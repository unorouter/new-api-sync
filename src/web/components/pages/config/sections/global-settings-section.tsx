import type { GlobalConfigType } from "@core/validations/config";
import { useIntl } from "@web/components/provider/intl-provider";
import { Button } from "@web/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@web/components/ui/card";
import { Input } from "@web/components/ui/input";
import { Label } from "@web/components/ui/label";
import { Skeleton } from "@web/components/ui/skeleton";
import {
  useGlobalConfig,
  useSaveGlobalConfig,
} from "@web/hooks/global-config-hook";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

/**
 * Editor for `config.global.yml` — the cross-config file whose `blacklist`
 * and `modelMapping` merge into every per-config at sync time. Locale and
 * theme are edited via their toggles in the header, so they're not shown
 * here.
 *
 * The section keeps its own local state (not wired into the per-config RHF
 * form), because saves write to a different file and shouldn't share the
 * dirty/submit bar.
 */
export function GlobalSettingsSection() {
  const { t } = useIntl();
  const query = useGlobalConfig();
  const save = useSaveGlobalConfig();

  const [blacklist, setBlacklist] = useState<string[]>([]);
  const [mapping, setMapping] = useState<[string, string][]>([]);

  // Sync local state from the server whenever the query resolves or
  // successfully saves.
  useEffect(() => {
    if (!query.data) return;
    setBlacklist(query.data.blacklist ?? []);
    setMapping(Object.entries(query.data.modelMapping ?? {}));
  }, [query.data]);

  const handleSave = () => {
    const filteredBlacklist = blacklist.map((s) => s.trim()).filter(Boolean);
    const mappingObject: Record<string, string> = {};
    for (const [key, value] of mapping) {
      const k = key.trim();
      if (!k || k in mappingObject) continue;
      mappingObject[k] = value;
    }
    const next: GlobalConfigType = {
      ...query.data,
      blacklist: filteredBlacklist.length > 0 ? filteredBlacklist : undefined,
      modelMapping:
        Object.keys(mappingObject).length > 0 ? mappingObject : undefined,
    };
    save.mutate(next, {
      onSuccess: () => toast.success(t("CONFIG.GLOBAL_SETTINGS.SAVED")),
    });
  };

  if (query.isPending) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("CONFIG.GLOBAL_SETTINGS.TITLE")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("CONFIG.GLOBAL_SETTINGS.TITLE")}</CardTitle>
        <CardDescription>
          {t("CONFIG.GLOBAL_SETTINGS.DESCRIPTION")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-2">
          <Label>{t("CONFIG.GLOBAL.BLACKLIST")}</Label>
          <p className="text-muted-foreground text-xs">
            {t("CONFIG.GLOBAL_SETTINGS.BLACKLIST_HELP")}
          </p>
          {blacklist.map((value, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                value={value}
                onChange={(event) => {
                  const next = [...blacklist];
                  next[index] = event.target.value;
                  setBlacklist(next);
                }}
                placeholder="model name or glob"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() =>
                  setBlacklist(blacklist.filter((_, i) => i !== index))
                }
                aria-label={t("CONFIG.FIELD.REMOVE")}
              >
                <Trash2Icon />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setBlacklist([...blacklist, ""])}
            className="self-start"
          >
            <PlusIcon />
            {t("CONFIG.FIELD.ADD")}
          </Button>
        </div>

        <div className="grid gap-2">
          <Label>{t("CONFIG.GLOBAL.MODEL_MAPPING")}</Label>
          <p className="text-muted-foreground text-xs">
            {t("CONFIG.GLOBAL_SETTINGS.MODEL_MAPPING_HELP")}
          </p>
          {mapping.map(([key, value], index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                value={key}
                onChange={(event) => {
                  const next: [string, string][] = [...mapping];
                  next[index] = [event.target.value, value];
                  setMapping(next);
                }}
                placeholder="upstream model"
                className="flex-1"
              />
              <Input
                value={value}
                onChange={(event) => {
                  const next: [string, string][] = [...mapping];
                  next[index] = [key, event.target.value];
                  setMapping(next);
                }}
                placeholder="target model"
                className="flex-1"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() =>
                  setMapping(mapping.filter((_, i) => i !== index))
                }
                aria-label={t("CONFIG.FIELD.REMOVE")}
              >
                <Trash2Icon />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setMapping([...mapping, ["", ""]])}
            className="self-start"
          >
            <PlusIcon />
            {t("CONFIG.FIELD.ADD")}
          </Button>
        </div>

        <div className="flex justify-end">
          <Button
            type="button"
            onClick={handleSave}
            disabled={save.isPending}
          >
            {t(
              save.isPending
                ? "CONFIG.GLOBAL_SETTINGS.SAVING"
                : "CONFIG.GLOBAL_SETTINGS.SAVE",
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
