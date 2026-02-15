import { withRetry, type VendorInfo } from "@/lib/constants";

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
    const response = await withRetry(async () => {
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!res.ok) throw new Error(`Failed to list models: ${res.status}`);
      return res.json() as Promise<{ data?: Array<{ id?: string }> }>;
    });
    return (response.data ?? []).map((m) => m.id ?? "").filter(Boolean);
  }

  private async discoverAnthropicModels(): Promise<string[]> {
    const response = await withRetry(async () => {
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
      });
      if (!res.ok) throw new Error(`Failed to list models: ${res.status}`);
      return res.json() as Promise<{ data?: Array<{ id?: string }> }>;
    });
    return (response.data ?? []).map((m) => m.id ?? "").filter(Boolean);
  }

  private async discoverGeminiModels(): Promise<string[]> {
    const response = await withRetry(async () => {
      const res = await fetch(
        `${this.baseUrl}/v1beta/models?key=${this.apiKey}`,
      );
      if (!res.ok) throw new Error(`Failed to list models: ${res.status}`);
      return res.json() as Promise<{ models?: Array<{ name?: string }> }>;
    });
    return (response.models ?? [])
      .map((m) => (m.name ?? "").replace(/^models\//, ""))
      .filter(Boolean);
  }
}
