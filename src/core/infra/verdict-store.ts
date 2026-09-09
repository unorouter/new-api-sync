import { basename } from "path";
import { S3Client } from "bun";

export interface VerdictStoreConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  prefix?: string;
}

const VERDICT_OBJECT = "verdict-cache.json";

// Optional shared home for the verdict cache and the run artifacts: any S3 API.
// Without it the sync is local-only (logs/), exactly as before.
export class VerdictStore {
  private readonly client: S3Client;
  private readonly prefix: string;
  readonly label: string;

  constructor(cfg: VerdictStoreConfig) {
    this.client = new S3Client({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      bucket: cfg.bucket,
      endpoint: cfg.endpoint,
      region: cfg.region ?? "auto",
    });
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

  async mirrorArtifact(localPath: string): Promise<string> {
    const key = this.key(`artifacts/${basename(localPath)}`);
    await this.client.write(key, Bun.file(localPath));
    return key;
  }
}
