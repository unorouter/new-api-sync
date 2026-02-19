import type { RuntimeConfig } from "@/config/schema";
import type { TargetSnapshot } from "@/core/types";
import type { Channel, ModelMeta, Vendor } from "@/lib/types";
import { NewApiClient } from "@/providers/newapi/client";

export const MANAGED_OPTION_KEYS = [
  "GroupRatio",
  "UserUsableGroups",
  "AutoGroups",
  "DefaultUseAutoGroup",
  "ModelRatio",
  "CompletionRatio",
  "global.chat_completions_to_responses_policy",
] as const;

export class TargetClient {
  private client: NewApiClient;

  constructor(config: RuntimeConfig["target"]) {
    this.client = new NewApiClient(config, "target");
  }

  healthCheck() {
    return this.client.healthCheck();
  }

  getOptions(keys: string[]) {
    return this.client.getOptions(keys);
  }

  updateOption(key: string, value: string) {
    return this.client.updateOption(key, value);
  }

  updateOptions(options: Record<string, string>) {
    return this.client.updateOptions(options);
  }

  listChannels(): Promise<Channel[]> {
    return this.client.listChannels();
  }

  createChannel(channel: Omit<Channel, "id">) {
    return this.client.createChannel(channel);
  }

  updateChannel(channel: Channel) {
    return this.client.updateChannel(channel);
  }

  deleteChannel(id: number) {
    return this.client.deleteChannel(id);
  }

  listModels(): Promise<ModelMeta[]> {
    return this.client.listModels();
  }

  createModel(model: Omit<ModelMeta, "id">) {
    return this.client.createModel(model);
  }

  updateModel(model: ModelMeta) {
    return this.client.updateModel(model);
  }

  deleteModel(id: number) {
    return this.client.deleteModel(id);
  }

  listVendors(): Promise<Vendor[]> {
    return this.client.listVendors();
  }

  cleanupOrphanedModels() {
    return this.client.cleanupOrphanedModels();
  }

  async snapshot(): Promise<TargetSnapshot> {
    const [channels, models, vendors, options] = await Promise.all([
      this.listChannels(),
      this.listModels(),
      this.listVendors(),
      this.getOptions([...MANAGED_OPTION_KEYS]),
    ]);

    return { channels, models, vendors, options };
  }
}
