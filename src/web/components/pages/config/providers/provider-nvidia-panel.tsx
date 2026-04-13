import { ConfigSchema, type ConfigSchemaType } from "@core/validations/config";
import { useIntl } from "@web/components/provider/intl-provider";
import { MyFormInput } from "@web/components/elements/form/my-form-input";
import { providerPath } from "./provider-path";
import type { TObject } from "@sinclair/typebox/type";
import { useFormContext } from "react-hook-form";

const variantSchema = { properties: {} } as unknown as TObject;
void ConfigSchema;

export function ProviderNvidiaPanel(props: { index: number }) {
  const { t } = useIntl();
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
              {t("CONFIG.PROVIDER.BASE_URL")}
              <span className="text-muted-foreground ml-1 text-xs font-normal">
                ({t("CONFIG.FIELD.OPTIONAL")})
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
              {t("CONFIG.PROVIDER.IMAGE_BASE_URL")}
              <span className="text-muted-foreground ml-1 text-xs font-normal">
                ({t("CONFIG.FIELD.OPTIONAL")})
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
        label={t("CONFIG.PROVIDER.API_KEY")}
        type="password"
        placeholder={t("CONFIG.PROVIDER.API_KEY_PLACEHOLDER_NVIDIA")}
      />
      <MyFormInput
        control={form.control}
        name={providerPath(props.index, "ratio")}
        schema={variantSchema}
        label={t("CONFIG.PROVIDER.RATIO")}
        type="number"
        step="any"
      />
    </div>
  );
}
