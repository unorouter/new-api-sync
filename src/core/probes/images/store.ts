import type { TestExchange } from "@core/testing/types";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { join } from "path";

export type ProbeShape =
  | "sync-edits"
  | "sync-generations"
  | "openai-vendor"
  | "task";
export type ProbeKind = "sync" | "openai-vendor" | "task";

// prettier-ignore
export type ProbeErrorClass = "endpoint_404" | "ref_count_rejected" | "auth" | "ratelimit" | "timeout" | "refusal" | "task_failed" | "no_channel" | "unknown";

export interface ChannelResult {
  channelName: string;
  exchange: TestExchange;
  errorClass?: ProbeErrorClass;
  artifactPath: string;
  imagePaths?: string[];
  imageResolutions?: Array<{ w: number; h: number }>;
  costUsd?: number;
  probeKind?: ProbeKind;
  probeShape?: ProbeShape;
  groupRatio?: number;
  hasImageInputs?: boolean;
  attemptedAt: string;
  taskId?: string;
}

export interface ModelResult {
  provider: string;
  model: string;
  kind: ProbeKind;
  workingChannelName?: string;
  workingChannel?: ChannelResult;
  failedChannels: ChannelResult[];
  decidedAt: string;
}

export interface ProbeStore {
  version: 1;
  generatedAt: string;
  results: ModelResult[];
}

const RESULTS_PATH = () => join(process.cwd(), "logs", "images-results.json");
const ARTIFACT_DIR = () => join(process.cwd(), "logs", "images");
const DRY_RUN_PATH = () => join(process.cwd(), "logs", "images-dry-run.json");

const ensureLogsDir = () =>
  mkdirSync(join(process.cwd(), "logs"), { recursive: true });

const writeAtomic = (path: string, content: string): void => {
  const tmp = path + ".tmp";
  writeFileSync(tmp, content);
  renameSync(tmp, path);
};

export function loadStore(): ProbeStore {
  ensureLogsDir();
  const path = RESULTS_PATH();
  if (!existsSync(path))
    return { version: 1, generatedAt: new Date().toISOString(), results: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ProbeStore;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.results))
      return parsed;
  } catch {
    /* corrupt */
  }
  return { version: 1, generatedAt: new Date().toISOString(), results: [] };
}

export function saveStore(store: ProbeStore): void {
  ensureLogsDir();
  store.generatedAt = new Date().toISOString();
  writeAtomic(RESULTS_PATH(), JSON.stringify(store, null, 2));
}

export const isAlreadyTested = (
  store: ProbeStore,
  provider: string,
  model: string,
): boolean =>
  store.results.some((r) => r.provider === provider && r.model === model);

export function appendResult(store: ProbeStore, r: ModelResult): void {
  const i = store.results.findIndex(
    (x) => x.provider === r.provider && x.model === r.model,
  );
  if (i >= 0) store.results[i] = r;
  else store.results.push(r);
}

export function slug(s: string): string {
  const cleaned = s.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "default";
}

export const artifactDirFor = (provider: string, model: string): string =>
  join(ARTIFACT_DIR(), slug(provider), slug(model));

export function writeArtifact(
  provider: string,
  model: string,
  channelLabel: string,
  probeShape: string,
  exchange: TestExchange,
): string {
  const dir = artifactDirFor(provider, model);
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${ts}-${slug(channelLabel)}-${probeShape}.json`);
  writeFileSync(
    path,
    JSON.stringify(
      {
        provider,
        model,
        channel: channelLabel,
        probeShape,
        recordedAt: ts,
        exchange,
      },
      null,
      2,
    ),
  );
  return path;
}

export interface DryRunCandidate {
  model: string;
  canonicalKey: string;
  aliases?: string[];
  kind: ProbeKind;
  endpointTypes: string[];
  tags?: string[];
  vendorId?: number;
  channels: Array<{
    id: number;
    name: string;
    priority: number;
    weight: number;
  }>;
  reasons: string[];
}

export interface DryRunProvider {
  name: string;
  baseUrl: string;
  totalModels: number;
  totalChannels: number;
  candidates: DryRunCandidate[];
  excluded: Array<{ model: string; reason: string }>;
}

export interface DryRunReport {
  version: 1;
  generatedAt: string;
  providers: DryRunProvider[];
  summary: {
    totalCandidates: number;
    byKind: Record<ProbeKind, number>;
    estimatedMaxCost: number;
    alreadyDecided: number;
  };
}

export function saveDryRun(report: DryRunReport): string {
  ensureLogsDir();
  const path = DRY_RUN_PATH();
  report.generatedAt = new Date().toISOString();
  writeAtomic(path, JSON.stringify(report, null, 2));
  return path;
}
