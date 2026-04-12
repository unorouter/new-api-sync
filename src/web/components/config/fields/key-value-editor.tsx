import { FormattedMessage } from "@web/components/provider/intl-provider";
import { Button } from "@web/components/ui/button";
import { Input } from "@web/components/ui/input";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type ValueType = "string" | "number";
type KVValue = string | number;

interface Props {
  pairs: Record<string, KVValue>;
  onChange: (pairs: Record<string, KVValue>) => void;
  valueType?: ValueType;
  /** Keys pinned at the top and not removable (e.g. "default" for priceAdjustment). */
  requiredKeys?: string[];
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}

interface Row {
  id: number;
  key: string;
  value: KVValue;
  required: boolean;
}

/**
 * Repeater over a key/value object. Internal state holds the pending rows so
 * the user can have duplicate / empty keys mid-edit without the object losing
 * data; the parent is only updated after each valid edit.
 */
export function KeyValueEditor(props: Props) {
  const valueType = props.valueType ?? "string";
  const requiredKeys = props.requiredKeys ?? [];
  const keyCounter = useRef(0);

  const [rows, setRows] = useState<Row[]>(() => buildInitialRows(props.pairs, requiredKeys, keyCounter));

  // Rebuild rows when incoming pairs diverge from our local view (e.g. Revert).
  const serialized = serializeRows(rows);
  const incoming = JSON.stringify(props.pairs);
  useEffect(() => {
    if (serialized !== incoming) {
      setRows(buildInitialRows(props.pairs, requiredKeys, keyCounter));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming]);

  const commit = (nextRows: Row[]) => {
    setRows(nextRows);
    const pairs: Record<string, KVValue> = {};
    for (const row of nextRows) {
      if (!row.key) continue;
      if (row.key in pairs) continue;
      pairs[row.key] = row.value;
    }
    props.onChange(pairs);
  };

  const updateKey = (id: number, key: string) => {
    commit(rows.map((r) => (r.id === id ? { ...r, key } : r)));
  };

  const updateValue = (id: number, raw: string) => {
    const value: KVValue = valueType === "number" ? (raw === "" ? 0 : Number(raw)) : raw;
    commit(rows.map((r) => (r.id === id ? { ...r, value } : r)));
  };

  const remove = (id: number) => {
    commit(rows.filter((r) => r.id !== id));
  };

  const add = () => {
    const id = keyCounter.current++;
    commit([...rows, { id, key: "", value: valueType === "number" ? 0 : "", required: false }]);
  };

  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.id} className="flex items-center gap-2">
          <Input
            value={row.key}
            onChange={(event) => updateKey(row.id, event.target.value)}
            placeholder={props.keyPlaceholder}
            disabled={row.required}
            className="flex-1"
          />
          <Input
            value={String(row.value)}
            onChange={(event) => updateValue(row.id, event.target.value)}
            placeholder={props.valuePlaceholder}
            type={valueType === "number" ? "number" : "text"}
            step={valueType === "number" ? "any" : undefined}
            className="flex-1"
          />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => remove(row.id)}
            type="button"
            disabled={row.required}
            aria-label="Remove"
          >
            <Trash2Icon />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={add} type="button">
        <PlusIcon />
        <FormattedMessage id="CONFIG.FIELD.ADD" />
      </Button>
    </div>
  );
}

function buildInitialRows(
  pairs: Record<string, KVValue>,
  requiredKeys: string[],
  counter: { current: number },
): Row[] {
  const rows: Row[] = [];
  for (const required of requiredKeys) {
    rows.push({
      id: counter.current++,
      key: required,
      value: pairs[required] ?? 0,
      required: true,
    });
  }
  for (const [key, value] of Object.entries(pairs)) {
    if (requiredKeys.includes(key)) continue;
    rows.push({ id: counter.current++, key, value, required: false });
  }
  return rows;
}

function serializeRows(rows: Row[]): string {
  const pairs: Record<string, KVValue> = {};
  for (const row of rows) {
    if (!row.key) continue;
    if (row.key in pairs) continue;
    pairs[row.key] = row.value;
  }
  return JSON.stringify(pairs);
}
