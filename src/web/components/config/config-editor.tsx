import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@web/components/ui/card";
import { Button } from "@web/components/ui/button";
import { Textarea } from "@web/components/ui/textarea";
import { Skeleton } from "@web/components/ui/skeleton";
import { useConfig, useSaveConfig } from "@web/hooks/config-hook";
import { useEffect, useState } from "react";
import { FormattedMessage, useIntl } from "@web/components/provider/intl-provider";

export function ConfigEditor() {
  const intl = useIntl();
  const config = useConfig();
  const save = useSaveConfig();
  const [draft, setDraft] = useState("");

  // Sync server value into the textarea when it first loads (or after save).
  useEffect(() => {
    if (config.data?.yaml !== undefined) {
      setDraft(config.data.yaml);
    }
  }, [config.data?.yaml]);

  const dirty = config.data ? draft !== config.data.yaml : false;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FormattedMessage id="CONFIG.TITLE" />
          {config.data ? (
            <span className="text-muted-foreground text-xs font-normal font-mono">
              {config.data.path}
            </span>
          ) : null}
        </CardTitle>
        <CardDescription>
          <FormattedMessage id="CONFIG.DESCRIPTION" />
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {config.isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : config.error ? (
          <p className="text-destructive text-sm">
            {intl.formatMessage(
              { id: "CONFIG.LOAD_ERROR" },
              { error: String(config.error) },
            )}
          </p>
        ) : (
          <>
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              spellCheck={false}
              className="h-128 font-mono text-xs"
            />
            <div className="flex items-center gap-2">
              <Button
                onClick={() => save.mutate(draft)}
                disabled={!dirty || save.isPending}
              >
                <FormattedMessage
                  id={save.isPending ? "CONFIG.SAVING" : "CONFIG.SAVE"}
                />
              </Button>
              <Button
                variant="outline"
                onClick={() => config.data && setDraft(config.data.yaml)}
                disabled={!dirty || save.isPending}
              >
                <FormattedMessage id="CONFIG.REVERT" />
              </Button>
              {dirty ? (
                <span className="text-muted-foreground text-xs">
                  <FormattedMessage id="CONFIG.UNSAVED" />
                </span>
              ) : null}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
