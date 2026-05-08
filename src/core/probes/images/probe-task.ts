import type { TestExchange } from "@core/testing/types";
import { classifyResponse } from "./classify";
import type { Fixtures } from "./fixtures";
import type { ProbeAttempt } from "./probe-sync";

export interface TaskProbeOpts {
  baseUrl: string;
  apiKey: string;
  userId: number;
  channelId: number;
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

/**
 * Probe a model exposed on the OpenAI Videos task surface (`openai-video`).
 * Submit `POST /v1/videos` with 6 reference images as data URIs and the
 * shared prompt; poll `GET /v1/videos/{id}` until terminal status.
 *
 * Most upstream task models accept far fewer than 6 references (kling i2v
 * = 1, vidu i2v = 1, vidu reference2video = up to 7). We submit 6 anyway
 * and let the upstream complain — recording the rejection reason is
 * informative.
 *
 * Pass criteria: terminal status `completed` / `succeeded` within the poll
 * budget. Submit-time 4xx is an immediate fail with classified error.
 */
export async function probeTaskChannel(
  opts: TaskProbeOpts,
): Promise<ProbeAttempt> {
  const submitUrl = opts.baseUrl.replace(/\/$/, "") + (opts.path ?? "/v1/videos");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.apiKey}`,
    "Content-Type": "application/json",
    "New-Api-User": String(opts.userId),
  };
  if (opts.channelId > 0) {
    headers["Specify-Channel"] = String(opts.channelId);
  }

  const submitBody = {
    model: opts.model,
    prompt: opts.fixtures.prompt,
    images: opts.fixtures.dataUris,
  };

  // ---- submit ----
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

  // Sanitize the submit body for the artifact (data URIs are huge).
  const sanitizedSubmit = {
    ...submitBody,
    images: submitBody.images.map(() => "[DATA_URI_REDACTED]"),
  };

  // Submit failed before we got a task id.
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

  // ---- poll ----
  const pollUrl = `${submitUrl}/${encodeURIComponent(taskId)}`;
  const pollDeadline = Date.now() + (opts.pollTimeoutMs ?? 600_000);
  const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
  let lastPollStatus: number | undefined;
  let lastPollHeaders: Record<string, string> = {};
  let lastPollBody: unknown = null;
  let pollErr: string | undefined;

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
      if (status === "succeeded" || status === "completed" || status === "success") {
        const exchange: TestExchange = {
          pass: true,
          request: { url: submitUrl, headers, body: sanitizedSubmit },
          response: { submit: submitJson, poll: lastPollBody, taskId },
          responseHeaders: { submit: submitHeaders, poll: lastPollHeaders } as unknown as Record<string, string>,
          status: lastPollStatus,
          latencyMs: Math.round(performance.now() - start),
        };
        return { status: "ok", exchange, taskId };
      }
      if (status === "failed" || status === "cancelled" || status === "error") {
        const exchange: TestExchange = {
          pass: false,
          request: { url: submitUrl, headers, body: sanitizedSubmit },
          response: { submit: submitJson, poll: lastPollBody, taskId },
          responseHeaders: { submit: submitHeaders, poll: lastPollHeaders } as unknown as Record<string, string>,
          status: lastPollStatus,
          latencyMs: Math.round(performance.now() - start),
          error: `task ${status}`,
        };
        return { status: "fail", exchange, errorClass: "task_failed", taskId };
      }
      // else still pending / running — loop.
    } catch (err) {
      pollErr = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(pollTimer);
    }
  }

  // Poll budget exhausted.
  const exchange: TestExchange = {
    pass: false,
    request: { url: submitUrl, headers, body: sanitizedSubmit },
    response: { submit: submitJson, lastPoll: lastPollBody, taskId },
    responseHeaders: { submit: submitHeaders, poll: lastPollHeaders } as unknown as Record<string, string>,
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
    if (typeof o.id === "string") return o.id;
    if (typeof o.task_id === "string") return o.task_id;
    const data = o.data as Record<string, unknown> | undefined;
    if (data) {
      if (typeof data.id === "string") return data.id;
      if (typeof data.task_id === "string") return data.task_id;
    }
  }
  return undefined;
}

function extractTaskStatus(pollJson: unknown): string | undefined {
  if (pollJson && typeof pollJson === "object") {
    const o = pollJson as Record<string, unknown>;
    if (typeof o.status === "string") return o.status.toLowerCase();
    const data = o.data as Record<string, unknown> | undefined;
    if (data && typeof data.status === "string") return data.status.toLowerCase();
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
