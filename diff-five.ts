import { toBareName } from "@core/catalog/bare-name";
const norm = (s: string) => toBareName(s.replace(/:free$/, "").toLowerCase());

const prodLines = (await Bun.file("/tmp/prod-five.txt").text()).trim().split("\n");
const prodByProv: Record<string, Set<string>> = {};
for (const l of prodLines) {
  const [chan, model] = l.split("|");
  if (!model) continue;
  const p = chan.match(/(nvda[123]|kilo1|open[12])/)?.[1];
  if (!p) continue;
  (prodByProv[p] ??= new Set()).add(norm(model));
}
const prodAll = new Set(Object.values(prodByProv).flatMap((s) => [...s]));

const nv = (await Bun.file("/tmp/nv-live.txt").text()).trim().split("\n");
const or = (await Bun.file("/tmp/or-free.txt").text()).trim().split("\n");

console.log("prod per provider:", Object.fromEntries(Object.entries(prodByProv).map(([k,v])=>[k,v.size])));

const nvNew = nv.filter((m) => !prodAll.has(norm(m)));
console.log("\n=== NVIDIA live not in ANY prod nvda channel:", nvNew.length, "===");
for (const m of nvNew) console.log("  +", m, "-> bare:", norm(m));

const orNew = or.filter((m) => !prodAll.has(norm(m)));
console.log("\n=== OpenRouter FREE not in prod open1/2:", orNew.length, "===");
for (const m of orNew) console.log("  +", m, "-> bare:", norm(m));
