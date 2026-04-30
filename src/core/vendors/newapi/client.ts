import { tryFetchJson } from "@core/runtime/http";
import type { Channel, GroupInfo, ModelMeta, Vendor } from "@core/types";
import { t } from "@server/i18n";
import type { ClientContext } from "./context";
import type { NewApiConfig, UpstreamPricing, UpstreamToken } from "./types";
import { fetchPricing as _fetchPricing } from "./pricing";
import {
  listTokens as _listTokens,
  createToken as _createToken,
  getTokenFullKey as _getTokenFullKey,
  deleteToken as _deleteToken,
  ensureTokens as _ensureTokens,
} from "./tokens";
import {
  listChannels as _listChannels,
  createChannel as _createChannel,
  updateChannel as _updateChannel,
  deleteChannel as _deleteChannel,
  listModels as _listModels,
  createModel as _createModel,
  updateModel as _updateModel,
  deleteModel as _deleteModel,
  listVendors as _listVendors,
  createVendor as _createVendor,
  updateVendor as _updateVendor,
  cleanupOrphanedModels as _cleanupOrphanedModels,
} from "./resources";

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

  private get ctx(): ClientContext {
    return {
      baseUrl: this.config.baseUrl,
      headers: this.headers,
      name: this._name ?? "target",
    };
  }

  private get headers(): Record<string, string> {
    const userId = String(this.config.userId);
    return {
      Authorization: `Bearer ${this.config.systemAccessToken}`,
      "New-Api-User": userId,
      "X-Api-User": userId,
      "Content-Type": "application/json",
    };
  }

  private get baseUrl(): string {
    return this.config.baseUrl;
  }

  private get name(): string {
    return this._name ?? "target";
  }

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
    if (!data) return { ok: false, error: t("CORE.ERROR.API_UNREACHABLE") };
    if (!data.success)
      return {
        ok: false,
        error: data.message ?? "API returned success: false",
      };
    const quota = data.data?.quota;
    const balance =
      quota !== undefined ? `$${(quota / 500000).toFixed(2)}` : undefined;
    return { ok: true, balance };
  }

  async fetchBalance(): Promise<number | null> {
    const data = await tryFetchJson<{
      success: boolean;
      data?: { quota?: number };
    }>(`${this.baseUrl}/api/user/self`, { headers: this.headers });
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
    const data = await tryFetchJson<{ success: boolean }>(
      `${this.baseUrl}/api/option/`,
      { method: "PUT", headers: this.headers, body: { key, value } },
    );
    return data?.success ?? false;
  }

  // Pricing
  fetchPricing(): Promise<UpstreamPricing> {
    return _fetchPricing(this.ctx);
  }

  // Tokens
  listTokens(): Promise<UpstreamToken[]> {
    return _listTokens(this.ctx);
  }
  createToken(name: string, group: string): Promise<boolean> {
    return _createToken(this.ctx, name, group);
  }
  getTokenFullKey(id: number): Promise<string | null> {
    return _getTokenFullKey(this.ctx, id);
  }
  deleteToken(id: number): Promise<boolean> {
    return _deleteToken(this.ctx, id);
  }
  ensureTokens(
    groups: GroupInfo[],
    prefix: string,
    options?: { skipCleanup?: boolean },
  ): Promise<{
    tokens: Record<string, string>;
    created: number;
    existing: number;
    deleted: number;
  }> {
    return _ensureTokens(this.ctx, groups, prefix, options);
  }

  // Channels
  listChannels(): Promise<Channel[]> {
    return _listChannels(this.ctx);
  }
  createChannel(channel: Omit<Channel, "id">): Promise<number | null> {
    return _createChannel(this.ctx, channel);
  }
  updateChannel(channel: Channel): Promise<boolean> {
    return _updateChannel(this.ctx, channel);
  }
  deleteChannel(id: number): Promise<boolean> {
    return _deleteChannel(this.ctx, id);
  }

  // Models
  listModels(): Promise<ModelMeta[]> {
    return _listModels(this.ctx);
  }
  createModel(model: Omit<ModelMeta, "id">): Promise<boolean> {
    return _createModel(this.ctx, model);
  }
  updateModel(model: ModelMeta): Promise<boolean> {
    return _updateModel(this.ctx, model);
  }
  deleteModel(id: number): Promise<boolean> {
    return _deleteModel(this.ctx, id);
  }

  // Vendors
  listVendors(): Promise<Vendor[]> {
    return _listVendors(this.ctx);
  }
  createVendor(vendor: {
    name: string;
    icon?: string;
  }): Promise<Vendor | null> {
    return _createVendor(this.ctx, vendor);
  }
  updateVendor(vendor: {
    id: number;
    name: string;
    icon?: string;
  }): Promise<boolean> {
    return _updateVendor(this.ctx, vendor);
  }

  // Cleanup
  cleanupOrphanedModels(): Promise<number> {
    return _cleanupOrphanedModels(this.ctx);
  }
}
