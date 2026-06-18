// Metadata-only re-seed: patch model metadata (release date, params, context,
// description from the pricing sources, primarily OpenRouter) onto already-synced
// models WITHOUT any probing/testing, pricing, or channel changes.
//
// Two reasons this exists as a first-class command:
//  1. The first sync after `reset` writes empty metadata (the snapshot is empty,
//     so diff.ts can't detect metadata support). This re-seeds without a full run.
//  2. Metadata sources update independently of pricing/availability; refreshing
//     them shouldn't require re-probing every model (slow + costs upstream calls).

import { toBareName } from "@core/catalog/bare-name";
import {
  buildReverseMapping,
  matchesAnyPattern,
} from "@core/catalog/constants/patterns";
import { fetchBasellmEntries } from "@core/catalog/metadata";
import type { RuntimeConfig } from "@core/config";
import {
  buildModelMetadata,
  fetchAllPricingSources,
} from "@core/pricing/resolver";
import { NewApiClient } from "@core/vendors/newapi/client";
import { t } from "@server/i18n";
import { consola } from "consola";

export interface MetadataSyncResult {
  total: number;
  patched: number;
  skipped: number;
  failed: number;
  failedModels: string[];
}

export async function runMetadataSync(
  config: RuntimeConfig,
): Promise<MetadataSyncResult> {
  const target = new NewApiClient(config.target, "target");
  const health = await target.healthCheck();
  if (!health.ok)
    throw new Error(
      t("ERROR.TARGET_HEALTH_CHECK_FAILED", {
        detail: health.error ?? "unknown",
      }),
    );

  const filter = config.modelFilter ?? [];
  const inScope = (name: string) =>
    filter.length === 0 || matchesAnyPattern(name, filter);

  const [basellmEntries, allModels] = await Promise.all([
    fetchBasellmEntries(),
    target.listModels(),
  ]);
  const sources = await fetchAllPricingSources(basellmEntries);
  const reverseMapping = buildReverseMapping(config.modelMapping);

  const models = allModels.filter(
    (m) => m.model_name && inScope(m.model_name),
  );
  consola.info(t("CORE.METADATA.RESEED_START", { count: models.length }));

  const result: MetadataSyncResult = {
    total: models.length,
    patched: 0,
    skipped: 0,
    failed: 0,
    failedModels: [],
  };

  for (const model of models) {
    const name = model.model_name!;
    // `{model}:free` published names have no `:free` key in the pricing sources;
    // fall back to the bare base so the alias inherits the real metadata.
    const merged =
      buildModelMetadata({ modelName: name, sources, reverseMapping }) ??
      buildModelMetadata({
        modelName: toBareName(name),
        sources,
        reverseMapping,
      });
    if (!merged) {
      result.skipped++;
      continue;
    }
    const json = JSON.stringify(merged);
    if ((model.metadata ?? "") === json) {
      result.skipped++;
      continue;
    }
    if (await target.updateModel({ ...model, metadata: json })) {
      result.patched++;
    } else {
      result.failed++;
      result.failedModels.push(name);
    }
  }

  return result;
}

export function printMetadataSummary(result: MetadataSyncResult): void {
  consola.success(
    t("CORE.METADATA.RESEED_DONE", {
      patched: result.patched,
      skipped: result.skipped,
      failed: result.failed,
    }),
  );
  if (result.failedModels.length > 0)
    consola.warn(
      t("CORE.METADATA.RESEED_FAILED_LIST", {
        items: result.failedModels.join(", "),
      }),
    );
}
