import { configDir } from "@core/paths";
import { LOCALES, type TranslationKey } from "@web/lib/constants";
import en from "@web/public/i18n/en.json";
import zh from "@web/public/i18n/zh.json";
import { join } from "node:path";
import { createTranslator, type Locale } from "use-intl/core";

const MESSAGES: Record<Locale, typeof en> = { en, zh };

let currentLocale: Locale = LOCALES[0];

function buildTranslator(locale: Locale) {
  const raw = createTranslator({ locale, messages: MESSAGES[locale] });
  return (key: TranslationKey, values?: Record<string, string | number>) =>
    raw(key, values);
}

let translator = buildTranslator(LOCALES[0]);

export const t = (
  key: TranslationKey,
  values?: Record<string, string | number>,
) => translator(key, values);

/** Set the active locale. Call once at startup (CLI/server). */
export function setLocale(locale: Locale): void {
  if (locale === currentLocale) return;
  currentLocale = locale;
  translator = buildTranslator(locale);
}

/** Read locale from config.global.yml. */
export async function readLocaleFromGlobal(): Promise<Locale> {
  try {
    const file = Bun.file(join(configDir(), "config.global.yml"));
    if (!(await file.exists())) return LOCALES[0];
    const text = await file.text();
    const parsed = Bun.YAML.parse(text) as { locale?: Locale } | null;
    const locale = parsed?.locale;
    return locale!;
  } catch {
    return LOCALES[0];
  }
}
