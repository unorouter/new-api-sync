import { logsDir } from "@core/infra/paths";
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const lockPath = () => join(logsDir(), "sync.lock");

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireSyncLock(): void {
  const path = lockPath();
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, "utf8").trim());
    if (pid && isAlive(pid))
      throw new Error(
        `another sync is already running (pid ${pid}); remove ${path} if stale`,
      );
  }
  writeFileSync(path, String(process.pid));
}

export function releaseSyncLock(): void {
  rmSync(lockPath(), { force: true });
}
