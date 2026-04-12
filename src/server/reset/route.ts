import { applyOnlyProviders, loadConfig } from "@core/config";
import { runReset } from "@core/sync/reset";
import { configPath } from "@server/config/route";
import { Elysia, t } from "elysia";

const BodySchema = t.Object({
  only: t.Optional(t.Array(t.String(), { default: [] })),
  configName: t.Optional(t.String()),
});

const ResponseSchema = {
  200: t.Object({
    success: t.Literal(true),
    data: t.Object({
      channelsDeleted: t.Number(),
      modelsDeleted: t.Number(),
      orphanModelsDeleted: t.Number(),
      tokensDeleted: t.Number(),
      optionsUpdated: t.Array(t.String()),
    }),
  }),
  500: t.Object({
    success: t.Literal(false),
    message: t.String(),
  }),
};

/**
 * POST /api/reset
 *
 * Delete all sync-managed resources in the target new-api. Short enough to
 * return synchronously — no SSE needed.
 */
export const resetRoute = new Elysia({ prefix: "/reset" }).post(
  "/",
  async ({ body, set }) => {
    try {
      const path = configPath(body.configName);
      const config = applyOnlyProviders(await loadConfig(path), body.only ?? []);
      const result = await runReset(config);
      return { success: true as const, data: result };
    } catch (error) {
      set.status = 500;
      return {
        success: false as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },
  { body: BodySchema, response: ResponseSchema },
);
