"use client";

import en from "@web/public/i18n/en.json";
import zh from "@web/public/i18n/zh.json";
import { type Locale, type TranslationKey } from "@web/lib/constants";
import { useConfigLocale } from "@web/hooks/config-hook";
import { useUiStore } from "@web/store/ui-store";
import {
  IntlProvider as UseIntlProvider,
  useTranslations,
  useLocale as useUseIntlLocale,
} from "use-intl";

// --- Message catalogs ----------------------------------------------------
// `zh` is typed against `en`'s shape so the build fails if a key is missing.
const MESSAGES: Record<Locale, typeof en> = { en, zh };

/**
 * Wraps the app in use-intl's provider. The locale is pulled from the
 * currently-selected config via `useConfigLocale`. While the config is
 * loading we render children against `en` so the tree never flashes
 * untranslated IDs, and a locale change re-renders the whole subtree.
 */
export function IntlProvider(props: { children: React.ReactNode }) {
  const selectedName = useUiStore((s) => s.selectedConfigName);
  const localeQuery = useConfigLocale(selectedName);
  const locale: Locale = localeQuery.data ?? "en";

  return (
    <UseIntlProvider locale={locale} messages={MESSAGES[locale]}>
      {props.children}
    </UseIntlProvider>
  );
}

// --- Typed intl helpers --------------------------------------------------
/**
 * Typed wrapper around use-intl's `useTranslations()`. All message keys
 * are constrained to `TranslationKey` (the dotted leaf paths of `en.json`),
 * so typos become compile errors.
 *
 * Usage:
 *   const { t } = useIntl();
 *   t("CONFIG.TITLE");
 *   t("HEALTH.ERROR", { error: "boom" });
 */
export function useIntl() {
  const t = useTranslations();
  const locale = useUseIntlLocale() as Locale;
  return {
    locale,
    t: (
      key: TranslationKey,
      values?: Record<string, string | number | undefined>,
    ) => t(key, values as Record<string, string | number>),
  };
}
