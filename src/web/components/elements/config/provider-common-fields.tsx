import { ConfigSchema, type ConfigSchemaType } from "@core/config";
import { MODEL_TYPES } from "@core/models/types";
import { EnabledModelsEditor } from "@web/components/elements/config/enabled-models-editor";
import { PriceAdjustmentEditor } from "@web/components/elements/config/price-adjustment-editor";
import { providerPath } from "@web/components/elements/config/provider-path";
import { MyFormCheckboxGroup } from "@web/components/elements/form/my-form-checkbox-group";
import { MyFormInput } from "@web/components/elements/form/my-form-input";
import { FormattedMessage } from "@web/components/provider/intl-provider";
import { Button } from "@web/components/ui/button";
import { Input } from "@web/components/ui/input";
import { Label } from "@web/components/ui/label";
import type { TranslationKey } from "@web/lib/constants";
import type { TObject } from "@sinclair/typebox/type";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { Controller, useFieldArray, useFormContext } from "react-hook-form";

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
  const form = useFormContext<ConfigSchemaType>();
  const vendors = useFieldArray({
    control: form.control,
    name: providerPath(props.index, "enabledVendors") as never,
  });

  return (
    <div className="space-y-4">
      <MyFormInput
        control={form.control}
        name={providerPath(props.index, "name")}
        schema={variantSchema}
        label={<FormattedMessage id="CONFIG.PROVIDER.NAME" />}
      />

      <MyFormCheckboxGroup
        control={form.control}
        name={providerPath(props.index, "testModelTypes")}
        schema={variantSchema}
        label={<FormattedMessage id="CONFIG.PROVIDER.TEST_MODEL_TYPES" />}
        options={MODEL_TYPES.map((type) => ({
          value: type,
          label: <FormattedMessage id={MODEL_TYPE_LABEL[type]!} />,
        }))}
      />

      <div className="grid gap-2">
        <Label>
          <FormattedMessage id="CONFIG.PROVIDER.ENABLED_VENDORS" />
        </Label>
        {vendors.fields.map((field, i) => (
          <div key={field.id} className="flex items-center gap-2">
            <Input
              {...form.register(
                `${providerPath(props.index, "enabledVendors")}.${i}` as never,
              )}
              placeholder="anthropic, openai, …"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => vendors.remove(i)}
              aria-label="Remove"
            >
              <Trash2Icon />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => vendors.append("" as never)}
          className="self-start"
        >
          <PlusIcon />
          <FormattedMessage id="CONFIG.FIELD.ADD" />
        </Button>
      </div>

      <div className="grid gap-2">
        <Label>
          <FormattedMessage id="CONFIG.PROVIDER.ENABLED_MODELS" />
        </Label>
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
        <Label>
          <FormattedMessage id="CONFIG.PROVIDER.PRICE_ADJUSTMENT" />
        </Label>
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
