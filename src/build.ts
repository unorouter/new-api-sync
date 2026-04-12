#!/usr/bin/env bun
/**
 * Release build. Produces:
 *   dist/public/           — frontend (tailwind compiled)
 *   dist/new-api-sync.js   — portable js bundle (deps inlined)
 *   dist/new-api-sync-<t>  — native binary per target
 *
 * The js bundle and binaries expect `./public/` next to them at runtime.
 */
import tailwindPlugin from "bun-plugin-tailwind";
import { rm } from "node:fs/promises";

const DIST = "dist";
const ENTRY = "src/cli/index.ts";
const TARGETS = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
  "bun-windows-x64",
  "bun-windows-arm64"
];

const binaryPath = (t: string) =>
  `${DIST}/new-api-sync-${t.replace(/^bun-/, "")}${t.includes("windows") ? ".exe" : ""}`;

const run = async (cmd: string[]) => {
  const code = await Bun.spawn({ cmd, stdout: "inherit", stderr: "inherit" })
    .exited;
  if (code !== 0) process.exit(code);
};

const build = async (options: Parameters<typeof Bun.build>[0]) => {
  const result = await Bun.build(options);
  if (result.success) return;
  console.error(result.logs);
  process.exit(1);
};

await rm(DIST, { recursive: true, force: true });

console.log("• typecheck");
await run(["bun", "run", "tsc", "--noEmit"]);

console.log("• frontend");
await build({
  entrypoints: ["src/web/public/index.html"],
  outdir: `${DIST}/public`,
  target: "browser",
  minify: true,
  sourcemap: "linked",
  plugins: [tailwindPlugin]
});

console.log("• js bundle");
await build({
  entrypoints: [ENTRY],
  outdir: DIST,
  naming: "new-api-sync.js",
  target: "bun",
  format: "esm",
  minify: true,
  packages: "bundle"
});

for (const target of TARGETS) {
  console.log(`• binary ${target}`);
  await run([
    "bun",
    "build",
    "--compile",
    `--target=${target}`,
    "--minify",
    ENTRY,
    `--outfile=${binaryPath(target)}`
  ]);
}

console.log("✓ done");
