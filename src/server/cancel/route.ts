import { cancelActiveRun } from "@server/active-runs";
import { Elysia, t } from "elysia";

const BodySchema = t.Object({ id: t.String() });

/**
 * POST /api/cancel
 *
 * Abort an in-flight pipeline identified by the run id that was delivered to
 * the client on the SSE `event: run` payload. Returns `{ cancelled: true }`
 * if we found and aborted it, `{ cancelled: false }` if the run already
 * finished or the id is unknown. Intentionally idempotent so double-clicks
 * are harmless.
 */
export const cancelRoute = new Elysia({ prefix: "/cancel" }).post(
  "/",
  ({ body }) => ({
    success: true as const,
    data: { cancelled: cancelActiveRun(body.id) },
  }),
  { body: BodySchema },
);
