import type { ConfigSchemaType } from "@core/config";
import type { ModelType } from "@core/models/constants";
import { FormattedMessage } from "@web/components/provider/intl-provider";
import { Input } from "@web/components/ui/input";
import { Label } from "@web/components/ui/label";
import { EnabledModelsEditor } from "./fields/enabled-models-editor";
import { ModelTypeMultiSelect } from "./fields/model-type-multi-select";
import { PriceAdjustmentEditor } from "./fields/price-adjustment-editor";
import { StringListEditor } from "./fields/string-list-editor";

type Provider = ConfigSchemaType["providers"][number];

interface Props {
  value: Provider;
  onChange: (value: Provider) => void;
}

type EnabledModelEntry = NonNullable<Provider["enabledModels"]>[number];

export function ProviderCommonFields(props: Props) {
  const updateField = <K extends keyof Provider>(
    key: K,
    value: Provider[K],
  ) => {
    props.onChange({ ...props.value, [key]: value } as Provider);
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <Label>
          <FormattedMessage id="CONFIG.PROVIDER.NAME" />
        </Label>
        <Input
          value={props.value.name}
          onChange={(event) => updateField("name", event.target.value)}
        />
      </div>

      <div className="grid gap-2">
        <Label>
          <FormattedMessage id="CONFIG.PROVIDER.TEST_MODEL_TYPES" />
        </Label>
        <ModelTypeMultiSelect
          value={props.value.testModelTypes as ModelType[] | undefined}
          onChange={(next) =>
            updateField("testModelTypes", next as never)
          }
        />
      </div>

      <div className="grid gap-2">
        <Label>
          <FormattedMessage id="CONFIG.PROVIDER.ENABLED_VENDORS" />
        </Label>
        <StringListEditor
          items={props.value.enabledVendors ?? []}
          onChange={(items) =>
            updateField(
              "enabledVendors",
              items.length === 0 ? undefined : items,
            )
          }
          placeholder="anthropic, openai, …"
        />
      </div>

      <div className="grid gap-2">
        <Label>
          <FormattedMessage id="CONFIG.PROVIDER.ENABLED_MODELS" />
        </Label>
        <EnabledModelsEditor
          items={props.value.enabledModels as EnabledModelEntry[] | undefined}
          onChange={(items) =>
            updateField("enabledModels", items as never)
          }
        />
      </div>

      <div className="grid gap-2">
        <Label>
          <FormattedMessage id="CONFIG.PROVIDER.PRICE_ADJUSTMENT" />
        </Label>
        <PriceAdjustmentEditor
          value={
            props.value.priceAdjustment as
              | number
              | Record<string, number>
              | undefined
          }
          onChange={(next) =>
            updateField("priceAdjustment", next as never)
          }
        />
      </div>
    </div>
  );
}
