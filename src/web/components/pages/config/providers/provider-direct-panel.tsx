import { ConfigSchema, type ConfigSchemaType } from "@core/validations/config";
import { useTranslations } from "use-intl";
import { MyFormInput } from "@web/components/elements/form/my-form-input";
import { providerPath } from "./provider-path";
import type { TObject } from "@sinclair/typebox/type";
import { useFormContext } from "react-hook-form";

const variantSchema = { properties: {} } as unknown as TObject;
void ConfigSchema;

export function ProviderDirectPanel(props: { index: number }) {
  const t = useTranslations();
  const form = useFormContext<ConfigSchemaType>();
  return (
    <div className="space-y-4">
      <MyFormInput
        control={form.control}
        name={providerPath(props.index, "baseUrl")}
        schema={variantSchema}
        label={t("CONFIG.PROVIDER.BASE_URL")}
        placeholder={t("CONFIG.PROVIDER.BASE_URL_PLACEHOLDER")}
      />
      <div className="grid grid-cols-2 gap-4">
        <MyFormInput
          control={form.control}
          name={providerPath(props.index, "vendor")}
          schema={variantSchema}
          label={t("CONFIG.PROVIDER.VENDOR")}
          placeholder={t("CONFIG.PROVIDER.VENDOR_PLACEHOLDER")}
        />
        <MyFormInput
          control={form.control}
          name={providerPath(props.index, "channelType")}
          schema={variantSchema}
          label={
            <>
              {t("CONFIG.PROVIDER.CHANNEL_TYPE")}
              <span className="text-muted-foreground ml-1 text-xs font-normal">
                ({t("CONFIG.FIELD.OPTIONAL")})
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
        label={t("CONFIG.PROVIDER.API_KEY")}
        type="password"
      />
      <div className="grid grid-cols-2 gap-4">
        <MyFormInput
          control={form.control}
          name={providerPath(props.index, "ratio")}
          schema={variantSchema}
          label={t("CONFIG.PROVIDER.RATIO")}
          type="number"
          step="any"
        />
        <MyFormInput
          control={form.control}
          name={providerPath(props.index, "discoverEndpoint")}
          schema={variantSchema}
          label={
            <>
              {t("CONFIG.PROVIDER.DISCOVER_ENDPOINT")}
              <span className="text-muted-foreground ml-1 text-xs font-normal">
                ({t("CONFIG.FIELD.OPTIONAL")})
              </span>
            </>
          }
          placeholder={t("CONFIG.PROVIDER.DISCOVER_ENDPOINT_PLACEHOLDER")}
        />
      </div>
    </div>
  );
}
