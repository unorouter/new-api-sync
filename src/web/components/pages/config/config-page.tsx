import { customValidateConfig } from "@core/config";
import { ConfigSchema, type ConfigSchemaType } from "@core/validations/config";
import { typeboxResolver } from "@hookform/resolvers/typebox";
import { useTranslations } from "use-intl";
import { Button } from "@web/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@web/components/ui/card";
import { Form } from "@web/components/ui/form";
import { Skeleton } from "@web/components/ui/skeleton";
import { useConfig, useSaveConfig } from "@web/hooks/config-hook";
import { useUiStore } from "@web/store/ui-store";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { GlobalSection } from "./sections/global-section";
import { GlobalSettingsSection } from "./sections/global-settings-section";
import { ProvidersSection } from "./sections/providers-section";
import { TargetSection } from "./sections/target-section";

/**
 * Structured editor for a config file. Outer component loads the server data
 * and gates rendering on it so the inner `useForm` can set `defaultValues`
 * once — giving us correct `isDirty` semantics out of the box. Remounting
 * the inner via `key` on the config path/name also guarantees a clean form
 * whenever the user swaps configs.
 */
export function ConfigPage() {
  const t = useTranslations();
  const selectedName = useUiStore((s) => s.selectedConfigName);
  const config = useConfig(selectedName);

  if (config.isPending) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("CONFIG.TITLE")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-64 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (config.error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("CONFIG.TITLE")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-destructive text-sm">
            {t("CONFIG.LOAD_ERROR", { error: String(config.error) })}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!config.data) return null;

  return (
    <ConfigForm
      key={config.data.path}
      name={selectedName}
      path={config.data.path}
      defaults={config.data.config}
    />
  );
}

function ConfigForm(props: {
  name: string;
  path: string;
  defaults: ConfigSchemaType;
}) {
  const t = useTranslations();
  const save = useSaveConfig(props.name);
  const [lastServerError, setLastServerError] = useState<string | null>(null);

  // `values` (rather than `defaultValues`) so RHF re-syncs whenever the
  // server-provided defaults change after a save. Also `resetOptions` tells
  // RHF to preserve dirty/touched flags as false on that re-sync.
  const form = useForm<ConfigSchemaType>({
    resolver: typeboxResolver(ConfigSchema),
    values: props.defaults,
    resetOptions: { keepDirtyValues: false, keepDirty: false },
  });

  const handleRevert = () => {
    form.reset(props.defaults);
    setLastServerError(null);
  };

  const onSubmit = form.handleSubmit(
    (values) => {
      const customErrors = customValidateConfig(values);
      if (customErrors.length > 0) {
        const message = customErrors[0]!;
        toast.error(message);
        setLastServerError(message);
        return;
      }
      setLastServerError(null);
      save.mutate(values, {
        // Re-seed defaults with the saved values so isDirty clears cleanly.
        // The mutation returns { path, config }; only config belongs in the form.
        onSuccess: (data) => form.reset(data.config),
        onError: (error) =>
          setLastServerError(
            error instanceof Error ? error.message : String(error),
          ),
      });
    },
    (errors) => {
      const first = Object.values(errors)[0];
      const message =
        (first && typeof first === "object" && "message" in first
          ? String((first as { message?: unknown }).message ?? "")
          : "") || t("CONFIG.VALIDATION.FAILED");
      toast.error(message);
      setLastServerError(message);
    },
  );

  // `isDirty` alone lies here: useFieldArray flips it true at mount even
  // when no field has actually changed and `dirtyFields` is empty. Trust
  // `dirtyFields` as the source of truth instead.
  const dirty = Object.keys(form.formState.dirtyFields).length > 0;
  const showBar = dirty || lastServerError !== null || save.isPending;

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} className="space-y-4 pb-20">
        <TargetSection />
        <GlobalSection />
        <GlobalSettingsSection />
        <ProvidersSection />

        {showBar ? (
          <div className="fixed right-6 bottom-6 z-50">
            <Card
              size="sm"
              className="bg-background/95 supports-backdrop-filter:bg-background/80 shadow-lg backdrop-blur"
            >
              <CardContent className="flex items-center gap-3 py-3">
                <div className="flex flex-col gap-0.5">
                  <span className="text-muted-foreground font-mono text-xs">
                    {props.path}
                  </span>
                  {lastServerError ? (
                    <span className="text-destructive text-xs">
                      {lastServerError}
                    </span>
                  ) : dirty ? (
                    <span className="text-muted-foreground text-xs">
                      {t("CONFIG.UNSAVED")}
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  {dirty ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleRevert}
                      disabled={save.isPending}
                    >
                      {t("CONFIG.REVERT")}
                    </Button>
                  ) : null}
                  <Button type="submit" disabled={!dirty || save.isPending}>
                    {t(save.isPending ? "CONFIG.SAVING" : "CONFIG.SAVE")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        ) : null}
      </form>
    </Form>
  );
}
