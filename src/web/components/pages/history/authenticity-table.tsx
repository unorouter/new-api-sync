import { useTranslations } from "use-intl";
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
  useAuthenticityBlacklist,
  useDeleteAuthenticityEntry,
} from "@web/hooks/history-hook";
import { useUiStore } from "@web/store/ui-store";
import { Trash2Icon } from "lucide-react";
import { useState } from "react";

/** Eden decodes ISO date strings to Date on the client; render just YYYY-MM-DD. */
function formatSince(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value;
}

export function AuthenticityTable() {
  const t = useTranslations();
  const authenticity = useAuthenticityBlacklist();
  const deleteEntry = useDeleteAuthenticityEntry();
  const query = useUiStore((s) => s.authenticityQuery);
  const setQuery = useUiStore((s) => s.setAuthenticityQuery);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);

  if (authenticity.isPending) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  if (authenticity.error) {
    return (
      <p className="text-destructive text-sm">
        {t("HISTORY.AUTHENTICITY.LOAD_ERROR", {
          error: String(authenticity.error),
        })}
      </p>
    );
  }

  if (!authenticity.data || authenticity.data.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("HISTORY.AUTHENTICITY.EMPTY")}
      </p>
    );
  }

  const q = query.trim().toLowerCase();
  const filtered = authenticity.data.filter((entry) => {
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
        placeholder={t("HISTORY.AUTHENTICITY.FILTER")}
        className="max-w-md"
      />
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
              <th>{t("HISTORY.AUTHENTICITY.COL_VERDICT")}</th>
              <th>{t("HISTORY.AUTHENTICITY.COL_PROVIDER")}</th>
              <th>{t("HISTORY.AUTHENTICITY.COL_GROUP")}</th>
              <th>{t("HISTORY.AUTHENTICITY.COL_MODEL")}</th>
              <th>{t("HISTORY.AUTHENTICITY.COL_SINCE")}</th>
              <th>{t("HISTORY.AUTHENTICITY.COL_REASON")}</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((entry) => (
              <tr key={entry.key} className="border-t [&>td]:px-3 [&>td]:py-2">
                <td>
                  <span
                    className={
                      entry.verdict === "pass"
                        ? "rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400"
                        : "bg-destructive/15 text-destructive rounded px-1.5 py-0.5 text-xs font-medium"
                    }
                  >
                    {entry.verdict === "pass"
                      ? t("HISTORY.AUTHENTICITY.VERDICT_PASS")
                      : t("HISTORY.AUTHENTICITY.VERDICT_FAIL")}
                  </span>
                </td>
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
                    aria-label={t("CONFIG.FIELD.REMOVE")}
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
              {t("HISTORY.AUTHENTICITY.REMOVE_CONFIRM")}
            </DialogTitle>
            <DialogDescription>
              {t("HISTORY.AUTHENTICITY.REMOVE_CONFIRM_DESC")}
            </DialogDescription>
          </DialogHeader>
          {confirmKey !== null ? (
            <p className="bg-muted rounded-md px-3 py-2 font-mono text-xs">
              {confirmKey}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmKey(null)}>
              {t("HISTORY.AUTHENTICITY.CANCEL")}
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
              {t("HISTORY.AUTHENTICITY.REMOVE")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
