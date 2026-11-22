import { resolveBareNames, toBareName } from "@core/catalog/bare-name";
import { inferModelType } from "@core/catalog/constants/inference";
import {
  dedupBase,
  findBlacklistMatch,
  matchesAnyPattern,
  sanitizeGroupName,
  spliceGroupLabel,
} from "@core/catalog/constants/patterns";
import { configStateOf, type ConfigState } from "@core/catalog/filter";
import { getEnabledModelGlobs, type RuntimeConfig } from "@core/config";
import { isFixed, laneModelName } from "@core/pricing/compute";
import type { ModelType } from "@core/types";
import type {
  A7ProviderConfig,
  AnyProviderConfig,
  IhProviderConfig,
  NvidiaProviderConfig,
  OpenAICompatibleProviderConfig,
  OpenRouterProviderConfig,
  ProviderConfig,
  SiProviderConfig,
} from "@core/validations/config";
import {
  fetchListingsByModel,
  fetchMarketplaceModelNames,
  selectMerchants,
  supplierSlug,
  usdPerMillion,
} from "@core/vendors/a7/marketplace";
import { fetchPoolCatalog } from "@core/vendors/ih/catalog";
import { NewApiClient } from "@core/vendors/newapi/client";
import {
  collapseEffortVariants,
  type EffortFamily,
} from "@core/vendors/newapi/effort-variants";
import {
  newApiExposedNamer,
  newApiGroupState,
  newApiPriceKeyOf,
  newApiUpstreamRatios,
} from "@core/vendors/newapi/provider";
import { listNvidiaModels } from "@core/vendors/nvidia/provider";
import { discoverOpenRouterFreeModels } from "@core/vendors/openrouter/discovery";
import {
  openRouterPaidSet,
  openRouterRequestedPaidIds,
} from "@core/vendors/openrouter/provider";
import {
  DEFAULT_BID_QUANTILE,
  DEFAULT_MIN_SELLERS,
  ladderQuantile,
  resolvePools,
} from "@core/vendors/shared/fallback-lanes";
import { discoverOpenAICompatibleModels } from "@core/vendors/shared/openai-free-provider";
import { resolvePerModel } from "@core/pricing";
import {
  fetchMarketModels,
  fetchOrderBook,
  fetchSellerProviders,
} from "@core/vendors/si/market";
import { sellerPin } from "@core/vendors/si/provider";

const USD_PER_M_PER_RATIO = 2;
const BOOK_CONCURRENCY = 4;

export interface UpstreamPrice {
  inPerM?: number;
  outPerM?: number;
  perCall?: number;
}

export interface CatalogRow {
  provider: string;
  upstreamGroup: string;
  upstreamModel: string;
  publishedName: string;
  aliases: string[];
  price: UpstreamPrice;
  state: string;
  /** Exact channel name a run would emit; unset where the tag and model identify the lane. */
  channelName?: string;
}

export interface ProviderCatalog {
  provider: string;
  type: string;
  rows: CatalogRow[];
  error?: string;
  note?: string;
}

const DECLARATIVE_TYPES: ReadonlySet<string> = new Set([
  "comfyui",
  "aihorde",
  "runware",
  "typesafe",
]);

function stateLabel(state: ConfigState): string {
  return state.kind === "blacklisted"
    ? `blacklisted:${state.rule}`
    : state.kind;
}

/** --models scopes rows like `sync run` does: on the upstream id, its bare form or the published name. */
function inModelScope(config: RuntimeConfig, ...names: string[]): boolean {
  if (!config.modelFilter?.length) return true;
  const filter = config.modelFilter;
  return names.some(
    (n) =>
      matchesAnyPattern(n, filter) || matchesAnyPattern(toBareName(n), filter),
  );
}

function aliasesOf(config: RuntimeConfig, published: string): string[] {
  return config.modelAlias?.[published] ?? [];
}

function publishAsFor(
  publishAs: Record<string, string> | undefined,
  exposed: string,
): string | undefined {
  return Object.entries(publishAs ?? {}).find(([glob]) =>
    matchesAnyPattern(exposed, [glob]),
  )?.[1];
}

async function newApiRows(
  pc: ProviderConfig,
  config: RuntimeConfig,
): Promise<CatalogRow[]> {
  const pricing = await new NewApiClient(pc, pc.name).fetchPricing();
  const pricingByName = new Map(pricing.models.map((m) => [m.name, m]));
  const exposedNameFor = newApiExposedNamer(
    pricing.models,
    config.modelMapping,
  );
  const { tieredByName, upstreamPricing } = newApiUpstreamRatios(
    pricing.models,
  );
  const priceKeyOf = newApiPriceKeyOf(pricingByName);
  const usedSanitizedNames = new Map<string, number>();
  const rows: CatalogRow[] = [];
  for (const group of pricing.groups) {
    const groupState = newApiGroupState(group, config, pc);
    let sanitizedName: string | undefined;
    if (groupState.kind === "enabled") {
      const label = spliceGroupLabel(group.name, pc.name, config.groupMapping);
      sanitizedName = dedupBase(
        sanitizeGroupName(`${label}-${pc.name}`),
        usedSanitizedNames,
      );
    }
    const collapsed = collapseEffortVariants(group.models, priceKeyOf);
    const baseOf = new Map<string, string>();
    for (const family of collapsed.families.values())
      for (const upstream of Object.values(family.variants))
        baseOf.set(upstream, family.base);
    for (const [standIn, family] of collapsed.families)
      baseOf.set(standIn, family.base);

    for (const upstream of group.models) {
      const base = baseOf.get(upstream) ?? upstream;
      const exposed = exposedNameFor(base);
      if (!inModelScope(config, upstream, exposed)) continue;
      const m = pricingByName.get(upstream);
      const tiered = tieredByName.get(upstream);
      const ratio = tiered?.modelRatio ?? m?.ratio;
      const completion = tiered?.completionRatio ?? m?.completionRatio;
      const free =
        group.ratio === 0 || (ratio === 0 && (m?.modelPrice ?? 0) === 0);
      const published = laneModelName(exposed, free);
      const price: UpstreamPrice = {};
      if (m && isFixed({ modelPrice: m.modelPrice, quotaType: m.quotaType }))
        price.perCall = (m.modelPrice ?? 0) * group.ratio;
      else if (ratio !== undefined) {
        price.inPerM = ratio * USD_PER_M_PER_RATIO * group.ratio;
        if (completion !== undefined) price.outPerM = price.inPerM * completion;
      }
      const modelState = configStateOf(base, config, pc);
      let state = stateLabel(
        modelState.kind === "enabled" ? groupState : modelState,
      );
      // Same cut as the pre-test gate: a paid group with no upstream ratio has nothing to price against.
      if (
        state === "enabled" &&
        config.skipUnprofitableText &&
        group.ratio > 0 &&
        !upstreamPricing.has(upstream)
      )
        state = "no_price";
      rows.push({
        provider: pc.name,
        upstreamGroup: group.name,
        upstreamModel: upstream,
        publishedName: published,
        aliases: aliasesOf(config, published),
        price,
        state,
        ...(sanitizedName
          ? {
              channelName: `${sanitizedName}-${sanitizeGroupName(published)}`,
            }
          : {}),
      });
    }
  }
  return rows;
}

// Mirrors the modalities processOpenAICompatibleFreeProvider emits; any other type is never published.
function servedModalities(pc: OpenAICompatibleProviderConfig): Set<ModelType> {
  const types = new Set<ModelType>(["text", "embedding"]);
  if (pc.imageChannelType !== undefined) types.add("image");
  if (pc.audioChannelType !== undefined) types.add("audio");
  if (pc.videoChannelType !== undefined) types.add("video");
  return types;
}

async function openAICompatibleRows(
  pc: OpenAICompatibleProviderConfig,
  config: RuntimeConfig,
): Promise<CatalogRow[]> {
  const discovered = await discoverOpenAICompatibleModels(pc, {
    listOnly: true,
  });
  const typeOf = (m: string): ModelType =>
    discovered.modelTypeHints?.get(m) ?? inferModelType(m);
  const modalities = servedModalities(pc);
  const stateById = new Map(
    discovered.models.map((id) => [id, configStateOf(id, config, pc)]),
  );
  let enabled = discovered.models.filter(
    (id) => stateById.get(id)?.kind === "enabled",
  );
  let families: Map<string, EffortFamily> | undefined;
  const folded = new Map<string, string>();
  if (pc.collapseEfforts) {
    const collapsed = collapseEffortVariants(enabled, () => "free");
    enabled = collapsed.models;
    families = collapsed.families;
    for (const [standIn, family] of collapsed.families)
      for (const upstream of Object.values(family.variants))
        if (upstream !== standIn) folded.set(upstream, standIn);
  }
  const exposedById = new Map<string, string>();
  for (const type of modalities)
    for (const r of resolveBareNames(
      enabled.filter((id) => typeOf(id) === type),
      config.modelMapping,
    ))
      exposedById.set(r.upstream, r.exposed);
  const paidModels = pc.paidModels ?? [];

  const rows: CatalogRow[] = [];
  for (const id of discovered.models) {
    const lane = folded.get(id) ?? id;
    const exposed =
      exposedById.get(lane) ??
      resolveBareNames([lane], config.modelMapping)[0]?.exposed ??
      lane.toLowerCase();
    if (!inModelScope(config, id, exposed)) continue;
    const paid =
      paidModels.length > 0 && matchesAnyPattern(exposed, paidModels);
    const family = families?.get(lane);
    const published = laneModelName(
      publishAsFor(pc.publishAs, exposed) ?? family?.base ?? exposed,
      !paid,
    );
    const price: UpstreamPrice = {};
    const ratio = discovered.ratioByModel?.get(id);
    if (!paid) {
      price.inPerM = 0;
      price.outPerM = 0;
    } else if (ratio !== undefined) {
      price.inPerM = ratio * USD_PER_M_PER_RATIO;
      const completion = discovered.completionRatioByModel?.get(id);
      if (completion !== undefined) price.outPerM = price.inPerM * completion;
    }
    const type = typeOf(id);
    let state = stateLabel(stateById.get(id) ?? { kind: "enabled" });
    if (state === "enabled" && !modalities.has(type))
      state = `unserved_type:${type}`;
    else if (state === "enabled" && paid && ratio === undefined)
      state = "no_price";
    rows.push({
      provider: pc.name,
      upstreamGroup: type,
      upstreamModel: id,
      publishedName: published,
      aliases: aliasesOf(config, published),
      price,
      state,
    });
  }
  return rows;
}

async function nvidiaRows(
  pc: NvidiaProviderConfig,
  config: RuntimeConfig,
): Promise<CatalogRow[]> {
  const models = await listNvidiaModels(pc);
  const enabled = models.filter(
    (id) => configStateOf(id, config, pc).kind === "enabled",
  );
  const exposedById = new Map<string, string>();
  for (const image of [false, true])
    for (const r of resolveBareNames(
      enabled.filter((id) => (inferModelType(id) === "image") === image),
      config.modelMapping,
    ))
      exposedById.set(r.upstream, r.exposed);
  const rows: CatalogRow[] = [];
  for (const id of models) {
    const exposed =
      exposedById.get(id) ??
      resolveBareNames([id], config.modelMapping)[0]?.exposed ??
      id.toLowerCase();
    if (!inModelScope(config, id, exposed)) continue;
    const image = inferModelType(id) === "image";
    const published = laneModelName(exposed, !image);
    rows.push({
      provider: pc.name,
      upstreamGroup: image ? "image" : "text",
      upstreamModel: id,
      publishedName: published,
      aliases: aliasesOf(config, published),
      price: image ? { perCall: 0 } : { inPerM: 0, outPerM: 0 },
      state: stateLabel(configStateOf(id, config, pc)),
    });
  }
  return rows;
}

async function openRouterRows(
  pc: OpenRouterProviderConfig,
  config: RuntimeConfig,
): Promise<CatalogRow[]> {
  const readKey = pc.managementKey ?? pc.apiKey ?? "";
  const requested = openRouterRequestedPaidIds(pc);
  const catalogue = await discoverOpenRouterFreeModels(
    pc.baseUrl,
    readKey,
    requested,
  );
  const freeSet = new Set(catalogue.freeIds);
  const paidSet = openRouterPaidSet(requested, catalogue);
  const ids = [...new Set([...freeSet, ...paidSet])];
  // OpenRouter fences on the bare name and the full id; enabledModels only names paid ids.
  const stateOf = (id: string): string => {
    const rule =
      findBlacklistMatch(toBareName(id), config.blacklist, pc.name) ??
      findBlacklistMatch(id, config.blacklist, pc.name);
    return rule !== undefined ? `blacklisted:${rule}` : "enabled";
  };
  const enabled = ids.filter((id) => stateOf(id) === "enabled");
  const exposedById = new Map(
    resolveBareNames(enabled, config.modelMapping).map(
      (r) => [r.upstream, r.exposed] as const,
    ),
  );
  const rows: CatalogRow[] = [];
  for (const id of ids) {
    const exposed =
      exposedById.get(id) ??
      resolveBareNames([id], config.modelMapping)[0]?.exposed ??
      id.toLowerCase();
    if (!inModelScope(config, id, exposed)) continue;
    const state = stateOf(id);
    if (freeSet.has(id)) {
      const published = laneModelName(exposed, true);
      rows.push({
        provider: pc.name,
        upstreamGroup: `free:${(catalogue.freeProviders.get(id) ?? []).join("+")}`,
        upstreamModel: id,
        publishedName: published,
        aliases: aliasesOf(config, published),
        price: { inPerM: 0, outPerM: 0 },
        state,
      });
    }
    if (!paidSet.has(id)) continue;
    const published = publishAsFor(pc.publishAs, exposed) ?? exposed;
    const hosts = catalogue.paidEndpoints.get(id) ?? [];
    if (hosts.length === 0)
      rows.push({
        provider: pc.name,
        upstreamGroup: "paid",
        upstreamModel: id,
        publishedName: published,
        aliases: aliasesOf(config, published),
        price: {},
        state: state === "enabled" ? "no_price" : state,
      });
    for (const host of hosts)
      rows.push({
        provider: pc.name,
        upstreamGroup: host.quantization
          ? `${host.tag}/${host.quantization}`
          : host.tag,
        upstreamModel: id,
        publishedName: published,
        aliases: aliasesOf(config, published),
        price: {
          inPerM: host.prompt * 1_000_000,
          outPerM: host.completion * 1_000_000,
        },
        state,
      });
  }
  return rows;
}

async function a7Rows(
  pc: A7ProviderConfig,
  config: RuntimeConfig,
): Promise<CatalogRow[]> {
  const names = await fetchMarketplaceModelNames(pc);
  if (names === null) throw new Error("a7 /api/pricing did not answer");
  const exposedOf = (m: string) =>
    (config.modelMapping?.[m] ?? m).toLowerCase();
  const scoped = names.filter((m) => inModelScope(config, m, exposedOf(m)));
  const { byModel, failed } = await fetchListingsByModel(pc, scoped);
  const globs = getEnabledModelGlobs(pc.enabledModels) ?? [];
  const rows: CatalogRow[] = [];
  for (const model of failed)
    rows.push({
      provider: pc.name,
      upstreamGroup: "",
      upstreamModel: model,
      publishedName: exposedOf(model),
      aliases: aliasesOf(config, exposedOf(model)),
      price: {},
      state: "listing_unreachable",
    });
  for (const [model, listings] of byModel) {
    const published = exposedOf(model);
    // resolveMarketplaceModels fences a7 model names with unscoped entries only.
    const rule = findBlacklistMatch(model, config.blacklist);
    const modelState =
      rule !== undefined
        ? `blacklisted:${rule}`
        : globs.length > 0 && !matchesAnyPattern(model, globs)
          ? "not_in_enabledModels"
          : "enabled";
    const viable = new Set(
      selectMerchants(model, listings, pc, undefined, config.blacklist).map(
        (l) => l.listing_id,
      ),
    );
    for (const listing of listings) {
      const slug = supplierSlug(listing.supplier_name);
      const laneId = slug
        ? `${slug}-${listing.channel_id}`
        : `${listing.channel_id}`;
      rows.push({
        provider: pc.name,
        upstreamGroup: laneId,
        upstreamModel: model,
        publishedName: published,
        aliases: aliasesOf(config, published),
        price: {
          inPerM: usdPerMillion(listing.input_price_micros),
          outPerM: usdPerMillion(listing.output_price_micros),
        },
        state:
          modelState === "enabled" && !viable.has(listing.listing_id)
            ? "merchant_filtered"
            : modelState,
        channelName: `${sanitizeGroupName(`${pc.name}-${laneId}`)}-${sanitizeGroupName(published)}`,
      });
    }
  }
  return rows;
}

async function ihRows(
  pc: IhProviderConfig,
  config: RuntimeConfig,
): Promise<CatalogRow[]> {
  const catalog = await fetchPoolCatalog(pc.catalogUrl, pc.apiKey);
  if (!catalog.ok) throw new Error(catalog.reason);
  const rows: CatalogRow[] = [];
  for (const up of catalog.upstreams) {
    const prefix = up.prefix.toLowerCase();
    const usable =
      up.enabled && !up.upstreamDisabled && up.status === "available";
    for (const m of up.models) {
      const bare = m.upstreamModelId.slice(
        m.upstreamModelId.lastIndexOf("/") + 1,
      );
      const exposed = (
        config.modelMapping?.[m.upstreamModelId] ??
        config.modelMapping?.[bare] ??
        bare
      ).toLowerCase();
      if (!inModelScope(config, m.upstreamModelId, exposed)) continue;
      const quantile = resolvePerModel(
        pc.bidQuantile,
        exposed,
        DEFAULT_BID_QUANTILE,
      );
      const minSellers = resolvePerModel(
        pc.minSellers,
        exposed,
        DEFAULT_MIN_SELLERS,
      );
      const inPerM = ladderQuantile(m.pricePointsIn, quantile, minSellers);
      const outPerM = ladderQuantile(m.pricePointsOut, quantile, minSellers);
      const configured = stateLabel(configStateOf(exposed, config, pc));
      const state =
        configured !== "enabled"
          ? configured
          : !resolvePools(pc.upstreams, exposed).includes(prefix)
            ? "pool_not_allowed"
            : !usable || !m.enabled || m.modelDisabled
              ? "pool_unavailable"
              : inPerM === undefined || outPerM === undefined
                ? "thin_pool"
                : "enabled";
      rows.push({
        provider: pc.name,
        upstreamGroup: prefix,
        upstreamModel: `${up.prefix}/${m.upstreamModelId}`,
        publishedName: exposed,
        aliases: aliasesOf(config, exposed),
        price: { inPerM, outPerM },
        state,
      });
    }
  }
  return rows;
}

async function siRows(
  pc: SiProviderConfig,
  config: RuntimeConfig,
): Promise<CatalogRow[]> {
  const baseUrl = pc.baseUrl.replace(/\/+$/, "");
  const [sellers, markets] = await Promise.all([
    fetchSellerProviders(baseUrl),
    fetchMarketModels(baseUrl),
  ]);
  if (!sellers.ok) throw new Error(sellers.reason);
  if (!markets.ok) throw new Error(markets.reason);
  const exposedOf = (id: string) =>
    (config.modelMapping?.[id] ?? id).toLowerCase();
  const models = markets.data.filter((id) =>
    inModelScope(config, id, exposedOf(id)),
  );
  const rows: CatalogRow[] = [];
  for (let i = 0; i < models.length; i += BOOK_CONCURRENCY) {
    const batch = models.slice(i, i + BOOK_CONCURRENCY);
    const books = await Promise.all(
      batch.map((id) => fetchOrderBook(baseUrl, id)),
    );
    batch.forEach((id, index) => {
      const book = books[index];
      const exposed = exposedOf(id);
      const modelState = stateLabel(configStateOf(exposed, config, pc));
      if (!book?.ok) {
        rows.push({
          provider: pc.name,
          upstreamGroup: "",
          upstreamModel: id,
          publishedName: exposed,
          aliases: aliasesOf(config, exposed),
          price: {},
          state: "book_unreachable",
        });
        return;
      }
      const allowed = new Set(resolvePools(pc.providers, exposed));
      for (const offer of book.data) {
        const pin = sellerPin(offer, sellers.data);
        const eligible =
          offer.available &&
          offer.healthy &&
          offer.trusted &&
          pin !== undefined &&
          allowed.has(pin);
        rows.push({
          provider: pc.name,
          upstreamGroup: pin ?? offer.provider ?? "",
          upstreamModel: id,
          publishedName: exposed,
          aliases: aliasesOf(config, exposed),
          price: {
            inPerM: offer.price_input_per_1m / 1e6,
            outPerM: offer.price_output_per_1m / 1e6,
          },
          state:
            modelState === "enabled" && !eligible
              ? "offer_filtered"
              : modelState,
        });
      }
    });
  }
  return rows;
}

function declarativeModels(pc: AnyProviderConfig): string[] {
  if (pc.type === "comfyui") return Object.keys(pc.templates);
  if (pc.type === "aihorde" || pc.type === "runware" || pc.type === "typesafe")
    return Object.keys(pc.models);
  return [];
}

/** One provider's listing, read only: GET listing and pricing routes, never a probe, token or key. */
export async function discoverCatalog(
  pc: AnyProviderConfig,
  config: RuntimeConfig,
): Promise<ProviderCatalog> {
  const out: ProviderCatalog = { provider: pc.name, type: pc.type, rows: [] };
  if (DECLARATIVE_TYPES.has(pc.type)) {
    out.note = "declarative";
    out.rows = declarativeModels(pc)
      .filter((m) => inModelScope(config, m))
      .map((m) => ({
        provider: pc.name,
        upstreamGroup: pc.type,
        upstreamModel: m,
        publishedName: m,
        aliases: aliasesOf(config, m),
        price: {},
        state: "declarative",
      }));
    return out;
  }
  if (pc.catalogOnlyWithModels && !config.modelFilter?.length) {
    out.note = "marketplace_skipped";
    return out;
  }
  try {
    if (pc.type === "newapi") out.rows = await newApiRows(pc, config);
    else if (pc.type === "openai-compatible")
      out.rows = await openAICompatibleRows(pc, config);
    else if (pc.type === "nvidia") out.rows = await nvidiaRows(pc, config);
    else if (pc.type === "openrouter")
      out.rows = await openRouterRows(pc, config);
    else if (pc.type === "a7") out.rows = await a7Rows(pc, config);
    else if (pc.type === "ih") out.rows = await ihRows(pc, config);
    else if (pc.type === "si") out.rows = await siRows(pc, config);
  } catch (error) {
    out.error = error instanceof Error ? error.message : String(error);
  }
  return out;
}
