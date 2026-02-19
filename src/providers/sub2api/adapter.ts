import type { AdapterContext, ProviderAdapter } from "@/providers/adapter";
import type { Sub2ApiProviderConfig } from "@/lib/types";
import { processSub2ApiProvider } from "@/providers/sub2api/provider";

export class Sub2ApiProviderAdapter implements ProviderAdapter {
  readonly type = "sub2api" as const;

  constructor(
    public readonly name: string,
    private providerConfig: Sub2ApiProviderConfig,
    private ctx: AdapterContext,
  ) {}

  async discover(): Promise<void> {}

  async test(): Promise<void> {}

  materialize() {
    return processSub2ApiProvider(this.providerConfig, this.ctx.config, this.ctx.state);
  }
}
