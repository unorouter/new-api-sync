"use client";

import { useGlobalConfig } from "@web/hooks/global-config-hook";
import { LOCALES, MESSAGES, type Locale } from "@web/lib/constants";
import { IntlProvider as UseIntlProvider } from "use-intl";

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

