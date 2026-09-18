import { CHANNEL_TYPES } from "@core/catalog/constants/channel-types";
import {
  matchesAnyPattern,
  matchesBlacklist,
} from "@core/catalog/constants/patterns";
import { getEnabledModelGlobs, type RuntimeConfig } from "@core/config";
import { resolvePerModel } from "@core/pricing";
import type {
  ProviderResult,
  ProviderRunContext,
  UpstreamOffer,
} from "@core/pricing/offers";
import { testAndFilterModels } from "@core/testing/runner";
import type { ModelTestDetail } from "@core/testing/types";
import type { ProviderReport } from "@core/types";
import type { IhProviderConfig } from "@core/validations/config";
import {
  bidValue,
  buildFallbackOffer,
  DEFAULT_BID_QUANTILE,
  DEFAULT_MIN_SELLERS,
  ladderQuantile,
  ladderSize,
  laneMultiple,
  resolvePools,
  type FallbackLane,
  type LanePrice,
} from "@core/vendors/shared/fallback-lanes";
import { t } from "@server/i18n";
import { consola } from "consola";
import { fetchPoolCatalog, officialUsd } from "./catalog";

// A relay with separate supply pools behind one key, each addressed by a model
// prefix (`<pool>/<model>`). Which pool a lane may use is config, never
// inferred: one pool can wrap Claude in an IDE persona, inject a few hundred
// prompt tokens and strip thinking while another passes the vendor's own
// envelope and a thinking signature the vendor accepts.
const bareModelId = (id: string) => id.slice(id.lastIndexOf("/") + 1);

export async function processIhProvider(
  provider: IhProviderConfig,
  config: RuntimeConfig,
  _ctx: ProviderRunContext,
): Promise<ProviderResult> {
  const name = provider.name;
  const report: ProviderReport = {
    name,
    success: false,
    groups: 0,
    models: 0,
    tokens: { created: 0, existing: 0, deleted: 0 },
  };
  const offers: UpstreamOffer[] = [];
  const result = (): ProviderResult => ({
    report,
    offers,
    endpointMetadata: { endpointPaths: new Map() },
  });
  const baseUrl = provider.baseUrl.replace(/\/+$/, "");
  const globs = getEnabledModelGlobs(provider.enabledModels) ?? [];
  const wanted = (exposed: string) =>
    !matchesBlacklist(exposed, config.blacklist, name) &&
    (globs.length === 0 || matchesAnyPattern(exposed, globs)) &&
    (!config.modelFilter?.length ||
      matchesAnyPattern(exposed, config.modelFilter));

  try {
    const catalog = await fetchPoolCatalog(
      provider.catalogUrl,
      provider.apiKey,
    );
    if (!catalog.ok) {
      report.error = t("CORE.IH.CATALOG_FAILED", {
        name,
        reason: catalog.reason,
      });
      return result();
    }

    const lanes: FallbackLane[] = [];
    for (const up of catalog.upstreams) {
      const prefix = up.prefix.toLowerCase();
      const usable =
        up.enabled && !up.upstreamDisabled && up.status === "available";
      for (const m of up.models) {
        // Pool ids can carry the model vendor's namespace
        // (MiniMaxAI/MiniMax-M2.5); the published name is the bare model.
        const bare = m.upstreamModelId.slice(
          m.upstreamModelId.lastIndexOf("/") + 1,
        );
        const exposed = (
          config.modelMapping?.[m.upstreamModelId] ??
          config.modelMapping?.[bare] ??
          bare
        ).toLowerCase();
        if (!resolvePools(provider.upstreams, exposed).includes(prefix))
          continue;
        if (!wanted(exposed) || !m.enabled || m.modelDisabled) continue;
        if (!usable) {
          consola.warn(
            t("CORE.IH.POOL_UNAVAILABLE", {
              name,
              model: exposed,
              pool: prefix,
              status: up.status,
            }),
          );
          continue;
        }
        const quantile = resolvePerModel(
          provider.bidQuantile,
          exposed,
          DEFAULT_BID_QUANTILE,
        );
        const minSellers = resolvePerModel(
          provider.minSellers,
          exposed,
          DEFAULT_MIN_SELLERS,
        );
        const sellers = Math.min(
          ladderSize(m.pricePointsIn),
          ladderSize(m.pricePointsOut),
        );
        if (sellers === 0) {
          consola.warn(
            t("CORE.IH.NO_ASKS", { name, model: exposed, pool: prefix }),
          );
          continue;
        }
        const inputUsd = ladderQuantile(m.pricePointsIn, quantile, minSellers);
        const outputUsd = ladderQuantile(
          m.pricePointsOut,
          quantile,
          minSellers,
        );
        if (inputUsd === undefined || outputUsd === undefined) {
          consola.warn(
            t("CORE.IH.THIN_POOL", {
              name,
              model: exposed,
              pool: prefix,
              sellers,
              min: minSellers,
            }),
          );
          continue;
        }
        const listInputUsd = officialUsd(m.officialIn);
        const listOutputUsd = officialUsd(m.officialOut);
        const price: LanePrice = {
          exposed,
          pool: prefix,
          inputUsd,
          outputUsd,
          ...(listInputUsd !== undefined ? { listInputUsd } : {}),
          ...(listOutputUsd !== undefined ? { listOutputUsd } : {}),
        };
        const multiple = laneMultiple(provider, price);
        if (multiple === undefined) continue;
        lanes.push({
          ...price,
          upstream: `${up.prefix}/${m.upstreamModelId}`,
          multiple,
          // Claude over the Anthropic wire keeps thinking blocks and their
          // signatures intact; the OpenAI wire drops both.
          channelType: m.upstreamModelId.startsWith("claude-")
            ? CHANNEL_TYPES.ANTHROPIC
            : CHANNEL_TYPES.OPENAI,
          baseUrl,
          // Without a bid the relay routes to its best-scoring provider at up
          // to half the official price; with one it refuses (402) instead of
          // charging more than the lane was priced at, and the gateway fails over.
          operations: [
            {
              mode: "set_header",
              path: "x-max-input-price",
              value: bidValue(inputUsd),
            },
            {
              mode: "set_header",
              path: "x-max-output-price",
              value: bidValue(outputUsd),
            },
          ],
          remark: `${exposed} via ${name} ${up.slug} pool (${prefix}/, ${up.activeProviders} providers, bid $${bidValue(inputUsd)}/$${bidValue(outputUsd)} per M)`,
        });
      }
    }
    if (lanes.length === 0) {
      report.error = t("CORE.ERROR.NO_MODELS_FOUND");
      return result();
    }

    const details = new Map<string, ModelTestDetail | undefined>();
    const throttled = new Set<string>();
    for (const channelType of new Set(lanes.map((l) => l.channelType))) {
      const probe = await testAndFilterModels({
        allModels: lanes
          .filter((l) => l.channelType === channelType)
          .map((l) => l.upstream),
        baseUrl,
        apiKey: provider.apiKey,
        channelType,
        providerLabel: name,
        testableModelTypes: new Set(["text"]),
        acceptRateLimited: provider.acceptRateLimited ?? false,
        familyOf: bareModelId,
      });
      for (const id of probe.workingModels)
        details.set(
          id,
          probe.details?.find((d) => d.model === id),
        );
      for (const id of probe.rateLimitedModels) throttled.add(id);
    }

    for (const lane of lanes) {
      if (!details.has(lane.upstream)) continue;
      const testDetail = details.get(lane.upstream);
      const probed: FallbackLane = {
        ...lane,
        ...(testDetail ? { testDetail } : {}),
        ...(throttled.has(lane.upstream) ? { rateLimited: true } : {}),
      };
      offers.push(
        buildFallbackOffer({
          provider: name,
          providerKind: "ih",
          apiKey: provider.apiKey,
          lane: probed,
        }),
      );
    }

    report.groups = offers.length;
    report.models = new Set(lanes.map((l) => l.exposed)).size;
    report.success = offers.length > 0;
    if (!report.success) report.error = t("CORE.ERROR.NO_WORKING_MODELS");
    consola.info(
      t("CORE.FALLBACK.SUMMARY", {
        name,
        lanes: offers.length,
        candidates: lanes.length,
      }),
    );
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  return result();
}
