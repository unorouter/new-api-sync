/**
 * Type definitions for new-api-sync
 */

// =============================================================================
// Config Types
// =============================================================================

export interface Config {
  target: TargetConfig;
  providers: ProviderConfig[];
  options?: SyncOptions;
}

export interface TargetConfig {
  url: string;
  adminToken: string;
}

export interface ProviderConfig {
  name: string;
  baseUrl: string;
  accessToken: string;
  enabledGroups?: string[];
  priority?: number;
}

export interface SyncOptions {
  tokenNamePrefix?: string; // Default: "new-api-sync"
  deleteStaleChannels?: boolean; // Default: true
}

// =============================================================================
// Sync Report Types
// =============================================================================

export interface SyncReport {
  success: boolean;
  providers: ProviderReport[];
  channels: {
    created: number;
    updated: number;
    deleted: number;
  };
  options: {
    updated: string[];
  };
  errors: SyncError[];
  timestamp: Date;
}

export interface ProviderReport {
  name: string;
  success: boolean;
  groups: number;
  models: number;
  tokens: {
    created: number;
    existing: number;
  };
  error?: string;
}

export interface SyncError {
  provider?: string;
  phase: string;
  message: string;
}

// =============================================================================
// Upstream Data Types (from /api/pricing)
// =============================================================================

export interface UpstreamPricing {
  groups: GroupInfo[];
  models: ModelInfo[];
  groupRatios: Record<string, number>;
  modelRatios: Record<string, number>;
  completionRatios: Record<string, number>;
}

export interface GroupInfo {
  name: string;
  description: string;
  ratio: number;
  models: string[];
}

export interface ModelInfo {
  name: string;
  ratio: number;
  completionRatio: number;
  groups: string[];
}

export interface UpstreamToken {
  id: number;
  name: string;
  key: string;
  group: string;
  status: number;
}

// =============================================================================
// Target Channel Types
// =============================================================================

export interface Channel {
  id?: number;
  name: string;
  type: number;
  key: string;
  base_url: string;
  models: string;
  group: string;
  priority: number;
  status: number;
}

// =============================================================================
// Internal Types (used during sync)
// =============================================================================

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

export interface ChannelSpec {
  name: string;
  type: number;
  key: string;
  baseUrl: string;
  models: string[];
  group: string;
  priority: number;
}
