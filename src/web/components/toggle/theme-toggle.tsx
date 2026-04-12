"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useIntl } from "@web/components/provider/intl-provider";
import { Button } from "@web/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@web/components/ui/dropdown-menu";
import { useTheme } from "@web/components/provider/theme-provider";

export function ThemeToggle() {
  const intl = useIntl();
  const setTheme = useTheme().setTheme;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={intl.formatMessage({ id: "THEME.TOGGLE" })}
          />
        }
      >
        <Sun className="h-4 w-4 scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
        <Moon className="absolute h-4 w-4 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme("light")}>
          <Sun className="h-4 w-4" />
          {intl.formatMessage({ id: "THEME.LIGHT" })}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("dark")}>
          <Moon className="h-4 w-4" />
          {intl.formatMessage({ id: "THEME.DARK" })}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("system")}>
          <Monitor className="h-4 w-4" />
          {intl.formatMessage({ id: "THEME.SYSTEM" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
