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
 *
 * `@core/config` is imported by the browser bundle (for `customValidateConfig`)
 * which has no `process`. Guard every `process` access so calling this from
 * the browser returns a harmless empty string instead of throwing.
 */
export function configDir(): string {
  if (typeof process === "undefined") return "";
  const exe = process.execPath;
  const exeName = basename(exe).toLowerCase();
  const isBunRuntime = exeName === "bun" || exeName.startsWith("bun.");
  if (isBunRuntime) return process.cwd();
  return dirname(exe);
}
