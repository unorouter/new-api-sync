import { toBareName } from "@core/catalog/bare-name";
import { loadConfig } from "@core/config";
const cfg: any = await loadConfig();
const blocked: string[] = cfg.blacklist ?? cfg.blockedModels ?? [];
console.log("blocklist entries:", blocked.length);

const isBlocked = (id: string) => {
  const l = id.toLowerCase();
  return blocked.some((b: string) => {
    const p = b.toLowerCase();
    if (p.includes("/") && !p.includes("*")) return l === p || l.endsWith("/" + p) || l.includes(p);
    const core = p.replace(/^[a-z0-9]+\//, "").replace(/\*/g, "");
    return core.length > 0 && l.includes(core);
  });
};
const norm = (s: string) => toBareName(s.replace(/:free$/, "").toLowerCase());
const prod = new Set(
  (await Bun.file("/tmp/prod-five.txt").text()).trim().split("\n")
    .map((l) => l.split("|")[1]).filter(Boolean).map(norm));

const nv = (await Bun.file("/tmp/nv-live.txt").text()).trim().split("\n");
const cand = nv.filter((m) => !prod.has(norm(m)));
const keep = cand.filter((m) => !isBlocked(m));
const drop = cand.filter((m) => isBlocked(m));
console.log(`\nNVIDIA: ${cand.length} not-in-prod -> ${drop.length} blocklisted, ${keep.length} REAL candidates`);
for (const m of keep) console.log("  +", m);
