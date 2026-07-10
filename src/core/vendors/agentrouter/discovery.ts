import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

// AgentRouter (agentrouter.org) - new-api fork, Claude-Code-only credit relay. $150
// one-time signup credit (no card, linux.do/Google OAuth). GOTCHAS:
//   1. anthropic native path ONLY - /v1/chat/completions is hard-blocked
//      ("unauthorized client detected"); only /v1/messages works. -> channelType 14.
//   2. UA-gated - needs a claude-cli User-Agent (the anthropic probe sends it; the
//      runtime channel needs a header_override, set in the DB post-sync).
// Fingerprinted authentic by VENDOR (the point that matters): opus-4-8/4-7 self-ID as
// Anthropic/Claude (no zh fake-relay leak), gpt-5.5 as OpenAI GPT-5, glm-5.2 as Zhipu.
// Versions may be inflated (cutoff probes put the opus lane at an early-2025 Claude) but
// the vendor is correct, so they join their real failover pools honestly. Free default
// group = these 4; every other catalog id is paid-group-gated. Static/hardcoded.
const FREE_MODELS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "glm-5.2",
  "gpt-5.5",
];

export async function discoverAgentRouterModels(
  _baseUrl: string,
  _apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  consola.info(
    t("CORE.PROVIDER.DISCOVERY_FETCH", {
      label: "AgentRouter",
      url: "(fixed free group)",
    }),
  );
  return { models: [...FREE_MODELS], maxOutputByModel: new Map() };
}
