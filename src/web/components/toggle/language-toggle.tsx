"use client";

import { useTranslations } from "use-intl";
import { Button } from "@web/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@web/components/ui/dropdown-menu";
import { LANGUAGES } from "@web/lib/constants";
import { useUiStore } from "@web/store/ui-store";

export function LanguageToggle() {
  const t = useTranslations();
  const locale = useUiStore((state) => state.locale);
  const setLocale = useUiStore((state) => state.setLocale);
  const current = LANGUAGES.find((lang) => lang.locale === locale);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("LANGUAGE.SWITCH")}
          />
        }
      >
        {current ? <current.Flag className="h-3.5 w-5 rounded-sm" /> : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {LANGUAGES.map((lang) => (
          <DropdownMenuItem
            key={lang.code}
            onClick={() => setLocale(lang.locale)}
            className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm"
          >
            <lang.Flag className="h-3.5 w-5 rounded-sm" />
            {t(`LANGUAGE.${lang.code}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
