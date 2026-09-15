# CLAUDE.md

Reconciler: discovers what each upstream provider serves, probes every model live, prices it under
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
```

`reconcile` (`src/core/sync/reconcile/`) pulls every relay account's own `/api/log/self` (100 rows
a page, one page at a time per account, 750 ms apart, 429 backs off up to 80 s; every page is
checkpointed into `logs/reconcile-cache/<provider>.jsonl` and the store object
`reconcile/<provider>.jsonl`, 45 days retained, so a rerun fetches only the tail) and joins each row
to our `logs` table (read-only DSN `targetDb`, bigint columns cast in the query) by
`upstream_request_id` = the relay's `request_id`, on any channel including deleted lanes, then by
tokens and time, then by model and time. Every probe the sync sends records the relay's request id
(`testing/probe-ids.ts`, `logs/probe-ids.jsonl` and store `reconcile/probe-ids.jsonl`), so probe
rows reconcile exactly. Leftover upstream rows are classed abandoned (an error row of ours for the
model within 3 min: the gateway timed out and retried, the relay billed the attempt), probe-shaped,
or unexplained; only unexplained rows, foreign tokens with usage, or a source ip outside
`targetEgressIps` that appears solely on unaccounted rows flip the exit code to 1 (duck logs its
edge proxy ip, so an ip seen on id-matched rows counts as ours). `record_ip_log` is on for the
pol, duck, gg, a7 and trp1 accounts (per-user setting, `PUT /api/user/setting`); fish logs ip and
user agent by itself; cent is banned.

```bash
bun sync baseline [--out f.json]  # dump voted canonical list prices
bun sync ui --port 3000           # dashboard (alias: bun ui)
bun run dev | typecheck | build | prettier
```

`config.yml` (gitignored) plus optional `config.global.yml`; only `config.example.yml` is committed.
`--only` and `--models` intersect.

## Layout

```
src/cli/index.ts          run | reset | metadata | balance | reconcile | ui | baseline
src/build.ts              compiles 6 binaries; embedded-assets.ts is GENERATED (empty = dev)
src/core/sync/            run, diff, apply, reset, metadata, option-store, pipeline/, reconcile/
src/core/pricing/         compute, vote, resolver, emit, sources/, tiered-expr
src/core/vendors/         one dir per provider; newapi is the reference. New free provider =
                          discovery.ts + registry-meta.ts + registry.ts + a config.yml block
src/core/testing/         runner, authenticity, request-configs, verdict-cache
src/core/catalog/ infra/  name norm + fuzzy metadata; abort, concurrency, http, lock, retry
src/server/ src/web/      Elysia routes + SSE; React app (lib/rpc.ts, lib/react-query/keys.ts)
```

Aliases `@core/*`, `@server/*`, `@web/*`; no relative imports across packages.

## Pipeline (`src/core/sync/run.ts`)

snapshot -> discover + probe per provider -> canonical price by vote (`pricing/vote.ts`) ->
`computePricedPlan` / `emitChannels` / `buildDesiredModels` / `buildOptionMaps` -> diff -> apply
(options via one `OptionStore.flush`, channels, models, FixAbility + orphaned-model cleanup, group
prune, guest token, `[pricing-audit]`).

`metadata` runs the pipeline dry over `newapi` and `a7` providers only and rewrites metadata and
the price maps (`ModelRatio`, `CompletionRatio`, `ModelPrice`, `Image*`, `Cache*`, `Audio*`,
`ModelQuotaType`, `ModelGridPricing`, `billing_setting.*`, `GroupRatio`) for names the target
already publishes. Exit 1 (alert `NewApiSyncJobFailed`) when the flush healed an entry or an enabled
model has no price.

### Fixing a bad channel

Never a full `sync run` for one model. `DELETE FROM channels WHERE id IN (...)` on the CNPG primary
(`kubectl -n databases get cluster newapi-pg -o jsonpath='{.status.currentPrimary}'`), restart
`deploy/new-api-master` (channel cache), delete the pair from `logs/verdict-cache.json` (keys
`a7:<merchant>|<model>` or `<provider>|<model>`, or wait for its TTL), then
`bun sync run --only <p> --models "<glob>"`. A channel that comes back passed authenticity: fix
`testing/authenticity.ts`.

### Invariants

- Partial mode (`--only` or `--models`) preserves out-of-scope ratios (`mergeProtected`); a managed
  model leaves the guard only when the run prices it.
- Every option-map write goes through `OptionStore` (`sync/option-store.ts`); `settle` heals any
  enabled model or carried group that would lose its price/group entries, then exits 1.
- Group options merge additively. The only remover is `OptionStore.pruneGroups`: drops a
  usable/auto entry only when no channel of any status carries it, never touches GroupRatio.
- `buildSurvivingGroups` re-asserts every group with a `status === 1` channel that is already in
  `UserUsableGroups`.
- `cleanupEmptyGroupTokens` runs only without `--models`/`--type`: a filtered run would delete keys
  out-of-scope channels still use.
- Cap: `modelRatio * candidate <= (canonical ?? ratio)` (`compute.ts`), no knob.
- `applyPriceAdjustment(cost, adj, ceiling)` (`pricing/index.ts`) is the only markup: adj > 0
  interpolates toward the ceiling (adj=1 -> 1x), cost >= ceiling -> `cost * 1.05`, adj <= 0 ->
  `cost * (1 + adj)`. Bounded `(-1, 1]` by schema. No path-local `(1 + adj)`.
- Fixed-price models: `cost = groupRatio * (relayModelPrice / sticker)` per lane; a flat base sold
  image models below cost. Relay prices are yuan labelled USD.
- `ConcurrencyGate.run` takes the per-upstream limit outside the global one. `throwIfRunAborted()`
  in every long loop.

### Sharp edges

- Vote needs >= 2 agreeing sources, else the stored ratio is kept uncapped; a canonical of
  `0`/`undefined` inverts the cap.
- 37.5 / completion 1 is new-api's "no price" pair, mapped to `undefined` by `publishedRatio`.
  Models only a non-newapi provider serves are repriced by `sync run --only <p>`, not `metadata`.
- `CURATED_OVERRIDE` beats every source; wrong fuzzy bases (`glm-5-turbo` -> `glm-5`) go there.
  `fuzzyLookup` keeps its exact-match fast path (token-set scoring drops repeated digits).
- Embeddings force `acceptRateLimited: false`. `fetchPricing` must send `ctx.headers`.
- a7 `minSuccessRate` defaults to 0: a7's own success rate is not trusted, the live probe is the
  gate, and the candidate walk runs until `hostsPerModel` lanes pass or the price-filtered list ends.
- a7 `minSellFraction` = retail floor (raises the group ratio), `maxSellFraction` = merchant cut,
  default 1 (cost \* profitMultiple <= canonical list; the engine never sells above list anyway);
  `sweepLiveLanes` re-runs the math on every held lane because the gateway re-enables lanes itself.

## Conventions

No prop/hook destructuring, no `useMemo`/`useCallback`, comments only for a non-obvious why, double
quotes + semicolons + `bun run prettier`, `import type`, no barrel files, ASCII punctuation outside
code and Chinese, no AI attribution in git. Strings via `t("SECTION.KEY")` with real translations in
`src/web/public/i18n/{en,zh}.json` and `src/server/i18n.ts`. Query keys from `lib/react-query/keys.ts`.

Release: bump `version`, merge to `main`, `release.yml` builds. Never ship binaries by hand.

## Gotchas

- `scripts/`, `reference/`, `config*.yml` gitignored. Builtin blacklist merges additively.
- Option maps have no lock: write only while no sync Job is active, via
  `OptionStore.load` / `setEntries` / `flush`, never `client.updateOption`.
- Vanilla new-api is detected by a 404 on `PUT /api/token/guest-model-limits`
  (`vendors/newapi/context.ts`); listing, orphan cleanup, guest limits and reseed degrade.

## Cluster

Two CronJobs in `services` (`k8s/`; a push to `main` builds the image in GitHub Actions and pins it, no local builds):
`new-api-sync` = `metadata` every 15 min Berlin except the two hours after each full run;
`new-api-sync-full` = `run --only a7` at 04:00, 10:00, 16:00 and 22:00, 2h deadline, `backoffLimit: 0`,
the only job that probes.

Cluster config (OpenBao `secret/sync-env` key `config.yml`) declares a7, fish, open1 only; local
`bun sync metadata` covers the rest. Mirror every edit to those blocks and to the shared blocks
(`rateLimit`, `modelMapping`, `groupMapping`, `blacklist`, `modelAlias`, `channelParamOverride`).
Payload over stdin, `patch` never `put` (the secret also holds `GUEST_API_KEY`), read back:

```bash
cd ../infra && BT=$(sops -d secrets/openbao-init.sops.yaml | grep -oP 'root_token:\s*\K\S+')
{ printf '%s\n' "$BT"; cat payload.json; } | kubectl -n openbao exec -i openbao-0 -- \
  sh -c 'read -r BAO_TOKEN && export BAO_TOKEN && bao kv patch -method=rw secret/sync-env -'
kubectl -n services annotate externalsecret sync-env force-sync=$(date +%s) --overwrite
```

Verdict cache: `logs/verdict-cache.json` is the working copy on every machine; the shared truth
is the object `new-api-sync/verdict-cache.json` in bucket `unorouter-sync` behind the S3 gateway
(`verdictStore` in config.yml; cluster config points at `https://s3.unorouter.com`, local at
`https://s3.unorouter.com:19443` through the `tsh-s3` user unit plus a `/etc/hosts` line). Every
`sync run` merges the object in at start and pushes at end (union by key, newest stamp wins, a fail
survives while it is fresh); artifacts mirror to `artifacts/`. Functional passes expire after 7 days (jittered
2), functional fails after 24 hours, or 2 hours when the fail was a 429, 5xx or timeout (a dead merchant is re-probed once a day, not once a run),
authenticity passes after 12 hours (`authenticityPassTtlHours` per provider overrides it, a7 uses 4 so every 6-hourly walk re-probes), authenticity fails after 24 hours (one probe then decides again), and the `metadata` cron re-probes live a7 Claude lanes whose
pass is stale (`vendors/a7/reverify.ts`, disables the channel on a fail). Every authenticity
outcome is appended to `verdict-history.jsonl` beside the cache. Every Claude probe also measures
the verifier's tokenizer fingerprint (input-token delta for a fixed text, `tokenizerDelta` on the
entry): a delta that moved since the last probe voids the cached pass for that run. It names no tier
(4.6-era models share a tokenizer, relays count differently), so it never fails a lane by itself. Without `verdictStore` the sync is local-only.
Every verdict write saves the local file at once and pushes the store at most every 2 minutes, so a
run killed at any point (Job deadline, OOM, Ctrl-C) keeps everything it probed: the next run loads the
local file (the PVC on the cluster) before merging the store.

Lane keys (`infra/lane-keys.ts`): every revealed upstream token secret is kept sealed with the
store cipher (`verdictStore.encryptionKey`, same value locally and in the cluster) in
`logs/lane-keys/<provider>.json.enc` and the store object `lane-keys/<provider>.json.enc`, keyed
by token id, so `ensureLaneTokens` and `ensureTokens` reveal only ids they do not hold. Load is
local then store; push is read-merge-write with eviction tombstones. A key is evicted on two
signals: a live channel the gateway auto disabled with a credential reason (`other_info.status_reason`
`status_code=401`/`403` or a7's `账号或令牌状态不允许`, `vendors/newapi/disable-reason.ts`), and an a7
probe answering 401/403 on a cached key (the fail verdict is cleared, the lane re-revealed and
re-probed once). Each provider logs `keys: N cached, N revealed, N evicted (probe), N evicted
(gateway), N rejected` and carries the same on its report. No cipher means no cache and no plain file.

The PVC is `local-path`, pinned to whichever Talos node the first job ran on (`kubectl -n services get pvc new-api-sync-logs -o jsonpath='{.metadata.annotations.volume\.kubernetes\.io/selected-node}'`): if that node is cordoned or gone the full job stays
Pending (uncordon, or delete PVC + PV and re-seed from the local file).

Token routes are rate limited per account, so a 429 on create or reveal arms one cooldown per base
url (`vendors/newapi/token-throttle.ts`, 60 s or the `Retry-After`): every later call in that window
returns empty at once instead of walking its own retry ladder, and the lanes it skipped are keyed on
a later round or the next run. A walk that lost lanes that way sets `deletesWithheld` on its report,
which keeps the provider out of the delete set and withholds the stale-token cleanup exactly as a
failed report did; the run itself stays green unless more than a fifth of the lanes were lost.

One a7 run at a time, anywhere, >= 30 min apart. Start local a7 runs at :01 to :13 with no active
`new-api-sync-*` Job; suspend the metadata cron for a full `--only a7` (~25 min). A throttled full
run deletes lanes it could not key or pin: kill it before `Providers:`/`Channels:` appear. Run it
detached (`setsid nohup`), the harness kills commands at 10 min.

a7 pins (`vendors/a7/pins.ts`): a reprice pauses the pin, accept via
`price-notices/<id>/accept`; a drop creates no notice and keeps billing the old snapshot, only
unpin + pin re-confirms; `fallback_to_smart_routing` stays false.

## Local runs

`TRUSTED_NETWORKS` is pod CIDR + loopback, so the local target is `http://127.0.0.1:13000` from the
user unit `tsh-newapi` (`kubectl -n services port-forward svc/new-api 13000:3000`; restart after a
tsh re-login). Never add a home prefix to `TRUSTED_NETWORKS`; the public hostname gives 401 plus an
`InvalidCredentialReplayed` alert.
