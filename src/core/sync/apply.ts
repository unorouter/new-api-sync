import type {
  ApplyError,
  ApplyReport,
  DiffOperation,
  EntityChangeSet,
  SyncDiff,
} from "@core/types";
import type { NewApiClient } from "@core/vendors/newapi/client";
import { t } from "@server/i18n";

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
  for (const op of ops) {
    if (op.type === "create") {
      if (await handlers.create(op.value)) {
        changes.created.push(op.key);
      } else {
        errors.push({
          phase,
          key: op.key,
          message: t("CORE.APPLY.FAIL_CREATE", { entity }),
        });
      }
      continue;
    }

    if (op.type === "update") {
      if (await handlers.update(op.value)) {
        changes.updated.push(op.key);
      } else {
        errors.push({
          phase,
          key: op.key,
          message: t("CORE.APPLY.FAIL_UPDATE", { entity }),
        });
      }
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

    if (await handlers.delete(op.existing.id)) {
      changes.deleted.push(op.key);
    } else {
      errors.push({
        phase,
        key: op.key,
        message: t("CORE.APPLY.FAIL_DELETE", { entity }),
      });
    }
  }
}

export async function applySyncDiff(
  target: NewApiClient,
  diff: SyncDiff,
): Promise<ApplyReport> {
  const report: ApplyReport = {
    channels: { created: [], updated: [], deleted: [] },
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

  if (diff.cleanupOrphans) {
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

  return report;
}
