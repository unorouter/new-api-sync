import { mergeProbeBody, testRequest } from "./execution";

// One fixed paragraph; the lane's own tokenizer prices it, so the check needs no
// per maker token table.
const BLOCK =
  "The harbor town woke slowly. Fishing boats rocked against the pier while gulls argued over scraps, " +
  "and the baker on the corner pulled the first loaves from a stone oven that had burned since before dawn. " +
  "Children ran past the chapel toward the school, their boots loud on the wet cobblestones, and an old man " +
  "mended nets beside a stack of lobster traps, humming a song his father had taught him decades ago. ";
const LONG_BLOCKS = 80;
// A merchant fanning one request out four times billed 4x the input of the same
// conversation elsewhere (a7 1326-6286, 2026-11-06); honest lanes land within a
// few percent of the linear count.
const OVER_FACTOR = 1.5;
const OVER_MIN_TOKENS = 1000;

export type UsageTruthResult =
  | { verdict: "pass"; billed: number; expected: number }
  | { verdict: "fail"; billed: number; expected: number; reason: string }
  | { verdict: "inconclusive"; reason: string };

export async function probeUsageTruth(lane: {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  extraBody?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
}): Promise<UsageTruthResult> {
  const billedPrompt = async (blocks: number): Promise<number | null> => {
    const res = await testRequest(
      {
        url: `${lane.baseUrl}/v1/chat/completions`,
        headers: {
          Authorization: `Bearer ${lane.apiKey}`,
          "Content-Type": "application/json",
          ...lane.extraHeaders,
        },
        body: mergeProbeBody(
          {
            model: lane.model,
            max_tokens: 16,
            messages: [
              {
                role: "user",
                content: `${BLOCK.repeat(blocks)}\nReply with the single word OK.`,
              },
            ],
          },
          lane.extraBody,
        ),
        isSuccess: () => true,
      },
      lane.timeoutMs,
    );
    if (res.status === undefined || res.status >= 400) return null;
    const data = res.response;
    if (!data || typeof data !== "object" || !("usage" in data)) return null;
    const usage = data.usage;
    if (!usage || typeof usage !== "object" || !("prompt_tokens" in usage))
      return null;
    const tokens = Number(usage.prompt_tokens);
    return Number.isFinite(tokens) && tokens > 0 ? tokens : null;
  };

  const one = await billedPrompt(1);
  const two = await billedPrompt(2);
  if (one === null || two === null)
    return { verdict: "inconclusive", reason: "no usage on the short prompts" };
  const perBlock = two - one;
  if (perBlock <= 0)
    return {
      verdict: "inconclusive",
      reason: `no per block growth (${one} then ${two})`,
    };
  const long = await billedPrompt(LONG_BLOCKS);
  if (long === null)
    return { verdict: "inconclusive", reason: "no usage on the long prompt" };
  const expected = one + perBlock * (LONG_BLOCKS - 1);
  if (long >= expected * OVER_FACTOR && long - expected >= OVER_MIN_TOKENS)
    return {
      verdict: "fail",
      billed: long,
      expected,
      reason: `usage inflation: billed ${long} input tokens for a prompt of about ${expected}`,
    };
  return { verdict: "pass", billed: long, expected };
}
