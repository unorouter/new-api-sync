import { staticPlugin } from "@elysiajs/static";
import { existsSync } from "node:fs";
import { Elysia } from "elysia";
import { configRoute } from "./config/route";
import { healthRoute } from "./health/route";
import { resetRoute } from "./reset/route";
import { runRoute } from "./run/route";
import { testRoute } from "./test/route";

/**
 * Resolve the directory the static plugin should serve the frontend from.
 *
 * - **dev** (`bun run src/server/route.ts`): sources live at `src/ui/public/`
 *   and Bun's fullstack bundler transpiles `index.html` + `index.tsx` on the fly.
 * - **prod** (compiled binary): `scripts/build-binary.ts` bundles the frontend
 *   into `./public/` next to the binary, which is the default cwd path.
 *
 * We pick whichever exists.
 */
function resolveAssetsDir(): string {
  if (existsSync("./src/ui/public")) return "src/ui/public";
  return "public";
}

/**
 * Main Elysia app.
 *
 * - `@elysiajs/static` serves the frontend entry dir as a Bun fullstack dev
 *   server in development (with HMR) or as static assets in a compiled binary.
 * - API routes live under `/api/*`.
 */
export const app = new Elysia()
  .use(await staticPlugin({ prefix: "/", assets: resolveAssetsDir() }))
  .group("/api", (api) =>
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
