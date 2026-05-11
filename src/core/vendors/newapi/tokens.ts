import { fetchJson, tryFetchJson } from "@core/infra/http";
import { throwIfRunAborted } from "@core/infra/abort";
import type { GroupInfo } from "@core/types";
import { PAGINATION } from "@core/types";
import { t } from "@server/i18n";
import { consola } from "consola";
import type { ClientContext } from "./context";
import type { TokenListResponse, UpstreamToken } from "./types";

export async function listTokens(ctx: ClientContext): Promise<UpstreamToken[]> {
  const allTokens: UpstreamToken[] = [];
  let page = PAGINATION.START_PAGE_ZERO;
  while (true) {
    // Retry token-list pages 3x with backoff. A single missed page during
    // pagination silently truncates the result, which then causes ensureTokens
    // to consider live tokens "stale" and delete them. Better to slow down on
    // a flaky upstream than corrupt state.
    const data = await fetchJson<TokenListResponse>(
      `${ctx.baseUrl}/api/token/?p=${page}&page_size=${PAGINATION.DEFAULT_PAGE_SIZE}`,
      {
        headers: ctx.headers,
        timeoutMs: 30_000,
        retry: 3,
        retryDelayMs: 2000,
      },
    );
    if (!data.success) {
      throw new Error(
        t("ERROR.NEWAPI_TOKEN_LIST_API_FAILED", {
          detail: data.message ? ` (${data.message})` : "",
        }),
      );
    }
    const tokens = Array.isArray(data.data)
      ? data.data
      : (data.data?.items ?? data.data?.data ?? []);
    allTokens.push(...tokens);
    if (tokens.length < PAGINATION.DEFAULT_PAGE_SIZE) break;
    page++;
  }
  return allTokens;
}

export async function createToken(
  ctx: ClientContext,
  name: string,
  group: string,
): Promise<boolean> {
  const data = await tryFetchJson<{ success: boolean; message?: string }>(
    `${ctx.baseUrl}/api/token/`,
    {
      method: "POST",
      headers: ctx.headers,
      body: {
        name,
        group,
        expired_time: -1,
        unlimited_quota: true,
        model_limits_enabled: false,
      },
    },
  );
  if (!data?.success) {
    consola.warn(
      t("CORE.NEWAPI.TOKEN_CREATE_FAILED", {
        name: ctx.name,
        group,
        message: data?.message ?? "unknown",
      }),
    );
    return false;
  }
  return true;
}

export async function getTokenFullKey(
  ctx: ClientContext,
  id: number,
): Promise<string | null> {
  const data = await tryFetchJson<{
    success: boolean;
    data?: { key: string };
  }>(`${ctx.baseUrl}/api/token/${id}/key`, {
    method: "POST",
    headers: ctx.headers,
  });
  if (!data?.success || !data.data?.key) return null;
  return data.data.key;
}

function isMaskedKey(key: string): boolean {
  return key.includes("**");
}

async function resolveFullKey(
  ctx: ClientContext,
  token: UpstreamToken,
): Promise<string | null> {
  const k = token.key;
  if (!isMaskedKey(k)) return k;
  return getTokenFullKey(ctx, token.id);
}

export async function findTokenByKey(
  ctx: ClientContext,
  fullKey: string,
): Promise<UpstreamToken | null> {
  const bare = fullKey.replace(/^sk-/, "");
  const data = await tryFetchJson<TokenListResponse>(
    `${ctx.baseUrl}/api/token/search?token=${encodeURIComponent(bare)}&p=0&page_size=10`,
    { headers: ctx.headers },
  );
  if (!data?.success) return null;
  const items = Array.isArray(data.data)
    ? data.data
    : (data.data?.items ?? data.data?.data ?? []);
  // search uses LIKE; pick the row whose unmasked key starts/ends with the bare
  // key fragments (masked keys come back from list endpoints).
  const head = bare.slice(0, 4);
  const tail = bare.slice(-4);
  return (
    items.find((t) => t.key.startsWith(head) && t.key.endsWith(tail)) ?? null
  );
}

export async function updateTokenModelLimits(
  ctx: ClientContext,
  token: UpstreamToken,
  modelLimits: string,
): Promise<boolean> {
  const body = {
    id: token.id,
    status: token.status,
    name: token.name,
    expired_time: token.expired_time ?? -1,
    remain_quota: token.remain_quota ?? 0,
    unlimited_quota: token.unlimited_quota ?? false,
    model_limits_enabled: true,
    model_limits: modelLimits,
    allow_ips: token.allow_ips ?? "",
    group: token.group,
    cross_group_retry: token.cross_group_retry ?? false,
  };
  const data = await tryFetchJson<{ success: boolean }>(
    `${ctx.baseUrl}/api/token/`,
    { method: "PUT", headers: ctx.headers, body },
  );
  return data?.success ?? false;
}

export async function deleteToken(
  ctx: ClientContext,
  id: number,
): Promise<boolean> {
  const data = await tryFetchJson<{ success: boolean }>(
    `${ctx.baseUrl}/api/token/${id}`,
    { method: "DELETE", headers: ctx.headers },
  );
  return data?.success ?? false;
}

export async function ensureTokens(
  ctx: ClientContext,
  groups: GroupInfo[],
  prefix: string,
  options?: { skipCleanup?: boolean },
): Promise<{
  tokens: Record<string, string>;
  created: number;
  existing: number;
  deleted: number;
}> {
  const result: Record<string, string> = {};
  let created = 0,
    existing = 0,
    deleted = 0;

  const existingTokens = await listTokens(ctx);
  const tokensByName = new Map(existingTokens.map((t) => [t.name, t]));

  const TOKEN_NAME_MAX_BYTES = 30;
  const suffix = `-${prefix}`;
  const suffixBytes = new TextEncoder().encode(suffix).length;
  const tokenNameForGroup = (groupName: string) => {
    const maxBytes = TOKEN_NAME_MAX_BYTES - suffixBytes;
    const encoder = new TextEncoder();
    if (encoder.encode(groupName).length <= maxBytes) {
      return `${groupName}${suffix}`;
    }
    let truncated = "";
    let usedBytes = 0;
    for (const char of groupName) {
      const charBytes = encoder.encode(char).length;
      if (usedBytes + charBytes > maxBytes) break;
      truncated += char;
      usedBytes += charBytes;
    }
    return `${truncated}${suffix}`;
  };
  const desiredTokenNames = new Set(
    groups.map((g) => tokenNameForGroup(g.name)),
  );

  // Skip token cleanup when caller indicates a partial sync (e.g. when
  // the user passed --models <glob>). The current `groups` list only
  // covers groups that produced models matching the filter, so any
  // existing token bound to a non-matching group would look "stale" and
  // get deleted destructively. Better to leave them alone.
  if (!options?.skipCleanup) {
    for (const token of existingTokens) {
      throwIfRunAborted();
      if (
        token.name.endsWith(`-${prefix}`) &&
        !desiredTokenNames.has(token.name)
      ) {
        if (await deleteToken(ctx, token.id)) {
          consola.info(
            t("CORE.NEWAPI.TOKEN_DELETED_STALE", {
              name: ctx.name,
              token: token.name,
            }),
          );
          deleted++;
        }
      }
    }
  }

  const normalizeKey = (key: string) =>
    key.startsWith("sk-") ? key : `sk-${key}`;

  // Phase 1: resolve keys for groups that already had a token in the snapshot
  // we paginated above, and issue create requests for the rest in parallel.
  // upstream's POST /api/token/ returns no ID, so we cannot wire creates to
  // the key endpoint directly — we must re-list once after all creates have
  // happened. Doing this in two phases (vs. relisting after every create)
  // turns N+1 paginated list calls into 2.
  const groupsAwaitingCreate: { group: GroupInfo; tokenName: string }[] = [];
  for (const group of groups) {
    throwIfRunAborted();
    const tokenName = tokenNameForGroup(group.name);
    const existingToken = tokensByName.get(tokenName);
    if (existingToken) {
      const fullKey = await resolveFullKey(ctx, existingToken);
      if (!fullKey) {
        consola.warn(
          t("CORE.NEWAPI.TOKEN_EXISTING_KEY_UNAVAILABLE", {
            name: ctx.name,
            token: tokenName,
          }),
        );
        continue;
      }
      result[group.name] = normalizeKey(fullKey);
      existing++;
    } else {
      groupsAwaitingCreate.push({ group, tokenName });
    }
  }

  if (groupsAwaitingCreate.length > 0) {
    const createResults = await Promise.all(
      groupsAwaitingCreate.map(async (entry) => ({
        ...entry,
        ok: await createToken(ctx, entry.tokenName, entry.group.name),
      })),
    );
    const successfulCreates = createResults.filter((r) => r.ok);
    created += successfulCreates.length;

    if (successfulCreates.length > 0) {
      throwIfRunAborted();
      const refreshed = await listTokens(ctx);
      const refreshedByName = new Map(refreshed.map((tk) => [tk.name, tk]));
      await Promise.all(
        successfulCreates.map(async (entry) => {
          const newToken = refreshedByName.get(entry.tokenName);
          if (!newToken) {
            consola.warn(
              t("CORE.NEWAPI.TOKEN_CREATED_NOT_FOUND", {
                name: ctx.name,
                token: entry.tokenName,
              }),
            );
            return;
          }
          const fullKey = await resolveFullKey(ctx, newToken);
          if (!fullKey) {
            consola.warn(
              t("CORE.NEWAPI.TOKEN_NEW_KEY_UNAVAILABLE", {
                name: ctx.name,
                token: entry.tokenName,
              }),
            );
            return;
          }
          result[entry.group.name] = normalizeKey(fullKey);
        }),
      );
    }
  }

  return { tokens: result, created, existing, deleted };
}
