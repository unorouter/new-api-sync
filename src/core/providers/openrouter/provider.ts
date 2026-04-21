import { getEnabledModelGlobs, type RuntimeConfig } from "@core/config";
import {
  CHANNEL_TYPES,
  matchesAnyPattern,
  matchesBlacklist,
} from "@core/models/constants";
import { logTestSummary } from "@core/models/test-log";
import type { OpenRouterProviderConfig } from "@core/validations/config";
import type { ProviderReport, SyncState } from "@core/types";
import { t } from "@server/i18n";
import { consola } from "consola";
import { discoverOpenRouterFreeModels } from "./discovery";

/**
 * Strip the `vendor/` prefix and `:free` / other colon suffixes from an
 * OpenRouter model ID to produce a user-facing bare name.
 *   "openai/gpt-oss-120b:free" -> "gpt-oss-120b"
 *   "moonshotai/kimi-k2.6"     -> "kimi-k2.6"
 */
function toBareName(openRouterId: string): string {
  const slash = openRouterId.indexOf("/");
  const withoutVendor = slash >= 0 ? openRouterId.slice(slash + 1) : openRouterId;
  const colon = withoutVendor.indexOf(":");
  return colon >= 0 ? withoutVendor.slice(0, colon) : withoutVendor;
}

interface ProbeResult {
  status: number | null;
  bodyText: string | null;
  error: string | null;
  latencyMs: number;
}

async function probeStatus(
  baseUrl: string,
  apiKey: string,
  modelId: string,
): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const res = await fetch(
      `${baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const latencyMs = Date.now() - started;
    const bodyText = await res.text().catch(() => "");
    return {
      status: res.status,
      bodyText: bodyText || null,
      error: res.ok ? null : `HTTP ${res.status} ${res.statusText}`,
      latencyMs,
    };
  } catch (err) {
    return {
      status: null,
      bodyText: null,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
    };
  }
}

export async function processOpenRouterProvider(
  providerConfig: OpenRouterProviderConfig,
  config: RuntimeConfig,
  state: SyncState,
): Promise<ProviderReport> {
  const report: ProviderReport = {
    name: providerConfig.name,
    success: false,
    groups: 0,
    models: 0,
    tokens: { created: 0, existing: 0, deleted: 0 },
  };

  try {
    // 1. Resolve candidate model IDs.
    //    - If explicit `models` is provided, use only that list (bypass discovery).
    //    - Otherwise: dynamic free discovery + literal enabledModels extras (union).
    let candidateIds: string[];

    if (providerConfig.models?.length) {
      candidateIds = [...providerConfig.models];
      consola.info(
        t("CORE.OPENROUTER.EXPLICIT_SKIP_DISCOVERY", {
          name: providerConfig.name,
          count: candidateIds.length,
        }),
      );
    } else {
      const freeIds = await discoverOpenRouterFreeModels(
        providerConfig.baseUrl,
        providerConfig.apiKey,
      );
      consola.info(
        t("CORE.OPENROUTER.DISCOVERED_FREE", {
          name: providerConfig.name,
          count: freeIds.length,
        }),
      );

      // Add literal (non-wildcard) entries from enabledModels as explicit extras.
      const enabledGlobs =
        getEnabledModelGlobs(providerConfig.enabledModels) ?? [];
      const extras = enabledGlobs.filter(
        (g) => !g.includes("*") && !g.includes("?"),
      );
      const set = new Set(freeIds);
      for (const extra of extras) {
        if (!set.has(extra)) {
          set.add(extra);
          consola.debug(
            t("CORE.OPENROUTER.ADDED_EXTRA", {
              name: providerConfig.name,
              model: extra,
            }),
          );
        }
      }
      candidateIds = [...set];
    }

    if (candidateIds.length === 0) {
      report.error = t("CORE.ERROR.NO_MODELS_FOUND");
      return report;
    }

    // 2. Apply filters:
    //    - blacklist (text-style match against bare names — OpenRouter IDs
    //      don't map cleanly onto vendor scopes, so match both full and bare)
    //    - enabledVendors (prefix of the full ID, before the first slash)
    //    - NOTE: enabledModels is treated as ADDITIVE (applied above), not
    //      restrictive, per the provider contract.
    const vendorFilter = providerConfig.enabledVendors;
    const filtered = candidateIds.filter((id) => {
      const bare = toBareName(id);
      if (
        matchesBlacklist(bare, config.blacklist, providerConfig.name) ||
        matchesBlacklist(id, config.blacklist, providerConfig.name)
      ) {
        return false;
      }
      if (vendorFilter?.length) {
        const slash = id.indexOf("/");
        const vendor = slash >= 0 ? id.slice(0, slash).toLowerCase() : "";
        if (!vendorFilter.map((v) => v.toLowerCase()).includes(vendor)) {
          return false;
        }
      }
      if (config.modelFilter?.length) {
        if (
          !matchesAnyPattern(id, config.modelFilter) &&
          !matchesAnyPattern(bare, config.modelFilter)
        ) {
          return false;
        }
      }
      return true;
    });

    if (filtered.length === 0) {
      report.error = t("CORE.ERROR.ALL_MODELS_FILTERED_SHORT");
      return report;
    }

    // 3. Test each model with a 1-token chat completion. Treat 429 as working
    //    (model exists upstream, just rate-limited right now).
    consola.info(
      t("CORE.OPENROUTER.PROBING", {
        name: providerConfig.name,
        count: filtered.length,
      }),
    );
    const working: string[] = [];
    const failed: Array<{ id: string; status: number | null }> = [];
    for (const id of filtered) {
      const probe = await probeStatus(
        providerConfig.baseUrl,
        providerConfig.apiKey,
        id,
      );
      const pass = probe.status === 200 || probe.status === 429;
      logTestSummary({
        prefix: providerConfig.name,
        model: toBareName(id),
        modelType: "text",
        http: {
          pass,
          status: probe.status,
          latencyMs: probe.latencyMs,
          error: probe.error,
          body: probe.bodyText,
        },
      });
      if (pass) working.push(id);
      else failed.push({ id, status: probe.status });
    }

    if (failed.length > 0) {
      const labeled = failed
        .map((f) => `${toBareName(f.id)}(${f.status ?? "net"})`)
        .join(", ");
      consola.info(
        t("CORE.OPENROUTER.FAILED", {
          name: providerConfig.name,
          models: labeled,
        }),
      );
    }
    consola.info(
      t("CORE.OPENROUTER.WORKING", {
        name: providerConfig.name,
        working: working.length,
        total: filtered.length,
      }),
    );

    if (working.length === 0) {
      report.error = t("CORE.ERROR.NO_WORKING_MODELS");
      return report;
    }

    // 4. Build bare-name → full-ID mapping, handling collisions by keeping the
    //    full ID for the colliding entry so both remain addressable.
    const bareCount = new Map<string, number>();
    for (const id of working) {
      const bare = toBareName(id);
      bareCount.set(bare, (bareCount.get(bare) ?? 0) + 1);
    }

    // exposedName = what users call on unorouter; upstream = what we forward to OpenRouter
    const upstreamByExposed = new Map<string, string>();
    for (const id of working) {
      const bare = toBareName(id);
      const collides = (bareCount.get(bare) ?? 0) > 1;
      const exposed = collides ? id : bare;
      // Apply user modelMapping (e.g. rename "kimi-k2.6" -> "kimi-k2-6")
      const mapped = config.modelMapping?.[exposed] ?? exposed;
      upstreamByExposed.set(mapped, id);
    }

    const exposedNames = [...upstreamByExposed.keys()];

    // 5. Build reverse model_mapping: only include entries where exposed !== upstream.
    const reverseMapping: Record<string, string> = {};
    for (const [exposed, upstream] of upstreamByExposed) {
      if (exposed !== upstream) reverseMapping[exposed] = upstream;
    }

    // 6. Push a single channel. Zero-ratio group, OpenRouter channel type so
    //    new-api's adaptor handles quirks of the upstream format.
    const groupName = `openrouter-free-${providerConfig.name}`;
    state.mergedGroups.push({
      name: groupName,
      ratio: providerConfig.ratio,
      description: `OpenRouter free tier via ${providerConfig.name}`,
      provider: providerConfig.name,
    });

    state.channelsToCreate.push({
      name: groupName,
      type: CHANNEL_TYPES.OPENROUTER,
      key: providerConfig.apiKey,
      base_url: providerConfig.baseUrl,
      models: exposedNames.join(","),
      group: groupName,
      priority: 0,
      weight: 1,
      status: 1,
      tag: providerConfig.name,
      remark: groupName,
      model_mapping:
        Object.keys(reverseMapping).length > 0
          ? JSON.stringify(reverseMapping)
          : undefined,
    });

    // 7. Override ratios to 0 for all exposed models. Mirrors the nvidia image
    //    branch: partial syncs may have seeded stale ratio entries from the
    //    pricing API for the same bare name.
    for (const exposed of exposedNames) {
      state.mergedModels.set(exposed, {
        ratio: 0,
        completionRatio: 0,
        modelPrice: 0,
        quotaType: 1,
      });
    }

    consola.info(
      t("CORE.NVIDIA.IMAGE_CHANNEL", {
        name: providerConfig.name,
        count: exposedNames.length,
        group: groupName,
        type: CHANNEL_TYPES.OPENROUTER,
      }),
    );

    report.groups = 1;
    report.models = exposedNames.length;
    report.success = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }

  return report;
}
