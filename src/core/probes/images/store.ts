import type { TestExchange } from "@core/testing/types";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * Storage layer for `bun sync images`. One master JSON file plus per-attempt
 * raw artifacts. Atomic writes survive Ctrl-C mid-run.
 */

export type ProbeKind = "sync" | "openai-vendor" | "task";

export type ProbeErrorClass =
  | "endpoint_404"
  | "ref_count_rejected"
  | "auth"
  | "ratelimit"
  | "timeout"
  | "refusal"
  | "task_failed"
  | "unknown";

export interface ChannelResult {
  channelId: number;
  channelName: string;
  /** Reuses the same shape text-model tests write, so logs grep the same way. */
  exchange: TestExchange;
  errorClass?: ProbeErrorClass;
  artifactPath: string;
  /** Absolute paths of any generated images saved to disk. Empty when the
   *  probe response carried no extractable url/b64_json (or download
   *  failed). */
  imagePaths?: string[];
  /** USD delta on the upstream account between submit and completion of
   *  THIS attempt (per-probe billing measured via two `/api/user/self`
   *  balance reads bracketing the probe). Absent if the upstream doesn't
   *  expose a quota balance. Note: passing probes ALWAYS bill; failing
   *  probes USUALLY don't but some upstreams charge for compute even on
   *  failure - this field surfaces the actual ground truth. */
  costUsd?: number;
  /** Which wire shape this attempt tested. A model with multiple
   *  endpoint_types (e.g. `["image-generation","dall-e-3"]`) gets one
   *  ChannelResult per kind so we capture how each shape behaves. */
  probeKind?: ProbeKind;
  attemptedAt: string;
  taskId?: string;
}

export interface ModelResult {
  provider: string;
  model: string;
  kind: ProbeKind;
  workingChannelId?: number;
  workingChannelName?: string;
  /** Full exchange (request/response/headers/status/latency) of the channel
   *  that decided this model: present when the model PASSED. Mirrors the
   *  shape recorded in `failedChannels[]` so the master file stands alone
   *  without having to open per-attempt artifacts on disk. */
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
    // Corrupted file — start fresh. The user can salvage the old file
    // from the .tmp sibling if they want.
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

/**
 * `true` when the (provider, model) pair is already in the results file.
 * To re-test a combo, the user manually deletes its entry from
 * `logs/images-results.json` and re-runs.
 */
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
  // Replace any prior entry for the same (provider, model) — defensive in
  // case a manual edit left a stale entry behind.
  const i = store.results.findIndex(
    (x) => x.provider === r.provider && x.model === r.model,
  );
  if (i >= 0) store.results[i] = r;
  else store.results.push(r);
}

/**
 * Slugify a string for use as a path component. `Qwen/Qwen-Image-Edit` and
 * `gpt-image-1.5` should both produce safe directory names.
 */
function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "_";
}

/** Resolve the per-(provider, model) artifact directory used for both the
 *  exchange JSON and the saved generated images. Exported so the
 *  download helper can reuse the same path scheme. */
export function artifactDirFor(provider: string, model: string): string {
  return join(ARTIFACT_DIR(), slug(provider), slug(model));
}

/**
 * Write a redacted exchange JSON to
 * `logs/images/<provider>/<model>/<timestamp>.json` and return its absolute
 * path. Caller is responsible for redacting auth tokens BEFORE calling this
 * (see redactExchange in shared util).
 */
export function writeArtifact(
  provider: string,
  model: string,
  channelId: number,
  exchange: TestExchange,
): string {
  const dir = join(ARTIFACT_DIR(), slug(provider), slug(model));
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${ts}-ch${channelId}.json`);
  writeFileSync(
    path,
    JSON.stringify(
      { provider, model, channelId, recordedAt: ts, exchange },
      null,
      2,
    ),
  );
  return path;
}

// ---------------------------------------------------------------------------
// Dry-run report
// ---------------------------------------------------------------------------

const DRY_RUN_PATH = () => join(process.cwd(), "logs", "images-dry-run.json");

export interface DryRunCandidate {
  model: string;
  /** Canonical key shared with all `aliases` (after slug-variant collapse). */
  canonicalKey: string;
  /** Other slugs on this provider that collapsed into this representative. */
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
