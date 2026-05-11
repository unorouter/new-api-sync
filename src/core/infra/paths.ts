import { basename, dirname, join } from "path";

/** Compiled binary: dirname(execPath). Bun dev: process.cwd(). */
export function configDir(): string {
  if (typeof process === "undefined") return "";
  const exe = process.execPath;
  const name = basename(exe).toLowerCase();
  const isBun = name === "bun" || name.startsWith("bun.");
  return isBun ? process.cwd() : dirname(exe);
}

export function logsDir(): string {
  return join(process.cwd(), "logs");
}

export function artifactsDir(provider: string, model: string): string {
  return join(logsDir(), "images", slug(provider), slug(model));
}

export function imageFixturesDir(): string {
  return join(configDir(), "images");
}

function slug(s: string): string {
  const cleaned = s.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "default";
}

export { slug };
