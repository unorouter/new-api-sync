// Input shape for the pricing pipeline. Each provider's discover function
// returns UpstreamOffer[]; compute() consumes the union and produces a
// PricedPlan. No mid-pipeline mutation.

import type { ModelType } from "@core/types";
import type { ModelTestDetail } from "@core/testing/types";
import type { ProviderReport } from "@core/types";
import type {
  AnyProviderConfig,
  ModelMetadata,
} from "@core/validations/config";

type ProviderKind = string;

export interface OfferModel {
  exposed: string;
  upstream: string;
  /** Undefined = no per-model pricing (sub2api). Compute falls back to cheapest existing group ratio. */
  upstreamRatio?: number;
  upstreamCompletionRatio?: number;
  cacheRatio?: number;
  createCacheRatio?: number;
  /** With quotaType ≥ 1: per-call price, ratio path skipped. */
  modelPrice?: number;
  /** 1=per-request, 3=flat custom, 4=grid. ≥1 bypasses ratio. */
  quotaType?: number;
  testDetail?: ModelTestDetail;
  /** Forces ratio=0 + group_ratio=0; cap check skipped. (OpenRouter free, NVIDIA) */
  isFree?: boolean;
  modelType: ModelType;
  /** Original endpoint strings — gates task-override sub-split detection (e.g. presence of openai-video). */
  endpoints?: string[];
  /** Normalized via normalizeEndpointTypes; feeds inferModelType + responses-api detection. */
  normalizedEndpoints?: string[];
  audioRatio?: number;
  audioCompletionRatio?: number;
  /** "tiered_expr" when billingExpr is set; otherwise "ratio" or undefined. */
  billingMode?: string;
  /** expr-lang expression; presence forces tiered_expr billing, ratios are ignored. */
  billingExpr?: string;
  /** Per-model upstream hash; used only for snapshot/drift, never written to target. */
  pricingVersion?: string;
  /** Provider-supplied metadata (e.g. upstream max_completion_tokens). Merged into the model's metadata column; config enabledModels overrides win. */
  metadata?: ModelMetadata;
}

export interface UpstreamOffer {
  provider: string;
  providerKind: ProviderKind;
  /** Upstream group name (synthetic placeholder for sub2api). */
  group: string;
  /** Tier channel-name base; already sanitized + collision-disambiguated. */
  sanitizedBase: string;
  vendor: string;
  channelType: number;
  baseUrl: string;
  apiKey: string;
  /** 1.0 = no group concept (sub2api). 0 = free (NVIDIA, OpenRouter free). */
  groupRatio: number;
  channelRemark: string;
  models: OfferModel[];
  priceAdjustment?: AnyProviderConfig["priceAdjustment"];
  defaultAdjustment: number;
  /** OpenRouter paid: cap-fitting binary search picks one group_ratio for the whole offer. */
  paidTier?: boolean;
  /** Free-tier offer (all models $0). Routes to pricing phase A; replaces the per-providerKind whitelist. */
  isFreeTier?: boolean;
}

/** newapi only; empty for sub2api/nvidia/openrouter. */
export interface EndpointPathInfo {
  path: string;
  method: string;
}

interface ProviderEndpointMetadata {
  endpointPaths: Map<string, EndpointPathInfo>;
}

export interface ProviderResult {
  report: ProviderReport;
  offers: UpstreamOffer[];
  endpointMetadata: ProviderEndpointMetadata;
}
