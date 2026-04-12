import type { ComponentProps } from "react";
import {
  FormattedMessage as ReactFormattedMessage,
  useIntl as useReactIntl,
} from "react-intl";
import type { TranslationKey } from "@web/lib/constants";

/**
 * Typed wrapper around react-intl's `useIntl()`. All message IDs are constrained
 * to `TranslationKey` (the keys of `en.json`), so typos become compile errors.
 *
 *   const intl = useIntl();
 *   intl.formatMessage({ id: "SYNC.RUN" });       // OK
 *   intl.formatMessage({ id: "SYNC.RUUN" });      // TS error
 */
export function useIntl() {
  const intl = useReactIntl();
  return {
    ...intl,
    formatMessage: (
      descriptor: { id: TranslationKey },
      values?: Record<string, string | number>,
    ) => intl.formatMessage(descriptor, values),
  };
}

/**
 * Typed wrapper for `<FormattedMessage>`. Same narrowing as `useIntl`.
 */
type BaseProps = ComponentProps<typeof ReactFormattedMessage>;
type TypedProps = Omit<BaseProps, "id"> & { id: TranslationKey };

export function FormattedMessage(props: TypedProps) {
  return <ReactFormattedMessage {...props} />;
}
