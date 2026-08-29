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
import { marketplaceHeaders, type Listing } from "./marketplace";

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
  opts: { dryRun: boolean; skipCleanup: boolean },
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

  // Same rationale as cleanupEmptyGroupTokens: only a FULL provider run may
  // delete, or a filtered run conflates "merchant gone" with "filtered out"
  // and the deleted key 401-kills every out-of-scope channel still using it.
  if (!opts.skipCleanup) {
    for (const token of existing) {
      throwIfRunAborted();
      if (!laneNamePattern.test(token.name)) continue;
      if (desired.has(token.name)) continue;
      if (await deleteToken(ctx, token.id))
        consola.info(
          `[${provider.name}] deleted stale lane token ${token.name}`,
        );
    }
  }
  return result;
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
      await fetchJson(
        `${provider.baseUrl.replace(/\/$/, "")}/api/marketplace/pin`,
        {
          method: "POST",
          headers: {
            ...marketplaceHeaders(provider),
            "Content-Type": "application/json",
          },
          body: {
            token_id: token.tokenId,
            channel_id: lane.listing.channel_id,
            model_name: lane.model,
            // NO smart-routing fallback: a7 bills the fallback merchant's own
            // price (seen 4.8x the pinned cost, can exceed our retail), and the
            // successful-but-expensive responses hide the dead merchant from
            // the failure-rate guard. An erroring lane fails over on our side
            // to lanes whose cost we actually priced.
            fallback_to_smart_routing: false,
          },
          timeoutMs: 30_000,
        },
      );
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
