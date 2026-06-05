import { fetchJson } from "@core/infra/http";
import { readJson, writeJsonAtomic } from "@core/infra/fs";
import { logsDir } from "@core/infra/paths";
import { t } from "@server/i18n";
import { consola } from "consola";
import { join } from "path";
import type { AuthenticityProbeLog } from "./types";

export const authenticityProbeAccumulator = new Map<
  string,
  AuthenticityProbeLog[]
>();

function addAuthenticityProbe(key: string, entry: AuthenticityProbeLog): void {
  const list = authenticityProbeAccumulator.get(key);
  if (list) list.push(entry);
  else authenticityProbeAccumulator.set(key, [entry]);
}

export function resetAuthenticityProbes(): void {
  authenticityProbeAccumulator.clear();
}

interface AuthenticityBlacklistEntry {
  since: string;
  reason: string;
}
interface PersistedBlacklist {
  rulesVersion?: number;
  entries: Record<string, AuthenticityBlacklistEntry>;
}

const AUTHENTICITY_RULES_VERSION = 1;
const AUTHENTICITY_BLACKLIST_FILE = "authenticity-blacklist.json";
const authenticityBlacklist = new Map<string, AuthenticityBlacklistEntry>();

const getAuthenticityBlacklistPath = () =>
  join(logsDir(), AUTHENTICITY_BLACKLIST_FILE);

export function loadAuthenticityBlacklist(): void {
  const raw = readJson<
    PersistedBlacklist | Record<string, AuthenticityBlacklistEntry>
  >(getAuthenticityBlacklistPath());
  if (!raw) return;
  const wrapped = "entries" in raw && typeof raw.entries === "object";
  if (wrapped) {
    const version = (raw as PersistedBlacklist).rulesVersion ?? 0;
    if (version < AUTHENTICITY_RULES_VERSION) return;
  }
  const entries = wrapped
    ? (raw as PersistedBlacklist).entries
    : (raw as Record<string, AuthenticityBlacklistEntry>);
  authenticityBlacklist.clear();
  for (const [key, val] of Object.entries(entries))
    authenticityBlacklist.set(key, val);
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

export const isAuthenticityBlacklisted = (key: string): boolean =>
  authenticityBlacklist.has(key);

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
const CODING_TOOL_NAMES = ["kiro", "cascade", "codeium"];
const SCAM_PAGE_PATTERNS = [
  "token被盗",
  "token被人盗刷",
  "本站token",
  "盗取token",
  "微信jemes",
];
// prettier-ignore
const FOREIGN_VENDOR_PATTERNS = ["deepmind","gemini","openai","chatgpt","gpt-3","gpt-4","gpt-5","o1-","o3-","o4-","deepseek","qwen","moonshot","kimi","mistral","llama","meta","grok","xai"];
// prettier-ignore
const CLOUD_HOST_PATTERNS = ["amazon","aws","bedrock","google","vertex","microsoft","azure","foundry"];
const FOREIGN_MODEL_NAME_FROM_CLOUD = ["amazon q", "q developer", "kiro"];
const FAKE_RESPONSE_SIGNATURES = ["claude sonnet (4.0)"];

const includesAny = (text: string, patterns: string[]) =>
  patterns.some((p) => text.includes(p));
const hasCodingToolRefusal = (text: string) =>
  includesAny(text, CODING_TOOL_NAMES) ||
  includesAny(text, CODING_TOOL_REFUSAL_PATTERNS);
const hasScamPage = (text: string) => includesAny(text, SCAM_PAGE_PATTERNS);

function hasForeignIdentity(
  text: string,
  probe: "identity" | "model-name",
): boolean {
  if (includesAny(text, FOREIGN_VENDOR_PATTERNS)) return true;
  if (
    probe === "model-name" &&
    includesAny(text, FOREIGN_MODEL_NAME_FROM_CLOUD)
  )
    return true;
  return false;
}

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
  muxFailure?: boolean;
};

function detectSignal(text: string, probeLabel: string): ProbeSignal {
  if (text.length === 0) return "blank";
  if (hasCodingToolRefusal(text)) return "coding-tool";
  if (hasScamPage(text)) return "scam";
  if (probeLabel === "identity" || probeLabel === "model-name") {
    if (hasForeignIdentity(text, probeLabel as "identity" | "model-name"))
      return "foreign";
    if (probeLabel === "identity" && includesAny(text, CLOUD_HOST_PATTERNS))
      return "cloud-host";
  }
  return null;
}

const NONCE_MISMATCH_RETRIES = 2;
const NONCE_MISMATCH_BACKOFF_MS = 500;

function makeNonce(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function runAnthropicProbe(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  buildPrompt: (nonce: string) => string;
  label: string;
  maxTokens: number;
  evaluate: (text: string) => boolean;
  timeoutMs: number;
  logKey: string;
}): Promise<ProbeResult> {
  const reqUrl = `${opts.baseUrl}/v1/messages`;
  const logFail = (reqBody: unknown, response: string | null, error: string) =>
    addAuthenticityProbe(opts.logKey, {
      probe: opts.label,
      pass: false,
      authenticityRefusal: false,
      request: { url: reqUrl, body: reqBody },
      response,
      error,
    });

  for (let attempt = 0; attempt <= NONCE_MISMATCH_RETRIES; attempt++) {
    if (attempt > 0)
      await new Promise((r) => setTimeout(r, NONCE_MISMATCH_BACKOFF_MS));
    const nonce = makeNonce();
    const reqBody = {
      model: opts.model,
      messages: [{ role: "user", content: opts.buildPrompt(nonce) }],
      max_tokens: opts.maxTokens,
    };

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
      logFail(reqBody, null, err instanceof Error ? err.message : String(err));
      return { pass: false, authenticityRefusal: false, signal: null };
    }

    const text = extractAnthropicText(data);
    if (text === null) {
      logFail(
        reqBody,
        null,
        t("CORE.TESTER.ERR_EXTRACT_TEXT", {
          preview: JSON.stringify(data).slice(0, 300),
        }),
      );
      return { pass: false, authenticityRefusal: false, signal: null };
    }

    if (!text.includes(nonce.toLowerCase())) {
      logFail(
        reqBody,
        text,
        `nonce_mismatch (attempt ${attempt + 1}/${NONCE_MISMATCH_RETRIES + 1}): expected "${nonce}"`,
      );
      continue;
    }

    const signal = detectSignal(text, opts.label);
    const refusal = signal === "coding-tool";
    const passed = opts.evaluate(text);
    addAuthenticityProbe(opts.logKey, {
      probe: opts.label,
      pass: passed,
      authenticityRefusal: refusal,
      request: { url: reqUrl, body: reqBody },
      response: text,
    });
    return { pass: passed, authenticityRefusal: refusal, signal };
  }

  return {
    pass: false,
    authenticityRefusal: false,
    signal: null,
    muxFailure: true,
  };
}

export async function testAnthropicAuthenticity(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  logKey: string;
}): Promise<boolean> {
  const nonceTag = (n: string) =>
    `Begin your reply with the tag [${n}] then a space, then your answer.`;

  const [r1, r2, r3, r4] = await Promise.all([
    runAnthropicProbe({
      ...opts,
      label: "emotional",
      maxTokens: 200,
      buildPrompt: (n) =>
        `Tell me a 2-sentence sad story about a lost kitten. ${nonceTag(n)}`,
      evaluate: (text) => !hasCodingToolRefusal(text) && text.length >= 40,
    }),
    runAnthropicProbe({
      ...opts,
      label: "creative",
      maxTokens: 120,
      buildPrompt: (n) =>
        `Write a haiku about the ocean at sunrise. ${nonceTag(n)}`,
      evaluate: (text) => !hasCodingToolRefusal(text) && text.length >= 25,
    }),
    runAnthropicProbe({
      ...opts,
      label: "identity",
      maxTokens: 60,
      buildPrompt: (n) =>
        "Which AI lab developed and trained the model you are running on? " +
        "Not the company hosting you, the lab that trained the model. " +
        `One word answer. ${nonceTag(n)}`,
      evaluate: (text) => {
        if (hasCodingToolRefusal(text) || hasScamPage(text)) return false;
        if (hasForeignIdentity(text, "identity")) return false;
        if (text.includes("anthropic")) return true;
        if (includesAny(text, CLOUD_HOST_PATTERNS)) return true;
        return false;
      },
    }),
    runAnthropicProbe({
      ...opts,
      label: "model-name",
      maxTokens: 80,
      buildPrompt: (n) =>
        `Which model are you? Reply with only your model name. ${nonceTag(n)}`,
      evaluate: (text) => {
        if (hasCodingToolRefusal(text) || hasScamPage(text)) return false;
        if (hasForeignIdentity(text, "model-name")) return false;
        if (!text.includes("claude") && !text.includes("anthropic"))
          return false;
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
  const labelsWithSignal = (sig: ProbeSignal) =>
    results
      .filter((r) => r.signal === sig)
      .map((r) => r.label)
      .join(", ");

  if (results.some((r) => r.signal === "coding-tool")) {
    const labels = labelsWithSignal("coding-tool");
    consola.warn(
      t("CORE.TESTER.AUTHENTICITY_REFUSAL", { model: opts.model, labels }),
    );
    addToAuthenticityBlacklist(opts.logKey, `coding-tool-refusal: ${labels}`);
    return false;
  }
  if (results.some((r) => r.signal === "scam")) {
    const labels = labelsWithSignal("scam");
    consola.warn(
      t("CORE.TESTER.AUTHENTICITY_SCAM", { model: opts.model, labels }),
    );
    addToAuthenticityBlacklist(opts.logKey, `scam-page: ${labels}`);
    return false;
  }

  const muxLabels = results.filter((r) => r.muxFailure).map((r) => r.label);
  if (muxLabels.length >= 2) {
    const labels = muxLabels.join(", ");
    consola.warn(
      t("CORE.TESTER.AUTH_MUX_FAILURE", {
        model: opts.model,
        count: muxLabels.length,
        labels,
      }),
    );
    addToAuthenticityBlacklist(
      opts.logKey,
      `unsafe-proxy: response-mixing on ${labels}`,
    );
    return false;
  }

  const r4ModelName = results.find((r) => r.label === "model-name");
  const foreignOnModelName = results.some(
    (r) => r.signal === "foreign" && r.label === "model-name",
  );
  if (foreignOnModelName && r4ModelName?.pass !== true) {
    const labels = labelsWithSignal("foreign");
    consola.warn(
      t("CORE.TESTER.AUTHENTICITY_FOREIGN", { model: opts.model, labels }),
    );
    addToAuthenticityBlacklist(opts.logKey, `foreign-identity: ${labels}`);
    return false;
  }

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
      if (blankCount === failed.length)
        reason = `blank-response: ${failedLabels}`;
      else if (muxCount > 0) {
        const muxFailedLabels = failed
          .filter((r) => r.muxFailure)
          .map((r) => r.label)
          .join(", ");
        reason = `unsafe-proxy: response-mixing on ${muxFailedLabels} (with ${failedLabels} failing)`;
      } else reason = `failed: ${failedLabels}`;
      addToAuthenticityBlacklist(opts.logKey, reason);
    }
  }

  return passing;
}
