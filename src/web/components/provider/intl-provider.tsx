"use client";

import { LOCALES, MESSAGES } from "@web/lib/constants";
import { useUiStore } from "@web/store/ui-store";
import { IntlProvider as UseIntlProvider } from "use-intl";

/**
 * Wraps the app in use-intl's provider. Locale is sourced from ui-store,
 * which is persisted through `config.global.yml` via globalConfigStorage.
 */
export function IntlProvider(props: { children: React.ReactNode }) {
  const locale = useUiStore((state) => state.locale) ?? LOCALES[0];

  return (
    <UseIntlProvider locale={locale} messages={MESSAGES[locale]}>
      {props.children}
    </UseIntlProvider>
  );
}
