import type { TestExchange } from "@core/testing/types";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { join } from "path";

// Storage for `bun sync images`: master JSON + per-attempt artifacts, atomic writes.

/**
 * Wire shapes routed by endpoint type (a model advertising both
 * `image-generation` and `image-edit` gets one attempt per shape):
 *   sync-edits        -> POST /v1/images/edits        (multipart, 6 refs)
 *   sync-generations  -> POST /v1/images/generations  (JSON, t2i)
 *   openai-vendor     -> POST /v1/chat/completions    (multimodal, 6 refs)
 *   task              -> POST /v1/videos              (submit + poll)
 */
export type ProbeShape =
  | "sync-edits"
  | "sync-generations"
  | "openai-vendor"
  | "task";

/** Master-file filter (per-attempt detail lives in ProbeShape). */
export type ProbeKind = "sync" | "openai-vendor" | "task";

export type ProbeErrorClass =
  | "endpoint_404"
  | "ref_count_rejected"
  | "auth"
  | "ratelimit"
  | "timeout"
  | "refusal"
  | "task_failed"
  /** 5xx body saying gateway has no backend wired up (e.g. yun's "无可用渠道"). */
  | "no_channel"
  | "unknown";

export interface ChannelResult {
  channelName: string;
  exchange: TestExchange;
  errorClass?: ProbeErrorClass;
  artifactPath: string;
  imagePaths?: string[];
  /** Native output dims — spots models that ignore our 1024x1024 (Doubao 2048², Grok 1168x784). */
  imageResolutions?: Array<{ w: number; h: number }>;
  /** Balance delta bracketing this attempt. Failing probes occasionally still bill. */
  costUsd?: number;
  probeKind?: ProbeKind;
  probeShape?: ProbeShape;
  groupRatio?: number;
  /** False only for sync-generations (text-to-image); useful for filtering 6-ref compose tests. */
  hasImageInputs?: boolean;
  attemptedAt: string;
  taskId?: string;
}

export interface ModelResult {
  provider: string;
  model: string;
  kind: ProbeKind;
  workingChannelName?: string;
  /** Inlined here so the master file stands alone (mirrors failedChannels[]). */
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

function ensureLogsDir(): void {
  mkdirSync(join(process.cwd(), "logs"), { recursive: true });
}

export function loadStore(): ProbeStore {
  ensureLogsDir();
  const path = RESULTS_PATH();
  if (!existsSync(path)) {
    return { version: 1, generatedAt: new Date().toISOString(), results: [] };
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as ProbeStore;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.results)) {
      return parsed;
    }
  } catch {
    // corrupt — start fresh (the .tmp sibling is still on disk)
  }
  return { version: 1, generatedAt: new Date().toISOString(), results: [] };
}

export function saveStore(store: ProbeStore): void {
  ensureLogsDir();
  const path = RESULTS_PATH();
  const tmp = path + ".tmp";
  store.generatedAt = new Date().toISOString();
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, path);
}

/** To re-test, delete the entry from logs/images-results.json and re-run. */
export function isAlreadyTested(
  store: ProbeStore,
  provider: string,
  model: string,
): boolean {
  return store.results.some(
    (r) => r.provider === provider && r.model === model,
  );
}

export function appendResult(store: ProbeStore, r: ModelResult): void {
  // Replace, not push — handles manual edits that left a stale entry.
  const i = store.results.findIndex(
    (x) => x.provider === r.provider && x.model === r.model,
  );
  if (i >= 0) store.results[i] = r;
  else store.results.push(r);
}

/** Empty / all-non-ascii inputs collapse to "default" (some upstreams ship emoji-only group names). */
export function slug(s: string): string {
  const cleaned = s.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "default";
}

export function artifactDirFor(provider: string, model: string): string {
  return join(ARTIFACT_DIR(), slug(provider), slug(model));
}

/** Caller must redactExchange() before calling this. */
export function writeArtifact(
  provider: string,
  model: string,
  channelLabel: string,
  probeShape: string,
  exchange: TestExchange,
): string {
  const dir = join(ARTIFACT_DIR(), slug(provider), slug(model));
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

// ─── Dry-run report ───────────────────────────────────────────────────────

const DRY_RUN_PATH = () => join(process.cwd(), "logs", "images-dry-run.json");

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
  const tmp = path + ".tmp";
  report.generatedAt = new Date().toISOString();
  writeFileSync(tmp, JSON.stringify(report, null, 2));
  renameSync(tmp, path);
  return path;
}
