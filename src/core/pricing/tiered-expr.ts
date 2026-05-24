/*
Tiered billing-expression analysis for sync pricing gate.

When upstream serves a model with billing_mode=tiered_expr, model_ratio is a
placeholder (often 37.5) and would fail canonical-cap checks. This extracts an
effective model_ratio + completion_ratio from the expression so the gate can
compare against canonical ratios in the same units.

Units: the expression's `p * X` coefficient X is the input ratio in new-api's
native units (USD per million tokens / 2 — same as `model_ratio`). See
src/core/pricing/sources/types.ts:usdPerTokenToRatio.

Strategy: parse all tiers, pick the cheapest one by input coefficient (p).
Returns its `p` coefficient as effective ratio and `c/p` as completion ratio.
Single-tier expressions become their direct coefficients.

Returns undefined when the expression is unparseable; caller should fall back
to the raw placeholder ratio (and likely drop the model).
*/

const BILLING_PRICING_VAR_KEYS = [
  "p",
  "c",
  "cr",
  "cc",
  "cc1h",
  "img",
  "img_o",
  "ai",
  "ao",
] as const;

const BILLING_VAR_REGEX = new RegExp(
  `\\b(${BILLING_PRICING_VAR_KEYS.join("|")})\\s*\\*\\s*([\\d.eE+-]+)`,
  "g",
);

type TierCoefficients = Record<string, number>;

function stripExprVersion(exprStr: string): string {
  if (!exprStr) return "";
  const m = exprStr.match(/^v(\d+):([\s\S]*)$/);
  return m && m[2] !== undefined ? m[2] : exprStr;
}

function parseTierBody(bodyStr: string): TierCoefficients {
  const coeffs: TierCoefficients = {};
  const re = new RegExp(BILLING_VAR_REGEX.source, "g");
  let m;
  while ((m = re.exec(bodyStr)) !== null) {
    const key = m[1];
    const val = m[2];
    if (key && val !== undefined && !(key in coeffs)) coeffs[key] = Number(val);
  }
  return coeffs;
}

function parseTierCoefficients(exprStr: string): TierCoefficients[] {
  if (!exprStr) return [];
  try {
    const body = stripExprVersion(exprStr);
    const tierRe = /tier\("[^"]*",\s*([^)]+)\)/g;
    const tiers: TierCoefficients[] = [];
    let m;
    while ((m = tierRe.exec(body)) !== null) {
      if (m[1] !== undefined) tiers.push(parseTierBody(m[1]));
    }
    return tiers;
  } catch {
    return [];
  }
}

export interface EffectiveTierPricing {
  modelRatio: number;
  completionRatio: number;
  cacheRatio?: number;
  createCacheRatio?: number;
}

export function effectiveRatioFromBillingExpr(
  billingExpr: string,
): EffectiveTierPricing | undefined {
  const tiers = parseTierCoefficients(billingExpr);
  if (tiers.length === 0) return undefined;
  type TierWithP = TierCoefficients & { p: number };
  const withInput = tiers.filter(
    (t): t is TierWithP => typeof t.p === "number" && t.p > 0,
  );
  if (withInput.length === 0) return undefined;
  const cheapest = withInput.reduce((min, t) => (t.p < min.p ? t : min));
  const completionRatio =
    typeof cheapest.c === "number" ? cheapest.c / cheapest.p : 1;
  return {
    modelRatio: cheapest.p,
    completionRatio,
    cacheRatio:
      typeof cheapest.cr === "number" ? cheapest.cr / cheapest.p : undefined,
    createCacheRatio:
      typeof cheapest.cc === "number" ? cheapest.cc / cheapest.p : undefined,
  };
}
