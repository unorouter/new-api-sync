#!/usr/bin/env bun
/**
 * Produce the release artifacts under `dist/`:
 *
 *  1. Frontend bundle    → `dist/public/`          (html + chunked js + css)
 *  2. Server + CLI JS    → `dist/new-api-sync.js`  (single file, all deps inlined)
 *  3. Compiled binary    → `dist/new-api-sync`     (single file, embeds bun runtime)
 *
 * At runtime both (2) and (3) expect a `./public/` dir next to them containing
 * the frontend bundle. See `resolveAssetsDir` in `src/server/route.ts`.
 */
import { rm } from "node:fs/promises";
import tailwindPlugin from "bun-plugin-tailwind";

const DIST = "dist";
const PUBLIC_OUT = `${DIST}/public`;
const JS_OUT = `${DIST}/new-api-sync.js`;
const BIN_OUT = `${DIST}/new-api-sync`;
const CLI_ENTRY = "src/cli/index.ts";

await rm(DIST, { recursive: true, force: true });

// ─── 1. Frontend bundle ──────────────────────────────────────────────────────

console.log("• bundling frontend...");
const frontend = await Bun.build({
  entrypoints: ["src/ui/public/index.html"],
  outdir: PUBLIC_OUT,
  target: "browser",
  minify: true,
  sourcemap: "linked",
  plugins: [tailwindPlugin],
});
if (!frontend.success) {
  console.error(frontend.logs);
  process.exit(1);
}
console.log(`  ${frontend.outputs.length} assets → ${PUBLIC_OUT}`);

// ─── 2. Server + CLI JS bundle (single file, all deps inlined) ───────────────

console.log("• bundling server+cli to single js...");
const server = await Bun.build({
  entrypoints: [CLI_ENTRY],
  outdir: DIST,
  naming: "new-api-sync.js",
  target: "bun",
  format: "esm",
  minify: true,
  // Inline every npm dep. node:* builtins stay external automatically.
  packages: "bundle",
});
if (!server.success) {
  console.error(server.logs);
  process.exit(1);
}
const jsBytes = server.outputs[0]?.size ?? 0;
console.log(`  ${JS_OUT} (${(jsBytes / 1024 / 1024).toFixed(2)} MB)`);

// ─── 3. Compiled binary ──────────────────────────────────────────────────────

console.log("• compiling binary...");
const result = await Bun.spawn({
  cmd: [
    "bun",
    "build",
    "--compile",
    "--target=bun",
    "--minify",
    CLI_ENTRY,
    "--outfile",
    BIN_OUT,
  ],
  stdout: "inherit",
  stderr: "inherit",
}).exited;
if (result !== 0) process.exit(result);

console.log("\n✓ build complete");
console.log(`  binary:   ${BIN_OUT} ui --port 3000`);
console.log(`  js:       bun ${JS_OUT} ui --port 3000`);
console.log(`  frontend: ${PUBLIC_OUT}/ (must sit next to binary/js at runtime)`);
