// Relays like maomiapi sell one model as an ID per effort; the gateway picks one via `@effort:` keys.

const EFFORT_LADDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

// Without a bare ID, the variant a request with no effort gets.
const DEFAULT_ORDER = [
  "medium",
  "high",
  "low",
  "xhigh",
  "max",
  "minimal",
  "none",
];

export interface EffortFamily {
  base: string;
  /** effort -> upstream ID, emitted as `<name>@effort:<effort>` keys. */
  variants: Record<string, string>;
}

function splitEffortTail(model: string): { base: string; effort: string } {
  for (const effort of EFFORT_LADDER) {
    const tail = `-${effort}`;
    if (model.length > tail.length && model.toLowerCase().endsWith(tail))
      return { base: model.slice(0, -tail.length), effort };
  }
  return { base: model, effort: "" };
}

// Same price only; a lone tiered ID (qwen-max) stays itself. A bare ID stays the default and takes
// unmapped efforts with the field forwarded; without one, each effort gets its nearest variant.
export function collapseEffortVariants(
  models: string[],
  priceKey: (model: string) => string | undefined,
): { models: string[]; families: Map<string, EffortFamily> } {
  const byBase = new Map<string, Map<string, string>>();
  for (const model of models) {
    const { base, effort } = splitEffortTail(model);
    if (!byBase.has(base)) byBase.set(base, new Map());
    byBase.get(base)!.set(effort, model);
  }

  const families = new Map<string, EffortFamily>();
  const dropped = new Set<string>();
  for (const [base, members] of byBase) {
    const tiered = EFFORT_LADDER.filter((e) => members.has(e));
    const bare = members.get("");
    if (tiered.length === 0 || (tiered.length < 2 && !bare)) continue;
    const prices = new Set([...members.values()].map(priceKey));
    if (prices.size !== 1 || prices.has(undefined)) continue;

    const variants: Record<string, string> = {};
    if (bare) {
      for (const effort of tiered) variants[effort] = members.get(effort)!;
    } else {
      EFFORT_LADDER.forEach((effort, at) => {
        const nearest = [...tiered].sort(
          (a, b) =>
            Math.abs(EFFORT_LADDER.indexOf(a) - at) -
              Math.abs(EFFORT_LADDER.indexOf(b) - at) ||
            EFFORT_LADDER.indexOf(b) - EFFORT_LADDER.indexOf(a),
        )[0]!;
        variants[effort] = members.get(nearest)!;
      });
    }
    const standIn =
      bare ?? members.get(DEFAULT_ORDER.find((e) => members.has(e))!)!;
    families.set(standIn, { base, variants });
    for (const model of members.values())
      if (model !== standIn) dropped.add(model);
  }

  return { models: models.filter((m) => !dropped.has(m)), families };
}
