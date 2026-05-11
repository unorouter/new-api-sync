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
    this.ctx = {
      baseUrl: this.baseUrl,
      headers: this.headers,
      name: name ?? "target",
    };
  }

  async healthCheck(): Promise<{
    ok: boolean;
    balance?: string;
    error?: string;
  }> {
    const data = await tryFetchJson<{
      success: boolean;
      message?: string;
      data?: { quota?: number };
    }>(`${this.baseUrl}/api/user/self`, { headers: this.headers });
    if (!data) return { ok: false, error: t("CORE.ERROR.API_UNREACHABLE") };
    if (!data.success)
      return {
        ok: false,
        error: data.message ?? "API returned success: false",
      };
    const quota = data.data?.quota;
    return {
      ok: true,
      balance:
        quota !== undefined ? `$${(quota / 500000).toFixed(2)}` : undefined,
    };
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
    for (const opt of data.data ?? [])
      if (keySet.has(opt.key)) result[opt.key] = opt.value;
    return result;
  }

  async updateOption(key: string, value: string): Promise<boolean> {
    const data = await tryFetchJson<{ success: boolean }>(
      `${this.baseUrl}/api/option/`,
      {
        method: "PUT",
        headers: this.headers,
        body: { key, value },
      },
    );
    return data?.success ?? false;
  }

  fetchPricing = (): Promise<UpstreamPricing> => fetchPricing(this.ctx);
  listTokens = (): Promise<UpstreamToken[]> => listTokens(this.ctx);
  createToken = (name: string, group: string) =>
    createToken(this.ctx, name, group);
  getTokenFullKey = (id: number) => getTokenFullKey(this.ctx, id);
  deleteToken = (id: number) => deleteToken(this.ctx, id);
  ensureTokens = (
    groups: GroupInfo[],
    prefix: string,
    options?: { skipCleanup?: boolean },
  ) => ensureTokens(this.ctx, groups, prefix, options);
  findTokenByKey = (fullKey: string) => findTokenByKey(this.ctx, fullKey);
  updateTokenModelLimits = (token: UpstreamToken, modelLimits: string) =>
    updateTokenModelLimits(this.ctx, token, modelLimits);
  listChannels = (): Promise<Channel[]> => listChannels(this.ctx);
  createChannel = (channel: Omit<Channel, "id">) =>
    createChannel(this.ctx, channel);
  updateChannel = (channel: Channel) => updateChannel(this.ctx, channel);
  deleteChannel = (id: number) => deleteChannel(this.ctx, id);
  listModels = (): Promise<ModelMeta[]> => listModels(this.ctx);
  createModel = (model: Omit<ModelMeta, "id">) => createModel(this.ctx, model);
  updateModel = (model: ModelMeta) => updateModel(this.ctx, model);
  deleteModel = (id: number) => deleteModel(this.ctx, id);
  listVendors = (): Promise<Vendor[]> => listVendors(this.ctx);
  createVendor = (vendor: { name: string; icon?: string }) =>
    createVendor(this.ctx, vendor);
  updateVendor = (vendor: { id: number; name: string; icon?: string }) =>
    updateVendor(this.ctx, vendor);
  cleanupOrphanedModels = () => cleanupOrphanedModels(this.ctx);
}
