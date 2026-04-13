import { useIntl } from "@web/components/provider/intl-provider";
import { Button } from "@web/components/ui/button";
import { Input } from "@web/components/ui/input";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useRef } from "react";

interface Group {
  key: string;
  platform: string;
  name?: string;
}

interface Props {
  groups: Group[] | undefined;
  onChange: (groups: Group[] | undefined) => void;
}

/** Repeater over sub2api { key, platform, name? } rows. */
export function Sub2ApiGroupsEditor(props: Props) {
  const { t } = useIntl();
  const groups = props.groups ?? [];
  const keyCounter = useRef(0);
  const keysRef = useRef<number[]>([]);

  while (keysRef.current.length < groups.length) {
    keysRef.current.push(keyCounter.current++);
  }
  if (keysRef.current.length > groups.length) {
    keysRef.current.length = groups.length;
  }

  const commit = (next: Group[]) => {
    props.onChange(next.length === 0 ? undefined : next);
  };

  const update = (index: number, patch: Partial<Group>) => {
    const next = [...groups];
    const existing = next[index];
    if (!existing) return;
    const merged: Group = { ...existing, ...patch };
    if (merged.name === "") delete merged.name;
    next[index] = merged;
    commit(next);
  };

  const remove = (index: number) => {
    keysRef.current.splice(index, 1);
    commit(groups.filter((_, i) => i !== index));
  };

  const add = () => {
    keysRef.current.push(keyCounter.current++);
    commit([...groups, { key: "", platform: "" }]);
  };

  return (
    <div className="space-y-2">
      {groups.map((group, i) => (
        <div key={keysRef.current[i]} className="flex items-center gap-2">
          <Input
            value={group.key}
            onChange={(event) => update(i, { key: event.target.value })}
            placeholder={t("CONFIG.SUB2API.KEY_PLACEHOLDER")}
            className="flex-1"
          />
          <Input
            value={group.platform}
            onChange={(event) => update(i, { platform: event.target.value })}
            placeholder={t("CONFIG.SUB2API.PLATFORM_PLACEHOLDER")}
            className="flex-1"
          />
          <Input
            value={group.name ?? ""}
            onChange={(event) => update(i, { name: event.target.value })}
            placeholder={t("CONFIG.SUB2API.NAME_PLACEHOLDER")}
            className="flex-1"
          />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => remove(i)}
            type="button"
            aria-label={t("CONFIG.FIELD.REMOVE")}
          >
            <Trash2Icon />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={add} type="button">
        <PlusIcon />
        {t("CONFIG.FIELD.ADD")}
      </Button>
    </div>
  );
}
