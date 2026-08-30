import { fetchJson, tryFetchJson } from "@core/infra/http";
import { throwIfRunAborted } from "@core/infra/abort";
import type { A7ApiProviderConfig } from "@core/validations/config";
import type { ClientContext } from "@core/vendors/newapi/context";
import {
  createToken,
  deleteToken,
  getTokenFullKeysBatch,
  listTokens,
} from "@core/vendors/newapi/tokens";
import { consola } from "consola";
import {
  DEFAULT_MAX_SELL_FRACTION,
  DEFAULT_PROFIT_MULTIPLE,
  fetchListings,
  marketplaceHeaders,
  resolvePerModel,
  type Listing,
} from "./marketplace";

// A pin is per (token, model), so one token cannot route the same model to two
// merchants. Multi-merchant channels therefore need one upstream token per
// (model, merchant) pair, each carrying exactly one pin.
export interface MerchantLane {
  model: string;
  listing: Listing;
}

export interface LaneToken {
  key: string;
  tokenId: number;
}

interface PinRecord {
  token_id: number;
  channel_id: number;
  model_name: string;
  status?: string;
  confirmed_output_price_micros?: number;
  current_output_price_micros?: number;
}

interface PinsResponse {
  success?: boolean;
  data?: { items?: PinRecord[] } | PinRecord[];
}

const TOKEN_NAME_MAX_BYTES = 30;

export function laneTokenName(lane: MerchantLane): string {
  const base = `${lane.listing.channel_id}-${lane.model}`;
  const encoder = new TextEncoder();
  if (encoder.encode(base).length <= TOKEN_NAME_MAX_BYTES) return base;
  let out = "";
  let used = 0;
  for (const ch of base) {
    const bytes = encoder.encode(ch).length;
    if (used + bytes > TOKEN_NAME_MAX_BYTES) break;
    out += ch;
    used += bytes;
  }
  return out;
}

function clientContext(provider: A7ApiProviderConfig): ClientContext {
  return {
    baseUrl: provider.baseUrl.replace(/\/$/, ""),
    headers: marketplaceHeaders(provider),
    name: provider.name,
  };
}

const normalizeKey = (key: string) =>
  key.startsWith("sk-") ? key : `sk-${key}`;
const isMasked = (key: string) => key.includes("*");
const laneNamePattern = /^\d+-/;

export async function ensureLaneTokens(
  provider: A7ApiProviderConfig,
  lanes: MerchantLane[],
  opts: { dryRun: boolean },
): Promise<Map<string, LaneToken>> {
  const result = new Map<string, LaneToken>();
  if (opts.dryRun) {
    for (const lane of lanes)
      result.set(laneTokenName(lane), { key: "", tokenId: 0 });
    return result;
  }

  const ctx = clientContext(provider);
  const existing = await listTokens(ctx);
  const byName = new Map(existing.map((t) => [t.name, t]));
  const desired = new Map(lanes.map((l) => [laneTokenName(l), l]));

  const maskedIds: number[] = [];
  for (const [name] of desired) {
    const token = byName.get(name);
    if (!token) continue;
    if (isMasked(token.key)) maskedIds.push(token.id);
    else result.set(name, { key: normalizeKey(token.key), tokenId: token.id });
  }
  if (maskedIds.length > 0) {
    const revealed = await getTokenFullKeysBatch(ctx, maskedIds);
    for (const [name] of desired) {
      const token = byName.get(name);
      if (!token || result.has(name)) continue;
      const key = revealed.get(token.id);
      if (key) result.set(name, { key: normalizeKey(key), tokenId: token.id });
    }
  }

  // a7api's POST /api/token returns no key inline, so a newly created token is
  // revealed the same way as an existing one: batch/keys after re-listing.
  const createdIds: number[] = [];
  for (const [name] of desired) {
    throwIfRunAborted();
    if (result.has(name)) continue;
    const created = await createToken(ctx, name, "default");
    if (!created.ok)
      consola.warn(`[${provider.name}] token create failed for lane ${name}`);
  }
  const afterCreate = new Map((await listTokens(ctx)).map((t) => [t.name, t]));
  for (const [name] of desired) {
    if (result.has(name)) continue;
    const token = afterCreate.get(name);
    if (token) createdIds.push(token.id);
  }
  if (createdIds.length > 0) {
    const keys = await getTokenFullKeysBatch(ctx, createdIds);
    for (const [name] of desired) {
      if (result.has(name)) continue;
      const token = afterCreate.get(name);
      if (!token) continue;
      const key = keys.get(token.id);
      if (key) result.set(name, { key: normalizeKey(key), tokenId: token.id });
      else consola.warn(`[${provider.name}] no key for lane ${name}, skipping`);
    }
  }

  return result;
}

// Same rationale as cleanupEmptyGroupTokens: only a FULL provider run may
// delete, or a filtered run conflates "merchant gone" with "filtered out"
// and the deleted key 401-kills every out-of-scope channel still using it.
// Runs against the KEPT lanes (probe passers), so a candidate probed and
// rejected this run loses its token (and thereby its pin) immediately.
export async function cleanupStaleLaneTokens(
  provider: A7ApiProviderConfig,
  keptLanes: MerchantLane[],
): Promise<void> {
  const ctx = clientContext(provider);
  const keep = new Set(keptLanes.map(laneTokenName));
  for (const token of await listTokens(ctx)) {
    throwIfRunAborted();
    if (!laneNamePattern.test(token.name)) continue;
    if (keep.has(token.name)) continue;
    if (await deleteToken(ctx, token.id))
      consola.info(`[${provider.name}] deleted stale lane token ${token.name}`);
  }
}

export async function listPins(
  provider: A7ApiProviderConfig,
): Promise<PinRecord[]> {
  const url = `${provider.baseUrl.replace(/\/$/, "")}/api/marketplace/pins`;
  const body = await tryFetchJson<PinsResponse>(url, {
    headers: marketplaceHeaders(provider),
    timeoutMs: 30_000,
  });
  if (!body?.success) return [];
  const data = body.data;
  return Array.isArray(data) ? data : (data?.items ?? []);
}

async function postPin(
  provider: A7ApiProviderConfig,
  tokenId: number,
  channelId: number,
  model: string,
): Promise<void> {
  await fetchJson(`${provider.baseUrl.replace(/\/$/, "")}/api/marketplace/pin`, {
    method: "POST",
    headers: {
      ...marketplaceHeaders(provider),
      "Content-Type": "application/json",
    },
    body: {
      token_id: tokenId,
      channel_id: channelId,
      model_name: model,
      // NO smart-routing fallback: a7 bills the fallback merchant's own price
      // (seen 4.8x the pinned cost, can exceed our retail), and the
      // successful-but-expensive responses hide the dead merchant from the
      // failure-rate guard. An erroring lane fails over on our side to lanes
      // whose cost we actually priced.
      fallback_to_smart_routing: false,
    },
    timeoutMs: 30_000,
  });
}

interface PriceNotice {
  notice_id: number;
  channel_id: number;
  model_name: string;
  status: string;
  new_price?: { output_price_micros?: number };
  relations?: { relation_type: string; relation_id: number; state: string }[];
}

interface PriceNoticesResponse {
  success?: boolean;
  data?: { items?: PriceNotice[] } | PriceNotice[];
}

// a7 PAUSES a pin whenever its merchant reprices (paused_price_changed) and,
// with fallback off, the lane errors until the change is accepted. Re-POSTing
// the pin does NOT accept (verified live); the accept is its own endpoint,
// keyed by price notice + pin relation. Accept every open pin relation whose
// new price is still profitable (new output * profitMultiple within
// maxSellFraction of the official list); a merchant that repriced itself past
// the ceiling stays paused so the failure-rate guard retires the lane. Runs
// from `sync metadata` so the cadence is the cron's, not the full-sync's.
export async function acceptPriceNotices(
  provider: A7ApiProviderConfig,
): Promise<{ accepted: number; leftPaused: number }> {
  const result = { accepted: 0, leftPaused: 0 };
  const base = provider.baseUrl.replace(/\/$/, "");
  const body = await tryFetchJson<PriceNoticesResponse>(
    `${base}/api/marketplace/price-notices`,
    { headers: marketplaceHeaders(provider), timeoutMs: 30_000 },
  );
  if (!body?.success) return result;
  const notices = Array.isArray(body.data)
    ? body.data
    : (body.data?.items ?? []);
  if (notices.length === 0) return result;

  const listings = await fetchListings(provider);
  const officialOutByKey = new Map(
    listings.map((l) => [
      `${l.channel_id}|${l.model_name}`,
      l.official_price?.output_price_micros,
    ]),
  );

  for (const notice of notices) {
    for (const rel of notice.relations ?? []) {
      if (rel.relation_type !== "pin" || rel.state !== "open") continue;
      throwIfRunAborted();
      const profitMultiple = resolvePerModel(
        provider.profitMultiple,
        notice.model_name,
        DEFAULT_PROFIT_MULTIPLE,
      );
      const maxSellFraction = resolvePerModel(
        provider.maxSellFraction,
        notice.model_name,
        DEFAULT_MAX_SELL_FRACTION,
      );
      const officialOut = officialOutByKey.get(
        `${notice.channel_id}|${notice.model_name}`,
      );
      const newOut = notice.new_price?.output_price_micros;
      if (
        officialOut !== undefined &&
        officialOut > 0 &&
        newOut !== undefined &&
        newOut * profitMultiple > officialOut * maxSellFraction
      ) {
        consola.warn(
          `[${provider.name}] leaving pin paused for ${notice.model_name} -> ${notice.channel_id}: new price breaches the sell ceiling`,
        );
        result.leftPaused++;
        continue;
      }
      try {
        await fetchJson(
          `${base}/api/marketplace/price-notices/${notice.notice_id}/accept`,
          {
            method: "POST",
            headers: {
              ...marketplaceHeaders(provider),
              "Content-Type": "application/json",
            },
            body: { relation_type: "pin", relation_id: rel.relation_id },
            timeoutMs: 30_000,
          },
        );
        consola.info(
          `[${provider.name}] accepted price change for ${notice.model_name} -> ${notice.channel_id}`,
        );
        result.accepted++;
      } catch (err) {
        consola.warn(
          `[${provider.name}] price accept failed for ${notice.model_name} -> ${notice.channel_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Price DROPS never pause the pin and produce no acceptable notice, so an
  // active pin keeps BILLING the old higher confirmed snapshot. Re-POSTing
  // the pin does not refresh it either (verified live); only unpin + pin
  // re-confirms at the current price. The ceiling still applies: a merchant
  // dropping from far above the ceiling to just above it is still not worth
  // re-pinning (3801 rode this to a 1.1x margin), so leave those to the full
  // sync's cull instead of resurrecting them.
  for (const pin of await listPins(provider)) {
    if (pin.status !== "active") continue;
    if (
      pin.current_output_price_micros === undefined ||
      pin.confirmed_output_price_micros === undefined ||
      pin.current_output_price_micros >= pin.confirmed_output_price_micros
    )
      continue;
    const profitMultiple = resolvePerModel(
      provider.profitMultiple,
      pin.model_name,
      DEFAULT_PROFIT_MULTIPLE,
    );
    const maxSellFraction = resolvePerModel(
      provider.maxSellFraction,
      pin.model_name,
      DEFAULT_MAX_SELL_FRACTION,
    );
    const officialOut = officialOutByKey.get(
      `${pin.channel_id}|${pin.model_name}`,
    );
    if (
      officialOut !== undefined &&
      officialOut > 0 &&
      pin.current_output_price_micros * profitMultiple >
        officialOut * maxSellFraction
    )
      continue;
    throwIfRunAborted();
    try {
      await fetchJson(`${base}/api/marketplace/unpin`, {
        method: "POST",
        headers: {
          ...marketplaceHeaders(provider),
          "Content-Type": "application/json",
        },
        body: {
          token_id: pin.token_id,
          channel_id: pin.channel_id,
          model_name: pin.model_name,
        },
        timeoutMs: 30_000,
      });
      await postPin(provider, pin.token_id, pin.channel_id, pin.model_name);
      consola.info(
        `[${provider.name}] re-pinned ${pin.model_name} -> ${pin.channel_id} at dropped price ($${(pin.confirmed_output_price_micros / 1e6).toFixed(3)} -> $${(pin.current_output_price_micros / 1e6).toFixed(3)}/M out)`,
      );
      result.accepted++;
    } catch (err) {
      consola.warn(
        `[${provider.name}] drop re-pin failed for ${pin.model_name} -> ${pin.channel_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return result;
}

export async function ensurePins(
  provider: A7ApiProviderConfig,
  lanes: MerchantLane[],
  tokens: Map<string, LaneToken>,
  dryRun: boolean,
): Promise<{ created: number; repinned: number }> {
  const result = { created: 0, repinned: 0 };
  const existing = new Map<string, number>();
  if (!dryRun) {
    for (const pin of await listPins(provider))
      existing.set(`${pin.token_id}|${pin.model_name}`, pin.channel_id);
  }

  for (const lane of lanes) {
    throwIfRunAborted();
    const token = tokens.get(laneTokenName(lane));
    if (!token) continue;
    if (dryRun) {
      result.created++;
      continue;
    }
    // Always re-POST, even for an unchanged merchant: the POST re-confirms the
    // price snapshot (accepting any pending merchant reprice) and refreshes the
    // routing flags; skipping left raised prices unaccepted indefinitely.
    const current = existing.get(`${token.tokenId}|${lane.model}`);
    try {
      await postPin(provider, token.tokenId, lane.listing.channel_id, lane.model);
      if (current === undefined) result.created++;
      else result.repinned++;
    } catch (err) {
      consola.warn(
        `[${provider.name}] pin failed for ${lane.model} -> ${lane.listing.channel_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return result;
}
