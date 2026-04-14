import type { LogEntry, SyncMode, SyncPhase } from "@web/types";
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SyncStore {
  mode: SyncMode | null;
  phase: SyncPhase;
  logs: LogEntry[];
  result: unknown | null;
  error: string | null;
  nextId: number;

  start: (mode: SyncMode) => void;
  addLog: (level: string, message: string) => void;
  finish: (result: unknown) => void;
  fail: (message: string) => void;
  reset: () => void;
}

/**
 * The sync store is persisted so a refresh preserves recent output. Note that
 * an interrupted `running` phase will *stay* running across the refresh because
 * the SSE stream is gone. The user can click Reset (or start a new run) to
 * clear it — that's what `reset()` is for.
 */
export const useSyncStore = create<SyncStore>()(
  persist(
    (set) => ({
      mode: null,
      phase: "idle",
      logs: [],
      result: null,
      error: null,
      nextId: 0,

      start: (mode) =>
        set({
          mode,
          phase: "running",
          logs: [],
          result: null,
          error: null,
          nextId: 0,
        }),
      addLog: (level, message) =>
        set((state) => ({
          logs: [...state.logs, { id: state.nextId, level, message }],
          nextId: state.nextId + 1,
        })),
      finish: (result) => set({ phase: "done", result }),
      fail: (message) => set({ phase: "error", error: message }),
      reset: () =>
        set({
          mode: null,
          phase: "idle",
          logs: [],
          result: null,
          error: null,
          nextId: 0,
        }),
    }),
    { name: "new-api-sync-run" },
  ),
);
