import { throwIfRunAborted } from "@core/infra/abort";
import { fetchJsonResult } from "@core/infra/http";
import { listTokens } from "@core/vendors/newapi/tokens";
import type { ClientContext } from "@core/vendors/newapi/context";
import type { UpstreamToken } from "@core/vendors/newapi/types";
import { consola } from "consola";
import { t } from "@server/i18n";
import { compactUpstreamRow } from "./cache";
import type { SourceStatus, UpstreamLogRow } from "./types";

const REQUESTED_PAGE_SIZE = 500;
// One page at a time per account with a pause: a7 throttles the whole account
// (key reveal, pins) when one endpoint is hammered.
const PAGE_PAUSE_MS = 1500;
// 429 backs off 5, 10, 20, 40, 80 s (or Retry-After) before a page is given up.
const FETCH_OPTS = { timeoutMs: 30_000, retry: 5, retryDelayMs: 5000 };

type LogPage = {
  success: boolean;
  message?: string;
  data?: { items?: UpstreamLogRow[]; data?: UpstreamLogRow[]; total?: number };
};

const pageItems = (d: LogPage): UpstreamLogRow[] =>
  (d.data?.items ?? d.data?.data ?? []).map(compactUpstreamRow);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchUpstreamConsumeLogs(
  ctx: ClientContext,
  window: { start: number; end: number },
  onPage?: (
    rows: UpstreamLogRow[],
    coveredFrom: number | null,
  ) => Promise<void>,
): Promise<{
  status: SourceStatus;
  rows: UpstreamLogRow[];
  incomplete: boolean;
  // Start of the contiguous covered span ending at window.end; null when the
  // partial walk cannot be trusted as contiguous.
  coveredFrom: number | null;
}> {
  const url = (page: number, size: number) =>
    `${ctx.baseUrl}/api/log/self?p=${page}&page_size=${size}&type=2&start_timestamp=${window.start}&end_timestamp=${window.end}`;
  const first = await fetchJsonResult<LogPage>(url(1, REQUESTED_PAGE_SIZE), {
    headers: ctx.headers,
    ...FETCH_OPTS,
  });
  if (!first.ok)
    return {
      status: {
        status: "unavailable",
        httpStatus: first.status,
        error: first.message,
      },
      rows: [],
      incomplete: true,
      coveredFrom: null,
    };
  if (!first.data.success)
    return {
      status: {
        status: "unavailable",
        error: first.data.message ?? "success=false",
      },
      rows: [],
      incomplete: true,
      coveredFrom: null,
    };
  const byId = new Map<number, UpstreamLogRow>();
  const firstItems = pageItems(first.data);
  for (const r of firstItems) byId.set(r.id, r);
  const total = first.data.data?.total ?? firstItems.length;
  // Pages come newest first, so after every page the span from the oldest
  // fetched row to the window end is contiguous and can be checkpointed.
  const newestFirst =
    firstItems.length > 1 &&
    (firstItems[0]?.created_at ?? 0) >= (firstItems.at(-1)?.created_at ?? 0);
  let oldest = Infinity;
  const progress = async (items: UpstreamLogRow[], done: boolean) => {
    for (const r of items) oldest = Math.min(oldest, r.created_at);
    if (!onPage) return;
    const from = done ? window.start : newestFirst ? oldest : null;
    await onPage(items, Number.isFinite(from) ? from : null);
  };
  // The server clamps page_size silently; the first page tells the real size.
  const size = firstItems.length;
  const pages = size > 0 ? Math.ceil(total / size) : 1;
  await progress(firstItems, pages <= 1);
  if (size > 0 && total > size) {
    for (let p = 2; p <= pages; p++) {
      throwIfRunAborted();
      await sleep(PAGE_PAUSE_MS);
      const res = await fetchJsonResult<LogPage>(url(p, size), {
        headers: ctx.headers,
        ...FETCH_OPTS,
      });
      if (!res.ok || !res.data.success) {
        consola.warn(
          t("CLI.RECONCILE.UPSTREAM_PAGE_FAILED", {
            name: ctx.name,
            page: p,
            error: res.ok ? (res.data.message ?? "") : res.message,
          }),
        );
        break;
      }
      const items = pageItems(res.data);
      for (const r of items) byId.set(r.id, r);
      if (items.length === 0) break;
      await progress(items, p === pages);
    }
  }
  const rows = [...byId.values()].filter((r) => r.type === 2);
  const incomplete = byId.size < total;
  const coveredFrom =
    !incomplete || rows.length === 0
      ? window.start
      : newestFirst && Number.isFinite(oldest)
        ? oldest
        : null;
  return { status: { status: "ok" }, rows, incomplete, coveredFrom };
}

export async function fetchUpstreamTokens(
  ctx: ClientContext,
): Promise<{ status: SourceStatus; tokens: UpstreamToken[] }> {
  try {
    return { status: { status: "ok" }, tokens: await listTokens(ctx) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = /\b(401|403|404|429|5\d\d)\b/.exec(message)?.[1];
    return {
      status: {
        status: "unavailable",
        httpStatus: code ? Number(code) : undefined,
        error: message,
      },
      tokens: [],
    };
  }
}
