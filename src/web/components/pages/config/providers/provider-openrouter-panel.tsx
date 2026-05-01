import { ConfigSchema, type ConfigSchemaType } from "@core/validations/config";
import { useTranslations } from "use-intl";
import { MyFormInput } from "@web/components/elements/form/my-form-input";
import { providerPath } from "./provider-path";
import type { TObject } from "@sinclair/typebox/type";
import { useFormContext } from "react-hook-form";

const variantSchema = { properties: {} } as unknown as TObject;
void ConfigSchema;

export function ProviderOpenRouterPanel(props: { index: number }) {
  const t = useTranslations();
  const form = useFormContext<ConfigSchemaType>();
  return (
    <div className="space-y-4">
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
        placeholder="https://openrouter.ai/api"
      />
      <MyFormInput
        control={form.control}
        name={providerPath(props.index, "apiKey")}
        schema={variantSchema}
        label={t("CONFIG.PROVIDER.API_KEY")}
        type="password"
        placeholder={t("CONFIG.PROVIDER.API_KEY_PLACEHOLDER_OPENROUTER")}
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
