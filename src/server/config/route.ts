import {
  configDir,
  GLOBAL_CONFIG_PATH,
  loadConfig,
  loadGlobalConfig,
  writeGlobalConfig,
} from "@core/config";
import { type ConfigSchemaType } from "@core/validations/config";
import {
  ConfigCreateBodySchema,
  ConfigCreateResponseSchema,
  ConfigDeleteResponseSchema,
  ConfigFilesListResponseSchema,
  ConfigGetResponsesSchema,
  ConfigNameParamsSchema,
  ConfigPutBodySchema,
  ConfigPutResponsesSchema,
  ConfigQuerySchema,
  GlobalConfigGetResponseSchema,
  GlobalConfigPutBodySchema,
  GlobalConfigPutResponsesSchema,
} from "@core/validations/config-route";
import { t } from "@server/i18n";
import { Elysia } from "elysia";
import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { embeddedConfigExample } from "../../embedded-assets";
import { stringifyWithComments } from "./yaml-sync";

// config.yml (default) + config.<name>.yml variants. Picked by ?name=.
const mainCandidates = () => [
  join(configDir(), "config.yml"),
  join(configDir(), "config.yaml"),
];
const NAMED_RE = /^config\.([a-zA-Z0-9_-]+)\.ya?ml$/;

/** Empty/undefined → main. Returns canonical path even if not yet created. */
export function configPath(name: string | undefined): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) {
    for (const candidate of mainCandidates()) {
      if (Bun.file(candidate).size > 0) return candidate;
    }
    return mainCandidates()[0]!;
  }
  return join(configDir(), `config.${trimmed}.yml`);
}

interface ConfigFileInfo {
  name: string;
  path: string;
  size: number;
}

export function listConfigs(): ConfigFileInfo[] {
  const files: ConfigFileInfo[] = [];
  const dir = configDir();
  for (const candidate of mainCandidates()) {
    if (Bun.file(candidate).size > 0) {
      files.push({ name: "", path: candidate, size: Bun.file(candidate).size });
      break;
    }
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const match = NAMED_RE.exec(entry);
    if (!match) continue;
    const name = match[1]!;
    if (name === "example" || name === "global") continue; // reserved
    const path = join(dir, entry);
    files.push({ name, path, size: Bun.file(path).size });
  }
  // main first, then alpha
  files.sort((a, b) => {
    if (a.name === "") return -1;
    if (b.name === "") return 1;
    return a.name.localeCompare(b.name);
  });
  return files;
}

export const configRoute = new Elysia({ prefix: "/config" })
  .get("/files", () => ({ success: true as const, data: listConfigs() }), {
    response: ConfigFilesListResponseSchema,
  })
  .post(
    "/files",
    async ({ body, set }) => {
      if (body.name === "example") {
        set.status = 400;
        return {
          success: false as const,
          message: t("SERVER.RESERVED_NAME"),
        };
      }
      const path = configPath(body.name);
      if (Bun.file(path).size > 0) {
        set.status = 400;
        return {
          success: false as const,
          message: t("SERVER.CONFIG_EXISTS", { name: body.name }),
        };
      }
      // Seed with the current main config (or `fromName`) so the new file is
      // a valid starting point — otherwise PUT would reject an empty doc.
      const sourcePath = configPath(body.fromName);
      const sourceText = await Bun.file(sourcePath).text();
      await Bun.write(path, sourceText);

      try {
        await loadConfig(path);
      } catch (error) {
        // Source was broken; back out so we don't leave a partial file.
        try {
          unlinkSync(path);
        } catch {
          // already gone
        }
        set.status = 400;
        return {
          success: false as const,
          message: error instanceof Error ? error.message : String(error),
        };
      }

      return {
        success: true as const,
        data: { name: body.name, path, size: Bun.file(path).size },
      };
    },
    {
      body: ConfigCreateBodySchema,
      response: ConfigCreateResponseSchema,
    },
  )
  .delete(
    "/files/:name",
    async ({ params, set }) => {
      if (
        !params.name ||
        params.name === "example" ||
        params.name === "global"
      ) {
        set.status = 400;
        return {
          success: false as const,
          message: t("SERVER.CANNOT_DELETE_MAIN"),
        };
      }
      const path = configPath(params.name);
      if (!(Bun.file(path).size > 0)) {
        set.status = 404;
        return {
          success: false as const,
          message: t("SERVER.CONFIG_NOT_FOUND", { name: params.name }),
        };
      }
      unlinkSync(path);
      return { success: true as const, data: { deleted: params.name } };
    },
    {
      params: ConfigNameParamsSchema,
      response: ConfigDeleteResponseSchema,
    },
  )
  .get(
    "/",
    async ({ query, set }) => {
      const name = query.name ?? "";
      const path = configPath(name);
      if (!(Bun.file(path).size > 0)) {
        // Main missing: seed from config.example.yml (on-disk or embedded).
        if (!name) {
          const onDisk = Bun.file(join(configDir(), "config.example.yml"));
          const example =
            onDisk.size > 0 ? await onDisk.text() : embeddedConfigExample;
          if (example) await Bun.write(path, example);
        }
        if (!(Bun.file(path).size > 0)) {
          set.status = 404;
          return {
            success: false as const,
            message: t("SERVER.CONFIG_NOT_FOUND", { name: name || "main" }),
          };
        }
      }
      const text = await Bun.file(path).text();
      const config = Bun.YAML.parse(text) as ConfigSchemaType;
      return { success: true as const, data: { name, path, config } };
    },
    {
      query: ConfigQuerySchema,
      response: ConfigGetResponsesSchema,
    },
  )
  .put(
    "/",
    async ({ body, query, set }) => {
      const name = query.name ?? "";
      const path = configPath(name);
      if (!(Bun.file(path).size > 0)) {
        set.status = 404;
        return {
          success: false as const,
          message: t("SERVER.CONFIG_NOT_FOUND", { name: name || "main" }),
        };
      }
      const previous = await Bun.file(path).text();

      // Diff into existing Document so comments on unchanged nodes survive.
      const yaml = stringifyWithComments(previous, body.config);
      await Bun.write(path, yaml);

      try {
        await loadConfig(path);
      } catch (error) {
        await Bun.write(path, previous); // rollback

        set.status = 400;
        return {
          success: false as const,
          message: error instanceof Error ? error.message : String(error),
        };
      }

      return {
        success: true as const,
        data: { name, path, config: body.config },
      };
    },
    {
      body: ConfigPutBodySchema,
      query: ConfigQuerySchema,
      response: ConfigPutResponsesSchema,
    },
  )
  .get(
    "/global",
    async () => {
      const config = await loadGlobalConfig();
      return {
        success: true as const,
        data: { path: GLOBAL_CONFIG_PATH, config },
      };
    },
    { response: GlobalConfigGetResponseSchema },
  )
  .put(
    "/global",
    async ({ body, set }) => {
      try {
        await writeGlobalConfig(body.config);
      } catch (error) {
        set.status = 400;
        return {
          success: false as const,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      return {
        success: true as const,
        data: { path: GLOBAL_CONFIG_PATH, config: body.config },
      };
    },
    {
      body: GlobalConfigPutBodySchema,
      response: GlobalConfigPutResponsesSchema,
    },
  );
