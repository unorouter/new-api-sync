import type { AdapterContext, ProviderAdapter } from "@/providers/adapter";
import type { DirectProviderConfig } from "@/lib/types";
import { processDirectProvider } from "@/providers/direct/provider";

export class DirectProviderAdapter implements ProviderAdapter {
  readonly type = "direct" as const;

  constructor(
    public readonly name: string,
    private providerConfig: DirectProviderConfig,
    private ctx: AdapterContext,
  ) {}

  async discover(): Promise<void> {}

  async test(): Promise<void> {}

  materialize() {
    return processDirectProvider(this.providerConfig, this.ctx.config, this.ctx.state);
  }
}
