export interface NewApiConfig {
  baseUrl: string;
  systemAccessToken: string;
  userId: number;
}

export interface Config {
  target: NewApiConfig;
  providers: AnyProviderConfig[];
  blacklist?: string[];
}

export interface BaseProviderConfig extends NewApiConfig {
  name: string;
  enabledGroups?: string[];
  enabledVendors?: string[];
  enabledModels?: string[];
  priority?: number;
  priceMultiplier?: number;
}

export interface ProviderConfig extends BaseProviderConfig {
  type?: "newapi";
}

export interface NekoProviderConfig extends Omit<BaseProviderConfig, "systemAccessToken" | "userId"> {
  type: "neko";
  sessionToken: string;
}

export type AnyProviderConfig = ProviderConfig | NekoProviderConfig;

export interface SyncReport {
  success: boolean;
  providers: ProviderReport[];
  channels: { created: number; updated: number; deleted: number };
  options: { updated: string[] };
  errors: SyncError[];
  timestamp: Date;
}

export interface ProviderReport {
  name: string;
  success: boolean;
  groups: number;
  models: number;
  tokens: { created: number; existing: number; deleted: number };
  error?: string;
}

export interface SyncError {
  provider?: string;
  phase: string;
  message: string;
}

export interface UpstreamPricing {
  groups: GroupInfo[];
  models: ModelInfo[];
  groupRatios: Record<string, number>;
  modelRatios: Record<string, number>;
  completionRatios: Record<string, number>;
  vendorIdToName: Record<number, string>;
}

export interface Vendor {
  id: number;
  name: string;
  icon?: string;
}

export interface GroupInfo {
  name: string;
  description: string;
  ratio: number;
  models: string[];
  channelType: number;
}

export interface ModelInfo {
  name: string;
  ratio: number;
  completionRatio: number;
  groups: string[];
  vendorId?: number;
  supportedEndpoints?: string[];
}

export interface UpstreamToken {
  id: number;
  name: string;
  key: string;
  group: string;
  status: number;
}

export interface Channel {
  id?: number;
  name: string;
  type: number;
  key: string;
  base_url: string;
  models: string;
  group: string;
  priority: number;
  weight?: number;
  status: number;
  tag?: string;
  remark?: string;
}

export interface ModelMeta {
  id?: number;
  model_name: string;
  vendor_id?: number;
  status?: number;
  sync_official?: number;
}

export interface MergedGroup {
  name: string;
  ratio: number;
  description: string;
  provider: string;
}

export interface MergedModel {
  ratio: number;
  completionRatio: number;
}
