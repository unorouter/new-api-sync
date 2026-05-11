"use client";

import { Combobox } from "@base-ui/react/combobox";
import { useTranslations } from "use-intl";
import { Badge } from "@web/components/ui/badge";
import { Button } from "@web/components/ui/button";
import { Separator } from "@web/components/ui/separator";
import { cn } from "@web/lib/utils";
import { CheckIcon, PlusCircleIcon } from "lucide-react";

export type ProviderOption = {
  name: string;
  type: string;
};

export function ProvidersFilter(props: {
  options: ProviderOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const t = useTranslations();
  const selectedSet = new Set(props.selected);
  const selectedItems = props.options.filter((option) =>
    selectedSet.has(option.name),
  );
  const typeCounts = props.options.reduce<Record<string, number>>(
    (acc, option) => {
      acc[option.type] = (acc[option.type] ?? 0) + 1;
      return acc;
    },
    {},
  );

  return (
    <Combobox.Root
      items={props.options}
      multiple
      value={selectedItems}
      onValueChange={(next: ProviderOption[]) =>
        props.onChange(next.map((option) => option.name))
      }
      itemToStringLabel={(item: ProviderOption) => item.name}
      itemToStringValue={(item: ProviderOption) => item.name}
    >
      <Combobox.Trigger
        disabled={props.disabled}
        render={
          <Button variant="outline" size="sm" className="border-dashed">
            <PlusCircleIcon />
            <span>{t("SYNC.FILTER.PROVIDER_MULTI")}</span>
            {props.selected.length > 0 ? (
              <>
                <Separator orientation="vertical" className="mx-1 h-4" />
                <Badge
                  variant="secondary"
                  className="rounded-sm px-1 font-normal lg:hidden"
                >
                  {props.selected.length}
                </Badge>
                <div className="hidden gap-1 lg:flex">
                  {props.selected.length > 2 ? (
                    <Badge
                      variant="secondary"
                      className="rounded-sm px-1 font-normal"
                    >
                      {t("SYNC.FILTER.SELECTED", {
                        count: props.selected.length,
                      })}
                    </Badge>
                  ) : (
                    props.options
                      .filter((option) => selectedSet.has(option.name))
                      .map((option) => (
                        <Badge
                          key={option.name}
                          variant="secondary"
                          className="rounded-sm px-1 font-normal"
                        >
                          {option.name}
                        </Badge>
                      ))
                  )}
                </div>
              </>
            ) : null}
          </Button>
        }
      />
      <Combobox.Portal>
        <Combobox.Positioner
          align="start"
          sideOffset={4}
          className="isolate z-50"
        >
          <Combobox.Popup
            className={cn(
              "bg-popover text-popover-foreground border-border data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 w-56 origin-(--transform-origin) overflow-hidden rounded-md border p-0 shadow-md outline-none",
            )}
          >
            <div className="border-border border-b p-2">
              <Combobox.Input
                placeholder={t("SYNC.FILTER.SEARCH_PROVIDERS")}
                className="border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus-visible:ring-3"
              />
            </div>
            <Combobox.List className="max-h-64 overflow-y-auto p-1">
              <Combobox.Empty>
                <div className="text-muted-foreground py-4 text-center text-xs">
                  {t("SYNC.FILTER.NO_PROVIDERS")}
                </div>
              </Combobox.Empty>
              <Combobox.Collection>
                {(item: ProviderOption) => (
                  <Combobox.Item
                    key={item.name}
                    value={item}
                    className={cn(
                      "data-highlighted:bg-accent data-highlighted:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50",
                    )}
                  >
                    <div
                      className={cn(
                        "border-primary flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border",
                        selectedSet.has(item.name)
                          ? "bg-primary text-primary-foreground"
                          : "opacity-50",
                      )}
                    >
                      <Combobox.ItemIndicator>
                        <CheckIcon className="size-3" />
                      </Combobox.ItemIndicator>
                    </div>
                    <span className="flex-1 truncate font-mono text-xs">
                      {item.name}
                    </span>
                    <span className="text-muted-foreground font-mono text-[10px] uppercase">
                      {item.type}
                    </span>
                  </Combobox.Item>
                )}
              </Combobox.Collection>
            </Combobox.List>
            {props.selected.length > 0 ? (
              <>
                <Separator />
                <button
                  type="button"
                  onClick={() => props.onChange([])}
                  className="hover:bg-accent hover:text-accent-foreground w-full cursor-default rounded-none px-2 py-1.5 text-center text-xs outline-none"
                >
                  {t("SYNC.FILTER.CLEAR", {
                    total: props.options.length,
                    types: Object.keys(typeCounts).length,
                  })}
                </button>
              </>
            ) : null}
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
