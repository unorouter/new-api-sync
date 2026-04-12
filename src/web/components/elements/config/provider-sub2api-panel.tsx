import { ConfigSchema, type ConfigSchemaType } from "@core/config";
import { FormattedMessage } from "@web/components/provider/intl-provider";
import { MyFormInput } from "@web/components/elements/form/my-form-input";
import { providerPath } from "@web/components/elements/config/provider-path";
import { Sub2ApiGroupsEditor } from "@web/components/elements/config/sub2api-groups-editor";
import { Label } from "@web/components/ui/label";
import type { TObject } from "@sinclair/typebox/type";
import { Controller, useFormContext } from "react-hook-form";

const variantSchema = { properties: {} } as unknown as TObject;
void ConfigSchema;

type Groups = Extract<
  ConfigSchemaType["providers"][number],
  { type: "sub2api" }
>["groups"];

export function ProviderSub2ApiPanel(props: { index: number }) {
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
      <MyFormInput
        control={form.control}
        name={providerPath(props.index, "adminApiKey")}
        schema={variantSchema}
        label={
          <>
            <FormattedMessage id="CONFIG.PROVIDER.ADMIN_API_KEY" />
            <span className="text-muted-foreground ml-1 text-xs font-normal">
              (<FormattedMessage id="CONFIG.FIELD.OPTIONAL" />)
            </span>
          </>
        }
        type="password"
        placeholder="admin-…"
      />
      <div className="grid gap-2">
        <Label>
          <FormattedMessage id="CONFIG.PROVIDER.GROUPS" />
        </Label>
        <Controller
          control={form.control}
          name={providerPath(props.index, "groups")}
          render={({ field }) => (
            <Sub2ApiGroupsEditor
              groups={field.value as Groups}
              onChange={field.onChange}
            />
          )}
        />
      </div>
    </div>
  );
}
