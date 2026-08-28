import { ConfigSchema, type ConfigSchemaType } from "@core/validations/config";
import { MODEL_TYPES } from "@core/types";
import { EnabledModelsEditor } from "../editors/enabled-models-editor";
import { PriceAdjustmentEditor } from "../editors/price-adjustment-editor";
import { providerPath } from "./provider-path";
import { MyFormCheckboxGroup } from "@web/components/elements/form/my-form-checkbox-group";
import { MyFormInput } from "@web/components/elements/form/my-form-input";
import { useTranslations } from "use-intl";
import { Button } from "@web/components/ui/button";
import { Input } from "@web/components/ui/input";
import { Label } from "@web/components/ui/label";
import type { TranslationKey } from "@web/lib/constants";
import type { TObject } from "@sinclair/typebox/type";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { Controller, useFormContext } from "react-hook-form";

const variantSchema = { properties: {} } as unknown as TObject;
void ConfigSchema;

const MODEL_TYPE_LABEL: Record<string, TranslationKey> = {
  text: "MODEL_TYPE.TEXT",
  image: "MODEL_TYPE.IMAGE",
  video: "MODEL_TYPE.VIDEO",
  audio: "MODEL_TYPE.AUDIO",
  embedding: "MODEL_TYPE.EMBEDDING",
};

export function ProviderCommonFields(props: { index: number }) {
  const t = useTranslations();
  const form = useFormContext<ConfigSchemaType>();
  return (
    <div className="space-y-4">
      <MyFormInput
        control={form.control}
        name={providerPath(props.index, "name")}
        schema={variantSchema}
        label={t("CONFIG.PROVIDER.NAME")}
      />

      <MyFormCheckboxGroup
        control={form.control}
        name={providerPath(props.index, "testModelTypes")}
        schema={variantSchema}
        label={t("CONFIG.PROVIDER.TEST_MODEL_TYPES")}
        options={MODEL_TYPES.map((type) => ({
          value: type,
          label: t(MODEL_TYPE_LABEL[type]! as TranslationKey),
        }))}
      />

      <MyFormInput
        control={form.control}
        name={providerPath(props.index, "perUpstreamConcurrency")}
        schema={variantSchema}
        label={
          <>
            {t("CONFIG.PROVIDER.PER_UPSTREAM_CONCURRENCY")}
            <span className="text-muted-foreground ml-1 text-xs font-normal">
              ({t("CONFIG.FIELD.OPTIONAL")})
            </span>
          </>
        }
        type="number"
        min={1}
        max={1000}
        placeholder={t("CONFIG.PROVIDER.PER_UPSTREAM_CONCURRENCY_PLACEHOLDER")}
      />

      <div className="grid gap-2">
        <Label>{t("CONFIG.PROVIDER.ENABLED_MODELS")}</Label>
        <Controller
          control={form.control}
          name={providerPath(props.index, "enabledModels")}
          render={({ field }) => (
            <EnabledModelsEditor
              items={
                field.value as Parameters<
                  typeof EnabledModelsEditor
                >[0]["items"]
              }
              onChange={field.onChange}
            />
          )}
        />
      </div>

      <div className="grid gap-2">
        <Label>{t("CONFIG.PROVIDER.PRICE_ADJUSTMENT")}</Label>
        <Controller
          control={form.control}
          name={providerPath(props.index, "priceAdjustment")}
          render={({ field }) => (
            <PriceAdjustmentEditor
              value={
                field.value as Parameters<
                  typeof PriceAdjustmentEditor
                >[0]["value"]
              }
              onChange={field.onChange}
            />
          )}
        />
      </div>
    </div>
  );
}
