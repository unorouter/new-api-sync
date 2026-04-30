import { applyModelFilter, applyOnlyProviders, loadConfig } from "@core/config";
import { runWithSignal } from "@core/runtime";
import { runReset } from "@core/sync/reset";
import { runSync } from "@core/sync/run";
import { CancelBody, PipelineBody } from "@core/validations/pipeline";
import { configPath } from "@server/config/route";
import { cancelActiveRun, pipelineStream } from "@server/sse";
import { Elysia } from "elysia";

export const pipelineRoute = new Elysia({ prefix: "/pipeline" })
  .post(
    "/run",
    ({ body, request }) =>
      pipelineStream(
        async (signal) => {
          const path = configPath(body.configName);
          const config = applyModelFilter(
            applyOnlyProviders(await loadConfig(path), body.only ?? []),
            body.models ?? [],
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
        },
        request,
        { verbose: body.verbose },
      ),
    { body: PipelineBody },
  )
  .post(
    "/reset",
    ({ body, request }) =>
      pipelineStream(
        async (signal) => {
          const path = configPath(body.configName);
          const only = body.only ?? [];
          const config = applyModelFilter(
            applyOnlyProviders(await loadConfig(path), only),
            body.models ?? [],
          );
          return await runWithSignal(signal, () =>
            runReset(config, { onlyProviders: only.length > 0 }),
          );
        },
        request,
        { verbose: body.verbose },
      ),
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
