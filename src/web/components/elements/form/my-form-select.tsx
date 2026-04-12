import { MyFormError } from "@web/components/elements/form/my-form-error";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
} from "@web/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@web/components/ui/select";
import type { TObject } from "@sinclair/typebox/type";
import type { ReactNode } from "react";
import type { Control, FieldValues, Path } from "react-hook-form";

type MyFormSelectProps<T extends FieldValues> = {
  control: Control<T>;
  name: Path<T>;
  schema: TObject;
  label?: ReactNode;
  placeholder?: string;
  options: Array<{ value: string; label: ReactNode }>;
  className?: string;
};

export function MyFormSelect<T extends FieldValues>(
  props: MyFormSelectProps<T>,
) {
  return (
    <FormField
      control={props.control}
      name={props.name}
      render={({ field, fieldState }) => (
        <FormItem>
          {props.label ? <FormLabel>{props.label}</FormLabel> : null}
          <FormControl>
            <Select
              value={field.value ?? ""}
              onValueChange={(value) => field.onChange(value)}
            >
              <SelectTrigger className={props.className}>
                <SelectValue placeholder={props.placeholder} />
              </SelectTrigger>
              <SelectContent>
                {props.options.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormControl>
          <MyFormError
            name={props.name}
            schema={props.schema}
            error={fieldState.error?.message}
          />
        </FormItem>
      )}
    />
  );
}
