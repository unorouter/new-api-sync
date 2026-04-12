import { staticPlugin } from "@elysiajs/static";
import { existsSync } from "node:fs";
import { Elysia } from "elysia";
import { cancelRoute } from "./cancel/route";
import { configRoute } from "./config/route";
import { embeddedAssets } from "./embedded-assets";
import { healthRoute } from "./health/route";
import { historyRoute } from "./history/route";
import { resetRoute } from "./reset/route";
import { runRoute } from "./run/route";
import { testRoute } from "./test/route";

// `embeddedAssets` is populated at build time by src/build.ts with base64
// bytes of every file in dist/public/. The stub checked into git is empty,
// so dev falls through to disk-based serving via @elysiajs/static.

/**
 * Register routes for frontend assets.
 *
 * - **production** (compiled binary or js bundle): serve from in-memory bytes
 *   decoded once at startup. No disk, no separate public/ dir.
 * - **dev**: serve from `src/web/public/` via `@elysiajs/static` (Bun fullstack
 *   mode transpiles index.html + tsx on the fly).
 */
function mountAssets(app: Elysia) {
  if (embeddedAssets.length > 0) {
    const bodies = new Map<string, ArrayBuffer>();
    for (const asset of embeddedAssets) {
      const binary = atob(asset.base64);
      const buf = new ArrayBuffer(binary.length);
      const view = new Uint8Array(buf);
      for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
      bodies.set(asset.path, buf);
    }
    for (const asset of embeddedAssets) {
      const route = asset.path === "index.html" ? "/" : `/${asset.path}`;
      const body = bodies.get(asset.path)!;
      app.get(
        route,
        () =>
          new Response(body, {
            headers: { "content-type": asset.contentType },
          }),
      );
    }
    return app;
  }
  const assetsDir = existsSync("./src/web/public")
    ? "src/web/public"
    : "public";
  return app.use(staticPlugin({ prefix: "/", assets: assetsDir }));
}

/**
 * Main Elysia app.
 *
 * - Frontend assets served from embedded base64 bytes (prod) or disk (dev).
 * - API routes live under `/api/*`.
 */
export const app = mountAssets(new Elysia()).group("/api", (api) =>
  api
    .use(healthRoute)
    .use(configRoute)
    .use(historyRoute)
    .use(resetRoute)
    .use(runRoute)
    .use(testRoute)
    .use(cancelRoute),
);

export type App = typeof app;

// Boot when run directly (bun run src/server/route.ts) or via the CLI's `ui`
// subcommand. When imported as a library (eden client), nothing happens.
if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port);
  console.log(`new-api-sync UI running at http://localhost:${port}`);
}
