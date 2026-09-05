import { getRunContext } from "@core/infra/abort";
import { fetchJson, tryFetchJson } from "@core/infra/http";
import type { Channel, ModelMeta, Vendor } from "@core/types";
import { PAGINATION } from "@core/types";
import { t } from "@server/i18n";
import { consola } from "consola";
import type { ClientContext } from "./context";
import type { ApiResponse } from "./types";

const FETCH_OPTS = { timeoutMs: 15_000, retry: 2, retryDelayMs: 2000 } as const;
const PS = PAGINATION.DEFAULT_PAGE_SIZE;

export interface UpstreamErrorEntry {
  // prettier-ignore
  op: "createChannel" | "updateChannel" | "deleteChannel" | "createModel" | "updateModel" | "deleteModel" | "createVendor" | "updateVendor";
  key: string;
  status?: number;
  message: string;
  payloadSnippet?: unknown;
  at: string;
}
// Per-run buffer (isolates concurrent server syncs); module fallback for the CLI.
const fallbackErrors: UpstreamErrorEntry[] = [];
const errorBuffer = (): UpstreamErrorEntry[] =>
  (getRunContext()?.upstreamErrors as UpstreamErrorEntry[]) ?? fallbackErrors;
export const recordUpstreamError = (
  e: Omit<UpstreamErrorEntry, "at">,
): void => {
  errorBuffer().push({ ...e, at: new Date().toISOString() });
};
export function drainUpstreamErrors(): UpstreamErrorEntry[] {
  const buf = errorBuffer();
  const out = buf.slice();
  buf.length = 0;
  return out;
}
export function peekUpstreamError(key: string): UpstreamErrorEntry | undefined {
  const buf = errorBuffer();
  for (let i = buf.length - 1; i >= 0; i--)
    if (buf[i]!.key === key) return buf[i];
  return undefined;
}

function recordIfFailed(
  data: { success?: boolean; message?: string } | null,
  op: UpstreamErrorEntry["op"],
  key: string,
  payloadSnippet?: unknown,
): boolean {
  if (data?.success) return true;
  recordUpstreamError({
    op,
    key,
    message: data?.message ?? "no response",
    payloadSnippet,
  });
  return false;
}

async function paginate<T>(
  fetchPage: (page: number) => Promise<T[]>,
  startPage: number,
): Promise<T[]> {
  const all: T[] = [];
  let page = startPage;
  while (true) {
    const items = await fetchPage(page);
    all.push(...items);
    if (items.length < PS) break;
    page++;
  }
  return all;
}

// id_sort forces a stable key: the default ordering ties on priority/weight, so
// rows shuffle between pages mid-walk and fall through the boundaries. Measured
// 1667 of 1677 channels returned without it - the 10 lost ones then read as dead
// groups and the group prune deleted their visibility.
export async function listChannels(ctx: ClientContext): Promise<Channel[]> {
  let reportedTotal: number | undefined;
  const rows = await paginate(async (page) => {
    const url = `${ctx.baseUrl}/api/channel/?p=${page}&page_size=${PS}&id_sort=true`;
    type R = {
      success: boolean;
      data: { data?: Channel[]; items?: Channel[]; total?: number } | Channel[];
    };
    const data = await fetchJson<R>(url, {
      headers: ctx.headers,
      ...FETCH_OPTS,
    });
    if (!data.success)
      throw new Error(t("ERROR.NEWAPI_CHANNEL_LIST_API_FAILED"));
    if (!Array.isArray(data.data) && typeof data.data.total === "number")
      reportedTotal = data.data.total;
    return Array.isArray(data.data)
      ? data.data
      : (data.data?.items ?? data.data?.data ?? []);
  }, PAGINATION.START_PAGE_ZERO);

  // The gateway is 1-indexed (p=0 and p=1 return the same first page), so the
  // walk from 0 double-counts the first page; dedup by id like listModels does.
  // Undeduped, every first-page channel appears twice in the snapshot and
  // diff.ts emits its delete op twice.
  const byId = new Map<number, Channel>();
  for (const row of rows) if (row.id != null) byId.set(row.id, row);
  const all = byId.size > 0 ? [...byId.values()] : rows;

  // Completeness guard, same reasoning as listModels: diff.ts deletes any
  // managed channel absent from the snapshot, so a walk that lost a page reads
  // as "these lanes are gone" and deletes live ones. A short list is only ever
  // a transport failure, never a real catalog; refuse it. Compare UNIQUE count,
  // the duplicated first page would otherwise hide a lost page.
  if (reportedTotal != null && all.length < reportedTotal)
    throw new Error(
      `channel list incomplete: got ${all.length} of ${reportedTotal}`,
    );
  return all;
}

export async function createChannel(
  ctx: ClientContext,
  channel: Omit<Channel, "id">,
): Promise<number | null> {
  const url = `${ctx.baseUrl}/api/channel/`;
  const post = (body: unknown) =>
    tryFetchJson<ApiResponse<{ id: number }>>(url, {
      method: "POST",
      headers: ctx.headers,
      body,
      ...FETCH_OPTS,
    });
  let data = await post({ mode: "single", channel });
  if (!data) data = await post(channel);
  if (!data?.success) {
    const message = data?.message ?? "no response";
    const key = channel.name ?? channel.tag ?? "<unnamed>";
    consola.warn(`[createChannel] ${ctx.name} failed for "${key}": ${message}`);
    const payloadSnippet = {
      name: channel.name,
      tag: channel.tag,
      type: channel.type,
      models: channel.models,
      group: channel.group,
      hasKey: !!channel.key,
    };
    recordUpstreamError({ op: "createChannel", key, message, payloadSnippet });
    return null;
  }
  return data.data?.id ?? 0;
}

export async function updateChannel(
  ctx: ClientContext,
  channel: Channel,
): Promise<boolean> {
  if (!channel.id) return false;
  const data = await tryFetchJson<ApiResponse>(`${ctx.baseUrl}/api/channel/`, {
    method: "PUT",
    headers: ctx.headers,
    body: channel,
    ...FETCH_OPTS,
  });
  return recordIfFailed(
    data,
    "updateChannel",
    channel.name ?? `id=${channel.id}`,
  );
}

export async function deleteChannel(
  ctx: ClientContext,
  id: number,
): Promise<boolean> {
  const data = await tryFetchJson<ApiResponse>(
    `${ctx.baseUrl}/api/channel/${id}`,
    { method: "DELETE", headers: ctx.headers, ...FETCH_OPTS },
  );
  return recordIfFailed(data, "deleteChannel", `id=${id}`);
}

export async function listModels(ctx: ClientContext): Promise<ModelMeta[]> {
  // Only /api/models/list. The trailing-slash form was kept as a fallback for
  // older gateways, but gin 301s `/api/models/` to `/api/models`, which is the
  // public dashboard list: it accepts anonymous callers and rejects any bearer it
  // does not recognise, and the scoped sync token is one of those. Every run was
  // therefore writing an auth-rejected audit row (406 a week from the cluster)
  // for a request that never contributed a model.
  const endpoints = [`${ctx.baseUrl}/api/models/list`];
  // Pick the endpoint that returns an items array on page 0, then paginate the
  // SAME endpoint from page 0 uniformly. The old code probed `p=0` then continued
  // from `p=1`, which silently dropped or duplicated a page whenever the chosen
  // endpoint's paging didn't line up - leaving the snapshot incomplete. A model
  // missing from the snapshot looks "new" to diff.ts, which POSTs createModel, and
  // new-api soft-deletes the real row on the name collision (the recurring
  // disappearing-metadata bug). One consistent pager prevents that.
  const probe = (
    await Promise.all(
      endpoints.map(async (base) => {
        const data = await tryFetchJson<
          ApiResponse<{ items?: ModelMeta[]; total?: number }>
        >(`${base}?p=0&page_size=${PS}`, {
          headers: ctx.headers,
          ...FETCH_OPTS,
        });
        return Array.isArray(data?.data?.items)
          ? { base, total: data!.data!.total }
          : null;
      }),
    )
  ).find((r) => r !== null);
  if (!probe) return [];

  // Some new-api builds are 1-indexed (p=0 and p=1 return the same first page),
  // so paginating from 0 can re-fetch a page; dedup by id to absorb that. Keep
  // paging while a page is full.
  const byId = new Map<number, ModelMeta>();
  let page = 0;
  while (true) {
    const data = await fetchJson<ApiResponse<{ items?: ModelMeta[] }>>(
      `${probe.base}?p=${page}&page_size=${PS}`,
      {
        headers: ctx.headers,
        ...FETCH_OPTS,
      },
    );
    const items = data.data?.items ?? [];
    for (const m of items) if (m.id != null) byId.set(m.id, m);
    if (items.length < PS) break;
    page++;
  }
  const all = [...byId.values()];

  // Completeness guard: a short snapshot (failed/timed-out page) makes diff.ts see
  // live models as "new" and POST createModel, which new-api answers by
  // soft-deleting the real row on the unique-name collision (the recurring
  // disappearing-metadata bug). Refuse to return a partial list instead.
  if (probe.total != null && all.length < probe.total)
    throw new Error(
      t("ERROR.NEWAPI_MODEL_LIST_INCOMPLETE", {
        got: all.length,
        total: probe.total,
      }),
    );
  return all;
}

export async function createModel(
  ctx: ClientContext,
  model: Omit<ModelMeta, "id">,
): Promise<boolean> {
  const data = await tryFetchJson<ApiResponse>(`${ctx.baseUrl}/api/models/`, {
    method: "POST",
    headers: ctx.headers,
    body: model,
  });
  return recordIfFailed(data, "createModel", model.model_name ?? "<unnamed>", {
    model_name: model.model_name,
    vendor_id: model.vendor_id,
    endpoints: model.endpoints,
  });
}

export async function updateModel(
  ctx: ClientContext,
  model: ModelMeta,
): Promise<boolean> {
  const data = await tryFetchJson<ApiResponse>(`${ctx.baseUrl}/api/models/`, {
    method: "PUT",
    headers: ctx.headers,
    body: model,
  });
  return recordIfFailed(
    data,
    "updateModel",
    model.model_name ?? `id=${model.id}`,
  );
}

export async function deleteModel(
  ctx: ClientContext,
  id: number,
): Promise<boolean> {
  const data = await tryFetchJson<ApiResponse>(
    `${ctx.baseUrl}/api/models/${id}`,
    { method: "DELETE", headers: ctx.headers },
  );
  return recordIfFailed(data, "deleteModel", `id=${id}`);
}

export async function listVendors(ctx: ClientContext): Promise<Vendor[]> {
  return paginate(async (page) => {
    const data = await fetchJson<ApiResponse<{ items?: Vendor[] }>>(
      `${ctx.baseUrl}/api/vendors/?p=${page}&page_size=${PS}`,
      { headers: ctx.headers, ...FETCH_OPTS },
    );
    return data.data?.items ?? [];
  }, PAGINATION.START_PAGE_ONE);
}

export async function createVendor(
  ctx: ClientContext,
  vendor: { name: string; icon?: string },
): Promise<Vendor | null> {
  const data = await tryFetchJson<ApiResponse<Vendor>>(
    `${ctx.baseUrl}/api/vendors/`,
    { method: "POST", headers: ctx.headers, body: vendor },
  );
  if (!data?.success) {
    recordUpstreamError({
      op: "createVendor",
      key: vendor.name,
      message: data?.message ?? "no response",
    });
    return null;
  }
  return data.data ?? null;
}

export async function updateVendor(
  ctx: ClientContext,
  vendor: { id: number; name: string; icon?: string },
): Promise<boolean> {
  const data = await tryFetchJson<ApiResponse>(`${ctx.baseUrl}/api/vendors/`, {
    method: "PUT",
    headers: ctx.headers,
    body: vendor,
  });
  return recordIfFailed(data, "updateVendor", vendor.name);
}

// Rebuild the abilities table from the channels table (new-api FixAbility:
// truncate + re-add + channel cache reload). Heals enabled-state drift and
// orphaned abilities left by out-of-band channel edits (raw SQL, crashes).
// Returns clean=true ONLY on a fully-successful rebuild (fails=0): a partial
// rebuild leaves failed channels with ZERO ability rows, and a subsequent
// orphaned-model cleanup would then delete their models as "unbound".
export async function fixAbilities(
  ctx: ClientContext,
): Promise<{ clean: boolean }> {
  const data = await tryFetchJson<
    ApiResponse<{ success?: number; fails?: number }>
  >(`${ctx.baseUrl}/api/channel/fix`, {
    method: "POST",
    headers: ctx.headers,
    timeoutMs: 120_000,
  });
  if (!data?.success) {
    consola.warn(t("CORE.NEWAPI.FIX_ABILITIES_FAILED", { name: ctx.name }));
    return { clean: false };
  }
  const fails = data.data?.fails ?? 0;
  if (fails > 0) {
    consola.warn(
      t("CORE.NEWAPI.FIX_ABILITIES_PARTIAL", { name: ctx.name, fails }),
    );
    return { clean: false };
  }
  return { clean: true };
}

export async function cleanupOrphanedModels(
  ctx: ClientContext,
): Promise<number> {
  const data = await tryFetchJson<ApiResponse<{ deleted: number }>>(
    `${ctx.baseUrl}/api/models/orphaned`,
    { method: "DELETE", headers: ctx.headers },
  );
  if (!data) {
    consola.warn(t("CORE.NEWAPI.ORPHAN_CLEANUP_FAILED", { name: ctx.name }));
    return 0;
  }
  const deleted = data.data?.deleted ?? 0;
  if (deleted > 0)
    consola.info(
      t("CORE.NEWAPI.ORPHAN_CLEANUP_DONE", { name: ctx.name, deleted }),
    );
  return deleted;
}
