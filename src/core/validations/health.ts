import { Type as T, type Static } from "@sinclair/typebox";

export const ProviderCountsSchema = T.Object({
  newapi: T.Number(),
  sub2api: T.Number(),
  direct: T.Number(),
  nvidia: T.Number(),
  total: T.Number(),
});

export const LastRunSchema = T.Union([
  T.Object({
    id: T.String(),
    timestamp: T.String(),
    total: T.Number(),
    passed: T.Number(),
    failed: T.Number(),
  }),
  T.Null(),
]);

export const HealthResponseSchema = T.Object({
  success: T.Literal(true),
  data: T.Object({
    ok: T.Boolean(),
    version: T.String(),
    uptime: T.Number(),
    startedAt: T.String(),
    runtime: T.Object({
      bun: T.String(),
      platform: T.String(),
      arch: T.String(),
      pid: T.Number(),
    }),
    memory: T.Object({
      rss: T.Number(),
      heapUsed: T.Number(),
      heapTotal: T.Number(),
    }),
    config: T.Object({
      files: T.Number(),
      selected: T.String(),
      providers: ProviderCountsSchema,
    }),
    lastRun: LastRunSchema,
    authenticityBlacklistSize: T.Number(),
    activeRuns: T.Array(T.String()),
  }),
});

export type HealthResponseType = Static<typeof HealthResponseSchema>;
export type HealthData = HealthResponseType["data"];
