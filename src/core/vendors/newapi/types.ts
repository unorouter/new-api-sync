import type { GroupInfo } from "@core/types";

export interface ApiResponse<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
}

export interface ModelInfo {
  name: string;
  ratio: number;
  completionRatio: number;
  cacheRatio?: number;
  createCacheRatio?: number;
  groups: string[];
  vendorId?: number;
  supportedEndpoints?: string[];
  modelPrice?: number;
  quotaType?: number;
  audioRatio?: number;
  audioCompletionRatio?: number;
  billingMode?: string;
  billingExpr?: string;
  pricingVersion?: string;
}

export interface UpstreamPricing {
  groups: GroupInfo[];
  models: ModelInfo[];
  groupRatios: Record<string, number>;
  modelRatios: Record<string, number>;
  completionRatios: Record<string, number>;
  vendorIdToName: Record<number, string>;
  endpointPaths: Record<string, EndpointInfo>;
  audioRatios: Record<string, number>;
  audioCompletionRatios: Record<string, number>;
  billingModes: Record<string, string>;
  billingExprs: Record<string, string>;
  pricingVersions: Record<string, string>;
}

export interface UpstreamToken {
  id: number;
  name: string;
  key: string;
  group: string;
  status: number;
  expired_time?: number;
  remain_quota?: number;
  unlimited_quota?: boolean;
  model_limits_enabled?: boolean;
  model_limits?: string;
  allow_ips?: string | null;
  cross_group_retry?: boolean;
}

export interface EndpointInfo {
  path: string;
  method: string;
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
    cache_ratio?: number;
    create_cache_ratio?: number;
    audio_ratio?: number | null;
    audio_completion_ratio?: number | null;
    enable_groups: string[];
    supported_endpoint_types?: string[];
    endpoints?: string[];
    billing_mode?: string;
    billing_expr?: string;
    pricing_version?: string;
  }>;
  group_ratio: Record<string, number>;
  usable_group?: Record<string, string>;
  group_names?: Record<string, string>;
  vendors?: Array<{ id: number; name: string }>;
  supported_endpoint?: Record<string, EndpointInfo>;
}

export interface PricingResponseV2 {
  success: boolean;
  data: {
    model_group: Record<
      string,
      {
        DisplayName: string;
        GroupRatio: number;
        ModelPrice: Record<string, { priceType: number; price: number }>;
      }
    >;
    model_info: Record<
      string,
      { key: string; name: string; supplier?: string; tags?: string[] }
    >;
    model_completion_ratio: Record<string, number>;
    group_special: Record<string, string[]>;
    owner_by: Record<string, unknown>;
  };
}

// VoAPI-style forks (ephone, chatfire) serve data.model_info as an ARRAY, with
// no /api/pricing_new. ephone prices via price_config (absolute USD or per-second);
// chatfire via price_info (new-api model_ratio, nested per enable-group).
interface V3GroupInfo {
  GroupRatio: number;
  DisplayName?: string;
  DisplayNameEn?: string;
  SubGroups?: string[];
}

interface EphoneConditionPrice {
  quota_type: "token" | "time" | "call";
  currency?: string;
  input_token_price?: number;
  output_token_price?: number;
  per_second_price?: number;
  model_price?: number;
  cache_read_token_price?: number;
  cache_create_token_price?: number;
}

export interface EphoneModel {
  model_name: string;
  display_name?: string;
  vendor_id?: number;
  modalities?: { input: string[]; output: string[] };
  enable_groups?: string[];
  price_config?: {
    original_price?: {
      conditions?: Array<{ rule?: string; price?: EphoneConditionPrice }>;
      multipliers?: unknown;
    };
  };
}

interface ChatfireGroupPrice {
  quota_type: number;
  model_price?: number;
  model_ratio?: number;
  model_completion_ratio?: number;
  model_cache_ratio?: number;
  model_create_cache_ratio?: number;
  model_audio_ratio?: number;
  model_audio_completion_ratio?: number;
}

export interface ChatfireModel {
  model_name: string;
  vendor_id?: number;
  enable_groups?: string[];
  supported_endpoint_types?: string[];
  price_info?: Record<string, { default?: ChatfireGroupPrice }>;
}

export interface PricingResponseV3 {
  success: boolean;
  data: {
    group_info?: Record<string, V3GroupInfo>;
    vendor_info?: Array<{ id: number; name: string }>;
    model_info: Array<EphoneModel | ChatfireModel>;
  };
}

export interface TokenListResponse {
  success: boolean;
  message?: string;
  data: { data?: UpstreamToken[]; items?: UpstreamToken[] } | UpstreamToken[];
}

export interface NewApiConfig {
  baseUrl: string;
  systemAccessToken: string;
  userId: number;
}
