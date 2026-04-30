import { describe, expect, it } from "bun:test";
import { computePricedPlan } from "./compute";
import type { OfferModel, UpstreamOffer } from "./offers";
import type { BaselineInputs } from "./types";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function model(name: string, overrides: Partial<OfferModel> = {}): OfferModel {
  return {
    exposed: name,
    upstream: name,
    modelType: "text",
    ...overrides,
  };
}

function offer(overrides: Partial<UpstreamOffer> = {}): UpstreamOffer {
  return {
    provider: "p1",
    providerKind: "newapi",
    group: "default",
    sanitizedBase: "default-p1",
    vendor: "anthropic",
    channelType: 14,
    baseUrl: "https://up.example.com",
    apiKey: "k",
    groupRatio: 1,
    channelRemark: "remark",
    models: [],
    defaultAdjustment: 0,
    maxRatioCap: 3,
    ...overrides,
  };
}

const emptyBaseline: BaselineInputs = {
  groups: [],
  channels: [],
  modelRatios: new Map(),
};

const emptyArgs = {
  baseline: emptyBaseline,
  canonical: new Map<string, number>(),
  pricingSources: [],
  reverseMapping: new Map<string, string>(),
  modelMapping: {},
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computePricedPlan", () => {
  it("1. single offer + model, no canonical → ratio passes through", () => {
    const o = offer({
      models: [model("kimi", { upstreamRatio: 3.25 })],
      groupRatio: 0.26,
      defaultAdjustment: -0.25,
    });
    const plan = computePricedPlan({ ...emptyArgs, offers: [o] });

    expect(plan.modelRatios.get("kimi")?.ratio).toBe(3.25);
    expect(plan.tiers).toHaveLength(1);
    // group_ratio = 0.26 * (1 + -0.25) * (3.25/3.25) = 0.195
    expect(plan.tiers[0]!.groupRatio).toBeCloseTo(0.195, 4);
    expect(plan.drops).toHaveLength(0);
  });

  it("2. two offers same model, cheapest writtenRatio + rescale on dearer", () => {
    const cheap = offer({
      provider: "cheap",
      sanitizedBase: "g-cheap",
      models: [model("kimi", { upstreamRatio: 0.5 })],
      groupRatio: 0.5,
      defaultAdjustment: 0,
    });
    const dear = offer({
      provider: "dear",
      sanitizedBase: "g-dear",
      models: [model("kimi", { upstreamRatio: 5.0 })],
      groupRatio: 0.2,
      defaultAdjustment: 0,
      maxRatioCap: 100, // high cap to avoid drop interference for this test
    });
    const plan = computePricedPlan({ ...emptyArgs, offers: [cheap, dear] });

    expect(plan.modelRatios.get("kimi")?.ratio).toBe(0.5);
    expect(plan.tiers).toHaveLength(2);
    const cheapTier = plan.tiers.find((t) => t.providerTag === "cheap");
    const dearTier = plan.tiers.find((t) => t.providerTag === "dear");
    expect(cheapTier!.groupRatio).toBeCloseTo(0.5, 4); // 0.5 * (5.0 ... no wait)
    // cheap: rescale = 0.5/0.5 = 1; group = 0.5 * 1 * 1 = 0.5
    // dear:  rescale = 5.0/0.5 = 10; group = 0.2 * 1 * 10 = 2.0
    expect(cheapTier!.groupRatio).toBeCloseTo(0.5, 4);
    expect(dearTier!.groupRatio).toBeCloseTo(2.0, 4);
  });

  it("3. canonical override — channel says 0.5, canonical 1.5 → written 1.5, rescale = 0.5/1.5", () => {
    const o = offer({
      models: [model("z-ai/glm", { upstreamRatio: 0.5, exposed: "glm" })],
      groupRatio: 1.0,
      defaultAdjustment: 0,
    });
    const plan = computePricedPlan({
      ...emptyArgs,
      offers: [o],
      canonical: new Map([["glm", 1.5]]),
    });

    expect(plan.modelRatios.get("glm")?.ratio).toBe(1.5);
    expect(plan.modelRatios.get("glm")?.pricingSource).toBe("litellm");
    // group = 1.0 * 1 * (0.5/1.5) ≈ 0.3333
    expect(plan.tiers[0]!.groupRatio).toBeCloseTo(1 / 3, 4);
  });

  it("4. cap drop — effective 5x with canonical → drop with reason cap-exceeded", () => {
    const o = offer({
      models: [model("opus", { upstreamRatio: 5.0 })],
      groupRatio: 1.0,
      defaultAdjustment: 0,
      maxRatioCap: 2,
    });
    const plan = computePricedPlan({
      ...emptyArgs,
      offers: [o],
      canonical: new Map([["opus", 1.0]]),
    });
    // written = 1.0 (canonical); rescale = 5.0/1.0 = 5; group = 5.0; charge = 1.0 * 5 = 5; ceiling = 1.0 * 2 = 2 → drop
    expect(plan.tiers).toHaveLength(0);
    expect(plan.drops).toHaveLength(1);
    expect(plan.drops[0]!.reason).toBe("cap-exceeded");
    expect(plan.drops[0]!.model).toBe("opus");
  });

  it("5. free model → ratio 0, completion 0, group 0, cap skipped", () => {
    const o = offer({
      models: [model("gpt-oss", { isFree: true })],
      groupRatio: 0,
      defaultAdjustment: 0,
    });
    const plan = computePricedPlan({ ...emptyArgs, offers: [o] });
    const merged = plan.modelRatios.get("gpt-oss")!;
    expect(merged.ratio).toBe(0);
    expect(merged.completionRatio).toBe(0);
    expect(plan.tiers).toHaveLength(1);
    expect(plan.tiers[0]!.groupRatio).toBe(0);
    expect(plan.drops).toHaveLength(0);
  });

  it("6. fixed-price (modelPrice>0, quotaType=1) → preserved, tier emitted", () => {
    const o = offer({
      models: [
        model("dall-e-3", {
          modelType: "image",
          modelPrice: 0.04,
          quotaType: 1,
        }),
      ],
      groupRatio: 1.0,
      defaultAdjustment: 0,
    });
    const plan = computePricedPlan({ ...emptyArgs, offers: [o] });
    const merged = plan.modelRatios.get("dall-e-3")!;
    expect(merged.modelPrice).toBe(0.04);
    expect(merged.quotaType).toBe(1);
    expect(plan.tiers).toHaveLength(1);
    expect(plan.tiers[0]!.groupRatio).toBe(1.0);
  });

  it("7. task override — models with openai-video endpoint sub-split into separate tiers", () => {
    const o = offer({
      models: [
        model("regular", { upstreamRatio: 1.0 }),
        model("sora-2-pro", {
          upstreamRatio: 1.0,
          modelType: "video",
          endpoints: ["openai-video"],
        }),
      ],
      groupRatio: 0.5,
      defaultAdjustment: 0,
    });
    const plan = computePricedPlan({ ...emptyArgs, offers: [o] });
    // Both have effectiveRatio = 0.5 → same bucket → sub-split by override
    expect(plan.tiers.length).toBeGreaterThanOrEqual(2);
    const taskTier = plan.tiers.find((t) => t.models.includes("sora-2-pro"));
    const regularTier = plan.tiers.find((t) => t.models.includes("regular"));
    expect(taskTier).toBeDefined();
    expect(regularTier).toBeDefined();
    // Sub-split must produce distinct tier suffixes -t0a / -t0b.
    expect(taskTier!.channelName).not.toBe(regularTier!.channelName);
  });

  it("8. multi-tier vendor bucket — different ratios produce -t0/-t1 suffixes", () => {
    // Pin canonical for c so its writtenRatio differs from upstreamRatio,
    // forcing rescale != 1 and a different bucket.
    const o = offer({
      models: [
        model("a", { upstreamRatio: 1.0 }),
        model("b", { upstreamRatio: 1.0 }),
        model("c", { upstreamRatio: 5.0 }),
      ],
      groupRatio: 0.3,
      defaultAdjustment: 0,
      maxRatioCap: 100,
    });
    const plan = computePricedPlan({
      ...emptyArgs,
      offers: [o],
      canonical: new Map([
        ["a", 1.0],
        ["b", 1.0],
        ["c", 1.0],
      ]),
    });
    // a/b: rescale 1.0/1.0 = 1, group 0.3
    // c:   rescale 5.0/1.0 = 5, group 1.5
    expect(plan.tiers).toHaveLength(2);
    const names = plan.tiers.map((t) => t.channelName);
    expect(names.some((n) => n.endsWith("-t0"))).toBe(true);
    expect(names.some((n) => n.endsWith("-t1"))).toBe(true);
  });

  it("9. paid OpenRouter — picks highest discrete candidate keeping all models under cap", () => {
    const o = offer({
      providerKind: "openrouter",
      paidTier: true,
      provider: "open1-paid",
      sanitizedBase: "open1-paid",
      vendor: "moonshot",
      models: [
        model("kimi", { upstreamRatio: 3.25 }),
        model("kimi-cheap", { upstreamRatio: 0.1 }),
      ],
      groupRatio: 1.0, // unused for paid
      maxRatioCap: 3,
    });
    const plan = computePricedPlan({
      ...emptyArgs,
      offers: [o],
      canonical: new Map([
        ["kimi", 0.475],
        ["kimi-cheap", 0.5],
      ]),
    });
    // For kimi: written=0.475, ceiling = 0.475 * 3 = 1.425
    //   ratio 1.0  → 0.475 → fits
    //   But wait: kimi's written is 0.475 (canonical), 0.475 * 1.0 = 0.475 ≤ 1.425 ✓
    // kimi-cheap: written=0.5, ceiling = 0.5 * 3 = 1.5
    //   ratio 1.0 → 0.5 ≤ 1.5 ✓
    // → both fit at ratio 1.0 → chosen.
    expect(plan.tiers).toHaveLength(1);
    expect(plan.tiers[0]!.groupRatio).toBe(1);
    expect(plan.tiers[0]!.models).toEqual(
      expect.arrayContaining(["kimi", "kimi-cheap"]),
    );
  });

  it("10. cheapest-existing lookup (sub2api) — baseline group 0.3, adj 0.1 → tier 0.33", () => {
    const baseline: BaselineInputs = {
      groups: [{ name: "g-other", ratio: 0.3, description: "", provider: "x" }],
      channels: [
        {
          name: "g-other",
          type: 14,
          key: "",
          base_url: "",
          models: "kimi",
          group: "g-other",
          priority: 0,
          status: 1,
        },
      ],
      modelRatios: new Map([
        [
          "kimi",
          {
            ratio: 0.5,
            completionRatio: 1,
            pricingSource: "channel" as const,
          },
        ],
      ]),
    };
    const sub = offer({
      providerKind: "sub2api",
      provider: "sub",
      sanitizedBase: "sub",
      vendor: "moonshot",
      groupRatio: 1.0,
      defaultAdjustment: 0.1,
      models: [
        // upstreamRatio undefined → phase B path
        model("kimi"),
      ],
    });
    const plan = computePricedPlan({
      ...emptyArgs,
      baseline,
      offers: [sub],
    });
    expect(plan.tiers).toHaveLength(1);
    expect(plan.tiers[0]!.groupRatio).toBeCloseTo(0.33, 4);
  });

  it("11. emit-side collision — distinct providers same vendor produce distinct names", () => {
    // Compute alone doesn't dedup — emit detects collisions. This test just
    // confirms compute generates the names we expect when input is OK.
    const a = offer({
      provider: "a",
      sanitizedBase: "g-a",
      models: [model("m1", { upstreamRatio: 1 })],
      groupRatio: 1,
    });
    const b = offer({
      provider: "b",
      sanitizedBase: "g-b",
      models: [model("m1", { upstreamRatio: 1 })],
      groupRatio: 1,
    });
    const plan = computePricedPlan({ ...emptyArgs, offers: [a, b] });
    expect(plan.tiers).toHaveLength(2);
    expect(plan.tiers[0]!.channelName).not.toBe(plan.tiers[1]!.channelName);
  });

  it("12. backfill — model only in offers with no upstream ratio + canonical → from canonical", () => {
    const o = offer({
      providerKind: "sub2api",
      provider: "sub",
      sanitizedBase: "sub",
      vendor: "anthropic",
      groupRatio: 0.5,
      models: [model("claude-sonnet")],
      defaultAdjustment: 0,
    });
    const plan = computePricedPlan({
      ...emptyArgs,
      offers: [o],
      canonical: new Map([["claude-sonnet", 1.5]]),
    });
    expect(plan.modelRatios.get("claude-sonnet")?.ratio).toBe(1.5);
    expect(plan.modelRatios.get("claude-sonnet")?.pricingSource).toBe("litellm");
  });

  it("13. fixed-price + canonical → modelPrice/quotaType preserved (not overridden)", () => {
    const o = offer({
      models: [
        model("dall-e", {
          modelType: "image",
          modelPrice: 0.04,
          quotaType: 1,
        }),
      ],
      groupRatio: 1.0,
    });
    const plan = computePricedPlan({
      ...emptyArgs,
      offers: [o],
      canonical: new Map([["dall-e", 0.5]]),
    });
    const merged = plan.modelRatios.get("dall-e")!;
    expect(merged.modelPrice).toBe(0.04);
    expect(merged.quotaType).toBe(1);
    // Fixed-price path doesn't touch ratio (ratio stays 0).
    expect(merged.ratio).toBe(0);
  });
});
