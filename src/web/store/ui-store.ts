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

export interface UiState {
  locale: Locale;
  theme: Theme;
  mainTab: MainTab;
  historyTab: HistoryTab;
  selectedRunId: string | null;
  runResultFilter: RunResultFilter;
  runQuery: string;
  authenticityQuery: string;
  selectedConfigName: string;
  pipelineMode: PipelineMode;
  verbose: boolean;
  onlyProviders: Record<string, string[]>;
  modelFilter: Record<string, string>;
}

export interface UiActions {
  setLocale: (locale: Locale) => void;
  setTheme: (theme: Theme) => void;
  setMainTab: (tab: MainTab) => void;
  setHistoryTab: (tab: HistoryTab) => void;
  setSelectedRunId: (id: string | null) => void;
  setRunResultFilter: (filter: RunResultFilter) => void;
  setRunQuery: (query: string) => void;
  setAuthenticityQuery: (query: string) => void;
  setSelectedConfigName: (name: string) => void;
  setPipelineMode: (mode: PipelineMode) => void;
  setVerbose: (verbose: boolean) => void;
  setOnlyProviders: (providers: string[]) => void;
  setModelFilter: (value: string) => void;
}

export type UiStore = UiState & UiActions;

const defaultPersistedUiState: UiState = {
  locale: "en",
  theme: "system",
  mainTab: "dashboard",
  historyTab: "runs",
  selectedRunId: null,
  runResultFilter: "all",
  runQuery: "",
  authenticityQuery: "",
  selectedConfigName: "",
  pipelineMode: "run",
  verbose: false,
  onlyProviders: {},
  modelFilter: {},
};

const globalConfigStorage: StateStorage = {
  getItem: async () => {
    const res = await rpc.api.config.global.get();
    if (res.error) return null;
    const globalConfig = res.data.data.config;

    const state: UiState = {
      ...defaultPersistedUiState,
      ...(globalConfig ?? {}),
      selectedConfigName: globalConfig.selectedConfigName ?? "",
    };

    const stored: StorageValue<UiState> = {
      state,
      version: 1,
    };
    return JSON.stringify(stored);
  },
  setItem: async (_name, value) => {
    const parsed = JSON.parse(value) as StorageValue<UiState>;
    const nextUi: UiState = {
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
      setAuthenticityQuery: (authenticityQuery) => set({ authenticityQuery }),
      setSelectedConfigName: (selectedConfigName) =>
        set({ selectedConfigName }),
      setPipelineMode: (pipelineMode) => set({ pipelineMode }),
      setVerbose: (verbose) => set({ verbose }),
      setOnlyProviders: (providers) =>
        set((state) => ({
          onlyProviders: {
            ...state.onlyProviders,
            [state.selectedConfigName]: providers,
          },
        })),
      setModelFilter: (value) =>
        set((state) => ({
          modelFilter: {
            ...state.modelFilter,
            [state.selectedConfigName]: value,
          },
        })),
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
        authenticityQuery: state.authenticityQuery,
        selectedConfigName: state.selectedConfigName,
        pipelineMode: state.pipelineMode,
        verbose: state.verbose,
        onlyProviders: state.onlyProviders,
        modelFilter: state.modelFilter,
      }),
    },
  ),
);
