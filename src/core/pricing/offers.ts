// Offer types: the input shape for the pricing pipeline.
//
// An UpstreamOffer is "this provider, in this upstream group, can serve these
// models with these capabilities." It carries everything compute() needs
// (per-model upstream ratios, free flags, fixed-price flags, test results)
// and nothing it doesn't (no API keys are used during pricing math, but they
// ride along so emit() can build channels without re-threading config).
//
// Each provider's discover function returns UpstreamOffer[]. The compute()
// function consumes the union of all offers from all providers and produces
// a global PricedPlan. There is no mid-pipeline state mutation.

import type { ModelType } from "@core/models/types";
import type { ModelTestDetail } from "@core/models/testing/types";
import type { AnyProviderConfig } from "@core/validations/config";

export type ProviderKind =
  | "newapi"
  | "nvidia"
  | "openrouter"
  | "direct"
  | "sub2api";

export interface OfferModel {
  /** Post-mapping name as exposed to users on the gateway. */
  exposed: string;
  /** Original upstream name. Identical to `exposed` when no mapping applies. */
  upstream: string;
  /** Upstream's per-model ratio. Undefined for providers that don't expose
   *  per-model pricing (sub2api, direct). When undefined, compute uses
   *  "cheapest existing group ratio across other tiers + baseline" instead
   *  of the rescale formula. */
  upstreamRatio?: number;
  upstreamCompletionRatio?: number;
  cacheRatio?: number;
  createCacheRatio?: number;
  /** Fixed-per-request price (image generation). When set with
   *  quotaType >= 1, the model is billed per call, not per token. */
  modelPrice?: number;
  /** Custom billing type override (1=per-request, 3=flat custom, 4=grid).
   *  Models with quotaType >= 1 bypass the ratio path entirely. */
  quotaType?: number;
  /** Test results for capability JSON in the channel `setting` field. */
  testDetail?: ModelTestDetail;
  /** Forces ratio=0 / completionRatio=0 in the global model_ratios map and
   *  group_ratio=0 on this offer's tier. Cap check is skipped. Used by
   *  free-tier OpenRouter and NVIDIA offers. */
  isFree?: boolean;
  modelType: ModelType;
  /** Original upstream endpoint type strings, for task-override sub-split
   *  detection (e.g. presence of "openai-video" gates the override). */
  endpoints?: string[];
}

export interface UpstreamOffer {
  /** Provider tag (config name). Used for channel.tag and managedProviders. */
  provider: string;
  providerKind: ProviderKind;
  /** Upstream's group name (or a synthetic placeholder for direct/sub2api
   *  which have no upstream group concept). */
  group: string;
  /** Sanitized base for tier channel names, e.g. `${groupName}-${providerName}`
   *  already passed through sanitizeGroupName + collision-disambiguation. */
  sanitizedBase: string;
  vendor: string;
  channelType: number;
  baseUrl: string;
  apiKey: string;
  /** Upstream's own group ratio. 1.0 if the provider has no group concept
   *  (direct, sub2api). 0 for free providers (NVIDIA, OpenRouter free). */
  groupRatio: number;
  channelRemark: string;
  models: OfferModel[];
  priceAdjustment?: AnyProviderConfig["priceAdjustment"];
  defaultAdjustment: number;
  /** Per-provider cap override, falling back to global config. */
  maxRatioCap: number;
  /** OpenRouter paid offers: trigger the cap-fitting binary search instead
   *  of the standard rescale formula. The compute function picks one
   *  group_ratio for the whole offer that keeps every model under cap. */
  paidTier?: boolean;
}
