import {
  ConfigSchema,
  customValidateConfig,
  type ConfigSchemaType,
} from "@core/config";
import { Value } from "@sinclair/typebox/value";
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
import { Skeleton } from "@web/components/ui/skeleton";
import { useConfig, useSaveConfig } from "@web/hooks/config-hook";
import { useUiStore } from "@web/store/ui-store";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { GlobalSection } from "./global-section";
import { ProvidersSection } from "./providers-section";
import { TargetSection } from "./target-section";

export function ConfigEditor() {
  const intl = useIntl();
  const selectedName = useUiStore((s) => s.selectedConfigName);
  const config = useConfig(selectedName);
  const save = useSaveConfig(selectedName);
  const [draft, setDraft] = useState<ConfigSchemaType | null>(null);
  const [lastServerError, setLastServerError] = useState<string | null>(null);

  // Hydrate draft once the server value lands (or after a successful save).
  useEffect(() => {
    if (config.data) {
      setDraft(structuredClone(config.data.config));
      setLastServerError(null);
    }
  }, [config.data]);

  const server = config.data?.config;
  const dirty =
    draft !== null && server !== undefined
      ? JSON.stringify(draft) !== JSON.stringify(server)
      : false;

  const handleSave = () => {
    if (!draft) return;
    // Client-side validation first so the user gets the actual path that failed.
    if (!Value.Check(ConfigSchema, draft)) {
      const first = [...Value.Errors(ConfigSchema, draft)][0];
      const message = first
        ? `${first.path || "root"}: ${first.message}`
        : intl.formatMessage({ id: "CONFIG.VALIDATION.FAILED" });
      toast.error(message);
      setLastServerError(message);
      return;
    }
    const customErrors = customValidateConfig(draft);
    if (customErrors.length > 0) {
      const message = customErrors[0]!;
      toast.error(message);
      setLastServerError(message);
      return;
    }
    setLastServerError(null);
    save.mutate(draft, {
      onError: (error) =>
        setLastServerError(
          error instanceof Error ? error.message : String(error),
        ),
    });
  };

  const handleRevert = () => {
    if (server) setDraft(structuredClone(server));
    setLastServerError(null);
  };

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

  if (!draft || !config.data) return null;

  return (
    <div className="space-y-4">
      <Card size="sm">
        <CardContent className="flex items-center justify-between gap-2 py-3">
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
            <Button
              variant="outline"
              onClick={handleRevert}
              disabled={!dirty || save.isPending}
            >
              <FormattedMessage id="CONFIG.REVERT" />
            </Button>
            <Button onClick={handleSave} disabled={!dirty || save.isPending}>
              <FormattedMessage
                id={save.isPending ? "CONFIG.SAVING" : "CONFIG.SAVE"}
              />
            </Button>
          </div>
        </CardContent>
      </Card>

      <TargetSection
        value={draft.target}
        onChange={(target) => setDraft({ ...draft, target })}
      />

      <GlobalSection value={draft} onChange={setDraft} />

      <ProvidersSection
        value={draft.providers}
        onChange={(providers) => setDraft({ ...draft, providers })}
      />
    </div>
  );
}
