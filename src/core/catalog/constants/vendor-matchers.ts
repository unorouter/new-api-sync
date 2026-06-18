interface VendorMatcher {
  modelPatterns: string[];
  nameAliases?: string[];
  displayName?: string;
  icon?: string;
  // Unambiguous brand markers (e.g. "nemotron", "sea-lion") that identify the real
  // vendor even when a base-model prefix ("llama", "gemma") would otherwise win.
  strongPatterns?: string[];
}

// prettier-ignore
export const VENDOR_MATCHERS: Record<string, VendorMatcher> = {
  anthropic: { modelPatterns: ["claude"], displayName: "Anthropic", icon: "Claude.Color" },
  google: { modelPatterns: ["gemini","palm","veo","gemma","lyria","imagen","embedding-001","embedding-gecko","text-embedding-004"], displayName: "Google", icon: "Gemini.Color" },
  openai: { modelPatterns: ["gpt","o1-","o3","o4-","chatgpt","sora","text-embedding-3","text-embedding-ada","whisper","openai"], displayName: "OpenAI", icon: "OpenAI" },
  kling: { modelPatterns: ["kling"], nameAliases: ["kling","可灵"], displayName: "Kling", icon: "Kling.Color" },
  deepseek: { modelPatterns: ["deepseek"], displayName: "DeepSeek", icon: "DeepSeek.Color" },
  xai: { modelPatterns: ["grok"], displayName: "xAI", icon: "XAI" },
  mistral: { modelPatterns: ["mistral","codestral","devstral","magistral","ministral","voxtral","pixtral"], displayName: "Mistral", icon: "Mistral.Color" },
  jina: { modelPatterns: ["jina-"], nameAliases: ["jina"], displayName: "Jina AI", icon: "Jina" },
  baai: { modelPatterns: ["bge-","bce-embedding","baai/"], nameAliases: ["baai","beijing academy"], displayName: "BAAI", icon: "BAAI" },
  baichuan: { modelPatterns: ["baichuan"], nameAliases: ["百川","baichuan"], displayName: "Baichuan", icon: "Baichuan.Color" },
  meta: { modelPatterns: ["llama"], displayName: "Meta", icon: "Meta.Color" },
  nvidia: { modelPatterns: ["nemotron"], strongPatterns: ["nemotron"], displayName: "NVIDIA", icon: "Nvidia.Color" },
  liquid: { modelPatterns: ["lfm-"], nameAliases: ["liquid"], displayName: "Liquid", icon: "Liquid" },
  inclusionai: { modelPatterns: ["ling-"], nameAliases: ["inclusionai"], displayName: "InclusionAI" },
  nousresearch: { modelPatterns: ["hermes-"], nameAliases: ["nous","nousresearch"], displayName: "Nous Research", icon: "NousResearch" },
  venice: { modelPatterns: ["venice"], nameAliases: ["venice"], displayName: "Venice AI", icon: "Venice.Color" },
  alibaba: { modelPatterns: ["qwen","qwq-","text-embedding-v"], nameAliases: ["阿里","通义","qwen","阿里巴巴"], displayName: "Alibaba", icon: "AlibabaCloud.Color" },
  bailian: { modelPatterns: ["wan2","z-image"], nameAliases: ["bailian","阿里云百炼"], displayName: "Bailian", icon: "AlibabaCloud.Color" },
  flux: { modelPatterns: ["flux-","flux.","flux"], nameAliases: ["flux"], displayName: "Flux", icon: "Flux" },
  cohere: { modelPatterns: ["command-","c4ai-","cohere","aya-","tiny-aya","north-mini","embed-english-","embed-multilingual-","embed-v4"], displayName: "Cohere", icon: "Cohere.Color" },
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
  groq: { modelPatterns: ["compound"], nameAliases: ["groq"], displayName: "Groq", icon: "Groq" },
  sdaia: { modelPatterns: ["allam"], nameAliases: ["sdaia","allam"], displayName: "SDAIA", icon: "SDAIA" },
  ibm: { modelPatterns: ["granite-"], nameAliases: ["ibm","ibm-granite"], displayName: "IBM" },
  microsoft: { modelPatterns: ["phi-","phi4","wizardlm"], nameAliases: ["microsoft"], displayName: "Microsoft" },
  deepgram: { modelPatterns: ["aura-","nova-3","nova-2"], nameAliases: ["deepgram"], displayName: "Deepgram" },
  leonardo: { modelPatterns: ["phoenix-","lucid-"], nameAliases: ["leonardo"], displayName: "Leonardo AI" },
  myshell: { modelPatterns: ["melotts"], nameAliases: ["myshell"], displayName: "MyShell" },
  pfnet: { modelPatterns: ["plamo"], nameAliases: ["pfnet","preferred networks"], displayName: "Preferred Networks" },
  lykon: { modelPatterns: ["dreamshaper"], nameAliases: ["lykon"], displayName: "Lykon" },
  amazon: { modelPatterns: ["nova","polly","titan-"], nameAliases: ["amazon","aws"], displayName: "Amazon" },
  pollinations: { modelPatterns: ["midijourney","openai-fast","openai-large","openai-roblox","openai-audio"], nameAliases: ["pollinations"], displayName: "Pollinations" },
  thedrummer: { modelPatterns: ["cydonia","skyfall","behemoth","rocinante","magidonia","tiger-gemma"], nameAliases: ["thedrummer","drummer"], displayName: "TheDrummer" },
  nexagi: { modelPatterns: ["nex-n2","nex-agi"], nameAliases: ["nexagi","nex agi","nex-agi"], displayName: "Nex AGI" },
  aisingapore: { modelPatterns: ["sea-lion"], strongPatterns: ["sea-lion"], nameAliases: ["ai singapore","aisingapore","sea-lion"], displayName: "AI Singapore" },
  stepfun: { modelPatterns: ["step-","step1","step2","step3"], nameAliases: ["stepfun","阶跃星辰","step"], displayName: "StepFun", icon: "Stepfun.Color" },
  katanemo: { modelPatterns: ["arch-router","arch-function"], nameAliases: ["katanemo"], displayName: "Katanemo" },
  hcompany: { modelPatterns: ["holo2","holo-"], nameAliases: ["hcompany","h company"], displayName: "H Company" },
  // NavyAI house finetunes (undisclosed bases): navy-roleplay, *-uncensored, emotional-36b.
  navyai: { modelPatterns: ["navy-roleplay","devious-uncensored","revenant-uncensored","laborratse","emotional-36b"], nameAliases: ["navyai","navy"], displayName: "NavyAI" },
  sao10k: { modelPatterns: ["euryale","stheno","lunaris","hanami","fimbulvetr"], strongPatterns: ["euryale","stheno","lunaris"], nameAliases: ["sao10k"], displayName: "Sao10K" },
  steelskull: { modelPatterns: ["nevoria","ms-nevoria","steelskull"], strongPatterns: ["nevoria"], nameAliases: ["steelskull"], displayName: "Steelskull" },
  bruhzwater: { modelPatterns: ["sapphira"], strongPatterns: ["sapphira"], nameAliases: ["bruhzwater"], displayName: "BruhzWater" },
  fallenmerick: { modelPatterns: ["violet-lotus","mn-violet"], strongPatterns: ["violet-lotus"], nameAliases: ["fallenmerick"], displayName: "FallenMerick" },
  meganova: { modelPatterns: ["manta-mini","manta-flash","manta-pro"], nameAliases: ["meganova","meganova-ai"], displayName: "MegaNova" },
  aionlabs: { modelPatterns: ["aion-rp","aion-1","aion-2"], strongPatterns: ["aion-rp"], nameAliases: ["aion labs","aionlabs"], displayName: "Aion Labs" },
};

// Most-specific match wins, not first-by-definition-order: a prefix match beats a
// mid-string match (so "bge-multilingual-gemma2" -> baai, not google), and among
// equal anchoring the longest pattern wins (so "llama-3.1-nemotron-..." -> nvidia
// via "nemotron" over meta via "llama", and "openai-fast" -> pollinations).
export function inferVendorFromModelName(name: string): string | undefined {
  const n = name.toLowerCase();
  let best: { vendor: string; score: number } | undefined;
  for (const [vendor, matcher] of Object.entries(VENDOR_MATCHERS)) {
    const strong = new Set(matcher.strongPatterns ?? []);
    for (const p of matcher.modelPatterns) {
      if (!n.includes(p)) continue;
      const score =
        (strong.has(p) ? 10000 : 0) + (n.startsWith(p) ? 1000 : 0) + p.length;
      if (!best || score > best.score) best = { vendor, score };
    }
  }
  return best?.vendor;
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
