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
  path?: string;
  submitTimeoutMs?: number;
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
}

const SUCCEEDED = new Set(["success", "succeeded", "completed", "complete"]);
const FAILED = new Set(["failure", "failed", "cancelled", "canceled", "error"]);
const errMsg = (err: unknown) =>
  err instanceof Error ? err.message : String(err);
const tryJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};
const headersToRecord = (h: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of h.entries()) out[k] = v;
  return out;
};

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
  if (built?.extraHeaders) Object.assign(headers, built.extraHeaders);

  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  const submitCtrl = new AbortController();
  const submitTimer = setTimeout(
    () => submitCtrl.abort(),
    opts.submitTimeoutMs ?? 60_000,
  );

  let submitResp: Response | undefined,
    submitText = "",
    submitErr: string | undefined;
  try {
    submitResp = await fetch(submitUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(submitBody),
      signal: submitCtrl.signal,
    });
    submitText = await submitResp.text();
  } catch (err) {
    submitErr = errMsg(err);
  } finally {
    clearTimeout(submitTimer);
  }

  const submitStatus = submitResp?.status;
  const submitHeaders = submitResp ? headersToRecord(submitResp.headers) : {};
  const sanitizedSubmit: Record<string, unknown> = built
    ? (built.bodyMeta as Record<string, unknown>)
    : {
        ...submitBody,
        images: (submitBody.images as string[]).map(
          () => "[DATA_URI_REDACTED]",
        ),
      };

  const submitJson = tryJson(submitText);
  const failSubmit = (
    error: string | undefined,
    response: unknown,
    errorClass: ProbeAttempt["errorClass"],
  ): ProbeAttempt => ({
    status: "fail",
    exchange: {
      pass: false,
      request: { url: submitUrl, headers, body: sanitizedSubmit },
      response,
      responseHeaders: submitHeaders,
      error,
      status: submitStatus,
      latencyMs: elapsed(),
    },
    errorClass,
  });
  if (submitStatus === undefined || submitStatus >= 400) {
    return failSubmit(
      submitErr,
      submitJson,
      classifyResponse(submitStatus, submitText).errorClass,
    );
  }

  const taskId = extractTaskId(submitJson);
  if (!taskId)
    return failSubmit("submit-2xx-but-no-task-id", submitJson, "unknown");

  const pollUrl = buildPollUrl(submitUrl, taskId);
  const pollDeadline = Date.now() + (opts.pollTimeoutMs ?? 600_000);
  const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
  let lastPollStatus: number | undefined,
    lastPollHeaders: Record<string, string> = {};
  let lastPollBody: unknown = null,
    pollErr: string | undefined;
  const pollHistory: Array<{
    at: string;
    httpStatus: number | undefined;
    taskStatus: string | undefined;
    body: unknown;
  }> = [];

  const buildExchange = (
    pass: boolean,
    extra: Partial<TestExchange> = {},
  ): TestExchange => ({
    pass,
    request: {
      url: submitUrl,
      headers,
      body: { submit: sanitizedSubmit, pollUrl, pollIntervalMs },
    },
    response: { submit: submitJson, poll: lastPollBody, pollHistory, taskId },
    responseHeaders: {
      submit: submitHeaders,
      poll: lastPollHeaders,
    } as unknown as Record<string, string>,
    status: lastPollStatus,
    latencyMs: elapsed(),
    ...extra,
  });

  while (Date.now() < pollDeadline) {
    await new Promise<void>((r) => setTimeout(r, pollIntervalMs));
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
      lastPollHeaders = headersToRecord(r.headers);
      lastPollBody = tryJson(text);
      const status = extractTaskStatus(lastPollBody);
      pollHistory.push({
        at: new Date().toISOString(),
        httpStatus: lastPollStatus,
        taskStatus: status,
        body: lastPollBody,
      });
      if (status === "succeeded")
        return { status: "ok", exchange: buildExchange(true), taskId };
      if (status === "failed") {
        return {
          status: "fail",
          exchange: buildExchange(false, { error: `task ${status}` }),
          errorClass: "task_failed",
          taskId,
        };
      }
    } catch (err) {
      pollErr = errMsg(err);
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

  return {
    status: "fail",
    exchange: buildExchange(false, {
      error: pollErr ?? "poll-deadline-exceeded",
    }),
    errorClass: "timeout",
    taskId,
  };
}

function extractTaskId(submitJson: unknown): string | undefined {
  if (!submitJson || typeof submitJson !== "object") return undefined;
  const o = submitJson as Record<string, unknown>;
  if (typeof o.id === "string") return o.id;
  if (typeof o.task_id === "string") return o.task_id;
  if (typeof o.result === "string" && o.result.length > 0) {
    const code = typeof o.code === "number" ? o.code : undefined;
    if (code === undefined || code === 1) return o.result;
  }
  const data = o.data as Record<string, unknown> | undefined;
  if (typeof data?.id === "string") return data.id;
  if (typeof data?.task_id === "string") return data.task_id;
  return undefined;
}

function buildPollUrl(submitUrl: string, taskId: string): string {
  const encoded = encodeURIComponent(taskId);
  if (/\/mj\/submit\/[^/]+$/.test(submitUrl))
    return submitUrl.replace(
      /\/mj\/submit\/[^/]+$/,
      `/mj/task/${encoded}/fetch`,
    );
  if (
    submitUrl.includes("/replicate/v1/") &&
    submitUrl.endsWith("/predictions")
  )
    return submitUrl.replace(
      /\/replicate\/v1\/.*\/predictions$/,
      `/replicate/v1/predictions/${encoded}`,
    );
  return `${submitUrl}/${encoded}`;
}

function extractTaskStatus(pollJson: unknown): string | undefined {
  if (!pollJson || typeof pollJson !== "object") return undefined;
  const o = pollJson as Record<string, unknown>;
  const data = o.data as Record<string, unknown> | undefined;
  const raw =
    typeof o.status === "string"
      ? o.status
      : typeof data?.status === "string"
        ? data.status
        : undefined;
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  if (SUCCEEDED.has(lower)) return "succeeded";
  if (FAILED.has(lower)) return "failed";
  return lower;
}
