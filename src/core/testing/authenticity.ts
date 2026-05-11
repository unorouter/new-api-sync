import { fetchJson } from "@core/infra/http";
import { readJson, writeJsonAtomic } from "@core/infra/fs";
import { logsDir } from "@core/infra/paths";
import { t } from "@server/i18n";
import { consola } from "consola";
import { join } from "path";
import type { AuthenticityProbeLog } from "./types";

// ─── Probe accumulator (module state) ──────────────────────────────────────

export const authenticityProbeAccumulator = new Map<
  string,
  AuthenticityProbeLog[]
>();

function addAuthenticityProbe(key: string, entry: AuthenticityProbeLog): void {
  if (!authenticityProbeAccumulator.has(key))
    authenticityProbeAccumulator.set(key, []);
  authenticityProbeAccumulator.get(key)!.push(entry);
}

// ─── Blacklist: persistent across runs ─────────────────────────────────────

interface AuthenticityBlacklistEntry {
  since: string;
  reason: string;
}

/** Bump to invalidate old verdicts. */
const AUTHENTICITY_RULES_VERSION = 1;

interface PersistedBlacklist {
  rulesVersion?: number;
  entries: Record<string, AuthenticityBlacklistEntry>;
}

const AUTHENTICITY_BLACKLIST_FILE = "authenticity-blacklist.json";
const authenticityBlacklist = new Map<string, AuthenticityBlacklistEntry>();

function getAuthenticityBlacklistPath(): string {
  return join(logsDir(), AUTHENTICITY_BLACKLIST_FILE);
}

export function loadAuthenticityBlacklist(): void {
  const raw = readJson<
    PersistedBlacklist | Record<string, AuthenticityBlacklistEntry>
  >(getAuthenticityBlacklistPath());
  if (!raw) return;
  // Legacy flat shape (Record<key, entry>) is treated as the current rules
  // version: it was created by code with the same checks. Drops only happen
  // when a future bump leaves a wrapped file behind with a lower version.
  const wrapped = "entries" in raw && typeof raw.entries === "object";
  if (wrapped) {
    const version = (raw as PersistedBlacklist).rulesVersion ?? 0;
    if (version < AUTHENTICITY_RULES_VERSION) {
      consola.info(
        `[authenticity] dropping blacklist (rules v${version} < v${AUTHENTICITY_RULES_VERSION})`,
      );
      return;
    }
  }
  const entries = wrapped
    ? (raw as PersistedBlacklist).entries
    : (raw as Record<string, AuthenticityBlacklistEntry>);
  authenticityBlacklist.clear();
  for (const [key, val] of Object.entries(entries)) {
    authenticityBlacklist.set(key, val);
  }
  consola.info(
    t("CORE.TESTER.AUTHENTICITY_LOADED", { count: authenticityBlacklist.size }),
  );
}

export function saveAuthenticityBlacklist(): void {
  if (authenticityBlacklist.size === 0) return;
  const entries: Record<string, AuthenticityBlacklistEntry> = {};
  for (const [key, val] of authenticityBlacklist) entries[key] = val;
  writeJsonAtomic(getAuthenticityBlacklistPath(), {
    rulesVersion: AUTHENTICITY_RULES_VERSION,
    entries,
  });
}

function addToAuthenticityBlacklist(key: string, reason: string): void {
  if (authenticityBlacklist.has(key)) return;
  authenticityBlacklist.set(key, {
    since: new Date().toISOString().slice(0, 10),
    reason,
  });
  consola.warn(t("CORE.TESTER.AUTHENTICITY_ADDED", { key, reason }));
}

export function isAuthenticityBlacklisted(key: string): boolean {
  return authenticityBlacklist.has(key);
}

// ─── Coding-tool substitution detection for Claude ─────────────────────────
// Only coding-assistant persona refusals; generic "I can't help" is excluded
// (real Claude legitimately uses it for model-name disclosure declines).
const CODING_TOOL_REFUSAL_PATTERNS = [
  "assist with development",
  "here to assist with development tasks",
  "sensitive, personal, or emotional",
  "i'm here to help with coding",
  "i'm here to help with development",
  "i'm designed to help with development",
  "let me help you with your code",
  "i'm a coding assistant",
  "development tasks, writing, analysis",
  "infrastructure and configuration",
  "falls outside what i can help with",
  "i'm focused on software development",
  "focused on software development and coding",
  "best suited for software development",
  "i'm built to help with software development",
  "i'm built to help with coding",
  "help with software development, coding",
  "what can i help you build",
  "got a tricky bug",
  "got a coding challenge",
  "got any code challenges",
  "i'm here to help with software",
  "i'm here for coding",
  "i'm droid",
  "development workflows, cli commands",
  "here to help with coding, development workflows",
];

function hasCodingToolRefusal(text: string): boolean {
  return (
    text.includes("kiro") ||
    text.includes("cascade") ||
    text.includes("codeium") ||
    CODING_TOOL_REFUSAL_PATTERNS.some((p) => text.includes(p))
  );
}

const SCAM_PAGE_PATTERNS = [
  "token被盗",
  "token被人盗刷",
  "本站token",
  "盗取token",
  "微信jemes",
];

function hasScamPage(text: string): boolean {
  return SCAM_PAGE_PATTERNS.some((p) => text.includes(p));
}

// Hard foreign-vendor signals: real substitution, blacklist immediately.
const FOREIGN_VENDOR_PATTERNS = [
  "deepmind",
  "gemini",
  "openai",
  "chatgpt",
  "gpt-3",
  "gpt-4",
  "gpt-5",
  "o1-",
  "o3-",
  "o4-",
  "deepseek",
  "qwen",
  "moonshot",
  "kimi",
  "mistral",
  "llama",
  "meta",
  "grok",
  "xai",
];

// Bedrock/Vertex/Foundry — real Claude there says "amazon"/"google" to
// identity due to system-prompt injection. Soft signal on identity only.
const CLOUD_HOST_PATTERNS = [
  "amazon",
  "aws",
  "bedrock",
  "google",
  "vertex",
  "microsoft",
  "azure",
  "foundry",
];

// AWS coding products (Amazon Q, Q Developer, Kiro) — real substitutions even though "amazon" is a cloud-host hit.
const FOREIGN_MODEL_NAME_FROM_CLOUD = ["amazon q", "q developer", "kiro"];

function hasForeignVendor(text: string): boolean {
  return FOREIGN_VENDOR_PATTERNS.some((p) => text.includes(p));
}

function hasCloudHost(text: string): boolean {
  return CLOUD_HOST_PATTERNS.some((p) => text.includes(p));
}

function hasForeignModelFromCloud(text: string): boolean {
  return FOREIGN_MODEL_NAME_FROM_CLOUD.some((p) => text.includes(p));
}

function hasForeignIdentity(
  text: string,
  probe: "identity" | "model-name",
): boolean {
  if (hasForeignVendor(text)) return true;
  if (probe === "model-name" && hasForeignModelFromCloud(text)) return true;
  return false;
}

// Cross-reseller identical responses = shared fake backend fingerprint.
const FAKE_RESPONSE_SIGNATURES = [
  // Seen on yun, pol, v3 opus channels; the `(4.0)` format is the tell.
  "claude sonnet (4.0)",
];

type AnthropicResponse = {
  type?: string;
  content?: Array<{ type?: string; text?: string }>;
};

function extractAnthropicText(data: unknown): string | null {
  const d = data as AnthropicResponse;
  if (d.type === "error") return null;
  return (d.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join(" ")
    .toLowerCase();
}

type ProbeSignal =
  | "coding-tool"
  | "scam"
  | "foreign"
  | "cloud-host"
  | "blank"
  | null;
type ProbeResult = {
  pass: boolean;
  authenticityRefusal: boolean;
  signal: ProbeSignal;
  /** Every retry returned a wrong-nonce response — unsafe-proxy mux signal. */
  muxFailure?: boolean;
};

// identity = soft on cloud-host (Bedrock Claude says "amazon"); model-name = hard.
function detectSignal(text: string, probeLabel: string): ProbeSignal {
  if (text.length === 0) return "blank";
  if (hasCodingToolRefusal(text)) return "coding-tool";
  if (hasScamPage(text)) return "scam";
  if (probeLabel === "identity" || probeLabel === "model-name") {
    if (hasForeignIdentity(text, probeLabel as "identity" | "model-name"))
      return "foreign";
    if (probeLabel === "identity" && hasCloudHost(text)) return "cloud-host";
  }
  return null;
}

/** Mux-mitigation: cheap proxies pair responses with wrong prompts under parallel load. Sequential retry with fresh nonce usually succeeds. */
const NONCE_MISMATCH_RETRIES = 2;
const NONCE_MISMATCH_BACKOFF_MS = 500;

async function runProbeAttempt(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  label: string;
  maxTokens: number;
  timeoutMs: number;
  logKey: string;
  nonce?: string;
}): Promise<
  | { kind: "ok"; text: string; reqUrl: string; reqBody: unknown }
  | { kind: "fail"; result: ProbeResult }
  | { kind: "nonce-mismatch"; text: string; reqUrl: string; reqBody: unknown }
> {
  const reqBody = {
    model: opts.model,
    messages: [{ role: "user", content: opts.prompt }],
    max_tokens: opts.maxTokens,
  };
  const reqUrl = `${opts.baseUrl}/v1/messages`;

  let data: unknown;
  try {
    data = await fetchJson<unknown>(reqUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": opts.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: reqBody,
      timeoutMs: opts.timeoutMs,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    addAuthenticityProbe(opts.logKey, {
      probe: opts.label,
      pass: false,
      authenticityRefusal: false,
      request: { url: reqUrl, body: reqBody },
      response: null,
      error: errMsg,
    });
    return {
      kind: "fail",
      result: { pass: false, authenticityRefusal: false, signal: null },
    };
  }

  const text = extractAnthropicText(data);
  if (text === null) {
    addAuthenticityProbe(opts.logKey, {
      probe: opts.label,
      pass: false,
      authenticityRefusal: false,
      request: { url: reqUrl, body: reqBody },
      response: null,
      error: t("CORE.TESTER.ERR_EXTRACT_TEXT", {
        preview: JSON.stringify(data).slice(0, 300),
      }),
    });
    return {
      kind: "fail",
      result: { pass: false, authenticityRefusal: false, signal: null },
    };
  }

  if (opts.nonce && !text.includes(opts.nonce.toLowerCase())) {
    return { kind: "nonce-mismatch", text, reqUrl, reqBody };
  }
  return { kind: "ok", text, reqUrl, reqBody };
}

async function runAnthropicProbe(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Build the prompt for a given nonce. Called once per attempt so retries
   *  use a fresh nonce — reusing the original would risk false-pass against
   *  a stale in-flight response that finally arrives with the right tag. */
  buildPrompt: (nonce: string) => string;
  label: string;
  maxTokens: number;
  evaluate: (text: string) => boolean;
  timeoutMs: number;
  logKey: string;
}): Promise<ProbeResult> {
  let lastMismatch:
    | { text: string; nonce: string; reqUrl: string; reqBody: unknown }
    | undefined;

  // Total attempts = 1 + NONCE_MISMATCH_RETRIES. Only the nonce-mismatch
  // path retries; any other failure (HTTP error, body parse) returns
  // immediately and is logged by runProbeAttempt.
  for (let attempt = 0; attempt <= NONCE_MISMATCH_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, NONCE_MISMATCH_BACKOFF_MS));
    }
    const nonce = makeNonce();
    const prompt = opts.buildPrompt(nonce);
    const result = await runProbeAttempt({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: opts.model,
      prompt,
      label: opts.label,
      maxTokens: opts.maxTokens,
      timeoutMs: opts.timeoutMs,
      logKey: opts.logKey,
      nonce,
    });

    if (result.kind === "fail") return result.result;

    if (result.kind === "nonce-mismatch") {
      // Log every attempt so the trace shows the full retry sequence.
      addAuthenticityProbe(opts.logKey, {
        probe: opts.label,
        pass: false,
        authenticityRefusal: false,
        request: { url: result.reqUrl, body: result.reqBody },
        response: result.text,
        error: `nonce_mismatch (attempt ${attempt + 1}/${NONCE_MISMATCH_RETRIES + 1}): expected "${nonce}"`,
      });
      lastMismatch = {
        text: result.text,
        nonce,
        reqUrl: result.reqUrl,
        reqBody: result.reqBody,
      };
      continue;
    }

    const text = result.text;
    const signal = detectSignal(text, opts.label);
    const refusal = signal === "coding-tool";
    const passed = opts.evaluate(text);
    addAuthenticityProbe(opts.logKey, {
      probe: opts.label,
      pass: passed,
      authenticityRefusal: refusal,
      request: { url: result.reqUrl, body: result.reqBody },
      response: text,
    });
    return { pass: passed, authenticityRefusal: refusal, signal };
  }

  // Every attempt mismatched: response-mixing proxy. Not substitution, but unsafe under parallel load.
  void lastMismatch;
  return {
    pass: false,
    authenticityRefusal: false,
    signal: null,
    muxFailure: true,
  };
}

function makeNonce(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function testAnthropicAuthenticity(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  logKey: string;
}): Promise<boolean> {
  // Per-probe nonce guards against response-mixing proxies under parallel load.
  const nonceTag = (n: string) =>
    `Begin your reply with the tag [${n}] then a space, then your answer.`;

  const [r1, r2, r3, r4] = await Promise.all([
    runAnthropicProbe({
      ...opts,
      label: "emotional",
      buildPrompt: (n) =>
        `Tell me a 2-sentence sad story about a lost kitten. ${nonceTag(n)}`,
      maxTokens: 200,
      evaluate: (text) => {
        if (hasCodingToolRefusal(text)) return false;
        return text.length >= 40;
      },
    }),
    runAnthropicProbe({
      ...opts,
      label: "creative",
      buildPrompt: (n) =>
        `Write a haiku about the ocean at sunrise. ${nonceTag(n)}`,
      maxTokens: 120,
      evaluate: (text) => {
        if (hasCodingToolRefusal(text)) return false;
        return text.length >= 25;
      },
    }),
    runAnthropicProbe({
      ...opts,
      label: "identity",
      buildPrompt: (n) =>
        "Which AI lab developed and trained the model you are running on? " +
        "Not the company hosting you, the lab that trained the model. " +
        `One word answer. ${nonceTag(n)}`,
      maxTokens: 60,
      evaluate: (text) => {
        if (hasCodingToolRefusal(text)) return false;
        if (hasScamPage(text)) return false;
        if (hasForeignIdentity(text, "identity")) return false;
        if (text.includes("anthropic")) return true;
        if (hasCloudHost(text)) return true;
        return false;
      },
    }),
    runAnthropicProbe({
      ...opts,
      label: "model-name",
      buildPrompt: (n) =>
        `Which model are you? Reply with only your model name. ${nonceTag(n)}`,
      maxTokens: 80,
      evaluate: (text) => {
        if (hasCodingToolRefusal(text)) return false;
        if (hasScamPage(text)) return false;
        if (hasForeignIdentity(text, "model-name")) return false;
        if (!text.includes("claude") && !text.includes("anthropic"))
          return false;
        // Strip nonce prefix so exact-match works on the blocklist.
        const stripped = text.replace(/^\s*\[[a-z0-9]{4,8}\]\s*/i, "").trim();
        if (FAKE_RESPONSE_SIGNATURES.includes(stripped)) return false;
        return true;
      },
    }),
  ]);

  const results = [
    { ...r1, label: "emotional" },
    { ...r2, label: "creative" },
    { ...r3, label: "identity" },
    { ...r4, label: "model-name" },
  ];

  const codingToolDetected = results.some((r) => r.signal === "coding-tool");
  if (codingToolDetected) {
    const refusalLabels = results
      .filter((r) => r.signal === "coding-tool")
      .map((r) => r.label)
      .join(", ");
    consola.warn(
      t("CORE.TESTER.AUTHENTICITY_REFUSAL", {
        model: opts.model,
        labels: refusalLabels,
      }),
    );
    addToAuthenticityBlacklist(
      opts.logKey,
      `coding-tool-refusal: ${refusalLabels}`,
    );
    return false;
  }

  const scamDetected = results.some((r) => r.signal === "scam");
  if (scamDetected) {
    const scamLabels = results
      .filter((r) => r.signal === "scam")
      .map((r) => r.label)
      .join(", ");
    consola.warn(
      t("CORE.TESTER.AUTHENTICITY_SCAM", {
        model: opts.model,
        labels: scamLabels,
      }),
    );
    addToAuthenticityBlacklist(opts.logKey, `scam-page: ${scamLabels}`);
    return false;
  }

  // ≥2 mux failures = unsafe proxy (not substitution, but a correctness/privacy bug).
  const muxLabels = results.filter((r) => r.muxFailure).map((r) => r.label);
  if (muxLabels.length >= 2) {
    consola.warn(
      t("CORE.TESTER.AUTH_MUX_FAILURE", {
        model: opts.model,
        count: muxLabels.length,
        labels: muxLabels.join(", "),
      }),
    );
    addToAuthenticityBlacklist(
      opts.logKey,
      `unsafe-proxy: response-mixing on ${muxLabels.join(", ")}`,
    );
    return false;
  }

  // Hard-foreign only when model-name probe ALSO claims a foreign identity. Bedrock-hosted Claude says "amazon" on identity but "claude" on model-name.
  const r4ModelName = results.find((r) => r.label === "model-name");
  const modelNameSaysClaude = r4ModelName?.pass === true;
  const foreignOnModelName = results.some(
    (r) => r.signal === "foreign" && r.label === "model-name",
  );
  const hardForeign = foreignOnModelName && !modelNameSaysClaude;
  if (hardForeign) {
    const foreignLabels = results
      .filter((r) => r.signal === "foreign")
      .map((r) => r.label)
      .join(", ");
    consola.warn(
      t("CORE.TESTER.AUTHENTICITY_FOREIGN", {
        model: opts.model,
        labels: foreignLabels,
      }),
    );
    addToAuthenticityBlacklist(
      opts.logKey,
      `foreign-identity: ${foreignLabels}`,
    );
    return false;
  }

  // 3/4 pass tolerated — one transient blank/short response shouldn't blacklist permanently.
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  const passing = passed >= 3;
  if (failed.length > 0) {
    const failedLabels = failed.map((r) => r.label).join(", ");
    const blankCount = failed.filter((r) => r.signal === "blank").length;
    const suffix = blankCount === failed.length ? " [blank-response]" : "";
    consola.warn(
      t("CORE.TESTER.AUTHENTICITY_PROBES_RESULT", {
        model: opts.model,
        passed,
        failed: failedLabels,
        suffix,
      }),
    );
    if (!passing) {
      const muxCount = failed.filter((r) => r.muxFailure).length;
      let reason: string;
      if (blankCount === failed.length) {
        reason = `blank-response: ${failedLabels}`;
      } else if (muxCount > 0) {
        // Even one mux probe is enough to distinguish upstream defect from model substitution.
        const muxFailedLabels = failed
          .filter((r) => r.muxFailure)
          .map((r) => r.label)
          .join(", ");
        reason = `unsafe-proxy: response-mixing on ${muxFailedLabels} (with ${failedLabels} failing)`;
      } else {
        reason = `failed: ${failedLabels}`;
      }
      addToAuthenticityBlacklist(opts.logKey, reason);
    }
  }

  return passing;
}
