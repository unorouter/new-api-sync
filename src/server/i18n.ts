import en from "../web/public/i18n/en.json";
import zh from "../web/public/i18n/zh.json";
import { createTranslator } from "use-intl/core";

type Locale = "en" | "zh";
const MESSAGES: Record<Locale, typeof en> = { en, zh };

// Reuse the frontend's key surface. A recursive dotted-path type so
// `t("SERVER.CONFIG_NOT_FOUND")` is checked at compile time.
type LeafPaths<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${K}`
    : LeafPaths<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type ServerTranslationKey = LeafPaths<typeof en>;

/**
 * Build a translator for the given locale. Falls back to English if the
 * locale is missing or unknown. The locale is sourced from
 * `config.global.yml` via `readLocaleFromGlobal()`.
 */
export function translatorFor(locale: Locale | undefined) {
  const safeLocale: Locale =
    locale && locale in MESSAGES ? locale : "en";
  const t = createTranslator({
    locale: safeLocale,
    messages: MESSAGES[safeLocale],
  });
  return (
    key: ServerTranslationKey,
    values?: Record<string, string | number>,
  ) => t(key, values);
}

/**
 * Convenience: read the UI locale from `config.global.yml` without throwing.
 * Returns "en" if the file is missing, malformed, or has no `locale` field.
 */
export async function readLocaleFromGlobal(): Promise<Locale> {
  try {
    const file = Bun.file("./config.global.yml");
    if (!(await file.exists())) return "en";
    const text = await file.text();
    const parsed = Bun.YAML.parse(text) as { locale?: unknown } | null;
    const locale = parsed?.locale;
    return locale === "zh" ? "zh" : "en";
  } catch {
    return "en";
  }
}
