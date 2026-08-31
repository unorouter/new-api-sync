/**
 * Observe-mode evidence collection for Claude lanes.
 *
 * Runs the new verify-core detectors (thinking signature, token accounting) and
 * only WRITES DOWN what they saw. Nothing here can fail a lane, blacklist a
 * merchant, or change a verdict: a false positive in a fresh detector would
 * delete lanes that are serving real traffic, so the numbers get reviewed
 * before they get authority.
 *
 * Findings land in logs/observe-<date>.jsonl, one line per lane.
 */

import { checkThinkingSignature } from "@unorouter/verify-core/detectors/thinking-signature";
import { checkTokenTruth } from "@unorouter/verify-core/detectors/token-truth";
import { logsDir } from "@core/infra/paths";
import { consola } from "consola";
import { appendFileSync } from "fs";
import { join } from "path";

/** Bridges verify-core's injected transport onto plain fetch. */
const transport = async (args: {
  url: string;
  headers: Record<string, string>;
  reqBody: unknown;
  timeoutMs: number;
}) => {
  try {
    const res = await fetch(args.url, {
      method: "POST",
      headers: args.headers,
      body: JSON.stringify(args.reqBody),
      signal: AbortSignal.timeout(args.timeoutMs),
    });
    return {
      status: res.status,
      data: await res.json().catch(() => null),
      error: null,
      corsBlocked: false,
    };
  } catch (err) {
    return {
      status: null,
      data: null,
      error: err instanceof Error ? err.message : String(err),
      corsBlocked: false,
    };
  }
};

export async function observeClaudeEvidence(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  label: string;
}): Promise<void> {
  try {
    const [signature, tokens] = await Promise.all([
      checkThinkingSignature({ transport, ...opts }),
      checkTokenTruth({ transport, ...opts }),
    ]);

    // Only two states are worth a human's attention: thinking was requested and
    // no block came back, or the token arithmetic did not add up. An unsigned
    // block is expected whenever the lane crosses an OpenAI-shaped hop.
    const notable =
      signature.state === "no-thinking" || tokens.ok === false
        ? "WOULD-FLAG"
        : null;

    appendFileSync(
      join(logsDir(), `observe-${new Date().toISOString().slice(0, 10)}.jsonl`),
      JSON.stringify({
        at: new Date().toISOString(),
        lane: opts.label,
        model: opts.model,
        notable,
        signature,
        tokens,
      }) + "\n",
    );

    if (notable)
      consola.info(
        `[observe] ${opts.label}: ${notable} (signature=${signature.state}, tokens=${
          tokens.checks
            .filter((c) => !c.pass)
            .map((c) => c.id)
            .join(",") || "ok"
        })`,
      );
  } catch (err) {
    // Observation must never disturb a sync run.
    consola.debug(
      `[observe] ${opts.label} skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
