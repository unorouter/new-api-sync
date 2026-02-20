// ============ Configuration ============

export type PriceAdjustment = number | Record<string, number>;

export interface NewApiConfig {
  baseUrl: string;
  systemAccessToken: string;
  userId: number;
}

export interface BaseProviderConfig extends NewApiConfig {
  name: string;
  enabledGroups?: string[];
  enabledVendors?: string[];
  enabledModels?: string[];
  priceAdjustment?: PriceAdjustment;
}

export interface ProviderConfig extends BaseProviderConfig {
  type?: "newapi";
}

export interface Sub2ApiGroupConfig {
  key: string;
  platform: string;
  name?: string;
}

export interface Sub2ApiProviderConfig {
  type: "sub2api";
  name: string;
  baseUrl: string;
  adminApiKey?: string;
  groups?: Sub2ApiGroupConfig[];
  enabledVendors?: string[];
  enabledModels?: string[];
  priceAdjustment?: PriceAdjustment;
}

export type AnyProviderConfig = ProviderConfig | Sub2ApiProviderConfig;

export interface Config {
  target: NewApiConfig;
  providers: AnyProviderConfig[];
  blacklist?: string[];
  modelMapping?: Record<string, string>;
  /** Runtime-only: set by --only flag to restrict deletion scope to these providers */
  onlyProviders?: Set<string>;
}

// ============ Sub2API Types ============

export interface Sub2ApiAccount {
  id: number;
  name: string;
  platform: string;
  type: string;
  status: string;
  model_mapping?: Record<string, string>;
}

export interface Sub2ApiModel {
  id: string;
  type: string;
  display_name?: string;
}

export interface Sub2ApiGroup {
  id: number;
  name: string;
  platform: string;
  status: string;
}

export interface Sub2ApiKey {
  id: number;
  key: string;
  name: string;
  group_id?: number;
  status: string;
}

// ============ Reports ============

export interface ProviderReport {
  name: string;
  success: boolean;
  groups: number;
  models: number;
  tokens: { created: number; existing: number; deleted: number };
  error?: string;
}

export interface ResetReport {
  channels: number;
  models: number;
  orphans: number;
  tokens: number;
  options: number;
}

// ============ Upstream Pricing ============

export interface UpstreamPricing {
  groups: GroupInfo[];
  models: ModelInfo[];
  groupRatios: Record<string, number>;
  modelRatios: Record<string, number>;
  completionRatios: Record<string, number>;
  vendorIdToName: Record<number, string>;
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
  /** Fixed price per request (quota_type 1). 0 or undefined means ratio-based. */
  modelPrice?: number;
}

export interface Vendor {
  id: number;
  name: string;
}

export interface UpstreamToken {
  id: number;
  name: string;
  key: string;
  group: string;
  status: number;
}

// ============ Channels & Models ============

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
  model_mapping?: string;
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
  modelMapping?: Record<string, string>;
}

export interface ModelMeta {
  id?: number;
  model_name: string;
  vendor_id?: number;
  endpoints?: string;
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
  /** Fixed price per request (quota_type 1). Undefined means ratio-based. */
  modelPrice?: number;
  /** Image ratio multiplier for image generation tokens. */
  imageRatio?: number;
}

export interface SyncState {
  mergedGroups: MergedGroup[];
  mergedModels: Map<string, MergedModel>;
  modelEndpoints: Map<string, string[]>;
  channelsToCreate: ChannelSpec[];
}

// ============ Model Testing ============

export interface TestResult {
  success: boolean;
}

export interface ModelTestDetail {
  model: string;
  success: boolean;
}

export interface TestModelsResult {
  workingModels: string[];
  details: ModelTestDetail[];
}

// ============ NewAPI Responses ============

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
  vendors?: Array<{ id: number; name: string }>;
}

// Newer new-api format where data is an object instead of array
export interface PricingResponseV2 {
  success: boolean;
  data: {
    model_group: Record<string, {
      DisplayName: string;
      GroupRatio: number;
      ModelPrice: Record<string, { priceType: number; price: number }>;
    }>;
    model_info: Record<string, {
      key: string;
      name: string;
      supplier?: string;
      tags?: string[];
    }>;
    model_completion_ratio: Record<string, number>;
    group_special: Record<string, string[]>;
    owner_by: Record<string, unknown>;
  };
}

export interface TokenListResponse {
  success: boolean;
  data: { data?: UpstreamToken[]; items?: UpstreamToken[] } | UpstreamToken[];
}

// ============ Sync Core Types ============

export interface DesiredModelSpec {
  model_name: string;
  vendor?: string;
  endpoints?: string;
}

export interface ManagedOptionMaps {
  groupRatio: Record<string, number>;
  userUsableGroups: Record<string, string>;
  autoGroups: string[];
  modelRatio: Record<string, number>;
  completionRatio: Record<string, number>;
  modelPrice: Record<string, number>;
  imageRatio: Record<string, number>;
  defaultUseAutoGroup: boolean;
}

export interface DesiredState {
  channels: Channel[];
  models: Map<string, DesiredModelSpec>;
  options: ManagedOptionMaps;
  managedProviders: Set<string>;
  mappingSources: Set<string>;
}

export interface TargetSnapshot {
  channels: Channel[];
  models: ModelMeta[];
  vendors: Vendor[];
  options: Record<string, string>;
}

export interface DiffOperationCreate<T> {
  type: "create";
  key: string;
  value: T;
}

export interface DiffOperationUpdate<T> {
  type: "update";
  key: string;
  existing: T;
  value: T;
}

export interface DiffOperationDelete<T> {
  type: "delete";
  key: string;
  existing: T;
}

export type DiffOperation<T> =
  | DiffOperationCreate<T>
  | DiffOperationUpdate<T>
  | DiffOperationDelete<T>;

export interface SyncDiff {
  channels: DiffOperation<Channel>[];
  models: DiffOperation<ModelMeta>[];
  options: DiffOperation<string>[];
  cleanupOrphans: boolean;
}

export interface ApplyError {
  phase: "options" | "channels" | "models" | "cleanup";
  key: string;
  message: string;
}

export interface ApplyReport {
  channels: { created: number; updated: number; deleted: number };
  models: { created: number; updated: number; deleted: number; orphansDeleted: number };
  options: { updated: string[] };
  errors: ApplyError[];
}

export interface SyncRunResult {
  success: boolean;
  providerReports: ProviderReport[];
  desired: DesiredState;
  diff: SyncDiff;
  apply: ApplyReport;
  elapsedMs: number;
}
