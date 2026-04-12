import { ConfigSchema, type ConfigSchemaType } from "@core/config";
import { FormattedMessage } from "@web/components/provider/intl-provider";
import { MyFormInput } from "@web/components/elements/form/my-form-input";
import { providerPath } from "@web/components/elements/config/provider-path";
import type { TObject } from "@sinclair/typebox/type";
import { useFormContext } from "react-hook-form";

const variantSchema = { properties: {} } as unknown as TObject;
void ConfigSchema;

export function ProviderNvidiaPanel(props: { index: number }) {
  const form = useFormContext<ConfigSchemaType>();
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <MyFormInput
          control={form.control}
          name={providerPath(props.index, "baseUrl")}
          schema={variantSchema}
          label={
            <>
              <FormattedMessage id="CONFIG.PROVIDER.BASE_URL" />
              <span className="text-muted-foreground ml-1 text-xs font-normal">
                (<FormattedMessage id="CONFIG.FIELD.OPTIONAL" />)
              </span>
            </>
          }
          placeholder="https://integrate.api.nvidia.com"
        />
        <MyFormInput
          control={form.control}
          name={providerPath(props.index, "imageBaseUrl")}
          schema={variantSchema}
          label={
            <>
              <FormattedMessage id="CONFIG.PROVIDER.IMAGE_BASE_URL" />
              <span className="text-muted-foreground ml-1 text-xs font-normal">
                (<FormattedMessage id="CONFIG.FIELD.OPTIONAL" />)
              </span>
            </>
          }
          placeholder="https://ai.api.nvidia.com"
        />
      </div>
      <MyFormInput
        control={form.control}
        name={providerPath(props.index, "apiKey")}
        schema={variantSchema}
        label={<FormattedMessage id="CONFIG.PROVIDER.API_KEY" />}
        type="password"
        placeholder="nvapi-…"
      />
      <MyFormInput
        control={form.control}
        name={providerPath(props.index, "ratio")}
        schema={variantSchema}
        label={<FormattedMessage id="CONFIG.PROVIDER.RATIO" />}
        type="number"
        step="any"
      />
    </div>
  );
}
