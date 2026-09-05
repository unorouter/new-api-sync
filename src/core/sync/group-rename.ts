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
import type { OptionStore } from "@core/sync/option-store";
import type { Channel } from "@core/types";
import type { NewApiClient } from "@core/vendors/newapi/client";
import { t } from "@server/i18n";
import { consola } from "consola";

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

/** Mutates the plan's channel objects to their post-rename names (dry-run preview, or after a real rename). */
export function applyGroupRenamesToChannels(renames: GroupRename[]): void {
  for (const r of renames) {
    r.channel.name = r.to;
    r.channel.group = r.to;
  }
}

export async function applyGroupRenames(
  target: NewApiClient,
  plan: GroupRenamePlan,
  store: OptionStore,
  channels: Channel[],
): Promise<number> {
  printGroupRenamePlan(plan);
  if (plan.renames.length === 0) return 0;
  store.renameGroups(plan.renames, "add");
  await store.flush(target, channels);

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
  store.renameGroups(done, "remove");
  await store.flush(target, channels);
  return done.length;
}
