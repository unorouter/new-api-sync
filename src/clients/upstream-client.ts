import { logDebug, logInfo } from "@/lib/utils";
import type {
  GroupInfo,
  ModelInfo,
  ProviderConfig,
  UpstreamPricing,
  UpstreamToken,
} from "@/types";

interface PricingResponse {
  success: boolean;
  data: Array<{
    model_name: string;
    vendor_id?: number;
    quota_type: number;
    model_ratio: number;
    model_price: number;
    completion_ratio: number;
    enable_groups: string[];
    supported_endpoint_types: string[];
  }>;
  group_ratio: Record<string, number>;
  usable_group: Record<string, string>;
  auto_groups?: string[];
}

interface TokenListResponse {
  success: boolean;
  data:
    | {
        data?: UpstreamToken[];
        items?: UpstreamToken[];
      }
    | UpstreamToken[];
}

interface TokenCreateResponse {
  success: boolean;
  message?: string;
}

export class UpstreamClient {
  private provider: ProviderConfig;

  constructor(provider: ProviderConfig) {
    this.provider = provider;
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.provider.systemAccessToken}`,
      "New-Api-User": String(this.provider.userId),
      "Content-Type": "application/json",
    };
  }

  private get baseUrl(): string {
    return this.provider.baseUrl.replace(/\/$/, "");
  }

  /**
   * Fetch pricing data from upstream /api/pricing
   */
  async fetchPricing(): Promise<UpstreamPricing> {
    logInfo(`[${this.provider.name}] Fetching pricing from ${this.baseUrl}`);

    const response = await fetch(`${this.baseUrl}/api/pricing`);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch pricing: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as PricingResponse;
    if (!data.success) {
      throw new Error(`Pricing API returned success: false`);
    }

    // Build group info with models
    const groupModels = new Map<string, Set<string>>();
    for (const model of data.data) {
      for (const group of model.enable_groups) {
        if (!groupModels.has(group)) {
          groupModels.set(group, new Set());
        }
        groupModels.get(group)!.add(model.model_name);
      }
    }

    const groups: GroupInfo[] = Object.entries(data.usable_group)
      .filter(([name]) => name !== "") // Filter empty key
      .map(([name, description]) => ({
        name,
        description,
        ratio: data.group_ratio[name] ?? 1,
        models: Array.from(groupModels.get(name) ?? []),
      }));

    // Build model info
    const models: ModelInfo[] = data.data.map((m) => ({
      name: m.model_name,
      ratio: m.model_ratio,
      completionRatio: m.completion_ratio,
      groups: m.enable_groups,
    }));

    // Build ratio maps
    const modelRatios: Record<string, number> = {};
    const completionRatios: Record<string, number> = {};
    for (const m of data.data) {
      if (m.model_ratio > 0) {
        modelRatios[m.model_name] = m.model_ratio;
      }
      if (m.completion_ratio > 0) {
        completionRatios[m.model_name] = m.completion_ratio;
      }
    }

    logInfo(
      `[${this.provider.name}] Found ${groups.length} groups, ${models.length} models`,
    );

    return {
      groups,
      models,
      groupRatios: data.group_ratio,
      modelRatios,
      completionRatios,
    };
  }

  /**
   * List all tokens for this user on upstream
   */
  async listTokens(): Promise<UpstreamToken[]> {
    logDebug(`[${this.provider.name}] Listing tokens`);

    const response = await fetch(
      `${this.baseUrl}/api/token/?p=0&page_size=1000`,
      {
        headers: this.headers,
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to list tokens: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as TokenListResponse;
    if (!data.success) {
      throw new Error(`Token list API returned success: false`);
    }

    // Handle multiple response formats (paginated with items/data or direct array)
    const tokens = Array.isArray(data.data)
      ? data.data
      : (data.data?.items ?? data.data?.data ?? []);

    return tokens;
  }

  /**
   * Create a new token on upstream
   */
  async createToken(name: string, group: string): Promise<void> {
    logInfo(
      `[${this.provider.name}] Creating token: ${name} (group: ${group})`,
    );

    const response = await fetch(`${this.baseUrl}/api/token/`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        name,
        group,
        expired_time: -1, // Never expire
        unlimited_quota: true,
        model_limits_enabled: false,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Failed to create token: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as TokenCreateResponse;
    if (!data.success) {
      throw new Error(
        `Token create failed: ${data.message ?? "unknown error"}`,
      );
    }
  }

  /**
   * Ensure tokens exist for each group, return map of group -> key
   * Creates tokens if they don't exist, reuses existing ones
   */
  async ensureTokens(
    groups: GroupInfo[],
    prefix: string,
  ): Promise<{
    tokens: Record<string, string>;
    created: number;
    existing: number;
  }> {
    const result: Record<string, string> = {};
    let created = 0;
    let existing = 0;

    // Get existing tokens
    const existingTokens = await this.listTokens();
    const tokensByName = new Map(existingTokens.map((t) => [t.name, t]));

    for (const group of groups) {
      const tokenName = `${prefix}-${group.name}`;
      const existingToken = tokensByName.get(tokenName);

      if (existingToken) {
        // Use existing token
        const key = existingToken.key.startsWith("sk-")
          ? existingToken.key
          : `sk-${existingToken.key}`;
        result[group.name] = key;
        existing++;
        logDebug(`[${this.provider.name}] Token exists: ${tokenName}`);
      } else {
        // Create new token
        await this.createToken(tokenName, group.name);
        created++;

        // Refetch tokens to get the key
        const updatedTokens = await this.listTokens();
        const newToken = updatedTokens.find((t) => t.name === tokenName);

        if (!newToken) {
          throw new Error(
            `Token ${tokenName} created but not found in token list`,
          );
        }

        const key = newToken.key.startsWith("sk-")
          ? newToken.key
          : `sk-${newToken.key}`;
        result[group.name] = key;
      }
    }

    logInfo(
      `[${this.provider.name}] Tokens: ${created} created, ${existing} existing`,
    );

    return { tokens: result, created, existing };
  }
}
