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
  google: { modelPatterns: ["gemini","palm","veo","gemma","lyria","imagen","nano-banana","embedding-001","embedding-gecko","text-embedding-004"], displayName: "Google", icon: "Gemini.Color" },
  openai: { modelPatterns: ["gpt","o1-","o3","o4-","chatgpt","sora","text-embedding-3","text-embedding-ada","whisper","dall-e","tts-1","omni-moderation","openai"], displayName: "OpenAI", icon: "OpenAI" },
  kling: { modelPatterns: ["kling"], nameAliases: ["kling","可灵"], displayName: "Kling", icon: "Kling.Color" },
  vidu: { modelPatterns: ["vidu"], nameAliases: ["vidu","生数"], displayName: "Vidu" },
  deepseek: { modelPatterns: ["deepseek"], displayName: "DeepSeek", icon: "DeepSeek.Color" },
  xai: { modelPatterns: ["grok"], displayName: "xAI", icon: "XAI" },
  mistral: { modelPatterns: ["mistral","codestral","devstral","magistral","ministral","voxtral","pixtral","leanstral"], displayName: "Mistral", icon: "Mistral.Color" },
  jina: { modelPatterns: ["jina-"], nameAliases: ["jina"], displayName: "Jina AI", icon: "Jina" },
  baai: { modelPatterns: ["bge-","bce-embedding","baai/"], nameAliases: ["baai","beijing academy"], displayName: "BAAI", icon: "BAAI" },
  baichuan: { modelPatterns: ["baichuan"], nameAliases: ["百川","baichuan"], displayName: "Baichuan", icon: "Baichuan.Color" },
  meta: { modelPatterns: ["llama"], displayName: "Meta", icon: "Meta.Color" },
  nvidia: { modelPatterns: ["nemotron"], strongPatterns: ["nemotron"], displayName: "NVIDIA", icon: "Nvidia.Color" },
  liquid: { modelPatterns: ["lfm-"], nameAliases: ["liquid"], displayName: "Liquid", icon: "Liquid" },
  inclusionai: { modelPatterns: ["ling-","ring-"], nameAliases: ["inclusionai"], displayName: "InclusionAI" },
  nousresearch: { modelPatterns: ["hermes-"], nameAliases: ["nous","nousresearch"], displayName: "Nous Research", icon: "NousResearch" },
  gryphe: { modelPatterns: ["mythomax","mythomist","mythalion","mytho-"], strongPatterns: ["mythomax","mythalion"], nameAliases: ["gryphe"], displayName: "Gryphe" },
  venice: { modelPatterns: ["venice"], nameAliases: ["venice"], displayName: "Venice AI", icon: "Venice.Color" },
  agnes: { modelPatterns: ["agnes-"], nameAliases: ["agnes","sapiens"], displayName: "Agnes AI" },
  alibaba: { modelPatterns: ["qwen","qwq-","qvq-","text-embedding-v"], nameAliases: ["阿里","通义","qwen","阿里巴巴"], displayName: "Alibaba", icon: "AlibabaCloud.Color" },
  bailian: { modelPatterns: ["wan2","z-image","happyhorse"], nameAliases: ["bailian","阿里云百炼"], displayName: "Bailian", icon: "AlibabaCloud.Color" },
  flux: { modelPatterns: ["flux-","flux.","flux"], nameAliases: ["flux"], displayName: "Flux", icon: "Flux" },
  cohere: { modelPatterns: ["command-","c4ai-","cohere","aya-","tiny-aya","north-mini","embed-english-","embed-multilingual-","embed-v4"], displayName: "Cohere", icon: "Cohere.Color" },
  minimax: { modelPatterns: ["abab","minimax-"], displayName: "MiniMax", icon: "Minimax.Color" },
  moonshot: { modelPatterns: ["moonshot-","kimi-","kimi","k2.6","k2-"], nameAliases: ["月之暗面","kimi"], displayName: "Moonshot", icon: "Moonshot" },
  zhipu: { modelPatterns: ["glm-","glm4","glm5","glm6","chatglm"], nameAliases: ["智谱","zhipu ai","chatglm","z.ai","z-ai","zai"], displayName: "Zhipu", icon: "Zhipu.Color" },
  perplexity: { modelPatterns: ["sonar"], displayName: "Perplexity", icon: "Perplexity.Color" },
  baidu: { modelPatterns: ["ernie-","qianfan-","embedding-v1"], nameAliases: ["百度","文心"], displayName: "Baidu", icon: "Wenxin" },
  xunfei: { modelPatterns: ["sparkdesk"], nameAliases: ["讯飞","spark"], displayName: "Xunfei", icon: "Spark.Color" },
  tencent: { modelPatterns: ["hunyuan","hy3","hy4","hy-mt"], strongPatterns: ["hy3","hy4","hy-mt"], nameAliases: ["腾讯","混元"], displayName: "Tencent", icon: "Hunyuan" },
  bytedance: { modelPatterns: ["doubao-","seed-","sdxl-lightning"], strongPatterns: ["sdxl-lightning"], nameAliases: ["字节","豆包","doubao","bytedance"], displayName: "ByteDance", icon: "Doubao.Color" },
  stabilityai: { modelPatterns: ["stable-diffusion","stability","sdxl"], nameAliases: ["stability ai","stabilityai"], displayName: "Stability AI", icon: "Stability" },
  elevenlabs: { modelPatterns: ["eleven-","eleven_","elevenlabs","eleven-multilingual","eleven-turbo","eleven-flash","scribe","dubbing"], nameAliases: ["elevenlabs","eleven labs"], displayName: "ElevenLabs", icon: "ElevenLabs" },
  midjourney: { modelPatterns: ["midjourney","mj_","mj-"], nameAliases: ["midjourney","mj"], displayName: "Midjourney", icon: "Midjourney" },
  speechify: { modelPatterns: ["speechify"], nameAliases: ["speechify"], displayName: "Speechify" },
  deepl: { modelPatterns: ["deepl"], strongPatterns: ["deepl"], nameAliases: ["deepl"], displayName: "DeepL" },
  essentialai: { modelPatterns: ["rnj-"], strongPatterns: ["rnj-"], nameAliases: ["essentialai","essential ai"], displayName: "Essential AI" },
  meituan: { modelPatterns: ["longcat"], strongPatterns: ["longcat"], nameAliases: ["meituan","美团","longcat"], displayName: "Meituan" },
  kuaishou: { modelPatterns: ["kat-coder","kat-dev","kwaipilot"], strongPatterns: ["kat-coder","kat-dev"], nameAliases: ["kuaishou","快手","kwaipilot","streamlake"], displayName: "Kuaishou" },
  internlm: { modelPatterns: ["internlm","internvl","intern-s","intern-latest"], strongPatterns: ["internlm","internvl","intern-s"], nameAliases: ["internlm","intern","书生","浦语","shanghai ai"], displayName: "InternLM", icon: "InternLM" },
  sensenova: { modelPatterns: ["sensechat","sensenova","sense-"], strongPatterns: ["sensechat","sensenova"], nameAliases: ["sensenova","sensetime","商汤"], displayName: "SenseNova", icon: "SenseNova" },
  voidai: { modelPatterns: ["umbra"], strongPatterns: ["umbra"], nameAliases: ["voidai","void ai"], displayName: "VoidAI" },
  zanity: { modelPatterns: ["zanity-rp","zanity"], strongPatterns: ["zanity-rp"], nameAliases: ["zanity"], displayName: "Zanity" },
  yi: { modelPatterns: ["yi-"], displayName: "Yi", icon: "Yi.Color" },
  ai360: { modelPatterns: ["360gpt"], displayName: "360 AI", icon: "Ai360" },
  xiaomi: { modelPatterns: ["mimo-"], nameAliases: ["xiaomi","小米"], displayName: "Xiaomi", icon: "Xiaomi" },
  arcee: { modelPatterns: ["arcee","trinity","afm-","virtuoso-","maestro-","caller-","blitz","spotlight","coder-large"], nameAliases: ["arcee","arcee ai"], displayName: "Arcee AI", icon: "Arcee.Color" },
  groq: { modelPatterns: ["compound"], nameAliases: ["groq"], displayName: "Groq", icon: "Groq" },
  sdaia: { modelPatterns: ["allam"], nameAliases: ["sdaia","allam"], displayName: "SDAIA", icon: "SDAIA" },
  ibm: { modelPatterns: ["granite-"], nameAliases: ["ibm","ibm-granite"], displayName: "IBM", icon: "IBM" },
  jetbrains: { modelPatterns: ["mellum"], strongPatterns: ["mellum"], nameAliases: ["jetbrains"], displayName: "JetBrains" },
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
  poolside: { modelPatterns: ["laguna","malibu"], nameAliases: ["poolside"], displayName: "Poolside" },
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
  // OpenCode Zen house/stealth models (undisclosed base): big-pickle + opencode-branded.
  opencodezen: { modelPatterns: ["big-pickle","opencode"], strongPatterns: ["big-pickle"], nameAliases: ["opencode zen","opencode"], displayName: "OpenCode Zen" },
  swissai: { modelPatterns: ["apertus"], strongPatterns: ["apertus"], nameAliases: ["swiss ai","swiss-ai","swissai","eth zurich","epfl"], displayName: "Swiss AI" },
  utterproject: { modelPatterns: ["eurollm"], strongPatterns: ["eurollm"], nameAliases: ["utter-project","utter project","eurollm"], displayName: "EuroLLM" },
  dictail: { modelPatterns: ["dictalm"], strongPatterns: ["dictalm"], nameAliases: ["dicta-il","dicta","dictalm"], displayName: "Dicta" },
  allenai: { modelPatterns: ["olmo"], strongPatterns: ["olmo"], nameAliases: ["allenai","allen ai","ai2","olmo"], displayName: "Allen AI" },
  voyage: { modelPatterns: ["voyage-"], strongPatterns: ["voyage-"], nameAliases: ["voyage","voyage ai"], displayName: "Voyage AI" },
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
