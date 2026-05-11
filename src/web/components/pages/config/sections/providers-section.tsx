import type { ConfigSchemaType } from "@core/validations/config";
import { ProviderCard } from "../providers/provider-card";
import { useTranslations } from "use-intl";
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
  nvidia: () => ({
    type: "nvidia",
    name: "",
    apiKey: "",
  }),
  openrouter: () => ({
    type: "openrouter",
    name: "",
    apiKey: "",
  }),
  comfyui: () => ({
    type: "comfyui",
    name: "",
    apiKey: "",
    provider: "runpod",
    baseUrl: "https://api.runpod.ai",
    templates: {},
  }),
};

const TYPE_ORDER: ProviderType[] = [
  "newapi",
  "sub2api",
  "nvidia",
  "openrouter",
  "comfyui",
];

export function ProvidersSection() {
  const t = useTranslations();
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
        <CardTitle>{t("CONFIG.PROVIDERS.TITLE")}</CardTitle>
        <CardDescription>{t("CONFIG.PROVIDERS.DESCRIPTION")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {providers.fields.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("CONFIG.PROVIDERS.EMPTY")}
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
          {t("CONFIG.PROVIDERS.ADD")}
        </Button>
      </CardContent>

      <Dialog open={pickOpen} onOpenChange={setPickOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("CONFIG.PROVIDERS.PICK_TYPE")}</DialogTitle>
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
