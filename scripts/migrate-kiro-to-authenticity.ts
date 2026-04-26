#!/usr/bin/env bun
/**
 * One-off migration: rename kiro-named log artefacts to authenticity-named ones.
 *
 *   logs/kiro-blacklist.json        -> logs/authenticity-blacklist.json
 *   reason "kiro-refusal: …"        -> "coding-tool-refusal: …"
 *   logs/*-model-tests.json keys:
 *     kiroProbes                    -> authenticityProbes
 *     kiroRefusal                   -> authenticityRefusal
 *
 * Idempotent. Safe to re-run; missing kiro keys are silently skipped.
 */

import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOGS_DIR = "logs";

function migrateBlacklist(): void {
  const oldPath = join(LOGS_DIR, "kiro-blacklist.json");
  const newPath = join(LOGS_DIR, "authenticity-blacklist.json");
  if (!existsSync(oldPath)) {
    console.log(`[blacklist] ${oldPath} does not exist, skipping`);
    return;
  }
  const raw = readFileSync(oldPath, "utf8");
  const data = JSON.parse(raw) as Record<string, { since: string; reason: string }>;
  let rewrites = 0;
  for (const key of Object.keys(data)) {
    const entry = data[key]!;
    if (entry.reason.startsWith("kiro-refusal:")) {
      entry.reason = entry.reason.replace(/^kiro-refusal:/, "coding-tool-refusal:");
      rewrites++;
    }
  }
  writeFileSync(newPath, JSON.stringify(data, null, 2));
  if (oldPath !== newPath) {
    // remove old file by renaming + deleting via writing empty? simpler: unlink
    Bun.file(oldPath).delete();
  }
  console.log(`[blacklist] migrated ${oldPath} -> ${newPath}, rewrote ${rewrites} reason tags`);
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function renameJsonKeys(value: JsonValue, renames: Record<string, string>): JsonValue {
  if (Array.isArray(value)) {
    return value.map((v) => renameJsonKeys(v, renames));
  }
  if (value !== null && typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(value)) {
      const newKey = renames[k] ?? k;
      out[newKey] = renameJsonKeys(v, renames);
    }
    return out;
  }
  return value;
}

function migrateModelTestLogs(): void {
  const renames = {
    kiroProbes: "authenticityProbes",
    kiroRefusal: "authenticityRefusal",
  };
  const files = readdirSync(LOGS_DIR).filter((f) => /-model-tests\.json$/.test(f));
  let touched = 0;
  for (const file of files) {
    const path = join(LOGS_DIR, file);
    const raw = readFileSync(path, "utf8");
    if (!raw.includes("kiroProbes") && !raw.includes("kiroRefusal")) continue;
    const data = JSON.parse(raw) as JsonValue;
    const migrated = renameJsonKeys(data, renames);
    writeFileSync(path, JSON.stringify(migrated, null, 2));
    touched++;
  }
  console.log(`[logs] migrated ${touched}/${files.length} *-model-tests.json files`);
}

migrateBlacklist();
migrateModelTestLogs();
