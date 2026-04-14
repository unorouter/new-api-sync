import type { Locale } from "@web/lib/constants";
import type en from "@web/public/i18n/en.json";

declare module "use-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: typeof en;
  }
}
