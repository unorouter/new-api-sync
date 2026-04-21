import { throwIfRunAborted } from "@core/runtime/abort";
import { fetchJson, tryFetchJson } from "@core/runtime/http";
import { PAGINATION } from "@core/models/constants";
import type { GroupInfo } from "@core/types";
import { t } from "@server/i18n";
import { consola } from "consola";
import type { ClientContext } from "./context";
import type { TokenListResponse, UpstreamToken } from "./types";

export async function listTokens(ctx: ClientContext): Promise<UpstreamToken[]> {
  const allTokens: UpstreamToken[] = [];
  let page = PAGINATION.START_PAGE_ZERO;
  while (true) {
    const data = await fetchJson<TokenListResponse>(
      `${ctx.baseUrl}/api/token/?p=${page}&page_size=${PAGINATION.DEFAULT_PAGE_SIZE}`,
      { headers: ctx.headers },
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

  const normalizeKey = (key: string) =>
    key.startsWith("sk-") ? key : `sk-${key}`;

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
      if (!(await createToken(ctx, tokenName, group.name))) continue;
      created++;
      const updatedTokens = await listTokens(ctx);
      const newToken = updatedTokens.find((t) => t.name === tokenName);
      if (!newToken) {
        consola.warn(
          t("CORE.NEWAPI.TOKEN_CREATED_NOT_FOUND", {
            name: ctx.name,
            token: tokenName,
          }),
        );
        continue;
      }
      const fullKey = await resolveFullKey(ctx, newToken);
      if (!fullKey) {
        consola.warn(
          t("CORE.NEWAPI.TOKEN_NEW_KEY_UNAVAILABLE", {
            name: ctx.name,
            token: tokenName,
          }),
        );
        continue;
      }
      result[group.name] = normalizeKey(fullKey);
    }
  }

  return { tokens: result, created, existing, deleted };
}
