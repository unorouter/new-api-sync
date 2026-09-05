import {
  findVendorByAlias,
  forEachVendor,
  VENDOR_MATCHERS,
} from "@core/catalog/constants/vendor-matchers";
import type { RuntimeConfig } from "@core/config";
import { throwIfRunAborted } from "@core/infra/abort";
import { writeJsonAtomic } from "@core/infra/fs";
import { logsDir } from "@core/infra/paths";
import { applySyncDiff, projectChannels } from "@core/sync/apply";
import { buildSyncDiff } from "@core/sync/diff";
import {
  applyGroupRenames,
  applyGroupRenamesToChannels,
  planGroupRenames,
  printGroupRenamePlan,
} from "@core/sync/group-rename";
import { updateGuestTokenIfConfigured } from "@core/sync/guest-token";
import { reconcileSystemPrompt } from "@core/sync/metadata";
import {
  OptionStore,
  parseJsonObject,
  printPricingAudit,
} from "@core/sync/option-store";
import { runProviderPipeline } from "@core/sync/pipeline";
import type { ResetResult } from "@core/sync/reset";
import { loadVerdictCache } from "@core/testing/verdict-cache";
import {
  recordRunSummary,
  resetTestState,
  writeTestReport,
} from "@core/testing/runner";
import type {
  DesiredState,
  DiffOperation,
  SyncRunResult,
  TargetSnapshot,
} from "@core/types";
import { NewApiClient } from "@core/vendors/newapi/client";
import { NEW_API_UNPRICED_RATIO } from "@core/vendors/newapi/pricing";
import { drainUpstreamErrors } from "@core/vendors/newapi/resources";
import { t } from "@server/i18n";
import { consola } from "consola";
import { acquireSyncLock, releaseSyncLock } from "@core/infra/lock";
import { timingMark, timingReport, timingReset } from "@core/infra/timing";
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

async function snapshot(
  client: NewApiClient,
): Promise<{ snap: TargetSnapshot; store: OptionStore }> {
  const [channels, models, vendors, store] = await Promise.all([
    client.listChannels(),
    client.listModels(),
    client.listVendors(),
    OptionStore.load(client),
  ]);
  return { snap: { channels, models, vendors, options: store.raw() }, store };
}

export async function runSync(
  config: RuntimeConfig,
  opts?: { dryRun?: boolean },
): Promise<SyncRunResult> {
  const start = Date.now();
  acquireSyncLock();
  timingReset();
  const dryRun = opts?.dryRun ?? false;
  const target = new NewApiClient(config.target, "target");
  resetTestState();
  loadVerdictCache();

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
    const { snap, store } = await snapshot(target);
    // Splice-rule renames happen in place BEFORE the diff, or the name-keyed
    // diff would turn each one into a create + delete. Dry-run applies the
    // plan to the in-memory snapshot so the preview shows the same diff.
    const groupPlan = planGroupRenames(snap.channels, config);
    if (dryRun) {
      printGroupRenamePlan(groupPlan);
      store.renameGroups(groupPlan.renames, "add");
      store.renameGroups(groupPlan.renames, "remove");
      applyGroupRenamesToChannels(groupPlan.renames);
    } else if (groupPlan.renames.length > 0) {
      await applyGroupRenames(target, groupPlan, store, snap.channels);
    }
    snap.options = store.raw();
    timingMark("snapshot");
    throwIfRunAborted();
    const { desired, providerReports } = await runProviderPipeline(
      config,
      snap,
      {
        dryRun,
      },
    );
    timingMark("discover+price");

    throwIfRunAborted();
    // Dry-run: no vendor/channel/model/option writes, no guest-token update.
    // Still diff against the live snapshot so the preview shows real changes,
    // and the finally block still writes the test report + pricing-gate logs.
    if (dryRun) {
      const diff = buildSyncDiff(config, desired, snap);
      printDryRunPricing(desired, snap, config);
      const preview = OptionStore.fromRaw(snap.options);
      for (const op of diff.options)
        if (op.type !== "delete") preview.replace(op.key, op.value);
      const after = projectChannels(snap.channels, diff);
      printPricingAudit(
        preview.settle(after),
        preview.unpricedLiveModels(after),
      );
      // Project the computed diff into the summary changeset so the dry-run
      // prints what WOULD be created/updated/deleted (no writes happen).
      const byType = <T>(
        ops: DiffOperation<T>[],
        t: DiffOperation<T>["type"],
      ) => ops.filter((o) => o.type === t).map((o) => o.key);
      const apply: SyncRunResult["apply"] = {
        channels: {
          created: byType(diff.channels, "create"),
          updated: byType(diff.channels, "update"),
          deleted: byType(diff.channels, "delete"),
          orphanAbilitiesDeleted: 0,
        },
        models: {
          created: byType(diff.models, "create"),
          updated: byType(diff.models, "update"),
          deleted: byType(diff.models, "delete"),
          orphansDeleted: 0,
        },
        options: { updated: byType(diff.options, "update") },
        pricing: { dropped: [], healed: [] },
        errors: [],
      };
      const successfulProviders = providerReports.filter(
        (p) => p.success,
      ).length;
      const hasProviderSuccess =
        successfulProviders > 0 || config.providers.length === 0;
      const elapsedMs = Date.now() - start;
      recordRunSummary({
        providerReports,
        apply,
        diff,
        elapsedMs,
        success: hasProviderSuccess,
      });
      return {
        success: hasProviderSuccess,
        providerReports,
        desired,
        diff,
        apply,
        elapsedMs,
      };
    }

    let liveSnap = snap;
    const vendorsCreated = await ensureVendors(target, desired, liveSnap);
    if (vendorsCreated > 0)
      liveSnap = { ...liveSnap, vendors: await target.listVendors() };

    throwIfRunAborted();
    const diff = buildSyncDiff(config, desired, liveSnap);
    timingMark("diff");
    const apply = await applySyncDiff(target, diff, store, liveSnap.channels);
    timingMark("apply");
    applyErrors = apply.errors;

    // systemPrompt injection is written on channel CREATE via the diff, but an
    // existing channel whose model wasn't re-tiered this run keeps a stale/absent
    // prompt. Reconcile it onto ALL current channels so a prompt/scope edit
    // propagates without recreating them (mirrors the metadata-sync reconcile).
    const liveChannels = await target.listChannels();
    await reconcileSystemPrompt(target, liveChannels, config);
    throwIfRunAborted();
    await updateGuestTokenIfConfigured(target, liveChannels);
    timingMark("reconcile+token");
    const unpriced = store.unpricedLiveModels(liveChannels);
    printPricingAudit(apply.pricing, unpriced);
    if (unpriced.length > 0)
      apply.errors.push({
        phase: "cleanup",
        key: "unpriced-models",
        message: `${unpriced.length} model(s) on enabled channels carry no price: ${unpriced.join(", ")}`,
      });

    const successfulProviders = providerReports.filter((p) => p.success).length;
    const hasProviderSuccess =
      successfulProviders > 0 || config.providers.length === 0;
    const elapsedMs = Date.now() - start;
    const success = hasProviderSuccess && apply.errors.length === 0;

    recordRunSummary({ providerReports, apply, diff, elapsedMs, success });
    return { success, providerReports, desired, diff, apply, elapsedMs };
  } finally {
    releaseSyncLock();
    timingReport();
    writeTestReport();
    writeApplyErrorsLog(applyErrors);
  }
}

// Dry-run pricing preview: for every in-scope model, show the computed
// model_ratio/completion (what WOULD be written) vs what new-api currently
// stores, and the channels that would serve it. Surfaces ratio discrepancies
// (e.g. a model falling back to new-api's unpriced default because no tier
// survived the cap) without any upstream cost or write.
function printDryRunPricing(
  desired: DesiredState,
  snapshot: TargetSnapshot,
  config: RuntimeConfig,
): void {
  const opts = desired.options;
  const currentRatio = parseJsonObject(snapshot.options.ModelRatio);

  const channelsByModel = new Map<string, { name: string; ratio: number }[]>();
  for (const ch of desired.channels)
    for (const m of ch.models.split(",").map((s) => s.trim()))
      if (m) {
        let arr = channelsByModel.get(m);
        if (!arr) channelsByModel.set(m, (arr = []));
        arr.push({ name: ch.name, ratio: opts.groupRatio[ch.group] ?? 1 });
      }

  const names0 = [
    ...Object.keys(opts.modelRatio),
    ...Object.keys(opts.modelPrice),
    ...channelsByModel.keys(),
  ];
  const names = [
    ...new Set([...names0, ...Object.keys(opts.billingExpr)]),
  ].sort();

  consola.info(t("CLI.DRY.HEADER", { count: names.length }));
  for (const name of names) {
    const ratio = opts.modelRatio[name];
    const comp = opts.completionRatio[name];
    const price = opts.modelPrice[name];
    const expr = opts.billingExpr[name];
    const chans = channelsByModel.get(name) ?? [];
    const hasComputed =
      ratio !== undefined || price !== undefined || expr !== undefined;
    const stored = currentRatio[name];
    // Channels exist but no computed ratio/price/expr => new-api keeps its
    // stored value, or the unpriced default. That is the discrepancy.
    const flag =
      !hasComputed && chans.length > 0
        ? ` <= NO COMPUTED RATIO; new-api keeps stored=${stored ?? `default(${NEW_API_UNPRICED_RATIO})`}`
        : "";
    const priced =
      expr !== undefined
        ? `TIERED ${expr}`
        : price !== undefined
          ? `price=$${price}`
          : ratio !== undefined
            ? `in=$${(ratio * 2).toFixed(2)}/M out=$${(ratio * 2 * (comp ?? 0)).toFixed(2)}/M (ratio=${ratio}, comp=${comp})`
            : "(none)";
    const cheapest =
      chans.length > 0
        ? Math.min(...chans.map((c) => c.ratio)).toFixed(4)
        : "-";
    consola.info(
      `  ${name}: ${priced} | channels=${chans.length} cheapestGroupRatio=${cheapest}${flag}`,
    );
  }
  void config;
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
