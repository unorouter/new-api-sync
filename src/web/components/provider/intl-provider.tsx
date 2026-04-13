"use client";

import { useGlobalConfig } from "@web/hooks/global-config-hook";
import {
  LOCALES,
  MESSAGES,
  type Locale,
  type TranslationKey,
} from "@web/lib/constants";
import {
  IntlProvider as UseIntlProvider,
  useLocale as useUseIntlLocale,
  useTranslations,
} from "use-intl";

/**
 * Wraps the app in use-intl's provider. Locale is pulled from
 * `config.global.yml` so the chosen language is app-wide (not per-config).
 * While the query is loading we render against English so the tree never
 * flashes untranslated IDs; a locale change re-renders the whole subtree.
 */
export function IntlProvider(props: { children: React.ReactNode }) {
  const globalQuery = useGlobalConfig();
  const locale: Locale = globalQuery.data?.locale ?? LOCALES[0];

  return (
    <UseIntlProvider locale={locale} messages={MESSAGES[locale]}>
      {props.children}
    </UseIntlProvider>
  );
}

/**
 * Typed wrapper around use-intl's `useTranslations()`. All message keys
 * are constrained to `TranslationKey` (the dotted leaf paths of `en.json`),
 * so typos become compile errors.
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
