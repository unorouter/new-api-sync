# CLAUDE.md

Reconciler. It discovers what each upstream provider serves, probes every model live, prices it under
a hard retail cap, then makes a [new-api](https://github.com/QuantumNous/new-api) gateway's
channels, models and options match. Partial runs never touch out-of-scope state.

Bun + TypeScript (strict, never `npm`/`node`), Elysia + Eden treaty, React 19 + TanStack Query +
Zustand + Tailwind v4 + shadcn, TypeBox schemas in `src/core/validations/`.

## Commands

```bash
bun sync run [--only p1,p2] [--models "claude-*"] [--type text] [--dry-run] [--verbose]
bun sync metadata [--dry-run]     # re-seed metadata + re-price, no probes
bun sync reset                    # delete all synced data
bun sync balance [--json]
bun sync reconcile [--only p] [--since 24h | --from 2026-08-26 --to now] [--json]   # upstream usage logs vs our logs, exit 1 on unaccounted usage
bun sync fingerprints [--model glob] [--json]   # answer fingerprint ledger summary
bun sync grade                    # lane grader, one tick
bun sync lane-report [--day 2026-10-11] [--live] [--json]
bun sync catalog [--only p1,p2] [--models "<glob>"] [--out f] [--json]   # read only, upstream listing vs what we publish
bun sync baseline [--out f.json]  # dump voted canonical list prices
bun sync ui --port 3000           # dashboard (alias: bun ui)
bun run dev | typecheck | build | prettier
```

`config.yml` (gitignored) plus optional `config.global.yml`. Only `config.example.yml` is committed.
`--only` and `--models` intersect.

## Layout

```
src/build.ts              compiles 6 binaries; embedded-assets.ts is GENERATED (empty = dev)
src/core/sync/            run, diff, apply, reset, metadata, option-store, pipeline/, reconcile/, catalog/
src/core/pricing/         compute, vote, resolver, emit, sources/, tiered-expr
src/core/vendors/         protocol adaptors only; every OpenAI-compatible upstream is
                          `type: openai-compatible` in config.yml (shared/generic-discovery.ts)
src/core/testing/         runner, authenticity, request-configs, verdict-cache, answer-fingerprints
src/core/quality/         lane grader
src/core/catalog/ infra/  name norm + fuzzy metadata; abort, concurrency, http, lock, retry, lane-keys
src/server/ src/web/      Elysia routes + SSE; React app (lib/rpc.ts, lib/react-query/keys.ts)
```

Aliases `@core/*`, `@server/*`, `@web/*`. No relative imports across packages.

## Pipeline (`src/core/sync/run.ts`)

snapshot -> discover + probe per provider -> canonical price by vote (`pricing/vote.ts`) ->
`computePricedPlan` / `emitChannels` / `buildDesiredModels` / `buildOptionMaps` -> diff -> apply.

`metadata` runs the pipeline dry over providers with `metadataReprice` and rewrites metadata and
price maps for names the target already publishes. It exits 1 (alert `NewApiSyncJobFailed`) when the
flush healed an entry or an enabled model has no price.

### Fixing a bad channel

Never a full `sync run` for one model. `DELETE FROM channels WHERE id IN (...)` on the CNPG primary
(`kubectl -n databases get cluster newapi-pg -o jsonpath='{.status.currentPrimary}'`), restart
`deploy/new-api-master` (channel cache), delete the pair from `logs/verdict-cache.json` (keys
`a7:<merchant>|<model>` or `<provider>|<model>`, or wait for its TTL), then
`bun sync run --only <p> --models "<glob>"`. A channel that comes back passed authenticity. Fix
`testing/authenticity.ts` (or the maker table in `ai-model-verifier`).

### Invariants

- Partial mode (`--only` or `--models`) preserves out-of-scope ratios (`mergeProtected`). A managed
  model leaves the guard only when the run prices it.
- Every option-map write goes through `OptionStore` (`OptionStore.load` / `setEntries` / `flush`), never
  `client.updateOption`. Option maps have no lock, so write only while no sync Job is active. `settle`
  heals any enabled model or carried group that would lose its price or group entries, then exits 1.
- Group options merge additively. The only remover is `OptionStore.pruneGroups`. It drops a
  usable/auto entry only when no channel of any status carries it and never touches GroupRatio.
- `buildSurvivingGroups` re-asserts every group with a `status === 1` channel already in `UserUsableGroups`.
- `cleanupEmptyGroupTokens` runs only without `--models`/`--type`. A filtered run would delete keys
  out-of-scope channels still use.
- Cap is `modelRatio * candidate <= (canonical ?? ratio)` (`compute.ts`), no knob.
- `applyPriceAdjustment(cost, adj, ceiling)` (`pricing/index.ts`) is the only markup. No path-local `(1 + adj)`.
- Margin floor (`enforceMargin`, `marginFloor`). A paid lane of a provider with `costFactor` (real USD
  per upstream-labelled USD) sells at `max(price, cost * costFactor * minMargin)`, `minMargin` default
  `MIN_MARGIN` 2. Above list the lane is dropped (`below-min-margin`) unless `marginAboveList`. An
  unknown cost drops the lane. Without `costFactor` a provider is unfloored until global
  `requireCostFactor` is on. `marginExempt` providers (a7, ih, si) use `profitMultiple`.
- Fixed-price models use `cost = groupRatio * (relayModelPrice / sticker)` per lane. A flat base sold
  image models below cost. Relay prices are yuan labelled USD.
- `ConcurrencyGate.run` takes the per-upstream limit outside the global one. `throwIfRunAborted()`
  in every long loop.

### Sharp edges

- Vote needs >= 2 agreeing sources, else the stored ratio is kept uncapped. A canonical of
  `0`/`undefined` inverts the cap.
- 37.5 / completion 1 is new-api's "no price" pair, mapped to `undefined` by `publishedRatio`.
  Models only a non-newapi provider serves are repriced by `sync run --only <p>`, not `metadata`.
- `CURATED_OVERRIDE` (then config `metadataOverrides`) beats every source. Wrong fuzzy bases
  (`glm-5-turbo` -> `glm-5`) go there. `fuzzyLookup` keeps its exact-match fast path.
- Embeddings force `acceptRateLimited: false`. `fetchPricing` must send `ctx.headers`.
- a7 `minSuccessRate` defaults to 0. a7's own success rate is not trusted, the live probe is the gate.
- a7 listings are fetched one model at a time (`model=<exact name>`). The unfiltered snapshot answers
  200 and stalls mid-stream. A model the marketplace cannot serve this run, or that the walk did not
  reach before `WALK_BUDGET_MS` (150 min), is `unverifiedModels`. The diff keeps its lanes and the
  stale-token cleanup keeps its tokens. Only a run that read no model at all fails with "no listings".
- `sweepLiveLanes` re-runs the price math on every held lane because the gateway re-enables lanes itself.
- A stream probe that reaches EOF after an OpenAI `finish_reason` passes without `data: [DONE]`.
- Vanilla new-api is detected by a 404 on `PUT /api/token/guest-model-limits`
  (`vendors/newapi/context.ts`). Listing, orphan cleanup, guest limits and reseed degrade.
- Token routes are rate limited per account. A 429 arms one cooldown per base url
  (`vendors/newapi/token-throttle.ts`). A walk that lost lanes that way sets `deletesWithheld`, which
  keeps the provider out of the delete set and withholds the stale-token cleanup.

## Conventions

- **Provider-, merchant-, host- or model-specific behaviour lives in config.yml, never in code.** Put it in that
  provider's own block (or a global block when it truly spans providers) and read it through the schema in
  `src/core/validations/config.ts`. No string literal, regex or constant set naming a lane, seller, host or model
  family that changes filtering, pricing, probing, renaming or verdicts. Vendor adaptors implement protocols only.

No prop/hook destructuring, no `useMemo`/`useCallback`, comments only for a non-obvious why, double
quotes + semicolons + `bun run prettier`, `import type`, no barrel files, ASCII punctuation outside
code and Chinese, no AI attribution in git. Strings via `t("SECTION.KEY")` with real translations in
`src/web/public/i18n/{en,zh}.json` and `src/server/i18n.ts`. Query keys from `lib/react-query/keys.ts`.

Release by bumping `version` and merging to `main`, `release.yml` builds. Never ship binaries by hand.
`scripts/`, `reference/`, `config*.yml` are gitignored.

## Cluster

CronJobs in `services` (`k8s/`). A push to `main` builds and pins the image, no local builds.

- `new-api-sync` runs `metadata` every 15 min Berlin except the two hours after each full run.
- `new-api-sync-grader` runs `grade` every 15 min.
- `new-api-sync-full` runs `run --only a7,ih,si` at 04:00, 10:00, 16:00, 22:00, 3h deadline, `backoffLimit: 0`.
- `new-api-sync-weekly` runs the paid non-marketplace providers Wednesdays 01:30 Berlin, 6h deadline.
- `new-api-sync-daily-metadata` runs `metadata` over every non-marketplace provider daily 03:15 Berlin.
- `new-api-sync-openrouter` runs `run --only open1,open2` every 6h from 01:30 Berlin.

Weekly, daily-metadata and openrouter read OpenBao `secret/sync-env-weekly` (local `config.yml` minus a7,
ih, si and excluded providers, plus the cluster's `target`, `verdictStore`, `targetDb`, `laneGrader`,
`authenticityPassTtlHours: 216` per provider, `WEEKLY_ONLY`). A provider added or re-keyed locally is not
covered until that secret is rebuilt. Relay "Test cost" overstates real spend about 7x (yuan labelled dollars).

Cluster config (OpenBao `secret/sync-env` key `config.yml`) declares a7, ih and si only. Mirror every
edit to those blocks and to the shared blocks (`rateLimit`, `modelMapping`, `groupMapping`, `blacklist`,
`modelAlias`, `channelParamOverride`, `dataPolicies`). Payload over stdin, `patch` never `put` (the
secret also holds `GUEST_API_KEY`), read back.

```bash
cd ../infra && BT=$(sops -d secrets/openbao-init.sops.yaml | grep -oP 'root_token:\s*\K\S+')
{ printf '%s\n' "$BT"; cat payload.json; } | kubectl -n openbao exec -i openbao-0 -- \
  sh -c 'read -r BAO_TOKEN && export BAO_TOKEN && bao kv patch -method=rw secret/sync-env -'
kubectl -n services annotate externalsecret sync-env force-sync=$(date +%s) --overwrite
```

The logs PVC is `local-path`, pinned to the node the first job ran on
(`kubectl -n services get pvc new-api-sync-logs -o jsonpath='{.metadata.annotations.volume\.kubernetes\.io/selected-node}'`).
If that node is cordoned or gone the full job stays Pending (uncordon, or delete PVC + PV and re-seed from the local file).

## a7 runs

One a7 run at a time, anywhere, >= 30 min apart. Start local a7 runs at :01 to :13 with no active
`new-api-sync-*` Job. Suspend the metadata cron for a full `--only a7` (~25 min). A throttled full
run deletes lanes it could not key or pin, so kill it before `Providers:`/`Channels:` appear. Run it
detached (`setsid nohup`), the harness kills commands at 10 min.

a7 pins (`vendors/a7/pins.ts`). A reprice pauses the pin, accept via `price-notices/<id>/accept`. A drop
creates no notice and keeps billing the old snapshot, only unpin + pin re-confirms.
`fallback_to_smart_routing` stays false.

## Verdict cache and authenticity

`logs/verdict-cache.json` is the working copy. The shared truth is `new-api-sync/verdict-cache.json` in
bucket `unorouter-sync` (`verdictStore`, cluster `https://s3.unorouter.com`, local
`https://s3.unorouter.com:19443` via the `tsh-s3` user unit plus a `/etc/hosts` line). Every `sync run`
merges it in at start and pushes at end. Without `verdictStore` the sync is local only. Every write saves
the local file at once, so a killed run keeps what it probed.

TTLs. Functional pass 7 days, functional fail 24h (2h on 429, 5xx or timeout). Authenticity pass 12h
(`authenticityPassTtlHours` overrides, a7 uses 4). Pass lifetimes of 24h or more stretch with `passStreak`
up to 720h. Authenticity fails start at 24h, double per failed retest and become permanent at the third
(`authFailStrikes`). Unblock by deleting the key from the cache.

The `metadata` cron re-probes stale live lanes of an a7 block with `reverify` (`vendors/a7/reverify.ts`)
and disables the channel on a fail. The Job dies at 20 minutes and a killed tick loses its option flush,
which is why reverify starts no lane late in the tick.

Probes are `ai-model-verifier`'s rule engine (`testing/authenticity.ts` is a thin adapter), judged against
the model's maker (`makerForModel`). Only anthropic's findings have authority, except `masked-identity`,
`fake-200`, `substituted` and `served-model-mismatch`, which judge every maker. Everything else is observe
only (`authenticity.observeOnly` per maker or `*`, `[]` promotes a maker) and lands in
`logs/observe-<date>.jsonl` and store `observe/<hour>.jsonl`. That log is what a maker is promoted from.
The functional test checks the reply's model field on both the plain and the stream reply.

Claude's tokenizer fingerprint is the only one with a verdict. A delta that moved since the last probe
voids the cached pass for that run. It names no tier, so it never fails a lane by itself.

Answer fingerprints (`testing/answer-fingerprints.ts`) are notes only, nothing here disables a lane. The
battery runs at most once a day per lane after 4 sampled runs (`answerFingerprintDue`), because running it
every ladder pushed both CronJobs past their deadlines (2026-09-22). The store object (about 18 MB) is
rewritten only by a process that recorded a run.

Lane keys (`infra/lane-keys.ts`). Revealed upstream token secrets are sealed with
`verdictStore.encryptionKey` (same value locally and in the cluster) in `logs/lane-keys/` and the store.
No cipher means no cache and no plain file. The store copy is pushed at most every 10 minutes per provider,
since each store write keeps a noncurrent version. A key is evicted when the gateway auto disabled its
channel with a credential reason (`vendors/newapi/disable-reason.ts`) or an a7 probe answers 401/403 on it.

## Marketplace lanes (ih, si)

`vendors/ih`, `vendors/si`, `vendors/shared/fallback-lanes.ts`. Priced at `profitMultiple` times the most
the spend guard lets a request cost, between `minSellFraction` and `maxSellFraction` of list. Once a lane
has enough billed traffic its ratio comes from real cost (`pricing/realized-marketplace.ts`). Numeric knobs
take a scalar or a glob map with `default` (`resolvePerModel`, first match wins). Every URL is config only.
Probes carry the same bid headers (ih) or seller pin (si) as the lane, so a 402 is the honest fail. The si
`/min{N}` discount floor is capped at 90, since a higher floor refuses small requests. `metadata` never
touches their `param_override` (`MARKETPLACE_KINDS`), because an si pin is a plain `set` the reconcile
would clear.

## Lane grader and reconcile

Lane grader (`src/core/quality/`, config `laneGrader`, needs `targetDb`). It compares each lane's recent
gateway log against other lanes of the same model and quarantines outliers with status 2, never 3, since
the gateway's tester re-enables status 3 on its first pass. `dryRun` is the default. The usage inflation
and padding rules act even under `dryRun` (`inflationLive`), since billed counts no model can produce are
fraud. Nothing is blacklisted automatically.

`reconcile` (`src/core/sync/reconcile/`) joins each relay account's `/api/log/self` to our logs by
`upstream_request_id`, then tokens and time. Every probe records the relay's request id
(`testing/probe-ids.ts`), so probe rows reconcile exactly. Only unexplained rows, foreign tokens with usage,
or an ip outside `targetEgressIps` seen only on unaccounted rows flip the exit code. Source ips need
`record_ip_log` on the relay account (`PUT /api/user/setting`).

## Other lane types

TypeSafe (`vendors/typesafe`) is declarative like runware. One channel of gateway type 1003, no discovery
or probe (`NON_TESTABLE_ENDPOINT_TYPES`). Block prices are sell price per million tokens into
`ModelRatio`/`CompletionRatio`, never a per-call price, since the gateway settles on upstream token counts.

Nothink lanes. A model in `nothinkModels` that the reasoning probe sees answer without reasoning serves as
`<name>-nothink`. Only a cached measurement flips the name. The rename is in place (`planNothinkRenames`),
moving token pins through `PUT /api/token/group-rename`. `selfReferenceAllowed` lets a model's reasoning name
the listed makers without failing `foreign-self-reference`.

## Local runs

`TRUSTED_NETWORKS` is pod CIDR + loopback, so the local target is `http://127.0.0.1:13000` from the
user unit `tsh-newapi` (`kubectl -n services port-forward svc/new-api 13000:3000`, restart after a
tsh re-login). Never add a home prefix to `TRUSTED_NETWORKS`. The public hostname gives 401 plus an
`InvalidCredentialReplayed` alert.
