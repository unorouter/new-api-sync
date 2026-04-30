import { fetchJson } from "@core/runtime";
import { t } from "@server/i18n";
import { consola } from "consola";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { AuthenticityProbeLog } from "./types";

// ---------------------------------------------------------------------------
// Authenticity probe accumulator (module-level state)
// ---------------------------------------------------------------------------

export const authenticityProbeAccumulator = new Map<
  string,
  AuthenticityProbeLog[]
>();

export function addAuthenticityProbe(
  key: string,
  entry: AuthenticityProbeLog,
): void {
  if (!authenticityProbeAccumulator.has(key))
    authenticityProbeAccumulator.set(key, []);
  authenticityProbeAccumulator.get(key)!.push(entry);
}

// ---------------------------------------------------------------------------
// Authenticity blacklist: persistent across runs, skips retesting known-fake providers
// ---------------------------------------------------------------------------

interface AuthenticityBlacklistEntry {
  since: string;
  reason: string;
}

const AUTHENTICITY_BLACKLIST_FILE = "authenticity-blacklist.json";
const authenticityBlacklist = new Map<string, AuthenticityBlacklistEntry>();

function getAuthenticityBlacklistPath(): string {
  return join(process.cwd(), "logs", AUTHENTICITY_BLACKLIST_FILE);
}

export function loadAuthenticityBlacklist(): void {
  const path = getAuthenticityBlacklistPath();
  if (!existsSync(path)) return;
  try {
    const raw = readFileSync(path, "utf8");
    const entries = JSON.parse(raw) as Record<
      string,
      AuthenticityBlacklistEntry
    >;
    authenticityBlacklist.clear();
    for (const [key, val] of Object.entries(entries)) {
      authenticityBlacklist.set(key, val);
    }
    consola.info(
      t("CORE.TESTER.AUTHENTICITY_LOADED", {
        count: authenticityBlacklist.size,
      }),
    );
  } catch {
    // Corrupted file, start fresh
  }
}

export function saveAuthenticityBlacklist(): void {
  if (authenticityBlacklist.size === 0) return;
  const logsDir = join(process.cwd(), "logs");
  mkdirSync(logsDir, { recursive: true });
  const obj: Record<string, AuthenticityBlacklistEntry> = {};
  for (const [key, val] of authenticityBlacklist) {
    obj[key] = val;
  }
  writeFileSync(getAuthenticityBlacklistPath(), JSON.stringify(obj, null, 2));
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

// ---------------------------------------------------------------------------
// Coding-tool model-substitution detection for Anthropic channels
// ---------------------------------------------------------------------------

// These patterns mark text as a coding-tool persona refusing a non-coding
// task. Generic refusals like "I can't discuss that" or "I can't help with
// that" are NOT included — real Anthropic Claude uses those for various
// legitimate reasons (e.g. declining to disclose model name) and they
// would false-positive as kiro/codeium refusals. Keep patterns specific
// to coding-assistant personas: phrases that explicitly redirect the user
// to coding/development tasks.
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

// Hard foreign-vendor signals: these names mean the response is from a
// non-Anthropic *model* with no licensing relationship to Anthropic.
// Anything matching here on identity OR model-name probes is a real
// substitution and should blacklist immediately.
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

// Cloud-host signals: these names appear when Claude is legitimately
// served via AWS Bedrock, Google Vertex AI, or Azure AI Foundry. Real
// licensed Claude on those platforms often answers "amazon" / "google"
// / "microsoft" to the identity probe because of injected system
// prompts. Treat these as a soft signal: only fail when paired with a
// model-name probe that *also* says it's a foreign model (e.g.
// "i'm amazon q" — that's Kiro, an actual model substitution, not
// Bedrock-hosted Claude).
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

// "Amazon Q" is Kiro's coding-assistant model. If model-name comes back
// with "amazon q" (or similar AWS-coding-product names), that's a real
// substitution despite "amazon" also appearing in cloud-host names.
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

// Used by probe evaluators. The identity/model-name probes call this to
// decide if the response identifies as a non-Anthropic model. For
// model-name we also catch coding-product names that happen to share
// substrings with cloud hosts (Amazon Q / Kiro / Q Developer).
function hasForeignIdentity(
  text: string,
  probe: "identity" | "model-name",
): boolean {
  if (hasForeignVendor(text)) return true;
  if (probe === "model-name" && hasForeignModelFromCloud(text)) return true;
  return false;
}

// Known-fake response signatures observed in the wild. When multiple
// upstreams return identical, unusually-formatted model-name responses,
// it's a fingerprint of a shared substitution backend being resold by
// different resellers. Real Claude responses vary stylistically across
// providers; exact-string-match across providers means a single fake
// backend.
const FAKE_RESPONSE_SIGNATURES = [
  // Seen across yun/特价 Claude Code, yun/逆向, pol/Claude-code稳定,
  // pol/中转低价, v3/claude_kiro on opus channels. The unusual `(4.0)`
  // parenthesized format is the giveaway.
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
};

// Probe label is passed in so identity/model-name can apply different
// rules: identity treats cloud-host names as a soft signal (real Bedrock
// Claude often says "amazon"), model-name treats them as hard fails
// (real Claude on Bedrock still says "claude" when asked the model name;
// "amazon q" or similar means it's actually Kiro, not Claude).
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

async function runAnthropicProbe(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  label: string;
  maxTokens: number;
  evaluate: (text: string) => boolean;
  timeoutMs: number;
  logKey: string;
  /** Optional nonce expected to appear in the response. Used to guard
   *  against reseller proxies that mux concurrent /v1/messages calls and
   *  return responses in the wrong order. When set, a response missing
   *  the nonce fails closed. */
  nonce?: string;
}): Promise<ProbeResult> {
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
    return { pass: false, authenticityRefusal: false, signal: null };
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
    return { pass: false, authenticityRefusal: false, signal: null };
  }
  // Nonce mismatch = response was paired with a different prompt by a
  // reseller's response-mixing proxy. Fail closed but don't tag it as a
  // foreign/scam/refusal signal — that would penalise the wrong probe.
  if (opts.nonce && !text.includes(opts.nonce.toLowerCase())) {
    addAuthenticityProbe(opts.logKey, {
      probe: opts.label,
      pass: false,
      authenticityRefusal: false,
      request: { url: reqUrl, body: reqBody },
      response: text,
      error: `nonce_mismatch: expected "${opts.nonce}"`,
    });
    return { pass: false, authenticityRefusal: false, signal: null };
  }
  const signal = detectSignal(text, opts.label);
  const refusal = signal === "coding-tool";
  const result = opts.evaluate(text);
  addAuthenticityProbe(opts.logKey, {
    probe: opts.label,
    pass: result,
    authenticityRefusal: refusal,
    request: { url: reqUrl, body: reqBody },
    response: text,
  });
  return { pass: result, authenticityRefusal: refusal, signal };
}

function makeNonce(): string {
  return Math.random().toString(36).slice(2, 8);
}

export async function testAnthropicAuthenticity(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  logKey: string;
}): Promise<boolean> {
  // Probes run in parallel. Some reseller proxies mux concurrent requests
  // through a shared connection and return responses paired with the wrong
  // prompt. We guard against that by embedding a unique nonce in each
  // prompt and requiring it back in the response — a mismatched response
  // fails the probe cleanly without tagging it as a foreign/scam signal.
  const nonceEmotional = makeNonce();
  const nonceCreative = makeNonce();
  const nonceIdentity = makeNonce();
  const nonceModelName = makeNonce();

  const nonceTag = (n: string) =>
    `Begin your reply with the tag [${n}] then a space, then your answer.`;

  const [r1, r2, r3, r4] = await Promise.all([
    runAnthropicProbe({
      ...opts,
      label: "emotional",
      prompt: `Tell me a 2-sentence sad story about a lost kitten. ${nonceTag(nonceEmotional)}`,
      maxTokens: 200,
      nonce: nonceEmotional,
      evaluate: (text) => {
        if (hasCodingToolRefusal(text)) return false;
        return text.length >= 40;
      },
    }),
    runAnthropicProbe({
      ...opts,
      label: "creative",
      prompt: `Write a haiku about the ocean at sunrise. ${nonceTag(nonceCreative)}`,
      maxTokens: 120,
      nonce: nonceCreative,
      evaluate: (text) => {
        if (hasCodingToolRefusal(text)) return false;
        return text.length >= 25;
      },
    }),
    runAnthropicProbe({
      ...opts,
      label: "identity",
      prompt:
        "Which AI lab developed and trained the model you are running on? " +
        "Not the company hosting you, the lab that trained the model. " +
        `One word answer. ${nonceTag(nonceIdentity)}`,
      maxTokens: 60,
      nonce: nonceIdentity,
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
      prompt: `Which model are you? Reply with only your model name. ${nonceTag(nonceModelName)}`,
      maxTokens: 80,
      nonce: nonceModelName,
      evaluate: (text) => {
        if (hasCodingToolRefusal(text)) return false;
        if (hasScamPage(text)) return false;
        if (hasForeignIdentity(text, "model-name")) return false;
        if (!text.includes("claude") && !text.includes("anthropic")) return false;
        // Strip the nonce tag before checking fake-signature blocklist so a
        // tag prefix doesn't break exact-match.
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

  // Foreign identity is only a hard fail when the model-name probe
  // *also* claims a non-Anthropic identity. Real Claude served via AWS
  // Bedrock often answers "amazon" to "what company created you?" while
  // still correctly identifying as "claude" on the model-name probe;
  // similarly for Google Vertex AI hosting Claude. Those are routing
  // hosts, not fake models. Only flag as foreign when the model-name
  // probe itself says it's a foreign model (e.g. "i'm gemini", "i'm
  // amazon q") — that's an actual model substitution.
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

  // Pass with 3/4 probes when no positive signal triggered. The 4th probe
  // is allowed to be blank/short/transient-error without dooming the
  // channel — real upstreams occasionally return short responses or hit a
  // transient timeout, and one such hiccup shouldn't blacklist them
  // permanently. Positive signals (foreign-identity, scam, coding-tool)
  // are still hard failures and are caught above.
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
      addToAuthenticityBlacklist(
        opts.logKey,
        blankCount === failed.length
          ? `blank-response: ${failedLabels}`
          : `failed: ${failedLabels}`,
      );
    }
  }

  return passing;
}
