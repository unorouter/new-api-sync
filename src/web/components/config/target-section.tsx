import type { ConfigSchemaType } from "@core/config";
import { FormattedMessage } from "@web/components/provider/intl-provider";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@web/components/ui/card";
import { Input } from "@web/components/ui/input";
import { Label } from "@web/components/ui/label";

type Target = ConfigSchemaType["target"];

interface Props {
  value: Target;
  onChange: (value: Target) => void;
}

export function TargetSection(props: Props) {
  const update = (patch: Partial<Target>) => {
    const next = { ...props.value, ...patch };
    if (next.targetPrefix === "") delete next.targetPrefix;
    props.onChange(next);
  };

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
        <div className="grid gap-2">
          <Label>
            <FormattedMessage id="CONFIG.TARGET.BASE_URL" />
          </Label>
          <Input
            value={props.value.baseUrl}
            onChange={(event) => update({ baseUrl: event.target.value })}
            placeholder="https://api.example.com"
          />
        </div>
        <div className="grid gap-2">
          <Label>
            <FormattedMessage id="CONFIG.TARGET.SYSTEM_ACCESS_TOKEN" />
          </Label>
          <Input
            value={props.value.systemAccessToken}
            onChange={(event) =>
              update({ systemAccessToken: event.target.value })
            }
            type="password"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="grid gap-2">
            <Label>
              <FormattedMessage id="CONFIG.TARGET.USER_ID" />
            </Label>
            <Input
              type="number"
              min={1}
              value={props.value.userId}
              onChange={(event) =>
                update({ userId: Number(event.target.value) || 1 })
              }
            />
          </div>
          <div className="grid gap-2">
            <Label>
              <FormattedMessage id="CONFIG.TARGET.TARGET_PREFIX" />
              <span className="text-muted-foreground text-xs font-normal">
                (<FormattedMessage id="CONFIG.FIELD.OPTIONAL" />)
              </span>
            </Label>
            <Input
              value={props.value.targetPrefix ?? ""}
              onChange={(event) => update({ targetPrefix: event.target.value })}
              placeholder="prod"
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
