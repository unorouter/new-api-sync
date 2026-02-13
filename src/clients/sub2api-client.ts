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
  private adminApiKey: string;
  private name: string;

  constructor(config: Sub2ApiProviderConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.adminApiKey = config.adminApiKey;
    this.name = config.name;
  }

  private get adminHeaders(): Record<string, string> {
    return {
      "x-api-key": this.adminApiKey,
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

  async testAccount(accountId: number): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      try {
        const response = await fetch(
          `${this.baseUrl}/api/v1/admin/accounts/${accountId}/test`,
          {
            method: "POST",
            headers: this.adminHeaders,
            signal: controller.signal,
          },
        );

        if (!response.ok) return false;
        if (!response.body) return false;

        // Parse SSE stream to determine success/failure
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let success = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const text = decoder.decode(value, { stream: true });
          const lines = text.split("\n");

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6)) as {
                type?: string;
                success?: boolean;
                error?: string;
              };
              if (event.type === "message_stop") {
                success = event.success ?? true;
              }
              if (event.type === "error") {
                return false;
              }
            } catch {
              // Skip non-JSON lines
            }
          }
        }

        return success;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch {
      return false;
    }
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
}
