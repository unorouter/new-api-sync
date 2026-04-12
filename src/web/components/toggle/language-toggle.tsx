"use client";

import { useIntl } from "@web/components/provider/intl-provider";
import { Button } from "@web/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@web/components/ui/dropdown-menu";
import {
  useConfigLocale,
  useSetConfigLocale,
} from "@web/hooks/config-hook";
import { LANGUAGES } from "@web/lib/constants";
import { useUiStore } from "@web/store/ui-store";

export function LanguageToggle() {
  const { t } = useIntl();
  const selectedName = useUiStore((s) => s.selectedConfigName);
  const locale = useConfigLocale(selectedName).data ?? "en";
  const setLocale = useSetConfigLocale(selectedName);
  const current = LANGUAGES.find((lang) => lang.locale === locale);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("LANGUAGE.SWITCH")}
            disabled={setLocale.isPending}
          />
        }
      >
        {current ? <current.Flag className="h-3.5 w-5 rounded-sm" /> : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {LANGUAGES.map((lang) => (
          <DropdownMenuItem
            key={lang.code}
            onClick={() => setLocale.mutate(lang.locale)}
            className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm"
          >
            <lang.Flag className="h-3.5 w-5 rounded-sm" />
            {t(`LANGUAGE.${lang.code}` as const)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
