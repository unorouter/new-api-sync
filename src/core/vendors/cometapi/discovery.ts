import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

// CometAPI (api.cometapi.com/v1) - unified relay, 606 models, $3 free signup credit (no card,
// PAYG after). Legit multi-provider relay routing to REAL upstreams (fingerprinted: claude-sonnet-5
// -> Anthropic/Bedrock, deepseek-v4-pro -> DeepSeek, grok-4.5 -> xAI). Curated frontier chat subset
// hardcoded (dated snapshots / effort-suffix dupes / media / opus-4-8 Bedrock-gated excluded).
// Names use dash form (claude-opus-4-6); modelMapping collapses to canonical dot form. $3 credit
// drains fast then 402-auto-disables -> burst fallback depth.
const MODELS = [
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "deepseek-r1",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-3-flash",
  "glm-4.7",
  "glm-5",
  "glm-5.1",
  "glm-5.2",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-5",
  "gpt-5-codex",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-5-pro",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.2-pro",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.4-pro",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.6",
  "gpt-oss-120b",
  "grok-4",
  "grok-4.3",
  "grok-4.5",
  "kimi-k2.5",
  "kimi-k2.6",
  "llama-4-maverick",
  "llama-4-scout",
  "minimax-m2",
  "minimax-m3",
  "o1",
  "o3",
  "o3-mini",
  "o3-pro",
  "o4-mini",
  "qwen3-max",
];

export async function discoverCometApiModels(
  _baseUrl: string,
  _apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  consola.info(
    t("CORE.PROVIDER.DISCOVERY_FETCH", {
      label: "CometAPI",
      url: "(curated frontier chat subset)",
    }),
  );
  return { models: MODELS, maxOutputByModel: new Map() };
}
