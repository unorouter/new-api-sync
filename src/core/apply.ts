import type { ApplyReport, SyncDiff } from "@/lib/types";
import type { NewApiClient } from "@/providers/newapi/client";

export async function applySyncDiff(
  target: NewApiClient,
  diff: SyncDiff,
): Promise<ApplyReport> {
  const report: ApplyReport = {
    channels: { created: 0, updated: 0, deleted: 0 },
    models: { created: 0, updated: 0, deleted: 0, orphansDeleted: 0 },
    options: { updated: [] },
    errors: [],
  };

  for (const op of diff.options) {
    if (op.type === "delete") continue;
    const success = await target.updateOption(op.key, op.value);
    if (success) {
      report.options.updated.push(op.key);
      continue;
    }
    report.errors.push({
      phase: "options",
      key: op.key,
      message: "failed to update option",
    });
  }

  for (const op of diff.channels) {
    if (op.type === "create") {
      const { id, ...channelPayload } = op.value;
      const createdId = await target.createChannel(channelPayload);
      if (createdId !== null) {
        report.channels.created++;
      } else {
        report.errors.push({
          phase: "channels",
          key: op.key,
          message: "failed to create channel",
        });
      }
      continue;
    }

    if (op.type === "update") {
      const success = await target.updateChannel(op.value);
      if (success) {
        report.channels.updated++;
      } else {
        report.errors.push({
          phase: "channels",
          key: op.key,
          message: "failed to update channel",
        });
      }
      continue;
    }

    if (!op.existing.id) {
      report.errors.push({
        phase: "channels",
        key: op.key,
        message: "missing channel id for delete",
      });
      continue;
    }

    const success = await target.deleteChannel(op.existing.id);
    if (success) {
      report.channels.deleted++;
    } else {
      report.errors.push({
        phase: "channels",
        key: op.key,
        message: "failed to delete channel",
      });
    }
  }

  for (const op of diff.models) {
    if (op.type === "create") {
      const success = await target.createModel(op.value);
      if (success) {
        report.models.created++;
      } else {
        report.errors.push({
          phase: "models",
          key: op.key,
          message: "failed to create model",
        });
      }
      continue;
    }

    if (op.type === "update") {
      const success = await target.updateModel(op.value);
      if (success) {
        report.models.updated++;
      } else {
        report.errors.push({
          phase: "models",
          key: op.key,
          message: "failed to update model",
        });
      }
      continue;
    }

    if (!op.existing.id) {
      report.errors.push({
        phase: "models",
        key: op.key,
        message: "missing model id for delete",
      });
      continue;
    }

    const success = await target.deleteModel(op.existing.id);
    if (success) {
      report.models.deleted++;
    } else {
      report.errors.push({
        phase: "models",
        key: op.key,
        message: "failed to delete model",
      });
    }
  }

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
