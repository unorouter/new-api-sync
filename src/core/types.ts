import type { Channel, ModelMeta, ProviderReport, Vendor } from "@/lib/types";

export interface PolicyState {
  enabled: boolean;
  all_channels: boolean;
  channel_types: number[];
  model_patterns: string[];
}

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
  defaultUseAutoGroup: boolean;
}

export interface DesiredState {
  channels: Channel[];
  models: Map<string, DesiredModelSpec>;
  options: ManagedOptionMaps;
  policy: PolicyState;
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
  dryRun: boolean;
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
