import type { GlobalConfigType } from "@core/validations/config";
import { rpc } from "@web/lib/rpc";
import type {
  HistoryTab,
  Locale,
  MainTab,
  PipelineMode,
  RunResultFilter,
  Theme,
} from "@web/types";
import { create } from "zustand";
import {
  createJSONStorage,
  persist,
  type StateStorage,
  type StorageValue,
} from "zustand/middleware";

export interface UiStore {
  locale: Locale;
  theme: Theme;
  mainTab: MainTab;
  historyTab: HistoryTab;
  selectedRunId: string | null;
  runResultFilter: RunResultFilter;
  runQuery: string;
  kiroQuery: string;
  selectedConfigName: string;
  pipelineMode: PipelineMode;

  setLocale: (locale: Locale) => void;
  setTheme: (theme: Theme) => void;
  setMainTab: (tab: MainTab) => void;
  setHistoryTab: (tab: HistoryTab) => void;
  setSelectedRunId: (id: string | null) => void;
  setRunResultFilter: (filter: RunResultFilter) => void;
  setRunQuery: (query: string) => void;
  setKiroQuery: (query: string) => void;
  setSelectedConfigName: (name: string) => void;
  setPipelineMode: (mode: PipelineMode) => void;
}

export type PersistedUiState = Pick<
  UiStore,
  | "locale"
  | "theme"
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
  locale: "en",
  theme: "system",
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
      version: 1,
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
      setLocale: (locale) => set({ locale }),
      setTheme: (theme) => set({ theme }),
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
    {
      name: "new-api-sync-ui",
      version: 1,
      storage: createJSONStorage(() => globalConfigStorage),
      partialize: (state) => ({
        locale: state.locale,
        theme: state.theme,
        mainTab: state.mainTab,
        historyTab: state.historyTab,
        selectedRunId: state.selectedRunId,
        runResultFilter: state.runResultFilter,
        runQuery: state.runQuery,
        kiroQuery: state.kiroQuery,
        selectedConfigName: state.selectedConfigName,
        pipelineMode: state.pipelineMode,
      }),
    },
  ),
);
