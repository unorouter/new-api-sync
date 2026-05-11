import { fetchJson, tryFetchJson } from "@core/infra/http";
import type { Sub2ApiProviderConfig } from "@core/validations/config";
import { t } from "@server/i18n";
import { consola } from "consola";
import type {
  PaginatedData,
  Sub2ApiAccount,
  Sub2ApiGroup,
  Sub2ApiKey,
  Sub2ApiModel,
  Sub2ApiResponse,
} from "./types";

export class Sub2ApiClient {
  private baseUrl: string;
  private adminApiKey?: string;
  private name: string;

  constructor(config: Sub2ApiProviderConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.adminApiKey = config.adminApiKey;
    this.name = config.name;
  }

  private get adminHeaders(): Record<string, string> {
    return {
      "x-api-key": this.adminApiKey ?? "",
      "Content-Type": "application/json",
    };
  }

  private async paginate<T>(
    path: string,
    onError: (detail: string) => string,
  ): Promise<T[]> {
    const all: T[] = [];
    let page = 1;
    const pageSize = 100;
    while (true) {
      const response = await fetchJson<Sub2ApiResponse<PaginatedData<T>>>(
        `${this.baseUrl}${path}?page=${page}&page_size=${pageSize}`,
        { headers: this.adminHeaders },
      );
      if (response.code !== 0 || !response.data)
        throw new Error(onError(response.message ?? "unknown"));
      all.push(...response.data.items);
      if (page >= response.data.pages) break;
      page++;
    }
    return all;
  }

  async listAccounts(): Promise<Sub2ApiAccount[]> {
    const all = await this.paginate<Sub2ApiAccount>(
      "/api/v1/admin/accounts",
      (detail) => t("ERROR.SUB2API_ACCOUNT_LIST_FAILED", { detail }),
    );
    consola.info(
      t("CORE.SUB2API.ACCOUNTS_FOUND", { name: this.name, count: all.length }),
    );
    return all;
  }

  async getAccountModels(accountId: number): Promise<Sub2ApiModel[]> {
    const response = await fetchJson<Sub2ApiResponse<Sub2ApiModel[]>>(
      `${this.baseUrl}/api/v1/admin/accounts/${accountId}/models`,
      { headers: this.adminHeaders },
    );
    if (response.code !== 0) {
      throw new Error(
        t("ERROR.SUB2API_GET_MODELS_FAILED", {
          detail: response.message ?? "unknown",
        }),
      );
    }
    return response.data ?? [];
  }

  async listGroups(): Promise<Sub2ApiGroup[]> {
    return this.paginate<Sub2ApiGroup>("/api/v1/admin/groups", (detail) =>
      t("ERROR.SUB2API_GROUP_LIST_FAILED", { detail }),
    );
  }

  async getGroupApiKey(groupId: number): Promise<string | null> {
    const response = await fetchJson<
      Sub2ApiResponse<PaginatedData<Sub2ApiKey>>
    >(
      `${this.baseUrl}/api/v1/admin/groups/${groupId}/api-keys?page=1&page_size=1`,
      { headers: this.adminHeaders },
    );
    if (response.code !== 0 || !response.data) {
      throw new Error(
        t("ERROR.SUB2API_GET_GROUP_API_KEYS_FAILED", {
          detail: response.message ?? "unknown",
        }),
      );
    }
    return response.data.items.find((k) => k.status === "active")?.key ?? null;
  }

  async fetchBalance(apiKey: string): Promise<number | null> {
    const data = await tryFetchJson<{
      code?: number;
      data?: { balance?: number };
    }>(`${this.baseUrl}/api/v1/users/me`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!data || data.code !== 0 || data.data?.balance === undefined)
      return null;
    return data.data.balance;
  }

  async listGatewayModels(apiKey: string, platform: string): Promise<string[]> {
    const isGemini = platform === "gemini";
    const endpoint = isGemini ? "/v1beta/models" : "/v1/models";
    const response = await fetchJson<Record<string, unknown>>(
      `${this.baseUrl}${endpoint}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (isGemini) {
      const models = (response.models ?? []) as Array<{ name?: string }>;
      return models
        .map((m) => (m.name ?? "").replace(/^models\//, ""))
        .filter(Boolean);
    }
    const data = (response.data ?? []) as Array<{ id?: string }>;
    return data.map((m) => m.id ?? "").filter(Boolean);
  }
}
