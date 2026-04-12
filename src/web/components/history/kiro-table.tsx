import {
  FormattedMessage,
  useIntl,
} from "@web/components/provider/intl-provider";
import { Button } from "@web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@web/components/ui/dialog";
import { Input } from "@web/components/ui/input";
import { Skeleton } from "@web/components/ui/skeleton";
import {
  useDeleteKiroEntry,
  useKiroBlacklist,
} from "@web/hooks/history-hook";
import { Trash2Icon } from "lucide-react";
import { useState } from "react";

/** Eden decodes ISO date strings to Date on the client; render just YYYY-MM-DD. */
function formatSince(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value;
}

export function KiroTable() {
  const intl = useIntl();
  const kiro = useKiroBlacklist();
  const deleteEntry = useDeleteKiroEntry();
  const [query, setQuery] = useState("");
  const [confirmKey, setConfirmKey] = useState<string | null>(null);

  if (kiro.isPending) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  if (kiro.error) {
    return (
      <p className="text-destructive text-sm">
        {intl.formatMessage(
          { id: "HISTORY.KIRO.LOAD_ERROR" },
          { error: String(kiro.error) },
        )}
      </p>
    );
  }

  if (!kiro.data || kiro.data.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        <FormattedMessage id="HISTORY.KIRO.EMPTY" />
      </p>
    );
  }

  const q = query.trim().toLowerCase();
  const filtered = kiro.data.filter((entry) => {
    if (!q) return true;
    return `${entry.provider} ${entry.group} ${entry.model} ${entry.reason}`
      .toLowerCase()
      .includes(q);
  });

  return (
    <div className="space-y-3">
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={intl.formatMessage({ id: "HISTORY.KIRO.FILTER" })}
        className="max-w-md"
      />
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
              <th>
                <FormattedMessage id="HISTORY.KIRO.COL_PROVIDER" />
              </th>
              <th>
                <FormattedMessage id="HISTORY.KIRO.COL_GROUP" />
              </th>
              <th>
                <FormattedMessage id="HISTORY.KIRO.COL_MODEL" />
              </th>
              <th>
                <FormattedMessage id="HISTORY.KIRO.COL_SINCE" />
              </th>
              <th>
                <FormattedMessage id="HISTORY.KIRO.COL_REASON" />
              </th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((entry) => (
              <tr
                key={entry.key}
                className="border-t [&>td]:px-3 [&>td]:py-2"
              >
                <td className="font-mono text-xs">{entry.provider}</td>
                <td className="font-mono text-xs">{entry.group}</td>
                <td className="font-mono text-xs">{entry.model}</td>
                <td className="text-muted-foreground text-xs">
                  {formatSince(entry.since)}
                </td>
                <td className="text-xs">{entry.reason}</td>
                <td>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setConfirmKey(entry.key)}
                    aria-label="Remove"
                  >
                    <Trash2Icon />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog
        open={confirmKey !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmKey(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <FormattedMessage id="HISTORY.KIRO.REMOVE_CONFIRM" />
            </DialogTitle>
            <DialogDescription>
              <FormattedMessage id="HISTORY.KIRO.REMOVE_CONFIRM_DESC" />
            </DialogDescription>
          </DialogHeader>
          {confirmKey !== null ? (
            <p className="bg-muted rounded-md px-3 py-2 font-mono text-xs">
              {confirmKey}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmKey(null)}>
              <FormattedMessage id="HISTORY.KIRO.CANCEL" />
            </Button>
            <Button
              variant="destructive"
              disabled={deleteEntry.isPending}
              onClick={() => {
                if (!confirmKey) return;
                const key = confirmKey;
                setConfirmKey(null);
                deleteEntry.mutate(key);
              }}
            >
              <FormattedMessage id="HISTORY.KIRO.REMOVE" />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
