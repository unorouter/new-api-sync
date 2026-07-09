import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

// AINative Studio (api.ainative.studio/v1) - free 10M tok/mo, email signup no card. 84-model
// catalog but ~20 premium ids (gpt-4/o1/o3/claude/gemini/llama/mixtral/command-r/...) are ONE
// identity-confused Qwen3 backend (zh self-ID = Tongyi, size unknown) - never exposed. Only ids
// whose fingerprint (zh self-ID + cutoff + dated-event knowledge) matches the advertised name
// are wired. qwen-coder-* excluded (actually plain Qwen3.5, size unknown); nemotron-super-49b
// excluded (v1 vs v1.5 ambiguous). Hardcoded so a catalog change can't leak a fake id.
const HONEST = [
  "deepseek-v4-flash",
  "glm-4.7",
  "glm-5",
  "phi-4",
  "gpt-oss-120b",
  "gpt-oss-20b",
  "qwen3-8b",
  "qwen3-14b",
  "qwen3-32b",
  "mistral-large",
];

export async function discoverAiNativeModels(
  _baseUrl: string,
  _apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  consola.info(
    t("CORE.PROVIDER.DISCOVERY_FETCH", {
      label: "AINative",
      url: "(fingerprinted honest subset)",
    }),
  );
  return { models: HONEST, maxOutputByModel: new Map() };
}
