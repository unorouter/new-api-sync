// prettier-ignore
export const CHANNEL_TYPES = { UNKNOWN: 0, OPENAI: 1, MIDJOURNEY: 2, AZURE: 3, OLLAMA: 4, MIDJOURNEY_PLUS: 5, OPENAI_MAX: 6, OH_MY_GPT: 7, CUSTOM: 8, AILS: 9, AI_PROXY: 10, PALM: 11, API2GPT: 12, AIGC2D: 13, ANTHROPIC: 14, BAIDU: 15, ZHIPU: 16, ALI: 17, XUNFEI: 18, AI360: 19, OPENROUTER: 20, AI_PROXY_LIBRARY: 21, FAST_GPT: 22, TENCENT: 23, GEMINI: 24, MOONSHOT: 25, ZHIPU_V4: 26, PERPLEXITY: 27, LINGYIWANWU: 31, AWS: 33, COHERE: 34, MINIMAX: 35, SUNO_API: 36, DIFY: 37, JINA: 38, CLOUDFLARE: 39, SILICONFLOW: 40, VERTEX_AI: 41, MISTRAL: 42, DEEPSEEK: 43, MOKA_AI: 44, VOLCENGINE: 45, BAIDU_V2: 46, XINFERENCE: 47, XAI: 48, COZE: 49, KLING: 50, JIMENG: 51, VIDU: 52, SUBMODEL: 53, DOUBAO_VIDEO: 54, SORA: 55, REPLICATE: 56, CODEX: 57, NVIDIA_NIM: 58, COMFYUI: 59, AIHORDE: 61 } as const;

interface TaskModelOverride {
  channelType: number;
  baseUrlSuffix?: string;
}

// prettier-ignore
const TASK_MODEL_OVERRIDES: [string, TaskModelOverride][] = [
  ["grok-imagine-video", { channelType: CHANNEL_TYPES.XAI }],
  ["grok-video", { channelType: CHANNEL_TYPES.XAI }],
  ["sora", { channelType: CHANNEL_TYPES.SORA }],
  ["kling", { channelType: CHANNEL_TYPES.KLING }],
  ["vidu", { channelType: CHANNEL_TYPES.VIDU }],
  ["jimeng", { channelType: CHANNEL_TYPES.JIMENG }],
  ["hailuo", { channelType: CHANNEL_TYPES.MINIMAX }],
  ["seedance", { channelType: CHANNEL_TYPES.DOUBAO_VIDEO }],
  ["veo", { channelType: CHANNEL_TYPES.GEMINI }],
  ["imagen", { channelType: CHANNEL_TYPES.GEMINI }],
  // No baseUrlSuffix: the gateway ALI task adapter adds /alibailian itself only when
  // the upstream is another new-api relay (isNewAPIRelay checks the host), and omits
  // it for a direct DashScope/Bailian host. Baking it into the base here would
  // wrongly prefix a direct aliyuncs.com host -> 404.
  ["wan", { channelType: CHANNEL_TYPES.ALI }],
];

export function getTaskModelOverride(
  modelName: string,
): TaskModelOverride | undefined {
  const lower = modelName.toLowerCase();
  for (const [pattern, override] of TASK_MODEL_OVERRIDES) {
    if (lower.includes(pattern)) return override;
  }
  return undefined;
}

export function inferChannelType(endpoints: string[]): number {
  if (endpoints.includes("jina-rerank")) return CHANNEL_TYPES.JINA;
  if (endpoints.includes("openai-video")) return CHANNEL_TYPES.SORA;
  if (endpoints.includes("anthropic")) return CHANNEL_TYPES.ANTHROPIC;
  if (endpoints.includes("gemini")) return CHANNEL_TYPES.GEMINI;
  return CHANNEL_TYPES.OPENAI;
}
