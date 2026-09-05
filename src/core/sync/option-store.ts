import {
  groupsOnChannels,
  modelsOnChannels,
} from "@core/catalog/constants/patterns";
import type { Channel, PricingAudit } from "@core/types";
import {
  GROUP_OPTION_KEYS,
  MANAGED_OPTION_KEYS,
  MODEL_OPTION_KEYS,
  PRICING_KEYS,
} from "@core/types";
import type { NewApiClient } from "@core/vendors/newapi/client";
import { t } from "@server/i18n";
import { consola } from "consola";
import stringify from "safe-stable-stringify";

export function parseJsonObject(
  raw: string | undefined,
): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw ?? "");
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? { ...v }
      : {};
  } catch {
    return {};
  }
}

export function parseJsonStringArray(raw: string | undefined): string[] {
  try {
    const v: unknown = JSON.parse(raw ?? "");
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

// Subscription tiers bill through GroupRatio without owning a channel, so it is
// never pruned; these names are never pruned from any group map.
const BASE_GROUPS = new Set(["default", "auto", "vip", "svip"]);

// Additive keys land before subtractive ones: a group must be priced before it
// is usable or auto, and a model's flat price must exist before its ratio goes.
const FLUSH_ORDER: readonly string[] = [
  "GroupRatio",
  "UserUsableGroups",
  "AutoGroups",
  "ModelPrice",
  "billing_setting.billing_mode",
  "billing_setting.billing_expr",
  "ModelQuotaType",
  "ModelGridPricing",
  "ModelRatio",
  "CompletionRatio",
  ...MANAGED_OPTION_KEYS,
];

const OBJECT_KEYS = new Set<string>([
  ...GROUP_OPTION_KEYS.filter((k) => k !== "AutoGroups"),
  ...MODEL_OPTION_KEYS,
]);

export interface OptionSettlement extends PricingAudit {
  changed: string[];
}

export interface OptionFlush extends PricingAudit {
  written: string[];
  errors: { key: string; message: string }[];
}

export function printPricingAudit(
  audit: PricingAudit,
  unpriced: string[],
): void {
  const lines = [
    ...audit.healed.map((h) => `healed ${h.key}: ${h.names.join(", ")}`),
    ...audit.dropped.map((d) => `dropped ${d.key}: ${d.names.join(", ")}`),
  ];
  if (unpriced.length > 0)
    lines.push(`unpriced on enabled channels: ${unpriced.join(", ")}`);
  if (lines.length === 0) {
    consola.info("[pricing] clean");
    return;
  }
  for (const line of lines) consola.error(`[pricing] ${line}`);
}

export class OptionStore {
  private readonly before: Record<string, string | undefined>;
  private next: Record<string, string | undefined>;

  private constructor(options: Record<string, string>) {
    this.before = { ...options };
    this.next = { ...options };
  }

  static async load(client: NewApiClient): Promise<OptionStore> {
    return new OptionStore(await client.getOptions([...MANAGED_OPTION_KEYS]));
  }

  static fromRaw(options: Record<string, string>): OptionStore {
    return new OptionStore(options);
  }

  raw(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.next))
      if (v !== undefined) out[k] = v;
    return out;
  }

  object(key: string): Record<string, unknown> {
    return parseJsonObject(this.next[key]);
  }

  autoGroups(): string[] {
    return parseJsonStringArray(this.next["AutoGroups"]);
  }

  replace(key: string, value: string): void {
    this.next[key] = value;
  }

  private writeObject(key: string, value: Record<string, unknown>): void {
    this.next[key] = stringify(value) ?? "{}";
  }

  private writeAutoGroups(auto: string[]): void {
    this.next["AutoGroups"] = JSON.stringify(auto);
  }

  setEntries(key: string, entries: Record<string, unknown>): void {
    const map = this.object(key);
    for (const [name, value] of Object.entries(entries)) map[name] = value;
    this.writeObject(key, map);
  }

  deleteEntries(key: string, names: Iterable<string>): void {
    const map = this.object(key);
    for (const name of names) delete map[name];
    this.writeObject(key, map);
  }

  private sortedAuto(auto: Iterable<string>): string[] {
    const ratio = this.object("GroupRatio");
    const ratioOf = (g: string) => {
      const r = ratio[g];
      return typeof r === "number" ? r : 1;
    };
    return [...new Set(auto)].sort((a, b) => ratioOf(a) - ratioOf(b));
  }

  // Additive only: entries are added or updated, never removed. A run only
  // prices the models that passed ITS probe, so removal by omission would drop
  // every group whose model merely throttled during the probe. Removal is
  // pruneGroups, which sees the full channel list.
  mergeGroups(groups: {
    ratio?: Record<string, number>;
    usable?: Record<string, string>;
    auto?: string[];
  }): void {
    if (groups.ratio) this.setEntries("GroupRatio", groups.ratio);
    this.setEntries("UserUsableGroups", {
      auto: t("CORE.GROUPS.AUTO_LABEL"),
      ...groups.usable,
    });
    this.writeAutoGroups(
      this.sortedAuto([...this.autoGroups(), ...(groups.auto ?? [])]),
    );
  }

  // Groups no channel carries linger in UserUsableGroups/AutoGroups and the token
  // group picker then offers unroutable pins. Returns the pruned names.
  pruneGroups(liveGroups: Set<string>, protect: Set<string>): string[] {
    const keep = (g: string) =>
      BASE_GROUPS.has(g) || liveGroups.has(g) || protect.has(g);
    const pruned = new Set<string>();
    const usable = this.object("UserUsableGroups");
    for (const g of Object.keys(usable))
      if (!keep(g)) {
        delete usable[g];
        pruned.add(g);
      }
    this.writeObject("UserUsableGroups", usable);
    const auto = this.autoGroups();
    for (const g of auto) if (!keep(g)) pruned.add(g);
    this.writeAutoGroups(auto.filter(keep));
    const names = [...pruned].sort();
    if (names.length > 0)
      consola.info(
        t("CORE.SYNC.DEAD_GROUPS_PRUNED", {
          count: names.length,
          names: names.join(", "),
        }),
      );
    return names;
  }

  // Phase "add" copies every old key to the new name; "remove" drops the old
  // keys. Two phases so a token pinned to both names never points at a group
  // the gateway lacks.
  renameGroups(
    renames: ReadonlyArray<{ from: string; to: string }>,
    phase: "add" | "remove",
  ): void {
    const ratio = this.object("GroupRatio");
    const usable = this.object("UserUsableGroups");
    let auto = this.autoGroups();
    for (const { from, to } of renames) {
      if (phase === "add") {
        if (from in ratio && !(to in ratio)) ratio[to] = ratio[from];
        if (from in usable && !(to in usable)) usable[to] = usable[from];
        if (auto.includes(from) && !auto.includes(to)) auto.push(to);
      } else {
        delete ratio[from];
        delete usable[from];
        auto = auto.filter((g) => g !== from);
      }
    }
    this.writeObject("GroupRatio", ratio);
    this.writeObject("UserUsableGroups", usable);
    this.writeAutoGroups(this.sortedAuto(auto));
  }

  private isDirty(key: string): boolean {
    const a = this.before[key];
    const b = this.next[key];
    if (a === b) return false;
    if (b === undefined) return false;
    if (a === undefined) return true;
    if (key === "AutoGroups")
      return (
        JSON.stringify(parseJsonStringArray(a)) !==
        JSON.stringify(parseJsonStringArray(b))
      );
    if (OBJECT_KEYS.has(key))
      return stringify(parseJsonObject(a)) !== stringify(parseJsonObject(b));
    return true;
  }

  dirtyKeys(): string[] {
    return FLUSH_ORDER.filter(
      (k, i) => FLUSH_ORDER.indexOf(k) === i && this.isDirty(k),
    );
  }

  unpricedLiveModels(channels: Channel[]): string[] {
    const priced = PRICING_KEYS.map((k) => this.object(k));
    return [
      ...modelsOnChannels(channels, {
        enabledOnly: true,
        includeAliases: false,
      }),
    ]
      .filter((m) => !priced.some((map) => m in map))
      .sort();
  }

  // The one invariant every option write is held to: a model an enabled channel
  // serves keeps at least one price, and a group any channel carries keeps its
  // entries. Endangered entries are carried forward from the loaded values and
  // reported; the rest of the write proceeds.
  settle(channels: Channel[]): OptionSettlement {
    const dropped: OptionSettlement["dropped"] = [];
    const healed: OptionSettlement["healed"] = [];
    const live = modelsOnChannels(channels, {
      enabledOnly: true,
      includeAliases: false,
    });
    const pricedBefore = PRICING_KEYS.map((k) =>
      parseJsonObject(this.before[k]),
    );
    const pricedAfter = PRICING_KEYS.map((k) => this.object(k));
    const endangered = [...live].filter(
      (m) =>
        pricedBefore.some((x) => m in x) && !pricedAfter.some((x) => m in x),
    );
    if (endangered.length > 0)
      for (const key of MODEL_OPTION_KEYS) {
        const was = parseJsonObject(this.before[key]);
        const names = endangered.filter((m) => m in was);
        if (names.length === 0) continue;
        this.setEntries(key, Object.fromEntries(names.map((m) => [m, was[m]])));
        healed.push({ key, names: names.sort() });
      }
    const carried = groupsOnChannels(channels, { enabledOnly: false });
    for (const key of GROUP_OPTION_KEYS) {
      if (key === "AutoGroups") {
        const was = parseJsonStringArray(this.before[key]);
        const now = new Set(this.autoGroups());
        const names = was.filter((g) => carried.has(g) && !now.has(g));
        if (names.length === 0) continue;
        this.writeAutoGroups(this.sortedAuto([...now, ...names]));
        healed.push({ key, names: names.sort() });
        continue;
      }
      const was = parseJsonObject(this.before[key]);
      const now = this.object(key);
      const names = Object.keys(was).filter(
        (g) => carried.has(g) && !(g in now),
      );
      if (names.length === 0) continue;
      this.setEntries(key, Object.fromEntries(names.map((g) => [g, was[g]])));
      healed.push({ key, names: names.sort() });
    }
    for (const key of PRICING_KEYS) {
      if (!this.isDirty(key)) continue;
      const after = this.object(key);
      const names = Object.keys(parseJsonObject(this.before[key])).filter(
        (m) => !(m in after),
      );
      if (names.length > 0) dropped.push({ key, names: names.sort() });
    }
    return { changed: this.dirtyKeys(), dropped, healed };
  }

  async flush(client: NewApiClient, channels: Channel[]): Promise<OptionFlush> {
    const plan = this.settle(channels);
    const written: string[] = [];
    const errors: OptionFlush["errors"] = [];
    for (const { key, names } of plan.dropped)
      consola.warn(
        `[option-store] ${key} drops ${names.length} model(s): ${names.join(", ")}`,
      );
    for (const { key, names } of plan.healed) {
      const message = `healed ${names.length} entr${names.length === 1 ? "y" : "ies"} kept at last value: ${names.join(", ")}`;
      consola.error(`[option-store] ${key}: ${message}`);
      errors.push({ key, message });
    }
    for (const key of plan.changed) {
      const value = this.next[key];
      if (value === undefined) continue;
      if (await client.updateOption(key, value)) {
        written.push(key);
        this.before[key] = value;
      } else errors.push({ key, message: "option write failed" });
    }
    return { written, errors, dropped: plan.dropped, healed: plan.healed };
  }
}
