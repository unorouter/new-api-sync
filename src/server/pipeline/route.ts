import { runWithSignal } from "@core/abort";
import { applyOnlyProviders, loadConfig } from "@core/config";
import { runReset } from "@core/sync/reset";
import { runSync } from "@core/sync/run";
import { runTestPipeline } from "@core/sync/test-runner";
import { configPath } from "@server/config/route";
import { cancelActiveRun, pipelineStream } from "@server/sse";
import { Elysia, t } from "elysia";

const PipelineBody = t.Object({
  only: t.Optional(t.Array(t.String(), { default: [] })),
  /** Config name — empty = main config.yml, else config.<name>.yml */
  configName: t.Optional(t.String()),
});

const CancelBody = t.Object({ id: t.String() });

/**
 * All pipeline endpoints live under `/api/pipeline`. The three run modes
 * (run / test / reset) stream SSE as async generators — each yields a
 * `kind: "run"` frame first (with the run id), then `start`, any number of
 * `log` frames, and a terminal `done` or `error`. Cancel takes the run id
 * and aborts the active run without tearing down the stream, so the final
 * summary logs still reach the UI.
 */
export const pipelineRoute = new Elysia({ prefix: "/pipeline" })
  .post(
    "/run",
    ({ body, request }) =>
      pipelineStream(async (emit, signal) => {
        emit({ kind: "start", at: new Date().toISOString() });
        const path = configPath(body.configName);
        const config = applyOnlyProviders(
          await loadConfig(path),
          body.only ?? [],
        );
        const result = await runWithSignal(signal, () => runSync(config));
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
      }, request),
    { body: PipelineBody },
  )
  .post(
    "/test",
    ({ body, request }) =>
      pipelineStream(async (emit, signal) => {
        emit({ kind: "start", at: new Date().toISOString() });
        const path = configPath(body.configName);
        const config = applyOnlyProviders(
          await loadConfig(path),
          body.only ?? [],
        );
        const ok = await runWithSignal(signal, () => runTestPipeline(config));
        return { success: ok };
      }, request),
    { body: PipelineBody },
  )
  .post(
    "/reset",
    ({ body, request }) =>
      pipelineStream(async (emit, signal) => {
        emit({ kind: "start", at: new Date().toISOString() });
        const path = configPath(body.configName);
        const config = applyOnlyProviders(
          await loadConfig(path),
          body.only ?? [],
        );
        return await runWithSignal(signal, () => runReset(config));
      }, request),
    { body: PipelineBody },
  )
  .post(
    "/cancel",
    ({ body }) => ({
      success: true as const,
      data: { cancelled: cancelActiveRun(body.id) },
    }),
    { body: CancelBody },
  );
