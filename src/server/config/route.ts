import { ConfigSchema, loadConfig, type ConfigSchemaType } from "@core/config";
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
      path: t.String(),
      config: ConfigSchema,
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
 * GET  /api/config   → parsed JSON config
 * PUT  /api/config   → replace config with a JSON object; server serializes to
 *                      YAML and validates by reloading. On failure, the previous
 *                      file content is restored.
 *
 * YAML comments in the source file are not preserved through this round-trip.
 */
export const configRoute = new Elysia({ prefix: "/config" })
  .get(
    "/",
    async () => {
      const path = await resolveConfigPath();
      const text = await Bun.file(path).text();
      const config = Bun.YAML.parse(text) as ConfigSchemaType;
      return { success: true as const, data: { path, config } };
    },
    { response: GetResponseSchema },
  )
  .put(
    "/",
    async ({ body, set }) => {
      const path = await resolveConfigPath();
      const previous = await Bun.file(path).text();

      const yaml = Bun.YAML.stringify(body.config, null, 2);
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

      return { success: true as const, data: { path, config: body.config } };
    },
    { body: PutBodySchema, response: PutResponseSchema },
  );
