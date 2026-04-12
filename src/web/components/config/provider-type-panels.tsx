import type { ConfigSchemaType } from "@core/config";
import { FormattedMessage } from "@web/components/provider/intl-provider";
import { Input } from "@web/components/ui/input";
import { Label } from "@web/components/ui/label";
import { Sub2ApiGroupsEditor } from "./fields/sub2api-groups-editor";

type Provider = ConfigSchemaType["providers"][number];
type NewApi = Extract<Provider, { type: "newapi" }>;
type Sub2Api = Extract<Provider, { type: "sub2api" }>;
type Direct = Extract<Provider, { type: "direct" }>;
type Nvidia = Extract<Provider, { type: "nvidia" }>;

/** newapi: baseUrl / systemAccessToken / userId */
export function NewApiPanel(props: {
  value: NewApi;
  onChange: (value: NewApi) => void;
}) {
  const update = <K extends keyof NewApi>(key: K, value: NewApi[K]) =>
    props.onChange({ ...props.value, [key]: value });

  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <Label>
          <FormattedMessage id="CONFIG.PROVIDER.BASE_URL" />
        </Label>
        <Input
          value={props.value.baseUrl}
          onChange={(event) => update("baseUrl", event.target.value)}
          placeholder="https://…"
        />
      </div>
      <div className="grid gap-2">
        <Label>
          <FormattedMessage id="CONFIG.PROVIDER.SYSTEM_ACCESS_TOKEN" />
        </Label>
        <Input
          value={props.value.systemAccessToken}
          onChange={(event) => update("systemAccessToken", event.target.value)}
          type="password"
        />
      </div>
      <div className="grid gap-2">
        <Label>
          <FormattedMessage id="CONFIG.PROVIDER.USER_ID" />
        </Label>
        <Input
          type="number"
          min={1}
          value={props.value.userId}
          onChange={(event) =>
            update("userId", Number(event.target.value) || 1)
          }
        />
      </div>
    </div>
  );
}

/** sub2api: baseUrl, adminApiKey?, groups? (one or the other required) */
export function Sub2ApiPanel(props: {
  value: Sub2Api;
  onChange: (value: Sub2Api) => void;
}) {
  const update = (patch: Partial<Sub2Api>) => {
    const next = { ...props.value, ...patch };
    if (next.adminApiKey === "") delete next.adminApiKey;
    props.onChange(next);
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <Label>
          <FormattedMessage id="CONFIG.PROVIDER.BASE_URL" />
        </Label>
        <Input
          value={props.value.baseUrl}
          onChange={(event) => update({ baseUrl: event.target.value })}
          placeholder="https://…"
        />
      </div>
      <div className="grid gap-2">
        <Label>
          <FormattedMessage id="CONFIG.PROVIDER.ADMIN_API_KEY" />
          <span className="text-muted-foreground text-xs font-normal">
            (<FormattedMessage id="CONFIG.FIELD.OPTIONAL" />)
          </span>
        </Label>
        <Input
          value={props.value.adminApiKey ?? ""}
          onChange={(event) => update({ adminApiKey: event.target.value })}
          type="password"
          placeholder="admin-…"
        />
      </div>
      <div className="grid gap-2">
        <Label>
          <FormattedMessage id="CONFIG.PROVIDER.GROUPS" />
        </Label>
        <Sub2ApiGroupsEditor
          groups={props.value.groups}
          onChange={(groups) => update({ groups })}
        />
      </div>
    </div>
  );
}

/** direct: baseUrl / apiKey / vendor + optional models, channelType, ratio, discoverEndpoint */
export function DirectPanel(props: {
  value: Direct;
  onChange: (value: Direct) => void;
}) {
  const update = (patch: Partial<Direct>) => {
    const next = { ...props.value, ...patch };
    if (next.discoverEndpoint === "") delete next.discoverEndpoint;
    props.onChange(next);
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <Label>
          <FormattedMessage id="CONFIG.PROVIDER.BASE_URL" />
        </Label>
        <Input
          value={props.value.baseUrl}
          onChange={(event) => update({ baseUrl: event.target.value })}
          placeholder="https://…"
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-2">
          <Label>
            <FormattedMessage id="CONFIG.PROVIDER.VENDOR" />
          </Label>
          <Input
            value={props.value.vendor}
            onChange={(event) => update({ vendor: event.target.value })}
            placeholder="moonshot, zhipu, …"
          />
        </div>
        <div className="grid gap-2">
          <Label>
            <FormattedMessage id="CONFIG.PROVIDER.CHANNEL_TYPE" />
            <span className="text-muted-foreground text-xs font-normal">
              (<FormattedMessage id="CONFIG.FIELD.OPTIONAL" />)
            </span>
          </Label>
          <Input
            type="number"
            min={1}
            value={props.value.channelType ?? ""}
            onChange={(event) =>
              update({
                channelType:
                  event.target.value === ""
                    ? undefined
                    : Number(event.target.value),
              })
            }
          />
        </div>
      </div>
      <div className="grid gap-2">
        <Label>
          <FormattedMessage id="CONFIG.PROVIDER.API_KEY" />
        </Label>
        <Input
          value={props.value.apiKey}
          onChange={(event) => update({ apiKey: event.target.value })}
          type="password"
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-2">
          <Label>
            <FormattedMessage id="CONFIG.PROVIDER.RATIO" />
          </Label>
          <Input
            type="number"
            step="any"
            value={props.value.ratio ?? 1}
            onChange={(event) =>
              update({
                ratio:
                  event.target.value === ""
                    ? undefined
                    : Number(event.target.value),
              })
            }
          />
        </div>
        <div className="grid gap-2">
          <Label>
            <FormattedMessage id="CONFIG.PROVIDER.DISCOVER_ENDPOINT" />
            <span className="text-muted-foreground text-xs font-normal">
              (<FormattedMessage id="CONFIG.FIELD.OPTIONAL" />)
            </span>
          </Label>
          <Input
            value={props.value.discoverEndpoint ?? ""}
            onChange={(event) =>
              update({ discoverEndpoint: event.target.value })
            }
            placeholder="/v1/models"
          />
        </div>
      </div>
    </div>
  );
}

/** nvidia: optional baseUrl / imageBaseUrl, required apiKey, optional ratio. */
export function NvidiaPanel(props: {
  value: Nvidia;
  onChange: (value: Nvidia) => void;
}) {
  const update = (patch: Partial<Nvidia>) => {
    const next = { ...props.value, ...patch };
    if (next.baseUrl === "") delete next.baseUrl;
    if (next.imageBaseUrl === "") delete next.imageBaseUrl;
    props.onChange(next);
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-2">
          <Label>
            <FormattedMessage id="CONFIG.PROVIDER.BASE_URL" />
            <span className="text-muted-foreground text-xs font-normal">
              (<FormattedMessage id="CONFIG.FIELD.OPTIONAL" />)
            </span>
          </Label>
          <Input
            value={props.value.baseUrl ?? ""}
            onChange={(event) => update({ baseUrl: event.target.value })}
            placeholder="https://integrate.api.nvidia.com"
          />
        </div>
        <div className="grid gap-2">
          <Label>
            <FormattedMessage id="CONFIG.PROVIDER.IMAGE_BASE_URL" />
            <span className="text-muted-foreground text-xs font-normal">
              (<FormattedMessage id="CONFIG.FIELD.OPTIONAL" />)
            </span>
          </Label>
          <Input
            value={props.value.imageBaseUrl ?? ""}
            onChange={(event) => update({ imageBaseUrl: event.target.value })}
            placeholder="https://ai.api.nvidia.com"
          />
        </div>
      </div>
      <div className="grid gap-2">
        <Label>
          <FormattedMessage id="CONFIG.PROVIDER.API_KEY" />
        </Label>
        <Input
          value={props.value.apiKey}
          onChange={(event) => update({ apiKey: event.target.value })}
          type="password"
          placeholder="nvapi-…"
        />
      </div>
      <div className="grid gap-2">
        <Label>
          <FormattedMessage id="CONFIG.PROVIDER.RATIO" />
        </Label>
        <Input
          type="number"
          step="any"
          value={props.value.ratio ?? 1}
          onChange={(event) =>
            update({
              ratio:
                event.target.value === ""
                  ? undefined
                  : Number(event.target.value),
            })
          }
        />
      </div>
    </div>
  );
}
