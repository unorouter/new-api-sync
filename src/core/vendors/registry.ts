import type { RuntimeConfig } from "@core/config";
import type {
  ProviderResult,
  ProviderRunContext,
} from "@core/pricing/offers";
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
import { discoverOpenCodeZenModels } from "./opencodezen/discovery";
import { discoverLogfareModels } from "./logfare/discovery";
import { discoverNavyAiModels } from "./navyai/discovery";
import { discoverScalewayModels } from "./scaleway/discovery";
import { discoverFreeModelModels } from "./freemodel/discovery";
import { discoverCrowLlmModels } from "./crowllm/discovery";
import { discoverMegaNovaModels } from "./meganova/discovery";
import { discoverAionLabsModels } from "./aionlabs/discovery";
import { discoverIoNetModels } from "./ionet/discovery";
import { discoverAkashMlModels } from "./akashml/discovery";
import { discoverNscaleModels } from "./nscale/discovery";
import { discoverNagaModels } from "./naga/discovery";
import { discoverOllamaModels } from "./ollama/discovery";
import { discoverQiniuModels } from "./qiniu/discovery";
import { discoverStreamLakeModels } from "./streamlake/discovery";
import { discoverInternLmModels } from "./internlm/discovery";
import { discoverSenseNovaModels } from "./sensenova/discovery";
import { discoverInfercomModels } from "./infercom/discovery";
import { discoverMiniMaxModels } from "./minimax/discovery";
import { discoverVoidAiModels } from "./voidai/discovery";
import { discoverZanityModels } from "./zanity/discovery";
import { discoverKiloModels } from "./kilo/discovery";
import { discoverUncloseAiModels } from "./uncloseai/discovery";
import { discoverAiHubMixModels } from "./aihubmix/discovery";
import { discoverTokenReplyModels } from "./tokenreply/discovery";
import { discoverBazaarLinkModels } from "./bazaarlink/discovery";
import { discoverBlockRunModels } from "./blockrun/discovery";
import { discoverFreeAiModels } from "./freeai/discovery";
import { discoverBleakModels } from "./bleak/discovery";
import { discoverLongCatModels } from "./longcat/discovery";
import { discoverPublicAiModels } from "./publicai/discovery";

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
  opencodezen: discoverOpenCodeZenModels,
  logfare: discoverLogfareModels,
  navyai: discoverNavyAiModels,
  scaleway: discoverScalewayModels,
  freemodel: discoverFreeModelModels,
  crowllm: discoverCrowLlmModels,
  meganova: discoverMegaNovaModels,
  aionlabs: discoverAionLabsModels,
  ionet: discoverIoNetModels,
  akashml: discoverAkashMlModels,
  nscale: discoverNscaleModels,
  naga: discoverNagaModels,
  ollama: discoverOllamaModels,
  qiniu: discoverQiniuModels,
  streamlake: discoverStreamLakeModels,
  internlm: discoverInternLmModels,
  sensenova: discoverSenseNovaModels,
  infercom: discoverInfercomModels,
  minimax: discoverMiniMaxModels,
  voidai: discoverVoidAiModels,
  zanity: discoverZanityModels,
  kilo: discoverKiloModels,
  uncloseai: discoverUncloseAiModels,
  aihubmix: discoverAiHubMixModels,
  tokenreply: discoverTokenReplyModels,
  bazaarlink: discoverBazaarLinkModels,
  blockrun: discoverBlockRunModels,
  freeai: discoverFreeAiModels,
  bleak: discoverBleakModels,
  longcat: discoverLongCatModels,
  publicai: discoverPublicAiModels,
};

export interface SimpleProviderDef extends SimpleProviderMeta {
  discover: Discover;
}

export const SIMPLE_PROVIDERS: SimpleProviderDef[] = SIMPLE_PROVIDER_META.map(
  (m) => ({ ...m, discover: DISCOVERERS[m.kind] }),
);

export const SIMPLE_PROVIDER_MAP: Record<string, SimpleProviderDef> =
  Object.fromEntries(SIMPLE_PROVIDERS.map((d) => [d.kind, d]));

export function processSimpleProvider(
  def: SimpleProviderDef,
  providerConfig: SimpleFreeProviderConfig,
  config: RuntimeConfig,
  ctx: ProviderRunContext,
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
