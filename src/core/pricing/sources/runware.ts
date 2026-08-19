import { tryFetchJson } from "@core/infra/http";
import { consola } from "consola";
import pLimit from "p-limit";
import type { ImageParams, ImageParamRange } from "./types";

// A param absent from Runware's schema is rejected upstream, so a control for it
// could only ever produce a failed generation. Two tiers: an arbitrary Civitai
// checkpoint resolves through its ARCHITECTURE, hosted APIs through their own slug.

const SCHEMA_URL = (slug: string) =>
  `https://runware.ai/docs/models/${slug}/schema.json`;
const FETCH_CONCURRENCY = 8;

const ARCHITECTURES = [
  "sdxl",
  "sdxl-lightning",
  "sdxl-turbo",
  "sd-1-5",
  "pony",
  "illustrious",
  "noobai",
  "flux-1-dev",
  "flux-1-schnell",
  "flux-1-kontext-dev",
  "flux-1-dev-srpo",
  "hidream-i1-dev",
  "hidream-i1-fast",
  "hidream-i1-full",
];

const MODEL_SLUGS = [
  "bfl-flux-2-max",
  "bfl-flux-2-pro",
  "bfl-flux-2-flex",
  "bfl-flux-2-dev",
  "bfl-flux-2-klein-4b",
  "bfl-flux-2-klein-9b",
  "openai-gpt-image-1",
  "openai-gpt-image-2",
  "bytedance-seedream-4-0",
  "bytedance-seedream-4-5",
  "bytedance-seedream-5-0-pro",
  "bytedance-seedream-5-0-lite",
];

// Joins the catalog's `series` label to Runware's architecture slugs.
const SERIES_TO_ARCHITECTURE: Record<string, string> = {
  sdxl: "sdxl",
  pony: "pony",
  illustrious: "illustrious",
  noobai: "noobai",
  "stable diffusion": "sd-1-5",
  flux: "flux-1-dev",
  hidream: "hidream-i1-dev",
};

// Provider-hosted rows carry neither AIR nor series, so without this they resolve
// to nothing and render a Steps slider on FLUX.2 max, which rejects it.
const MODEL_NAME_TO_AIR: Record<string, string> = {
  "flux.2-max": "bfl:7@1",
  "flux.2-pro": "bfl:5@1",
  "flux.2-flex": "bfl:6@1",
  "flux.2-dev": "runware:400@1",
  "flux.2-klein-9b": "runware:400@2",
  "flux.2-klein-4b": "runware:400@4",
};

type JsonObject = Record<string, unknown>;

interface ParamSpec {
  min?: number;
  max?: number;
  default?: unknown;
  enum?: string[];
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

// RequestBody comes in TWO shapes: most models put params on `properties`, others
// (flux-2-flex) wrap the task in an array and nest them under `items.properties`.
// Reading only `properties` reports every param of those models as missing.
function requestProperties(schema: JsonObject): JsonObject {
  const direct = asObject(schema.properties);
  if (direct) return direct;
  const items = asObject(schema.items);
  return (items && asObject(items.properties)) ?? {};
}

function toParamSpec(raw: JsonObject): ParamSpec {
  const spec: ParamSpec = {};
  if (typeof raw.minimum === "number") spec.min = raw.minimum;
  if (typeof raw.maximum === "number") spec.max = raw.maximum;
  if (raw.default !== undefined) spec.default = raw.default;
  if (Array.isArray(raw.enum)) {
    spec.enum = raw.enum.filter((v): v is string => typeof v === "string");
  } else if (Array.isArray(raw.oneOf)) {
    // Runware spells provider-settings enums as oneOf[{const}] rather than enum.
    const consts = raw.oneOf
      .map((o) => asObject(o)?.const)
      .filter((c): c is string => typeof c === "string");
    if (consts.length > 0) spec.enum = consts;
  }
  return spec;
}

function toRange(spec: ParamSpec | undefined): ImageParamRange | undefined {
  if (!spec) return undefined;
  const range: ImageParamRange = {};
  if (spec.min !== undefined) range.min = spec.min;
  if (spec.max !== undefined) range.max = spec.max;
  const def = numeric(spec.default);
  if (def !== undefined) range.default = def;
  return Object.keys(range).length > 0 ? range : undefined;
}

function distill(
  raw: unknown,
): { air: string | null; params: ImageParams } | null {
  const root = asObject(raw);
  if (!root) return null;
  const components = asObject(root.components);
  const schemas = components && asObject(components.schemas);
  const requestBody = schemas && asObject(schemas.RequestBody);
  if (!requestBody) return null;

  const properties = requestProperties(requestBody);
  const params: Record<string, ParamSpec> = {};
  for (const [key, value] of Object.entries(properties)) {
    const entry = asObject(value);
    if (entry) params[key] = toParamSpec(entry);
  }

  const inputs = asObject(properties.inputs);
  const inputProps = (inputs && asObject(inputs.properties)) ?? {};
  const references = asObject(inputProps.referenceImages);

  // Keyed "<vendor>.<field>"; only one vendor ever matches a model.
  const providerSettings: Record<string, ParamSpec> = {};
  const settingsRoot = asObject(properties.providerSettings);
  for (const [vendor, vendorSchema] of Object.entries(
    (settingsRoot && asObject(settingsRoot.properties)) ?? {},
  )) {
    const vendorProps = asObject(vendorSchema);
    for (const [field, fieldSchema] of Object.entries(
      (vendorProps && asObject(vendorProps.properties)) ?? {},
    )) {
      const entry = asObject(fieldSchema);
      if (entry) providerSettings[`${vendor}.${field}`] = toParamSpec(entry);
    }
  }
  const vendorParam = (name: string) =>
    Object.entries(providerSettings).find(
      ([key]) => key.split(".")[1] === name,
    )?.[1];

  const info = asObject(root.info) ?? {};
  return {
    air: typeof info["x-air-id"] === "string" ? info["x-air-id"] : null,
    params: {
      supportsNegativePrompt: "negativePrompt" in params,
      supportsCfg: "CFGScale" in params,
      supportsSteps: "steps" in params,
      supportsSampler: "scheduler" in params,
      supportsLoraChain: "lora" in params,
      supportsSeed: "seed" in params,
      supportsStrength: "strength" in params,
      supportsHiresFix: "hiresFix" in params,
      supportsAdetailer: "ultralytics" in params,
      samplers: params.scheduler?.enum,
      steps: toRange(params.steps),
      cfg: toRange(params.CFGScale),
      maxReferenceImages:
        references && typeof references.maxItems === "number"
          ? references.maxItems
          : 0,
      supportsSeedImage: "seedImage" in inputProps,
      supportsMaskImage: "maskImage" in inputProps,
      outputFormatChoices: params.outputFormat?.enum,
      qualityChoices: vendorParam("quality")?.enum,
      backgroundChoices: vendorParam("background")?.enum,
    },
  };
}

export interface RunwareSchemaIndex {
  byAir: Record<string, ImageParams>;
  byArchitecture: Record<string, ImageParams>;
}

export async function fetchRunwareSchemas(): Promise<RunwareSchemaIndex | null> {
  const limit = pLimit(FETCH_CONCURRENCY);
  const index: RunwareSchemaIndex = { byAir: {}, byArchitecture: {} };

  const load = (slug: string, architecture: boolean) =>
    limit(async () => {
      const raw = await tryFetchJson<unknown>(SCHEMA_URL(slug));
      if (!raw) return { slug, ok: false };
      const spec = distill(raw);
      if (!spec) return { slug, ok: false };
      if (architecture) index.byArchitecture[slug] = spec.params;
      if (spec.air) index.byAir[spec.air] = spec.params;
      return { slug, ok: true };
    });

  const results = await Promise.all([
    ...ARCHITECTURES.map((s) => load(s, true)),
    ...MODEL_SLUGS.map((s) => load(s, false)),
  ]);

  // A missing architecture silently strips every control from its checkpoints.
  const missingArch = results.filter(
    (r) => !r.ok && ARCHITECTURES.includes(r.slug),
  );
  if (missingArch.length > 0) {
    consola.warn(
      `runware: ${missingArch.length} architecture schemas unavailable (${missingArch
        .map((r) => r.slug)
        .join(", ")}); image capabilities left unset for those lineages`,
    );
  }
  if (Object.keys(index.byArchitecture).length === 0) return null;
  return index;
}

// Undefined (no match) is distinct from a spec saying every control is off.
export function lookupImageParams(
  index: RunwareSchemaIndex,
  modelName: string,
  series: string | null | undefined,
): ImageParams | undefined {
  const air = MODEL_NAME_TO_AIR[modelName.trim().toLowerCase()];
  if (air && index.byAir[air]) return index.byAir[air];
  if (!series) return undefined;
  const key = series.trim().toLowerCase();
  const mapped = SERIES_TO_ARCHITECTURE[key] ?? key;
  const direct = index.byArchitecture[mapped] ?? index.byArchitecture[key];
  if (direct) return direct;
  // A variant ("pony_v7") takes its base architecture's parameters.
  const base = key.split(/[_-]/)[0];
  if (!base) return undefined;
  const baseSlug = SERIES_TO_ARCHITECTURE[base] ?? base;
  return index.byArchitecture[baseSlug];
}
