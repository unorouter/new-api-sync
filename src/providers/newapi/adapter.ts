import type { AdapterContext, ProviderAdapter } from "@/providers/adapter";
import type { ProviderConfig } from "@/lib/types";
import { processNewApiProvider } from "@/providers/newapi/provider";

export class NewApiProviderAdapter implements ProviderAdapter {
  readonly type = "newapi" as const;

  constructor(
    public readonly name: string,
    private providerConfig: ProviderConfig,
    private ctx: AdapterContext,
  ) {}

  async discover(): Promise<void> {}

  async test(): Promise<void> {}

  materialize() {
    return processNewApiProvider(this.providerConfig, this.ctx.config, this.ctx.state);
  }
}
