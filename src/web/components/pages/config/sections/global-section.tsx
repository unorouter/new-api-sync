import { ConfigSchema, type ConfigSchemaType } from "@core/validations/config";
import { MODEL_TYPES } from "@core/types";
import { useTranslations } from "use-intl";
import { MyFormCheckboxGroup } from "@web/components/elements/form/my-form-checkbox-group";
import { MyFormSwitch } from "@web/components/elements/form/my-form-switch";
import { Button } from "@web/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@web/components/ui/card";
import { Input } from "@web/components/ui/input";
import { Label } from "@web/components/ui/label";
import type { TObject } from "@sinclair/typebox/type";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { Controller, useFieldArray, useFormContext } from "react-hook-form";
import type { TranslationKey } from "@web/lib/constants";

const globalSchema = ConfigSchema as TObject;

const MODEL_TYPE_LABEL: Record<string, TranslationKey> = {
  text: "MODEL_TYPE.TEXT",
  image: "MODEL_TYPE.IMAGE",
  video: "MODEL_TYPE.VIDEO",
  audio: "MODEL_TYPE.AUDIO",
  embedding: "MODEL_TYPE.EMBEDDING",
};

export function GlobalSection() {
  const t = useTranslations();
  const form = useFormContext<ConfigSchemaType>();
  const blacklist = useFieldArray({
    control: form.control,
    name: "blacklist" as never,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {t("CONFIG.GLOBAL.TITLE")}
        </CardTitle>
        <CardDescription>
          {t("CONFIG.GLOBAL.DESCRIPTION")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <MyFormSwitch
          control={form.control}
          name="skipUnprofitableText"
          label={t("CONFIG.GLOBAL.SKIP_UNPROFITABLE_TEXT")}
        />

        <MyFormCheckboxGroup
          control={form.control}
          name="testModelTypes"
          schema={globalSchema}
          label={t("CONFIG.GLOBAL.TEST_MODEL_TYPES")}
          options={MODEL_TYPES.map((type) => ({
            value: type,
            label: t(MODEL_TYPE_LABEL[type]! as TranslationKey),
          }))}
        />
        <p className="text-muted-foreground -mt-4 text-xs">
          {t("CONFIG.GLOBAL.TEST_MODEL_TYPES_HELP")}
        </p>

        <div className="grid gap-2">
          <Label>
            {t("CONFIG.GLOBAL.BLACKLIST")}
          </Label>
          <p className="text-muted-foreground text-xs">
            {t("CONFIG.GLOBAL.BLACKLIST_HELP")}
          </p>
          {blacklist.fields.map((field, index) => (
            <div key={field.id} className="flex items-center gap-2">
              <Input
                {...form.register(`blacklist.${index}` as never)}
                placeholder={t("CONFIG.GLOBAL.BLACKLIST_PLACEHOLDER")}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => blacklist.remove(index)}
                aria-label={t("CONFIG.FIELD.REMOVE")}
              >
                <Trash2Icon />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => blacklist.append("" as never)}
            className="self-start"
          >
            <PlusIcon />
            {t("CONFIG.FIELD.ADD")}
          </Button>
        </div>

        <div className="grid gap-2">
          <Label>
            {t("CONFIG.GLOBAL.MODEL_MAPPING")}
          </Label>
          <p className="text-muted-foreground text-xs">
            {t("CONFIG.GLOBAL.MODEL_MAPPING_HELP")}
          </p>
          <Controller
            control={form.control}
            name="modelMapping"
            render={({ field }) => (
              <ModelMappingEditor
                value={(field.value ?? {}) as Record<string, string>}
                onChange={(next) =>
                  field.onChange(
                    Object.keys(next).length === 0 ? undefined : next,
                  )
                }
              />
            )}
          />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Inlined string/string key-value editor for modelMapping. Kept here since
 * it's the only string-valued KV in the schema; the old standalone
 * KeyValueEditor remains for priceAdjustment's numeric variant.
 */
function ModelMappingEditor(props: {
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
}) {
  const t = useTranslations();
  const entries = Object.entries(props.value);

  const update = (index: number, patch: { key?: string; value?: string }) => {
    const next = [...entries];
    const existing = next[index];
    if (!existing) return;
    const nextEntry: [string, string] = [
      patch.key ?? existing[0],
      patch.value ?? existing[1],
    ];
    next[index] = nextEntry;
    const asObject: Record<string, string> = {};
    for (const [k, v] of next) {
      if (!k || k in asObject) continue;
      asObject[k] = v;
    }
    props.onChange(asObject);
  };

  const remove = (index: number) => {
    const next = entries.filter((_, i) => i !== index);
    const asObject: Record<string, string> = {};
    for (const [k, v] of next) asObject[k] = v;
    props.onChange(asObject);
  };

  const add = () => {
    // Append empty key — user types it in. Object doesn't gain the entry until
    // a non-empty key is entered (because dedup filters empty).
    props.onChange({ ...props.value, "": "" });
  };

  return (
    <div className="space-y-2">
      {entries.map(([key, value], i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            value={key}
            onChange={(event) => update(i, { key: event.target.value })}
            placeholder={t("CONFIG.GLOBAL.UPSTREAM_MODEL_PLACEHOLDER")}
            className="flex-1"
          />
          <Input
            value={value}
            onChange={(event) => update(i, { value: event.target.value })}
            placeholder={t("CONFIG.GLOBAL.TARGET_MODEL_PLACEHOLDER")}
            className="flex-1"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => remove(i)}
            aria-label={t("CONFIG.FIELD.REMOVE")}
          >
            <Trash2Icon />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={add}>
        <PlusIcon />
        {t("CONFIG.FIELD.ADD")}
      </Button>
    </div>
  );
}
