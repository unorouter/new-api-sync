import { staticPlugin } from "@elysiajs/static";
import { existsSync } from "node:fs";
import { Elysia } from "elysia";
import { configRoute } from "./config/route";
import { embeddedAssetPaths } from "./embedded-assets";
import { healthRoute } from "./health/route";
import { resetRoute } from "./reset/route";
import { runRoute } from "./run/route";
import { testRoute } from "./test/route";

// `embeddedAssetPaths` is populated at build time by src/build.ts with static
// `import ... with { type: "file" }` entries. Those imports tell
// `bun build --compile` to bundle each asset into the binary. The stub version
// checked into git is empty, so dev mode falls through to disk-based serving.

/**
 * Register routes for frontend assets.
 *
 * - **compiled binary**: `embeddedAssetPaths` is populated, so we register
 *   one GET handler per embedded file. Nothing is read from disk.
 * - **dev / js bundle**: fall back to `@elysiajs/static` pointing at whichever
 *   `public/` dir exists relative to cwd.
 */
function mountAssets(app: Elysia) {
  if (embeddedAssetPaths.length > 0) {
    for (const [name, path] of embeddedAssetPaths) {
      const route = name === "index.html" ? "/" : `/${name}`;
      app.get(route, () => Bun.file(path));
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
 * - Frontend assets served either from embedded bundles (native binary) or
 *   from disk (dev / js bundle).
 * - API routes live under `/api/*`.
 */
export const app = mountAssets(new Elysia()).group("/api", (api) =>
  api
    .use(healthRoute)
    .use(configRoute)
    .use(resetRoute)
    .use(runRoute)
    .use(testRoute),
);

export type App = typeof app;

// Boot when run directly (bun run src/server/route.ts) or via the CLI's `ui`
// subcommand. When imported as a library (eden client), nothing happens.
if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port);
  console.log(`new-api-sync UI running at http://localhost:${port}`);
}
