import { fetchJson } from "@core/runtime/http";
import { t } from "@server/i18n";
import { consola } from "consola";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { KiroProbeLog } from "./types";

// ---------------------------------------------------------------------------
// Kiro probe accumulator (module-level state)
// ---------------------------------------------------------------------------

export const kiroProbeAccumulator = new Map<string, KiroProbeLog[]>();

export function addKiroProbe(key: string, entry: KiroProbeLog): void {
  if (!kiroProbeAccumulator.has(key)) kiroProbeAccumulator.set(key, []);
  kiroProbeAccumulator.get(key)!.push(entry);
}

// ---------------------------------------------------------------------------
// Kiro blacklist: persistent across runs, skips retesting known-fake providers
// ---------------------------------------------------------------------------

interface KiroBlacklistEntry {
  since: string;
  reason: string;
}

const KIRO_BLACKLIST_FILE = "kiro-blacklist.json";
const kiroBlacklist = new Map<string, KiroBlacklistEntry>();

function getKiroBlacklistPath(): string {
  return join(process.cwd(), "logs", KIRO_BLACKLIST_FILE);
}

export function loadKiroBlacklist(): void {
  const path = getKiroBlacklistPath();
  if (!existsSync(path)) return;
  try {
    const raw = readFileSync(path, "utf8");
    const entries = JSON.parse(raw) as Record<string, KiroBlacklistEntry>;
    kiroBlacklist.clear();
    for (const [key, val] of Object.entries(entries)) {
      kiroBlacklist.set(key, val);
    }
    consola.info(t("CORE.TESTER.KIRO_LOADED", { count: kiroBlacklist.size }));
  } catch {
    // Corrupted file, start fresh
  }
}

export function saveKiroBlacklist(): void {
  if (kiroBlacklist.size === 0) return;
  const logsDir = join(process.cwd(), "logs");
  mkdirSync(logsDir, { recursive: true });
  const obj: Record<string, KiroBlacklistEntry> = {};
  for (const [key, val] of kiroBlacklist) {
    obj[key] = val;
  }
  writeFileSync(getKiroBlacklistPath(), JSON.stringify(obj, null, 2));
}

function addToKiroBlacklist(key: string, reason: string): void {
  if (kiroBlacklist.has(key)) return;
  kiroBlacklist.set(key, {
    since: new Date().toISOString().slice(0, 10),
    reason,
  });
  consola.warn(t("CORE.TESTER.KIRO_ADDED", { key, reason }));
}

export function isKiroBlacklisted(key: string): boolean {
  return kiroBlacklist.has(key);
}

// ---------------------------------------------------------------------------
// Kiro model-substitution detection for Anthropic channels
// ---------------------------------------------------------------------------

const KIRO_REFUSAL_PATTERNS = [
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

function hasKiroRefusal(text: string): boolean {
  return (
    text.includes("kiro") ||
    text.includes("cascade") ||
    text.includes("codeium") ||
    KIRO_REFUSAL_PATTERNS.some((p) => text.includes(p))
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

type ProbeSignal = "kiro" | "scam" | "foreign" | "blank" | null;
type ProbeResult = {
  pass: boolean;
  kiroRefusal: boolean;
  signal: ProbeSignal;
};

function detectSignal(text: string): ProbeSignal {
  if (text.length === 0) return "blank";
  if (hasKiroRefusal(text)) return "kiro";
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
    addKiroProbe(opts.logKey, {
      probe: opts.label,
      pass: false,
      kiroRefusal: false,
      request: { url: reqUrl, body: reqBody },
      response: null,
      error: errMsg,
    });
    return { pass: false, kiroRefusal: false, signal: null };
  }

  const text = extractAnthropicText(data);
  if (text === null) {
    addKiroProbe(opts.logKey, {
      probe: opts.label,
      pass: false,
      kiroRefusal: false,
      request: { url: reqUrl, body: reqBody },
      response: null,
      error: t("CORE.TESTER.ERR_EXTRACT_TEXT", {
        preview: JSON.stringify(data).slice(0, 300),
      }),
    });
    return { pass: false, kiroRefusal: false, signal: null };
  }
  const signal = detectSignal(text);
  const refusal = signal === "kiro";
  const result = opts.evaluate(text);
  addKiroProbe(opts.logKey, {
    probe: opts.label,
    pass: result,
    kiroRefusal: refusal,
    request: { url: reqUrl, body: reqBody },
    response: text,
  });
  return { pass: result, kiroRefusal: refusal, signal };
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
        if (hasKiroRefusal(text)) return false;
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
        if (hasKiroRefusal(text)) return false;
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
        if (hasKiroRefusal(text)) return false;
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
        if (hasKiroRefusal(text)) return false;
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

  const kiroDetected = results.some((r) => r.signal === "kiro");
  if (kiroDetected) {
    const refusalLabels = results
      .filter((r) => r.signal === "kiro")
      .map((r) => r.label)
      .join(", ");
    consola.warn(
      t("CORE.TESTER.KIRO_REFUSAL", {
        model: opts.model,
        labels: refusalLabels,
      }),
    );
    addToKiroBlacklist(opts.logKey, `kiro-refusal: ${refusalLabels}`);
    return false;
  }

  const scamDetected = results.some((r) => r.signal === "scam");
  if (scamDetected) {
    const scamLabels = results
      .filter((r) => r.signal === "scam")
      .map((r) => r.label)
      .join(", ");
    consola.warn(
      t("CORE.TESTER.KIRO_SCAM", {
        model: opts.model,
        labels: scamLabels,
      }),
    );
    addToKiroBlacklist(opts.logKey, `scam-page: ${scamLabels}`);
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
      t("CORE.TESTER.KIRO_FOREIGN", {
        model: opts.model,
        labels: foreignLabels,
      }),
    );
    addToKiroBlacklist(opts.logKey, `foreign-identity: ${foreignLabels}`);
    return false;
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    const failedLabels = failed.map((r) => r.label).join(", ");
    const blankCount = failed.filter((r) => r.signal === "blank").length;
    const suffix = blankCount === failed.length ? " [blank-response]" : "";
    consola.warn(
      t("CORE.TESTER.KIRO_PROBES_RESULT", {
        model: opts.model,
        passed,
        failed: failedLabels,
        suffix,
      }),
    );
    addToKiroBlacklist(
      opts.logKey,
      blankCount === failed.length
        ? `blank-response: ${failedLabels}`
        : `failed: ${failedLabels}`,
    );
  }

  return passed >= 4;
}
