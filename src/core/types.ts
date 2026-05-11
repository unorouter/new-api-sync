// Browser-safe: kept out of constants.ts so the web bundle skips micromatch.
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
  "ModelQuotaType",
  "ModelGridPricing",
  "global.chat_completions_to_responses_policy",
] as const;

export const PAGINATION = {
  DEFAULT_PAGE_SIZE: 100,
  START_PAGE_ZERO: 0,
  START_PAGE_ONE: 1,
} as const;

export const TIMEOUTS = {
  MODEL_TEST_MS: 20000,
} as const;

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
  /** 0 = log failures, stay enabled. Image/task channels set 0; new-api default is 1. */
  auto_ban?: number;
}

export interface ModelMeta {
  id?: number;
  model_name: string;
  vendor_id?: number;
  endpoints?: string;
  description?: string;
  tags?: string;
  /** Opaque JSON of client hints; lives in models.metadata. */
  metadata?: string;
  status?: number;
  sync_official?: number;
}

export interface MergedGroup {
  name: string;
  ratio: number;
  description: string;
  provider: string;
}

export type PricingSourceName =
  | "litellm"
  | "openrouter"
  | "basellm"
  | "llm-prices"
  | "channel";

export interface MergedModel {
  ratio: number;
  completionRatio: number;
  /** Fixed per-request price; undefined = ratio-based. */
  modelPrice?: number;
  imageRatio?: number;
  /** 3=flat custom, 4=grid (only set for types ≥ 2). */
  quotaType?: number;
  cacheRatio?: number;
  createCacheRatio?: number;
}

export interface DesiredModelSpec {
  model_name: string;
  vendor?: string;
  endpoints?: string;
  description?: string;
  tags?: string;
  metadata?: string;
}

/** Pricing-grid row; all non-Pricing keys are display columns. */
export type GridPricingRow = Record<string, string | number> & {
  Pricing: number;
};
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
  modelQuotaType: Record<string, number>;
  modelGridPricing: Record<string, GridPricingInfo>;
  defaultUseAutoGroup: boolean;
  /** chat/completions → /v1/responses targets. */
  responsesApiModels: string[];
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
  channels: EntityChangeSet;
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
