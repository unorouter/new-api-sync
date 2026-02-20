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
  channelsToCreate: Channel[];
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
