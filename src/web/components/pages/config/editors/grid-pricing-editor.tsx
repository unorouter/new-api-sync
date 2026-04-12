import { useIntl } from "@web/components/provider/intl-provider";
import { Button } from "@web/components/ui/button";
import { Input } from "@web/components/ui/input";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useRef } from "react";

type Cell = string | number;
type Row = Record<string, Cell>;

interface Props {
  rows: Row[];
  onChange: (rows: Row[]) => void;
}

const PRICING_COLUMN = "Pricing";

/**
 * Grid-pricing editor: dynamic columns with a mandatory "Pricing" column.
 * Column headers are renameable; Pricing is locked. Renaming a column
 * propagates the key across every row.
 */
export function GridPricingEditor(props: Props) {
  const { t } = useIntl();
  const keyCounter = useRef(0);
  const rowKeysRef = useRef<number[]>([]);

  while (rowKeysRef.current.length < props.rows.length) {
    rowKeysRef.current.push(keyCounter.current++);
  }
  if (rowKeysRef.current.length > props.rows.length) {
    rowKeysRef.current.length = props.rows.length;
  }

  // Derive columns: Pricing always last; others in insertion order across rows.
  const columns: string[] = [];
  for (const row of props.rows) {
    for (const col of Object.keys(row)) {
      if (col !== PRICING_COLUMN && !columns.includes(col)) columns.push(col);
    }
  }
  columns.push(PRICING_COLUMN);

  const renameColumn = (oldName: string, newName: string) => {
    if (!newName || newName === oldName) return;
    if (columns.includes(newName)) return; // duplicate, silently ignore
    const next = props.rows.map((row) => {
      const copy: Row = {};
      for (const key of Object.keys(row)) {
        copy[key === oldName ? newName : key] = row[key]!;
      }
      return copy;
    });
    props.onChange(next);
  };

  const removeColumn = (name: string) => {
    if (name === PRICING_COLUMN) return;
    const next = props.rows.map((row) => {
      const copy: Row = { ...row };
      delete copy[name];
      return copy;
    });
    props.onChange(next);
  };

  const addColumn = () => {
    let base = "Column";
    let n = 1;
    while (columns.includes(`${base}${n}`)) n++;
    const newCol = `${base}${n}`;
    const next = props.rows.map((row) => ({ ...row, [newCol]: "" }));
    // If no rows yet, seed one so the column actually shows up.
    if (props.rows.length === 0) {
      rowKeysRef.current.push(keyCounter.current++);
      props.onChange([{ [newCol]: "", [PRICING_COLUMN]: 0 }]);
    } else {
      props.onChange(next);
    }
  };

  const addRow = () => {
    const row: Row = {};
    for (const col of columns) {
      row[col] = col === PRICING_COLUMN ? 0 : "";
    }
    rowKeysRef.current.push(keyCounter.current++);
    props.onChange([...props.rows, row]);
  };

  const removeRow = (index: number) => {
    rowKeysRef.current.splice(index, 1);
    props.onChange(props.rows.filter((_, i) => i !== index));
  };

  const updateCell = (rowIndex: number, col: string, raw: string) => {
    const row = props.rows[rowIndex];
    if (!row) return;
    const nextRow: Row = { ...row };
    if (col === PRICING_COLUMN) {
      nextRow[col] = raw === "" ? 0 : Number(raw);
    } else {
      nextRow[col] = raw;
    }
    const next = [...props.rows];
    next[rowIndex] = nextRow;
    props.onChange(next);
  };

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              {columns.map((col) => (
                <th key={col} className="p-1">
                  <div className="flex items-center gap-1">
                    <Input
                      value={col}
                      onChange={(event) =>
                        renameColumn(col, event.target.value)
                      }
                      disabled={col === PRICING_COLUMN}
                      className="h-7 text-xs"
                    />
                    {col !== PRICING_COLUMN ? (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => removeColumn(col)}
                        type="button"
                        aria-label={t("CONFIG.ENABLED_MODELS.REMOVE_COLUMN")}
                      >
                        <Trash2Icon />
                      </Button>
                    ) : null}
                  </div>
                </th>
              ))}
              <th className="w-10 p-1" />
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row, i) => (
              <tr key={rowKeysRef.current[i]} className="border-t">
                {columns.map((col) => (
                  <td key={col} className="p-1">
                    <Input
                      value={String(row[col] ?? "")}
                      onChange={(event) =>
                        updateCell(i, col, event.target.value)
                      }
                      type={col === PRICING_COLUMN ? "number" : "text"}
                      step={col === PRICING_COLUMN ? "any" : undefined}
                      className="h-7 text-xs"
                    />
                  </td>
                ))}
                <td className="p-1">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => removeRow(i)}
                    type="button"
                    aria-label={t("CONFIG.ENABLED_MODELS.REMOVE_ROW")}
                  >
                    <Trash2Icon />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={addRow} type="button">
          <PlusIcon />
          {t("CONFIG.FIELD.ADD")}
        </Button>
        <Button variant="outline" size="sm" onClick={addColumn} type="button">
          <PlusIcon />
          {t("CONFIG.ENABLED_MODELS.ADD_COLUMN")}
        </Button>
      </div>
    </div>
  );
}
