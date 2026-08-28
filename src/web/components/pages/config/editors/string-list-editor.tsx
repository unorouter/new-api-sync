import { useTranslations } from "use-intl";
import { Button } from "@web/components/ui/button";
import { Input } from "@web/components/ui/input";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useRef } from "react";

interface Props {
  items: string[];
  onChange: (items: string[]) => void;
  placeholder?: string;
  datalistId?: string;
  suggestions?: string[];
}

/**
 * Repeater over a list of strings. Used by blacklist,
 * nvidia.models.
 *
 * Stable row keys come from a ref-counter so deleting a row doesn't remap
 * React's DOM nodes by index and steal focus from the next input.
 */
export function StringListEditor(props: Props) {
  const t = useTranslations();
  const keyCounter = useRef(0);
  const keysRef = useRef<number[]>([]);

  while (keysRef.current.length < props.items.length) {
    keysRef.current.push(keyCounter.current++);
  }
  if (keysRef.current.length > props.items.length) {
    keysRef.current.length = props.items.length;
  }

  const update = (index: number, value: string) => {
    const next = [...props.items];
    next[index] = value;
    props.onChange(next);
  };

  const remove = (index: number) => {
    const next = props.items.filter((_, i) => i !== index);
    keysRef.current.splice(index, 1);
    props.onChange(next);
  };

  const add = () => {
    keysRef.current.push(keyCounter.current++);
    props.onChange([...props.items, ""]);
  };

  const listId = props.datalistId;

  return (
    <div className="space-y-2">
      {listId && props.suggestions ? (
        <datalist id={listId}>
          {props.suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      ) : null}
      {props.items.map((item, i) => (
        <div key={keysRef.current[i]} className="flex items-center gap-2">
          <Input
            value={item}
            onChange={(event) => update(i, event.target.value)}
            placeholder={props.placeholder}
            list={listId}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => remove(i)}
            type="button"
            aria-label={t("CONFIG.FIELD.REMOVE")}
          >
            <Trash2Icon />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={add} type="button">
        <PlusIcon />
        {t("CONFIG.FIELD.ADD")}
      </Button>
    </div>
  );
}
