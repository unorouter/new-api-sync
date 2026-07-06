// yunwu prices some models (notably gemini-*-image) with a resolution grid that is NOT in
// its pricing API - it lives in the frontend pricing chunk as static React `dataSource`
// arrays. The gateway applies such a grid via GetGridPrice(model, ImageResolution) ONLY for
// gemini-image models (the only path that sets relayInfo.ImageResolution), so this scraper is
// scoped to gemini-image resolution tiers. It is BEST-EFFORT: any fetch/parse failure logs and
// returns {} so the sync falls back to the model's flat price - it never throws.
//
// Discovery is build-hash-proof: the pricing chunk filename changes every yunwu build, so we
// resolve it by ROUTE, not hash: /pricing HTML -> entry chunk -> the `"/pricing": import(...)`
// lazy-import names the current chunk.

import { consola } from "consola";
import { ofetch } from "ofetch";

const PRICING_URL = "https://yunwu.ai/pricing";

// GEM display version -> the gemini-image model ids the grid applies to.
const GEM_VERSION_TO_MODELS: Record<string, string[]> = {
  "3.0": ["gemini-3-pro-image", "gemini-3-pro-image-preview"],
};

// Grid rows key on Resolution matching the gateway's relayInfo.ImageResolution (gemini's
// imageSize values are "1K"/"2K"/"4K"). Value is a MULTIPLIER on the model's base price.
export interface ResolutionRatioRow {
  resolution: string;
  ratio: number;
}

async function fetchText(url: string): Promise<string> {
  return ofetch<string>(url, {
    parseResponse: (t) => t,
    retry: 2,
    timeout: 20_000,
  });
}

// /pricing HTML -> the app entry chunk URL (the only <script src> that is an index-*.js).
function findEntryChunk(html: string): string | undefined {
  const m = html.match(
    /https:\/\/[^"']+\/assets\/js\/index-[A-Za-z0-9_-]+\.js/,
  );
  return m?.[0];
}

// entry chunk -> the pricing route's lazy chunk name, resolved by route path (survives rebuilds).
function findPricingChunk(
  entryJs: string,
  entryUrl: string,
): string | undefined {
  const m = entryJs.match(
    /"\/pricing":\s*\(\)\s*=>[^,]*import\("\.\/(index-[A-Za-z0-9_-]+\.js)"\)/,
  );
  if (!m) return undefined;
  const base = entryUrl.slice(0, entryUrl.lastIndexOf("/") + 1);
  return base + m[1];
}

// Extract GEM resolution base-multipliers from the chunk. Rows look like:
//   {model:"GEM",version:"3.0",resolution:"4K（短边 ≤ 2160）",price:oe(180*r/20)}
//   {model:"GEM",version:"3.0",resolution:"720P、1080P、2K（短边 ≤ 1440）",price:oe(100*r/20)}
// The N in oe(N*r/divisor) is the per-resolution base; the ratio to the base tier is the
// stable multiplier (divisor is a per-group ratio and cancels in the ratio).
function parseGemRatios(chunk: string): Map<string, Map<string, number>> {
  const byVersion = new Map<string, Map<string, number>>();
  const rowRe =
    /\{model:"GEM",version:"([^"]*)",resolution:(?:"([^"]*)"|v\("([^"]*)"\)),price:oe\((\d+(?:\.\d+)?)\*r/g;
  for (const m of chunk.matchAll(rowRe)) {
    const version = m[1];
    const resLabel = m[2] ?? m[3] ?? "";
    if (!version) continue;
    const base = Number(m[4]);
    if (!Number.isFinite(base) || base <= 0) continue;
    const bucket = classifyResolution(resLabel);
    if (!bucket) continue;
    if (!byVersion.has(version)) byVersion.set(version, new Map());
    // first occurrence per (version, bucket) wins; later group-variants share the same ratio
    const vmap = byVersion.get(version)!;
    if (!vmap.has(bucket)) vmap.set(bucket, base);
  }
  return byVersion;
}

// Map a CJK resolution label to the gateway's ImageResolution key. "1K" and "2K" collapse to
// the base tier (same price on yunwu); "4K" is the premium tier.
function classifyResolution(label: string): "base" | "4K" | undefined {
  if (label.includes("4K")) return "4K";
  if (/1K|2K|720P|1080P|不区分/.test(label)) return "base";
  return undefined;
}

// Returns { modelName: [{Resolution, Pricing}] } grid rows, absolute prices computed from the
// model's base price x the scraped resolution ratio. basePrices maps model -> its flat price.
export async function scrapeYunwuGeminiImageGrids(
  basePrices: Record<string, number>,
): Promise<Record<string, Array<Record<string, string | number>>>> {
  const out: Record<string, Array<Record<string, string | number>>> = {};
  try {
    const html = await fetchText(PRICING_URL);
    const entryUrl = findEntryChunk(html);
    if (!entryUrl) {
      consola.warn(
        "[yunwu-grid] entry chunk not found in /pricing HTML; using flat prices",
      );
      return out;
    }
    const entryJs = await fetchText(entryUrl);
    const chunkUrl = findPricingChunk(entryJs, entryUrl);
    if (!chunkUrl) {
      consola.warn(
        "[yunwu-grid] pricing chunk not found via route import; using flat prices",
      );
      return out;
    }
    const chunk = await fetchText(chunkUrl);
    const gemRatios = parseGemRatios(chunk);

    for (const [version, models] of Object.entries(GEM_VERSION_TO_MODELS)) {
      const tiers = gemRatios.get(version);
      const base = tiers?.get("base");
      const hi = tiers?.get("4K");
      if (!base || !hi || hi <= base) {
        consola.warn(
          `[yunwu-grid] GEM ${version} tiers incomplete (base=${base} 4K=${hi}); models fall back to flat`,
        );
        continue;
      }
      const ratio4k = hi / base;
      for (const model of models) {
        const flat = basePrices[model];
        if (!flat || flat <= 0) {
          consola.warn(
            `[yunwu-grid] no base price for ${model}; skipping grid`,
          );
          continue;
        }
        out[model] = [
          { Resolution: "1K", Pricing: r4(flat) },
          { Resolution: "2K", Pricing: r4(flat) },
          { Resolution: "4K", Pricing: r4(flat * ratio4k) },
        ];
      }
    }
    if (Object.keys(out).length > 0)
      consola.info(
        `[yunwu-grid] scraped resolution grids for ${Object.keys(out).join(", ")}`,
      );
    return out;
  } catch (err) {
    consola.warn(
      `[yunwu-grid] scrape failed (${err instanceof Error ? err.message : String(err)}); using flat prices`,
    );
    return out;
  }
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;
