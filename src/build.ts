#!/usr/bin/env bun
/**
 * Produce the release artifacts under `dist/`:
 *
 *  1. Frontend bundle → `dist/public/`       (html + js + css, tailwind compiled)
 *  2. JS bundle       → `dist/new-api-sync.js` (single file, all deps inlined)
 *  3. Binaries        → `dist/new-api-sync[-<target>]` (native, embeds bun runtime)
 *
 * Binary targets can be passed as CLI args. The bare "bun" target produces
 * `dist/new-api-sync` (for the current host); anything else produces
 * `dist/new-api-sync-<target>`. Defaults to just the host target.
 *
 *   bun run src/build.ts                              # host binary only
 *   bun run src/build.ts bun-linux-x64 bun-darwin-arm64  # cross-compile
 *   bun run src/build.ts --all                        # linux-x64 + linux-arm64 + darwin-arm64
 *
 * At runtime (2) and (3) expect a `./public/` dir next to them.
 */
import { rm } from "node:fs/promises";
import tailwindPlugin from "bun-plugin-tailwind";

const DIST = "dist";
const PUBLIC_OUT = `${DIST}/public`;
const JS_OUT = `${DIST}/new-api-sync.js`;
const CLI_ENTRY = "src/cli/index.ts";

// The supported release targets for `--all`.
const RELEASE_TARGETS = ["bun-linux-x64", "bun-linux-arm64", "bun-darwin-arm64"];

function parseTargets(argv: string[]): string[] {
  const args = argv.slice(2);
  if (args.includes("--all")) return RELEASE_TARGETS;
  const explicit = args.filter((a) => a.startsWith("bun-") || a === "bun");
  if (explicit.length > 0) return explicit;
  return ["bun"]; // host default
}

function outfileFor(target: string): string {
  if (target === "bun") return `${DIST}/new-api-sync`;
  const suffix = target.replace(/^bun-/, "");
  return `${DIST}/new-api-sync-${suffix}`;
}

const targets = parseTargets(process.argv);

await rm(DIST, { recursive: true, force: true });

// ─── 0. Typecheck ────────────────────────────────────────────────────────────
// `bun build` strips types without checking them, so we gate the build on a
// real tsc pass. Without this, type-broken code can ship to production.

console.log("• typechecking...");
const tsc = await Bun.spawn({
  cmd: ["bun", "run", "tsc", "--noEmit"],
  stdout: "inherit",
  stderr: "inherit",
}).exited;
if (tsc !== 0) {
  console.error("typecheck failed");
  process.exit(tsc);
}

// ─── 1. Frontend bundle ──────────────────────────────────────────────────────

console.log("• bundling frontend...");
const frontend = await Bun.build({
  entrypoints: ["src/web/public/index.html"],
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

// ─── 3. Compiled binaries (host + any cross-compile targets) ─────────────────

for (const target of targets) {
  const outfile = outfileFor(target);
  console.log(`• compiling binary (${target})...`);
  const result = await Bun.spawn({
    cmd: [
      "bun",
      "build",
      "--compile",
      `--target=${target}`,
      "--minify",
      CLI_ENTRY,
      `--outfile=${outfile}`,
    ],
    stdout: "inherit",
    stderr: "inherit",
  }).exited;
  if (result !== 0) process.exit(result);
}

console.log("\n✓ build complete");
for (const target of targets) {
  console.log(`  ${outfileFor(target)}`);
}
console.log(`  ${JS_OUT}`);
console.log(`  ${PUBLIC_OUT}/ (must sit next to binary/js at runtime)`);
