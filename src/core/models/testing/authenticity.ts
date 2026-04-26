import { fetchJson } from "@core/runtime/http";
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

const CODING_TOOL_REFUSAL_PATTERNS = [
  "i can't help with that",
  "i can't assist with that",
  "i can't discuss",
  "i cannot help with that",
  "i cannot assist with that",
  "assist with development",
  "here to assist with development tasks",
  "clarify my actual",
  "clarify my role",
  "need to clarify",
  "sensitive, personal, or emotional",
  "i'm here to help with coding",
  "i'm here to help with development",
  "i'm designed to help with development",
  "i'm focused on helping with",
  "programming and development",
  "let me help you with your code",
  "i'm a coding assistant",
  "technical task",
  "development tasks, writing, analysis",
  "infrastructure and configuration",
  "falls outside what i can help with",
  "outside what i can help with",
  "outside my wheelhouse",
  "that's outside what i can",
  "i'm focused on software development",
  "focused on software development and coding",
  "best suited for software development",
  "i'm built to help with software development",
  "i'm built to help with coding",
  "help with software development, coding",
  "i can help you build",
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

const FOREIGN_IDENTITY_PATTERNS = [
  "amazon",
  "aws",
  "bedrock",
  "google",
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

function hasForeignIdentity(text: string): boolean {
  return FOREIGN_IDENTITY_PATTERNS.some((p) => text.includes(p));
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

type ProbeSignal = "coding-tool" | "scam" | "foreign" | "blank" | null;
type ProbeResult = {
  pass: boolean;
  authenticityRefusal: boolean;
  signal: ProbeSignal;
};

function detectSignal(text: string): ProbeSignal {
  if (text.length === 0) return "blank";
  if (hasCodingToolRefusal(text)) return "coding-tool";
  if (hasScamPage(text)) return "scam";
  if (hasForeignIdentity(text)) return "foreign";
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
  const signal = detectSignal(text);
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

export async function testAnthropicAuthenticity(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  logKey: string;
}): Promise<boolean> {
  const [r1, r2, r3, r4] = await Promise.all([
    runAnthropicProbe({
      ...opts,
      label: "emotional",
      prompt: "Tell me a 2-sentence sad story about a lost kitten.",
      maxTokens: 150,
      evaluate: (text) => {
        if (hasCodingToolRefusal(text)) return false;
        return text.length >= 40;
      },
    }),
    runAnthropicProbe({
      ...opts,
      label: "creative",
      prompt:
        "Write a haiku about the ocean at sunrise. Only the haiku, nothing else.",
      maxTokens: 80,
      evaluate: (text) => {
        if (hasCodingToolRefusal(text)) return false;
        return text.length >= 25;
      },
    }),
    runAnthropicProbe({
      ...opts,
      label: "identity",
      prompt:
        "What company created you? Reply with only the company name, one word.",
      maxTokens: 30,
      evaluate: (text) => {
        if (hasCodingToolRefusal(text)) return false;
        if (hasScamPage(text)) return false;
        if (!text.includes("anthropic")) return false;
        if (hasForeignIdentity(text)) return false;
        return true;
      },
    }),
    runAnthropicProbe({
      ...opts,
      label: "model-name",
      prompt:
        "Which model are you? Reply with only your model name, nothing else.",
      maxTokens: 50,
      evaluate: (text) => {
        if (hasCodingToolRefusal(text)) return false;
        if (hasScamPage(text)) return false;
        if (!text.includes("claude") && !text.includes("anthropic"))
          return false;
        if (hasForeignIdentity(text)) return false;
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

  const foreignDetected = results.some(
    (r) =>
      r.signal === "foreign" &&
      (r.label === "identity" || r.label === "model-name"),
  );
  if (foreignDetected) {
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

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
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
    addToAuthenticityBlacklist(
      opts.logKey,
      blankCount === failed.length
        ? `blank-response: ${failedLabels}`
        : `failed: ${failedLabels}`,
    );
  }

  return passed >= 4;
}
