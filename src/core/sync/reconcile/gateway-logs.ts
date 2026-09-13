import { SQL } from "bun";
import { t } from "@server/i18n";
import type { GatewayLogRow } from "./types";

// Widened on both sides: the upstream stamps completion time, we stamp ours,
// and a retried request lands its consume row later than the upstream's.
export const WINDOW_SLACK_SECONDS = 600;
const ID_CHUNK = 2000;

export async function fetchGatewayLogs(
  url: string,
  window: { start: number; end: number },
  channelIds: number[],
): Promise<GatewayLogRow[]> {
  if (channelIds.length === 0) return [];
  const sql = new SQL(url, { max: 2, connectionTimeout: 15, idleTimeout: 30 });
  try {
    // bigint columns arrive as strings; cast so the matcher compares numbers.
    const rows: GatewayLogRow[] = await sql`
      SELECT id::int, type::int, created_at::int, model_name,
             quota::float8, prompt_tokens::int, completion_tokens::int,
             channel_id::int, token_name, request_id, upstream_request_id
      FROM logs
      WHERE type IN (2, 5)
        AND created_at BETWEEN ${window.start - WINDOW_SLACK_SECONDS}
                           AND ${window.end + WINDOW_SLACK_SECONDS}
        AND channel_id IN ${sql(channelIds)}
      ORDER BY created_at`;
    return rows;
  } catch (err) {
    throw new Error(
      t("ERROR.RECONCILE_DB_FAILED", {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  } finally {
    await sql.close();
  }
}

// Rows keyed by the upstream's request id, whatever channel they sit on: a
// lane deleted since the request still has its log row.
export async function fetchGatewayLogsByUpstreamIds(
  url: string,
  ids: string[],
): Promise<GatewayLogRow[]> {
  if (ids.length === 0) return [];
  const sql = new SQL(url, { max: 1, connectionTimeout: 15, idleTimeout: 30 });
  const out: GatewayLogRow[] = [];
  try {
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const chunk = ids.slice(i, i + ID_CHUNK);
      const rows: GatewayLogRow[] = await sql`
        SELECT id::int, type::int, created_at::int, model_name,
               quota::float8, prompt_tokens::int, completion_tokens::int,
               channel_id::int, token_name, request_id, upstream_request_id
        FROM logs
        WHERE upstream_request_id IN ${sql(chunk)}`;
      out.push(...rows);
    }
    return out;
  } catch (err) {
    throw new Error(
      t("ERROR.RECONCILE_DB_FAILED", {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  } finally {
    await sql.close();
  }
}

// Error rows on every channel: an attempt the gateway abandoned and retried
// elsewhere leaves its error row wherever the retry chain started.
export async function fetchGatewayErrorRows(
  url: string,
  window: { start: number; end: number },
): Promise<GatewayLogRow[]> {
  const sql = new SQL(url, { max: 1, connectionTimeout: 15, idleTimeout: 30 });
  try {
    const rows: GatewayLogRow[] = await sql`
      SELECT id::int, type::int, created_at::int, model_name,
             quota::float8, prompt_tokens::int, completion_tokens::int,
             channel_id::int, token_name, request_id, upstream_request_id
      FROM logs
      WHERE type = 5
        AND created_at BETWEEN ${window.start - WINDOW_SLACK_SECONDS}
                           AND ${window.end + WINDOW_SLACK_SECONDS}`;
    return rows;
  } catch (err) {
    throw new Error(
      t("ERROR.RECONCILE_DB_FAILED", {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  } finally {
    await sql.close();
  }
}
