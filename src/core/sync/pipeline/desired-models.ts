import { getTaskModelOverride } from "@core/catalog/constants/channel-types";
import {
  ENDPOINT_DEFAULT_PATHS,
  MODEL_TYPE_CANONICAL_ENDPOINT,
  normalizeEndpointType,
} from "@core/catalog/constants/endpoints";
import { inferModelType } from "@core/catalog/constants/inference";
import { parseModelList } from "@core/catalog/constants/patterns";
import { inferVendorFromModelName } from "@core/catalog/constants/vendor-matchers";
import {
  type BasellmEntry,
  buildMetadataMap,
} from "@core/catalog/metadata";
import { splitCsv } from "@core/catalog/naming";
import {
  buildModelMetadata,
  deriveTagsFromMetadata,
  type PricingSource,
  resolveSourceMetadata,
} from "@core/pricing/resolver";
import type { Channel, DesiredModelSpec } from "@core/types";

export function buildDesiredModels(opts: {
  channels: Channel[];
  /** Original upstream endpoint type strings, keyed by both `exposed` and
   *  `upstream` for each OfferModel. Replaces SyncState.modelOriginalEndpoints. */
  originalEndpointsByName: Map<string, string[]>;
  /** Normalized endpoint type strings, keyed by both `exposed` and `upstream`.
   *  Replaces SyncState.modelEndpoints. */
  normalizedEndpointsByName: Map<string, string[]>;
  /** Endpoint type -> {path, method} aggregated across all providers.
   *  Replaces SyncState.endpointPaths. */
  endpointPaths: Map<string, { path: string; method: string }>;
  reverseMapping: Map<string, string>;
  basellmEntries: BasellmEntry[];
  openRouterDescriptions: Map<string, string>;
  modelMapping: Record<string, string>;
  /**
   * Per-model metadata overrides collected from each provider's
   * `enabledModels`. Keyed by the UPSTREAM model id (e.g.
   * "z-ai/glm4.7"). Applied after the bare-name resolution so the
   * metadata lands on whichever exposed name the sync actually pushes.
   */
  metadataByUpstream: Record<string, Record<string, unknown>>;
  /** Pricing sources used to auto-populate model metadata (max tokens,
   *  capabilities, modalities). Override from enabledModels still wins. */
  pricingSources: PricingSource[];
}): Map<string, DesiredModelSpec> {
  const models = new Map<string, DesiredModelSpec>();

  for (const channel of opts.channels) {
    const channelModels = parseModelList(channel.models);
    for (const modelName of channelModels) {
      const vendor = inferVendorFromModelName(modelName);
      const originalEps =
        opts.originalEndpointsByName.get(modelName) ??
        opts.originalEndpointsByName.get(
          opts.reverseMapping.get(modelName) ?? "",
        );
      let endpoints: string | undefined;
      if (originalEps) {
        const epMap: Record<string, string> = {};
        for (const origEp of originalEps) {
          const normalized = normalizeEndpointType(origEp);
          const info = opts.endpointPaths.get(origEp);
          const path = info?.path ?? ENDPOINT_DEFAULT_PATHS[normalized];
          if (path) epMap[normalized] = path;
        }
        if (Object.keys(epMap).length > 0) endpoints = JSON.stringify(epMap);
      } else {
        // No upstream endpoint data: infer from model type
        const modelType = inferModelType(modelName);
        const canonicalEp = MODEL_TYPE_CANONICAL_ENDPOINT[modelType];
        if (canonicalEp) {
          const path = ENDPOINT_DEFAULT_PATHS[canonicalEp];
          if (path) endpoints = JSON.stringify({ [canonicalEp]: path });
        }
      }
      models.set(modelName, {
        model_name: modelName,
        vendor,
        endpoints,
      });
    }
  }

  // Enrich models with descriptions (OpenRouter) and tags (basellm)
  const metadataMap = buildMetadataMap({
    modelNames: models.keys(),
    basellmEntries: opts.basellmEntries,
    openRouterDescriptions: opts.openRouterDescriptions,
    modelMapping: opts.modelMapping,
  });
  for (const [modelName, meta] of metadataMap) {
    const existing = models.get(modelName);
    if (existing) {
      if (meta.description) existing.description = meta.description;
      if (meta.tags) existing.tags = meta.tags;
    }
  }

  // Add model type tag (and a `Task` tag for async task models) and deduplicate.
  // The `Task` tag lets downstream consumers (unorouter) tell async task models
  // apart from regular streaming models without re-encoding the override list.
  // Gate `Task` on the upstream actually exposing `openai-video`; a name like
  // `grok-imagine-video` can also be resold as chat-completions, in which case
  // it is not a task model for this channel.
  //
  // Tags are merged from three sources, in order of precedence:
  // 1. Type prefix (Text/Image/Video/Audio + optional Task)
  // 2. basellm tags (already in spec.tags from buildMetadataMap)
  // 3. Capability tags derived from LiteLLM/OpenRouter metadata
  //    (Reasoning, Tools, Vision, Audio, Files, Cache, WebSearch, ComputerUse,
  //    + context-window tag like "200K", "1M")
  for (const [modelName, spec] of models) {
    const originalName = opts.reverseMapping.get(modelName) ?? modelName;
    const eps =
      opts.normalizedEndpointsByName.get(modelName) ??
      opts.normalizedEndpointsByName.get(originalName);
    const modelType = inferModelType(modelName, eps);
    const typeTag = modelType.charAt(0).toUpperCase() + modelType.slice(1);
    const isTaskModel =
      eps?.includes("openai-video") ||
      (!eps && getTaskModelOverride(modelName) !== undefined);
    const prefix = isTaskModel ? `${typeTag},Task` : typeTag;

    const sourceMd = resolveSourceMetadata(
      modelName,
      opts.pricingSources,
      opts.reverseMapping,
    );
    const sourceTags = deriveTagsFromMetadata(sourceMd);

    const rawTags = [prefix, spec.tags ?? "", sourceTags.join(",")]
      .filter(Boolean)
      .join(",");

    const seen = new Set<string>();
    const deduped = splitCsv(rawTags)
      .filter((t) => {
        const lower = t.toLowerCase();
        if (seen.has(lower)) return false;
        seen.add(lower);
        return true;
      })
      .join(",");
    spec.tags =
      deduped.length > 255
        ? deduped.slice(0, deduped.lastIndexOf(",", 255) || 255)
        : deduped;
  }

  // Apply per-model metadata. Layered: source-derived (LiteLLM > OpenRouter
  // > basellm) provides defaults, then per-model `enabledModels[].metadata`
  // overrides win. Config keys are the upstream id (`z-ai/glm4.7`); desired
  // models are keyed by the exposed bare name (`glm4.7`). Build exposed ->
  // upstream from each channel's model_mapping since that's the real source
  // of bare-name resolution (global reverseMapping only covers
  // config.modelMapping renames).
  const exposedToUpstream = new Map<string, string>();
  for (const ch of opts.channels) {
    if (!ch.model_mapping) continue;
    try {
      const mm = JSON.parse(ch.model_mapping) as Record<string, string>;
      for (const [exposed, upstream] of Object.entries(mm)) {
        exposedToUpstream.set(exposed, upstream);
      }
    } catch {
      // malformed model_mapping — skip
    }
  }
  for (const [modelName, spec] of models) {
    const upstream = exposedToUpstream.get(modelName) ?? modelName;
    const override =
      opts.metadataByUpstream[upstream] ?? opts.metadataByUpstream[modelName];
    const merged = buildModelMetadata({
      modelName,
      sources: opts.pricingSources,
      reverseMapping: opts.reverseMapping,
      override,
    });
    if (merged) {
      spec.metadata = JSON.stringify(merged);
    }
  }

  return models;
}

export function collectResponsesApiModels(
  channels: Channel[],
  normalizedEndpointsByName: Map<string, string[]>,
  reverseMapping: Map<string, string>,
  modelMapping: Record<string, string>,
): string[] {
  const result: string[] = [];
  for (const channel of channels) {
    for (const modelName of parseModelList(channel.models)) {
      const mappedName = modelMapping?.[modelName] ?? modelName;
      const originalName = reverseMapping.get(mappedName) ?? mappedName;
      const eps =
        normalizedEndpointsByName.get(modelName) ??
        normalizedEndpointsByName.get(originalName);
      if (eps?.includes("openai-response")) {
        result.push(mappedName);
      }
    }
  }
  return result;
}
