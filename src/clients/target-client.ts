import { logDebug, logError, logInfo } from "@/lib/utils";
import type { Channel, TargetConfig } from "@/types";

interface ApiResponse<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
}

interface ChannelListResponse {
  success: boolean;
  data:
    | {
        data?: Channel[];
        items?: Channel[];
      }
    | Channel[];
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

  /**
   * Update a single option
   */
  async updateOption(key: string, value: string): Promise<boolean> {
    logDebug(`Updating option: ${key}`);

    const response = await fetch(`${this.config.url}/api/option/`, {
      method: "PUT",
      headers: this.headers,
      body: JSON.stringify({ key, value }),
    });

    if (!response.ok) {
      logError(`Failed to update option ${key}: ${response.status}`);
      return false;
    }

    const data = (await response.json()) as ApiResponse;
    if (!data.success) {
      logError(`Failed to update option ${key}: ${data.message}`);
      return false;
    }

    return true;
  }

  /**
   * Update multiple options
   */
  async updateOptions(
    options: Record<string, string>,
  ): Promise<{ updated: string[]; failed: string[] }> {
    const updated: string[] = [];
    const failed: string[] = [];

    for (const [key, value] of Object.entries(options)) {
      const success = await this.updateOption(key, value);
      if (success) {
        updated.push(key);
      } else {
        failed.push(key);
      }
    }

    if (updated.length > 0) {
      logInfo(`Updated options: ${updated.join(", ")}`);
    }
    if (failed.length > 0) {
      logError(`Failed to update options: ${failed.join(", ")}`);
    }

    return { updated, failed };
  }

  /**
   * List all channels
   */
  async listChannels(): Promise<Channel[]> {
    logDebug("Listing channels");

    const response = await fetch(
      `${this.config.url}/api/channel/?p=0&page_size=10000`,
      {
        headers: this.headers,
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to list channels: ${response.status}`);
    }

    const data = (await response.json()) as ChannelListResponse;
    if (!data.success) {
      throw new Error("Channel list API returned success: false");
    }

    // Handle multiple response formats (paginated with items/data or direct array)
    const channels = Array.isArray(data.data)
      ? data.data
      : (data.data?.items ?? data.data?.data ?? []);

    return channels;
  }

  /**
   * Create a new channel
   * Supports both old format (direct channel) and new format (wrapped in mode+channel)
   */
  async createChannel(channel: Omit<Channel, "id">): Promise<number | null> {
    logDebug(`Creating channel: ${channel.name}`);

    // Try new API format first (wrapped in mode+channel)
    const newFormatBody = {
      mode: "single",
      channel: channel,
    };

    let response = await fetch(`${this.config.url}/api/channel/`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(newFormatBody),
    });

    // If new format fails with 400/422, try old format (direct channel)
    if (response.status === 400 || response.status === 422) {
      logDebug(`New API format failed, trying old format for: ${channel.name}`);
      response = await fetch(`${this.config.url}/api/channel/`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(channel),
      });
    }

    if (!response.ok) {
      logError(`Failed to create channel ${channel.name}: ${response.status}`);
      return null;
    }

    const data = (await response.json()) as ApiResponse<{ id: number }>;
    if (!data.success) {
      logError(`Failed to create channel ${channel.name}: ${data.message}`);
      return null;
    }

    logInfo(`Created channel: ${channel.name}`);
    // New API doesn't return ID, return 0 to indicate success
    return data.data?.id ?? 0;
  }

  /**
   * Update an existing channel
   */
  async updateChannel(channel: Channel): Promise<boolean> {
    if (!channel.id) {
      logError(`Cannot update channel without ID: ${channel.name}`);
      return false;
    }

    logDebug(`Updating channel: ${channel.name} (ID: ${channel.id})`);

    const response = await fetch(`${this.config.url}/api/channel/`, {
      method: "PUT",
      headers: this.headers,
      body: JSON.stringify(channel),
    });

    if (!response.ok) {
      logError(`Failed to update channel ${channel.name}: ${response.status}`);
      return false;
    }

    const data = (await response.json()) as ApiResponse;
    if (!data.success) {
      logError(`Failed to update channel ${channel.name}: ${data.message}`);
      return false;
    }

    logInfo(`Updated channel: ${channel.name}`);
    return true;
  }

  /**
   * Delete a channel by ID
   */
  async deleteChannel(id: number): Promise<boolean> {
    logDebug(`Deleting channel ID: ${id}`);

    const response = await fetch(`${this.config.url}/api/channel/${id}`, {
      method: "DELETE",
      headers: this.headers,
    });

    if (!response.ok) {
      logError(`Failed to delete channel ${id}: ${response.status}`);
      return false;
    }

    const data = (await response.json()) as ApiResponse;
    if (!data.success) {
      logError(`Failed to delete channel ${id}: ${data.message}`);
      return false;
    }

    logInfo(`Deleted channel ID: ${id}`);
    return true;
  }

  /**
   * Test connection to target
   */
  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.url}/api/status`, {
        headers: this.headers,
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
