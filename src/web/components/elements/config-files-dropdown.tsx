import { useIntl } from "@web/components/provider/intl-provider";
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
import { Label } from "@web/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@web/components/ui/select";
import {
  useConfigFiles,
  useCreateConfigFile,
  useDeleteConfigFile,
} from "@web/hooks/config-hook";
import { useUiStore } from "@web/store/ui-store";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";

// Select uses "" internally for "no value selected"; base-ui complains when
// you use the empty string as an item value, so main maps to this sentinel.
const MAIN_VALUE = "__main__";

export function ConfigFilesDropdown() {
  const { t } = useIntl();
  const selectedName = useUiStore((s) => s.selectedConfigName);
  const setSelectedName = useUiStore((s) => s.setSelectedConfigName);
  const files = useConfigFiles();
  const createMutation = useCreateConfigFile();
  const deleteMutation = useDeleteConfigFile();

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const selectValue = selectedName === "" ? MAIN_VALUE : selectedName;

  useEffect(() => {
    const names = (files.data ?? []).map((f) => f.name);
    if (selectedName !== "" && !names.includes(selectedName)) {
      setSelectedName("");
    }
  }, [files.data, selectedName, setSelectedName]);

  const handleCreate = () => {
    const trimmed = createName.trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
      setCreateError(t("CONFIG.FILES.INVALID_NAME"));
      return;
    }
    if (files.data?.some((f) => f.name === trimmed)) {
      setCreateError(t("CONFIG.FILES.ALREADY_EXISTS", { name: trimmed }));
      return;
    }
    createMutation.mutate(
      { name: trimmed, fromName: selectedName },
      {
        onSuccess: () => {
          setSelectedName(trimmed);
          setCreateName("");
          setCreateError(null);
          setCreateOpen(false);
        },
        onError: (error) => {
          setCreateError(
            error instanceof Error ? error.message : String(error),
          );
        },
      },
    );
  };

  const handleDelete = () => {
    if (!selectedName) return;
    const name = selectedName;
    deleteMutation.mutate(name, {
      onSuccess: () => {
        setSelectedName("");
        setDeleteOpen(false);
      },
    });
  };

  return (
    <div className="flex items-center gap-2">
      <Select
        value={selectValue}
        onValueChange={(value) => {
          if (value === null) return;
          setSelectedName(value === MAIN_VALUE ? "" : value);
        }}
      >
        <SelectTrigger className="w-44">
          <SelectValue>
            {selectedName === ""
              ? t("CONFIG.FILES.MAIN")
              : selectedName}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {(files.data ?? []).map((file) => (
            <SelectItem
              key={file.name || MAIN_VALUE}
              value={file.name || MAIN_VALUE}
            >
              {file.name || t("CONFIG.FILES.MAIN")}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        variant="outline"
        size="icon-sm"
        onClick={() => {
          setCreateName("");
          setCreateError(null);
          setCreateOpen(true);
        }}
        title={t("CONFIG.FILES.CREATE")}
      >
        <PlusIcon />
      </Button>
      <Button
        variant="outline"
        size="icon-sm"
        onClick={() => setDeleteOpen(true)}
        disabled={selectedName === ""}
        title={t("CONFIG.FILES.DELETE")}
      >
        <Trash2Icon />
      </Button>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("CONFIG.FILES.CREATE_TITLE")}
            </DialogTitle>
            <DialogDescription>
              {t("CONFIG.FILES.CREATE_DESC")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label>
              {t("CONFIG.FILES.NAME")}
            </Label>
            <Input
              value={createName}
              onChange={(event) => {
                setCreateName(event.target.value);
                setCreateError(null);
              }}
              placeholder={t("CONFIG.FILES.NAME_PLACEHOLDER")}
              autoFocus
              onKeyDown={(event) => {
                if (event.key === "Enter") handleCreate();
              }}
            />
            {createError ? (
              <p className="text-destructive text-xs">{createError}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t("CONFIG.FILES.CANCEL")}
            </Button>
            <Button
              onClick={handleCreate}
              disabled={createMutation.isPending || createName.trim() === ""}
            >
              {t("CONFIG.FILES.CREATE")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("CONFIG.FILES.DELETE_TITLE", { name: selectedName })}
            </DialogTitle>
            <DialogDescription>
              {t("CONFIG.FILES.DELETE_DESC")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              {t("CONFIG.FILES.CANCEL")}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
            >
              {t("CONFIG.FILES.DELETE")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
