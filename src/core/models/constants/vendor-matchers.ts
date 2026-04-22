export interface VendorMatcher {
  modelPatterns: string[];
  nameAliases?: string[];
  displayName?: string;
  icon?: string;
}

export const VENDOR_MATCHERS: Record<string, VendorMatcher> = {
  anthropic: {
    modelPatterns: ["claude"],
    displayName: "Anthropic",
    icon: "Claude.Color",
  },
  google: {
    modelPatterns: ["gemini", "palm", "veo"],
    displayName: "Google",
    icon: "Gemini.Color",
  },
  openai: {
    modelPatterns: ["gpt", "o1-", "o3-", "o4-", "chatgpt", "sora"],
    displayName: "OpenAI",
    icon: "OpenAI",
  },
  kling: {
    modelPatterns: ["kling"],
    nameAliases: ["kling", "可灵"],
    displayName: "Kling",
    icon: "Kling.Color",
  },
  deepseek: {
    modelPatterns: ["deepseek"],
    displayName: "DeepSeek",
    icon: "DeepSeek.Color",
  },
  xai: { modelPatterns: ["grok"], displayName: "xAI", icon: "XAI" },
  mistral: {
    modelPatterns: ["mistral", "codestral"],
    displayName: "Mistral",
    icon: "Mistral.Color",
  },
  meta: { modelPatterns: ["llama"], displayName: "Meta", icon: "Meta.Color" },
  alibaba: {
    modelPatterns: ["qwen", "qwq-"],
    nameAliases: ["阿里", "通义", "qwen", "阿里巴巴"],
    displayName: "Alibaba",
    icon: "AlibabaCloud.Color",
  },
  bailian: {
    modelPatterns: ["wan2", "z-image"],
    nameAliases: ["bailian", "阿里云百炼"],
    displayName: "Bailian",
    icon: "AlibabaCloud.Color",
  },
  flux: {
    modelPatterns: ["flux-", "flux."],
    nameAliases: ["flux"],
    displayName: "Flux",
    icon: "Flux",
  },
  cohere: {
    modelPatterns: ["command-", "c4ai-"],
    displayName: "Cohere",
    icon: "Cohere.Color",
  },
  minimax: {
    modelPatterns: ["abab", "minimax-"],
    displayName: "MiniMax",
    icon: "Minimax.Color",
  },
  moonshot: {
    modelPatterns: ["moonshot-", "kimi-"],
    nameAliases: ["月之暗面", "kimi"],
    displayName: "Moonshot",
    icon: "Moonshot",
  },
  zhipu: {
    modelPatterns: ["glm-", "glm4", "glm5", "glm6", "chatglm"],
    nameAliases: ["智谱", "zhipu ai", "chatglm"],
    displayName: "Zhipu",
    icon: "Zhipu.Color",
  },
  perplexity: {
    modelPatterns: ["sonar"],
    displayName: "Perplexity",
    icon: "Perplexity.Color",
  },
  baidu: {
    modelPatterns: ["ernie-"],
    nameAliases: ["百度", "文心"],
    displayName: "Baidu",
    icon: "Wenxin",
  },
  xunfei: {
    modelPatterns: ["sparkdesk"],
    nameAliases: ["讯飞", "spark"],
    displayName: "Xunfei",
    icon: "Spark.Color",
  },
  tencent: {
    modelPatterns: ["hunyuan-"],
    nameAliases: ["腾讯", "混元"],
    displayName: "Tencent",
    icon: "Hunyuan",
  },
  bytedance: {
    modelPatterns: ["doubao-"],
    nameAliases: ["字节", "豆包", "doubao"],
    displayName: "ByteDance",
    icon: "Doubao.Color",
  },
  stabilityai: {
    modelPatterns: ["stable-diffusion", "stability"],
    nameAliases: ["stability ai", "stabilityai"],
    displayName: "Stability AI",
    icon: "Stability",
  },
  yi: { modelPatterns: ["yi-"], displayName: "Yi", icon: "Yi.Color" },
  ai360: { modelPatterns: ["360gpt"], displayName: "360 AI", icon: "Ai360" },
  xiaomi: {
    modelPatterns: ["mimo-"],
    nameAliases: ["xiaomi", "小米"],
    displayName: "Xiaomi",
    icon: "Xiaomi",
  },
};

export function inferVendorFromModelName(name: string): string | undefined {
  const n = name.toLowerCase();
  for (const [vendor, matcher] of Object.entries(VENDOR_MATCHERS)) {
    if (matcher.modelPatterns.some((p) => n.includes(p) || n.startsWith(p))) {
      return vendor;
    }
  }
  return undefined;
}
