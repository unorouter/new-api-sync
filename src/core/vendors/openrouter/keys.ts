import { fetchJson, fetchJsonResult } from "@core/infra/http";
import { throwIfRunAborted } from "@core/infra/abort";
import { consola } from "consola";
import pLimit from "p-limit";

// One OpenRouter key per published model, each pinned by a guardrail to that
// model alone and capped per day. A single shared key across every channel means
// one leak spends the whole account on anything OpenRouter sells; that is how
// $708 left in a day against ~$10 of our own traffic. The cap bounds the loss,
// the allowlist bounds what the loss can even buy.
//
// Management keys are a separate credential class: they administer keys and
// guardrails and cannot call completion endpoints, so holding one in the sync
// does not widen what a sync compromise could spend.

const PROVISION_CONCURRENCY = 4;

interface RemoteKey {
  name?: string;
  hash?: string;
  limit?: number | null;
  disabled?: boolean;
}

interface Guardrail {
  id?: string;
  name?: string;
}

export interface ProvisionedKeys {
  /** published model name -> the secret to put on that model's channels */
  keyByModel: Map<string, string>;
  minted: number;
  reused: number;
}

/**
 * Reads the per-model secrets back out of the live channel rows, which is where
 * they live between runs. `shared` is the provider's bootstrap key: a channel
 * still carrying it has not been migrated, so it is reported as having no key
 * and gets one minted. Both the published name and its bare form are indexed
 * because callers look up by exposed name while channels store `x:free`.
 */
export function liveKeysByModel(
  channels: { tag?: string; models: string; key?: string }[] | undefined,
  providerTag: string,
  shared: string,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const ch of channels ?? []) {
    if (ch.tag !== providerTag || !ch.key || ch.key === shared) continue;
    for (const model of ch.models.split(",")) {
      const name = model.trim();
      if (!name) continue;
      out.set(name, ch.key);
      const bare = name.replace(/:free$/, "");
      if (!out.has(bare)) out.set(bare, ch.key);
    }
  }
  return out;
}

const api = (baseUrl: string, path: string) =>
  `${baseUrl.replace(/\/$/, "")}${path}`;

const auth = (managementKey: string) => ({
  Authorization: `Bearer ${managementKey}`,
});

// Names are the join between our channels and OpenRouter's key list, so they
// must be stable across runs and readable in their dashboard.
const keyName = (provider: string, model: string) => `${provider}/${model}`;

async function listRemote<T>(
  baseUrl: string,
  managementKey: string,
  path: string,
): Promise<T[]> {
  const body = await fetchJson<{ data?: T[] }>(api(baseUrl, path), {
    headers: auth(managementKey),
    timeoutMs: 30_000,
    retry: 3,
    retryDelayMs: 2000,
  });
  return body?.data ?? [];
}

/**
 * Mints or reuses one capped key per model and pins each to its own guardrail.
 *
 * Reuse is what keeps this idempotent: `normalizeChannel` compares `key`, so a
 * freshly minted secret every run would rewrite every channel row every run.
 * OpenRouter returns a key's secret only once at creation, so the live channel
 * rows are the store: a model whose key already exists upstream AND whose
 * channels already carry a non-bootstrap secret keeps that secret untouched.
 */
export async function ensureProvisionedKeys(args: {
  baseUrl: string;
  managementKey: string;
  provider: string;
  models: string[];
  /** published model -> secret currently on that model's live channels */
  existingKeyByModel: Map<string, string>;
  /** published model -> OpenRouter permaslug, for the guardrail allowlist */
  permaslugByModel: Map<string, string>;
  dailyLimitUsd: number;
  expiryDays: number;
}): Promise<ProvisionedKeys> {
  const remoteKeys = await listRemote<RemoteKey>(
    args.baseUrl,
    args.managementKey,
    "/v1/keys",
  );
  const guardrails = await listRemote<Guardrail>(
    args.baseUrl,
    args.managementKey,
    "/v1/guardrails",
  );
  const remoteByName = new Map(
    remoteKeys.filter((k) => k.name).map((k) => [k.name as string, k]),
  );
  const guardrailByName = new Map(
    guardrails.filter((g) => g.name).map((g) => [g.name as string, g]),
  );

  const keyByModel = new Map<string, string>();
  const limit = pLimit(PROVISION_CONCURRENCY);
  let minted = 0;
  let reused = 0;

  await Promise.all(
    args.models.map((model) =>
      limit(async () => {
        throwIfRunAborted();
        const name = keyName(args.provider, model);
        const remote = remoteByName.get(name);
        const held = args.existingKeyByModel.get(model);

        if (remote && held) {
          keyByModel.set(model, held);
          reused++;
          if (remote.limit !== args.dailyLimitUsd && remote.hash) {
            await fetchJsonResult(
              api(args.baseUrl, `/v1/keys/${remote.hash}`),
              {
                method: "PATCH",
                headers: auth(args.managementKey),
                body: { limit: args.dailyLimitUsd, limit_reset: "daily" },
                retry: 2,
                retryDelayMs: 2000,
              },
            );
          }
          return;
        }

        // A key exists upstream but its secret is lost to us, so it can never be
        // put on a channel again. Remove it rather than leaking an orphan that
        // still carries spend authority.
        if (remote?.hash) {
          await fetchJsonResult(api(args.baseUrl, `/v1/keys/${remote.hash}`), {
            method: "DELETE",
            headers: auth(args.managementKey),
            retry: 2,
            retryDelayMs: 2000,
          });
        }

        const created = await fetchJson<{ key?: string; data?: RemoteKey }>(
          api(args.baseUrl, "/v1/keys"),
          {
            method: "POST",
            headers: auth(args.managementKey),
            body: {
              name,
              limit: args.dailyLimitUsd,
              limit_reset: "daily",
              include_byok_in_limit: true,
              expires_at: new Date(
                Date.now() + args.expiryDays * 86_400_000,
              ).toISOString(),
            },
            retry: 3,
            retryDelayMs: 2000,
          },
        );
        if (!created?.key) {
          throw new Error(
            `openrouter: key create returned no secret for ${name}`,
          );
        }
        keyByModel.set(model, created.key);
        minted++;

        await ensureGuardrail({
          baseUrl: args.baseUrl,
          managementKey: args.managementKey,
          name,
          permaslug: args.permaslugByModel.get(model),
          dailyLimitUsd: args.dailyLimitUsd,
          existing: guardrailByName.get(name),
          keyHash: created.data?.hash,
        });
      }),
    ),
  );

  consola.info(
    `[${args.provider}] keys: ${minted} minted, ${reused} reused, $${args.dailyLimitUsd}/day each`,
  );
  return { keyByModel, minted, reused };
}

// A guardrail holds the model allowlist; OpenRouter allows at most one per key,
// so the guardrail is 1:1 with the key and shares its name. Without a permaslug
// we would create an allow-everything guardrail, which is worse than none: skip.
async function ensureGuardrail(args: {
  baseUrl: string;
  managementKey: string;
  name: string;
  permaslug?: string;
  dailyLimitUsd: number;
  existing?: Guardrail;
  keyHash?: string;
}): Promise<void> {
  if (!args.permaslug) {
    consola.warn(
      `[openrouter] no permaslug for ${args.name}, key left without a model allowlist`,
    );
    return;
  }
  let id = args.existing?.id;
  if (!id) {
    const created = await fetchJson<{ data?: { id?: string } }>(
      api(args.baseUrl, "/v1/guardrails"),
      {
        method: "POST",
        headers: auth(args.managementKey),
        body: {
          name: args.name,
          allowed_models: [args.permaslug],
          limit_usd: args.dailyLimitUsd,
          reset_interval: "daily",
        },
        retry: 3,
        retryDelayMs: 2000,
      },
    );
    id = created?.data?.id;
  }
  if (!id || !args.keyHash) return;
  await fetchJsonResult(
    api(args.baseUrl, `/v1/guardrails/${id}/assignments/keys`),
    {
      method: "POST",
      headers: auth(args.managementKey),
      body: { key_hashes: [args.keyHash] },
      retry: 2,
      retryDelayMs: 2000,
    },
  );
}
