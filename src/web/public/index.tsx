import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./global.css";
import { App } from "@web/app";
import { IntlProvider } from "@web/components/provider/intl-provider";
import { ThemeProvider } from "@web/components/provider/theme-provider";

const container = document.getElementById("root");
if (!container) throw new Error("root element not found");

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <IntlProvider>
        <App />
      </IntlProvider>
    </ThemeProvider>
  </StrictMode>,
);
