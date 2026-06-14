import type { RuntimeConfig } from "@core/config";
import type { ProviderResult } from "@core/pricing/offers";
import type { PricingSource } from "@core/pricing/resolver";
import type { SimpleFreeProviderConfig } from "@core/validations/config";
import {
  SIMPLE_PROVIDER_META,
  type SimpleProviderKind,
  type SimpleProviderMeta,
} from "./registry-meta";
import {
  processOpenAICompatibleFreeProvider,
  type OpenAIFreeDiscovery,
} from "./shared/openai-free-provider";
import { discoverGroqModels } from "./groq/discovery";
import { discoverGeminiModels } from "./gemini/discovery";
import { discoverCerebrasModels } from "./cerebras/discovery";
import { discoverSambaNovaModels } from "./sambanova/discovery";
import { discoverMistralModels } from "./mistral/discovery";
import { discoverCloudflareModels } from "./cloudflare/discovery";
import { discoverGithubModels } from "./github/discovery";
import { discoverZaiModels } from "./zai/discovery";
import { discoverOvhModels } from "./ovh/discovery";
import { discoverPollinationsModels } from "./pollinations/discovery";
import { discoverAiHordeModels } from "./aihorde/discovery";
import { discoverJinaModels } from "./jina/discovery";
import { discoverCohereModels } from "./cohere/discovery";
import { discoverHuggingFaceModels } from "./huggingface/discovery";
import { discoverSiliconFlowModels } from "./siliconflow/discovery";
import { discoverLlm7Models } from "./llm7/discovery";

type Discover = (
  baseUrl: string,
  apiKey: string,
) => Promise<OpenAIFreeDiscovery>;

// Discovery fn per simple provider kind. The ONLY place a new simple provider
// is wired beyond its discovery module + the registry-meta entry.
const DISCOVERERS: Record<SimpleProviderKind, Discover> = {
  groq: discoverGroqModels,
  gemini: discoverGeminiModels,
  cerebras: discoverCerebrasModels,
  sambanova: discoverSambaNovaModels,
  mistral: discoverMistralModels,
  cloudflare: discoverCloudflareModels,
  github: discoverGithubModels,
  zai: discoverZaiModels,
  ovh: discoverOvhModels,
  pollinations: discoverPollinationsModels,
  aihorde: discoverAiHordeModels,
  jina: discoverJinaModels,
  cohere: discoverCohereModels,
  huggingface: discoverHuggingFaceModels,
  siliconflow: discoverSiliconFlowModels,
  llm7: discoverLlm7Models,
};

export interface SimpleProviderDef extends SimpleProviderMeta {
  discover: Discover;
}

export const SIMPLE_PROVIDERS: SimpleProviderDef[] = SIMPLE_PROVIDER_META.map(
  (m) => ({ ...m, discover: DISCOVERERS[m.kind] }),
);

export const SIMPLE_PROVIDER_MAP: Record<string, SimpleProviderDef> =
  Object.fromEntries(SIMPLE_PROVIDERS.map((d) => [d.kind, d]));

interface Ctx {
  pricingSources: PricingSource[];
  reverseMapping: Map<string, string>;
}

export function processSimpleProvider(
  def: SimpleProviderDef,
  providerConfig: SimpleFreeProviderConfig,
  config: RuntimeConfig,
  ctx: Ctx,
): Promise<ProviderResult> {
  return processOpenAICompatibleFreeProvider({
    providerConfig,
    config,
    ctx,
    providerKind: def.kind,
    channelRemarkLabel: def.label,
    discover: def.discover,
    channelType: def.channelType,
    imageChannelType: def.imageChannelType,
    audioChannelType: def.audioChannelType,
    acceptRateLimited: def.acceptRateLimited,
  });
}
