import {
  GlobalConfigSchema,
  type GlobalConfigType,
} from "@core/validations/config";
import { t } from "@server/i18n";
import { Value } from "@sinclair/typebox/value";
import YAML from "yaml";

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
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      t("ERROR.GLOBAL_CONFIG_INVALID_YAML", {
        path: GLOBAL_CONFIG_PATH,
        detail,
      }),
    );
  }
  // Treat an empty document (null) as "no settings".
  if (parsedRaw === null || parsedRaw === undefined) return {};
  if (!Value.Check(GlobalConfigSchema, parsedRaw)) {
    const errors = [...Value.Errors(GlobalConfigSchema, parsedRaw)]
      .map((e) => `${e.path || "root"}: ${e.message}`)
      .join("\n");
    throw new Error(
      t("ERROR.GLOBAL_CONFIG_VALIDATION_FAILED", { detail: errors }),
    );
  }
  return parsedRaw as GlobalConfigType;
}

export async function writeGlobalConfig(next: GlobalConfigType): Promise<void> {
  const yaml = YAML.stringify(next, {
    lineWidth: 0,
    defaultStringType: "QUOTE_DOUBLE",
  });
  await Bun.write(GLOBAL_CONFIG_PATH, yaml);
}
