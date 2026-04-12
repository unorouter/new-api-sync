import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
} from "@web/components/ui/form";
import { Switch } from "@web/components/ui/switch";
import type { ReactNode } from "react";
import type { Control, FieldValues, Path } from "react-hook-form";

type MyFormSwitchProps<T extends FieldValues> = {
  control: Control<T>;
  name: Path<T>;
  label?: ReactNode;
  description?: ReactNode;
};

export function MyFormSwitch<T extends FieldValues>(
  props: MyFormSwitchProps<T>,
) {
  return (
    <FormField
      control={props.control}
      name={props.name}
      render={({ field }) => (
        <FormItem className="flex items-center justify-between">
          <div className="flex flex-col gap-0.5">
            {props.label ? (
              <FormLabel className="text-xs font-medium">
                {props.label}
              </FormLabel>
            ) : null}
            {props.description ? (
              <span className="text-muted-foreground max-w-75 text-[11px]">
                {props.description}
              </span>
            ) : null}
          </div>
          <FormControl>
            <Switch checked={!!field.value} onCheckedChange={field.onChange} />
          </FormControl>
        </FormItem>
      )}
    />
  );
}
