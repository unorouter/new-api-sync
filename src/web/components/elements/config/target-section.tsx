import { ConfigSchema, type ConfigSchemaType } from "@core/config";
import { FormattedMessage } from "@web/components/provider/intl-provider";
import { MyFormInput } from "@web/components/elements/form/my-form-input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@web/components/ui/card";
import type { TObject } from "@sinclair/typebox/type";
import { useFormContext } from "react-hook-form";

const targetSchema = ConfigSchema.properties.target as TObject;

export function TargetSection() {
  const form = useFormContext<ConfigSchemaType>();

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <FormattedMessage id="CONFIG.TARGET.TITLE" />
        </CardTitle>
        <CardDescription>
          <FormattedMessage id="CONFIG.TARGET.DESCRIPTION" />
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <MyFormInput
          control={form.control}
          name="target.baseUrl"
          schema={targetSchema}
          label={<FormattedMessage id="CONFIG.TARGET.BASE_URL" />}
          placeholder="https://api.example.com"
        />
        <MyFormInput
          control={form.control}
          name="target.systemAccessToken"
          schema={targetSchema}
          label={<FormattedMessage id="CONFIG.TARGET.SYSTEM_ACCESS_TOKEN" />}
          type="password"
        />
        <div className="grid grid-cols-2 gap-4">
          <MyFormInput
            control={form.control}
            name="target.userId"
            schema={targetSchema}
            label={<FormattedMessage id="CONFIG.TARGET.USER_ID" />}
            type="number"
            min={1}
          />
          <MyFormInput
            control={form.control}
            name="target.targetPrefix"
            schema={targetSchema}
            label={
              <>
                <FormattedMessage id="CONFIG.TARGET.TARGET_PREFIX" />
                <span className="text-muted-foreground ml-1 text-xs font-normal">
                  (<FormattedMessage id="CONFIG.FIELD.OPTIONAL" />)
                </span>
              </>
            }
            placeholder="prod"
          />
        </div>
      </CardContent>
    </Card>
  );
}
