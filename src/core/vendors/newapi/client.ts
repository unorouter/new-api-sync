import { tryFetchJson } from "@core/infra/http";
import type { Channel, GroupInfo, ModelMeta, Vendor } from "@core/types";
import { t } from "@server/i18n";
import type { ClientContext } from "./context";
import { fetchPricing } from "./pricing";
import {
  cleanupOrphanedModels,
  createChannel,
  createModel,
  createVendor,
  deleteChannel,
  deleteModel,
  listChannels,
  listModels,
  listVendors,
  updateChannel,
  updateModel,
  updateVendor,
} from "./resources";
import {
  createToken,
  deleteToken,
  ensureTokens,
  findTokenByKey,
  getTokenFullKey,
  listTokens,
  updateTokenModelLimits,
} from "./tokens";
import type { NewApiConfig, UpstreamPricing, UpstreamToken } from "./types";

export class NewApiClient {
  readonly ctx: ClientContext;
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: NewApiConfig, name?: string) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    const userId = String(config.userId);
    this.headers = {
      Authorization: `Bearer ${config.systemAccessToken}`,
      "New-Api-User": userId,
      "X-Api-User": userId,
      "Content-Type": "application/json",
    };
    this.ctx = { baseUrl: this.baseUrl, headers: this.headers, name: name ?? "target" };
  }

  async healthCheck(): Promise<{ ok: boolean; balance?: string; error?: string }> {
    const data = await tryFetchJson<{
      success: boolean;
      message?: string;
      data?: { quota?: number };
    }>(`${this.baseUrl}/api/user/self`, { headers: this.headers });
    if (!data) return { ok: false, error: t("CORE.ERROR.API_UNREACHABLE") };
    if (!data.success) return { ok: false, error: data.message ?? "API returned success: false" };
    const quota = data.data?.quota;
    return { ok: true, balance: quota !== undefined ? `$${(quota / 500000).toFixed(2)}` : undefined };
  }

  async fetchBalance(): Promise<number | null> {
    const data = await tryFetchJson<{ success: boolean; data?: { quota?: number } }>(
      `${this.baseUrl}/api/user/self`,
      { headers: this.headers },
    );
    if (!data?.success || data.data?.quota === undefined) return null;
    return data.data.quota / 500000;
  }

  async updateCache(): Promise<boolean> {
    const data = await tryFetchJson<{ success: boolean }>(
      `${this.baseUrl}/api/option/update_cache`,
      { headers: this.headers },
    );
    return data?.success === true;
  }

  async getOptions(keys: string[]): Promise<Record<string, string>> {
    const data = await tryFetchJson<{ data?: Array<{ key: string; value: string }> }>(
      `${this.baseUrl}/api/option/`,
      { headers: this.headers },
    );
    if (!data) return {};
    const keySet = new Set(keys);
    const result: Record<string, string> = {};
    for (const opt of data.data ?? []) if (keySet.has(opt.key)) result[opt.key] = opt.value;
    return result;
  }

  async updateOption(key: string, value: string): Promise<boolean> {
    const data = await tryFetchJson<{ success: boolean }>(`${this.baseUrl}/api/option/`, {
      method: "PUT",
      headers: this.headers,
      body: { key, value },
    });
    return data?.success ?? false;
  }

  fetchPricing(): Promise<UpstreamPricing> { return fetchPricing(this.ctx); }
  listTokens(): Promise<UpstreamToken[]> { return listTokens(this.ctx); }
  createToken(name: string, group: string): Promise<boolean> { return createToken(this.ctx, name, group); }
  getTokenFullKey(id: number): Promise<string | null> { return getTokenFullKey(this.ctx, id); }
  deleteToken(id: number): Promise<boolean> { return deleteToken(this.ctx, id); }
  ensureTokens(groups: GroupInfo[], prefix: string, options?: { skipCleanup?: boolean }) {
    return ensureTokens(this.ctx, groups, prefix, options);
  }
  findTokenByKey(fullKey: string): Promise<UpstreamToken | null> { return findTokenByKey(this.ctx, fullKey); }
  updateTokenModelLimits(token: UpstreamToken, modelLimits: string): Promise<boolean> {
    return updateTokenModelLimits(this.ctx, token, modelLimits);
  }
  listChannels(): Promise<Channel[]> { return listChannels(this.ctx); }
  createChannel(channel: Omit<Channel, "id">): Promise<number | null> { return createChannel(this.ctx, channel); }
  updateChannel(channel: Channel): Promise<boolean> { return updateChannel(this.ctx, channel); }
  deleteChannel(id: number): Promise<boolean> { return deleteChannel(this.ctx, id); }
  listModels(): Promise<ModelMeta[]> { return listModels(this.ctx); }
  createModel(model: Omit<ModelMeta, "id">): Promise<boolean> { return createModel(this.ctx, model); }
  updateModel(model: ModelMeta): Promise<boolean> { return updateModel(this.ctx, model); }
  deleteModel(id: number): Promise<boolean> { return deleteModel(this.ctx, id); }
  listVendors(): Promise<Vendor[]> { return listVendors(this.ctx); }
  createVendor(vendor: { name: string; icon?: string }): Promise<Vendor | null> {
    return createVendor(this.ctx, vendor);
  }
  updateVendor(vendor: { id: number; name: string; icon?: string }): Promise<boolean> {
    return updateVendor(this.ctx, vendor);
  }
  cleanupOrphanedModels(): Promise<number> { return cleanupOrphanedModels(this.ctx); }
}
