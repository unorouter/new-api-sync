import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Guards two runs on ONE machine. It lives in the temp dir, not logs/: the
// cluster mounts logs/ on a PVC shared by every Job, and a Job killed at its
// deadline left a lock there whose pid (1, the container's only process) is
// alive in every later container, so each nightly run died at start.
const lockPath = () => join(tmpdir(), "new-api-sync.lock");
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

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
    const age = Date.now() - statSync(path).mtimeMs;
    if (pid && isAlive(pid) && age < STALE_AFTER_MS)
      throw new Error(
        `another sync is already running (pid ${pid}); remove ${path} if stale`,
      );
  }
  writeFileSync(path, String(process.pid));
}

export function releaseSyncLock(): void {
  rmSync(lockPath(), { force: true });
}
