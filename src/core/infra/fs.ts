import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Tmp + rename: a SIGKILL mid-write leaves the previous file intact. */
export function writeJsonAtomic(path: string, data: unknown): void {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

export function writeFile(path: string, data: string | Uint8Array): void {
  ensureDir(dirname(path));
  writeFileSync(path, data);
}
