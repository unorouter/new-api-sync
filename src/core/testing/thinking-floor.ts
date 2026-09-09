import type { TestExchange } from "./types";

// Gemini 2.5 Pro cannot switch thinking off (budget floor 128), so even "Reply
// with only the word ok." carries hidden tokens: every genuine sample in the log
// history reports completion_tokens >= 12 (OpenAI shape, thoughts folded in) or
// thoughtsTokenCount >= 99 (native shape). A flash-class backend under the pro
// name answers with completion_tokens 1 (a7 3623, 2026-09-09).
const ALWAYS_THINKS = /^gemini-2\.5-pro/;
const MIN_COMPLETION_TOKENS = 10;

type Usage = {
  completion_tokens?: unknown;
  completion_tokens_details?: { reasoning_tokens?: unknown };
  thoughtsTokenCount?: unknown;
};

function usageOf(r: TestExchange): Usage | null {
  const data = r.response;
  if (!data || typeof data !== "object") return null;
  const u =
    (data as { usage?: unknown; usageMetadata?: unknown }).usage ??
    (data as { usageMetadata?: unknown }).usageMetadata;
  return u && typeof u === "object" ? (u as Usage) : null;
}

// Completion tokens of the reply when the model must have thought and did not;
// null when the model is not covered, usage is absent, or thinking is visible.
export function completionTokensWithoutThinking(
  model: string,
  r: TestExchange,
): number | null {
  if (!ALWAYS_THINKS.test(model)) return null;
  const u = usageOf(r);
  if (!u) return null;
  const reasoning = u.completion_tokens_details?.reasoning_tokens;
  if (typeof reasoning === "number" && reasoning > 0) return null;
  const thoughts = u.thoughtsTokenCount;
  if (typeof thoughts === "number" && thoughts > 0) return null;
  const out = u.completion_tokens;
  if (typeof out !== "number") return null;
  return out < MIN_COMPLETION_TOKENS ? out : null;
}
