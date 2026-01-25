import { CHANNEL_TYPES, TIMEOUTS } from "@/lib/constants";

export interface TestResult {
  success: boolean;
  responseTime?: number;
}

export interface TestModelsResult {
  workingModels: string[];
  avgResponseTime?: number;
}

export class ModelTester {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  private async testOpenAI(
    model: string,
    timeoutMs = TIMEOUTS.MODEL_TEST_MS,
  ): Promise<TestResult> {
    try {
      const startTime = Date.now();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
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

  private async testAnthropic(
    model: string,
    timeoutMs = TIMEOUTS.MODEL_TEST_MS,
  ): Promise<TestResult> {
    try {
      const startTime = Date.now();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(`${this.baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey,
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

  private async testGemini(
    model: string,
    timeoutMs = TIMEOUTS.MODEL_TEST_MS,
  ): Promise<TestResult> {
    try {
      const startTime = Date.now();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(
          `${this.baseUrl}/v1beta/models/${model}:generateContent?key=${this.apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: "hi" }] }],
              generationConfig: { maxOutputTokens: 1 },
            }),
            signal: controller.signal,
          },
        );
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

  async testModel(
    model: string,
    channelType: number,
    timeoutMs = TIMEOUTS.MODEL_TEST_MS,
  ): Promise<TestResult> {
    if (channelType === CHANNEL_TYPES.ANTHROPIC) {
      return this.testAnthropic(model, timeoutMs);
    }
    if (channelType === CHANNEL_TYPES.GEMINI) {
      return this.testGemini(model, timeoutMs);
    }
    return this.testOpenAI(model, timeoutMs);
  }

  async testModels(
    models: string[],
    channelType: number,
  ): Promise<TestModelsResult> {
    const results = await Promise.all(
      models.map(async (model) => {
        const result = await this.testModel(model, channelType);
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
}

// Convenience function for backwards compatibility
export function testModelsWithKey(
  baseUrl: string,
  apiKey: string,
  models: string[],
  channelType: number,
): Promise<TestModelsResult> {
  return new ModelTester(baseUrl, apiKey).testModels(models, channelType);
}
