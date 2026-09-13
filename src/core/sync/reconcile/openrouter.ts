import { fetchJson } from "@core/infra/http";
import type { OpenRouterProviderConfig } from "@core/validations/config";
import type { OpenRouterForeignKey, OpenRouterReconcile } from "./types";

const PAGE = 100;

type RemoteKey = {
  name?: string;
  hash?: string;
  disabled?: boolean;
  limit?: number | null;
  usage?: number;
  usage_daily?: number;
  created_at?: string;
};

// Sync-minted keys are `<provider>/<model>` (vendors/openrouter/keys.ts);
// anything else on the account was created by hand or by someone else.
export async function checkOpenRouterKeys(
  provider: OpenRouterProviderConfig,
): Promise<OpenRouterReconcile> {
  const out: OpenRouterReconcile = {
    name: provider.name,
    status: "ok",
    foreignKeys: [],
  };
  if (!provider.managementKey) {
    out.status = "no-management-key";
    return out;
  }
  const base = (provider.baseUrl ?? "https://openrouter.ai/api").replace(
    /\/$/,
    "",
  );
  try {
    const keys: RemoteKey[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const body = await fetchJson<{ data?: RemoteKey[] }>(
        `${base}/v1/keys?include_disabled=true&offset=${offset}`,
        {
          headers: { Authorization: `Bearer ${provider.managementKey}` },
          timeoutMs: 30_000,
          retry: 3,
          retryDelayMs: 2000,
        },
      );
      const page = body?.data ?? [];
      keys.push(...page);
      if (page.length < PAGE) break;
    }
    const prefix = `${provider.name}/`;
    out.foreignKeys = keys
      .filter((k) => !(k.name ?? "").startsWith(prefix))
      .map(
        (k): OpenRouterForeignKey => ({
          name: k.name ?? "",
          hash: k.hash,
          disabled: k.disabled,
          limit: k.limit,
          usage: k.usage,
          usageDaily: k.usage_daily,
          createdAt: k.created_at,
        }),
      )
      .sort((a, b) => (b.usage ?? 0) - (a.usage ?? 0));
  } catch (err) {
    out.status = "error";
    out.error = err instanceof Error ? err.message : String(err);
  }
  return out;
}
