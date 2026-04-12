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

export function ConfigEditor() {
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
          Configuration
          {config.data ? (
            <span className="text-muted-foreground text-xs font-normal font-mono">
              {config.data.path}
            </span>
          ) : null}
        </CardTitle>
        <CardDescription>
          Edit providers, pricing, and global settings. Saving re-validates the
          YAML; an invalid document is rolled back automatically.
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
            Failed to load: {String(config.error)}
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
                {save.isPending ? "Saving..." : "Save"}
              </Button>
              <Button
                variant="outline"
                onClick={() => config.data && setDraft(config.data.yaml)}
                disabled={!dirty || save.isPending}
              >
                Revert
              </Button>
              {dirty ? (
                <span className="text-muted-foreground text-xs">
                  unsaved changes
                </span>
              ) : null}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
