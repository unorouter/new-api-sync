export interface ApiResponse<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
}

export interface ModelInfo {
  name: string;
  ratio: number;
  completionRatio: number;
  groups: string[];
  vendorId?: number;
  supportedEndpoints?: string[];
  modelPrice?: number;
}

export interface UpstreamPricing {
  groups: import("@/lib/types").GroupInfo[];
  models: ModelInfo[];
  groupRatios: Record<string, number>;
  modelRatios: Record<string, number>;
  completionRatios: Record<string, number>;
  vendorIdToName: Record<number, string>;
}

export interface UpstreamToken {
  id: number;
  name: string;
  key: string;
  group: string;
  status: number;
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
      {
        key: string;
        name: string;
        supplier?: string;
        tags?: string[];
      }
    >;
    model_completion_ratio: Record<string, number>;
    group_special: Record<string, string[]>;
    owner_by: Record<string, unknown>;
  };
}

export interface TokenListResponse {
  success: boolean;
  data: { data?: UpstreamToken[]; items?: UpstreamToken[] } | UpstreamToken[];
}

export interface NewApiConfig {
  baseUrl: string;
  systemAccessToken: string;
  userId: number;
}
