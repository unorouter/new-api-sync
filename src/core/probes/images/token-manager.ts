import { retryOn429 } from "@core/infra/retry";
import type { ClientContext } from "@core/vendors/newapi/context";
import {
  createToken,
  deleteToken,
  getTokenFullKey,
  listTokens,
} from "@core/vendors/newapi/tokens";
import type { UpstreamToken } from "@core/vendors/newapi/types";
import { consola } from "consola";

export class ProbeTokenManager {
  private tokensByName = new Map<string, UpstreamToken>();
  private resolvedKeys = new Map<string, string>();
  private createdByThisRun = new Set<number>();
  private listed = false;

  constructor(
    private ctx: ClientContext,
    private providerName: string,
    private prefix: string = "image",
  ) {}

  async preloadList(): Promise<void> {
    if (this.listed) return;
    const all = await retryOn429(() => listTokens(this.ctx));
    for (const t of all) this.tokensByName.set(t.name, t);
    this.listed = true;
    consola.info(
      `[${this.providerName}] cached ${this.tokensByName.size} tokens`,
    );
  }

  async getApiKey(groupName: string): Promise<string | null> {
    const cached = this.resolvedKeys.get(groupName);
    if (cached) return cached;

    await this.preloadList();
    const tokenName = this.tokenNameFor(groupName);
    let token = this.tokensByName.get(tokenName);

    if (!token) {
      const ok = await retryOn429(() =>
        createToken(this.ctx, tokenName, groupName),
      );
      if (!ok) return null;
      const refreshed = await retryOn429(() => listTokens(this.ctx));
      for (const t of refreshed) this.tokensByName.set(t.name, t);
      token = this.tokensByName.get(tokenName);
      if (!token) return null;
      this.createdByThisRun.add(token.id);
    }

    let key = token.key;
    if (key.includes("**")) {
      const fetched = await retryOn429(
        () => getTokenFullKey(this.ctx, token!.id),
        { maxAttempts: 4 },
      );
      if (!fetched) return null;
      key = fetched;
    }
    if (!key) return null;

    const normalized = key.startsWith("sk-") ? key : `sk-${key}`;
    this.resolvedKeys.set(groupName, normalized);
    return normalized;
  }

  async cleanup(): Promise<void> {
    if (this.createdByThisRun.size === 0) return;
    consola.info(
      `[${this.providerName}] deleting ${this.createdByThisRun.size} probe tokens`,
    );
    for (const id of this.createdByThisRun) {
      try {
        await retryOn429(() => deleteToken(this.ctx, id));
      } catch (err) {
        consola.warn(
          `[${this.providerName}] failed to delete probe token ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private tokenNameFor(groupName: string): string {
    const suffix = `-${this.prefix}`;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const maxBytes = 30 - encoder.encode(suffix).length;
    const encoded = encoder.encode(groupName);
    if (encoded.length <= maxBytes) return `${groupName}${suffix}`;
    let cut = maxBytes;
    while (cut > 0 && (encoded[cut]! & 0xc0) === 0x80) cut--;
    return `${decoder.decode(encoded.subarray(0, cut))}${suffix}`;
  }
}
