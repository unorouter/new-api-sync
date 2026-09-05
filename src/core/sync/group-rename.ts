// In-place rename of sync-built channels whose upstream group label a
// groupMapping rule now splices. The channel remark is the raw
// `${group.name}-${provider}`, so the pre-rule name is recoverable from the live
// row alone: no probing, no create+delete, channel ids and stats preserved.
// Option keys move with the group in two phases (add new, rename, drop old) so
// a token pinned to both names never points at a group the gateway lacks.

import type { RuntimeConfig } from "@core/config";
import {
  sanitizeGroupName,
  spliceGroupLabel,
} from "@core/catalog/constants/patterns";
import type { Channel } from "@core/types";
import type { NewApiClient } from "@core/vendors/newapi/client";
import { t } from "@server/i18n";
import { consola } from "consola";

const GROUP_OPTION_KEYS = ["GroupRatio", "UserUsableGroups", "AutoGroups"];

export interface GroupRename {
  channel: Channel;
  from: string;
  to: string;
}

export interface GroupRenamePlan {
  renames: GroupRename[];
  collisions: GroupRename[];
}

export function planGroupRenames(
  channels: Channel[],
  config: RuntimeConfig,
): GroupRenamePlan {
  const plan: GroupRenamePlan = { renames: [], collisions: [] };
  if (Object.keys(config.groupMapping).length === 0) return plan;
  const providers = new Set(
    config.providers.filter((p) => p.type === "newapi").map((p) => p.name),
  );
  const taken = new Set(channels.map((ch) => ch.name));
  for (const ch of channels) {
    if (!ch.tag || !ch.remark || !providers.has(ch.tag)) continue;
    // Only the one-channel-per-group shape the emitter builds (group == name).
    if (ch.group !== ch.name) continue;
    const suffix = `-${ch.tag}`;
    if (!ch.remark.endsWith(suffix)) continue;
    const groupName = ch.remark.slice(0, -suffix.length);
    const oldBase = sanitizeGroupName(ch.remark);
    if (!ch.name.startsWith(`${oldBase}-`)) continue;
    const label = spliceGroupLabel(groupName, ch.tag, config.groupMapping);
    if (label === groupName) continue;
    const newBase = sanitizeGroupName(`${label}${suffix}`);
    if (newBase === oldBase) continue;
    const to = newBase + ch.name.slice(oldBase.length);
    const rename: GroupRename = { channel: ch, from: ch.name, to };
    if (taken.has(to)) {
      plan.collisions.push(rename);
      continue;
    }
    taken.add(to);
    plan.renames.push(rename);
  }
  return plan;
}

export function printGroupRenamePlan(plan: GroupRenamePlan): void {
  for (const r of plan.renames)
    consola.info(
      t("CORE.METADATA.GROUP_RENAME_PLANNED", {
        id: r.channel.id ?? 0,
        from: r.from,
        to: r.to,
      }),
    );
  for (const r of plan.collisions)
    consola.warn(
      t("CORE.METADATA.GROUP_RENAME_COLLISION", { from: r.from, to: r.to }),
    );
  if (plan.renames.length > 0 || plan.collisions.length > 0)
    consola.info(
      t("CORE.METADATA.GROUP_RENAME_SUMMARY", {
        count: plan.renames.length,
        collisions: plan.collisions.length,
      }),
    );
}

function parseObject(json: string | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return { ...parsed };
  } catch {
    // fall through: an unparseable live map is treated as empty
  }
  return {};
}

function parseStringArray(json: string | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(json || "[]");
    if (Array.isArray(parsed))
      return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    // fall through
  }
  return [];
}

/**
 * The option values after moving group keys for `renames`. Phase "add" copies
 * every old key to the new name; phase "remove" drops the old keys. Returns only
 * the keys whose serialized value changed.
 */
export function moveGroupOptionKeys(
  live: Record<string, string>,
  renames: ReadonlyArray<{ from: string; to: string }>,
  phase: "add" | "remove",
): Record<string, string> {
  const ratio = parseObject(live["GroupRatio"]);
  const usable = parseObject(live["UserUsableGroups"]);
  let auto = parseStringArray(live["AutoGroups"]);
  for (const { from, to } of renames) {
    if (phase === "add") {
      if (from in ratio && !(to in ratio)) ratio[to] = ratio[from];
      if (from in usable && !(to in usable)) usable[to] = usable[from];
      if (auto.includes(from) && !auto.includes(to)) auto.push(to);
    } else {
      delete ratio[from];
      delete usable[from];
      auto = auto.filter((g) => g !== from);
    }
  }
  const ratioOf = (g: string) => {
    const r = ratio[g];
    return typeof r === "number" ? r : 1;
  };
  auto.sort((a, b) => ratioOf(a) - ratioOf(b));
  const next: Record<string, string> = {
    GroupRatio: JSON.stringify(ratio),
    UserUsableGroups: JSON.stringify(usable),
    AutoGroups: JSON.stringify(auto),
  };
  const changed: Record<string, string> = {};
  for (const key of GROUP_OPTION_KEYS)
    if (next[key] !== (live[key] ?? "")) changed[key] = next[key]!;
  return changed;
}

/** Mutates the plan's channel objects to their post-rename names (dry-run preview, or after a real rename). */
export function applyGroupRenamesToChannels(renames: GroupRename[]): void {
  for (const r of renames) {
    r.channel.name = r.to;
    r.channel.group = r.to;
  }
}

async function writeOptions(
  target: NewApiClient,
  changed: Record<string, string>,
): Promise<void> {
  // GroupRatio first: the gateway treats a group as selectable only once it
  // has a ratio, so the new name must be priced before it is usable or auto.
  for (const key of GROUP_OPTION_KEYS)
    if (key in changed) await target.updateOption(key, changed[key]!);
}

export async function applyGroupRenames(
  target: NewApiClient,
  plan: GroupRenamePlan,
): Promise<number> {
  printGroupRenamePlan(plan);
  if (plan.renames.length === 0) return 0;
  const live = await target.getOptions(GROUP_OPTION_KEYS);
  const added = moveGroupOptionKeys(live, plan.renames, "add");
  await writeOptions(target, added);
  Object.assign(live, added);

  const done: GroupRename[] = [];
  for (const r of plan.renames) {
    const ok = await target.updateChannel({
      ...r.channel,
      name: r.to,
      group: r.to,
    });
    if (!ok) {
      consola.warn(
        t("CORE.METADATA.GROUP_RENAME_FAILED", {
          id: r.channel.id ?? 0,
          from: r.from,
          to: r.to,
        }),
      );
      continue;
    }
    done.push(r);
    consola.info(
      t("CORE.METADATA.GROUP_RENAMED", {
        id: r.channel.id ?? 0,
        from: r.from,
        to: r.to,
      }),
    );
  }
  applyGroupRenamesToChannels(done);
  // Old keys go only for groups whose channel really moved; a failed rename
  // keeps its old key so the still-old channel stays routable.
  await writeOptions(target, moveGroupOptionKeys(live, done, "remove"));
  return done.length;
}
