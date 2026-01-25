import { CHANNEL_TYPES, TIMEOUTS } from "@/constants";

export interface TestResult {
  success: boolean;
  responseTime?: number;
}

export interface TestModelsResult {
  workingModels: string[];
  avgResponseTime?: number;
}

/**
 * Test a model using the OpenAI chat completions format.
 */
export async function testModelOpenAI(
  baseUrl: string,
  apiKey: string,
  model: string,
  timeoutMs = TIMEOUTS.MODEL_TEST_MS,
): Promise<TestResult> {
  try {
    const startTime = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
        }),
        signal: controller.signal,
      });
      const responseTime = Date.now() - startTime;
      if (!response.ok) return { success: false };
      const data = (await response.json()) as { error?: unknown };
      return { success: !data.error, responseTime };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    return { success: false };
  }
}

/**
 * Test a model using the Anthropic messages format.
 */
export async function testModelAnthropic(
  baseUrl: string,
  apiKey: string,
  model: string,
  timeoutMs = TIMEOUTS.MODEL_TEST_MS,
): Promise<TestResult> {
  try {
    const startTime = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
        }),
        signal: controller.signal,
      });
      const responseTime = Date.now() - startTime;
      if (!response.ok) return { success: false };
      const data = (await response.json()) as { type?: string };
      return { success: data.type !== "error", responseTime };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    return { success: false };
  }
}

/**
 * Test a model using the appropriate format based on channel type.
 */
export async function testModel(
  baseUrl: string,
  apiKey: string,
  model: string,
  channelType: number,
  timeoutMs = TIMEOUTS.MODEL_TEST_MS,
): Promise<TestResult> {
  if (channelType === CHANNEL_TYPES.ANTHROPIC) {
    return testModelAnthropic(baseUrl, apiKey, model, timeoutMs);
  }
  return testModelOpenAI(baseUrl, apiKey, model, timeoutMs);
}

/**
 * Test multiple models and return working ones with average response time.
 */
export async function testModelsWithKey(
  baseUrl: string,
  apiKey: string,
  models: string[],
  channelType: number,
): Promise<TestModelsResult> {
  const results = await Promise.all(
    models.map(async (model) => {
      const result = await testModel(baseUrl, apiKey, model, channelType);
      return { model, ...result };
    }),
  );

  const working = results.filter((r) => r.success);
  const responseTimes = working
    .map((r) => r.responseTime)
    .filter((t): t is number => t !== undefined);

  const avgResponseTime =
    responseTimes.length > 0
      ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
      : undefined;

  return {
    workingModels: working.map((r) => r.model),
    avgResponseTime,
  };
}
