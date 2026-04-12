import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Persistent UI state — tabs + filters that should survive a page refresh.
 * Mirrors what the user was looking at so they land back where they were.
 *
 * Does not hold server data. Non-persistent ephemeral state (sync logs,
 * dialog open/close) lives in other stores or local useState.
 */

export type MainTab = "dashboard" | "config" | "history";
export type HistoryTab = "runs" | "kiro";
export type RunResultFilter = "all" | "passed" | "failed";
export type PipelineMode = "run" | "test" | "reset";

interface UiStore {
  mainTab: MainTab;
  historyTab: HistoryTab;
  /** `null` = show run list; string = show run detail for that id */
  selectedRunId: string | null;
  runResultFilter: RunResultFilter;
  runQuery: string;
  kiroQuery: string;
  /** Name of the active config file; "" = main (config.yml), else config.<name>.yml */
  selectedConfigName: string;
  /** Which pipeline mode the Start button will launch. */
  pipelineMode: PipelineMode;

  setMainTab: (tab: MainTab) => void;
  setHistoryTab: (tab: HistoryTab) => void;
  setSelectedRunId: (id: string | null) => void;
  setRunResultFilter: (filter: RunResultFilter) => void;
  setRunQuery: (query: string) => void;
  setKiroQuery: (query: string) => void;
  setSelectedConfigName: (name: string) => void;
  setPipelineMode: (mode: PipelineMode) => void;
}

export const useUiStore = create<UiStore>()(
  persist(
    (set) => ({
      mainTab: "dashboard",
      historyTab: "runs",
      selectedRunId: null,
      runResultFilter: "all",
      runQuery: "",
      kiroQuery: "",
      selectedConfigName: "",
      pipelineMode: "run",

      setMainTab: (mainTab) => set({ mainTab }),
      setHistoryTab: (historyTab) => set({ historyTab }),
      setSelectedRunId: (selectedRunId) => set({ selectedRunId }),
      setRunResultFilter: (runResultFilter) => set({ runResultFilter }),
      setRunQuery: (runQuery) => set({ runQuery }),
      setKiroQuery: (kiroQuery) => set({ kiroQuery }),
      setSelectedConfigName: (selectedConfigName) =>
        set({ selectedConfigName }),
      setPipelineMode: (pipelineMode) => set({ pipelineMode }),
    }),
    { name: "new-api-sync-ui" },
  ),
);
