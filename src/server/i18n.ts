import type { ConfigSchemaType } from "@core/validations/config";
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
 * Build a translator for a given request. Pass the already-loaded config
 * (or its `locale` field) so we don't re-read YAML on every translation.
 * Falls back to English if the locale is missing or unknown.
 */
export function translatorFor(
  configOrLocale: ConfigSchemaType | Locale | undefined,
) {
  const locale: Locale =
    typeof configOrLocale === "string"
      ? configOrLocale
      : (configOrLocale?.locale ?? "en");
  const safeLocale: Locale = locale in MESSAGES ? locale : "en";
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
 * Convenience: read the locale from the main config.yml (or a specific
 * config by path) without throwing. Returns "en" if anything fails.
 */
export async function readLocaleFromPath(path: string): Promise<Locale> {
  try {
    const file = Bun.file(path);
    if (!(file.size > 0)) return "en";
    const text = await file.text();
    const parsed = Bun.YAML.parse(text) as { locale?: unknown };
    const locale = parsed.locale;
    return locale === "zh" ? "zh" : "en";
  } catch {
    return "en";
  }
}
