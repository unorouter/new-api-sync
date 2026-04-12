import { Label } from "@web/components/ui/label";
import { cn } from "@web/lib/utils";
import * as React from "react";
import {
  Controller,
  FormProvider,
  useFormContext,
  useFormState,
  type ControllerProps,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";

const Form = FormProvider;

type FormFieldContextValue<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> = {
  name: TName;
};

const FormFieldContext = React.createContext<FormFieldContextValue>(
  {} as FormFieldContextValue,
);

const FormField = <
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>(
  props: ControllerProps<TFieldValues, TName>,
) => {
  return (
    <FormFieldContext.Provider value={{ name: props.name }}>
      <Controller {...props} />
    </FormFieldContext.Provider>
  );
};

type FormItemContextValue = {
  id: string;
};

const FormItemContext = React.createContext<FormItemContextValue>(
  {} as FormItemContextValue,
);

const useFormField = () => {
  const fieldContext = React.useContext(FormFieldContext);
  const itemContext = React.useContext(FormItemContext);
  const { getFieldState } = useFormContext();
  const formState = useFormState({ name: fieldContext.name });
  const fieldState = getFieldState(fieldContext.name, formState);

  if (!fieldContext) {
    throw new Error("useFormField should be used within <FormField>");
  }

  const id = itemContext.id;

  return {
    id,
    name: fieldContext.name,
    formItemId: `${id}-form-item`,
    formDescriptionId: `${id}-form-item-description`,
    formMessageId: `${id}-form-item-message`,
    ...fieldState,
  };
};

function FormItem(props: React.ComponentProps<"div">) {
  const id = React.useId();
  return (
    <FormItemContext.Provider value={{ id }}>
      <div
        data-slot="form-item"
        className={cn("grid gap-2", props.className)}
        {...props}
      />
    </FormItemContext.Provider>
  );
}

function FormLabel(props: React.ComponentProps<typeof Label>) {
  const field = useFormField();
  return (
    <Label
      data-slot="form-label"
      data-error={!!field.error}
      className={cn("data-[error=true]:text-destructive", props.className)}
      htmlFor={field.formItemId}
      {...props}
    />
  );
}

function FormControl(
  props: React.ComponentProps<"div"> & { children?: React.ReactNode },
) {
  const field = useFormField();
  const formProps = {
    "data-slot": "form-control" as const,
    id: field.formItemId,
    "aria-describedby": !field.error
      ? field.formDescriptionId
      : `${field.formDescriptionId} ${field.formMessageId}`,
    "aria-invalid": !!field.error,
    ...props,
  };
  if (React.isValidElement(props.children)) {
    return React.cloneElement(
      props.children as React.ReactElement<Record<string, unknown>>,
      formProps,
    );
  }
  return <div {...formProps}>{props.children}</div>;
}

function FormDescription(props: React.ComponentProps<"p">) {
  const field = useFormField();
  return (
    <p
      data-slot="form-description"
      id={field.formDescriptionId}
      className={cn("text-muted-foreground text-sm", props.className)}
      {...props}
    />
  );
}

function FormMessage(props: React.ComponentProps<"p">) {
  const field = useFormField();
  const body = props.children ?? (field.error ? String(field.error.message) : null);
  if (!body) return null;
  return (
    <p
      data-slot="form-message"
      id={field.formMessageId}
      className={cn("text-destructive text-sm", props.className)}
      {...props}
    >
      {body}
    </p>
  );
}

export {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  useFormField,
};
