import { tryFetchJson } from "@core/infra/http";
import type { Channel, GroupInfo, ModelMeta, Vendor } from "@core/types";
import { t } from "@server/i18n";
import { type ClientContext, makeClientContext } from "./context";
import { fetchPricing } from "./pricing";
import {
  cleanupOrphanedModels,
  fixAbilities,
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
  updateGuestTokenModelLimits,
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
    this.ctx = makeClientContext(this.baseUrl, this.headers, name ?? "target");
  }

  // Reachability only, deliberately not /api/user/self. The target now
  // authenticates with a scoped service token that owns no account, so there is
  // no "self" to read: SyncAuth reports user id 0 and GetUserById(0) errors.
  // Balance is reporting, not a decision input, so it is dropped rather than
  // widening the credential to recover a startup line.
  async healthCheck(): Promise<{
    ok: boolean;
    balance?: string;
    error?: string;
  }> {
    const data = await tryFetchJson<{
      success: boolean;
      message?: string;
    }>(`${this.baseUrl}/api/status`, { headers: this.headers });
    if (!data) return { ok: false, error: t("CORE.ERROR.API_UNREACHABLE") };
    if (!data.success)
      return {
        ok: false,
        error: data.message ?? "API returned success: false",
      };
    return { ok: true };
  }

  async fetchBalance(): Promise<number | null> {
    const data = await tryFetchJson<{
      success: boolean;
      data?: { quota?: number };
    }>(`${this.baseUrl}/api/user/self`, { headers: this.headers });
    if (!data?.success || data.data?.quota === undefined) return null;
    return data.data.quota / 500000;
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
  updateGuestTokenModelLimits = (guestKey: string, modelLimits: string) =>
    updateGuestTokenModelLimits(this.ctx, guestKey, modelLimits);
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
  fixAbilities = () => fixAbilities(this.ctx);
}
