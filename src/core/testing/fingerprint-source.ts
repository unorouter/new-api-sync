import type { RuntimeConfig } from "@core/config";
import { SIMPLE_PROVIDER_META } from "@core/vendors/registry-meta";
import type { FingerprintEntry, SourceOf } from "./answer-fingerprints";

const OFFICIAL_KINDS = new Set<string>(
  SIMPLE_PROVIDER_META.filter((m) => "official" in m && m.official).map(
    (m) => m.kind,
  ),
);

/**
 * Where a lane's answers come from, for the reference profiles: the maker's
 * own route (`official`), a known host that is not a marketplace (`host`, one
 * profile per provider, or per pool on ih), or a marketplace merchant
 * (`market`, judged and never trusted).
 */
export function sourceOfFor(config: RuntimeConfig): SourceOf {
  const typeOf = new Map(config.providers.map((p) => [p.name, p.type]));
  return (entry: FingerprintEntry) => {
    // a7 keys are `a7:<merchant>|<model>`: the provider name ends at the colon.
    const provider = entry.provider.split(":")[0] ?? entry.provider;
    const type = typeOf.get(provider);
    if (type === "a7" || type === "si") return { source: "market", name: provider };
    if (type === "ih") {
      const pool = entry.model.includes("/") ? entry.model.split("/")[0]! : provider;
      return { source: "host", name: `${provider}:${pool}` };
    }
    if (type && OFFICIAL_KINDS.has(type)) return { source: "official", name: type };
    return { source: "host", name: provider };
  };
}
