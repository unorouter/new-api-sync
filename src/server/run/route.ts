import { applyOnlyProviders, loadConfig } from "@core/config";
import { runSync } from "@core/run";
import { sseResponse } from "@server/lib/sse";
import { Elysia, t } from "elysia";

const BodySchema = t.Object({
  only: t.Optional(t.Array(t.String(), { default: [] })),
});

/**
 * POST /api/run
 *
 * Streams pipeline progress as Server-Sent Events:
 *   event: log   → consola log forwarded line-by-line
 *   event: done  → final SyncRunResult summary (JSON)
 *   event: error → { message } if the pipeline threw
 */
export const runRoute = new Elysia({ prefix: "/run" }).post(
  "/",
  ({ body }) =>
    sseResponse(async (emit) => {
      emit("start", { at: new Date().toISOString() });
      const config = applyOnlyProviders(await loadConfig(), body.only ?? []);
      const result = await runSync(config);
      return {
        success: result.success,
        elapsedMs: result.elapsedMs,
        providerReports: result.providerReports.map((report) => ({
          name: report.name,
          success: report.success,
          models: report.models,
          error: report.error,
        })),
        apply: {
          channels: result.apply.channels,
          models: result.apply.models,
          options: { updated: result.apply.options.updated },
          errors: result.apply.errors,
        },
      };
    }),
  { body: BodySchema },
);
