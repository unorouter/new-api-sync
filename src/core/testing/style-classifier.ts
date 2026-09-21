/**
 * Word-level style classifier over the probe replies, one class per maker:
 * multinomial naive Bayes on unigrams and bigrams. Cross-family style is the
 * one text signal the literature calls reliable (97% across chat APIs, 96%
 * across Llama, Gemma, Qwen and Mistral, arXiv 2502.12150); within a family
 * it is not, so a posterior names a family and never a version. Trained only
 * on lanes we trust and emitted only when leave-one-lane-out accuracy on
 * those lanes clears the gate.
 */

const MIN_REPLIES_PER_CLASS = 200;
const MIN_CLASSES = 3;
const ACCURACY_GATE = 0.9;
const ALPHA = 0.5;

export type StyleVerdict = {
  top: string;
  p: number;
  second: string | null;
  p2: number;
  samples: number;
};

export type StyleModel = {
  classes: string[];
  /** Per class: feature counts and the total, log prior. */
  counts: Record<string, Record<string, number>>;
  totals: Record<string, number>;
  priors: Record<string, number>;
  vocab: number;
  trained: number;
  accuracy: number | null;
  emitted: boolean;
};

export function styleFeatures(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/\[[a-f0-9]{8}\]/g, " ")
    .replace(/<think>[\s\S]*?<\/think>/g, " ")
    .replace(/\d+/g, "0")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out = [...words];
  for (let i = 0; i + 1 < words.length; i++) out.push(`${words[i]}_${words[i + 1]}`);
  return out;
}

type Lane = { lane: string; label: string; texts: string[] };

function fit(lanes: Lane[]): Omit<StyleModel, "accuracy" | "emitted" | "trained"> & { trained: number } {
  const counts: Record<string, Record<string, number>> = {};
  const totals: Record<string, number> = {};
  const docs: Record<string, number> = {};
  const vocab = new Set<string>();
  let trained = 0;
  for (const l of lanes) {
    counts[l.label] ??= {};
    totals[l.label] ??= 0;
    docs[l.label] ??= 0;
    for (const t of l.texts) {
      if (!t) continue;
      docs[l.label]!++;
      trained++;
      for (const f of styleFeatures(t)) {
        counts[l.label]![f] = (counts[l.label]![f] ?? 0) + 1;
        totals[l.label]!++;
        vocab.add(f);
      }
    }
  }
  const n = Object.values(docs).reduce((a, b) => a + b, 0) || 1;
  const priors = Object.fromEntries(Object.keys(counts).map((c) => [c, Math.log((docs[c] ?? 0) / n || 1e-9)]));
  return { classes: Object.keys(counts), counts, totals, priors, vocab: vocab.size, trained };
}

function posterior(model: Pick<StyleModel, "classes" | "counts" | "totals" | "priors" | "vocab">, texts: string[]): Record<string, number> {
  const feats = texts.flatMap(styleFeatures);
  const logp: Record<string, number> = {};
  for (const c of model.classes) {
    let s = model.priors[c] ?? 0;
    const total = (model.totals[c] ?? 0) + ALPHA * model.vocab;
    for (const f of feats) s += Math.log(((model.counts[c]?.[f] ?? 0) + ALPHA) / total);
    logp[c] = s;
  }
  const max = Math.max(...Object.values(logp));
  const exp = Object.fromEntries(Object.entries(logp).map(([c, v]) => [c, Math.exp(v - max)]));
  const z = Object.values(exp).reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(Object.entries(exp).map(([c, v]) => [c, v / z]));
}

/** Null when the training set is too thin for any class. */
export function trainStyleModel(lanes: Lane[]): StyleModel | null {
  const byClass = new Map<string, number>();
  for (const l of lanes) byClass.set(l.label, (byClass.get(l.label) ?? 0) + l.texts.filter(Boolean).length);
  const eligible = lanes.filter((l) => (byClass.get(l.label) ?? 0) >= MIN_REPLIES_PER_CLASS);
  const classes = new Set(eligible.map((l) => l.label));
  if (classes.size < MIN_CLASSES) return null;
  // Leave one lane out: a lane's own replies never vote for its label.
  let right = 0;
  let tested = 0;
  for (const held of eligible) {
    const rest = eligible.filter((l) => l !== held);
    if (!rest.some((l) => l.label === held.label)) continue;
    const m = fit(rest);
    const p = posterior(m, held.texts);
    const top = Object.entries(p).sort((a, b) => b[1] - a[1])[0]?.[0];
    tested++;
    if (top === held.label) right++;
  }
  const accuracy = tested > 0 ? right / tested : null;
  const full = fit(eligible);
  return { ...full, accuracy, emitted: accuracy !== null && accuracy >= ACCURACY_GATE };
}

export function classifyStyle(model: StyleModel, texts: string[]): StyleVerdict | null {
  const usable = texts.filter(Boolean);
  if (usable.length === 0) return null;
  const ranked = Object.entries(posterior(model, usable)).sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  if (!top) return null;
  return {
    top: top[0],
    p: +top[1].toFixed(3),
    second: second?.[0] ?? null,
    p2: +(second?.[1] ?? 0).toFixed(3),
    samples: usable.length,
  };
}
