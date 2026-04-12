import { Elysia, t } from "elysia";

const ResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    ok: t.Boolean(),
    version: t.String(),
    uptime: t.Number(),
  }),
});

const VERSION = "0.1.0";

export const healthRoute = new Elysia({ prefix: "/health" }).get(
  "/",
  () => ({
    success: true as const,
    data: {
      ok: true,
      version: VERSION,
      uptime: process.uptime(),
    },
  }),
  { response: ResponseSchema },
);
