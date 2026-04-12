"use client";

import { Button } from "@web/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@web/components/ui/dropdown-menu";
import { useLocale } from "@web/components/provider/intl-provider";
import { LANGUAGES } from "@web/lib/constants";
import { FormattedMessage, useIntl } from "@web/lib/intl";

export function LanguageToggle() {
  const intl = useIntl();
  const locale = useLocale().locale;
  const setLocale = useLocale().setLocale;
  const current = LANGUAGES.find((lang) => lang.locale === locale);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={intl.formatMessage({ id: "LANGUAGE.SWITCH" })}
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
            <FormattedMessage id={`LANGUAGE.${lang.code}`} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
