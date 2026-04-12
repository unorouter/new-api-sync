import { MyFormError } from "@web/components/elements/form/my-form-error";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
} from "@web/components/ui/form";
import { Input } from "@web/components/ui/input";
import { cn } from "@web/lib/utils";
import type { TObject } from "@sinclair/typebox/type";
import type { ComponentProps, ReactNode } from "react";
import type {
  Control,
  FieldValues,
  Path,
  RegisterOptions,
} from "react-hook-form";

type MyFormInputProps<T extends FieldValues> = {
  symbol?: string;
  control: Control<T>;
  name: Path<T>;
  schema: TObject;
  label?: ReactNode;
  validate?: RegisterOptions<T>["validate"];
} & ComponentProps<"input">;

export function MyFormInput<T extends FieldValues>(props: MyFormInputProps<T>) {
  const { control, label, name, schema, symbol, validate, ...rest } = props;
  const leafName = name.split(".").pop() ?? name;
  const schemaProp = schema.properties[leafName];

  return (
    <FormField
      control={control}
      name={name}
      rules={{ validate }}
      render={({ field, fieldState }) => {
        const error = fieldState.error?.message;
        const isNumber = rest.type === "number";
        return (
          <FormItem>
            {label ? <FormLabel>{label}</FormLabel> : null}
            <div className="relative flex items-center">
              {symbol ? (
                <span className="absolute top-1/2 left-0 -translate-y-1/2 pl-2">
                  {symbol}
                </span>
              ) : null}
              <FormControl>
                <Input
                  {...field}
                  {...rest}
                  value={field.value ?? ""}
                  onChange={(e) =>
                    field.onChange(
                      isNumber && e.target.value !== ""
                        ? Number(e.target.value)
                        : e,
                    )
                  }
                  className={cn(symbol && "pl-6", rest.className)}
                  minLength={rest.minLength ?? schemaProp?.minLength}
                  maxLength={rest.maxLength ?? schemaProp?.maxLength}
                  min={rest.min ?? schemaProp?.minimum}
                  max={rest.max ?? schemaProp?.maximum}
                />
              </FormControl>
            </div>
            <MyFormError name={name} schema={schema} error={error} />
          </FormItem>
        );
      }}
    />
  );
}
