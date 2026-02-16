import { withRetry } from "@/lib/constants";
import type { Sub2ApiAccount, Sub2ApiGroup, Sub2ApiKey, Sub2ApiModel, Sub2ApiProviderConfig } from "@/lib/types";
import { consola } from "consola";

interface Sub2ApiResponse<T = unknown> {
  code: number;
  message: string;
  data?: T;
}

interface PaginatedData<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}

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

  async listAccounts(): Promise<Sub2ApiAccount[]> {
    const allAccounts: Sub2ApiAccount[] = [];
    let page = 1;
    const pageSize = 100;

    while (true) {
      const data = await withRetry(async () => {
        const response = await fetch(
          `${this.baseUrl}/api/v1/admin/accounts?page=${page}&page_size=${pageSize}`,
          { headers: this.adminHeaders },
        );
        if (!response.ok)
          throw new Error(`Failed to list accounts: ${response.status}`);
        const data = (await response.json()) as Sub2ApiResponse<PaginatedData<Sub2ApiAccount>>;
        if (data.code !== 0) throw new Error(`Account list failed: ${data.message}`);
        return data.data!;
      });

      allAccounts.push(...data.items);
      if (page >= data.pages) break;
      page++;
    }

    consola.info(`[${this.name}] ${allAccounts.length} accounts found`);
    return allAccounts;
  }

  async getAccountModels(accountId: number): Promise<Sub2ApiModel[]> {
    const data = await withRetry(async () => {
      const response = await fetch(
        `${this.baseUrl}/api/v1/admin/accounts/${accountId}/models`,
        { headers: this.adminHeaders },
      );
      if (!response.ok)
        throw new Error(`Failed to get models for account ${accountId}: ${response.status}`);
      const data = (await response.json()) as Sub2ApiResponse<Sub2ApiModel[]>;
      if (data.code !== 0) throw new Error(`Get models failed: ${data.message}`);
      return data.data ?? [];
    });

    return data;
  }

  async listGroups(): Promise<Sub2ApiGroup[]> {
    const allGroups: Sub2ApiGroup[] = [];
    let page = 1;
    const pageSize = 100;

    while (true) {
      const data = await withRetry(async () => {
        const response = await fetch(
          `${this.baseUrl}/api/v1/admin/groups?page=${page}&page_size=${pageSize}`,
          { headers: this.adminHeaders },
        );
        if (!response.ok)
          throw new Error(`Failed to list groups: ${response.status}`);
        const data = (await response.json()) as Sub2ApiResponse<PaginatedData<Sub2ApiGroup>>;
        if (data.code !== 0) throw new Error(`Group list failed: ${data.message}`);
        return data.data!;
      });

      allGroups.push(...data.items);
      if (page >= data.pages) break;
      page++;
    }

    return allGroups;
  }

  async getGroupApiKey(groupId: number): Promise<string | null> {
    const data = await withRetry(async () => {
      const response = await fetch(
        `${this.baseUrl}/api/v1/admin/groups/${groupId}/api-keys?page=1&page_size=1`,
        { headers: this.adminHeaders },
      );
      if (!response.ok)
        throw new Error(`Failed to get group API keys: ${response.status}`);
      const data = (await response.json()) as Sub2ApiResponse<PaginatedData<Sub2ApiKey>>;
      if (data.code !== 0) throw new Error(`Get group API keys failed: ${data.message}`);
      return data.data!;
    });

    const activeKey = data.items.find((k) => k.status === "active");
    return activeKey?.key ?? null;
  }

  async listGatewayModels(apiKey: string, platform: string): Promise<string[]> {
    const isGemini = platform === "gemini";
    const endpoint = isGemini ? "/v1beta/models" : "/v1/models";
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
    };

    const response = await withRetry(async () => {
      const res = await fetch(`${this.baseUrl}${endpoint}`, { headers });
      if (!res.ok) throw new Error(`Failed to list models: ${res.status}`);
      return res.json() as Promise<Record<string, unknown>>;
    });

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
