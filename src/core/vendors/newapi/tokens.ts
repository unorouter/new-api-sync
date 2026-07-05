import { fetchJson, tryFetchJson } from "@core/infra/http";
import { throwIfRunAborted } from "@core/infra/abort";
import { getConcurrencyGate } from "@core/infra/concurrency";
import type { GroupInfo } from "@core/types";
import { PAGINATION } from "@core/types";
import { t } from "@server/i18n";
import { consola } from "consola";
import type { ClientContext } from "./context";
import type { TokenListResponse, UpstreamToken } from "./types";
import pLimit from "p-limit";

const PS = PAGINATION.DEFAULT_PAGE_SIZE;
const extractTokens = (data: TokenListResponse): UpstreamToken[] =>
  Array.isArray(data.data)
    ? data.data
    : (data.data?.items ?? data.data?.data ?? []);

export async function listTokens(ctx: ClientContext): Promise<UpstreamToken[]> {
  const allTokens: UpstreamToken[] = [];
  let page = PAGINATION.START_PAGE_ZERO;
  while (true) {
    const data = await fetchJson<TokenListResponse>(
      `${ctx.baseUrl}/api/token/?p=${page}&page_size=${PS}`,
      { headers: ctx.headers, timeoutMs: 30_000, retry: 3, retryDelayMs: 2000 },
    );
    if (!data.success) {
      const detail = data.message ? ` (${data.message})` : "";
      throw new Error(t("ERROR.NEWAPI_TOKEN_LIST_API_FAILED", { detail }));
    }
    const tokens = extractTokens(data);
    allTokens.push(...tokens);
    if (tokens.length < PS) break;
    page++;
  }
  return allTokens;
}

export async function createToken(
  ctx: ClientContext,
  name: string,
  group: string,
): Promise<{ ok: boolean; key?: string }> {
  const body = {
    name,
    group,
    expired_time: -1,
    unlimited_quota: true,
    model_limits_enabled: false,
  };
  // New-api rate-limits token writes too. Retry on 429.
  const data = await tryFetchJson<{
    success: boolean;
    message?: string;
    data?: { key?: string };
  }>(`${ctx.baseUrl}/api/token/`, {
    method: "POST",
    headers: ctx.headers,
    body,
    retry: 8,
    retryDelayMs: 4000,
  });
  if (!data?.success) {
    consola.warn(
      t("CORE.NEWAPI.TOKEN_CREATE_FAILED", {
        name: ctx.name,
        group,
        message: data?.message ?? "unknown",
      }),
    );
    return { ok: false };
  }
  // Some forks (ephone) return the full key only here and mask it on later reads.
  return { ok: true, key: data.data?.key };
}

export async function getTokenFullKey(
  ctx: ClientContext,
  id: number,
): Promise<string | null> {
  // Per-token endpoint is rate-limited; prefer getTokenFullKeysBatch.
  const data = await tryFetchJson<{ success: boolean; data?: { key: string } }>(
    `${ctx.baseUrl}/api/token/${id}/key`,
    {
      method: "POST",
      headers: ctx.headers,
      retry: 8,
      retryDelayMs: 4000,
    },
  );
  return data?.success && data.data?.key ? data.data.key : null;
}

const TOKEN_BATCH_MAX = 100;

/**
 * Bulk-reveal full keys for up to 100 tokens per call via /api/token/batch/keys.
 * Avoids the per-token rate-limit on /api/token/{id}/key.
 */
export async function getTokenFullKeysBatch(
  ctx: ClientContext,
  ids: number[],
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  for (let i = 0; i < ids.length; i += TOKEN_BATCH_MAX) {
    const batch = ids.slice(i, i + TOKEN_BATCH_MAX);
    const data = await tryFetchJson<{
      success: boolean;
      data?: { keys?: Record<string, string> };
    }>(`${ctx.baseUrl}/api/token/batch/keys`, {
      method: "POST",
      headers: ctx.headers,
      body: { ids: batch },
      retry: 5,
      retryDelayMs: 2000,
    });
    const keys = data?.success ? data.data?.keys : undefined;
    if (!keys) continue;
    for (const [k, v] of Object.entries(keys)) {
      const id = Number(k);
      if (Number.isFinite(id) && v) result.set(id, v);
    }
  }
  return result;
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
  const head = bare.slice(0, 4),
    tail = bare.slice(-4);
  return (
    extractTokens(data).find(
      (t) => t.key.startsWith(head) && t.key.endsWith(tail),
    ) ?? null
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

  const suffix = `-${prefix}`;
  const encoder = new TextEncoder();
  const suffixBytes = encoder.encode(suffix).length;
  const tokenNameForGroup = (groupName: string) => {
    const maxBytes = 30 - suffixBytes;
    if (encoder.encode(groupName).length <= maxBytes)
      return `${groupName}${suffix}`;
    let truncated = "",
      usedBytes = 0;
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
  const normalizeKey = (key: string) =>
    key.startsWith("sk-") ? key : `sk-${key}`;

  if (!options?.skipCleanup) {
    for (const token of existingTokens) {
      throwIfRunAborted();
      if (
        token.name.endsWith(`-${prefix}`) &&
        !desiredTokenNames.has(token.name) &&
        (await deleteToken(ctx, token.id))
      ) {
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

  const groupsAwaitingCreate: { group: GroupInfo; tokenName: string }[] = [];
  const existingNeedingReveal: { group: GroupInfo; token: UpstreamToken }[] =
    [];
  for (const group of groups) {
    throwIfRunAborted();
    const tokenName = tokenNameForGroup(group.name);
    const existingToken = tokensByName.get(tokenName);
    if (!existingToken) {
      groupsAwaitingCreate.push({ group, tokenName });
      continue;
    }
    if (existingToken.key.includes("**")) {
      existingNeedingReveal.push({ group, token: existingToken });
    } else {
      result[group.name] = normalizeKey(existingToken.key);
      existing++;
    }
  }

  // Batch-reveal all masked existing keys in one call.
  if (existingNeedingReveal.length > 0) {
    const ids = existingNeedingReveal.map((e) => e.token.id);
    const batchKeys = await getTokenFullKeysBatch(ctx, ids);
    for (const entry of existingNeedingReveal) {
      const fullKey = batchKeys.get(entry.token.id);
      if (!fullKey) {
        // Forks that mask keys and expose no reveal endpoint (ephone) return the
        // full key only on create; delete the masked token and recreate below.
        if (await deleteToken(ctx, entry.token.id)) {
          groupsAwaitingCreate.push({
            group: entry.group,
            tokenName: entry.token.name,
          });
          continue;
        }
        consola.warn(
          t("CORE.NEWAPI.TOKEN_EXISTING_KEY_UNAVAILABLE", {
            name: ctx.name,
            token: entry.token.name,
          }),
        );
        continue;
      }
      result[entry.group.name] = normalizeKey(fullKey);
      existing++;
    }
  }

  if (groupsAwaitingCreate.length === 0)
    return { tokens: result, created, existing, deleted };

  // Throttle creates to 2; gate.run so they count toward the global cap, not bypass it.
  const createLimit = pLimit(2);
  const gate = getConcurrencyGate();
  const createResults = await Promise.all(
    groupsAwaitingCreate.map((entry) =>
      createLimit(() =>
        gate.run(ctx.baseUrl, async () => {
          const created = await createToken(ctx, entry.tokenName, entry.group.name);
          return { ...entry, ok: created.ok, inlineKey: created.key };
        }),
      ),
    ),
  );
  const successfulCreates = createResults.filter((r) => r.ok);
  created += successfulCreates.length;

  if (successfulCreates.length > 0) {
    throwIfRunAborted();
    // Forks that return the full key on create (ephone) are done here; only fall
    // back to a list + reveal for those whose create response carried no key.
    const needLookup = successfulCreates.filter((entry) => {
      if (entry.inlineKey) {
        result[entry.group.name] = normalizeKey(entry.inlineKey);
        return false;
      }
      return true;
    });
    const refreshedByName =
      needLookup.length > 0
        ? new Map((await listTokens(ctx)).map((tk) => [tk.name, tk]))
        : new Map<string, UpstreamToken>();
    const newTokensNeedingReveal: {
      entry: (typeof successfulCreates)[number];
      token: UpstreamToken;
    }[] = [];
    for (const entry of needLookup) {
      const newToken = refreshedByName.get(entry.tokenName);
      const ctxParams = { name: ctx.name, token: entry.tokenName };
      if (!newToken) {
        consola.warn(t("CORE.NEWAPI.TOKEN_CREATED_NOT_FOUND", ctxParams));
        continue;
      }
      if (newToken.key.includes("**")) {
        newTokensNeedingReveal.push({ entry, token: newToken });
      } else {
        result[entry.group.name] = normalizeKey(newToken.key);
      }
    }
    if (newTokensNeedingReveal.length > 0) {
      const ids = newTokensNeedingReveal.map((e) => e.token.id);
      const batchKeys = await getTokenFullKeysBatch(ctx, ids);
      for (const item of newTokensNeedingReveal) {
        const fullKey = batchKeys.get(item.token.id);
        const ctxParams = { name: ctx.name, token: item.entry.tokenName };
        if (!fullKey) {
          consola.warn(t("CORE.NEWAPI.TOKEN_NEW_KEY_UNAVAILABLE", ctxParams));
          continue;
        }
        result[item.entry.group.name] = normalizeKey(fullKey);
      }
    }
  }

  return { tokens: result, created, existing, deleted };
}
