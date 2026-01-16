import { logInfo } from "@/lib/utils";
import type { Channel, ModelMeta, TargetConfig } from "@/types";

interface ApiResponse<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
}

interface ChannelListResponse {
  success: boolean;
  data: { data?: Channel[]; items?: Channel[] } | Channel[];
}

export class TargetClient {
  private config: TargetConfig;

  constructor(config: TargetConfig) {
    this.config = {
      url: config.url.replace(/\/$/, ""),
      systemAccessToken: config.systemAccessToken,
      userId: config.userId,
    };
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.systemAccessToken}`,
      "New-Api-User": String(this.config.userId),
      "Content-Type": "application/json",
    };
  }

  async updateOption(key: string, value: string): Promise<boolean> {
    const response = await fetch(`${this.config.url}/api/option/`, {
      method: "PUT",
      headers: this.headers,
      body: JSON.stringify({ key, value }),
    });
    if (!response.ok) return false;
    const data = (await response.json()) as ApiResponse;
    return data.success;
  }

  async updateOptions(options: Record<string, string>): Promise<{ updated: string[]; failed: string[] }> {
    const updated: string[] = [];
    const failed: string[] = [];
    for (const [key, value] of Object.entries(options)) {
      if (await this.updateOption(key, value)) updated.push(key);
      else failed.push(key);
    }
    return { updated, failed };
  }

  async listChannels(): Promise<Channel[]> {
    const allChannels: Channel[] = [];
    let page = 0;
    while (true) {
      const response = await fetch(`${this.config.url}/api/channel/?p=${page}&page_size=100`, { headers: this.headers });
      if (!response.ok) throw new Error(`Failed to list channels: ${response.status}`);
      const data = (await response.json()) as ChannelListResponse;
      if (!data.success) throw new Error("Channel list API returned success: false");
      const channels = Array.isArray(data.data) ? data.data : (data.data?.items ?? data.data?.data ?? []);
      allChannels.push(...channels);
      if (channels.length < 100) break;
      page++;
    }
    return allChannels;
  }

  async createChannel(channel: Omit<Channel, "id">): Promise<number | null> {
    let response = await fetch(`${this.config.url}/api/channel/`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ mode: "single", channel }),
    });
    if (response.status === 400 || response.status === 422) {
      response = await fetch(`${this.config.url}/api/channel/`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(channel),
      });
    }
    if (!response.ok) return null;
    const data = (await response.json()) as ApiResponse<{ id: number }>;
    if (!data.success) return null;
    logInfo(`Created channel: ${channel.name}`);
    return data.data?.id ?? 0;
  }

  async updateChannel(channel: Channel): Promise<boolean> {
    if (!channel.id) return false;
    const response = await fetch(`${this.config.url}/api/channel/`, {
      method: "PUT",
      headers: this.headers,
      body: JSON.stringify(channel),
    });
    if (!response.ok) return false;
    const data = (await response.json()) as ApiResponse;
    return data.success;
  }

  async deleteChannel(id: number): Promise<boolean> {
    const response = await fetch(`${this.config.url}/api/channel/${id}`, {
      method: "DELETE",
      headers: this.headers,
    });
    if (!response.ok) return false;
    const data = (await response.json()) as ApiResponse;
    return data.success;
  }

  async listModels(): Promise<ModelMeta[]> {
    const allModels: ModelMeta[] = [];
    let page = 0;
    while (true) {
      const response = await fetch(`${this.config.url}/api/models/?p=${page}&page_size=100`, { headers: this.headers });
      if (!response.ok) throw new Error(`Failed to list models: ${response.status}`);
      const data = (await response.json()) as ApiResponse<{ items?: ModelMeta[] }>;
      const models = data.data?.items ?? [];
      allModels.push(...models);
      if (models.length < 100) break;
      page++;
    }
    return allModels;
  }

  async createModel(model: Omit<ModelMeta, "id">): Promise<boolean> {
    const response = await fetch(`${this.config.url}/api/models/`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(model),
    });
    if (!response.ok) return false;
    const data = (await response.json()) as ApiResponse;
    if (data.success) logInfo(`Created model: ${model.model_name}`);
    return data.success;
  }
}
