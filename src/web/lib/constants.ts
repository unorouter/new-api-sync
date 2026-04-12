import { CN, US } from "country-flag-icons/react/3x2";
import type { FunctionComponent, SVGAttributes } from "react";
import en from "@web/public/i18n/en.json";

/** Available locale codes. Must match JSON files in src/web/public/i18n/. */
export const LOCALES = ["en", "zh"] as const;
export type Locale = (typeof LOCALES)[number];

export const LANGUAGES: {
  code: Uppercase<Locale>;
  locale: Locale;
  Flag: FunctionComponent<SVGAttributes<SVGElement>>;
}[] = [
  { code: "EN", locale: "en", Flag: US },
  { code: "ZH", locale: "zh", Flag: CN },
];

/**
 * Keys of the English message catalog. All translation lookups are constrained
 * to these keys at compile time via the typed `useIntl()` wrapper in
 * `@web/lib/intl`. Other locales must implement the same key set.
 */
export type TranslationKey = keyof typeof en;

/**
 * Pass-through helper for declaring translation keys in non-React code.
 * Exists for symmetry with unorouter's `msg()` helper; the type guarantees
 * the argument is a valid key.
 */
export const msg = <T extends TranslationKey>(key: T): T => key;
