import {
  findVendorByAlias,
  forEachVendor,
  VENDOR_MATCHERS,
} from "@core/catalog/constants/vendor-matchers";
import type { RuntimeConfig } from "@core/config";
import { throwIfRunAborted } from "@core/infra/abort";
import { writeJsonAtomic } from "@core/infra/fs";
import { logsDir } from "@core/infra/paths";
import { applySyncDiff } from "@core/sync/apply";
import { buildSyncDiff } from "@core/sync/diff";
import { updateGuestTokenIfConfigured } from "@core/sync/guest-token";
import { runProviderPipeline } from "@core/sync/pipeline";
import type { ResetResult } from "@core/sync/reset";
import { loadAuthenticityBlacklist } from "@core/testing/authenticity";
import {
  recordRunSummary,
  resetTestState,
  writeTestReport,
} from "@core/testing/runner";
import type { DesiredState, SyncRunResult, TargetSnapshot } from "@core/types";
import { MANAGED_OPTION_KEYS } from "@core/types";
import { NewApiClient } from "@core/vendors/newapi/client";
import { drainUpstreamErrors } from "@core/vendors/newapi/resources";
import { t } from "@server/i18n";
import { consola } from "consola";
import { join } from "path";

async function ensureVendors(
  client: NewApiClient,
  desired: DesiredState,
  snap: TargetSnapshot,
): Promise<number> {
  const neededVendors = new Set<string>();
  for (const model of desired.models.values())
    if (model.vendor) neededVendors.add(model.vendor.toLowerCase());
  const existingByCanonical = new Map<string, (typeof snap.vendors)[0]>();
  forEachVendor((canonical) => {
    const found = findVendorByAlias(snap.vendors, canonical);
    if (found) existingByCanonical.set(canonical, found);
  });
  let changed = 0;
  for (const vendor of neededVendors) {
    const matcher = VENDOR_MATCHERS[vendor];
    const displayName =
      matcher?.displayName ?? vendor.charAt(0).toUpperCase() + vendor.slice(1);
    const icon = matcher?.icon;
    const iconLabel = icon ?? t("CORE.SYNC.ICON_NONE");
    const existing = existingByCanonical.get(vendor);
    if (existing) {
      if (existing.icon !== icon || existing.name !== displayName) {
        if (
          await client.updateVendor({
            id: existing.id,
            name: displayName,
            icon,
          })
        ) {
          consola.info(
            t("CORE.SYNC.VENDOR_UPDATED", {
              name: displayName,
              id: existing.id,
              icon: iconLabel,
            }),
          );
          changed++;
        }
      }
      continue;
    }
    const result = await client.createVendor({ name: displayName, icon });
    if (result) {
      consola.info(
        t("CORE.SYNC.VENDOR_CREATED", {
          name: displayName,
          id: result.id,
          icon: iconLabel,
        }),
      );
      changed++;
    } else
      consola.warn(t("CORE.SYNC.VENDOR_CREATE_FAILED", { name: displayName }));
  }
  return changed;
}

async function snapshot(client: NewApiClient): Promise<TargetSnapshot> {
  const [channels, models, vendors, options] = await Promise.all([
    client.listChannels(),
    client.listModels(),
    client.listVendors(),
    client.getOptions([...MANAGED_OPTION_KEYS]),
  ]);
  return { channels, models, vendors, options };
}

export async function runSync(config: RuntimeConfig): Promise<SyncRunResult> {
  const start = Date.now();
  const target = new NewApiClient(config.target, "target");
  resetTestState();
  loadAuthenticityBlacklist();

  // Logs written in finally so a crash/abort still flushes buffered errors.
  let applyErrors: SyncRunResult["apply"]["errors"] = [];
  try {
    const health = await target.healthCheck();
    if (!health.ok)
      throw new Error(
        t("ERROR.TARGET_HEALTH_CHECK_FAILED", {
          detail: health.error ?? "unknown",
        }),
      );

    throwIfRunAborted();
    let snap = await snapshot(target);
    throwIfRunAborted();
    const { desired, providerReports } = await runProviderPipeline(
      config,
      snap,
    );

    throwIfRunAborted();
    const vendorsCreated = await ensureVendors(target, desired, snap);
    if (vendorsCreated > 0)
      snap = { ...snap, vendors: await target.listVendors() };

    throwIfRunAborted();
    const diff = buildSyncDiff(config, desired, snap);
    const apply = await applySyncDiff(target, diff);
    applyErrors = apply.errors;
    if (apply.options.updated.length > 0) await target.updateCache();

    throwIfRunAborted();
    const postApplyPricing = await target.fetchPricing();
    await updateGuestTokenIfConfigured(target, postApplyPricing);

    const successfulProviders = providerReports.filter((p) => p.success).length;
    const hasProviderSuccess =
      successfulProviders > 0 || config.providers.length === 0;
    const elapsedMs = Date.now() - start;
    const success = hasProviderSuccess && apply.errors.length === 0;

    recordRunSummary({ providerReports, apply, diff, elapsedMs, success });
    return { success, providerReports, desired, diff, apply, elapsedMs };
  } finally {
    writeTestReport();
    writeApplyErrorsLog(applyErrors);
  }
}

function writeApplyErrorsLog(
  applyErrors: SyncRunResult["apply"]["errors"],
): void {
  const upstream = drainUpstreamErrors();
  if (applyErrors.length === 0 && upstream.length === 0) return;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(logsDir(), `${ts}-apply-errors.json`);
  writeJsonAtomic(path, {
    version: 1,
    generatedAt: new Date().toISOString(),
    applyErrors,
    upstream,
  });
  consola.info(`Apply errors written to ${path}`);
}

function buildChannelProviderMap(result: SyncRunResult): Map<string, string> {
  const map = new Map<string, string>();
  for (const op of result.diff.channels) {
    const channel = op.type === "delete" ? op.existing : op.value;
    if (channel.tag) map.set(channel.name, channel.tag);
  }
  return map;
}

function buildModelProviderMap(result: SyncRunResult): Map<string, string[]> {
  const map = new Map<string, Set<string>>();
  for (const channel of result.desired.channels) {
    if (!channel.tag || !channel.models) continue;
    for (const raw of channel.models.split(",")) {
      const name = raw.trim();
      if (!name) continue;
      let bucket = map.get(name);
      if (!bucket) {
        bucket = new Set<string>();
        map.set(name, bucket);
      }
      bucket.add(channel.tag);
    }
  }
  for (const op of result.diff.models) {
    if (op.type !== "delete") continue;
    if (!map.has(op.key)) map.set(op.key, new Set<string>());
  }
  return new Map(
    Array.from(map.entries()).map(([k, v]) => [k, Array.from(v).sort()]),
  );
}

export function printRunSummary(result: SyncRunResult): void {
  const elapsed = (result.elapsedMs / 1000).toFixed(2);
  const ch = result.apply.channels;
  const md = result.apply.models;
  consola.info(
    t("CLI.SUMMARY.PROVIDERS", {
      passed: result.providerReports.filter((p) => p.success).length,
      total: result.providerReports.length,
    }),
  );
  const channelProviders = buildChannelProviderMap(result);
  const modelProviders = buildModelProviderMap(result);
  const annotate = (items: string[], lookup: (k: string) => string) =>
    items
      .map((k) => {
        const tag = lookup(k);
        return tag ? `${k} [${tag}]` : k;
      })
      .join(", ");
  const chLookup = (n: string) => channelProviders.get(n) ?? "";
  const mdLookup = (n: string) => modelProviders.get(n)?.join(", ") ?? "";
  const emit = (items: string[], msg: string) => {
    if (items.length > 0) consola.info(msg);
  };
  consola.info(
    t("CLI.SUMMARY.CHANNELS", {
      created: ch.created.length,
      updated: ch.updated.length,
      deleted: ch.deleted.length,
    }),
  );
  emit(
    ch.created,
    t("CLI.SUMMARY.CHANNELS_ADDED", { items: annotate(ch.created, chLookup) }),
  );
  emit(
    ch.updated,
    t("CLI.SUMMARY.CHANNELS_UPDATED", {
      items: annotate(ch.updated, chLookup),
    }),
  );
  emit(
    ch.deleted,
    t("CLI.SUMMARY.CHANNELS_DELETED", {
      items: annotate(ch.deleted, chLookup),
    }),
  );
  consola.info(
    t("CLI.SUMMARY.MODELS", {
      created: md.created.length,
      updated: md.updated.length,
      deleted: md.deleted.length,
      orphans: md.orphansDeleted,
    }),
  );
  emit(
    md.created,
    t("CLI.SUMMARY.MODELS_ADDED", { items: annotate(md.created, mdLookup) }),
  );
  emit(
    md.updated,
    t("CLI.SUMMARY.MODELS_UPDATED", { items: annotate(md.updated, mdLookup) }),
  );
  emit(
    md.deleted,
    t("CLI.SUMMARY.MODELS_DELETED", { items: annotate(md.deleted, mdLookup) }),
  );
  consola.info(
    t("CLI.SUMMARY.OPTIONS_UPDATED", {
      count: result.apply.options.updated.length,
    }),
  );
  if (result.apply.options.updated.length > 0)
    consola.info(
      t("CLI.SUMMARY.OPTIONS_UPDATED_LIST", {
        items: result.apply.options.updated.join(", "),
      }),
    );

  for (const provider of result.providerReports) {
    if (provider.success) continue;
    consola.warn(
      t("CLI.SUMMARY.PROVIDER_ERROR", {
        name: provider.name,
        error: provider.error ?? t("CLI.ERROR.UNKNOWN_SHORT"),
      }),
    );
  }
  for (const error of result.apply.errors)
    consola.error(
      t("CLI.SUMMARY.APPLY_ERROR", {
        phase: error.phase,
        key: error.key,
        message: error.message,
      }),
    );
  if (result.success) consola.success(t("CLI.SUMMARY.COMPLETED", { elapsed }));
  else consola.error(t("CLI.SUMMARY.COMPLETED_WITH_ERRORS", { elapsed }));
}

export function printResetSummary(result: ResetResult): void {
  consola.info(
    t("CLI.SUMMARY.RESET_COMPLETE", {
      channels: result.channelsDeleted,
      channelsUpdated: result.channelsUpdated,
      models: result.modelsDeleted,
      orphans: result.orphanModelsDeleted,
      tokens: result.tokensDeleted,
      options: result.optionsUpdated.length,
    }),
  );
}
