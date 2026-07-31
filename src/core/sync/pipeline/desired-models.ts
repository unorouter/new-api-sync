import { toBareName } from "@core/catalog/bare-name";
import {
  CHANNEL_TYPES,
  getTaskModelOverride,
} from "@core/catalog/constants/channel-types";
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
  looksTruncated,
  type PricingSource,
  resolveSourceMetadata,
} from "@core/pricing/resolver";
import type { Channel, DesiredModelSpec } from "@core/types";
import { consola } from "consola";

const CLAUDE_CONTEXT_1M_SUFFIX = "[1m]";

// Prefer the non-truncated, then the longer description. Keeps the current
// OpenRouter win when both are complete; lets ePhone's full text override a
// truncated OpenRouter stub.
export function pickBetterDescription(
  primary: string | undefined,
  fallback: string | undefined,
): string | undefined {
  if (!primary) return fallback;
  if (!fallback) return primary;
  const primaryTrunc = looksTruncated(primary);
  const fallbackTrunc = looksTruncated(fallback);
  if (primaryTrunc && !fallbackTrunc) return fallback;
  if (!primaryTrunc && fallbackTrunc) return primary;
  return fallback.length > primary.length ? fallback : primary;
}

// exposed -> upstream from every channel's model_mapping. First-wins for determinism.
function buildChannelModelUpstream(channels: Channel[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const ch of channels) {
    if (!ch.model_mapping) continue;
    try {
      const mm = JSON.parse(ch.model_mapping) as Record<string, string>;
      for (const [exposed, upstream] of Object.entries(mm))
        if (!map.has(exposed)) map.set(exposed, upstream);
    } catch (err) {
      consola.warn(
        `Channel "${ch.name}" has unparseable model_mapping: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return map;
}

// Model names served by an AIHORDE-type channel. These need the `aihorde`
// endpoint (async task, POST /v1/videos), NOT the sync `image-generation` the
// image model-type would otherwise pick.
export function buildAiHordeModels(channels: Channel[]): Set<string> {
  const set = new Set<string>();
  for (const ch of channels) {
    if (ch.type !== CHANNEL_TYPES.AIHORDE) continue;
    for (const m of parseModelList(ch.models))
      if (!isRoutingOnlyAlias(m)) set.add(m);
  }
  return set;
}

// Model names served by a RUNWARE-type channel. Runware image inference is
// synchronous, so unlike aihorde these pin the sync image endpoint. They are
// named by AIR alias (wai-illustrious), which infers no model type on its own.
export function buildRunwareModels(channels: Channel[]): Set<string> {
  const set = new Set<string>();
  for (const ch of channels) {
    if (ch.type !== CHANNEL_TYPES.RUNWARE) continue;
    for (const m of parseModelList(ch.models))
      if (!isRoutingOnlyAlias(m)) set.add(m);
  }
  return set;
}

export function isRoutingOnlyAlias(modelName: string): boolean {
  return modelName.endsWith(CLAUDE_CONTEXT_1M_SUFFIX);
}

export interface ToolEvidence {
  supportsTools: boolean;
  supportsParallelTools: boolean;
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
  /** Live tool-probe verdicts from this run, keyed by published model name. */
  toolEvidence: Map<string, ToolEvidence>;
  /** Existing target metadata, keyed by model name. */
  snapshotMetadata: Map<string, Record<string, unknown>>;
}): Map<string, DesiredModelSpec> {
  const models = new Map<string, DesiredModelSpec>();

  const channelModelUpstream = buildChannelModelUpstream(opts.channels);
  const aiHordeModels = buildAiHordeModels(opts.channels);
  const runwareModels = buildRunwareModels(opts.channels);

  for (const channel of opts.channels) {
    for (const modelName of parseModelList(channel.models)) {
      if (isRoutingOnlyAlias(modelName)) continue;
      const vendor = inferVendorFromModelName(modelName);
      const upstreamFromChannel = channelModelUpstream.get(modelName);
      // AIHORDE models are async image tasks: pin the aihorde endpoint so
      // new-api's metadata-endpoint override doesn't publish a sync image
      // endpoint the model can't serve.
      if (aiHordeModels.has(modelName)) {
        models.set(modelName, {
          model_name: modelName,
          vendor: "aihorde",
          endpoints: JSON.stringify({ aihorde: "/v1/videos" }),
        });
        continue;
      }
      if (runwareModels.has(modelName)) {
        models.set(modelName, {
          model_name: modelName,
          vendor: "runware",
          endpoints: JSON.stringify({
            "image-generation": "/v1/images/generations",
          }),
        });
        continue;
      }
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

  // Also resolve metadata under each name's bare form so a `{model}:free`
  // published name inherits the base model's description/tags (the fuzzy index
  // has no `:free` key).
  const metadataMap = buildMetadataMap({
    modelNames: new Set([
      ...models.keys(),
      ...[...models.keys()].map((n) => toBareName(n)),
    ]),
    basellmEntries: opts.basellmEntries,
    openRouterDescriptions: opts.openRouterDescriptions,
    modelMapping: opts.modelMapping,
  });
  for (const [modelName, spec] of models) {
    const meta =
      metadataMap.get(modelName) ?? metadataMap.get(toBareName(modelName));
    if (meta?.tags) spec.tags = meta.tags;
    // ePhone (and other pricing sources) carry full descriptions; OpenRouter's is
    // often truncated. Take the fuller/non-truncated of the two.
    const sourceDescription = resolveSourceMetadata(
      modelName,
      opts.pricingSources,
      opts.reverseMapping,
    ).description;
    const chosen = pickBetterDescription(meta?.description, sourceDescription);
    if (chosen) spec.description = chosen;
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
    const isAiHorde = aiHordeModels.has(modelName);
    const modelType = isAiHorde ? "image" : inferModelType(modelName, eps);
    const typeTag = modelType.charAt(0).toUpperCase() + modelType.slice(1);
    const isTaskModel =
      isAiHorde ||
      eps?.includes("openai-video") ||
      eps?.includes("aihorde") ||
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

  for (const [modelName, spec] of models) {
    const upstream = channelModelUpstream.get(modelName) ?? modelName;
    const override =
      opts.metadataByUpstream[upstream] ?? opts.metadataByUpstream[modelName];
    const merged =
      buildModelMetadata({
        modelName,
        sources: opts.pricingSources,
        reverseMapping: opts.reverseMapping,
        override,
      }) ?? {};
    // Tool-capability policy: live probe evidence beats source CLAIMS; without fresh
    // evidence, keep the target's existing verdict (prior probe/backfill) so a
    // transient-skipped run never resurrects a wrong claim.
    const evidence = opts.toolEvidence.get(modelName);
    const prior = opts.snapshotMetadata.get(modelName);
    if (evidence) {
      merged.supportsTools = evidence.supportsTools;
      merged.supportsParallelTools = evidence.supportsTools
        ? evidence.supportsParallelTools
        : false;
    } else if (prior) {
      if (typeof prior.supportsTools === "boolean")
        merged.supportsTools = prior.supportsTools;
      if (typeof prior.supportsParallelTools === "boolean")
        merged.supportsParallelTools = prior.supportsParallelTools;
    }
    if (Object.keys(merged).length > 0) spec.metadata = JSON.stringify(merged);
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
