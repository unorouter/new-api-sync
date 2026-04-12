import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./global.css";
import { App } from "@web/app";
import { IntlProvider } from "@web/components/provider/intl-provider";
import { ThemeProvider } from "@web/components/provider/theme-provider";
import getQueryClient from "@web/lib/react-query/client";

const container = document.getElementById("root");
if (!container) throw new Error("root element not found");

const queryClient = getQueryClient();

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <IntlProvider>
          <App />
        </IntlProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
