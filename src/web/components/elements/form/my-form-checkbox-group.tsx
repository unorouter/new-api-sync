import { MyFormError } from "@web/components/elements/form/my-form-error";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
} from "@web/components/ui/form";
import { Checkbox } from "@web/components/ui/checkbox";
import type { TObject } from "@sinclair/typebox/type";
import type { ReactNode } from "react";
import type { Control, FieldValues, Path } from "react-hook-form";

type Option = { value: string; label: ReactNode };

type MyFormCheckboxGroupProps<T extends FieldValues> = {
  control: Control<T>;
  name: Path<T>;
  schema: TObject;
  label?: ReactNode;
  options: Option[];
};

/**
 * Multi-select checkbox list bound to a `string[]` field. Used for things
 * like `testModelTypes` where the config shape is an array of enum values.
 */
export function MyFormCheckboxGroup<T extends FieldValues>(
  props: MyFormCheckboxGroupProps<T>,
) {
  return (
    <FormField
      control={props.control}
      name={props.name}
      render={({ field, fieldState }) => {
        const selected: string[] = Array.isArray(field.value)
          ? (field.value as string[])
          : [];
        const toggle = (value: string, checked: boolean) => {
          const next = checked
            ? Array.from(new Set([...selected, value]))
            : selected.filter((v) => v !== value);
          field.onChange(next);
        };
        return (
          <FormItem>
            {props.label ? <FormLabel>{props.label}</FormLabel> : null}
            <FormControl>
              <div className="flex flex-wrap gap-3">
                {props.options.map((opt) => {
                  const checked = selected.includes(opt.value);
                  return (
                    <label
                      key={opt.value}
                      className="flex cursor-pointer items-center gap-1.5 text-sm"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(state) => toggle(opt.value, !!state)}
                      />
                      {opt.label}
                    </label>
                  );
                })}
              </div>
            </FormControl>
            <MyFormError
              name={props.name}
              schema={props.schema}
              error={fieldState.error?.message}
            />
          </FormItem>
        );
      }}
    />
  );
}
