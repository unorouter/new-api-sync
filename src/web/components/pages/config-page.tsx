import {
  ConfigSchema,
  customValidateConfig,
  type ConfigSchemaType,
} from "@core/config";
import { typeboxResolver } from "@hookform/resolvers/typebox";
import { GlobalSection } from "@web/components/elements/config/global-section";
import { ProvidersSection } from "@web/components/elements/config/providers-section";
import { TargetSection } from "@web/components/elements/config/target-section";
import {
  FormattedMessage,
  useIntl,
} from "@web/components/provider/intl-provider";
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
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

/**
 * Structured editor for a config file. A single root `useForm` feeds every
 * section; child sections reach for `control` via `useFormContext`. The
 * floating Save/Revert bar is wired to `form.formState.isDirty`.
 */
export function ConfigPage() {
  const intl = useIntl();
  const selectedName = useUiStore((s) => s.selectedConfigName);
  const config = useConfig(selectedName);
  const save = useSaveConfig(selectedName);
  const [lastServerError, setLastServerError] = useState<string | null>(null);

  const form = useForm<ConfigSchemaType>({
    resolver: typeboxResolver(ConfigSchema),
  });

  // Hydrate defaults once the server value lands (and after a successful save).
  useEffect(() => {
    if (config.data) {
      form.reset(config.data.config);
      setLastServerError(null);
    }
  }, [config.data, form]);

  const handleRevert = () => {
    if (config.data) form.reset(config.data.config);
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
        onError: (error) =>
          setLastServerError(
            error instanceof Error ? error.message : String(error),
          ),
      });
    },
    (errors) => {
      // Surface the first resolver error as a toast so it's not silently
      // stuck in formState.
      const first = Object.values(errors)[0];
      const message =
        (first && typeof first === "object" && "message" in first
          ? String((first as { message?: unknown }).message ?? "")
          : "") || intl.formatMessage({ id: "CONFIG.VALIDATION.FAILED" });
      toast.error(message);
      setLastServerError(message);
    },
  );

  if (config.isPending) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            <FormattedMessage id="CONFIG.TITLE" />
          </CardTitle>
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
          <CardTitle>
            <FormattedMessage id="CONFIG.TITLE" />
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-destructive text-sm">
            {intl.formatMessage(
              { id: "CONFIG.LOAD_ERROR" },
              { error: String(config.error) },
            )}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!config.data) return null;

  const dirty = form.formState.isDirty;
  const showBar = dirty || lastServerError !== null || save.isPending;

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} className="space-y-4 pb-20">
        <TargetSection />
        <GlobalSection />
        <ProvidersSection />

        {showBar ? (
          <div className="fixed right-6 bottom-6 z-50">
            <Card
              size="sm"
              className="bg-background/95 shadow-lg backdrop-blur supports-backdrop-filter:bg-background/80"
            >
              <CardContent className="flex items-center gap-3 py-3">
                <div className="flex flex-col gap-0.5">
                  <span className="text-muted-foreground font-mono text-xs">
                    {config.data.path}
                  </span>
                  {lastServerError ? (
                    <span className="text-destructive text-xs">
                      {lastServerError}
                    </span>
                  ) : dirty ? (
                    <span className="text-muted-foreground text-xs">
                      <FormattedMessage id="CONFIG.UNSAVED" />
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
                      <FormattedMessage id="CONFIG.REVERT" />
                    </Button>
                  ) : null}
                  <Button
                    type="submit"
                    disabled={!dirty || save.isPending}
                  >
                    <FormattedMessage
                      id={save.isPending ? "CONFIG.SAVING" : "CONFIG.SAVE"}
                    />
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
