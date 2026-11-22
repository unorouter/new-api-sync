import type { RuntimeConfig } from "@core/config";
import type { FingerprintEntry, SourceOf } from "./answer-fingerprints";

/**
 * Where a lane's answers come from, for the reference profiles: a provider
 * with `fingerprintSource: market` (judged and never trusted), the maker's own
 * route (`official`), or a known host (`host`, one profile per provider, or
 * per pool on ih).
 */
export function sourceOfFor(config: RuntimeConfig): SourceOf {
  const typeOf = new Map(config.providers.map((p) => [p.name, p.type]));
  const marketOf = new Set(
    config.providers
      .filter((p) => p.fingerprintSource === "market")
      .map((p) => p.name),
  );
  const officialOf = new Map(
    config.providers.flatMap((p) =>
      p.type === "openai-compatible" && p.official
        ? [[p.name, p.official] as const]
        : [],
    ),
  );
  return (entry: FingerprintEntry) => {
    // a7 keys are `a7:<merchant>|<model>`: the provider name ends at the colon.
    const provider = entry.provider.split(":")[0] ?? entry.provider;
    if (marketOf.has(provider)) return { source: "market", name: provider };
    // ih keys carry the pool as <pool>/<model>: one host profile per pool.
    if (typeOf.get(provider) === "ih") {
      const pool = entry.model.includes("/")
        ? entry.model.split("/")[0]!
        : provider;
      return { source: "host", name: `${provider}:${pool}` };
    }
    const official = officialOf.get(provider);
    if (official) return { source: "official", name: official };
    return { source: "host", name: provider };
  };
}
