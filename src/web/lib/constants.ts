import en from "@web/public/i18n/en.json";
import zh from "@web/public/i18n/zh.json";
import { CN, US } from "country-flag-icons/react/3x2";
import type { FunctionComponent, SVGAttributes } from "react";
import type { useTranslations } from "use-intl";

export const LOCALES = ["en", "zh"] as const;
export type Locale = (typeof LOCALES)[number];

/**
 * Message catalogs keyed by locale. `zh` is typed against `en`'s shape so the
 * build fails if a key is missing.
 */
export const MESSAGES: Record<Locale, typeof en> = { en, zh };

export const LANGUAGES: {
  code: Uppercase<Locale>;
  locale: Locale;
  Flag: FunctionComponent<SVGAttributes<SVGElement>>;
}[] = [
  { code: "EN", locale: "en", Flag: US },
  { code: "ZH", locale: "zh", Flag: CN },
];

export type TranslationKey = Parameters<
  ReturnType<typeof useTranslations<never>>
>[0];

/**
 * Pass-through helper for declaring translation keys in non-React code.
 * The type guarantees the argument is a valid key path.
 */
export const msg = (key: TranslationKey): TranslationKey => key;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m ${Math.floor(seconds % 60)}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}
