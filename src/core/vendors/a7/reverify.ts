import { CHANNEL_TYPES } from "@core/catalog/constants/channel-types";
import { sanitizeGroupName } from "@core/catalog/constants/patterns";
import type { RuntimeConfig } from "@core/config";
import { isAuthenticityBlacklisted } from "@core/testing/authenticity";
import { testAndFilterModels } from "@core/testing/runner";
import {
  getVerdict,
  isAuthenticityPassFresh,
} from "@core/testing/verdict-cache";
import type { Channel } from "@core/types";
import type { A7ProviderConfig } from "@core/validations/config";
import type { NewApiClient } from "@core/vendors/newapi/client";
import { makerForModel } from "ai-model-verifier/makers";
import { consola } from "consola";
import { t } from "@server/i18n";
import {
  fetchListingsByModel,
  fetchMarketplaceModelNames,
} from "./marketplace";
import { ensureLaneTokens, laneTokenName, type MerchantLane } from "./pins";

// Probe budget per cron tick: the metadata cron runs every 15 minutes, about
// 64 ticks a day, and ~300 live lanes on a 4 hour pass TTL fall due ~1800
// times a day. Lane keys are cached, so a7's reveal limit is untouched.
const REVERIFY_PER_TICK = 32;
const MANUALLY_DISABLED = 2;

export interface ReverifyResult {
  live: number;
  due: number;
  passed: number;
  disabled: number;
  inconclusive: number;
}

interface LiveLane {
  channel: Channel;
  lane: MerchantLane;
  key: string;
}

// A live lane is never re-selected, so the candidate path's pass TTL never
// reaches it: a7 383 served haiku under claude-opus-5 for two days on a verdict
// that had expired. Re-probe every live text lane whose pass is stale and
// disable the channel when the probe records a fail. Disabled means status 2
// (manual), which the sync preserves and the gateway's own retest ignores.
export async function reverifyLiveLanes(
  provider: A7ProviderConfig,
  config: RuntimeConfig,
  target: NewApiClient,
  channels: Channel[],
): Promise<ReverifyResult> {
  const result: ReverifyResult = {
    live: 0,
    due: 0,
    passed: 0,
    disabled: 0,
    inconclusive: 0,
  };
  const live = channels.filter(
    (ch) => ch.tag === provider.name && ch.status === 1 && !!ch.group,
  );
  result.live = live.length;
  if (live.length === 0) return result;

  const marketNames = await fetchMarketplaceModelNames(provider);
  if (!marketNames) {
    consola.warn(`[${provider.name}] reverify: marketplace index unreachable`);
    return result;
  }
  const marketByExposed = new Map<string, string>();
  for (const model of marketNames)
    marketByExposed.set(
      (config.modelMapping?.[model] ?? model).toLowerCase(),
      model,
    );
  // Only the models the live lanes are sold under, never the snapshot.
  const liveMarkets = new Set<string>();
  for (const ch of live) {
    const market = marketByExposed.get(
      ch.models.split(",")[0]!.trim().toLowerCase(),
    );
    if (market) liveMarkets.add(market);
  }
  const { byModel } = await fetchListingsByModel(provider, [...liveMarkets]);

  const disableLane = async (ch: Channel, reason: string): Promise<void> => {
    const ok = await target.updateChannel({ ...ch, status: MANUALLY_DISABLED });
    if (ok) result.disabled++;
    consola.warn(
      t(ok ? "CORE.REVERIFY.DISABLED" : "CORE.REVERIFY.DISABLE_FAILED", {
        provider: provider.name,
        channel: ch.name,
        reason,
      }),
    );
  };

  const due: LiveLane[] = [];
  for (const ch of live) {
    const exposed = ch.models.split(",")[0]!.trim().toLowerCase();
    const market = marketByExposed.get(exposed);
    if (!market) continue;
    const suffix = `-${sanitizeGroupName(exposed)}`;
    if (!ch.group.endsWith(suffix)) continue;
    const id = /(\d+)$/.exec(ch.group.slice(0, -suffix.length))?.[1];
    const listing = id
      ? byModel.get(market)?.find((l) => l.channel_id === Number(id))
      : undefined;
    if (!listing) continue;
    const key = `${provider.name}:${listing.channel_id}|${market}`;
    if (isAuthenticityBlacklisted(key)) {
      await disableLane(ch, getVerdict(key)?.authenticityReason ?? "");
      continue;
    }
    if (isAuthenticityPassFresh(getVerdict(key), provider.baseUrl)) continue;
    due.push({ channel: ch, lane: { model: market, listing }, key });
  }
  result.due = due.length;
  if (due.length === 0) return result;

  // Claude first (its verdicts have authority), then oldest pass first, so a
  // lane never starves behind fresher ones.
  const rank = (l: LiveLane) =>
    makerForModel(l.lane.model) === "anthropic" ? 0 : 1;
  due.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (getVerdict(a.key)?.verifiedAt ?? "").localeCompare(
        getVerdict(b.key)?.verifiedAt ?? "",
      ),
  );
  const batch = due.slice(0, REVERIFY_PER_TICK);
  const tokens = await ensureLaneTokens(
    provider,
    batch.map((l) => l.lane),
    { dryRun: false },
  );
  const baseUrl = provider.baseUrl.replace(/\/$/, "");

  await Promise.all(
    batch.map(async (item) => {
      const token = tokens.get(laneTokenName(item.lane));
      if (!token) {
        result.inconclusive++;
        return;
      }
      const verdict = await testAndFilterModels({
        allModels: [item.lane.model],
        baseUrl,
        apiKey: token.key,
        channelType: CHANNEL_TYPES.OPENAI,
        providerLabel: `${provider.name}:${item.lane.listing.channel_id}`,
        testableModelTypes: new Set(["text"]),
        acceptRateLimited: provider.acceptRateLimited,
      });
      if (verdict.workingModels.includes(item.lane.model)) {
        result.passed++;
        return;
      }
      // A transient (503, cooldown, throttle) records no verdict and keeps the
      // lane; only a recorded fail pulls it.
      if (isAuthenticityBlacklisted(item.key))
        await disableLane(
          item.channel,
          getVerdict(item.key)?.authenticityReason ?? "",
        );
      else result.inconclusive++;
    }),
  );
  return result;
}
