import { ConfigSchema, type ConfigSchemaType } from "@core/validations/config";
import { useIntl } from "@web/components/provider/intl-provider";
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
  const { t } = useIntl();
  const form = useFormContext<ConfigSchemaType>();

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {t("CONFIG.TARGET.TITLE")}
        </CardTitle>
        <CardDescription>
          {t("CONFIG.TARGET.DESCRIPTION")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <MyFormInput
          control={form.control}
          name="target.baseUrl"
          schema={targetSchema}
          label={t("CONFIG.TARGET.BASE_URL")}
          placeholder={t("CONFIG.TARGET.BASE_URL_PLACEHOLDER")}
        />
        <MyFormInput
          control={form.control}
          name="target.systemAccessToken"
          schema={targetSchema}
          label={t("CONFIG.TARGET.SYSTEM_ACCESS_TOKEN")}
          type="password"
        />
        <div className="grid grid-cols-2 gap-4">
          <MyFormInput
            control={form.control}
            name="target.userId"
            schema={targetSchema}
            label={t("CONFIG.TARGET.USER_ID")}
            type="number"
            min={1}
          />
          <MyFormInput
            control={form.control}
            name="target.targetPrefix"
            schema={targetSchema}
            label={
              <>
                {t("CONFIG.TARGET.TARGET_PREFIX")}
                <span className="text-muted-foreground ml-1 text-xs font-normal">
                  ({t("CONFIG.FIELD.OPTIONAL")})
                </span>
              </>
            }
            placeholder={t("CONFIG.TARGET.TARGET_PREFIX_PLACEHOLDER")}
          />
        </div>
      </CardContent>
    </Card>
  );
}
