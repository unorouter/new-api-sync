"use client";

import { createContext, useContext, useState, type ComponentProps } from "react";
import {
  FormattedMessage as ReactFormattedMessage,
  IntlProvider as ReactIntlProvider,
  useIntl as useReactIntl,
} from "react-intl";
import en from "@web/public/i18n/en.json";
import zh from "@web/public/i18n/zh.json";
import { LOCALES, type Locale, type TranslationKey } from "@web/lib/constants";

// --- Message catalogs ----------------------------------------------------
// `zh` is typed against `en`'s shape so the build fails if a key is missing.
const MESSAGES: Record<Locale, typeof en> = { en, zh };

// --- Locale context ------------------------------------------------------
const STORAGE_KEY = "new-api-sync-locale";

type LocaleState = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
};

const LocaleContext = createContext<LocaleState | null>(null);

function isLocale(value: string | null): value is Locale {
  return LOCALES.includes(value as Locale);
}

function initialLocale(): Locale {
  if (typeof window === "undefined") return "en";
  const stored = localStorage.getItem(STORAGE_KEY);
  if (isLocale(stored)) return stored;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function IntlProvider(props: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const setLocale = (next: Locale) => {
    localStorage.setItem(STORAGE_KEY, next);
    setLocaleState(next);
  };

  return (
    <LocaleContext.Provider value={{ locale, setLocale }}>
      <ReactIntlProvider
        locale={locale}
        defaultLocale="en"
        messages={MESSAGES[locale]}
      >
        {props.children}
      </ReactIntlProvider>
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("useLocale must be used within IntlProvider");
  return ctx;
}

// --- Typed intl helpers --------------------------------------------------
/**
 * Typed wrapper around react-intl's `useIntl()`. All message IDs are constrained
 * to `TranslationKey` (the keys of `en.json`), so typos become compile errors.
 */
export function useIntl() {
  const intl = useReactIntl();
  return {
    ...intl,
    formatMessage: (
      descriptor: { id: TranslationKey },
      values?: Record<string, string | number>,
    ) => intl.formatMessage(descriptor, values),
  };
}

/** Typed wrapper for `<FormattedMessage>`. Same narrowing as `useIntl`. */
type TypedFormattedMessageProps = Omit<
  ComponentProps<typeof ReactFormattedMessage>,
  "id"
> & { id: TranslationKey };

export function FormattedMessage(props: TypedFormattedMessageProps) {
  return <ReactFormattedMessage {...props} />;
}
