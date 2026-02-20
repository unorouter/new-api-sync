import type { Sub2ApiProviderConfig } from "@/config";
import { fetchJson } from "@/lib/http";
import { consola } from "consola";

// ============ Client-local types ============

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

interface Sub2ApiAccount {
  id: number;
  name: string;
  platform: string;
  type: string;
  status: string;
  model_mapping?: Record<string, string>;
}

interface Sub2ApiModel {
  id: string;
  type: string;
  display_name?: string;
}

interface Sub2ApiGroup {
  id: number;
  name: string;
  platform: string;
  status: string;
}

interface Sub2ApiKey {
  id: number;
  key: string;
  name: string;
  group_id?: number;
  status: string;
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
      const response = await fetchJson<
        Sub2ApiResponse<PaginatedData<Sub2ApiAccount>>
      >(
        `${this.baseUrl}/api/v1/admin/accounts?page=${page}&page_size=${pageSize}`,
        { headers: this.adminHeaders },
      );
      if (response.code !== 0 || !response.data) {
        throw new Error(`Account list failed: ${response.message}`);
      }
      const data = response.data;

      allAccounts.push(...data.items);
      if (page >= data.pages) break;
      page++;
    }

    consola.info(`[${this.name}] ${allAccounts.length} accounts found`);
    return allAccounts;
  }

  async getAccountModels(accountId: number): Promise<Sub2ApiModel[]> {
    const response = await fetchJson<Sub2ApiResponse<Sub2ApiModel[]>>(
      `${this.baseUrl}/api/v1/admin/accounts/${accountId}/models`,
      { headers: this.adminHeaders },
    );
    if (response.code !== 0) {
      throw new Error(`Get models failed: ${response.message}`);
    }
    return response.data ?? [];
  }

  async listGroups(): Promise<Sub2ApiGroup[]> {
    const allGroups: Sub2ApiGroup[] = [];
    let page = 1;
    const pageSize = 100;

    while (true) {
      const response = await fetchJson<
        Sub2ApiResponse<PaginatedData<Sub2ApiGroup>>
      >(
        `${this.baseUrl}/api/v1/admin/groups?page=${page}&page_size=${pageSize}`,
        { headers: this.adminHeaders },
      );
      if (response.code !== 0 || !response.data) {
        throw new Error(`Group list failed: ${response.message}`);
      }
      const data = response.data;

      allGroups.push(...data.items);
      if (page >= data.pages) break;
      page++;
    }

    return allGroups;
  }

  async getGroupApiKey(groupId: number): Promise<string | null> {
    const response = await fetchJson<
      Sub2ApiResponse<PaginatedData<Sub2ApiKey>>
    >(
      `${this.baseUrl}/api/v1/admin/groups/${groupId}/api-keys?page=1&page_size=1`,
      { headers: this.adminHeaders },
    );
    if (response.code !== 0 || !response.data) {
      throw new Error(`Get group API keys failed: ${response.message}`);
    }
    const data = response.data;

    const activeKey = data.items.find((k) => k.status === "active");
    return activeKey?.key ?? null;
  }

  async listGatewayModels(apiKey: string, platform: string): Promise<string[]> {
    const isGemini = platform === "gemini";
    const endpoint = isGemini ? "/v1beta/models" : "/v1/models";
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
    };

    const response = await fetchJson<Record<string, unknown>>(
      `${this.baseUrl}${endpoint}`,
      { headers },
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
