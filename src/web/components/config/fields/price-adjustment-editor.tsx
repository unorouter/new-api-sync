import { FormattedMessage } from "@web/components/provider/intl-provider";
import { Input } from "@web/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@web/components/ui/radio-group";
import { KeyValueEditor } from "./key-value-editor";

type PriceAdjustment = number | Record<string, number> | undefined;

interface Props {
  value: PriceAdjustment;
  onChange: (value: PriceAdjustment) => void;
}

type Mode = "none" | "single" | "per_key";

/**
 * priceAdjustment: undefined | number | { default: number, [key]: number }.
 * Renders a mode radio at top; "none" strips the field entirely, "single" is a
 * plain number input, "per_key" is a KeyValueEditor with "default" pinned.
 */
export function PriceAdjustmentEditor(props: Props) {
  const mode: Mode =
    props.value === undefined
      ? "none"
      : typeof props.value === "number"
        ? "single"
        : "per_key";

  const setMode = (next: Mode) => {
    if (next === "none") {
      props.onChange(undefined);
    } else if (next === "single") {
      const n = typeof props.value === "number" ? props.value : 0;
      props.onChange(n);
    } else {
      const existing =
        props.value && typeof props.value === "object" ? props.value : {};
      props.onChange({ default: 0, ...existing });
    }
  };

  return (
    <div className="space-y-3">
      <RadioGroup
        value={mode}
        onValueChange={(next) => {
          if (typeof next === "string") setMode(next as Mode);
        }}
        className="flex gap-4"
      >
        <label className="flex items-center gap-2 text-sm">
          <RadioGroupItem value="none" />
          <FormattedMessage id="CONFIG.PRICE_ADJUSTMENT.NONE" />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <RadioGroupItem value="single" />
          <FormattedMessage id="CONFIG.PRICE_ADJUSTMENT.SINGLE" />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <RadioGroupItem value="per_key" />
          <FormattedMessage id="CONFIG.PRICE_ADJUSTMENT.PER_KEY" />
        </label>
      </RadioGroup>
      {mode === "single" && typeof props.value === "number" ? (
        <Input
          type="number"
          step="any"
          value={props.value}
          onChange={(event) =>
            props.onChange(event.target.value === "" ? 0 : Number(event.target.value))
          }
        />
      ) : null}
      {mode === "per_key" && typeof props.value === "object" && props.value !== null ? (
        <KeyValueEditor
          pairs={props.value}
          onChange={(pairs) => props.onChange(pairs as Record<string, number>)}
          valueType="number"
          requiredKeys={["default"]}
          keyPlaceholder="vendor / model type / glob"
          valuePlaceholder="-0.5"
        />
      ) : null}
    </div>
  );
}
