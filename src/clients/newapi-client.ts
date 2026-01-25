import { inferChannelType, PAGINATION } from "@/lib/constants";
import type {
  ApiResponse,
  Channel,
  GroupInfo,
  ModelInfo,
  ModelMeta,
  NewApiConfig,
  PricingResponse,
  TokenListResponse,
  UpstreamPricing,
  UpstreamToken,
  Vendor,
} from "@/lib/types";
import { ModelTester } from "@/service/model-tester";
import { consola } from "consola";

export class NewApiClient {
  private config: NewApiConfig;
  private _name?: string;

  constructor(config: NewApiConfig, name?: string) {
    this.config = {
      baseUrl: config.baseUrl.replace(/\/$/, ""),
      systemAccessToken: config.systemAccessToken,
      userId: config.userId,
    };
    this._name = name;
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.systemAccessToken}`,
      "New-Api-User": String(this.config.userId),
      "Content-Type": "application/json",
    };
  }

  private get baseUrl(): string {
    return this.config.baseUrl;
  }

  private get name(): string {
    return this._name ?? "target";
  }

  // ============ Provider Methods (fetch from upstream) ============

  async fetchBalance(): Promise<string> {
    try {
      const response = await fetch(`${this.baseUrl}/api/user/self`, {
        headers: this.headers,
      });
      if (!response.ok) return "N/A";
      const data = (await response.json()) as {
        success: boolean;
        data?: { quota?: number; used_quota?: number };
      };
      if (!data.success || !data.data) return "N/A";
      const quota = (data.data.quota ?? 0) / 500000;
      return `$${quota.toFixed(2)}`;
    } catch {
      return "N/A";
    }
  }

  async fetchPricing(): Promise<UpstreamPricing> {
    const response = await fetch(`${this.baseUrl}/api/pricing`);
    if (!response.ok)
      throw new Error(`Failed to fetch pricing: ${response.status}`);
    const data = (await response.json()) as PricingResponse;
    if (!data.success) throw new Error("Pricing API returned success: false");

    const groupModels = new Map<string, Set<string>>();
    const groupEndpoints = new Map<string, Set<string>>();
    for (const model of data.data) {
      for (const group of model.enable_groups) {
        if (!groupModels.has(group)) {
          groupModels.set(group, new Set());
          groupEndpoints.set(group, new Set());
        }
        groupModels.get(group)!.add(model.model_name);
        for (const endpoint of model.supported_endpoint_types) {
          groupEndpoints.get(group)!.add(endpoint);
        }
      }
    }

    const groups: GroupInfo[] = Object.entries(data.usable_group)
      .filter(([name]) => name !== "")
      .map(([name, description]) => ({
        name,
        description,
        ratio: data.group_ratio[name] ?? 1,
        models: Array.from(groupModels.get(name) ?? []),
        channelType: inferChannelType(
          Array.from(groupEndpoints.get(name) ?? []),
        ),
      }));

    const models: ModelInfo[] = data.data.map((m) => ({
      name: m.model_name,
      ratio: m.model_ratio,
      completionRatio: m.completion_ratio,
      groups: m.enable_groups,
      vendorId: m.vendor_id,
      supportedEndpoints: m.supported_endpoint_types,
    }));

    const modelRatios: Record<string, number> = {};
    const completionRatios: Record<string, number> = {};
    for (const m of data.data) {
      if (m.model_ratio > 0) modelRatios[m.model_name] = m.model_ratio;
      if (m.completion_ratio > 0)
        completionRatios[m.model_name] = m.completion_ratio;
    }

    const vendorIdToName: Record<number, string> = {};
    if (data.vendors) {
      for (const v of data.vendors) {
        vendorIdToName[v.id] = v.name;
      }
    }

    consola.info(`[${this.name}] ${groups.length} groups, ${models.length} models`);

    return {
      groups,
      models,
      groupRatios: data.group_ratio,
      modelRatios,
      completionRatios,
      vendorIdToName,
    };
  }

  async listTokens(): Promise<UpstreamToken[]> {
    const allTokens: UpstreamToken[] = [];
    let page = PAGINATION.START_PAGE_ZERO;
    while (true) {
      const response = await fetch(
        `${this.baseUrl}/api/token/?p=${page}&page_size=${PAGINATION.DEFAULT_PAGE_SIZE}`,
        { headers: this.headers },
      );
      if (!response.ok)
        throw new Error(`Failed to list tokens: ${response.status}`);
      const data = (await response.json()) as TokenListResponse;
      if (!data.success)
        throw new Error("Token list API returned success: false");
      const tokens = Array.isArray(data.data)
        ? data.data
        : (data.data?.items ?? data.data?.data ?? []);
      allTokens.push(...tokens);
      if (tokens.length < PAGINATION.DEFAULT_PAGE_SIZE) break;
      page++;
    }
    return allTokens;
  }

  async createToken(name: string, group: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/token/`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        name,
        group,
        expired_time: -1,
        unlimited_quota: true,
        model_limits_enabled: false,
      }),
    });
    if (!response.ok)
      throw new Error(`Failed to create token: ${response.status}`);
    const data = (await response.json()) as {
      success: boolean;
      message?: string;
    };
    if (!data.success)
      throw new Error(`Token create failed: ${data.message ?? "unknown"}`);
  }

  async testModelsWithKey(
    apiKey: string,
    models: string[],
    channelType: number,
  ): Promise<{ workingModels: string[]; avgResponseTime?: number }> {
    return new ModelTester(this.baseUrl, apiKey).testModels(models, channelType);
  }

  async ensureTokens(
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

    const existingTokens = await this.listTokens();
    const tokensByName = new Map(existingTokens.map((t) => [t.name, t]));

    const desiredTokenNames = new Set(groups.map((g) => `${g.name}-${prefix}`));

    // Delete tokens that are managed by us but no longer needed
    for (const token of existingTokens) {
      if (token.name.endsWith(`-${prefix}`) && !desiredTokenNames.has(token.name)) {
        if (await this.deleteToken(token.id)) {
          consola.info(`[${this.name}] Deleted stale token: ${token.name}`);
          deleted++;
        }
      }
    }

    for (const group of groups) {
      const tokenName = `${group.name}-${prefix}`;
      const existingToken = tokensByName.get(tokenName);

      if (existingToken) {
        result[group.name] = existingToken.key.startsWith("sk-")
          ? existingToken.key
          : `sk-${existingToken.key}`;
        existing++;
      } else {
        await this.createToken(tokenName, group.name);
        created++;
        const updatedTokens = await this.listTokens();
        const newToken = updatedTokens.find((t) => t.name === tokenName);
        if (!newToken)
          throw new Error(`Token ${tokenName} created but not found`);
        result[group.name] = newToken.key.startsWith("sk-")
          ? newToken.key
          : `sk-${newToken.key}`;
      }
    }

    return { tokens: result, created, existing, deleted };
  }

  async deleteToken(id: number): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/api/token/${id}`, {
      method: "DELETE",
      headers: this.headers,
    });
    if (!response.ok) return false;
    const data = (await response.json()) as { success: boolean };
    return data.success;
  }

  async deleteTokenByName(tokenName: string): Promise<boolean> {
    const tokens = await this.listTokens();
    const token = tokens.find((t) => t.name === tokenName);
    if (!token) return false;
    return this.deleteToken(token.id);
  }

  // ============ Target Methods (sync to target instance) ============

  async updateOption(key: string, value: string): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/api/option/`, {
      method: "PUT",
      headers: this.headers,
      body: JSON.stringify({ key, value }),
    });
    if (!response.ok) return false;
    const data = (await response.json()) as ApiResponse;
    return data.success;
  }

  async updateOptions(
    options: Record<string, string>,
  ): Promise<{ updated: string[]; failed: string[] }> {
    const updated: string[] = [];
    const failed: string[] = [];
    for (const [key, value] of Object.entries(options)) {
      if (await this.updateOption(key, value)) updated.push(key);
      else failed.push(key);
    }
    return { updated, failed };
  }

  async listChannels(): Promise<Channel[]> {
    const all: Channel[] = [];
    let page = PAGINATION.START_PAGE_ZERO;
    while (true) {
      const response = await fetch(
        `${this.baseUrl}/api/channel/?p=${page}&page_size=${PAGINATION.DEFAULT_PAGE_SIZE}`,
        { headers: this.headers },
      );
      if (!response.ok) throw new Error(`Failed to list channels: ${response.status}`);
      const data = (await response.json()) as {
        success: boolean;
        data: { data?: Channel[]; items?: Channel[] } | Channel[];
      };
      if (!data.success) throw new Error("Channel list API returned success: false");
      const items = Array.isArray(data.data)
        ? data.data
        : (data.data?.items ?? data.data?.data ?? []);
      all.push(...items);
      if (items.length < PAGINATION.DEFAULT_PAGE_SIZE) break;
      page++;
    }
    return all;
  }

  async createChannel(channel: Omit<Channel, "id">): Promise<number | null> {
    let response = await fetch(`${this.baseUrl}/api/channel/`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ mode: "single", channel }),
    });
    if (response.status === 400 || response.status === 422) {
      response = await fetch(`${this.baseUrl}/api/channel/`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(channel),
      });
    }
    if (!response.ok) return null;
    const data = (await response.json()) as ApiResponse<{ id: number }>;
    if (!data.success) return null;
    return data.data?.id ?? 0;
  }

  async updateChannel(channel: Channel): Promise<boolean> {
    if (!channel.id) return false;
    const response = await fetch(`${this.baseUrl}/api/channel/`, {
      method: "PUT",
      headers: this.headers,
      body: JSON.stringify(channel),
    });
    if (!response.ok) return false;
    const data = (await response.json()) as ApiResponse;
    return data.success;
  }

  async deleteChannel(id: number): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/api/channel/${id}`, {
      method: "DELETE",
      headers: this.headers,
    });
    if (!response.ok) return false;
    const data = (await response.json()) as ApiResponse;
    return data.success;
  }

  async listModels(): Promise<ModelMeta[]> {
    const allModels: ModelMeta[] = [];
    let page = PAGINATION.START_PAGE_ZERO;
    while (true) {
      const response = await fetch(
        `${this.baseUrl}/api/models/?p=${page}&page_size=${PAGINATION.DEFAULT_PAGE_SIZE}`,
        { headers: this.headers },
      );
      if (!response.ok)
        throw new Error(`Failed to list models: ${response.status}`);
      const data = (await response.json()) as ApiResponse<{
        items?: ModelMeta[];
      }>;
      const models = data.data?.items ?? [];
      allModels.push(...models);
      if (models.length < PAGINATION.DEFAULT_PAGE_SIZE) break;
      page++;
    }
    return allModels;
  }

  async createModel(model: Omit<ModelMeta, "id">): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/api/models/`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(model),
    });
    if (!response.ok) return false;
    const data = (await response.json()) as ApiResponse;
    return data.success;
  }

  async updateModel(model: ModelMeta): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/api/models/`, {
      method: "PUT",
      headers: this.headers,
      body: JSON.stringify(model),
    });
    if (!response.ok) return false;
    const data = (await response.json()) as ApiResponse;
    return data.success;
  }

  async deleteModel(id: number): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/api/models/${id}`, {
      method: "DELETE",
      headers: this.headers,
    });
    if (!response.ok) return false;
    const data = (await response.json()) as ApiResponse;
    return data.success;
  }

  async listVendors(): Promise<Vendor[]> {
    const allVendors: Vendor[] = [];
    let page = PAGINATION.START_PAGE_ONE;
    while (true) {
      const response = await fetch(
        `${this.baseUrl}/api/vendors/?page=${page}&page_size=${PAGINATION.DEFAULT_PAGE_SIZE}`,
        { headers: this.headers },
      );
      if (!response.ok)
        throw new Error(`Failed to list vendors: ${response.status}`);
      const data = (await response.json()) as ApiResponse<{ items?: Vendor[] }>;
      const vendors = data.data?.items ?? [];
      allVendors.push(...vendors);
      if (vendors.length < PAGINATION.DEFAULT_PAGE_SIZE) break;
      page++;
    }
    return allVendors;
  }

  async cleanupOrphanedModels(): Promise<number> {
    try {
      const response = await fetch(`${this.baseUrl}/api/models/orphaned`, {
        method: "DELETE",
        headers: this.headers,
      });
      if (!response.ok) return 0;
      const data = (await response.json()) as ApiResponse<{ deleted: number }>;
      return data.data?.deleted ?? 0;
    } catch {
      return 0;
    }
  }
}
