import type { ConfigSchemaType } from "@core/validations/config";
import { ProviderCard } from "@web/components/elements/config/provider-card";
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
import { useFieldArray, useFormContext } from "react-hook-form";

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

export function ProvidersSection() {
  const form = useFormContext<ConfigSchemaType>();
  const providers = useFieldArray({
    control: form.control,
    name: "providers",
  });
  const [pickOpen, setPickOpen] = useState(false);

  const addProvider = (type: ProviderType) => {
    providers.append(TEMPLATES[type]());
    setPickOpen(false);
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
        {providers.fields.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            <FormattedMessage id="CONFIG.PROVIDERS.EMPTY" />
          </p>
        ) : null}
        {providers.fields.map((field, i) => (
          <ProviderCard
            key={field.id}
            index={i}
            onDelete={() => providers.remove(i)}
          />
        ))}
        <Button
          type="button"
          variant="outline"
          onClick={() => setPickOpen(true)}
        >
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
                type="button"
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
