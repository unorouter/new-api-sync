import {
  GlobalConfigSchema,
  type GlobalConfigType,
} from "@core/validations/config";
import { Value } from "@sinclair/typebox/value";

/**
 * Loader/writer for `config.global.yml` — the cross-config file that holds
 * `locale`, `theme`, and the shared `blacklist` / `modelMapping` that merge
 * into every per-config on load. See `loadConfig()` in `config.ts`.
 */

export const GLOBAL_CONFIG_PATH = "./config.global.yml";

export async function loadGlobalConfig(): Promise<GlobalConfigType> {
  const file = Bun.file(GLOBAL_CONFIG_PATH);
  if (!(await file.exists())) return {};
  let parsedRaw: unknown;
  try {
    parsedRaw = Bun.YAML.parse(await file.text());
  } catch (error) {
    throw new Error(
      `Invalid YAML in ${GLOBAL_CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Treat an empty document (null) as "no settings".
  if (parsedRaw === null || parsedRaw === undefined) return {};
  if (!Value.Check(GlobalConfigSchema, parsedRaw)) {
    const errors = [...Value.Errors(GlobalConfigSchema, parsedRaw)]
      .map((e) => `${e.path || "root"}: ${e.message}`)
      .join("\n");
    throw new Error(`${GLOBAL_CONFIG_PATH} validation failed:\n${errors}`);
  }
  return parsedRaw as GlobalConfigType;
}

export async function writeGlobalConfig(
  next: GlobalConfigType,
): Promise<void> {
  const yaml = Bun.YAML.stringify(next);
  await Bun.write(GLOBAL_CONFIG_PATH, yaml);
}
