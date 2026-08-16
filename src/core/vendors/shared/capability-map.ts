import type { RuntimeConfig } from "@core/config";
import { resolveSourceMetadata } from "@core/pricing/resolver";
import type { PricingSource } from "@core/pricing/sources/types";
import type { ModelCapabilityHint } from "@core/testing/runner";

/**
 * Build per-model `{ supportsTools, isReasoning }` hints from the pricing
 * sources. The hints flow into the test runner so reasoning-only and
 * tools-unsupported models don't get false-failed by the tool-call probe.
 *
 * Each vendor maps its upstream name to an "exposed" name (the one written
 * to new-api) before looking up metadata. Most vendors lowercase the exposed
 * name; NVIDIA historically didn't, so callers pass their own mapper.
 */
export function buildCapabilityMap(
  upstreamModels: string[],
  mapExposed: (upstream: string) => string,
  ctx: {
    pricingSources: PricingSource[];
    reverseMapping: Map<string, string>;
  },
): Map<string, ModelCapabilityHint> {
  const map = new Map<string, ModelCapabilityHint>();
  for (const upstream of upstreamModels) {
    const md = resolveSourceMetadata(
      mapExposed(upstream),
      ctx.pricingSources,
      ctx.reverseMapping,
    );
    if (md.supportsTools !== undefined || md.isReasoning !== undefined) {
      map.set(upstream, {
        supportsTools: md.supportsTools,
        isReasoning: md.isReasoning,
      });
    }
  }
  return map;
}

/** Standard lowercase exposed-name resolver used by most vendors. */
export function lowercaseExposed(
  config: RuntimeConfig,
): (upstream: string) => string {
  return (upstream) =>
    (config.modelMapping?.[upstream] ?? upstream).toLowerCase();
}

/** NVIDIA's non-lowercased exposed-name resolver (kept for behavior parity). */
export function passthroughExposed(
  config: RuntimeConfig,
): (upstream: string) => string {
  return (upstream) => config.modelMapping?.[upstream] ?? upstream;
}
