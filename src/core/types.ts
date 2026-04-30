// ============ Model Types ============

// Browser-safe model-type constants. Kept in core/types.ts so the web bundle
// doesn't transitively pull in micromatch (Node-only) through constants.ts.
export const MODEL_TYPES = [
  "text",
  "image",
  "video",
  "audio",
  "embedding",
] as const;
export type ModelType = (typeof MODEL_TYPES)[number];

// ============ Misc constants ============

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

// ============ Upstream Pricing ============

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

// ============ Reports ============

export interface ProviderReport {
  name: string;
  success: boolean;
  groups: number;
  models: number;
  tokens: { created: number; existing: number; deleted: number };
  error?: string;
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
  setting?: string;
}

export interface ModelMeta {
  id?: number;
  model_name: string;
  vendor_id?: number;
  endpoints?: string;
  description?: string;
  tags?: string;
  /** Opaque JSON string of client hints (maxOutputTokens, isReasoning, ...).
   *  Lives in new-api's models.metadata column and is surfaced by /api/pricing. */
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

export type PricingSourceName = "litellm" | "openrouter" | "basellm" | "channel";

export interface MergedModel {
  ratio: number;
  completionRatio: number;
  /** Fixed price per request (quota_type 1). Undefined means ratio-based. */
  modelPrice?: number;
  /** Image ratio multiplier for image generation tokens. */
  imageRatio?: number;
  /** Custom billing type override (3=flat custom, 4=grid pricing). Only set for types >= 2. */
  quotaType?: number;
  /** Cache-read ratio (multiplier vs input ratio). */
  cacheRatio?: number;
  /** Cache-write ratio (multiplier vs input ratio). */
  createCacheRatio?: number;
  /** Source that supplied the pricing for diagnostics. */
  pricingSource?: PricingSourceName;
}

// ============ Sync Core Types ============

export interface DesiredModelSpec {
  model_name: string;
  vendor?: string;
  endpoints?: string;
  description?: string;
  tags?: string;
  metadata?: string;
}

/** A single row in a pricing grid. All keys except "Pricing" become display columns. "Pricing" is the price value. */
export type GridPricingRow = Record<string, string | number> & {
  Pricing: number;
};

/** Pricing grid: array of rows with arbitrary columns + required Pricing value. */
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
  /** Models that require chat/completions → /v1/responses conversion */
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

export interface ApplyReport {
  channels: { created: number; updated: number; deleted: number };
  models: {
    created: number;
    updated: number;
    deleted: number;
    orphansDeleted: number;
  };
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
