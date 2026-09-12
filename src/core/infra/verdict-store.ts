import { basename } from "path";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { S3Client } from "bun";

export interface VerdictStoreConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  prefix?: string;
  /** 32 bytes as hex, `openssl rand -hex 32`. Required only for the OpenRouter
   *  key map; absent leaves that map unreadable and unwritable. */
  encryptionKey?: string;
}

const VERDICT_OBJECT = "verdict-cache.json";
const HISTORY_OBJECT = "verdict-history.jsonl";
const keysObject = (provider: string) => `openrouter-keys/${provider}.json.enc`;

function cipherKey(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(hex))
    throw new Error(
      "verdictStore.encryptionKey must be 64 hex characters: openssl rand -hex 32",
    );
  return Buffer.from(hex, "hex");
}

// The bucket credential is the shared s3gw pair, held by other cluster
// components, so the key map cannot sit there in the clear: these are spending
// credentials. The cipher key lives in config.yml beside the management key,
// which already mints keys on the same account, so the blast radius of a
// config.yml compromise is unchanged.
function seal(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

function unseal(blob: string, key: Buffer): string {
  const raw = Buffer.from(blob, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([
    decipher.update(raw.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
}

// Optional shared home for the verdict cache, the run artifacts and the
// encrypted OpenRouter per-model key map: any S3 API. Without it the sync is
// local-only (logs/), exactly as before.
export class VerdictStore {
  private readonly client: S3Client;
  private readonly prefix: string;
  private readonly cipher: Buffer | null;
  readonly label: string;

  constructor(cfg: VerdictStoreConfig) {
    this.client = new S3Client({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      bucket: cfg.bucket,
      endpoint: cfg.endpoint,
      region: cfg.region ?? "auto",
    });
    this.cipher = cfg.encryptionKey ? cipherKey(cfg.encryptionKey) : null;
    this.prefix = (cfg.prefix ?? "new-api-sync").replace(/^\/+|\/+$/g, "");
    this.label = `${cfg.bucket}/${this.prefix}`;
  }

  private key(name: string): string {
    return `${this.prefix}/${name}`;
  }

  async fetchVerdicts(): Promise<unknown[] | null> {
    const file = this.client.file(this.key(VERDICT_OBJECT));
    if (!(await file.exists())) return null;
    const parsed: unknown = JSON.parse(await file.text());
    return Array.isArray(parsed) ? parsed : null;
  }

  async putVerdicts(entries: unknown[]): Promise<void> {
    await this.client.write(
      this.key(VERDICT_OBJECT),
      JSON.stringify(entries, null, 1),
      { type: "application/json" },
    );
  }

  // Append-only: S3 has no append, so the object is re-read and rewritten with
  // the new lines on the end. Runs are serialised by the sync lock, and a lost
  // line here only thins the audit trail, never a verdict.
  async appendHistory(lines: string[]): Promise<void> {
    if (lines.length === 0) return;
    const file = this.client.file(this.key(HISTORY_OBJECT));
    const prior = (await file.exists()) ? await file.text() : "";
    await this.client.write(
      this.key(HISTORY_OBJECT),
      prior + lines.join("\n") + "\n",
      { type: "application/x-ndjson" },
    );
  }

  get canHoldKeys(): boolean {
    return this.cipher !== null;
  }

  /**
   * OpenRouter reveals a key's secret once, at creation, and our own gateway
   * strips `key` from every channel read, so this object is the only place a
   * minted secret can be read back. One object per provider: providers run
   * concurrently and a shared object would lose writes.
   */
  async fetchProvisionedKeys(
    provider: string,
  ): Promise<Map<string, string> | null> {
    if (!this.cipher) return null;
    const file = this.client.file(this.key(keysObject(provider)));
    if (!(await file.exists())) return null;
    const parsed: unknown = JSON.parse(unseal(await file.text(), this.cipher));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    return new Map(Object.entries(parsed as Record<string, string>));
  }

  async putProvisionedKeys(
    provider: string,
    keys: Map<string, string>,
  ): Promise<void> {
    if (!this.cipher)
      throw new Error(
        "verdictStore.encryptionKey is not set, refusing to write key material",
      );
    await this.client.write(
      this.key(keysObject(provider)),
      seal(JSON.stringify(Object.fromEntries(keys)), this.cipher),
      { type: "text/plain" },
    );
  }

  async mirrorArtifact(localPath: string): Promise<string> {
    const key = this.key(`artifacts/${basename(localPath)}`);
    await this.client.write(key, Bun.file(localPath));
    return key;
  }
}
