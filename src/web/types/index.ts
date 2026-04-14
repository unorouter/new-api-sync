import type { LocaleValue, ThemeValue } from "@core/validations/config";

export type SyncMode = "run" | "test" | "reset";

export interface LogEntry {
  id: number;
  level: string;
  message: string;
}

export type SyncPhase = "idle" | "running" | "done" | "error";
export type MainTab = "dashboard" | "config" | "history";
export type HistoryTab = "runs" | "kiro";
export type RunResultFilter = "all" | "passed" | "failed";
export type PipelineMode = "run" | "test" | "reset";
export type Locale = LocaleValue;
export type Theme = ThemeValue;
