import { CHANNEL_TYPES, PAGINATION } from "@/lib/constants";
import type {
  GroupInfo,
  ModelInfo,
  NekoProviderConfig,
  UpstreamPricing,
} from "@/lib/types";
import { testModelsWithKey as testModels } from "@/service/model-tester";
import { consola } from "consola";

interface NekoGroup {
  id: number;
  name: string;
  description: string;
  ratio: string;
  rpm: number | null;
  is_default: boolean;
}

interface NekoModel {
  id: number;
  model: string;
  provider: string;
  input_price_per_m: string;
  output_price_per_m: string;
  cache_read_price_per_m: string;
  cache_write_price_per_m: string;
  enabled: boolean;
  description: string;
}

interface NekoToken {
  id: number;
  name: string;
  key: string;
  billing_type: string;
  subscription_group_id: number;
  pay_as_you_go_group_id: number;
  used_quota: string;
  enabled: boolean;
  subscription_group?: { name: string; ratio: string };
  pay_as_you_go_group?: { name: string; ratio: string };
}

function generateNonce(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(
    { length: 8 },
    () => chars[Math.floor(Math.random() * chars.length)],
  ).join("");
}

async function generateSign(
  timestamp: string,
  nonce: string,
  path: string,
): Promise<string> {
  const secret = "nekoneko";
  const data = new TextEncoder().encode(timestamp + nonce + path + secret);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  )
    .join("")
    .substring(0, 16);
}

function providerToVendorId(provider: string): number | undefined {
  const mapping: Record<string, number> = {
    openai: 1,
    anthropic: 2,
    claude: 2,
    google: 3,
    gemini: 3,
  };
  return mapping[provider.toLowerCase()];
}

export class NekoClient {
  private provider: NekoProviderConfig;

  constructor(provider: NekoProviderConfig) {
    this.provider = provider;
  }

  private get baseUrl(): string {
    return this.provider.baseUrl.replace(/\/$/, "");
  }

  private async getHeaders(path: string): Promise<Record<string, string>> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = generateNonce();
    const sign = await generateSign(timestamp, nonce, path);

    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      Cookie: `session=${this.provider.sessionToken}`,
      "X-Timestamp": timestamp,
      "X-Nonce": nonce,
      "X-Sign": sign,
    };
  }

  private async fetch<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const basePath = path.split("?")[0] ?? path;
    const headers = await this.getHeaders(basePath);

    const response = await fetch(url, {
      ...options,
      headers: { ...headers, ...options.headers },
    });

    if (!response.ok) {
      throw new Error(`Neko API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { success: boolean; message?: string } & T;
    if (!data.success) {
      throw new Error(`Neko API error: ${data.message || "Unknown error"}`);
    }

    return data as T;
  }

  async fetchBalance(): Promise<string> {
    try {
      const res = await this.fetch<{ data: { balance?: string } }>(
        "/api/usage/summary",
      );
      const balance = res.data?.balance ?? "0";
      return `$${parseFloat(balance).toFixed(2)}`;
    } catch {
      return "N/A";
    }
  }

  async fetchPricing(): Promise<UpstreamPricing> {
    const [pricingRes, paygoGroupsRes] = await Promise.all([
      fetch(`${this.baseUrl}/api/pricing/public`).then((r) => r.json()) as Promise<{ data: NekoModel[] }>,
      this.fetch<{ data: NekoGroup[] }>("/api/groups/by-type?type=pay_as_you_go"),
    ]);

    const nekoModels: NekoModel[] = pricingRes.data || [];
    const paygoGroups = paygoGroupsRes.data || [];

    const enabledGroupIds = this.provider.enabledGroups
      ? new Set(this.provider.enabledGroups.map((g) => parseInt(g, 10) || g))
      : null;

    const mapGroup = (g: NekoGroup): GroupInfo & { nekoGroupId: number; nekoGroupType: string } => {
      // Determine channel type based on group name - Codex groups use OpenAI format
      const isOpenAI = g.name.toLowerCase().includes("codex");
      const channelType = isOpenAI ? 1 : 14; // 1 = OpenAI, 14 = Anthropic

      // Filter models based on channel type - OpenAI groups get OpenAI models, Claude groups get Claude models
      const groupModels = nekoModels
        .filter((m) => m.enabled)
        .filter((m) => {
          const provider = m.provider.toLowerCase();
          if (isOpenAI) {
            return provider === "openai" || provider.includes("gpt");
          } else {
            return provider === "claude" || provider === "anthropic";
          }
        })
        .map((m) => m.model);

      return {
        name: g.name,
        description: g.description || g.name,
        ratio: parseFloat(g.ratio) || 1,
        models: groupModels,
        channelType,
        nekoGroupId: g.id,
        nekoGroupType: "pay_as_you_go",
      };
    };

    const groups: (GroupInfo & { nekoGroupId: number; nekoGroupType: string })[] = paygoGroups
      .filter((g) => !enabledGroupIds || enabledGroupIds.has(g.id) || enabledGroupIds.has(g.name))
      .map((g) => mapGroup(g));

    const models: ModelInfo[] = nekoModels
      .filter((m) => m.enabled)
      .map((m) => {
        const inputPrice = parseFloat(m.input_price_per_m) || 0;
        const outputPrice = parseFloat(m.output_price_per_m) || 0;
        const ratio = inputPrice;
        const completionRatio = inputPrice > 0 ? outputPrice / inputPrice : 1;

        return {
          name: m.model,
          ratio,
          completionRatio,
          groups: groups.map((g) => g.name),
          vendorId: providerToVendorId(m.provider),
        };
      });

    const modelRatios: Record<string, number> = {};
    const completionRatios: Record<string, number> = {};
    const vendorIdToName: Record<number, string> = {
      1: "openai",
      2: "anthropic",
      3: "google",
    };

    for (const m of models) {
      if (m.ratio > 0) modelRatios[m.name] = m.ratio;
      if (m.completionRatio > 0) completionRatios[m.name] = m.completionRatio;
    }

    consola.info(
      `[${this.provider.name}] ${groups.length} groups, ${models.length} models (neko)`,
    );

    return {
      groups,
      models,
      groupRatios: Object.fromEntries(groups.map((g) => [g.name, g.ratio])),
      modelRatios,
      completionRatios,
      vendorIdToName,
    };
  }

  async listTokens(): Promise<NekoToken[]> {
    const allTokens: NekoToken[] = [];
    let page = PAGINATION.START_PAGE_ONE;

    while (true) {
      const res = await this.fetch<{ data: { data: NekoToken[]; total: number } }>(
        `/api/token?page=${page}&size=${PAGINATION.DEFAULT_PAGE_SIZE}&order=-created_at`,
      );

      const tokens = res.data?.data || [];
      allTokens.push(...tokens);

      if (allTokens.length >= res.data.total || tokens.length < PAGINATION.DEFAULT_PAGE_SIZE) break;
      page++;
    }

    return allTokens;
  }

  async createToken(
    name: string,
    subscriptionGroupId: number,
    payAsYouGoGroupId: number,
  ): Promise<NekoToken> {
    const res = await this.fetch<{ data: NekoToken }>("/api/token", {
      method: "POST",
      body: JSON.stringify({
        name,
        billing_type: "pay_as_you_go",
        subscription_group_id: subscriptionGroupId,
        pay_as_you_go_group_id: payAsYouGoGroupId,
      }),
    });

    return res.data;
  }

  async deleteToken(id: number): Promise<boolean> {
    try {
      await this.fetch(`/api/token/${id}`, { method: "DELETE" });
      return true;
    } catch {
      return false;
    }
  }

  async testModelsWithKey(
    apiKey: string,
    models: string[],
    _channelType?: number,
  ): Promise<{ workingModels: string[]; avgResponseTime?: number }> {
    // Neko only supports Anthropic format
    return testModels(this.baseUrl, apiKey, models, CHANNEL_TYPES.ANTHROPIC);
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
    let created = 0;
    let existing = 0;
    let deleted = 0;

    const existingTokens = await this.listTokens();
    const tokensByName = new Map(existingTokens.map((t) => [t.name, t]));
    const desiredTokenNames = new Set(groups.map((g) => `${g.name}-${prefix}`));

    for (const token of existingTokens) {
      if (
        token.name.endsWith(`-${prefix}`) &&
        !desiredTokenNames.has(token.name)
      ) {
        if (await this.deleteToken(token.id)) {
          consola.info(`[${this.provider.name}] Deleted stale token: ${token.name}`);
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
        const nekoGroup = group as GroupInfo & {
          nekoGroupId?: number;
          nekoGroupType?: string;
        };

        let subGroupId = 1;
        let paygoGroupId = 2;

        if (nekoGroup.nekoGroupType === "subscription") {
          subGroupId = nekoGroup.nekoGroupId!;
        } else if (nekoGroup.nekoGroupType === "pay_as_you_go") {
          paygoGroupId = nekoGroup.nekoGroupId!;
        }

        const newToken = await this.createToken(tokenName, subGroupId, paygoGroupId);
        result[group.name] = newToken.key.startsWith("sk-")
          ? newToken.key
          : `sk-${newToken.key}`;
        created++;
      }
    }

    return { tokens: result, created, existing, deleted };
  }

  async deleteTokenByName(tokenName: string): Promise<boolean> {
    const tokens = await this.listTokens();
    const token = tokens.find((t) => t.name === tokenName);
    if (!token) return false;
    return this.deleteToken(token.id);
  }
}
