import { getTaskModelOverride } from "@core/catalog/constants/channel-types";
import {
  ENDPOINT_DEFAULT_PATHS,
  MODEL_TYPE_CANONICAL_ENDPOINT,
  normalizeEndpointType,
} from "@core/catalog/constants/endpoints";
import { inferModelType } from "@core/catalog/constants/inference";
import { parseModelList } from "@core/catalog/constants/patterns";
import { inferVendorFromModelName } from "@core/catalog/constants/vendor-matchers";
import { type BasellmEntry, buildMetadataMap } from "@core/catalog/metadata";
import {
  buildModelMetadata,
  deriveTagsFromMetadata,
  type PricingSource,
  resolveSourceMetadata,
} from "@core/pricing/resolver";
import type { Channel, DesiredModelSpec } from "@core/types";

const CLAUDE_CONTEXT_1M_SUFFIX = "[1m]";

function isRoutingOnlyAlias(modelName: string): boolean {
  return modelName.endsWith(CLAUDE_CONTEXT_1M_SUFFIX);
}

export function buildDesiredModels(opts: {
  channels: Channel[];
  originalEndpointsByName: Map<string, string[]>;
  normalizedEndpointsByName: Map<string, string[]>;
  endpointPaths: Map<string, { path: string; method: string }>;
  reverseMapping: Map<string, string>;
  basellmEntries: BasellmEntry[];
  openRouterDescriptions: Map<string, string>;
  modelMapping: Record<string, string>;
  metadataByUpstream: Record<string, Record<string, unknown>>;
  pricingSources: PricingSource[];
}): Map<string, DesiredModelSpec> {
  const models = new Map<string, DesiredModelSpec>();

  const channelModelUpstream = new Map<string, string>();
  for (const ch of opts.channels) {
    if (!ch.model_mapping) continue;
    try {
      const mm = JSON.parse(ch.model_mapping) as Record<string, string>;
      for (const [exposed, upstream] of Object.entries(mm))
        if (!channelModelUpstream.has(exposed))
          channelModelUpstream.set(exposed, upstream);
    } catch {}
  }

  for (const channel of opts.channels) {
    for (const modelName of parseModelList(channel.models)) {
      if (isRoutingOnlyAlias(modelName)) continue;
      const vendor = inferVendorFromModelName(modelName);
      const upstreamFromChannel = channelModelUpstream.get(modelName);
      const originalEps =
        opts.originalEndpointsByName.get(modelName) ??
        (upstreamFromChannel
          ? opts.originalEndpointsByName.get(upstreamFromChannel)
          : undefined) ??
        opts.originalEndpointsByName.get(
          opts.reverseMapping.get(modelName) ?? "",
        );
      let endpoints: string | undefined;
      if (originalEps) {
        const epMap: Record<string, string> = {};
        for (const origEp of originalEps) {
          const normalized = normalizeEndpointType(origEp);
          const path =
            opts.endpointPaths.get(origEp)?.path ??
            ENDPOINT_DEFAULT_PATHS[normalized];
          if (path) epMap[normalized] = path;
        }
        if (Object.keys(epMap).length > 0) endpoints = JSON.stringify(epMap);
      } else {
        const canonicalEp =
          MODEL_TYPE_CANONICAL_ENDPOINT[inferModelType(modelName)];
        if (canonicalEp) {
          const path = ENDPOINT_DEFAULT_PATHS[canonicalEp];
          if (path) endpoints = JSON.stringify({ [canonicalEp]: path });
        }
      }
      models.set(modelName, { model_name: modelName, vendor, endpoints });
    }
  }

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

  for (const [modelName, spec] of models) {
    const upstreamFromChannel = channelModelUpstream.get(modelName);
    const originalName = opts.reverseMapping.get(modelName) ?? modelName;
    const eps =
      opts.normalizedEndpointsByName.get(modelName) ??
      (upstreamFromChannel
        ? opts.normalizedEndpointsByName.get(upstreamFromChannel)
        : undefined) ??
      opts.normalizedEndpointsByName.get(originalName);
    const modelType = inferModelType(modelName, eps);
    const typeTag = modelType.charAt(0).toUpperCase() + modelType.slice(1);
    const isTaskModel =
      eps?.includes("openai-video") ||
      (!eps && getTaskModelOverride(modelName) !== undefined);
    const prefix = isTaskModel ? `${typeTag},Task` : typeTag;
    const sourceTags = deriveTagsFromMetadata(
      resolveSourceMetadata(
        modelName,
        opts.pricingSources,
        opts.reverseMapping,
      ),
    );
    const rawTags = [prefix, spec.tags ?? "", sourceTags.join(",")]
      .filter(Boolean)
      .join(",");
    const seen = new Set<string>();
    const deduped = parseModelList(rawTags)
      .filter(
        (tag) => !seen.has(tag.toLowerCase()) && seen.add(tag.toLowerCase()),
      )
      .join(",");
    spec.tags =
      deduped.length > 255
        ? deduped.slice(0, deduped.lastIndexOf(",", 255) || 255)
        : deduped;
  }

  const exposedToUpstream = new Map<string, string>();
  for (const ch of opts.channels) {
    if (!ch.model_mapping) continue;
    try {
      const mm = JSON.parse(ch.model_mapping) as Record<string, string>;
      for (const [exposed, upstream] of Object.entries(mm))
        exposedToUpstream.set(exposed, upstream);
    } catch {}
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
    if (merged) spec.metadata = JSON.stringify(merged);
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
      if (eps?.includes("openai-response")) result.push(mappedName);
    }
  }
  return result;
}
