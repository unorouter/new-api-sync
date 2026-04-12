import { runWithSignal } from "@core/abort";
import { applyOnlyProviders, loadConfig } from "@core/config";
import { runReset } from "@core/sync/reset";
import { configPath } from "@server/config/route";
import { sseResponse } from "@server/sse";
import { Elysia, t } from "elysia";

const BodySchema = t.Object({
  only: t.Optional(t.Array(t.String(), { default: [] })),
  configName: t.Optional(t.String()),
});

/**
 * POST /api/reset
 *
 * Streams reset-pipeline progress as SSE so the client can abort via the same
 * connection-drop mechanism as run/test.
 */
export const resetRoute = new Elysia({ prefix: "/reset" }).post(
  "/",
  ({ body, request }) =>
    sseResponse(async (emit, signal) => {
      emit("start", { at: new Date().toISOString() });
      const path = configPath(body.configName);
      const config = applyOnlyProviders(
        await loadConfig(path),
        body.only ?? [],
      );
      return await runWithSignal(signal, () => runReset(config));
    }, request),
  { body: BodySchema },
);
