import { basename, dirname } from "node:path";

/**
 * Resolve the directory where `config.yml`, `config.global.yml`, and named
 * `config.<name>.yml` files live.
 *
 * Dev mode (`bun run`): use `process.cwd()` so configs stay next to the source
 * tree the developer is editing.
 *
 * Compiled single-file binary: use the directory of the binary itself so the
 * UI writes configs next to the executable, regardless of where it was
 * launched from (double-click, PATH, different cwd, etc.).
 */
export function configDir(): string {
  const exe = process.execPath;
  const exeName = basename(exe).toLowerCase();
  const isBunRuntime = exeName === "bun" || exeName.startsWith("bun.");
  if (isBunRuntime) return process.cwd();
  return dirname(exe);
}
