import { fetchJson, tryFetchJson } from "@core/runtime/http";
import type { Channel, ModelMeta, Vendor } from "@core/types";
import { PAGINATION } from "@core/types";
import { t } from "@server/i18n";
import { consola } from "consola";
import type { ClientContext } from "./context";
import type { ApiResponse } from "./types";

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
      { headers: ctx.headers },
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
  if (!data?.success) return null;
  return data.data?.id ?? 0;
}

export async function updateChannel(
  ctx: ClientContext,
  channel: Channel,
): Promise<boolean> {
  if (!channel.id) return false;
  const data = await tryFetchJson<ApiResponse>(
    `${ctx.baseUrl}/api/channel/`,
    { method: "PUT", headers: ctx.headers, body: channel },
  );
  return data?.success ?? false;
}

export async function deleteChannel(
  ctx: ClientContext,
  id: number,
): Promise<boolean> {
  const data = await tryFetchJson<ApiResponse>(
    `${ctx.baseUrl}/api/channel/${id}`,
    { method: "DELETE", headers: ctx.headers },
  );
  return data?.success ?? false;
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
      { headers: ctx.headers },
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
      { headers: ctx.headers },
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
  const data = await tryFetchJson<ApiResponse>(
    `${ctx.baseUrl}/api/models/`,
    { method: "POST", headers: ctx.headers, body: model },
  );
  return data?.success ?? false;
}

export async function updateModel(
  ctx: ClientContext,
  model: ModelMeta,
): Promise<boolean> {
  const data = await tryFetchJson<ApiResponse>(
    `${ctx.baseUrl}/api/models/`,
    { method: "PUT", headers: ctx.headers, body: model },
  );
  return data?.success ?? false;
}

export async function deleteModel(
  ctx: ClientContext,
  id: number,
): Promise<boolean> {
  const data = await tryFetchJson<ApiResponse>(
    `${ctx.baseUrl}/api/models/${id}`,
    { method: "DELETE", headers: ctx.headers },
  );
  return data?.success ?? false;
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
      { headers: ctx.headers },
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
  return data?.data ?? null;
}

export async function updateVendor(
  ctx: ClientContext,
  vendor: { id: number; name: string; icon?: string },
): Promise<boolean> {
  const data = await tryFetchJson<ApiResponse>(
    `${ctx.baseUrl}/api/vendors/`,
    {
      method: "PUT",
      headers: ctx.headers,
      body: vendor,
    },
  );
  return data?.success ?? false;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export async function cleanupOrphanedModels(ctx: ClientContext): Promise<number> {
  const data = await tryFetchJson<ApiResponse<{ deleted: number }>>(
    `${ctx.baseUrl}/api/models/orphaned`,
    { method: "DELETE", headers: ctx.headers },
  );
  if (!data) {
    consola.warn(
      t("CORE.NEWAPI.ORPHAN_CLEANUP_FAILED", { name: ctx.name }),
    );
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
