import { fetchSameHost, tryFetchJson } from "@core/infra/http";
import type { ModelType } from "@core/types";
import type {
  DiscoveryConfig,
  DiscoveryFilter,
} from "@core/validations/config";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

type Row = Record<string, unknown>;

const USD_PER_M_PER_RATIO = 2;

/** Every value at a dotted path, descending into arrays at any level. */
function valuesAt(row: unknown, path: string): unknown[] {
  let current: unknown[] = [row];
  for (const key of path.split(".")) {
    const next: unknown[] = [];
    for (const value of current) {
      if (Array.isArray(value)) {
        for (const item of value)
          if (item && typeof item === "object") next.push((item as Row)[key]);
      } else if (value && typeof value === "object") {
        next.push((value as Row)[key]);
      }
    }
    current = next;
  }
  return current
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .filter((v) => v !== undefined);
}

// A rule value of null also matches a missing field, so "absent means chat" is expressible.
function matchesAny(row: Row, path: string, expected: unknown): boolean {
  const wanted = Array.isArray(expected) ? expected : [expected];
  const actual = valuesAt(row, path);
  if (actual.length === 0) return wanted.includes(null);
  return actual.some((v) => wanted.includes(v));
}

function allZero(row: Row, path: string): boolean {
  const values = valuesAt(row, path);
  return values.length > 0 && values.every((v) => Number(v) === 0);
}

function passes(
  row: Row,
  id: string,
  filter: DiscoveryFilter,
  flags: string,
): boolean {
  if (filter.include && !new RegExp(filter.include, flags).test(id))
    return false;
  if (filter.exclude && new RegExp(filter.exclude, flags).test(id))
    return false;
  for (const [path, value] of Object.entries(filter.where ?? {}))
    if (!matchesAny(row, path, value)) return false;
  for (const [path, value] of Object.entries(filter.whereNot ?? {}))
    if (matchesAny(row, path, value)) return false;
  if (filter.free) {
    const prompt = filter.free.prompt ?? "pricing.prompt";
    const completion = filter.free.completion ?? "pricing.completion";
    if (!allZero(row, prompt) || !allZero(row, completion)) return false;
  }
  return true;
}

function firstNumber(row: Row, paths: string[]): number | undefined {
  for (const path of paths) {
    const numbers = valuesAt(row, path)
      .map((v) => (typeof v === "string" ? Number.parseInt(v, 10) : v))
      .filter((v): v is number => typeof v === "number" && v > 0);
    if (numbers.length > 0) return Math.max(...numbers);
  }
  return undefined;
}

function rowsOf(data: unknown, listField: string | undefined): Row[] {
  if (Array.isArray(data)) return data as Row[];
  if (!data || typeof data !== "object") return [];
  const body = data as Row;
  const list = listField
    ? valuesAt(body, listField)
    : (body.data ?? body.models ?? body.result);
  return Array.isArray(list) ? (list as Row[]) : [];
}

function idOf(row: Row, fields: string[], stripPrefix: string | undefined) {
  for (const field of fields) {
    const value = valuesAt(row, field)[0];
    if (typeof value === "string" && value) {
      return stripPrefix && value.startsWith(stripPrefix)
        ? value.slice(stripPrefix.length)
        : value;
    }
  }
  return undefined;
}

function authHeaders(apiKey: string, cfg: DiscoveryConfig) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...cfg.headers,
  };
  if (!apiKey || apiKey === "keyless" || cfg.authHeader === "none")
    return headers;
  if (cfg.authHeader) headers[cfg.authHeader] = apiKey;
  else headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function listUrl(baseUrl: string, cfg: DiscoveryConfig): string {
  if (cfg.url) return cfg.url;
  return `${baseUrl.replace(/\/$/, "")}${cfg.path ?? "/v1/models"}`;
}

// Some upstreams hide the output cap and only name it when a request exceeds it.
async function probeOutputCap(
  baseUrl: string,
  headers: Record<string, string>,
  model: string,
): Promise<number | undefined> {
  try {
    const res = await fetchSameHost(
      `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 200_000,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (res.ok) return undefined;
    const body = (await res.json().catch(() => null)) as Row | null;
    const message = typeof body?.message === "string" ? body.message : "";
    const cap = Number(message.match(/less than or equal to (\d+)/i)?.[1]);
    return cap > 0 ? cap : undefined;
  } catch {
    return undefined;
  }
}

/** Models in the groups a new-api relay prices at ratio 0. */
async function discoverFreeGroups(
  baseUrl: string,
  headers: Record<string, string>,
  cfg: DiscoveryConfig,
): Promise<OpenAIFreeDiscovery> {
  const url = cfg.url ?? `${baseUrl.replace(/\/$/, "")}/api/pricing`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "pricing", url }));
  const data = await tryFetchJson<{
    group_ratio?: Record<string, number>;
    data?: { model_name: string; enable_groups?: string[] }[];
  }>(url, { headers, timeoutMs: cfg.timeoutMs ?? 15_000 });
  const free = new Set(
    Object.entries(data?.group_ratio ?? {})
      .filter(([, ratio]) => ratio === 0)
      .map(([group]) => group),
  );
  const models = (data?.data ?? [])
    .filter((m) => (m.enable_groups ?? []).some((g) => free.has(g)))
    .map((m) => m.model_name);
  return { models, maxOutputByModel: new Map() };
}

/** One catalog search per task, each task tagged with the model type it serves. */
async function discoverTaskCatalog(
  baseUrl: string,
  headers: Record<string, string>,
  cfg: DiscoveryConfig,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "").replace(/\/v1$/, "");
  const tasks = Object.entries(cfg.tasks ?? {});
  const pages = await Promise.all(
    tasks.map(([task]) => {
      const url = `${base}${cfg.path ?? "/models/search"}?task=${task}&per_page=100`;
      consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: task, url }));
      return tryFetchJson<unknown>(url, {
        headers,
        timeoutMs: cfg.timeoutMs ?? 15_000,
      });
    }),
  );
  const flags = cfg.ignoreCase ? "i" : "";
  const models: string[] = [];
  const maxOutputByModel = new Map<string, number>();
  const modelTypeHints = new Map<string, ModelType>();
  tasks.forEach(([, task], i) => {
    for (const row of rowsOf(pages[i], cfg.listField ?? "result")) {
      const id = idOf(row, [cfg.idField ?? "name"].flat(), undefined);
      if (!id) continue;
      if (task.exclude && new RegExp(task.exclude, flags).test(id)) continue;
      models.push(id);
      if (task.type) modelTypeHints.set(id, task.type);
      const ctx = (row.properties as Row[] | undefined)?.find(
        (p) => p.property_id === "context_window",
      )?.value;
      const cap = typeof ctx === "string" ? Number.parseInt(ctx, 10) : ctx;
      if (typeof cap === "number" && cap > 0) maxOutputByModel.set(id, cap);
    }
  });
  return { models, maxOutputByModel, modelTypeHints };
}

/**
 * The model list of an OpenAI-compatible upstream, shaped entirely by the
 * provider's `discovery` block in config.yml.
 */
export async function discoverModels(
  baseUrl: string,
  apiKey: string,
  label: string,
  cfg: DiscoveryConfig = {},
): Promise<OpenAIFreeDiscovery> {
  const headers = authHeaders(apiKey, cfg);
  if (cfg.mode === "free-groups")
    return discoverFreeGroups(baseUrl, headers, cfg);
  if (cfg.mode === "task-catalog")
    return discoverTaskCatalog(baseUrl, headers, cfg);

  const typeHints = (ids: string[]) =>
    cfg.modelType
      ? new Map(ids.map((id) => [id, cfg.modelType as ModelType]))
      : undefined;
  if (cfg.models) {
    return {
      models: cfg.models,
      maxOutputByModel: new Map(),
      modelTypeHints: typeHints(cfg.models),
    };
  }

  const url = listUrl(baseUrl, cfg);
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label, url }));
  const data = await tryFetchJson<unknown>(url, {
    headers,
    timeoutMs: cfg.timeoutMs ?? 15_000,
  });
  const flags = cfg.ignoreCase ? "i" : "";
  const idFields = [cfg.idField ?? "id"].flat();
  const maxOutputFields = [cfg.maxOutputField ?? []].flat();
  const filters = cfg.filters?.length ? cfg.filters : [{}];
  const top: DiscoveryFilter = { include: cfg.include, exclude: cfg.exclude };

  const models: string[] = [];
  const maxOutputByModel = new Map<string, number>();
  const ratioByModel = new Map<string, number>();
  const completionRatioByModel = new Map<string, number>();
  for (const row of rowsOf(data, cfg.listField)) {
    const id = idOf(row, idFields, cfg.idStripPrefix);
    if (!id) continue;
    if (!passes(row, id, top, flags)) continue;
    if (!filters.some((f) => passes(row, id, f, flags))) continue;
    models.push(id);
    const cap = firstNumber(row, maxOutputFields);
    if (cap) maxOutputByModel.set(id, cap);
    if (cfg.pricing) {
      const input = Number(
        valuesAt(row, cfg.pricing.prompt ?? "pricing.prompt")[0],
      );
      const output = Number(
        valuesAt(row, cfg.pricing.completion ?? "pricing.completion")[0],
      );
      if (input > 0) {
        const perM = cfg.pricing.unit === "million" ? input : input * 1_000_000;
        ratioByModel.set(id, perM / USD_PER_M_PER_RATIO);
        if (output > 0) completionRatioByModel.set(id, output / input);
      }
    }
  }

  if (cfg.probeOutputCap) {
    for (const id of models) {
      if (/embed/i.test(id)) continue;
      const cap = await probeOutputCap(baseUrl, headers, id);
      if (cap) maxOutputByModel.set(id, cap);
    }
  }

  return {
    models,
    maxOutputByModel,
    modelTypeHints: typeHints(models),
    ...(cfg.pricing ? { ratioByModel, completionRatioByModel } : {}),
  };
}
