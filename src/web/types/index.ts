import type { LocaleValue, ThemeValue } from "@core/validations/config";

export type SyncMode = "run" | "reset";

export interface LogEntry {
  id: number;
  level: string;
  message: string;
}

export type SyncPhase = "idle" | "running" | "done" | "error";
export type MainTab = "dashboard" | "config" | "history";
export type HistoryTab = "runs" | "authenticity";
export type RunResultFilter = "all" | "passed" | "failed";
export type PipelineMode = "run" | "reset";
export type Locale = LocaleValue;
export type Theme = ThemeValue;
