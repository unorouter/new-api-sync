import type { GlobalConfigType } from "@core/validations/config";
import { rpc } from "@web/lib/rpc";
import { create } from "zustand";
import {
  createJSONStorage,
  persist,
  type StateStorage,
  type StorageValue,
} from "zustand/middleware";

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
  selectedConfigName: string;
  hasHydrated: boolean;
  /** Which pipeline mode the Start button will launch. */
  pipelineMode: PipelineMode;

  setMainTab: (tab: MainTab) => void;
  setHistoryTab: (tab: HistoryTab) => void;
  setSelectedRunId: (id: string | null) => void;
  setRunResultFilter: (filter: RunResultFilter) => void;
  setRunQuery: (query: string) => void;
  setKiroQuery: (query: string) => void;
  setSelectedConfigName: (name: string) => void;
  setHasHydrated: (hasHydrated: boolean) => void;
  setPipelineMode: (mode: PipelineMode) => void;
}

type PersistedUiState = Pick<
  UiStore,
  | "mainTab"
  | "historyTab"
  | "selectedRunId"
  | "runResultFilter"
  | "runQuery"
  | "kiroQuery"
  | "selectedConfigName"
  | "pipelineMode"
>;

const defaultPersistedUiState: PersistedUiState = {
  mainTab: "dashboard",
  historyTab: "runs",
  selectedRunId: null,
  runResultFilter: "all",
  runQuery: "",
  kiroQuery: "",
  selectedConfigName: "",
  pipelineMode: "run",
};

const globalConfigStorage: StateStorage = {
  getItem: async () => {
    const res = await rpc.api.config.global.get();
    if (res.error) return null;
    const globalConfig = res.data.data.config;

    const state: PersistedUiState = {
      ...defaultPersistedUiState,
      ...(globalConfig ?? {}),
      selectedConfigName: globalConfig.selectedConfigName ?? "",
    };

    const stored: StorageValue<PersistedUiState> = {
      state,
      version: 2,
    };
    return JSON.stringify(stored);
  },
  setItem: async (_name, value) => {
    const parsed = JSON.parse(value) as StorageValue<PersistedUiState>;
    const nextUi: PersistedUiState = {
      ...defaultPersistedUiState,
      ...(parsed.state ?? {}),
    };

    const currentRes = await rpc.api.config.global.get();
    const current: GlobalConfigType = currentRes.error
      ? {}
      : currentRes.data.data.config;

    await rpc.api.config.global.put({
      config: {
        ...current,
        ...nextUi,
      },
    });
  },
  removeItem: async () => {
    const currentRes = await rpc.api.config.global.get();
    const current: GlobalConfigType = currentRes.error
      ? {}
      : currentRes.data.data.config;
    await rpc.api.config.global.put({
      config: {
        ...current,
        ...defaultPersistedUiState,
      },
    });
  },
};

export const useUiStore = create<UiStore>()(
  persist(
    (set) => ({
      ...defaultPersistedUiState,
      hasHydrated: false,

      setMainTab: (mainTab) => set({ mainTab }),
      setHistoryTab: (historyTab) => set({ historyTab }),
      setSelectedRunId: (selectedRunId) => set({ selectedRunId }),
      setRunResultFilter: (runResultFilter) => set({ runResultFilter }),
      setRunQuery: (runQuery) => set({ runQuery }),
      setKiroQuery: (kiroQuery) => set({ kiroQuery }),
      setSelectedConfigName: (selectedConfigName) => set({ selectedConfigName }),
      setHasHydrated: (hasHydrated) => set({ hasHydrated }),
      setPipelineMode: (pipelineMode) => set({ pipelineMode }),
    }),
    {
      name: "new-api-sync-ui",
      version: 2,
      storage: createJSONStorage(() => globalConfigStorage),
      partialize: (state) => ({
        mainTab: state.mainTab,
        historyTab: state.historyTab,
        selectedRunId: state.selectedRunId,
        runResultFilter: state.runResultFilter,
        runQuery: state.runQuery,
        kiroQuery: state.kiroQuery,
        selectedConfigName: state.selectedConfigName,
        pipelineMode: state.pipelineMode,
      }),
      skipHydration: true,
      onRehydrateStorage: (state) => {
        state.setHasHydrated(false);
        return (nextState) => {
          nextState?.setHasHydrated(true);
        };
      },
    },
  ),
);
