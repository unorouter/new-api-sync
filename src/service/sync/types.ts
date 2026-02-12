import type { ChannelSpec, MergedGroup, MergedModel } from "@/lib/types";

export interface SyncState {
  mergedGroups: MergedGroup[];
  mergedModels: Map<string, MergedModel>;
  modelEndpoints: Map<string, string[]>;
  channelsToCreate: ChannelSpec[];
}
