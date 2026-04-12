import { FormMessage } from "@web/components/ui/form";
import { useIntl } from "@web/components/provider/intl-provider";
import type { TranslationKey } from "@web/lib/constants";
import type { TObject } from "@sinclair/typebox/type";

type MyFormErrorProps = {
  error?: string | null;
  schema: TObject;
  name: string;
};

/**
 * Renders a localized validation error below a form field. Looks up the
 * schema property metadata (minLength/maxLength/minimum) and threads it into
 * the translation so messages can reference the exact bound that failed.
 * Falls back to the raw error string if the translation key is missing.
 */
export function MyFormError(props: MyFormErrorProps) {
  const intl = useIntl();
  if (!props.error) return null;

  const leafName =
    props.name
      .replace(/\.\d+\./g, ".")
      .split(".")
      .pop() ?? props.name;
  const property = props.schema.properties[leafName];

  let message: string;
  try {
    message = intl.formatMessage(
      { id: props.error as TranslationKey },
      {
        minLength: property?.minLength,
        maxLength: property?.maxLength,
        minimum: property?.minimum,
        maximum: property?.maximum,
      },
    );
  } catch {
    message = props.error;
  }

  return <FormMessage className="text-xs font-bold">{message}</FormMessage>;
}
