import { Elysia, t } from "elysia";
import pkg from "../../../package.json" with { type: "json" };

const ResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    ok: t.Boolean(),
    version: t.String(),
    uptime: t.Number(),
  }),
});

export const healthRoute = new Elysia({ prefix: "/health" }).get(
  "/",
  () => ({
    success: true as const,
    data: {
      ok: true,
      version: pkg.version,
      uptime: process.uptime(),
    },
  }),
  { response: ResponseSchema },
);
