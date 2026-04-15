import { QueryClientProvider } from "@tanstack/react-query";
import { App } from "@web/app";
import { IntlProvider } from "@web/components/provider/intl-provider";
import { ThemeProvider } from "@web/components/provider/theme-provider";
import getQueryClient from "@web/lib/react-query/client";
import { useUiStore } from "@web/store/ui-store";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./global.css";

const container = document.getElementById("root");
if (!container) throw new Error("root element not found");

const queryClient = getQueryClient();

await useUiStore.persist.rehydrate();

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <IntlProvider>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </IntlProvider>
    </QueryClientProvider>
  </StrictMode>,
);
