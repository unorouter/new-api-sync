import {
  buildChannelModelMapping,
  resolveBareNames,
  toBareName,
} from "@core/catalog/bare-name";
import { CHANNEL_TYPES } from "@core/catalog/constants/channel-types";
import {
  matchesAnyPattern,
  matchesBlacklist,
  sanitizeGroupName,
} from "@core/catalog/constants/patterns";
import { inferVendorFromModelName } from "@core/catalog/constants/vendor-matchers";
import {
  getEnabledModelGlobs,
  getMetadataFromEnabledModels,
  type RuntimeConfig,
} from "@core/config";
import type {
  OfferModel,
  ProviderResult,
  ProviderRunContext,
  UpstreamOffer,
} from "@core/pricing/offers";
import { resolvePriceAdjustment } from "@core/pricing";
import { tryFetchJson } from "@core/infra/http";
import { testAndFilterModels } from "@core/testing/runner";
import type { ModelTestDetail } from "@core/testing/types";
import type { ProviderReport } from "@core/types";
import type { OpenRouterProviderConfig } from "@core/validations/config";
import { t } from "@server/i18n";
import { consola } from "consola";
import { buildCapabilityMap, lowercaseExposed } from "../shared/capability-map";
import { withCostTracking } from "../shared/cost-tracker";
import { partitionByVendor } from "../shared/partition";
import { discoverOpenRouterFreeModels } from "./discovery";

// new-api's per-token base: model_ratio 1 == $2/M tokens.
const USD_PER_M_PER_RATIO = 2;
// Cost + 50% when a provider's priceAdjustment default is unset.
const DEFAULT_PAID_MARKUP = 1.5;
const MIN_HOST_UPTIME_PCT = 90;
// fp8 is the floor. Anything coarser trades output quality for a price we are not
// short of alternatives at, and "unknown" covers the full-precision hosts, so only
// the explicitly-lower tiers are named here.
const SUB_FP8_QUANTIZATIONS = new Set(["fp4", "int4", "nf4", "fp6", "int8"]);
// Hosts with confirmed-degraded output. akashml passes probes but its glm-5.2 fp8
// garbles names and loses context (user-reported, reproducible against novita's
// fp8 of the same weights), so its cheap price never wins the host pick.
//
// deepinfra is NOT excluded despite the direct di1 lane: di1 only carries four
// models, so blanket-blocking the host also cost every model it does not serve.
// The two lanes coexist and the cheaper one wins per model; paying OR's cut is
// better than having no host at all.
const EXCLUDED_HOSTS = new Set(["akashml"]);

// Sampler/format knobs a chat client sends unprompted. A host pinned via provider.only
// gets the request verbatim, so one it does not accept fails the whole call: GMICloud
// omits frequency_penalty/presence_penalty/stop from its supported list and answers
// `400001 Invalid request parameters` when a preset sends them, while DeepSeek's own
// endpoint of the SAME model takes all three. Only params in this list are ever
// stripped, so a sparse or stale upstream list cannot delete something load-bearing.
const CLIENT_SENT_PARAMS = [
  "frequency_penalty",
  "presence_penalty",
  "repetition_penalty",
  "top_k",
  "min_p",
  "top_a",
  "stop",
  "seed",
  "logit_bias",
  "response_format",
] as const;

type OverrideOp = {
  mode: string;
  path?: string;
  value?: unknown;
  keep_origin?: boolean;
  conditions?: {
    path: string;
    mode: string;
    value: unknown;
    invert?: boolean;
  }[];
  logic?: string;
};

function unsupportedParamOps(
  supported: string[] | undefined,
  acceptsImages: boolean,
  disableThinking?: boolean,
): { operations: OverrideOp[] } | undefined {
  const ops: OverrideOp[] = [];
  if (supported && supported.length > 0) {
    const ok = new Set(supported);
    for (const path of CLIENT_SENT_PARAMS) {
      if (!ok.has(path)) ops.push({ path, mode: "delete" });
    }
  }
  // A text-only model rejects the entire request over one image, and the sender
  // usually cannot tell an image was in it: iOS puts stickers and Memoji in as
  // PNG attachments. Dropping the image costs that attachment; keeping it costs
  // the reply.
  if (!acceptsImages) ops.push({ mode: "strip_images" });
  // Hybrid models (glm-4.7) reason by default on OpenRouter and clients that
  // never asked for reasoning get it folded into the visible reply (Chub
  // renders think tags raw). exclude keeps the chain of thought (the model
  // still reasons, verified: same completion_tokens) but OpenRouter drops it
  // from the stream, so every client sees only the answer. Two escapes: an
  // explicit client reasoning object passes (keep_origin), and a -thinking
  // alias on the same channel skips the op entirely (original_model is the
  // client-requested name, checked before mapping), so visible reasoning
  // stays one model-picker choice away.
  if (disableThinking)
    ops.push({
      path: "reasoning",
      mode: "set",
      value: { exclude: true },
      keep_origin: true,
      conditions: [
        {
          path: "original_model",
          mode: "suffix",
          value: "-thinking",
          invert: true,
        },
      ],
      logic: "AND",
    });
  return ops.length > 0 ? { operations: ops } : undefined;
}
// Host exclusions that apply to ONE model rather than the whole host. gmicloud's
// glm-5.2 does not separate reasoning from content and runs a classifier that trims
// replies mid-response (user-reported), and it is the priciest open1 glm-5.2 lane;
// its minimax-m3 is the cheapest lane we have and stays.
const EXCLUDED_HOSTS_BY_MODEL: Record<string, Set<string>> = {
  // digitalocean is the only glm-5.2 host OpenRouter reports as quantization
  // "unknown" rather than fp8, and it collapses on long context: 10.4 tps on a
  // 32k prompt where every other lane ran 55-127. Its kimi-k2.6 and mimo lanes
  // hold 44-51 tps and stay.
  "glm-5.2": new Set(["gmicloud", "digitalocean"]),
};

// A host's published quantization, appended to its tag when OpenRouter has not
// already put it there. OpenRouter suffixes the tag for SOME hosts (novita/fp8)
// and not others (together, digitalocean), so without this the published name
// says nothing about precision for exactly the hosts a caller most wants to
// check. "unknown" is skipped: it is OpenRouter's "not declared", and spelling
// it into a channel name reads as a precision rather than the absence of one.
function quantTag(tag: string, quantization?: string): string {
  const q = (quantization ?? "").trim().toLowerCase();
  if (!q || !tag || q === "unknown") return tag;
  return tag.includes(q) ? tag : `${tag}/${q}`;
}

// PAID models are never probed (a probe is a billed request per model per run),
// so a paid host has no test detail at all unless one is synthesised here.
// OpenRouter publishes supported_parameters PER HOST, and "reasoning" appears on
// exactly the reasoning models (glm-4.7 8/8 hosts, kimi-k3 15/15, llama-3.3
// 0/13), so the host's own declaration stands in for a probe.
//
// It no longer carries thinkingDetected: that only ever fed thinking_to_content,
// which is obsolete now that new-api judges stream emptiness on content rather
// than on the billing buffer.
function advertisedThinkingDetail(
  upstream: string,
  supportedParameters?: string[],
): ModelTestDetail | undefined {
  const params = supportedParameters ?? [];
  if (!params.includes("reasoning") && !params.includes("include_reasoning"))
    return undefined;
  return {
    model: upstream,
    success: true,
    streamSuccess: null,
    toolCallSuccess: null,
    toolParallel: null,
    authenticityProbed: false,
    channelType: CHANNEL_TYPES.OPENROUTER,
  };
}

async function fetchOpenRouterBalance(
  baseUrl: string,
  apiKey: string,
): Promise<number | null> {
  const data = await tryFetchJson<{
    data?: { total_credits?: number; total_usage?: number };
  }>(`${baseUrl.replace(/\/$/, "")}/v1/credits`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const c = data?.data?.total_credits,
    u = data?.data?.total_usage;
  return c === undefined || u === undefined ? null : c - u;
}

export async function processOpenRouterProvider(
  providerConfig: OpenRouterProviderConfig,
  config: RuntimeConfig,
  ctx: ProviderRunContext,
): Promise<ProviderResult> {
  const name = providerConfig.name;
  const report: ProviderReport = {
    name,
    success: false,
    groups: 0,
    models: 0,
    tokens: { created: 0, existing: 0, deleted: 0 },
  };
  const offers: UpstreamOffer[] = [];
  const endpointMetadata = { endpointPaths: new Map() };

  await withCostTracking(
    name,
    () =>
      ctx.dryRun
        ? Promise.resolve(null)
        : fetchOpenRouterBalance(providerConfig.baseUrl, providerConfig.apiKey),
    async () => {
      try {
        const enabledGlobs =
          getEnabledModelGlobs(providerConfig.enabledModels) ?? [];
        // Exact (non-glob) enabled ids = explicitly-requested paid models. Fetch
        // their per-host endpoint pricing during discovery.
        const requestedPaidIds = enabledGlobs.filter(
          (id) => !id.includes("*") && !id.includes("?"),
        );

        const catalogue = await discoverOpenRouterFreeModels(
          providerConfig.baseUrl,
          providerConfig.apiKey,
          requestedPaidIds,
        );
        consola.info(
          t("CORE.OPENROUTER.DISCOVERED_FREE", {
            name,
            count: catalogue.freeIds.length,
          }),
        );

        const freeSet = new Set(catalogue.freeIds);
        const paidSet = new Set<string>();
        for (const id of requestedPaidIds) {
          if (freeSet.has(id)) continue;
          paidSet.add(id);
        }

        const candidateIds = [...freeSet, ...paidSet];
        if (candidateIds.length === 0) {
          report.error = t("CORE.ERROR.NO_MODELS_FOUND");
          return;
        }

        const vendorFilterLower = providerConfig.enabledVendors?.map((v) =>
          v.toLowerCase(),
        );
        const filtered = candidateIds.filter((id) => {
          const bare = toBareName(id);
          if (
            matchesBlacklist(bare, config.blacklist, name) ||
            matchesBlacklist(id, config.blacklist, name)
          )
            return false;
          if (vendorFilterLower?.length) {
            const slash = id.indexOf("/");
            const vendor = slash >= 0 ? id.slice(0, slash).toLowerCase() : "";
            if (!vendorFilterLower.includes(vendor)) return false;
          }
          if (
            config.modelFilter?.length &&
            !matchesAnyPattern(id, config.modelFilter) &&
            !matchesAnyPattern(bare, config.modelFilter)
          )
            return false;
          return true;
        });

        if (filtered.length === 0) {
          report.error = t("CORE.ERROR.ALL_MODELS_FILTERED_SHORT");
          return;
        }

        // Only the free tier is probed. A paid probe is a billed request per model per
        // run, and OpenRouter already removes a model from its own catalog when the
        // upstream drops it; the free tier has no such guarantee and throttles constantly,
        // so it still earns the test. Paid models pass through untested.
        const toProbe = filtered.filter((id) => freeSet.has(id));
        const untested = filtered.filter((id) => !freeSet.has(id));

        let working = untested;
        let details: Awaited<
          ReturnType<typeof testAndFilterModels>
        >["details"] = [];
        if (toProbe.length > 0) {
          consola.info(
            t("CORE.OPENROUTER.PROBING", { name, count: toProbe.length }),
          );
          const filterResult = await testAndFilterModels({
            allModels: toProbe,
            baseUrl: providerConfig.baseUrl,
            apiKey: providerConfig.apiKey,
            channelType: CHANNEL_TYPES.OPENAI,
            providerLabel: name,
            testableModelTypes: new Set(["text"]),
            acceptRateLimited: providerConfig.acceptRateLimited ?? false,
            capabilities: buildCapabilityMap(
              toProbe,
              lowercaseExposed(config),
              ctx,
            ),
          });
          working = [...untested, ...filterResult.workingModels];
          details = filterResult.details ?? [];
        }

        consola.info(
          t("CORE.OPENROUTER.WORKING", {
            name,
            working: working.length,
            total: filtered.length,
          }),
        );
        if (working.length === 0) {
          report.error = t("CORE.ERROR.NO_WORKING_MODELS");
          return;
        }

        const resolutions = resolveBareNames(working, config.modelMapping);
        const reverseMapping = buildChannelModelMapping(resolutions);
        const freeResolutions = resolutions.filter((r) =>
          freeSet.has(r.upstream),
        );
        const paidResolutions = resolutions.filter(
          (r) => !freeSet.has(r.upstream),
        );

        let totalVendors = 0;
        const emitFreeTier = () => {
          if (freeResolutions.length === 0) return;
          const byVendor = partitionByVendor(
            freeResolutions,
            (r) => r.exposed,
            "other",
          );
          for (const [vendor, vendorResolutions] of byVendor) {
            const offerModels: OfferModel[] = vendorResolutions.map((r) => ({
              exposed: r.exposed,
              upstream: reverseMapping[r.exposed] ?? r.upstream,
              modelType: "text",
              testDetail: details.find((d) => d.model === r.upstream),
              isFree: true,
            }));
            offers.push({
              provider: name,
              providerKind: "openrouter",
              group: vendor,
              sanitizedBase: sanitizeGroupName(name),
              vendor,
              channelType: CHANNEL_TYPES.OPENROUTER,
              baseUrl: providerConfig.baseUrl,
              apiKey: providerConfig.apiKey,
              groupRatio: providerConfig.ratio,
              channelRemark: `OpenRouter free via ${name}`,
              models: offerModels,
              priceAdjustment: providerConfig.priceAdjustment,
              defaultAdjustment: 0,
              isFreeTier: true,
            });
            totalVendors++;
          }
        };

        // Paid: one channel per (model, upstream host). Each pins its host via
        // provider.only + no-fallback, priced off that host's real cost * markup.
        // Margin is baked into groupRatio (adj resolved to 0) so capAbove1x leaves
        // it untouched (a positive reprice would collapse to +5% since the model's
        // own price is its 1x list). Markup is resolved PER MODEL (against the
        // exposed name) so config priceAdjustment can key individual models, e.g.
        // a 50% (0.5) lane alongside a 55% default.
        const emitPaidPerHost = () => {
          for (const r of paidResolutions) {
            const hosts = catalogue.paidEndpoints.get(r.upstream);
            if (!hosts?.length) {
              consola.warn(
                t("CORE.OPENROUTER.PAID_NO_PRICING", {
                  name,
                  model: r.upstream,
                }),
              );
              continue;
            }
            const markup =
              1 +
              resolvePriceAdjustment({
                adj: providerConfig.priceAdjustment,
                model: r.exposed,
                vendor: inferVendorFromModelName(r.exposed) ?? "",
                modelType: "text",
                fallback: DEFAULT_PAID_MARKUP - 1,
                modelMapping: config.modelMapping,
              });
            const vendor = inferVendorFromModelName(r.exposed) ?? "other";
            // Skip hosts OpenRouter reports as unreliable (GMICloud-class ~18%
            // uptime slips past our own probe when transiently up). null uptime =
            // too new for stats, kept. Threshold is OR's 1-day uptime %.
            const reliableHosts = hosts.filter(
              (h) =>
                (h.uptime == null || h.uptime >= MIN_HOST_UPTIME_PCT) &&
                !SUB_FP8_QUANTIZATIONS.has(
                  (h.quantization ?? "").toLowerCase(),
                ) &&
                !EXCLUDED_HOSTS.has(h.provider.toLowerCase()) &&
                !EXCLUDED_HOSTS_BY_MODEL[r.exposed]?.has(
                  h.provider.toLowerCase(),
                ),
            );
            for (const h of hosts) {
              if (h.uptime != null && h.uptime < MIN_HOST_UPTIME_PCT) {
                consola.warn(
                  t("CORE.OPENROUTER.HOST_LOW_UPTIME", {
                    name,
                    model: r.exposed,
                    host: h.provider,
                    uptime: h.uptime.toFixed(1),
                  }),
                );
              }
            }
            // Warn rather than skip silently: a paid model that stops publishing
            // keeps whatever ratio it last had, and desiredModelsWithoutRatio
            // guards that value on every later run. laguna-s-2.1 sat at ratio 0
            // for weeks this way after poolside moved its only host to fp4,
            // reading as free in the catalog while a stale channel still served it.
            if (reliableHosts.length === 0) {
              consola.warn(
                t("CORE.OPENROUTER.PAID_NO_RELIABLE_HOST", {
                  name,
                  model: r.exposed,
                }),
              );
              continue;
            }
            // The N cheapest reliable hosts, each pinned via provider.only, instead of
            // fanning out a channel per host. Extras are failoverDuplicate so they do not
            // re-enter tier selection: the cheapest sets the published price and the rest
            // only catch the overflow when it is down or rate-limited.
            // Keyed by glob against the exposed name, matching priceAdjustment. Absent
            // key = 1 host, so fanning out stays opt-in per model.
            const hostsWanted =
              Object.entries(providerConfig.hostsPerModel ?? {}).find(
                ([glob]) => matchesAnyPattern(r.exposed, [glob]),
              )?.[1] ?? 1;
            const cheapestHosts = [...reliableHosts]
              .sort((a, b) => a.prompt - b.prompt)
              .slice(0, hostsWanted);
            const disableThinking = Object.entries(
              getMetadataFromEnabledModels(providerConfig.enabledModels),
            ).some(
              ([glob, meta]) =>
                meta.disableThinking === true &&
                (matchesAnyPattern(r.exposed, [glob]) ||
                  matchesAnyPattern(r.upstream, [glob])),
            );
            cheapestHosts.forEach((host, hostIndex) => {
              // OpenRouter only suffixes the tag with the quantization for SOME
              // hosts (novita/fp8), so the rest published a name that said
              // nothing about precision and a caller could not tell an fp8 lane
              // from an unknown one. The tag is the name users pick from, so
              // name the quantization there rather than leaving it implied.
              const hostTag = quantTag(host.tag, host.quantization);
              const m: OfferModel = {
                exposed: r.exposed,
                upstream: reverseMapping[r.exposed] ?? r.upstream,
                modelType: "text",
                testDetail:
                  details.find((d) => d.model === r.upstream) ??
                  (disableThinking
                    ? undefined
                    : advertisedThinkingDetail(
                        r.upstream,
                        host.supportedParameters,
                      )),
                upstreamRatio: (host.prompt * 1_000_000) / USD_PER_M_PER_RATIO,
                upstreamCompletionRatio:
                  host.prompt > 0 ? host.completion / host.prompt : 1,
                cacheRatio:
                  host.cacheRead != null && host.prompt > 0
                    ? host.cacheRead / host.prompt
                    : undefined,
                paramOverride: JSON.stringify({
                  provider: { only: [host.provider], allow_fallbacks: false },
                  ...unsupportedParamOps(
                    host.supportedParameters,
                    !catalogue.textOnlyIds.has(r.upstream),
                    disableThinking,
                  ),
                }),
                ...(hostIndex > 0 ? { failoverDuplicate: true } : {}),
              };
              offers.push({
                provider: name,
                providerKind: "openrouter",
                group: `${vendor}-${hostTag}`,
                sanitizedBase: sanitizeGroupName(`${name}-${hostTag}`),
                vendor,
                channelType: CHANNEL_TYPES.OPENROUTER,
                baseUrl: providerConfig.baseUrl,
                apiKey: providerConfig.apiKey,
                groupRatio: markup,
                channelRemark: `OpenRouter ${host.provider} via ${name}`,
                models: [m],
                priceAdjustment: { default: 0 },
                defaultAdjustment: 0,
              });
              totalVendors++;
            });
          }
        };

        emitFreeTier();
        emitPaidPerHost();

        consola.info(
          t("CORE.OPENROUTER.SUMMARY", {
            name,
            total: resolutions.length,
            free: freeResolutions.length,
            paid: paidResolutions.length,
            vendors: totalVendors,
          }),
        );

        report.groups = totalVendors;
        report.models = resolutions.length;
        report.success = true;
      } catch (error) {
        report.error = error instanceof Error ? error.message : String(error);
      }
    },
  );
  return { report, offers, endpointMetadata };
}
