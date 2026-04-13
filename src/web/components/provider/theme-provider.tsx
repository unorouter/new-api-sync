"use client";

import type { ThemeValue } from "@core/validations/config";
import {
  useGlobalConfig,
  useSetGlobalTheme,
} from "@web/hooks/global-config-hook";
import { createContext, useContext, useEffect } from "react";

type Theme = ThemeValue;

type ThemeState = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeState | null>(null);

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  root.classList.add(resolved);
}

export function ThemeProvider(props: { children: React.ReactNode }) {
  // Theme lives in `config.global.yml` (not localStorage) so it follows the
  // user across browsers. Fall back to "system" while the query is loading
  // or when the field is absent.
  const globalQuery = useGlobalConfig();
  const theme: Theme = globalQuery.data?.theme ?? "system";
  const setThemeMutation = useSetGlobalTheme();

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // React to OS theme changes while "system" is selected.
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handle = () => applyTheme("system");
    mq.addEventListener("change", handle);
    return () => mq.removeEventListener("change", handle);
  }, [theme]);

  const setTheme = (next: Theme) => {
    setThemeMutation.mutate(next);
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {props.children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
