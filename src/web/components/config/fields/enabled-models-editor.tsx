import { MODEL_TYPES } from "@core/models/constants";
import { FormattedMessage } from "@web/components/provider/intl-provider";
import { Button } from "@web/components/ui/button";
import { Input } from "@web/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@web/components/ui/select";
import { ChevronRightIcon, FileTextIcon, PlusIcon, SlidersIcon, Trash2Icon } from "lucide-react";
import { useRef, useState } from "react";
import { GridPricingEditor } from "./grid-pricing-editor";

type GridRow = Record<string, string | number>;
interface Detail {
  type: string;
  model: string;
  modelPricingGrid: GridRow[];
}
type Entry = string | Detail;

interface Props {
  items: Entry[] | undefined;
  onChange: (items: Entry[] | undefined) => void;
}

/**
 * enabledModels is a list of either bare model globs (strings) or detail
 * objects with grid pricing. Each row has a toggle to flip between the two
 * shapes.
 */
export function EnabledModelsEditor(props: Props) {
  const items = props.items ?? [];
  const keyCounter = useRef(0);
  const keysRef = useRef<number[]>([]);

  while (keysRef.current.length < items.length) {
    keysRef.current.push(keyCounter.current++);
  }
  if (keysRef.current.length > items.length) {
    keysRef.current.length = items.length;
  }

  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const commit = (next: Entry[]) => {
    props.onChange(next.length === 0 ? undefined : next);
  };

  const updateItem = (index: number, entry: Entry) => {
    const next = [...items];
    next[index] = entry;
    commit(next);
  };

  const remove = (index: number) => {
    keysRef.current.splice(index, 1);
    const nextExpanded = new Set<number>();
    for (const key of expanded) {
      if (key < index) nextExpanded.add(key);
      else if (key > index) nextExpanded.add(key - 1);
    }
    setExpanded(nextExpanded);
    commit(items.filter((_, i) => i !== index));
  };

  const addString = () => {
    keysRef.current.push(keyCounter.current++);
    commit([...items, ""]);
  };

  const addDetail = () => {
    keysRef.current.push(keyCounter.current++);
    const detail: Detail = {
      type: "image",
      model: "",
      modelPricingGrid: [{ Pricing: 0 }],
    };
    commit([...items, detail]);
  };

  const toggleShape = (index: number) => {
    const entry = items[index];
    if (entry === undefined) return;
    if (typeof entry === "string") {
      updateItem(index, {
        type: "image",
        model: entry,
        modelPricingGrid: [{ Pricing: 0 }],
      });
      setExpanded(new Set([...expanded, index]));
    } else {
      updateItem(index, entry.model);
    }
  };

  const toggleExpanded = (index: number) => {
    const next = new Set(expanded);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    setExpanded(next);
  };

  return (
    <div className="space-y-2">
      {items.map((entry, i) => (
        <div key={keysRef.current[i]} className="rounded-md border">
          <div className="flex items-center gap-2 p-2">
            {typeof entry === "string" ? (
              <>
                <Input
                  value={entry}
                  onChange={(event) => updateItem(i, event.target.value)}
                  placeholder="claude-*-4-5*"
                  className="flex-1"
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => toggleShape(i)}
                  type="button"
                  title="Switch to detailed pricing"
                >
                  <SlidersIcon />
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => toggleExpanded(i)}
                  type="button"
                  aria-label="Expand"
                  className={expanded.has(i) ? "rotate-90" : ""}
                >
                  <ChevronRightIcon />
                </Button>
                <Select
                  value={entry.type}
                  onValueChange={(value) => {
                    if (value === null) return;
                    updateItem(i, { ...entry, type: value });
                  }}
                >
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MODEL_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={entry.model}
                  onChange={(event) =>
                    updateItem(i, { ...entry, model: event.target.value })
                  }
                  placeholder="model name"
                  className="flex-1"
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => toggleShape(i)}
                  type="button"
                  title="Switch to plain glob"
                >
                  <FileTextIcon />
                </Button>
              </>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => remove(i)}
              type="button"
              aria-label="Remove"
            >
              <Trash2Icon />
            </Button>
          </div>
          {typeof entry !== "string" && expanded.has(i) ? (
            <div className="border-t p-2">
              <GridPricingEditor
                rows={entry.modelPricingGrid}
                onChange={(rows) =>
                  updateItem(i, {
                    ...entry,
                    modelPricingGrid: rows.length === 0 ? [{ Pricing: 0 }] : rows,
                  })
                }
              />
            </div>
          ) : null}
        </div>
      ))}
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={addString} type="button">
          <PlusIcon />
          <FormattedMessage id="CONFIG.ENABLED_MODELS.GLOB" />
        </Button>
        <Button variant="outline" size="sm" onClick={addDetail} type="button">
          <PlusIcon />
          <FormattedMessage id="CONFIG.ENABLED_MODELS.WITH_PRICING" />
        </Button>
      </div>
    </div>
  );
}
