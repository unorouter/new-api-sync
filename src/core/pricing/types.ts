// Output types for the pricing pipeline.
//
// A PricedPlan is the result of compute(): a list of fully-priced tiers ready
// for emission as channels, plus the global model_ratios map and a list of
// drops for diagnostics. Once you have a PricedPlan, no more pricing math
// happens — emit() just translates tiers into Channel objects.

import type { Channel, MergedGroup, MergedModel } from "@core/types";
import type { ModelTestDetail } from "@core/testing/types";

export interface PricedTier {
  /** Disambiguated channel name, e.g. `aigc-3-moonshot-t1`. Already includes
   *  the `-tN` / `-tNa` suffixes when there are multiple tiers / sub-tiers. */
  channelName: string;
  vendor: string;
  channelType: number;
  /** Final base URL (provider baseUrl + optional task-override suffix). */
  baseUrl: string;
  apiKey: string;
  /** Provider tag (channel.tag) — used to identify the owning provider for
   *  managedProviders set membership. */
  providerTag: string;
  channelRemark: string;
  /** Final post-rescale, post-adjustment group ratio. This is what gets
   *  written to GroupRatio for this tier. */
  groupRatio: number;
  /** The priceAdjustment applied to this tier (0 when none). The 1x-cap post-pass backs
   *  it out (cost = groupRatio / (1 + priceAdjustment)) to clamp an all-above-1x model to
   *  cheapest-upstream-cost + 5%, never the full markup. */
  priceAdjustment?: number;
  groupDescription: string;
  /** Exposed model names that should be served by this channel. */
  models: string[];
  /** Reverse mapping (exposed -> upstream) scoped to this tier's models. */
  modelMapping?: Record<string, string>;
  /** Test details pre-filtered to this tier's models. emit() reads these to
   *  build the capabilities JSON for channel.setting. */
  testDetails?: ModelTestDetail[];
  /** Optional channel-scoped param_override JSON. Used for header injection
   *  on conditional model-name suffixes (e.g. Claude `[1m]` context beta). */
  paramOverride?: string;
  /** Emit the channel disabled (status=3). Set when the model only passed via a
   *  429 capacity throttle; new-api's auto-test enables it once the limit clears. */
  disabled?: boolean;
  /** Forward the raw client body to upstream (channel.setting.pass_through_body_enabled).
   *  Media channels need it so non-struct fields (image_urls, vendor extras) survive new-api's
   *  ImageRequest re-marshal, which drops unknown fields. */
  passThroughBody?: boolean;
}

type PricedDropReason = "cap-exceeded" | "no-fit" | "collision";

export interface PricedDrop {
  model: string;
  /** Intended tier name where the model would have landed. */
  channel: string;
  reason: PricedDropReason;
  effectiveRatio?: number;
  /** Optional human-readable detail for log lines. */
  detail?: string;
}

export interface PricedPlan {
  tiers: PricedTier[];
  /** Single source of truth for model_ratio + completion/cache ratios.
   *  Built by compute() from canonical retail (LiteLLM > OpenRouter >
   *  basellm) when available, falling back to cheapest offer ratio when
   *  no canonical resolves. */
  modelRatios: Map<string, MergedModel>;
  drops: PricedDrop[];
}

/** Inputs to compute() that come from the existing target snapshot or
 *  partial-sync seeding. Must include any baseline channels/groups whose
 *  ratios sub2api's "cheapest existing" lookup needs to consider. */
export interface BaselineInputs {
  groups: MergedGroup[];
  channels: Channel[];
  modelRatios: Map<string, MergedModel>;
}
