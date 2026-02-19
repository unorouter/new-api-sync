import { requestJson } from "@/lib/http";
import type { VendorInfo } from "@/lib/constants";

export class DirectApiClient {
  private baseUrl: string;
  private apiKey: string;
  private discoveryType: VendorInfo["modelDiscovery"];

  constructor(baseUrl: string, apiKey: string, vendorInfo: VendorInfo) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.discoveryType = vendorInfo.modelDiscovery;
  }

  async discoverModels(): Promise<string[]> {
    switch (this.discoveryType) {
      case "gemini":
        return this.discoverGeminiModels();
      case "anthropic":
        return this.discoverAnthropicModels();
      default:
        return this.discoverOpenAIModels();
    }
  }

  private async discoverOpenAIModels(): Promise<string[]> {
    const response = await requestJson<{ data?: Array<{ id?: string }> }>(
      `${this.baseUrl}/v1/models`,
      {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      },
    );
    return (response.data ?? []).map((m) => m.id ?? "").filter(Boolean);
  }

  private async discoverAnthropicModels(): Promise<string[]> {
    const response = await requestJson<{ data?: Array<{ id?: string }> }>(
      `${this.baseUrl}/v1/models`,
      {
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
      },
    );
    return (response.data ?? []).map((m) => m.id ?? "").filter(Boolean);
  }

  private async discoverGeminiModels(): Promise<string[]> {
    const response = await requestJson<{ models?: Array<{ name?: string }> }>(
      `${this.baseUrl}/v1beta/models?key=${this.apiKey}`,
    );
    return (response.models ?? [])
      .map((m) => (m.name ?? "").replace(/^models\//, ""))
      .filter(Boolean);
  }
}
