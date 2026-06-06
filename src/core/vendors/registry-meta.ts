// Single source of truth for simple OpenAI-compatible free-tier providers.
// Zero runtime deps so the web bundle can import it. Adding a provider = one entry
// here + one discovery module wired in registry.ts.

export interface SimpleProviderMeta {
  kind: string;
  label: string;
  defaultBaseUrl: string;
  defaultRatio: number;
  apiKeyPlaceholder: string;
}

export const SIMPLE_PROVIDER_META = [
  {
    kind: "groq",
    label: "Groq",
    defaultBaseUrl: "https://api.groq.com/openai",
    defaultRatio: 0,
    apiKeyPlaceholder: "gsk_…",
  },
  {
    kind: "gemini",
    label: "Gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultRatio: 0,
    apiKeyPlaceholder: "AIza… / AQ.…",
  },
  {
    kind: "cerebras",
    label: "Cerebras",
    defaultBaseUrl: "https://api.cerebras.ai",
    defaultRatio: 0,
    apiKeyPlaceholder: "csk-…",
  },
  {
    kind: "sambanova",
    label: "SambaNova",
    defaultBaseUrl: "https://api.sambanova.ai",
    defaultRatio: 0,
    apiKeyPlaceholder: "uuid key",
  },
  {
    kind: "mistral",
    label: "Mistral",
    defaultBaseUrl: "https://api.mistral.ai",
    defaultRatio: 0,
    apiKeyPlaceholder: "mistral key",
  },
  {
    kind: "cloudflare",
    label: "Cloudflare",
    // Per-account: replace {account_id}. Base ends at "/ai" (no /v1); the runner
    // and new-api append /v1/chat/completions, discovery appends /models/search.
    defaultBaseUrl:
      "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai",
    defaultRatio: 0,
    apiKeyPlaceholder: "cf-... (Workers AI token)",
  },
  {
    kind: "github",
    label: "GitHub",
    // Base ends at "/inference"; discovery strips it and appends /catalog/models.
    defaultBaseUrl: "https://models.github.ai/inference",
    defaultRatio: 0,
    apiKeyPlaceholder: "github_pat_... (models:read)",
  },
] as const satisfies readonly SimpleProviderMeta[];

export type SimpleProviderKind = (typeof SIMPLE_PROVIDER_META)[number]["kind"];

export const SIMPLE_PROVIDER_META_MAP: Record<string, SimpleProviderMeta> =
  Object.fromEntries(SIMPLE_PROVIDER_META.map((m) => [m.kind, m]));
