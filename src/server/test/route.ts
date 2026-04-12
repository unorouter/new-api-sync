import { applyOnlyProviders, loadConfig } from "@core/config";
import { runTestPipeline } from "@core/sync/test-runner";
import { configPath } from "@server/config/route";
import { sseResponse } from "@server/lib/sse";
import { Elysia, t } from "elysia";

const BodySchema = t.Object({
  only: t.Optional(t.Array(t.String(), { default: [] })),
  configName: t.Optional(t.String()),
});

/**
 * POST /api/test
 *
 * Streams test-pipeline progress as SSE. No apply-phase, just model testing.
 */
export const testRoute = new Elysia({ prefix: "/test" }).post(
  "/",
  ({ body }) =>
    sseResponse(async (emit) => {
      emit("start", { at: new Date().toISOString() });
      const path = configPath(body.configName);
      const config = applyOnlyProviders(await loadConfig(path), body.only ?? []);
      const ok = await runTestPipeline(config);
      return { success: ok };
    }),
  { body: BodySchema },
);
