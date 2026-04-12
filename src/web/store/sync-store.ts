import { create } from "zustand";

export type SyncMode = "run" | "test" | "reset";

export interface LogEntry {
  id: number;
  level: string;
  message: string;
}

export type SyncPhase = "idle" | "running" | "done" | "error";

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

export const useSyncStore = create<SyncStore>((set) => ({
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
}));
