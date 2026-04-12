import { ConfigSchema, type ConfigSchemaType } from "@core/validations/config";
import { FormattedMessage } from "@web/components/provider/intl-provider";
import { MyFormInput } from "@web/components/elements/form/my-form-input";
import { providerPath } from "@web/components/elements/config/provider-path";
import type { TObject } from "@sinclair/typebox/type";
import { useFormContext } from "react-hook-form";

const variantSchema = { properties: {} } as unknown as TObject;
void ConfigSchema;

export function ProviderDirectPanel(props: { index: number }) {
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
      <div className="grid grid-cols-2 gap-4">
        <MyFormInput
          control={form.control}
          name={providerPath(props.index, "vendor")}
          schema={variantSchema}
          label={<FormattedMessage id="CONFIG.PROVIDER.VENDOR" />}
          placeholder="moonshot, zhipu, …"
        />
        <MyFormInput
          control={form.control}
          name={providerPath(props.index, "channelType")}
          schema={variantSchema}
          label={
            <>
              <FormattedMessage id="CONFIG.PROVIDER.CHANNEL_TYPE" />
              <span className="text-muted-foreground ml-1 text-xs font-normal">
                (<FormattedMessage id="CONFIG.FIELD.OPTIONAL" />)
              </span>
            </>
          }
          type="number"
          min={1}
        />
      </div>
      <MyFormInput
        control={form.control}
        name={providerPath(props.index, "apiKey")}
        schema={variantSchema}
        label={<FormattedMessage id="CONFIG.PROVIDER.API_KEY" />}
        type="password"
      />
      <div className="grid grid-cols-2 gap-4">
        <MyFormInput
          control={form.control}
          name={providerPath(props.index, "ratio")}
          schema={variantSchema}
          label={<FormattedMessage id="CONFIG.PROVIDER.RATIO" />}
          type="number"
          step="any"
        />
        <MyFormInput
          control={form.control}
          name={providerPath(props.index, "discoverEndpoint")}
          schema={variantSchema}
          label={
            <>
              <FormattedMessage id="CONFIG.PROVIDER.DISCOVER_ENDPOINT" />
              <span className="text-muted-foreground ml-1 text-xs font-normal">
                (<FormattedMessage id="CONFIG.FIELD.OPTIONAL" />)
              </span>
            </>
          }
          placeholder="/v1/models"
        />
      </div>
    </div>
  );
}
