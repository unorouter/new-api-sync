interface VendorMatcher {
  modelPatterns: string[];
  nameAliases?: string[];
  displayName?: string;
  icon?: string;
}

// prettier-ignore
export const VENDOR_MATCHERS: Record<string, VendorMatcher> = {
  anthropic: { modelPatterns: ["claude"], displayName: "Anthropic", icon: "Claude.Color" },
  google: { modelPatterns: ["gemini","palm","veo","gemma","lyria","imagen","embedding-001","embedding-gecko","text-embedding-004"], displayName: "Google", icon: "Gemini.Color" },
  openai: { modelPatterns: ["gpt","o1-","o3-","o4-","chatgpt","sora","text-embedding-3","text-embedding-ada"], displayName: "OpenAI", icon: "OpenAI" },
  kling: { modelPatterns: ["kling"], nameAliases: ["kling","可灵"], displayName: "Kling", icon: "Kling.Color" },
  deepseek: { modelPatterns: ["deepseek"], displayName: "DeepSeek", icon: "DeepSeek.Color" },
  xai: { modelPatterns: ["grok"], displayName: "xAI", icon: "XAI" },
  mistral: { modelPatterns: ["mistral","codestral"], displayName: "Mistral", icon: "Mistral.Color" },
  jina: { modelPatterns: ["jina-"], nameAliases: ["jina"], displayName: "Jina AI", icon: "Jina" },
  baai: { modelPatterns: ["bge-","bce-embedding","baai/"], nameAliases: ["baai","beijing academy"], displayName: "BAAI", icon: "BAAI" },
  baichuan: { modelPatterns: ["baichuan"], nameAliases: ["百川","baichuan"], displayName: "Baichuan", icon: "Baichuan.Color" },
  meta: { modelPatterns: ["llama"], displayName: "Meta", icon: "Meta.Color" },
  nvidia: { modelPatterns: ["nemotron"], displayName: "NVIDIA", icon: "Nvidia.Color" },
  liquid: { modelPatterns: ["lfm-"], nameAliases: ["liquid"], displayName: "Liquid", icon: "Liquid" },
  inclusionai: { modelPatterns: ["ling-"], nameAliases: ["inclusionai"], displayName: "InclusionAI" },
  nousresearch: { modelPatterns: ["hermes-"], nameAliases: ["nous","nousresearch"], displayName: "Nous Research", icon: "NousResearch" },
  venice: { modelPatterns: ["venice"], nameAliases: ["venice"], displayName: "Venice AI", icon: "Venice.Color" },
  alibaba: { modelPatterns: ["qwen","qwq-","text-embedding-v"], nameAliases: ["阿里","通义","qwen","阿里巴巴"], displayName: "Alibaba", icon: "AlibabaCloud.Color" },
  bailian: { modelPatterns: ["wan2","z-image"], nameAliases: ["bailian","阿里云百炼"], displayName: "Bailian", icon: "AlibabaCloud.Color" },
  flux: { modelPatterns: ["flux-","flux."], nameAliases: ["flux"], displayName: "Flux", icon: "Flux" },
  cohere: { modelPatterns: ["command-","c4ai-"], displayName: "Cohere", icon: "Cohere.Color" },
  minimax: { modelPatterns: ["abab","minimax-"], displayName: "MiniMax", icon: "Minimax.Color" },
  moonshot: { modelPatterns: ["moonshot-","kimi-"], nameAliases: ["月之暗面","kimi"], displayName: "Moonshot", icon: "Moonshot" },
  zhipu: { modelPatterns: ["glm-","glm4","glm5","glm6","chatglm"], nameAliases: ["智谱","zhipu ai","chatglm","z.ai","z-ai","zai"], displayName: "Zhipu", icon: "Zhipu.Color" },
  perplexity: { modelPatterns: ["sonar"], displayName: "Perplexity", icon: "Perplexity.Color" },
  baidu: { modelPatterns: ["ernie-","qianfan-","embedding-v1"], nameAliases: ["百度","文心"], displayName: "Baidu", icon: "Wenxin" },
  xunfei: { modelPatterns: ["sparkdesk"], nameAliases: ["讯飞","spark"], displayName: "Xunfei", icon: "Spark.Color" },
  tencent: { modelPatterns: ["hunyuan-","hy3-","hy4-"], nameAliases: ["腾讯","混元"], displayName: "Tencent", icon: "Hunyuan" },
  bytedance: { modelPatterns: ["doubao-"], nameAliases: ["字节","豆包","doubao"], displayName: "ByteDance", icon: "Doubao.Color" },
  stabilityai: { modelPatterns: ["stable-diffusion","stability"], nameAliases: ["stability ai","stabilityai"], displayName: "Stability AI", icon: "Stability" },
  yi: { modelPatterns: ["yi-"], displayName: "Yi", icon: "Yi.Color" },
  ai360: { modelPatterns: ["360gpt"], displayName: "360 AI", icon: "Ai360" },
  xiaomi: { modelPatterns: ["mimo-"], nameAliases: ["xiaomi","小米"], displayName: "Xiaomi", icon: "Xiaomi" },
  arcee: { modelPatterns: ["arcee","trinity","afm-","virtuoso-","maestro-","caller-","blitz","spotlight","coder-large"], nameAliases: ["arcee","arcee ai"], displayName: "Arcee AI", icon: "Arcee.Color" },
};

export function inferVendorFromModelName(name: string): string | undefined {
  const n = name.toLowerCase();
  for (const [vendor, matcher] of Object.entries(VENDOR_MATCHERS)) {
    if (matcher.modelPatterns.some((p) => n.includes(p) || n.startsWith(p)))
      return vendor;
  }
  return undefined;
}

export function forEachVendor(
  fn: (canonical: string, matcher: VendorMatcher) => void,
): void {
  for (const [canonical, matcher] of Object.entries(VENDOR_MATCHERS))
    fn(canonical, matcher);
}

export function findVendorByAlias<V extends { name: string }>(
  vendors: V[],
  canonical: string,
): V | undefined {
  const matcher = VENDOR_MATCHERS[canonical];
  const direct = vendors.find(
    (v) =>
      v.name.toLowerCase() === canonical ||
      v.name.toLowerCase() === matcher?.displayName?.toLowerCase(),
  );
  if (direct) return direct;
  for (const alias of matcher?.nameAliases ?? []) {
    const match = vendors.find((v) =>
      v.name.toLowerCase().includes(alias.toLowerCase()),
    );
    if (match) return match;
  }
  return undefined;
}
