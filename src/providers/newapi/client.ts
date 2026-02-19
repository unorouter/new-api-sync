import { requestJson } from "@/lib/http";
import { CHANNEL_TYPES, inferChannelType, PAGINATION, sanitizeGroupName } from "@/lib/constants";
import type {
  ApiResponse,
  Channel,
  GroupInfo,
  ModelInfo,
  ModelMeta,
  NewApiConfig,
  PricingResponse,
  PricingResponseV2,
  TokenListResponse,
  UpstreamPricing,
  ModelTestDetail,
  TestModelsResult,
  UpstreamToken,
  Vendor,
} from "@/lib/types";
import { ModelTester } from "@/lib/model-tester";
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

  /**
   * Quick health check: verifies the instance is reachable and the access token is valid.
   * Calls /api/user/self and checks for a successful authenticated response.
   */
  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/api/user/self`, {
        headers: this.headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status} ${response.statusText}` };
      }
      const data = (await response.json()) as { success: boolean; message?: string };
      if (!data.success) {
        return { ok: false, error: data.message ?? "API returned success: false" };
      }
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
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
    // Try /api/pricing_new first — some instances (newer new-api forks) expose
    // a V1-format endpoint here that includes supported_endpoint_types even when
    // /api/pricing returns V2 format without endpoint data.
    const urls = [`${this.baseUrl}/api/pricing_new`, `${this.baseUrl}/api/pricing`];
    let raw: { success: boolean; [key: string]: unknown } | undefined;
    for (const url of urls) {
      try {
        const body = await requestJson<{ success: boolean; [key: string]: unknown }>(url);
        if (!body.success || !body.data) continue;
        // Only prefer pricing_new if it actually returns V1 format (with endpoint data)
        if (url.endsWith("/pricing_new") && !Array.isArray(body.data)) continue;
        raw = body;
        break;
      } catch {
        continue;
      }
    }
    if (!raw) {
      throw new Error("Failed to fetch pricing from both /api/pricing_new and /api/pricing");
    }

    // Detect format: V1 has data as array + top-level usable_group/group_ratio,
    // V2 has data as object with model_group/model_info/model_completion_ratio
    const isV1 = Array.isArray(raw.data);

    if (isV1) {
      return this.parsePricingV1(raw as unknown as PricingResponse);
    }
    return this.parsePricingV2(raw as unknown as PricingResponseV2);
  }

  private parsePricingV1(data: PricingResponse): UpstreamPricing {
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

    consola.info(`[${this.name}] V1 format: ${groups.length} groups, ${models.length} models`);

    return {
      groups,
      models,
      groupRatios: data.group_ratio,
      modelRatios,
      completionRatios,
      vendorIdToName,
    };
  }

  private parsePricingV2(raw: PricingResponseV2): UpstreamPricing {
    const d = raw.data;
    const groupRatios: Record<string, number> = {};
    const modelRatios: Record<string, number> = {};
    const completionRatios: Record<string, number> = { ...d.model_completion_ratio };

    const groups: GroupInfo[] = Object.entries(d.model_group)
      .filter(([name]) => name !== "")
      .map(([name, group]) => {
        const modelNames = Object.keys(group.ModelPrice);
        groupRatios[name] = group.GroupRatio;

        // Derive per-model ratios from ModelPrice (price field acts as model_ratio)
        for (const [modelName, pricing] of Object.entries(group.ModelPrice)) {
          if (pricing.price > 0 && !(modelName in modelRatios)) {
            modelRatios[modelName] = pricing.price;
          }
        }

        return {
          name,
          description: group.DisplayName || name,
          ratio: group.GroupRatio,
          models: modelNames,
          channelType: CHANNEL_TYPES.OPENAI, // V2 doesn't expose endpoint types; default to OpenAI
        };
      });

    // Build ModelInfo from the combined data
    const allModels = new Map<string, ModelInfo>();
    for (const [groupName, group] of Object.entries(d.model_group)) {
      for (const [modelName, pricing] of Object.entries(group.ModelPrice)) {
        if (!allModels.has(modelName)) {
          allModels.set(modelName, {
            name: modelName,
            ratio: pricing.price || 1,
            completionRatio: d.model_completion_ratio[modelName] ?? 1,
            groups: [],
          });
        }
        allModels.get(modelName)!.groups.push(groupName);
      }
    }
    const models = Array.from(allModels.values());

    consola.info(`[${this.name}] V2 format: ${groups.length} groups, ${models.length} models`);

    return {
      groups,
      models,
      groupRatios,
      modelRatios,
      completionRatios,
      vendorIdToName: {},
    };
  }

  async listTokens(): Promise<UpstreamToken[]> {
    const allTokens: UpstreamToken[] = [];
    let page = PAGINATION.START_PAGE_ZERO;
    while (true) {
      const data = await requestJson<TokenListResponse>(
        `${this.baseUrl}/api/token/?p=${page}&page_size=${PAGINATION.DEFAULT_PAGE_SIZE}`,
        { headers: this.headers },
      );
      if (!data.success) {
        throw new Error("Token list API returned success: false");
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

  async createToken(name: string, group: string): Promise<void> {
    const data = await requestJson<{ success: boolean; message?: string }>(
      `${this.baseUrl}/api/token/`,
      {
        method: "POST",
        headers: this.headers,
        body: {
          name,
          group,
          expired_time: -1,
          unlimited_quota: true,
          model_limits_enabled: false,
        },
      },
    );
    if (!data.success) {
      throw new Error(`Token create failed: ${data.message ?? "unknown"}`);
    }
  }

  async testModelsWithKey(
    apiKey: string,
    models: string[],
    channelType: number,
    onModelTested?: (detail: ModelTestDetail) => void | Promise<void>,
  ): Promise<TestModelsResult> {
    return new ModelTester(this.baseUrl, apiKey).testModels(
      models,
      channelType,
      false,
      5,
      onModelTested,
    );
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

    const tokenNameForGroup = (groupName: string) =>
      sanitizeGroupName(`${groupName}-${prefix}`) || `group-${prefix}`;
    const desiredTokenNames = new Set(groups.map((g) => tokenNameForGroup(g.name)));

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
      const tokenName = tokenNameForGroup(group.name);
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

  async getOptions(keys: string[]): Promise<Record<string, string>> {
    const response = await fetch(`${this.baseUrl}/api/option/`, {
      headers: this.headers,
    });
    if (!response.ok) return {};
    const data = (await response.json()) as { data?: Array<{ key: string; value: string }> };
    const keySet = new Set(keys);
    const result: Record<string, string> = {};
    for (const opt of data.data ?? []) {
      if (keySet.has(opt.key)) {
        result[opt.key] = opt.value;
      }
    }
    return result;
  }

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

  private async paginatedFetch<T>(
    path: string,
    extractItems: (json: unknown) => T[],
    opts?: { startPage?: number; pageParam?: string },
  ): Promise<T[]> {
    const all: T[] = [];
    let page = opts?.startPage ?? PAGINATION.START_PAGE_ZERO;
    const pageParam = opts?.pageParam ?? "p";
    while (true) {
      const response = await fetch(
        `${this.baseUrl}${path}?${pageParam}=${page}&page_size=${PAGINATION.DEFAULT_PAGE_SIZE}`,
        { headers: this.headers },
      );
      if (!response.ok) throw new Error(`Failed to fetch ${path}: ${response.status}`);
      const json = await response.json();
      const items = extractItems(json);
      all.push(...items);
      if (items.length < PAGINATION.DEFAULT_PAGE_SIZE) break;
      page++;
    }
    return all;
  }

  async listChannels(): Promise<Channel[]> {
    return this.paginatedFetch<Channel>("/api/channel/", (json) => {
      const data = json as { success: boolean; data: { data?: Channel[]; items?: Channel[] } | Channel[] };
      if (!data.success) throw new Error("Channel list API returned success: false");
      return Array.isArray(data.data) ? data.data : (data.data?.items ?? data.data?.data ?? []);
    });
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
    return this.paginatedFetch<ModelMeta>("/api/models/", (json) => {
      const data = json as ApiResponse<{ items?: ModelMeta[] }>;
      return data.data?.items ?? [];
    });
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
    return this.paginatedFetch<Vendor>("/api/vendors/", (json) => {
      const data = json as ApiResponse<{ items?: Vendor[] }>;
      return data.data?.items ?? [];
    }, { startPage: PAGINATION.START_PAGE_ONE, pageParam: "page" });
  }

  async cleanupOrphanedModels(): Promise<number> {
    try {
      const response = await fetch(`${this.baseUrl}/api/models/orphaned`, {
        method: "DELETE",
        headers: this.headers,
      });
      if (!response.ok) {
        if (response.status === 404) {
          consola.warn(`[${this.name}] Orphan cleanup endpoint not supported (404)`);
        } else {
          consola.warn(`[${this.name}] Orphan cleanup failed: ${response.status}`);
        }
        return 0;
      }
      const data = (await response.json()) as ApiResponse<{ deleted: number }>;
      const deleted = data.data?.deleted ?? 0;
      if (deleted > 0) {
        consola.info(`[${this.name}] Cleaned up ${deleted} orphaned models`);
      }
      return deleted;
    } catch (error) {
      consola.warn(`[${this.name}] Orphan cleanup failed: ${error}`);
      return 0;
    }
  }
}
