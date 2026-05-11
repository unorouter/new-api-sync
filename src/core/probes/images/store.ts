import type { TestExchange } from "@core/testing/types";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { join } from "path";

/**
 * Storage layer for `bun sync images`. One master JSON file plus per-attempt
 * raw artifacts. Atomic writes survive Ctrl-C mid-run.
 */

/**
 * Distinct wire shapes the probe can submit. Routed by the candidate's
 * `endpointTypes` rather than by model "kind" so a model that advertises
 * BOTH `image-generation` (text-to-image, JSON) AND `openai编辑图片`
 * (image-edit, multipart) gets a separate attempt per shape - the user
 * sees ground truth for each endpoint independently. Errors don't bill,
 * so the extra attempts are free.
 *
 * - sync-edits        -> POST /v1/images/edits        (multipart, 6 image refs)
 * - sync-generations  -> POST /v1/images/generations  (JSON, text-to-image)
 * - openai-vendor     -> POST /v1/chat/completions    (multimodal, 6 refs)
 * - task              -> POST /v1/videos              (submit + poll)
 */
export type ProbeShape =
  | "sync-edits"
  | "sync-generations"
  | "openai-vendor"
  | "task";

/**
 * High-level routing kind. Used in the master file as a quick filter
 * (sync vs openai-vendor vs task). Distinct attempts within a model are
 * differentiated by `ProbeShape` (per-endpoint).
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
  /** 5xx with body indicating no upstream channel is configured for this
   *  model (e.g. yun's "分组 X 下模型 Y 无可用渠道"). The gateway lists the
   *  model in pricing but has no backend wired up - common on resellers
   *  that copy upstream catalogs without provisioning every entry. */
  | "no_channel"
  | "unknown";

export interface ChannelResult {
  channelName: string;
  /** Reuses the same shape text-model tests write, so logs grep the same way. */
  exchange: TestExchange;
  errorClass?: ProbeErrorClass;
  artifactPath: string;
  /** Absolute paths of any generated images saved to disk. Empty when the
   *  probe response carried no extractable url/b64_json (or download
   *  failed). */
  imagePaths?: string[];
  /** Output dimensions (width x height) of each saved image, parallel to
   *  `imagePaths`. Captured at save time via image-magick `identify` so
   *  the master file carries the model's NATIVE output resolution
   *  without having to walk back to disk. Useful for spotting models
   *  that ignored our `size: 1024x1024` request and returned their
   *  native default (Doubao 2048², Grok 1168x784, etc.). */
  imageResolutions?: Array<{ w: number; h: number }>;
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
  /** Specific endpoint URL family that was hit. `sync-edits` and
   *  `sync-generations` both have probeKind=sync but address different
   *  upstream endpoints; this field disambiguates so the user can see at
   *  a glance which wire was tested. */
  probeShape?: ProbeShape;
  /** Group's pricing multiplier at probe time. Probes are ordered
   *  cheapest-first, so a `workingChannel.groupRatio` of 0.5 tells the
   *  user the model worked on the discounted tier. */
  groupRatio?: number;
  /** Did the request body actually carry the 6 reference fixtures?
   *  - `sync-edits` and `openai-vendor` always send refs (true).
   *  - `sync-generations` is text-to-image, no refs (false).
   *  - `task` always sends refs (true).
   *  Useful for filtering: a "passing" sync-generations probe with
   *  hasImageInputs=false produced an image but didn't actually test
   *  reference handling, so it's not a valid candidate for the
   *  6-character-compose workload even though it returned a URL. */
  hasImageInputs?: boolean;
  attemptedAt: string;
  taskId?: string;
}

export interface ModelResult {
  provider: string;
  model: string;
  kind: ProbeKind;
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
 * `gpt-image-1.5` should both produce safe directory names. Empty / all-
 * non-ascii inputs (some upstreams ship emoji-only group names) collapse
 * to `default` rather than a bare `_` so filenames stay readable.
 */
export function slug(s: string): string {
  const cleaned = s.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "default";
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
