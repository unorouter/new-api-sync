import type { ConfigSchemaType } from "@core/validations/config";
import { FormattedMessage } from "@web/components/provider/intl-provider";
import { MyFormInput } from "@web/components/elements/form/my-form-input";
import { providerPath } from "@web/components/elements/config/provider-path";
import type { TObject } from "@sinclair/typebox/type";
import { useFormContext } from "react-hook-form";

// Schema for MyFormError metadata lookup — fields are shared, so leaf name
// is enough; no need to thread the per-variant union.
import { ConfigSchema } from "@core/validations/config";
// The providers array items are a TypeBox discriminated union, which isn't a
// TObject. MyFormInput only reads `.properties[leafName]` for bound metadata;
// a synthetic empty-properties object satisfies that without duplicating the
// union. Per-field bounds are still enforced by the root typeboxResolver.
const variantSchema = { properties: {} } as unknown as TObject;
// Keep the import "used" so future maintainers see the intent.
void ConfigSchema;

export function ProviderNewApiPanel(props: { index: number }) {
  const form = useFormContext<ConfigSchemaType>();
  return (
    <div className="space-y-4">
      <MyFormInput
        control={form.control}
        name={providerPath(props.index, "baseUrl")}
        schema={variantSchema}
        label={<FormattedMessage id="CONFIG.PROVIDER.BASE_URL" />}
        placeholder="https://…"
      />
      <MyFormInput
        control={form.control}
        name={providerPath(props.index, "systemAccessToken")}
        schema={variantSchema}
        label={<FormattedMessage id="CONFIG.PROVIDER.SYSTEM_ACCESS_TOKEN" />}
        type="password"
      />
      <MyFormInput
        control={form.control}
        name={providerPath(props.index, "userId")}
        schema={variantSchema}
        label={<FormattedMessage id="CONFIG.PROVIDER.USER_ID" />}
        type="number"
        min={1}
      />
    </div>
  );
}
