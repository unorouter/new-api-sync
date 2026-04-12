import { loadConfig } from "@core/config";
import { Elysia, t } from "elysia";

const CONFIG_CANDIDATES = ["./config.yml", "./config.yaml"];

async function resolveConfigPath(): Promise<string> {
  for (const candidate of CONFIG_CANDIDATES) {
    if (await Bun.file(candidate).exists()) return candidate;
  }
  throw new Error(
    `No config file found (tried ${CONFIG_CANDIDATES.join(", ")})`,
  );
}

const GetResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    path: t.String(),
    yaml: t.String(),
  }),
});

const PutBodySchema = t.Object({
  yaml: t.String({ minLength: 1 }),
});

const PutResponseSchema = {
  200: t.Object({
    success: t.Literal(true),
    data: t.Object({
      path: t.String(),
      yaml: t.String(),
    }),
  }),
  400: t.Object({
    success: t.Literal(false),
    message: t.String(),
  }),
};

/**
 * Config routes.
 *
 * GET  /api/config   → raw YAML text (preserves comments/formatting)
 * PUT  /api/config   → replace the YAML file, validate by reloading
 */
export const configRoute = new Elysia({ prefix: "/config" })
  .get(
    "/",
    async () => {
      const path = await resolveConfigPath();
      const yaml = await Bun.file(path).text();
      return { success: true as const, data: { path, yaml } };
    },
    { response: GetResponseSchema },
  )
  .put(
    "/",
    async ({ body, set }) => {
      const path = await resolveConfigPath();
      const previous = await Bun.file(path).text();

      await Bun.write(path, body.yaml);

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

      return { success: true as const, data: { path, yaml: body.yaml } };
    },
    { body: PutBodySchema, response: PutResponseSchema },
  );
