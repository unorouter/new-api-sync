import { CHANNEL_TYPES } from "@core/catalog/constants/channel-types";
import {
  matchesAnyPattern,
  matchesBlacklist,
} from "@core/catalog/constants/patterns";
import { getEnabledModelGlobs, type RuntimeConfig } from "@core/config";
import { throwIfRunAborted } from "@core/infra/abort";
import type {
  ProviderResult,
  ProviderRunContext,
  UpstreamOffer,
} from "@core/pricing/offers";
import { isBalanceError, testAndFilterModels } from "@core/testing/runner";
import type { ModelTestDetail } from "@core/testing/types";
import type { ProviderReport } from "@core/types";
import type { SiProviderConfig } from "@core/validations/config";
import { resolvePerModel } from "@core/pricing";
import {
  buildFallbackOffer,
  DEFAULT_MIN_SELLERS,
  laneMultiple,
  resolvePools,
  type FallbackLane,
} from "@core/vendors/shared/fallback-lanes";
import { t } from "@server/i18n";
import { consola } from "consola";
import {
  fetchMarketModels,
  fetchOrderBook,
  fetchSellerProviders,
  type BookOffer,
  type SellerProviderInfo,
} from "./market";

// An order book over resold API keys: every request goes to the cheapest
// healthy seller unless the body pins seller providers (`provider`). A pin is
// only as honest as the sellers behind it (one Claude pin answered a probe as a
// GPT model with another request's nonce), so the allowlist is per model family
// in config and only offers the market itself marks trusted are counted.
// The market bills whole micro-dollars, so a small request's estimated discount
// tops out near 97%: a 97% floor refused deepseek-v3.1 with 49 sellers at 98% off
// (2026-09-19, "best otherwise-eligible 96.9697%"). Floors stay at or under 90.
const FLOOR_CAP_PCT = 90;
// A lane is priced on the expected seller; the floor only has to keep the dearest
// seller it still admits at this multiple.
const WORST_CASE_MULTIPLE = 2;
const BOOK_CONCURRENCY = 3;

function sellerPin(
  offer: BookOffer,
  providers: SellerProviderInfo[],
): string | undefined {
  const label = offer.provider?.toLowerCase();
  const byName = providers.find((p) => p.name.toLowerCase() === label);
  if (byName) return byName.id.toLowerCase();
  let host: string | undefined;
  try {
    host = offer.seller_base_url
      ? new URL(offer.seller_base_url).host
      : undefined;
  } catch {
    host = undefined;
  }
  return providers.find((p) => p.host === host)?.id.toLowerCase();
}

export async function processSiProvider(
  provider: SiProviderConfig,
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
  const exposedOf = (id: string) =>
    (config.modelMapping?.[id] ?? id).toLowerCase();
  const wanted = (exposed: string) =>
    !matchesBlacklist(exposed, config.blacklist, name) &&
    (globs.length === 0 || matchesAnyPattern(exposed, globs)) &&
    (!config.modelFilter?.length ||
      matchesAnyPattern(exposed, config.modelFilter));

  try {
    const [sellers, markets] = await Promise.all([
      fetchSellerProviders(baseUrl),
      fetchMarketModels(baseUrl),
    ]);
    if (!sellers.ok || !markets.ok) {
      report.error = t("CORE.SI.MARKET_FAILED", {
        name,
        reason: !sellers.ok ? sellers.reason : markets.ok ? "" : markets.reason,
      });
      return result();
    }
    const knownPins = new Set(sellers.data.map((p) => p.id.toLowerCase()));
    const models = markets.data.filter((id) => wanted(exposedOf(id)));
    if (models.length === 0) {
      report.error = t("CORE.ERROR.NO_MODELS_FOUND");
      return result();
    }

    const lanes: FallbackLane[] = [];
    const unverified: string[] = [];
    for (let i = 0; i < models.length; i += BOOK_CONCURRENCY) {
      throwIfRunAborted();
      const batch = models.slice(i, i + BOOK_CONCURRENCY);
      const books = await Promise.all(
        batch.map((id) => fetchOrderBook(baseUrl, id)),
      );
      batch.forEach((id, index) => {
        const book = books[index];
        const exposed = exposedOf(id);
        const minSellers = resolvePerModel(
          provider.minSellers,
          exposed,
          DEFAULT_MIN_SELLERS,
        );
        if (!book || !book.ok) {
          unverified.push(exposed);
          consola.warn(
            t("CORE.SI.BOOK_FAILED", {
              name,
              model: exposed,
              reason: book && !book.ok ? book.reason : "",
            }),
          );
          return;
        }
        const allowed = new Set(
          resolvePools(provider.providers, exposed).filter((pin) => {
            if (knownPins.has(pin)) return true;
            consola.warn(t("CORE.SI.UNKNOWN_PIN", { name, pin }));
            return false;
          }),
        );
        const listInputUsd = (book.data[0]?.direct_input_per_1m ?? 0) / 1e6;
        const listOutputUsd = (book.data[0]?.direct_output_per_1m ?? 0) / 1e6;
        const eligible = book.data.filter((o) => {
          const pin = sellerPin(o, sellers.data);
          return (
            o.available &&
            o.healthy &&
            o.trusted &&
            pin !== undefined &&
            allowed.has(pin)
          );
        });
        if (
          eligible.length < minSellers ||
          listInputUsd <= 0 ||
          listOutputUsd <= 0
        ) {
          consola.warn(
            t("CORE.SI.THIN_BOOK", {
              name,
              model: exposed,
              offers: eligible.length,
              min: minSellers,
            }),
          );
          return;
        }
        // Priced on the minSellers-th cheapest trusted offer, the seller the
        // lane expects to reach once the cheapest few are busy.
        const ranked = eligible
          .map((o) => ({
            o,
            share: Math.max(
              o.price_input_per_1m / 1e6 / listInputUsd,
              o.price_output_per_1m / 1e6 / listOutputUsd,
            ),
          }))
          .sort((a, b) => a.share - b.share);
        const expected = ranked[minSellers - 1];
        if (!expected) return;
        const inputUsd = expected.o.price_input_per_1m / 1e6;
        const outputUsd = expected.o.price_output_per_1m / 1e6;
        const multiple = laneMultiple(provider, {
          exposed,
          pool: "",
          inputUsd,
          outputUsd,
          listInputUsd,
          listOutputUsd,
        });
        if (multiple === undefined) return;
        // The market caps no price; its only spend guard is a floor on the
        // discount off list. It sits where the dearest admitted seller still
        // earns WORST_CASE_MULTIPLE, never above the expected seller's discount.
        const bound = Math.max(
          expected.share,
          Math.min(
            (multiple * inputUsd) / (WORST_CASE_MULTIPLE * listInputUsd),
            (multiple * outputUsd) / (WORST_CASE_MULTIPLE * listOutputUsd),
          ),
        );
        const floor = Math.min(FLOOR_CAP_PCT, Math.floor(100 * (1 - bound)));
        if (floor < 1) {
          consola.warn(t("CORE.SI.NO_FLOOR", { name, model: exposed }));
          return;
        }
        const pins = [...allowed].filter((pin) =>
          eligible.some((o) => sellerPin(o, sellers.data) === pin),
        );
        const claude = exposed.startsWith("claude-");
        lanes.push({
          exposed,
          upstream: id,
          pool: "",
          inputUsd,
          outputUsd,
          listInputUsd,
          listOutputUsd,
          multiple,
          channelType: claude ? CHANNEL_TYPES.ANTHROPIC : CHANNEL_TYPES.OPENAI,
          baseUrl: claude
            ? `${baseUrl}/anthropic/min${floor}`
            : `${baseUrl}/min${floor}`,
          operations: [{ mode: "set", path: "provider", value: pins }],
          probeBody: { provider: pins },
          remark: `${exposed} via ${name} (${eligible.length} trusted sellers on ${pins.join(", ")}, priced on the #${minSellers} ask, floor ${floor}% under list)`,
        });
      });
    }
    if (unverified.length > 0) report.unverifiedModels = unverified;
    if (lanes.length === 0) {
      report.error = t("CORE.ERROR.NO_MODELS_FOUND");
      return result();
    }

    // The pin rides in every probe body, or the probe tests whichever seller
    // is cheapest instead of the ones the lane will reach.
    const details = new Map<string, ModelTestDetail | undefined>();
    const throttled = new Set<string>();
    let balanceErrors = 0;
    for (const lane of lanes) {
      const probe = await testAndFilterModels({
        allModels: [lane.upstream],
        baseUrl: lane.baseUrl,
        apiKey: provider.apiKey,
        channelType: lane.channelType,
        providerLabel: name,
        testableModelTypes: new Set(["text"]),
        acceptRateLimited: provider.acceptRateLimited ?? false,
        extraBody: lane.probeBody,
      });
      if (probe.details?.some(isBalanceError)) balanceErrors++;
      if (!probe.workingModels.includes(lane.upstream)) continue;
      details.set(
        lane.upstream,
        probe.details?.find((d) => d.model === lane.upstream),
      );
      if (probe.rateLimitedModels.includes(lane.upstream))
        throttled.add(lane.upstream);
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
          providerKind: "si",
          apiKey: provider.apiKey,
          lane: probed,
        }),
      );
    }

    report.groups = offers.length;
    report.models = new Set(lanes.map((l) => l.exposed)).size;
    report.success = offers.length > 0;
    if (!report.success) report.error = t("CORE.ERROR.NO_WORKING_MODELS");
    // An empty wallet fails every probe; the lanes are not dead, so keep them.
    // One lane's own quota answer is ordinary, so it takes half the run.
    if (balanceErrors > 0 && balanceErrors * 2 >= lanes.length) {
      report.deletesWithheld = true;
      report.error = t("CORE.ERROR.BALANCE_EMPTY_DELETES_WITHHELD", { name, count: balanceErrors });
      consola.warn(report.error);
    }
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
