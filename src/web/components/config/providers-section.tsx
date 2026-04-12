import type { ConfigSchemaType } from "@core/config";
import { FormattedMessage } from "@web/components/provider/intl-provider";
import { Button } from "@web/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@web/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@web/components/ui/dialog";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { ProviderCard } from "./provider-card";

type Provider = ConfigSchemaType["providers"][number];
type ProviderType = Provider["type"];

const TEMPLATES: Record<ProviderType, () => Provider> = {
  newapi: () => ({
    type: "newapi",
    name: "",
    baseUrl: "",
    systemAccessToken: "",
    userId: 1,
  }),
  sub2api: () => ({
    type: "sub2api",
    name: "",
    baseUrl: "",
    adminApiKey: "",
  }),
  direct: () => ({
    type: "direct",
    name: "",
    baseUrl: "",
    apiKey: "",
    vendor: "",
  }),
  nvidia: () => ({
    type: "nvidia",
    name: "",
    apiKey: "",
  }),
};

const TYPE_ORDER: ProviderType[] = ["newapi", "sub2api", "direct", "nvidia"];

interface Props {
  value: Provider[];
  onChange: (value: Provider[]) => void;
}

export function ProvidersSection(props: Props) {
  const [pickOpen, setPickOpen] = useState(false);

  const addProvider = (type: ProviderType) => {
    const next = [...props.value, TEMPLATES[type]()];
    props.onChange(next);
    setPickOpen(false);
  };

  const updateProvider = (index: number, provider: Provider) => {
    const next = [...props.value];
    next[index] = provider;
    props.onChange(next);
  };

  const deleteProvider = (index: number) => {
    props.onChange(props.value.filter((_, i) => i !== index));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <FormattedMessage id="CONFIG.PROVIDERS.TITLE" />
        </CardTitle>
        <CardDescription>
          <FormattedMessage id="CONFIG.PROVIDERS.DESCRIPTION" />
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {props.value.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            <FormattedMessage id="CONFIG.PROVIDERS.EMPTY" />
          </p>
        ) : null}
        {props.value.map((provider, i) => (
          <ProviderCard
            key={i}
            value={provider}
            onChange={(next) => updateProvider(i, next)}
            onDelete={() => deleteProvider(i)}
          />
        ))}
        <Button variant="outline" onClick={() => setPickOpen(true)}>
          <PlusIcon />
          <FormattedMessage id="CONFIG.PROVIDERS.ADD" />
        </Button>
      </CardContent>

      <Dialog open={pickOpen} onOpenChange={setPickOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <FormattedMessage id="CONFIG.PROVIDERS.PICK_TYPE" />
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            {TYPE_ORDER.map((type) => (
              <Button
                key={type}
                variant="outline"
                onClick={() => addProvider(type)}
                className="justify-start"
              >
                {type}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
