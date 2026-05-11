import type { TestExchange } from "@core/testing/types";
import { buildBody } from "./body-builder";
import { classifyResponse } from "./classify";
import type { Fixtures } from "./fixtures";
import type { ProbeAttempt } from "./probe-sync";

export interface TaskProbeOpts {
  baseUrl: string;
  apiKey: string;
  userId: number;
  model: string;
  fixtures: Fixtures;
  /** Override the submit URL path. When omitted, defaults to /v1/videos.
   *  Used for Replicate-routed image tasks
   *  (`/replicate/v1/models/{model}/predictions`) and other
   *  provider-declared task paths. */
  path?: string;
  /** Submit timeout, default 60s. */
  submitTimeoutMs?: number;
  /** Total poll budget, default 10 minutes. */
  pollTimeoutMs?: number;
  /** Poll interval, default 5s. */
  pollIntervalMs?: number;
}

/** Submit + poll. Submits 6 refs even though most upstreams cap at 1-2 — the rejection reason is informative. */
export async function probeTaskChannel(
  opts: TaskProbeOpts,
): Promise<ProbeAttempt> {
  const submitUrl =
    opts.baseUrl.replace(/\/$/, "") + (opts.path ?? "/v1/videos");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.apiKey}`,
    "Content-Type": "application/json",
    "New-Api-User": String(opts.userId),
  };

  // buildBody dispatches per-path; OAI-Videos default falls through when no vendor match.
  const built = opts.path
    ? buildBody({ path: opts.path, model: opts.model, fixtures: opts.fixtures })
    : null;
  const submitBody: Record<string, unknown> = built
    ? (built.body as Record<string, unknown>)
    : {
        model: opts.model,
        prompt: opts.fixtures.prompt,
        images: opts.fixtures.dataUris,
      };
  if (built?.extraHeaders) {
    for (const [k, v] of Object.entries(built.extraHeaders)) headers[k] = v;
  }

  // ─── submit ───
  const start = performance.now();
  const submitCtrl = new AbortController();
  const submitTimer = setTimeout(
    () => submitCtrl.abort(),
    opts.submitTimeoutMs ?? 60_000,
  );

  let submitResp: Response | undefined;
  let submitText = "";
  let submitErr: string | undefined;
  try {
    submitResp = await fetch(submitUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(submitBody),
      signal: submitCtrl.signal,
    });
    submitText = await submitResp.text();
  } catch (err) {
    submitErr = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(submitTimer);
  }

  const submitStatus = submitResp?.status;
  const submitHeaders: Record<string, string> = {};
  if (submitResp) {
    for (const [k, v] of submitResp.headers.entries()) submitHeaders[k] = v;
  }

  // Vendor bodies already provide redacted bodyMeta; OAI-Videos strips data URIs inline.
  const sanitizedSubmit: Record<string, unknown> = built
    ? (built.bodyMeta as Record<string, unknown>)
    : {
        ...submitBody,
        images: (submitBody.images as string[]).map(
          () => "[DATA_URI_REDACTED]",
        ),
      };

  // No task id on submit failure.
  if (submitStatus === undefined || submitStatus >= 400) {
    const cls = classifyResponse(submitStatus, submitText);
    const exchange: TestExchange = {
      pass: false,
      request: { url: submitUrl, headers, body: sanitizedSubmit },
      response: tryJson(submitText),
      responseHeaders: submitHeaders,
      error: submitErr,
      status: submitStatus,
      latencyMs: Math.round(performance.now() - start),
    };
    return { status: "fail", exchange, errorClass: cls.errorClass };
  }

  const submitJson = tryJson(submitText);
  const taskId = extractTaskId(submitJson);
  if (!taskId) {
    const exchange: TestExchange = {
      pass: false,
      request: { url: submitUrl, headers, body: sanitizedSubmit },
      response: submitJson,
      responseHeaders: submitHeaders,
      error: "submit-2xx-but-no-task-id",
      status: submitStatus,
      latencyMs: Math.round(performance.now() - start),
    };
    return { status: "fail", exchange, errorClass: "unknown" };
  }

  // ─── poll ───
  // Poll URL varies: MJ → /mj/task/{id}/fetch, Replicate → /replicate/v1/predictions/{id}, OAI Videos appends.
  const pollUrl = buildPollUrl(submitUrl, taskId);
  const pollDeadline = Date.now() + (opts.pollTimeoutMs ?? 600_000);
  const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
  let lastPollStatus: number | undefined;
  let lastPollHeaders: Record<string, string> = {};
  let lastPollBody: unknown = null;
  let pollErr: string | undefined;

  // History of every poll attempt for the artifact (status transitions, progress %).
  interface PollSample {
    at: string;
    httpStatus: number | undefined;
    taskStatus: string | undefined;
    body: unknown;
  }
  const pollHistory: PollSample[] = [];

  while (Date.now() < pollDeadline) {
    await sleep(pollIntervalMs);
    const pollCtrl = new AbortController();
    const pollTimer = setTimeout(() => pollCtrl.abort(), 30_000);
    try {
      const r = await fetch(pollUrl, {
        method: "GET",
        headers,
        signal: pollCtrl.signal,
      });
      const text = await r.text();
      lastPollStatus = r.status;
      lastPollHeaders = {};
      for (const [k, v] of r.headers.entries()) lastPollHeaders[k] = v;
      lastPollBody = tryJson(text);

      const status = extractTaskStatus(lastPollBody);
      pollHistory.push({
        at: new Date().toISOString(),
        httpStatus: lastPollStatus,
        taskStatus: status,
        body: lastPollBody,
      });
      if (status === "succeeded") {
        const exchange: TestExchange = {
          pass: true,
          request: {
            url: submitUrl,
            headers,
            body: { submit: sanitizedSubmit, pollUrl, pollIntervalMs },
          },
          response: {
            submit: submitJson,
            poll: lastPollBody,
            pollHistory,
            taskId,
          },
          responseHeaders: {
            submit: submitHeaders,
            poll: lastPollHeaders,
          } as unknown as Record<string, string>,
          status: lastPollStatus,
          latencyMs: Math.round(performance.now() - start),
        };
        return { status: "ok", exchange, taskId };
      }
      if (status === "failed") {
        const exchange: TestExchange = {
          pass: false,
          request: {
            url: submitUrl,
            headers,
            body: { submit: sanitizedSubmit, pollUrl, pollIntervalMs },
          },
          response: {
            submit: submitJson,
            poll: lastPollBody,
            pollHistory,
            taskId,
          },
          responseHeaders: {
            submit: submitHeaders,
            poll: lastPollHeaders,
          } as unknown as Record<string, string>,
          status: lastPollStatus,
          latencyMs: Math.round(performance.now() - start),
          error: `task ${status}`,
        };
        return { status: "fail", exchange, errorClass: "task_failed", taskId };
      }
      // else still pending / running — loop.
    } catch (err) {
      pollErr = err instanceof Error ? err.message : String(err);
      pollHistory.push({
        at: new Date().toISOString(),
        httpStatus: undefined,
        taskStatus: undefined,
        body: { error: pollErr },
      });
    } finally {
      clearTimeout(pollTimer);
    }
  }

  // budget exhausted
  const exchange: TestExchange = {
    pass: false,
    request: {
      url: submitUrl,
      headers,
      body: { submit: sanitizedSubmit, pollUrl, pollIntervalMs },
    },
    response: {
      submit: submitJson,
      poll: lastPollBody,
      pollHistory,
      taskId,
    },
    responseHeaders: {
      submit: submitHeaders,
      poll: lastPollHeaders,
    } as unknown as Record<string, string>,
    status: lastPollStatus,
    latencyMs: Math.round(performance.now() - start),
    error: pollErr ?? "poll-deadline-exceeded",
  };
  return { status: "fail", exchange, errorClass: "timeout", taskId };
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function extractTaskId(submitJson: unknown): string | undefined {
  if (submitJson && typeof submitJson === "object") {
    const o = submitJson as Record<string, unknown>;
    // OAI-Videos / Suno: {id} or {task_id}
    if (typeof o.id === "string") return o.id;
    if (typeof o.task_id === "string") return o.task_id;
    // MJ: {code:1, result:"<task_id>"}. Other codes are error envelopes — don't extract.
    if (typeof o.result === "string" && o.result.length > 0) {
      const code = typeof o.code === "number" ? o.code : undefined;
      if (code === undefined || code === 1) return o.result;
    }
    // wrapped: {data: {id|task_id}}
    const data = o.data as Record<string, unknown> | undefined;
    if (data) {
      if (typeof data.id === "string") return data.id;
      if (typeof data.task_id === "string") return data.task_id;
    }
  }
  return undefined;
}

/** MJ /mj/submit/X → /mj/task/<id>/fetch. Replicate /predictions → /replicate/v1/predictions/<id>. Default: append. */
function buildPollUrl(submitUrl: string, taskId: string): string {
  const encoded = encodeURIComponent(taskId);
  if (/\/mj\/submit\/[^/]+$/.test(submitUrl)) {
    return submitUrl.replace(
      /\/mj\/submit\/[^/]+$/,
      `/mj/task/${encoded}/fetch`,
    );
  }
  if (
    submitUrl.includes("/replicate/v1/") &&
    submitUrl.endsWith("/predictions")
  ) {
    return submitUrl.replace(
      /\/replicate\/v1\/.*\/predictions$/,
      `/replicate/v1/predictions/${encoded}`,
    );
  }
  return `${submitUrl}/${encoded}`;
}

function extractTaskStatus(pollJson: unknown): string | undefined {
  if (pollJson && typeof pollJson === "object") {
    const o = pollJson as Record<string, unknown>;
    if (typeof o.status === "string") return normalizeTaskStatus(o.status);
    const data = o.data as Record<string, unknown> | undefined;
    if (data && typeof data.status === "string")
      return normalizeTaskStatus(data.status);
  }
  return undefined;
}

/** Collapse to {succeeded|failed|<pending>}. Non-terminal strings keep polling. */
function normalizeTaskStatus(raw: string): string {
  const lower = raw.toLowerCase();
  if (
    lower === "success" ||
    lower === "succeeded" ||
    lower === "completed" ||
    lower === "complete"
  ) {
    return "succeeded";
  }
  if (
    lower === "failure" ||
    lower === "failed" ||
    lower === "cancelled" ||
    lower === "canceled" ||
    lower === "error"
  ) {
    return "failed";
  }
  return lower;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
