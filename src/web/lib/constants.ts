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
 * Dot-notation leaf paths of the English message catalog. Since the catalog
 * is nested (use-intl requirement), `"CONFIG.TITLE"` means `en.CONFIG.TITLE`.
 * All translation lookups are constrained to these paths at compile time via
 * the typed `useIntl()` wrapper in `@web/components/provider/intl-provider`.
 * Other locales must implement the same key set.
 */
type LeafPaths<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${K}`
    : LeafPaths<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type TranslationKey = LeafPaths<typeof en>;

/**
 * Pass-through helper for declaring translation keys in non-React code.
 * The type guarantees the argument is a valid key path.
 */
export const msg = <T extends TranslationKey>(key: T): T => key;
