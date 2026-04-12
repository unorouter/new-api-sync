import { ConfigSchema, loadConfig, type ConfigSchemaType } from "@core/config";
import { readdirSync, unlinkSync } from "node:fs";
import { Elysia, t } from "elysia";
import { stringifyWithComments } from "./yaml-sync";

/**
 * Config routes.
 *
 * Multiple named configs live in the project root as `config.yml` (the main /
 * default one) and `config.<name>.yml` (named variants). The frontend picks one
 * by `name`:
 *   - `""` or omitted → `config.yml`
 *   - `"debug"`       → `config.debug.yml`
 *
 * Endpoints:
 *   GET    /api/config/files          list all configs
 *   POST   /api/config/files          create a new named config (body: {name, fromName?})
 *   DELETE /api/config/files/:name    delete a named config (main is locked)
 *   GET    /api/config?name=<name>    parsed JSON for one config
 *   PUT    /api/config?name=<name>    overwrite with JSON; validates + rolls back on failure
 *
 * YAML comments in the source file are not preserved through PUT.
 */

// Main file name — `.yaml` is also accepted if present on disk.
const MAIN_CANDIDATES = ["./config.yml", "./config.yaml"];
const NAMED_RE = /^config\.([a-zA-Z0-9_-]+)\.ya?ml$/;

/**
 * Pick the path for a given `name`. Empty string / undefined → main config.
 * Returns the *canonical* path we'd create (may not exist yet for POST).
 */
export function configPath(name: string | undefined): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) {
    for (const candidate of MAIN_CANDIDATES) {
      if (Bun.file(candidate).size > 0) return candidate;
    }
    return MAIN_CANDIDATES[0]!;
  }
  return `./config.${trimmed}.yml`;
}

interface ConfigFileInfo {
  name: string;
  path: string;
  size: number;
}

function listConfigs(): ConfigFileInfo[] {
  const files: ConfigFileInfo[] = [];
  // Main config — first existing candidate.
  for (const candidate of MAIN_CANDIDATES) {
    if (Bun.file(candidate).size > 0) {
      files.push({ name: "", path: candidate, size: Bun.file(candidate).size });
      break;
    }
  }
  // Named configs.
  let entries: string[] = [];
  try {
    entries = readdirSync(".");
  } catch {
    return files;
  }
  for (const entry of entries) {
    const match = NAMED_RE.exec(entry);
    if (!match) continue;
    const name = match[1]!;
    // Skip "example" — it's shipped documentation, not a user-editable config.
    if (name === "example") continue;
    const path = `./${entry}`;
    files.push({ name, path, size: Bun.file(path).size });
  }
  // Main first, named alphabetically.
  files.sort((a, b) => {
    if (a.name === "") return -1;
    if (b.name === "") return 1;
    return a.name.localeCompare(b.name);
  });
  return files;
}

const ConfigFileSchema = t.Object({
  name: t.String(),
  path: t.String(),
  size: t.Number(),
});

const QuerySchema = t.Object({ name: t.Optional(t.String()) });

const GetResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    name: t.String(),
    path: t.String(),
    config: ConfigSchema,
  }),
});

const PutBodySchema = t.Object({
  config: ConfigSchema,
});

const PutResponseSchema = {
  200: t.Object({
    success: t.Literal(true),
    data: t.Object({
      name: t.String(),
      path: t.String(),
      config: ConfigSchema,
    }),
  }),
  400: t.Object({
    success: t.Literal(false),
    message: t.String(),
  }),
};

const CreateBodySchema = t.Object({
  name: t.String({ minLength: 1, pattern: "^[a-zA-Z0-9_-]+$" }),
  /** Optional: clone the body from this existing config name. Empty string = main. */
  fromName: t.Optional(t.String()),
});

export const configRoute = new Elysia({ prefix: "/config" })
  .get(
    "/files",
    () => ({ success: true as const, data: listConfigs() }),
    {
      response: t.Object({
        success: t.Literal(true),
        data: t.Array(ConfigFileSchema),
      }),
    },
  )
  .post(
    "/files",
    async ({ body, set }) => {
      if (body.name === "example") {
        set.status = 400;
        return { success: false as const, message: "name 'example' is reserved" };
      }
      const path = configPath(body.name);
      if (Bun.file(path).size > 0) {
        set.status = 400;
        return { success: false as const, message: `config '${body.name}' already exists` };
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
      body: CreateBodySchema,
      response: {
        200: t.Object({ success: t.Literal(true), data: ConfigFileSchema }),
        400: t.Object({ success: t.Literal(false), message: t.String() }),
      },
    },
  )
  .delete(
    "/files/:name",
    ({ params, set }) => {
      if (!params.name || params.name === "example") {
        set.status = 400;
        return {
          success: false as const,
          message: "cannot delete main or reserved configs",
        };
      }
      const path = configPath(params.name);
      if (!(Bun.file(path).size > 0)) {
        set.status = 404;
        return {
          success: false as const,
          message: `config '${params.name}' not found`,
        };
      }
      unlinkSync(path);
      return { success: true as const, data: { deleted: params.name } };
    },
    {
      params: t.Object({ name: t.String() }),
      response: {
        200: t.Object({
          success: t.Literal(true),
          data: t.Object({ deleted: t.String() }),
        }),
        400: t.Object({ success: t.Literal(false), message: t.String() }),
        404: t.Object({ success: t.Literal(false), message: t.String() }),
      },
    },
  )
  .get(
    "/",
    async ({ query, set }) => {
      const name = query.name ?? "";
      const path = configPath(name);
      if (!(Bun.file(path).size > 0)) {
        set.status = 404;
        return {
          success: false as const,
          message: `config '${name || "main"}' not found`,
        };
      }
      const text = await Bun.file(path).text();
      const config = Bun.YAML.parse(text) as ConfigSchemaType;
      return { success: true as const, data: { name, path, config } };
    },
    {
      query: QuerySchema,
      response: {
        200: GetResponseSchema,
        404: t.Object({ success: t.Literal(false), message: t.String() }),
      },
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
          message: `config '${name || "main"}' not found`,
        };
      }
      const previous = await Bun.file(path).text();

      // Preserve comments on unchanged nodes by diffing into the existing
      // YAML Document rather than re-emitting from scratch.
      const yaml = stringifyWithComments(previous, body.config);
      await Bun.write(path, yaml);

      try {
        await loadConfig(path);
      } catch (error) {
        // Validation failed — restore the previous file and surface the error.
        await Bun.write(path, previous);
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
      body: PutBodySchema,
      query: QuerySchema,
      response: {
        ...PutResponseSchema,
        404: t.Object({ success: t.Literal(false), message: t.String() }),
      },
    },
  );
