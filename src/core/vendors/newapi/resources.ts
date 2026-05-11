import { fetchJson, tryFetchJson } from "@core/infra/http";
import type { Channel, ModelMeta, Vendor } from "@core/types";
import { PAGINATION } from "@core/types";
import { t } from "@server/i18n";
import { consola } from "consola";
import type { ClientContext } from "./context";
import type { ApiResponse } from "./types";

// Pagination loops over flaky upstreams need higher tolerance than one-shot
// requests. Default ofetch retry is 1; a single missed page truncates the
// result, which then makes the diff phase delete live entities as "stale".
const PAGINATED_FETCH_OPTS = {
  timeoutMs: 15_000,
  retry: 2,
  retryDelayMs: 2000,
} as const;

/**
 * Module-scoped buffer of the most recent upstream error per (operation, key).
 * Resource functions write into it on failure; apply.ts drains it when
 * recording an `ApplyError` so the upstream's actual reason ("channel cannot
 * be empty", "name already exists", "key invalid") survives instead of being
 * collapsed into the generic "FAIL_CREATE" i18n string. Dump separately so
 * `writeApplyErrors()` can serialize the trail to logs/{ts}-apply-errors.json.
 */
export interface UpstreamErrorEntry {
  op: "createChannel" | "updateChannel" | "deleteChannel" | "createModel" | "updateModel" | "deleteModel" | "createVendor" | "updateVendor";
  key: string;
  status?: number;
  message: string;
  payloadSnippet?: unknown;
  at: string;
}
const upstreamErrors: UpstreamErrorEntry[] = [];
export function recordUpstreamError(e: Omit<UpstreamErrorEntry, "at">): void {
  upstreamErrors.push({ ...e, at: new Date().toISOString() });
}
export function drainUpstreamErrors(): UpstreamErrorEntry[] {
  const out = upstreamErrors.slice();
  upstreamErrors.length = 0;
  return out;
}
/** Read-only lookup by key. apply.ts uses this to enrich generic ApplyErrors
 *  with the upstream's real message without removing the entry from the
 *  buffer (the buffer is later drained by writeApplyErrorsLog).
 *  Returns the LAST entry for the key, since a retry could record twice. */
export function peekUpstreamError(key: string): UpstreamErrorEntry | undefined {
  for (let i = upstreamErrors.length - 1; i >= 0; i--) {
    if (upstreamErrors[i]!.key === key) return upstreamErrors[i];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Channel CRUD
// ---------------------------------------------------------------------------

export async function listChannels(ctx: ClientContext): Promise<Channel[]> {
  const all: Channel[] = [];
  let page = PAGINATION.START_PAGE_ZERO;
  while (true) {
    const data = await fetchJson<{
      success: boolean;
      data: { data?: Channel[]; items?: Channel[] } | Channel[];
    }>(
      `${ctx.baseUrl}/api/channel/?p=${page}&page_size=${PAGINATION.DEFAULT_PAGE_SIZE}`,
      { headers: ctx.headers, ...PAGINATED_FETCH_OPTS },
    );
    if (!data.success) {
      throw new Error(t("ERROR.NEWAPI_CHANNEL_LIST_API_FAILED"));
    }
    const items = Array.isArray(data.data)
      ? data.data
      : (data.data?.items ?? data.data?.data ?? []);
    all.push(...items);
    if (items.length < PAGINATION.DEFAULT_PAGE_SIZE) break;
    page++;
  }
  return all;
}

export async function createChannel(
  ctx: ClientContext,
  channel: Omit<Channel, "id">,
): Promise<number | null> {
  let data = await tryFetchJson<ApiResponse<{ id: number }>>(
    `${ctx.baseUrl}/api/channel/`,
    {
      method: "POST",
      headers: ctx.headers,
      body: { mode: "single", channel },
    },
  );
  if (!data) {
    data = await tryFetchJson<ApiResponse<{ id: number }>>(
      `${ctx.baseUrl}/api/channel/`,
      { method: "POST", headers: ctx.headers, body: channel },
    );
  }
  if (!data?.success) {
    const message = data?.message ?? "no response";
    const key = channel.name ?? channel.tag ?? "<unnamed>";
    consola.warn(`[createChannel] ${ctx.name} failed for "${key}": ${message}`);
    recordUpstreamError({
      op: "createChannel",
      key,
      message,
      payloadSnippet: {
        name: channel.name,
        tag: channel.tag,
        type: channel.type,
        models: channel.models,
        group: channel.group,
        hasKey: !!channel.key,
      },
    });
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
  });
  if (!data?.success) {
    recordUpstreamError({
      op: "updateChannel",
      key: channel.name ?? `id=${channel.id}`,
      message: data?.message ?? "no response",
    });
    return false;
  }
  return true;
}

export async function deleteChannel(
  ctx: ClientContext,
  id: number,
): Promise<boolean> {
  const data = await tryFetchJson<ApiResponse>(
    `${ctx.baseUrl}/api/channel/${id}`,
    { method: "DELETE", headers: ctx.headers },
  );
  if (!data?.success) {
    recordUpstreamError({
      op: "deleteChannel",
      key: `id=${id}`,
      message: data?.message ?? "no response",
    });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Model CRUD
// ---------------------------------------------------------------------------

export async function listModels(ctx: ClientContext): Promise<ModelMeta[]> {
  const endpoints = [
    `${ctx.baseUrl}/api/models/list`,
    `${ctx.baseUrl}/api/models/`,
  ];
  const tryEndpoint = async (
    base: string,
  ): Promise<{ base: string; items: ModelMeta[] } | null> => {
    const data = await tryFetchJson<ApiResponse<{ items?: ModelMeta[] }>>(
      `${base}?p=0&page_size=${PAGINATION.DEFAULT_PAGE_SIZE}`,
      { headers: ctx.headers, ...PAGINATED_FETCH_OPTS },
    );
    const items = data?.data?.items;
    if (!Array.isArray(items)) return null;
    return { base, items };
  };

  const results = await Promise.all(endpoints.map(tryEndpoint));
  const winner = results.find((r) => r !== null);
  if (!winner) return [];

  const all: ModelMeta[] = [...winner.items];
  if (winner.items.length < PAGINATION.DEFAULT_PAGE_SIZE) return all;

  let page = 1;
  while (true) {
    const data = await fetchJson<ApiResponse<{ items?: ModelMeta[] }>>(
      `${winner.base}?p=${page}&page_size=${PAGINATION.DEFAULT_PAGE_SIZE}`,
      { headers: ctx.headers, ...PAGINATED_FETCH_OPTS },
    );
    const items = data.data?.items ?? [];
    all.push(...items);
    if (items.length < PAGINATION.DEFAULT_PAGE_SIZE) break;
    page++;
  }
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
  if (!data?.success) {
    recordUpstreamError({
      op: "createModel",
      key: model.model_name ?? "<unnamed>",
      message: data?.message ?? "no response",
      payloadSnippet: {
        model_name: model.model_name,
        vendor_id: model.vendor_id,
        endpoints: model.endpoints,
      },
    });
    return false;
  }
  return true;
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
  if (!data?.success) {
    recordUpstreamError({
      op: "updateModel",
      key: model.model_name ?? `id=${model.id}`,
      message: data?.message ?? "no response",
    });
    return false;
  }
  return true;
}

export async function deleteModel(
  ctx: ClientContext,
  id: number,
): Promise<boolean> {
  const data = await tryFetchJson<ApiResponse>(
    `${ctx.baseUrl}/api/models/${id}`,
    { method: "DELETE", headers: ctx.headers },
  );
  if (!data?.success) {
    recordUpstreamError({
      op: "deleteModel",
      key: `id=${id}`,
      message: data?.message ?? "no response",
    });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Vendor CRUD
// ---------------------------------------------------------------------------

export async function listVendors(ctx: ClientContext): Promise<Vendor[]> {
  const all: Vendor[] = [];
  let page = PAGINATION.START_PAGE_ONE;
  while (true) {
    const data = await fetchJson<ApiResponse<{ items?: Vendor[] }>>(
      `${ctx.baseUrl}/api/vendors/?page=${page}&page_size=${PAGINATION.DEFAULT_PAGE_SIZE}`,
      { headers: ctx.headers, ...PAGINATED_FETCH_OPTS },
    );
    const items = data.data?.items ?? [];
    all.push(...items);
    if (items.length < PAGINATION.DEFAULT_PAGE_SIZE) break;
    page++;
  }
  return all;
}

export async function createVendor(
  ctx: ClientContext,
  vendor: { name: string; icon?: string },
): Promise<Vendor | null> {
  const data = await tryFetchJson<ApiResponse<Vendor>>(
    `${ctx.baseUrl}/api/vendors/`,
    {
      method: "POST",
      headers: ctx.headers,
      body: vendor,
    },
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
  if (!data?.success) {
    recordUpstreamError({
      op: "updateVendor",
      key: vendor.name,
      message: data?.message ?? "no response",
    });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

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
  if (deleted > 0) {
    consola.info(
      t("CORE.NEWAPI.ORPHAN_CLEANUP_DONE", { name: ctx.name, deleted }),
    );
  }
  return deleted;
}
