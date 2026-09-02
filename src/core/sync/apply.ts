import type {
  ApplyError,
  ApplyReport,
  DiffOperation,
  EntityChangeSet,
  SyncDiff,
} from "@core/types";
import type { NewApiClient } from "@core/vendors/newapi/client";
import { peekUpstreamError } from "@core/vendors/newapi/resources";
import { t } from "@server/i18n";
import { consola } from "consola";

function applyErrorWithUpstream(
  phase: ApplyError["phase"],
  key: string,
  fallback: string,
): ApplyError {
  const upstream = peekUpstreamError(key);
  return upstream
    ? { phase, key, message: `${fallback}: ${upstream.message}` }
    : { phase, key, message: fallback };
}

async function applyEntityOps<T extends { id?: number }>(
  ops: DiffOperation<T>[],
  handlers: {
    create: (value: T) => Promise<boolean>;
    update: (value: T) => Promise<boolean>;
    delete: (id: number) => Promise<boolean>;
  },
  phase: ApplyError["phase"],
  changes: EntityChangeSet,
  errors: ApplyError[],
): Promise<void> {
  const entity = phase.slice(0, -1);
  const failWith = (
    op: DiffOperation<T>,
    key: "CREATE" | "UPDATE" | "DELETE",
  ) =>
    errors.push(
      applyErrorWithUpstream(
        phase,
        op.key,
        t(`CORE.APPLY.FAIL_${key}`, { entity }),
      ),
    );
  for (const op of ops) {
    if (op.type === "create") {
      if (await handlers.create(op.value)) changes.created.push(op.key);
      else failWith(op, "CREATE");
      continue;
    }
    if (op.type === "update") {
      if (await handlers.update(op.value)) changes.updated.push(op.key);
      else failWith(op, "UPDATE");
      continue;
    }
    if (!op.existing.id) {
      errors.push({
        phase,
        key: op.key,
        message: t("CORE.APPLY.FAIL_MISSING_ID", { entity }),
      });
      continue;
    }
    if (await handlers.delete(op.existing.id)) changes.deleted.push(op.key);
    else failWith(op, "DELETE");
  }
}

export async function applySyncDiff(
  target: NewApiClient,
  diff: SyncDiff,
): Promise<ApplyReport> {
  const report: ApplyReport = {
    channels: {
      created: [],
      updated: [],
      deleted: [],
      orphanAbilitiesDeleted: 0,
    },
    models: { created: [], updated: [], deleted: [], orphansDeleted: 0 },
    options: { updated: [] },
    errors: [],
  };

  for (const op of diff.options) {
    if (op.type === "delete") continue;
    if (await target.updateOption(op.key, op.value)) {
      report.options.updated.push(op.key);
    } else {
      report.errors.push({
        phase: "options",
        key: op.key,
        message: t("CORE.APPLY.FAIL_OPTION_UPDATE"),
      });
    }
  }

  await applyEntityOps(
    diff.channels,
    {
      create: async (ch) => {
        const { id, ...payload } = ch;
        return (await target.createChannel(payload)) !== null;
      },
      update: (ch) => target.updateChannel(ch),
      delete: (id) => target.deleteChannel(id),
    },
    "channels",
    report.channels,
    report.errors,
  );

  await applyEntityOps(
    diff.models,
    {
      create: (model) => target.createModel(model),
      update: (model) => target.updateModel(model),
      delete: (id) => target.deleteModel(id),
    },
    "models",
    report.models,
    report.errors,
  );

  // Always-on janitor: FixAbility rebuilds the abilities table from channels
  // (heals enabled-drift zombies and orphaned abilities from out-of-band
  // edits). Orphaned-model cleanup (rows with no ability at all; disabled
  // abilities count as bound) runs ONLY after a fully-clean rebuild: a partial
  // rebuild leaves failed channels ability-less and the cleanup then eats their
  // models as "unbound" (happened live: 208 models soft-deleted, hand-restored).
  let abilitiesClean = false;
  try {
    abilitiesClean = (await target.fixAbilities()).clean;
  } catch (error) {
    report.errors.push({
      phase: "cleanup",
      key: "fix-abilities",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (abilitiesClean) {
    try {
      report.models.orphansDeleted = await target.cleanupOrphanedModels();
    } catch (error) {
      report.errors.push({
        phase: "cleanup",
        key: "orphaned-models",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    // Groups the sync just wrote this run are guaranteed-live even if the admin
    // channel list (in-memory cache) has not caught up yet - protect them from the
    // prune so a freshly-created group is never pruned back out on the same run
    // (the "new channel needs two syncs to become visible" regression).
    const desiredGroups = new Set<string>();
    for (const op of diff.channels) {
      if (op.type === "delete") continue;
      for (const g of (op.value.group ?? "").split(","))
        if (g.trim()) desiredGroups.add(g.trim());
    }
    // The prune reads the maps back from whichever gateway pod answers, and pods
    // reload options from the DB only every SYNC_FREQUENCY seconds, so seconds
    // after this run's own PUT a pod can still serve the pre-run map. Protecting
    // names cannot restore entries that read never had; seed it with what this
    // run wrote (live incident: five fresh fable-5.1 lanes priced but invisible).
    const own: OwnGroupMaps = { usable: {}, auto: [] };
    for (const op of diff.options) {
      if (op.type === "delete") continue;
      if (op.key === "UserUsableGroups") own.usable = parseJson(op.value, {});
      if (op.key === "AutoGroups") own.auto = parseJson(op.value, []);
    }
    await pruneDeadOptionGroups(target, desiredGroups, own);
  } catch (error) {
    report.errors.push({
      phase: "cleanup",
      key: "dead-groups",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return report;
}

// Exclusive channel-groups linger in UserUsableGroups/AutoGroups after their
// channel churns (partial syncs preserve out-of-scope entries), and the token
// group picker then offers unroutable pins (live incident: a token pinned to a
// dead kimi group 503'd every request while its usage stayed invisible).
// GroupRatio is deliberately NOT pruned: subscription tiers bill through it
// without owning any channel.
const BASE_GROUPS = new Set(["default", "auto", "vip", "svip"]);

interface OwnGroupMaps {
  usable: Record<string, string>;
  auto: string[];
}

function parseJson<T>(raw: string | undefined, fallback: T): T {
  try {
    return JSON.parse(raw ?? "") as T;
  } catch {
    return fallback;
  }
}

async function pruneDeadOptionGroups(
  target: NewApiClient,
  protectedGroups: Set<string> = new Set(),
  own: OwnGroupMaps = { usable: {}, auto: [] },
): Promise<void> {
  const channels = await target.listChannels();
  const live = new Set<string>(protectedGroups);
  for (const ch of channels)
    for (const g of (ch.group ?? "").split(","))
      if (g.trim()) live.add(g.trim());
  if (live.size === 0) return;

  const opts = await target.getOptions(["UserUsableGroups", "AutoGroups"]);
  let pruned = 0;
  // Named, not just counted: a transient upstream blip (an OpenRouter host dipping
  // under MIN_HOST_UPTIME_PCT for one run) silently cost the cheapest glm-5.2 lane
  // its visibility for two days, and a bare count left nothing to diagnose from.
  const prunedNames = new Set<string>();

  const readUsable = parseJson<Record<string, string>>(
    opts["UserUsableGroups"],
    {},
  );
  const usable: Record<string, string> = { ...readUsable, ...own.usable };
  const keptUsable: Record<string, string> = {};
  for (const [g, label] of Object.entries(usable)) {
    if (BASE_GROUPS.has(g) || live.has(g)) keptUsable[g] = label;
    else {
      pruned++;
      prunedNames.add(g);
    }
  }
  const usableChanged =
    Object.keys(keptUsable).length !== Object.keys(readUsable).length ||
    Object.keys(keptUsable).some((g) => !(g in readUsable));
  if (usableChanged)
    await target.updateOption("UserUsableGroups", JSON.stringify(keptUsable));

  const readAuto = parseJson<string[]>(opts["AutoGroups"], []);
  const auto = [...new Set([...readAuto, ...own.auto])];
  const keptAuto = auto.filter((g) => BASE_GROUPS.has(g) || live.has(g));
  const readAutoSet = new Set(readAuto);
  const autoChanged =
    keptAuto.length !== readAuto.length ||
    keptAuto.some((g) => !readAutoSet.has(g));
  if (autoChanged) {
    pruned += auto.length - keptAuto.length;
    for (const g of auto)
      if (!BASE_GROUPS.has(g) && !live.has(g)) prunedNames.add(g);
    await target.updateOption("AutoGroups", JSON.stringify(keptAuto));
  }

  if (pruned > 0)
    consola.info(
      t("CORE.SYNC.DEAD_GROUPS_PRUNED", {
        count: pruned,
        names: [...prunedNames].sort().join(", "),
      }),
    );
}
