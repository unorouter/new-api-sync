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

export interface TestResult {
  success: boolean;
  responseTime?: number;
}

export interface TestModelsResult {
  workingModels: string[];
  avgResponseTime?: number;
}

export interface ChannelSpec {
  name: string;
  type: number;
  key: string;
  baseUrl: string;
  models: string[];
  group: string;
  priority: number;
  weight: number;
  provider: string;
  remark: string;
}

// Neko API types
export interface NekoGroup {
  id: number;
  name: string;
  description: string;
  ratio: string;
  rpm: number | null;
  is_default: boolean;
}

export interface NekoModel {
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

export interface NekoToken {
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

// NewAPI response types
export interface ApiResponse<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
}

export interface PricingResponse {
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
  vendors?: Array<{ id: number; name: string; icon?: string }>;
}

export interface TokenListResponse {
  success: boolean;
  data: { data?: UpstreamToken[]; items?: UpstreamToken[] } | UpstreamToken[];
}
