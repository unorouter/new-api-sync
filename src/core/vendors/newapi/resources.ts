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

export async function listChannels(ctx: ClientContext): Promise<Channel[]> {
  return paginate(async (page) => {
    const url = `${ctx.baseUrl}/api/channel/?p=${page}&page_size=${PS}`;
    type R = {
      success: boolean;
      data: { data?: Channel[]; items?: Channel[] } | Channel[];
    };
    const data = await fetchJson<R>(url, {
      headers: ctx.headers,
      ...FETCH_OPTS,
    });
    if (!data.success)
      throw new Error(t("ERROR.NEWAPI_CHANNEL_LIST_API_FAILED"));
    return Array.isArray(data.data)
      ? data.data
      : (data.data?.items ?? data.data?.data ?? []);
  }, PAGINATION.START_PAGE_ZERO);
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
  const endpoints = [
    `${ctx.baseUrl}/api/models/list`,
    `${ctx.baseUrl}/api/models/`,
  ];
  const winner = (
    await Promise.all(
      endpoints.map(async (base) => {
        const data = await tryFetchJson<ApiResponse<{ items?: ModelMeta[] }>>(
          `${base}?p=0&page_size=${PS}`,
          { headers: ctx.headers, ...FETCH_OPTS },
        );
        const items = data?.data?.items;
        return Array.isArray(items) ? { base, items } : null;
      }),
    )
  ).find((r) => r !== null);
  if (!winner) return [];
  const all: ModelMeta[] = [...winner.items];
  if (winner.items.length < PS) return all;
  const rest = await paginate(async (page) => {
    const data = await fetchJson<ApiResponse<{ items?: ModelMeta[] }>>(
      `${winner.base}?p=${page}&page_size=${PS}`,
      { headers: ctx.headers, ...FETCH_OPTS },
    );
    return data.data?.items ?? [];
  }, 1);
  all.push(...rest);
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
      `${ctx.baseUrl}/api/vendors/?page=${page}&page_size=${PS}`,
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
