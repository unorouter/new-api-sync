import { applyOnlyProviders, loadConfig } from "@core/config";
import { runSync } from "@core/sync/run";
import { configPath } from "@server/config/route";
import { sseResponse } from "@server/lib/sse";
import { Elysia, t } from "elysia";

const BodySchema = t.Object({
  only: t.Optional(t.Array(t.String(), { default: [] })),
  /** Config name — empty = main config.yml, else config.<name>.yml */
  configName: t.Optional(t.String()),
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
      const path = configPath(body.configName);
      const config = applyOnlyProviders(await loadConfig(path), body.only ?? []);
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
