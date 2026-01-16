import { logInfo } from "@/lib/utils";
import type { GroupInfo, ModelInfo, ProviderConfig, UpstreamPricing, UpstreamToken } from "@/types";

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
}

interface TokenListResponse {
  success: boolean;
  data: { data?: UpstreamToken[]; items?: UpstreamToken[] } | UpstreamToken[];
}

function inferChannelType(endpoints: string[]): number {
  if (endpoints.includes("jina-rerank")) return 38;
  if (endpoints.includes("openai-video")) return 55;
  if (endpoints.includes("anthropic")) return 14;
  if (endpoints.includes("gemini")) return 24;
  return 1;
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

  async fetchPricing(): Promise<UpstreamPricing> {
    const response = await fetch(`${this.baseUrl}/api/pricing`);
    if (!response.ok) throw new Error(`Failed to fetch pricing: ${response.status}`);
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
        channelType: inferChannelType(Array.from(groupEndpoints.get(name) ?? [])),
      }));

    const models: ModelInfo[] = data.data.map((m) => ({
      name: m.model_name,
      ratio: m.model_ratio,
      completionRatio: m.completion_ratio,
      groups: m.enable_groups,
      vendorId: m.vendor_id,
    }));

    const modelRatios: Record<string, number> = {};
    const completionRatios: Record<string, number> = {};
    for (const m of data.data) {
      if (m.model_ratio > 0) modelRatios[m.model_name] = m.model_ratio;
      if (m.completion_ratio > 0) completionRatios[m.model_name] = m.completion_ratio;
    }

    logInfo(`[${this.provider.name}] ${groups.length} groups, ${models.length} models`);

    return { groups, models, groupRatios: data.group_ratio, modelRatios, completionRatios };
  }

  async listTokens(): Promise<UpstreamToken[]> {
    const allTokens: UpstreamToken[] = [];
    let page = 0;
    while (true) {
      const response = await fetch(`${this.baseUrl}/api/token/?p=${page}&page_size=100`, { headers: this.headers });
      if (!response.ok) throw new Error(`Failed to list tokens: ${response.status}`);
      const data = (await response.json()) as TokenListResponse;
      if (!data.success) throw new Error("Token list API returned success: false");
      const tokens = Array.isArray(data.data) ? data.data : (data.data?.items ?? data.data?.data ?? []);
      allTokens.push(...tokens);
      if (tokens.length < 100) break;
      page++;
    }
    return allTokens;
  }

  async createToken(name: string, group: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/token/`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ name, group, expired_time: -1, unlimited_quota: true, model_limits_enabled: false }),
    });
    if (!response.ok) throw new Error(`Failed to create token: ${response.status}`);
    const data = (await response.json()) as { success: boolean; message?: string };
    if (!data.success) throw new Error(`Token create failed: ${data.message ?? "unknown"}`);
  }

  async ensureTokens(groups: GroupInfo[], prefix: string): Promise<{ tokens: Record<string, string>; created: number; existing: number }> {
    const result: Record<string, string> = {};
    let created = 0, existing = 0;

    const existingTokens = await this.listTokens();
    const tokensByName = new Map(existingTokens.map((t) => [t.name, t]));

    for (const group of groups) {
      const tokenName = `${group.name}-${prefix}`;
      const existingToken = tokensByName.get(tokenName);

      if (existingToken) {
        result[group.name] = existingToken.key.startsWith("sk-") ? existingToken.key : `sk-${existingToken.key}`;
        existing++;
      } else {
        await this.createToken(tokenName, group.name);
        created++;
        const updatedTokens = await this.listTokens();
        const newToken = updatedTokens.find((t) => t.name === tokenName);
        if (!newToken) throw new Error(`Token ${tokenName} created but not found`);
        result[group.name] = newToken.key.startsWith("sk-") ? newToken.key : `sk-${newToken.key}`;
        logInfo(`[${this.provider.name}] Created token: ${tokenName}`);
      }
    }

    return { tokens: result, created, existing };
  }

  async deleteToken(id: number): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/api/token/${id}`, { method: "DELETE", headers: this.headers });
    if (!response.ok) return false;
    const data = (await response.json()) as { success: boolean };
    return data.success;
  }
}
