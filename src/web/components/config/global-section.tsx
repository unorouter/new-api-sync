import type { ConfigSchemaType } from "@core/config";
import type { ModelType } from "@core/models/constants";
import { FormattedMessage } from "@web/components/provider/intl-provider";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@web/components/ui/card";
import { Label } from "@web/components/ui/label";
import { Switch } from "@web/components/ui/switch";
import { KeyValueEditor } from "./fields/key-value-editor";
import { ModelTypeMultiSelect } from "./fields/model-type-multi-select";
import { StringListEditor } from "./fields/string-list-editor";

interface Props {
  value: ConfigSchemaType;
  onChange: (value: ConfigSchemaType) => void;
}

export function GlobalSection(props: Props) {
  const modelMapping = (props.value.modelMapping ?? {}) as Record<
    string,
    string
  >;

  const updateField = <K extends keyof ConfigSchemaType>(
    key: K,
    value: ConfigSchemaType[K],
  ) => {
    const next = { ...props.value, [key]: value };
    props.onChange(next);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <FormattedMessage id="CONFIG.GLOBAL.TITLE" />
        </CardTitle>
        <CardDescription>
          <FormattedMessage id="CONFIG.GLOBAL.DESCRIPTION" />
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label className="font-medium">
              <FormattedMessage id="CONFIG.GLOBAL.SKIP_UNPROFITABLE_TEXT" />
            </Label>
          </div>
          <Switch
            checked={props.value.skipUnprofitableText ?? true}
            onCheckedChange={(next) =>
              updateField("skipUnprofitableText", next)
            }
          />
        </div>

        <div className="grid gap-2">
          <Label>
            <FormattedMessage id="CONFIG.GLOBAL.TEST_MODEL_TYPES" />
          </Label>
          <p className="text-muted-foreground text-xs">
            <FormattedMessage id="CONFIG.GLOBAL.TEST_MODEL_TYPES_HELP" />
          </p>
          <ModelTypeMultiSelect
            value={props.value.testModelTypes as ModelType[] | undefined}
            onChange={(next) => updateField("testModelTypes", next as never)}
          />
        </div>

        <div className="grid gap-2">
          <Label>
            <FormattedMessage id="CONFIG.GLOBAL.BLACKLIST" />
          </Label>
          <p className="text-muted-foreground text-xs">
            <FormattedMessage id="CONFIG.GLOBAL.BLACKLIST_HELP" />
          </p>
          <StringListEditor
            items={props.value.blacklist ?? []}
            onChange={(items) =>
              updateField("blacklist", items.length === 0 ? undefined : items)
            }
            placeholder="model name or glob"
          />
        </div>

        <div className="grid gap-2">
          <Label>
            <FormattedMessage id="CONFIG.GLOBAL.MODEL_MAPPING" />
          </Label>
          <p className="text-muted-foreground text-xs">
            <FormattedMessage id="CONFIG.GLOBAL.MODEL_MAPPING_HELP" />
          </p>
          <KeyValueEditor
            pairs={modelMapping}
            onChange={(pairs) => {
              const stringPairs: Record<string, string> = {};
              for (const [key, value] of Object.entries(pairs)) {
                stringPairs[key] = String(value);
              }
              updateField(
                "modelMapping",
                Object.keys(stringPairs).length === 0
                  ? undefined
                  : (stringPairs as ConfigSchemaType["modelMapping"]),
              );
            }}
            keyPlaceholder="upstream model"
            valuePlaceholder="target model"
          />
        </div>
      </CardContent>
    </Card>
  );
}
