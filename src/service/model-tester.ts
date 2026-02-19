import { CHANNEL_TYPES, TIMEOUTS } from "@/lib/constants";
import type {
  ModelTestDetail,
  TestModelsResult,
  TestResult
} from "@/lib/types";

interface RequestConfig {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  isSuccess: (data: unknown) => boolean;
}

export class ModelTester {
  constructor(
    private baseUrl: string,
    private apiKey: string
  ) {}

  private getRequestConfig(
    model: string,
    channelType: number,
    useResponsesAPI: boolean
  ): RequestConfig {
    if (channelType === CHANNEL_TYPES.ANTHROPIC) {
      return {
        url: `${this.baseUrl}/v1/messages`,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: {
          model,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1
        },
        isSuccess: (data) => (data as { type?: string }).type !== "error"
      };
    }
    if (channelType === CHANNEL_TYPES.GEMINI) {
      return {
        url: `${this.baseUrl}/v1beta/models/${model}:generateContent?key=${this.apiKey}`,
        headers: { "Content-Type": "application/json" },
        body: {
          contents: [{ parts: [{ text: "hi" }] }],
          generationConfig: { maxOutputTokens: 1 }
        },
        isSuccess: (data) => !(data as { error?: unknown }).error
      };
    }
    if (useResponsesAPI) {
      return {
        url: `${this.baseUrl}/v1/responses`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`
        },
        body: {
          model,
          input: [
            { role: "user", content: [{ type: "input_text", text: "hi" }] }
          ],
          max_output_tokens: 1,
          store: false
        },
        isSuccess: (data) => !(data as { error?: unknown }).error
      };
    }
    return {
      url: `${this.baseUrl}/v1/chat/completions`,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: {
        model,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1
      },
      isSuccess: (data) => !(data as { error?: unknown }).error
    };
  }

  private async testRequest(
    config: RequestConfig,
    timeoutMs: number
  ): Promise<TestResult> {
    try {
      const startTime = Date.now();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(config.url, {
          method: "POST",
          headers: config.headers,
          body: JSON.stringify(config.body),
          signal: controller.signal
        });
        const responseTime = Date.now() - startTime;
        if (!response.ok) return { success: false };
        const data = await response.json();
        return { success: config.isSuccess(data), responseTime };
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
    timeoutMs: number = TIMEOUTS.MODEL_TEST_MS,
    useResponsesAPI = false
  ): Promise<TestResult> {
    return this.testRequest(
      this.getRequestConfig(model, channelType, useResponsesAPI),
      timeoutMs
    );
  }

  // async testModels(
  //   models: string[],
  //   channelType: number,
  //   useResponsesAPI = false,
  //   concurrency = 5,
  //   onModelTested?: (detail: ModelTestDetail) => void | Promise<void>
  // ): Promise<TestModelsResult> {
  //   const results: ModelTestDetail[] = models.map((model) => ({
  //     model,
  //     success: true,
  //     responseTime: 100
  //   }));

  //   if (onModelTested) {
  //     for (const detail of results) {
  //       await onModelTested(detail);
  //     }
  //   }

  //   return {
  //     workingModels: models,
  //     avgResponseTime: 100,
  //     details: results
  //   };
  // }

  async testModels(
    models: string[],
    channelType: number,
    useResponsesAPI = false,
    concurrency = 5,
    onModelTested?: (detail: ModelTestDetail) => void | Promise<void>,
    timeoutMs: number = TIMEOUTS.MODEL_TEST_MS
  ): Promise<TestModelsResult> {
    const results: ModelTestDetail[] = [];

    for (let i = 0; i < models.length; i += concurrency) {
      const batch = models.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(async (model) => {
          const result = await this.testModel(
            model,
            channelType,
            timeoutMs,
            useResponsesAPI
          );
          return { model, ...result };
        })
      );
      results.push(...batchResults);
      if (onModelTested) {
        for (const detail of batchResults) {
          await onModelTested(detail);
        }
      }
    }

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
      details: results
    };
  }
}
