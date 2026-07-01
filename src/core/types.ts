export const MODEL_TYPES = [
  "text",
  "image",
  "video",
  "audio",
  "embedding",
] as const;
export type ModelType = (typeof MODEL_TYPES)[number];

export const MANAGED_OPTION_KEYS = [
  "GroupRatio",
  "UserUsableGroups",
  "AutoGroups",
  "DefaultUseAutoGroup",
  "ModelRatio",
  "CompletionRatio",
  "ModelPrice",
  "ImageRatio",
  "CacheRatio",
  "CreateCacheRatio",
  "AudioRatio",
  "AudioCompletionRatio",
  "ModelQuotaType",
  "ModelGridPricing",
  "billing_setting.billing_mode",
  "billing_setting.billing_expr",
  "global.chat_completions_to_responses_policy",
  "ModelRequestRateLimitModels",
  "ModelRequestRateLimitNewUserFactor",
  "ModelRequestRateLimitNewUserMaxAgeDays",
  "ModelRequestRateLimitNewUserMaxUsedQuota",
] as const;

export const PAGINATION = {
  DEFAULT_PAGE_SIZE: 100,
  START_PAGE_ZERO: 0,
  START_PAGE_ONE: 1,
} as const;
export const TIMEOUTS = { MODEL_TEST_MS: 20000 } as const;

export interface GroupInfo {
  name: string;
  description: string;
  ratio: number;
  models: string[];
  channelType: number;
}

export interface Vendor {
  id: number;
  name: string;
  icon?: string;
}

export interface ProviderReport {
  name: string;
  success: boolean;
  groups: number;
  models: number;
  tokens: { created: number; existing: number; deleted: number };
  error?: string;
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
  model_mapping?: string;
  setting?: string;
  workflow_templates?: string;
  auto_ban?: number;
  param_override?: string;
}

export interface ModelMeta {
  id?: number;
  model_name: string;
  vendor_id?: number;
  endpoints?: string;
  description?: string;
  tags?: string;
  metadata?: string;
  status?: number;
  sync_official?: number;
}

export interface MergedGroup {
  name: string;
  ratio: number;
  description: string;
  provider: string;
  private?: boolean;
}

export type PricingSourceName =
  | "litellm"
  | "openrouter"
  | "basellm"
  | "llm-prices"
  | "models-dev"
  | "aipricing"
  | "genai-prices"
  | "curated"
  | "channel";

export interface MergedModel {
  ratio: number;
  completionRatio: number;
  modelPrice?: number;
  imageRatio?: number;
  quotaType?: number;
  cacheRatio?: number;
  createCacheRatio?: number;
  audioRatio?: number;
  audioCompletionRatio?: number;
  billingMode?: string;
  billingExpr?: string;
  pricingVersion?: string;
}

export interface DesiredModelSpec {
  model_name: string;
  vendor?: string;
  endpoints?: string;
  description?: string;
  tags?: string;
  metadata?: string;
}

type GridPricingRow = Record<string, string | number> & { Pricing: number };
export type GridPricingInfo = GridPricingRow[];

export interface ManagedOptionMaps {
  groupRatio: Record<string, number>;
  userUsableGroups: Record<string, string>;
  autoGroups: string[];
  modelRatio: Record<string, number>;
  completionRatio: Record<string, number>;
  modelPrice: Record<string, number>;
  imageRatio: Record<string, number>;
  cacheRatio: Record<string, number>;
  createCacheRatio: Record<string, number>;
  audioRatio: Record<string, number>;
  audioCompletionRatio: Record<string, number>;
  modelQuotaType: Record<string, number>;
  modelGridPricing: Record<string, GridPricingInfo>;
  billingMode: Record<string, string>;
  billingExpr: Record<string, string>;
  defaultUseAutoGroup: boolean;
  responsesApiModels: string[];
  modelRateLimits: Record<string, [number, number]>;
  rateLimitNewUserFactor: number;
  rateLimitNewUserMaxAgeDays: number;
  rateLimitNewUserMaxUsedQuota: number;
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

export type DiffOperation<T> =
  | { type: "create"; key: string; value: T }
  | { type: "update"; key: string; existing: T; value: T }
  | { type: "delete"; key: string; existing: T };

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

export interface EntityChangeSet {
  created: string[];
  updated: string[];
  deleted: string[];
}

export interface ApplyReport {
  channels: EntityChangeSet & { orphanAbilitiesDeleted: number };
  models: EntityChangeSet & { orphansDeleted: number };
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
