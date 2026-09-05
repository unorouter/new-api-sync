# CLAUDE.md

Guidance for working in **new-api-sync**. Read this before touching code.

## What this is

Declarative reconciliation tool that syncs AI model pricing, channels, and models from upstream
providers into a target [new-api](https://github.com/QuantumNous/new-api) gateway. It discovers what
each upstream serves, verifies every model with live API probes, computes profitable retail pricing
against multi-source canonical data, then makes the target's channels/models/options exactly match a
computed desired state (create/update/delete). Ships a Commander CLI and a bundled Elysia + React
dashboard, all compiled into one native binary per platform.

It is NOT "copy config". It is a four-way reconciler: test before exposing, price under a hard cap,
organize into per-tier channels, and support partial syncs that never clobber out-of-scope state.

## Stack

- Runtime: **Bun** + TypeScript (ESNext, strict, `noUncheckedIndexedAccess`). Use `bun`, never `npm`/`node`.
- Server: **Elysia** + Eden treaty (end-to-end typed RPC, no codegen).
- Frontend: **React 19** + TanStack Query + Zustand + Tailwind v4 + shadcn (`base-vega`, zinc, lucide).
- Validation: **TypeBox** schemas in `src/core/validations/`, shared server <-> web via Eden.
- Key deps: consola (logging, bridged to SSE), p-limit (concurrency), ofetch (HTTP), micromatch
  (globs), yaml (comment-preserving Document tree), commander.

## Commands

```bash
bun install
bun sync run                              # full sync
bun sync run --only <p1,p2>               # sync only named providers (partial)
bun sync run --models "claude-*,gpt-4*"   # sync only matching models (partial)
bun sync run --verbose                    # debug logging
bun sync metadata                         # re-seed model metadata + re-price WITHOUT probes/tests
bun sync reset                            # delete all synced data
bun sync images                           # image-gen probe pipeline (--dry-run, --step)
bun sync ui --port 3000                   # web dashboard (alias: bun ui)
bun run dev                               # watch-mode server, serves frontend from disk
bun run typecheck                         # tsc, run before committing
bun run build                             # typecheck + frontend + 6 native binaries
bun run prettier                          # format
```

Config lives in `config.yml` (gitignored, holds secrets) + optional `config.global.yml`
(cross-config: locale/theme/shared blacklist/shared modelMapping/shared groupMapping). Named variants are
`config.<name>.yml`. Only `config.example.yml` is committed.

## Layout

```
src/
  cli/index.ts            Commander entry, 4 commands (run|reset|images|ui)
  build.ts                single-file-binary build, generates embedded-assets.ts
  embedded-assets.ts      GENERATED. base64-inlined frontend. empty in dev, populated in prod build
  core/                   provider-agnostic engine
    config.ts             config load/merge, ENV expansion, builtin blacklist
    sync/                 orchestration: run, diff, apply, reset, pipeline/
    pricing/              the economic core: compute, vote, resolver, sources/, tiered-expr
    vendors/              per-provider adapters: newapi (reference), a7api, openrouter, nvidia, comfyui,
                          shared/openai-free-provider (keyless/free OpenAI-compat providers), plus
                          per-provider discovery dirs (blockrun, freeai, bleak, longcat, publicai, voyage,
                          sealion, llmgateway). New free provider = discovery.ts + registry-meta.ts
                          (SIMPLE_PROVIDER_META) + registry.ts (DISCOVERERS) + a config.yml block.
    testing/              model probes: runner, authenticity, request-configs, redact
    probes/images/        image-gen discovery + probe pipeline
    catalog/              bare-name norm, vendor-matchers, filter, metadata, constants/
    infra/                abort, concurrency, fs, http, retry, paths
    validations/          TypeBox schemas (shared with web via Eden)
  server/                 Elysia app: route.ts + config/health/history/pipeline routes, sse.ts, i18n.ts
  web/                    React app: app.tsx, lib/rpc.ts, lib/react-query/keys.ts, store/, hooks/, components/
```

Path aliases (use these, never relative cross-package imports): `@core/*`, `@server/*`, `@web/*`.

## How the sync works (read before editing the pipeline)

`runSync` in `src/core/sync/run.ts` is the 6-step spine:

1. **Health + snapshot** current channels/models/vendors/options into a `TargetSnapshot`.
2. **Discover + test** per provider in TYPE_ORDER (newapi, nvidia, openrouter, a7api). Each
   processor returns `UpstreamOffer[]`.
3. **Canonical retail** resolved by VOTE across pricing sources (`pricing/vote.ts`).
4. **Price + emit**: `computePricedPlan` (pricing/compute.ts) builds tiers under the cap, `emitChannels`
   makes channels, `buildDesiredModels` + `buildOptionMaps` make the rest. Result: `DesiredState`.
5. **Diff** desired vs snapshot into create/update/delete ops (`sync/diff.ts`).
6. **Apply + cleanup**: options (one `OptionStore.flush`) -> channels -> models -> always-on janitor
   (new-api FixAbility rebuilds the abilities table from channels, healing enabled-drift and orphans
   from out-of-band edits; then orphaned-model cleanup deletes model rows with no ability at all -
   disabled abilities count as bound, so it is partial-safe) -> group prune (second flush) -> guest
   token -> the `[pricing]` audit block -> logs.

Each upstream model flows: provider row -> `OfferModel{exposed, upstream, upstreamRatio}` -> canonical
vote -> `MergedModel` + `PricedTier` -> `Channel` (with `model_mapping: {exposed -> upstream}`) ->
option maps -> `DiffOperation` -> POST to new-api. `exposed` is the published name, `upstream` is what
gets forwarded.

### `bun sync metadata` (no-probe re-seed + re-price)

`metadata` runs `runProviderPipeline({dryRun:true})` over ONLY the `newapi` and `a7api` providers (the
others run live probes even under dryRun), then writes a SUBSET of options merge-preserving everything else: it
re-seeds model metadata (context/release/series/tags via `curated.ts` + `CURATED_OVERRIDE` + fuzzy
sources) AND re-prices the option maps `ModelRatio`/`CompletionRatio`/`ModelPrice`/`ImageRatio`/
`Cache*`/`Audio*`/`ModelQuotaType`/`ModelGridPricing`/`billing_setting.*` AND `GroupRatio` (the last is
keyed by channel-group, not model name, so it is merged separately at the end of `syncUpstreamPricing`).
It does NO live probes, NO channel create/delete, NO token creation. Use it to apply pricing-engine
changes (e.g. the per-request group-ratio formula) WITHOUT a full `sync run`. It only touches names the
current target channels already publish (in-scope), so out-of-scope/paid-elsewhere entries stay intact.
All option edits accumulate in one `OptionStore` and land in a single flush at the end; the run exits 1
(and the cluster Job fails, alert `NewApiSyncJobFailed`) when that flush healed an entry or a model on an
enabled channel carries no price. Read the `[pricing]` block at the end of the log.

### Fixing a bad/fake channel: delete in DB, then re-sync with precision

When a specific channel-model is broken (fake/substituted model, CJK gibberish, dead upstream), do
NOT `bun sync run` the whole catalog. Surgically remove the bad rows from the target DB, then
re-discover + re-test ONLY the affected providers and models. The combined scope keeps the run small
and the partial-sync invariants protect everything out of scope.

1. **Identify** the bad channel(s) and model(s) in the target DB (`channels` table: `id`, `name`,
   `base_url`, `models`). Confirm the upstream actually still serves a clean alternative first
   (query each provider's `/api/pricing_new` then `/api/pricing` for the model name; see
   `vendors/newapi/pricing.ts`).
2. **Delete the bad channels in the DB by id** (they are recreated only if a provider still passes
   testing for that model). The target gateway DB is the CloudNativePG `newapi` cluster on the k3s
   cluster (namespace `databases`, db `newapi`); reach it via kubectl, not don SSH
   (`KUBECONFIG=infra/kubeconfig`; the primary drifts on failover and replicas are
   read-only, so resolve it from the cluster status instead of assuming `-pg-1`):
   ```bash
   PG=$(kubectl -n databases get cluster newapi-pg -o jsonpath='{.status.currentPrimary}')
   kubectl -n databases exec $PG -c postgres -- \
     psql -U postgres -d newapi -c "DELETE FROM channels WHERE id IN (5487,5488,...);"
   ```
   Direct DB deletes bypass the in-memory channel cache; the runtime may keep serving the old
   channel until the next sync reload or a `kubectl -n services rollout restart deploy/new-api-master`.
3. **Clear stale verdicts** for the affected provider+model keys in `logs/verdict-cache.json`
   (back it up first). This is the UNIVERSAL permanent verdict file: one entry per
   `provider|model` pair holding http/stream/tool verdicts AND claude authenticity. Verdicts
   have NO TTL; a pair with a recorded pass is never re-probed until its entry is deleted. A
   cached `success`/`authenticity: "pass"` skips re-probe and would let a known fake through; a
   cached `authenticity: "fail"` blacklists a real channel and stops it being recreated. Delete
   the whole entry so the next run re-probes fresh. Key shape:
   `provider/channel-name/anthropic|model-name`.
4. **Re-sync with both filters ANDed** so only the targeted providers AND models are touched:

   ```bash
   bun sync run --only code,pol,aigc --models "claude-opus-4-6*,claude-opus-4-7*,claude-opus-4-8*"
   ```

   - `--only <csv>` narrows to those provider NAMES (`applyOnlyProviders`); `--models <globs>` narrows
     to matching model names (`applyModelFilter`, micromatch). They COMBINE (intersection): only those
     providers, only those models. Both accept repeats or comma-separated lists.
   - This sets `isPartialSync` -> out-of-scope ratios are preserved (`mergeProtected`), so the run
     never clobbers other providers/models. A clean provider that passes testing for the model is
     recreated as a channel; a failing one stays absent.

5. **Verify**: re-query the `channels` table for the model; confirm only clean upstreams remain and
   the bad ids did not reappear. If a deleted channel reappears, its provider still passed the
   authenticity test (the fix belongs in `testing/authenticity.ts`, not another delete).

Rule of thumb: DB delete = remove the bad runtime row now; `--only` + `--models` = re-test and
recreate with precision; never a full `sync run` to fix one model.

### Invariants that MUST hold (do not break these)

- **Partial syncs never clobber.** `isPartialSync = onlyProviders || modelFilter.length > 0`. In
  partial mode, out-of-scope MODEL ratios are preserved (`mergeProtected` + modelGuard). A
  `--only openrouter` run must not touch other providers' pricing. Any pipeline change must keep
  this true. A managed model leaves the guard ONLY when the run prices it: stripping every
  model a managed provider serves let a `--only <provider>` run whose in-scope lanes all failed the
  live probe erase the sticker while another provider's lanes kept serving it, and the gateway then
  answered "not priced by the administrator" (41 models, 2026-09-05). Independently, EVERY option-map
  write goes through `OptionStore` (`sync/option-store.ts`) and its `settle` invariant: a model on an
  enabled channel keeps at least one of ModelRatio / ModelPrice / billing_expr, and a group any
  channel carries keeps its GroupRatio / UserUsableGroups / AutoGroups entries. An endangered entry is
  HEALED (copied forward from the loaded value, `[option-store] healed ...`), the rest of the write
  lands, and the run exits 1 so the cluster Job fails and alerts. Six incidents since June each
  unpriced live models through a different path; the store is the one write they all share.
  `reset` passes because it deletes the channels first. The apply-phase janitor (FixAbility + orphaned-model cleanup) runs on EVERY sync
  because it is partial-safe by construction: abilities rebuild from whatever channels exist, and a
  model row only counts as orphaned with zero ability rows (disabled ones from rate-limited-preserved
  channels count as bound - requires new-api >= a0f589a1).
- **Group options (GroupRatio/UserUsableGroups/AutoGroups) are ADDITIVE in the diff.** Desired
  entries add/update; the merge NEVER removes existing entries. A run only computes tiers for models
  that passed ITS OWN probe, so removal-by-omission deleted the group entries of every live channel
  whose model merely throttled during that run's probe (free tiers throttle constantly) - the
  recurring "channel live but model invisible/unroutable" incident (gemini groups, di1, 149 free
  groups, 20 paid groups all hit this). The ONLY removal authority is `OptionStore.pruneGroups`
  (called from apply.ts): full post-apply channel list, protects the run's own diff groups, removes a
  usable/auto entry only when NO channel of any status carries the group. GroupRatio is never
  pruned at all (subscription tiers bill through it). Do not reintroduce a group guard in the merge.
  The prune also logs the group NAMES it removed, not just a count - a bare count left the
  sail-research incident undiagnosable.
- **A published group with an ENABLED channel is re-asserted every run** (`buildSurvivingGroups` ->
  `buildOptionMaps`). Additive-merge alone was not enough: the entries only ever came from THIS run's
  offers, so an upstream blip (an OpenRouter host dipping under `MIN_HOST_UPTIME_PCT`, a free tier
  throttling mid-probe) dropped the group from the run's maps, the prune then deleted it, and nothing
  restored it when the upstream recovered - removal was one-way. Live incident: `sail-research`, the
  CHEAPEST glm-5.2 host, sat enabled+priced but invisible for two days. Recovery is deliberately
  narrower than the prune: it needs `status === 1` (never resurrects a disabled lane) and only
  re-publishes groups ALREADY in `UserUsableGroups` (never publishes a private or brand-new group).
- **Upstream token deletion only on FULL provider runs.** `cleanupEmptyGroupTokens` deletes a
  provider's `<group>-<prefix>` token when the group produced zero working offers - under a
  `--models`/`--type` filter that conflates "dead group" with "group's models were filtered out",
  and the deleted key 401-kills every out-of-scope channel still carrying it (live incident: a
  mimo-only fishx run deleted china-prod/default-prod, auto-disabling all 30 glm/kimi/deepseek
  lanes). The call is gated on `!modelFilter && !modelTypeFilter`; keep it that way.
- **Pricing cap is hard.** No offer may charge more than 1x canonical retail. The cap is
  `modelRatio * candidate <= (canonical ?? ratio)` in `compute.ts`. There is no user knob to relax it.
- **priceAdjustment has ONE universal rule**: `applyPriceAdjustment(cost, adj, ceiling)` in
  `pricing/index.ts`, used by EVERY pricing decision (compute.ts standard/no-upstream paths, the
  newapi pre-test gate). Positive adj = position between cost and the canonical ceiling
  (`retail = cost + (ceiling - cost) * adj`; adj=1 -> exactly 1x). Cap-safe by construction: raising
  adj approaches 1x, it never drops the lane. Cost at/above ceiling -> `cost * 1.05` (the only case
  above 1x). adj <= 0 = plain multiplier `cost * (1 + adj)` (yuan convention). Never reintroduce a
  path-local `(1 + adj)` markup: markup semantics made higher adj DROP lanes as cap-exceeded while
  capAbove1x reinterpreted the same knob as interpolation (the di1/GLM-5.2 incident).
- **priceAdjustment is schema-bounded** to `(-1, 1]` in `validations/config.ts`. Keep the schema bound.
- **Per-request (fixed-price) group ratio tracks actual upstream cost.** Per-token models bake margin
  into `ModelRatio`, so a negative `priceAdjustment` still clears cost. Per-request (`quotaType >= 1`,
  flat `ModelPrice`) has NO ratio markup: the flat price IS the cost. In `compute.ts` `processStandardOffer`
  the fixed branch feeds `cost = offer.groupRatio * (relayModelPrice / sticker)` into
  `applyPriceAdjustment`, so each channel prices off ITS OWN upstream cost. The sticker (`ModelPrice`
  option) is the cheapest relay's price; pricier relays get a proportionally higher group ratio so they
  don't bill the cheap relay's sticker. Do NOT collapse this back to a flat `base` for fixed-price (that
  was the bug that sold image models 5-17x below cost). Note: upstream relay prices are denominated in
  yuan but their APIs label the field as USD; the yuan->USD gap is the real retail margin, so a -0.75
  adjustment on the yuan-number is still profitable in USD.
- **Concurrency inversion is deliberate.** `ConcurrencyGate.run(key, fn)` acquires the per-upstream
  limit OUTSIDE the global limit so one slow upstream cannot starve the global pool
  (`infra/concurrency.ts`). Do not reorder.
- **Abort is per-run** via `AsyncLocalStorage<AbortSignal>` (`infra/abort.ts`) so concurrent SSE
  clients stay isolated. Long loops call `throwIfRunAborted()` at checkpoints; keep adding these to
  new loops.

### Known sharp edges (don't "fix" without understanding)

- Canonical voting is consensus-or-nothing: needs a cluster of >= 2 agreeing sources, else no canonical
  and the stored new-api ratio is kept (no cap, no strikethrough). Two equal-size clusters tie by
  iteration order (no explicit tie-break yet).
- A canonical of `0` or `undefined` neuters or inverts the cap (`canonical ?? ratio`). Watch sources
  that can return zero/null ratios.
- Unparseable tiered billing expressions fall back to a raw placeholder (~37.5) and silently drop the
  model. Surface a warning rather than dropping silently if you touch `tiered-expr.ts`.
- **Curated metadata is two-tier** (`pricing/sources/curated.ts`): `CURATED` is a low-priority pricing
  SOURCE that VOTES with the others (can be outvoted / fuzzy-matched to a base model). `CURATED_OVERRIDE`
  is a HARD override applied last in `resolver.ts`, winning over every source. Obscure variants that other
  sources fuzzy-match to the wrong base (e.g. `glm-5-turbo` -> `glm-5`, `glm-4.7-flash` -> `glm-4.7`) must
  go in `CURATED_OVERRIDE`, not `CURATED`, or the bad fuzzy match overstates context/series.
- **Fuzzy-match repeated-digit collapse** (`catalog/metadata.ts`): similarity uses token SETS, so a name
  like `gpt-5.5` has its two `5`s dedupe in the Set, dropping Dice below the 0.75 threshold. The
  `fuzzyLookup` stripped-variant loop has an exact-equality fast path returning score 1.0 BEFORE the
  similarity gate; keep it. `STRIPPABLE_SUFFIXES` includes `-search*` so search variants resolve to their
  base price.
- **Embeddings reject rate-limited probes** (`shared/openai-free-provider.ts`): a model with
  `modelType === "embedding"` forces `acceptRateLimited: false` so a 429 during testing does NOT add a
  flaky embedding channel. Other modalities honor the provider's `acceptRateLimited`.
- **37.5 is new-api's "no price" answer, never a price.** `GetModelRatio` returns 37.5 /
  completion 1 for any model it holds no ratio for, and relays publish the same pair for models
  they list but do not price (gg: 100+ rows). The parser maps that pair to `ratio: undefined`
  (`publishedRatio` in `vendors/newapi/pricing.ts`), the pre-test gate drops a paid lane with no
  upstream price instead of pricing it at 1, and `mirrorAliasRatio` only defers to an alias that
  has its own offer this run. Before this, one placeholder in ModelRatio was re-asserted by every
  run (safety-net restore + alias mirror) and sold at $75/M until repriced by hand; a model that
  only a non-newapi provider serves (open1) is never repriced by `metadata`, so run
  `sync run --only open1` to reprice those.
- **a7 `minSellFraction` is a retail FLOOR, `maxSellFraction` a merchant CUT.** Both are
  per-model maps (first glob wins) as fractions of the voted canonical list (output $/M). The
  ceiling rejects a merchant whose cost x profitMultiple would sell above list x maxSellFraction.
  The floor keeps the merchant and raises the lane's group ratio so it sells at list x
  minSellFraction when cost x profitMultiple would land below it (`buildLaneOffer` in
  `vendors/a7api/provider.ts`, logged as `[a7] floor ...`). Ceiling wins if they overlap.
  Every run also SWEEPS every a7 lane the target holds, any status, through the same math
  (`sweepLiveLanes`): the gateway re-enables a disabled lane on its own retest, and a7 DELISTS
  merchants while their pins keep serving, so a lane can come back live at the ratio it was
  created with. A lane whose merchant is no longer listed is held at the floor until the full
  run culls it (live incident: opus-5 via delisted merchant 3973 re-enabled at 0.17% of list).
- **`fetchPricing` passes auth headers** (`vendors/newapi/pricing.ts`): some relays (e.g. zetatechs)
  gate `/api/pricing` behind the system token. Always send `ctx.headers`; an authless fetch silently
  drops those providers from discovery.

## Conventions (match the existing code)

- **No destructuring** of React props, variables, or hook returns (unless spreading or setting
  defaults).
- **No `useMemo`/`useCallback`** (React 19). The codebase has zero; keep it that way.
- **No bloated comments.** Comment only non-obvious _why_, one terse line. No restating code, no
  multi-line explainers. Prefer zero comments. (Module-level docblocks in `scripts/` and pipeline
  entry files are the existing exception.)
- **Double quotes, semicolons.** Prettier with `prettier-plugin-tailwindcss`. Run `bun run prettier`.
- **Imports via path aliases** (`@core`/`@server`/`@web`), never relative across packages. Use
  `import type` for type-only imports (`verbatimModuleSyntax` is on).
- **No barrel re-export files** when splitting modules. Move the symbol, then update every importer.
  No `index.ts` that only re-exports siblings.

### Frontend specifics

- **All user-facing strings go through i18n.** Use full translation keys via `t("SECTION.KEY")`.
  When adding a key, add a real native translation to BOTH locale files in `src/web/public/i18n/`
  (`en.json` and `zh.json`) plus the server catalogs (`src/server/i18n.ts`,
  `src/web/lib/constants.ts`). No English placeholders in `zh.json`. Chinese strings use full-width
  punctuation (`：`, `，`, `。`), never ASCII.
- **React Query cache ops go through `src/web/lib/react-query/keys.ts`.** Never raw string arrays in
  `useQuery`/`useMutation`/`setQueryData`/`invalidateQueries`.
- The frontend talks to the server via the Eden client in `src/web/lib/rpc.ts`. Responses are typed
  from `App = typeof app` but NOT runtime-validated client-side; a server shape change can surface as
  a runtime undefined.

## Build & release

`bun run build` (`src/build.ts`): typecheck -> Tailwind frontend -> `writeAssetManifest()` base64-inlines
every frontend file + `config.example.yml` into `embedded-assets.ts` -> JS bundle -> `bun build
--compile` for 6 targets (linux/darwin/windows x64+arm64) -> resets the manifest to an empty stub.
**Empty `embeddedAssets` = dev (serve from disk via `@elysiajs/static`); populated = prod (serve from
binary).**

Release is automated: bump `version` in `package.json`, merge to `main`, and
`.github/workflows/release.yml` builds all artifacts and cuts the GitHub release. Do not build/ship
binaries by hand.

## Punctuation (code, commits, comments)

ASCII keyboard punctuation only. No em/en dashes, no Unicode arrows (`->` not the glyph), no curly
quotes, no ellipsis glyph. Inside fenced code blocks, characters stay verbatim. Chinese text uses
full-width punctuation.

## Git

Never add Co-Authored-By, "Generated with Claude Code", or any Claude/AI reference to commits, PRs, or
issues.

## Gotchas

- `config*.yml` is gitignored (holds secrets). Only `config.example.yml` is committed.
- `scripts/` and `reference/` are dev-only (gitignored). `scripts/*.ts` are one-shot analysis/backfill
  tools run with `bun scripts/<name>.ts`; `reference/` holds snapshotted pricing datasets.
- `logs/` holds run history, redacted model-test transcripts, and `verdict-cache.json` (the
  universal PERMANENT verdict file: http/stream/tool + claude authenticity per `provider|model`
  pair; auto-maintained, no TTL, prune entries manually or from the UI History tab to force a
  re-probe; migrates the legacy `authenticity-cache.json` on first load).
- Builtin blacklist (`config.ts`) is merged last and additively; local config can add but never remove
  builtins.
- Option maps are read-modify-write with no lock. The 15-min cluster `metadata` job can read
  `GroupRatio` before a manual write and merge its stale copy back afterwards; write option maps
  only while no sync job is active, recompute from live at write time, and re-check after the
  next cron tick. That job also writes a ratio for every unprobed candidate group, so lane-shaped
  `GroupRatio` keys without a channel accumulate; the group prune never touches them.
- Never call `client.updateOption` from a script; it bypasses the pricing invariant. Recipe:
  `const store = await OptionStore.load(target); store.setEntries("ModelRatio", { name: 1.5 });
await store.flush(target, await target.listChannels());` (`deleteEntries`, `mergeGroups`,
  `pruneGroups`, `replace` for scalar keys). The flush logs drops and heals and returns `errors`.

## a7 cluster crons (cluster runs the cadence, this machine is for development)

Two CronJobs in the k3s `services` namespace deploy from this repo's `k8s/` dir
(build via `infra/scripts/build-local.sh new-api-sync --deploy`):

- `new-api-sync` (every 15min): `sync metadata`. Reprices option maps from live
  marketplace listings AND accepts a7 pin price-change notices (ceiling-gated).
  Zero probes, zero channel writes. Needs no verdict cache.
- `new-api-sync-full` (daily 22:00 Europe/Berlin): `sync run --only a7`. Membership churn:
  probes + admits new merchants, deletes dead lanes, re-pins. The ONLY job that
  runs live probes.

**Mirror config.yml provider changes to the cluster.** The cluster reads a
MINIMAL config.yml from OpenBao `secret/sync-env` (target + the a7, fish and
open1 provider blocks + kiro blacklist entries + the opus-4-6 modelMapping + the
full groupMapping block). Any edit to those provider blocks, those blacklist
entries, either mapping, or any groupMapping rule MUST be pushed there too or
the crons keep running the old rules. Missing groupMapping there is not
cosmetic: the 15-min metadata job prices fish's candidate groups under their
RAW labels and writes brand-named `GroupRatio` keys back every tick. Regenerate + upload (payload file
plus stdin, never argv):

```bash
bun scripts/... # build {"config.yml": <minimal>} JSON from local config.yml
cd ../infra && BT=$(sops -d secrets/openbao-init.sops.yaml | grep -oP 'root_token:\s*\K\S+')
{ printf '%s\n' "$BT"; cat payload.json; } | kubectl -n openbao exec -i openbao-0 -- \
  sh -c 'read -r BAO_TOKEN && export BAO_TOKEN && bao kv patch -method=rw secret/sync-env -'
kubectl -n services annotate externalsecret sync-env force-sync=$(date +%s) --overwrite
```

`patch`, never `put`: the secret also holds `GUEST_API_KEY`, which the guest
token refresh reads. `put` replaces the whole secret and silently drops it; that
happened eight times before the recipe above was corrected (v16 through v25).
Read the secret back after every write and confirm both keys are present.

**Keep BOTH verdict caches in sync.** The daily full-sync CronJob persists
`logs/verdict-cache.json` on PVC `new-api-sync-logs` (services ns); this repo
has its own local copy. They drift: local manual runs write local, cluster runs
write the PVC. After pruning/scrubbing verdicts locally (fake-channel cleanup,
forced re-probes) copy the file to the PVC too, and vice versa, or one side
re-probes lanes the other already settled and blacklist scrubs do not take
effect on the other side. **Sync them after every local run that probed** (any
`sync run` without `--dry-run`) and before relying on a cluster verdict. Entries
carry no timestamp, so the merge is a union keyed by `key`, local winning on a
conflict (the local run is the newer one); check the printed conflicts first.

```bash
export KUBECONFIG=~/MEGA/Projects/ai-api/infra/kubeconfig
kubectl -n services apply -f - <<'YAML'
apiVersion: v1
kind: Pod
metadata: { name: verdict-peek }
spec:
  restartPolicy: Never
  containers:
  - { name: s, image: busybox:1.36, command: ["sh","-c","sleep 600"], volumeMounts: [{ name: logs, mountPath: /logs }] }
  volumes: [{ name: logs, persistentVolumeClaim: { claimName: new-api-sync-logs } }]
YAML
kubectl -n services wait --for=condition=Ready pod/verdict-peek --timeout=100s
kubectl -n services cp verdict-peek:/logs/verdict-cache.json /tmp/pvc-verdict-cache.json
cp logs/verdict-cache.json logs/verdict-cache.json.bak-presync-$(date +%s)
python3 - <<'PY'
import json
L=json.load(open('logs/verdict-cache.json')); P=json.load(open('/tmp/pvc-verdict-cache.json'))
lk={e['key']:e for e in L}; pk={e['key']:e for e in P}
for k in set(lk)&set(pk):
    if json.dumps(lk[k],sort_keys=True)!=json.dumps(pk[k],sort_keys=True): print('CONFLICT',k,lk[k],pk[k])
out=sorted({**pk,**lk}.values(),key=lambda e:e['key'])
json.dump(out,open('logs/verdict-cache.json','w'),indent=1,ensure_ascii=False); print('merged',len(out))
PY
kubectl -n services cp logs/verdict-cache.json verdict-peek:/logs/verdict-cache.json
kubectl -n services exec verdict-peek -- wc -c /logs/verdict-cache.json
kubectl -n services delete pod verdict-peek --wait=false
```

The PVC is `local-path`, so it is pinned to ONE node (`unorouter-node9` since
2026-09-02; the previous volume died with node7 and the daily job sat unscheduled
for two days). A helper pod needs no nodeSelector: the scheduler follows the PV's
node affinity, and RWO is node-scoped, so it does not block the cron. If the node
ever goes away: delete PVC + PV (clear the PV finalizer, its node cannot run the
cleanup), ArgoCD recreates the PVC, the next consumer pod provisions it, then
re-seed from the local `verdict-cache.json`. The 15-min metadata cron does not
mount it, so it keeps working while the daily run is stuck.

## a7 concurrency (the local lock does not cover the cluster)

`logs/sync.lock` serializes LOCAL runs only. The cluster `metadata` cron hits a7
every 15 min (:00/:15/:30/:45, ~35s: listings, pin list, notice accepts, unpin+pin
on price drops) on its own schedule. Local a7 runs share a7's rate budget with it
and can race its re-pins. Rules:

- One a7 run at a time, anywhere. Start local a7 runs in the gap after a tick
  (:01-:13) and check `kubectl -n services get jobs` shows no active
  `new-api-sync-*` first; for anything long (`--only a7` full, ~25 min) suspend
  the metadata cron (`kubectl -n services patch cronjob new-api-sync -p
'{"spec":{"suspend":true}}'`, un-suspend after; ArgoCD does not revert it).
- Space a7 runs >= 30 min apart. Five in one hour tripped 429s on pin/token
  calls and "no key for lane ..., skipping" for healthy merchants.
- A THROTTLED FULL `--only a7` RUN IS DESTRUCTIVE: a lane skipped for "no key"
  or a failed pin is absent from desired, so apply deletes its channel and
  token. If a full run logs 429s or no-key skips, kill it BEFORE apply
  (`Providers:`/`Channels:` lines mean apply started). `--models` runs never
  delete, so a throttled scoped run only leaves stale ratios behind.
- The tool harness kills foreground/background commands at 10 min; run the
  full a7 job detached (`setsid nohup ... &`) and tail its log.

## a7 pin semantics (hard-won, do not re-learn)

- a7 PAUSES a pin whenever its merchant reprices (`paused_price_changed`);
  re-POSTing /api/marketplace/pin re-pins but does NOT accept the new price.
  Accept is `POST /api/marketplace/price-notices/<notice_id>/accept` with
  `{relation_type: "pin", relation_id}` from the notice's open pin relation
  (`acceptPriceNotices` in vendors/a7api/pins.ts).
- Price DROPS never pause the pin and create no acceptable notice; the active
  pin keeps BILLING the old higher confirmed snapshot (seen 1.07x margin on a
  4x lane). Re-POST does not refresh; only unpin + pin re-confirms at the
  current price (the drop loop in `acceptPriceNotices`). Detection: pins list
  `current_output_price_micros < confirmed_output_price_micros`.
- `fallback_to_smart_routing` must stay FALSE: a paused/dead pinned lane then
  errors (gateway failover covers it). With fallback on, a7 silently serves
  the request through ANY merchant at THAT merchant's price (seen 4.8x the
  pinned cost, can exceed retail) and the success hides the outage from the
  failure-rate guard.
