import { CHANNEL_TYPES, inferChannelType, PAGINATION } from "@/lib/constants";
import { fetchJson, tryFetchJson } from "@/lib/http";
import type { Channel, GroupInfo, ModelMeta, Vendor } from "@/lib/types";
import { consola } from "consola";
import type {
  ApiResponse,
  ModelInfo,
  NewApiConfig,
  PricingResponse,
  PricingResponseV2,
  TokenListResponse,
  UpstreamPricing,
  UpstreamToken,
} from "./types";

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
   * Health check: verifies the instance is reachable and returns the balance.
   */
  async healthCheck(): Promise<{
    ok: boolean;
    balance?: string;
    error?: string;
  }> {
    const data = await tryFetchJson<{
      success: boolean;
      message?: string;
      data?: { quota?: number; used_quota?: number };
    }>(`${this.baseUrl}/api/user/self`, { headers: this.headers });
    if (!data) return { ok: false, error: "Failed to reach API" };
    if (!data.success)
      return { ok: false, error: data.message ?? "API returned success: false" };
    const quota = data.data?.quota;
    const balance =
      quota !== undefined ? `$${(quota / 500000).toFixed(2)}` : undefined;
    return { ok: true, balance };
  }

  /** Returns the numeric balance in dollars, or null on failure. */
  async fetchBalance(): Promise<number | null> {
    const data = await tryFetchJson<{
      success: boolean;
      data?: { quota?: number };
    }>(`${this.baseUrl}/api/user/self`, { headers: this.headers });
    if (!data?.success || data.data?.quota === undefined) return null;
    return data.data.quota / 500000;
  }

  async fetchPricing(): Promise<UpstreamPricing> {
    // Try /api/pricing_new first — some instances (newer new-api forks) expose
    // a V1-format endpoint here that includes supported_endpoint_types even when
    // /api/pricing returns V2 format without endpoint data.
    const urls = [
      `${this.baseUrl}/api/pricing_new`,
      `${this.baseUrl}/api/pricing`,
    ];
    let raw: { success: boolean; [key: string]: unknown } | undefined;
    for (const url of urls) {
      const body = await tryFetchJson<{
        success: boolean;
        [key: string]: unknown;
      }>(url);
      if (!body?.success || !body.data) continue;
      // Only prefer pricing_new if it actually returns V1 format (with endpoint data)
      if (url.endsWith("/pricing_new") && !Array.isArray(body.data)) continue;
      raw = body;
      break;
    }
    if (!raw) {
      throw new Error(
        "Failed to fetch pricing from both /api/pricing_new and /api/pricing",
      );
    }

    // Extract supported_endpoint before format dispatch (both V1 and V2 may have it)
    const supportedEndpoint = (raw.supported_endpoint ?? {}) as Record<
      string,
      { path: string; method: string }
    >;

    // Detect format: V1 has data as array + top-level usable_group/group_ratio,
    // V2 has data as object with model_group/model_info/model_completion_ratio
    const isV1 = Array.isArray(raw.data);

    if (isV1) {
      return this.parsePricingV1(raw as unknown as PricingResponse);
    }
    const result = this.parsePricingV2(raw as unknown as PricingResponseV2);
    result.endpointPaths = supportedEndpoint;
    return result;
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
      modelPrice:
        m.quota_type === 1 && m.model_price > 0 ? m.model_price : undefined,
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

    consola.info(
      `[${this.name}] V1 format: ${groups.length} groups, ${models.length} models`,
    );

    return {
      groups,
      models,
      groupRatios: data.group_ratio,
      modelRatios,
      completionRatios,
      vendorIdToName,
      endpointPaths: data.supported_endpoint ?? {},
    };
  }

  private parsePricingV2(raw: PricingResponseV2): UpstreamPricing {
    const d = raw.data;
    const groupRatios: Record<string, number> = {};
    const modelRatios: Record<string, number> = {};
    const completionRatios: Record<string, number> = {
      ...d.model_completion_ratio,
    };

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

    consola.info(
      `[${this.name}] V2 format: ${groups.length} groups, ${models.length} models`,
    );

    return {
      groups,
      models,
      groupRatios,
      modelRatios,
      completionRatios,
      vendorIdToName: {},
      endpointPaths: {},
    };
  }

  async listTokens(): Promise<UpstreamToken[]> {
    const allTokens: UpstreamToken[] = [];
    let page = PAGINATION.START_PAGE_ZERO;
    while (true) {
      const data = await fetchJson<TokenListResponse>(
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

  async createToken(name: string, group: string): Promise<boolean> {
    const data = await tryFetchJson<{ success: boolean; message?: string }>(
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
    if (!data?.success) {
      consola.warn(
        `[${this.name}] Token create failed for "${group}": ${data?.message ?? "unknown"}`,
      );
      return false;
    }
    return true;
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

    const TOKEN_NAME_MAX = 30;
    const suffix = `-${prefix}`;
    const tokenNameForGroup = (groupName: string) => {
      const maxLen = TOKEN_NAME_MAX - suffix.length;
      const truncated =
        groupName.length > maxLen ? groupName.slice(0, maxLen) : groupName;
      return `${truncated}${suffix}`;
    };
    const desiredTokenNames = new Set(
      groups.map((g) => tokenNameForGroup(g.name)),
    );

    // Delete tokens that are managed by us but no longer needed
    for (const token of existingTokens) {
      if (
        token.name.endsWith(`-${prefix}`) &&
        !desiredTokenNames.has(token.name)
      ) {
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
        if (!(await this.createToken(tokenName, group.name))) continue;
        created++;
        const updatedTokens = await this.listTokens();
        const newToken = updatedTokens.find((t) => t.name === tokenName);
        if (!newToken) {
          consola.warn(
            `[${this.name}] Token "${tokenName}" created but not found`,
          );
          continue;
        }
        result[group.name] = newToken.key.startsWith("sk-")
          ? newToken.key
          : `sk-${newToken.key}`;
      }
    }

    return { tokens: result, created, existing, deleted };
  }

  async deleteToken(id: number): Promise<boolean> {
    const data = await tryFetchJson<{ success: boolean }>(
      `${this.baseUrl}/api/token/${id}`,
      { method: "DELETE", headers: this.headers },
    );
    return data?.success ?? false;
  }

  // ============ Target Methods (sync to target instance) ============

  async updateCache(): Promise<boolean> {
    const data = await tryFetchJson<{ success: boolean }>(
      `${this.baseUrl}/api/option/update_cache`,
      { headers: this.headers },
    );
    return data?.success === true;
  }

  async getOptions(keys: string[]): Promise<Record<string, string>> {
    const data = await tryFetchJson<{
      data?: Array<{ key: string; value: string }>;
    }>(`${this.baseUrl}/api/option/`, { headers: this.headers });
    if (!data) return {};
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
    const data = await tryFetchJson<ApiResponse>(
      `${this.baseUrl}/api/option/`,
      { method: "PUT", headers: this.headers, body: { key, value } },
    );
    return data?.success ?? false;
  }

  async listChannels(): Promise<Channel[]> {
    const all: Channel[] = [];
    let page = PAGINATION.START_PAGE_ZERO;
    while (true) {
      const data = await fetchJson<{
        success: boolean;
        data: { data?: Channel[]; items?: Channel[] } | Channel[];
      }>(
        `${this.baseUrl}/api/channel/?p=${page}&page_size=${PAGINATION.DEFAULT_PAGE_SIZE}`,
        { headers: this.headers },
      );
      if (!data.success)
        throw new Error("Channel list API returned success: false");
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
    // Try wrapped format first, fall back to flat format on 400/422
    let data = await tryFetchJson<ApiResponse<{ id: number }>>(
      `${this.baseUrl}/api/channel/`,
      {
        method: "POST",
        headers: this.headers,
        body: { mode: "single", channel },
      },
    );
    if (!data) {
      data = await tryFetchJson<ApiResponse<{ id: number }>>(
        `${this.baseUrl}/api/channel/`,
        { method: "POST", headers: this.headers, body: channel },
      );
    }
    if (!data?.success) return null;
    return data.data?.id ?? 0;
  }

  async updateChannel(channel: Channel): Promise<boolean> {
    if (!channel.id) return false;
    const data = await tryFetchJson<ApiResponse>(
      `${this.baseUrl}/api/channel/`,
      { method: "PUT", headers: this.headers, body: channel },
    );
    return data?.success ?? false;
  }

  async deleteChannel(id: number): Promise<boolean> {
    const data = await tryFetchJson<ApiResponse>(
      `${this.baseUrl}/api/channel/${id}`,
      { method: "DELETE", headers: this.headers },
    );
    return data?.success ?? false;
  }

  async listModels(): Promise<ModelMeta[]> {
    const all: ModelMeta[] = [];
    let page = PAGINATION.START_PAGE_ZERO;
    while (true) {
      const data = await fetchJson<ApiResponse<{ items?: ModelMeta[] }>>(
        `${this.baseUrl}/api/models/?p=${page}&page_size=${PAGINATION.DEFAULT_PAGE_SIZE}`,
        { headers: this.headers },
      );
      const items = data.data?.items ?? [];
      all.push(...items);
      if (items.length < PAGINATION.DEFAULT_PAGE_SIZE) break;
      page++;
    }
    return all;
  }

  async createModel(model: Omit<ModelMeta, "id">): Promise<boolean> {
    const data = await tryFetchJson<ApiResponse>(
      `${this.baseUrl}/api/models/`,
      { method: "POST", headers: this.headers, body: model },
    );
    return data?.success ?? false;
  }

  async updateModel(model: ModelMeta): Promise<boolean> {
    const data = await tryFetchJson<ApiResponse>(
      `${this.baseUrl}/api/models/`,
      { method: "PUT", headers: this.headers, body: model },
    );
    return data?.success ?? false;
  }

  async deleteModel(id: number): Promise<boolean> {
    const data = await tryFetchJson<ApiResponse>(
      `${this.baseUrl}/api/models/${id}`,
      { method: "DELETE", headers: this.headers },
    );
    return data?.success ?? false;
  }

  async listVendors(): Promise<Vendor[]> {
    const all: Vendor[] = [];
    let page = PAGINATION.START_PAGE_ONE;
    while (true) {
      const data = await fetchJson<ApiResponse<{ items?: Vendor[] }>>(
        `${this.baseUrl}/api/vendors/?page=${page}&page_size=${PAGINATION.DEFAULT_PAGE_SIZE}`,
        { headers: this.headers },
      );
      const items = data.data?.items ?? [];
      all.push(...items);
      if (items.length < PAGINATION.DEFAULT_PAGE_SIZE) break;
      page++;
    }
    return all;
  }

  async cleanupOrphanedModels(): Promise<number> {
    const data = await tryFetchJson<ApiResponse<{ deleted: number }>>(
      `${this.baseUrl}/api/models/orphaned`,
      { method: "DELETE", headers: this.headers },
    );
    if (!data) {
      consola.warn(`[${this.name}] Orphan cleanup failed or not supported`);
      return 0;
    }
    const deleted = data.data?.deleted ?? 0;
    if (deleted > 0) {
      consola.info(`[${this.name}] Cleaned up ${deleted} orphaned models`);
    }
    return deleted;
  }
}
