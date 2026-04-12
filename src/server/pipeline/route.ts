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

export const pipelineRoute = new Elysia({ prefix: "/pipeline" })
  .post(
    "/run",
    ({ body, request }) =>
      pipelineStream(async (signal) => {
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
      pipelineStream(async (signal) => {
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
      pipelineStream(async (signal) => {
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
