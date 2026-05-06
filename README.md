English | [中文](README.zh.md)

> Friends: [LINUX DO](https://linux.do/) - 新的理想型社区

# new-api-sync

Sync pricing, channels, and models from upstream providers to your [new-api](https://github.com/QuantumNous/new-api) instance. Supports [new-api](https://github.com/QuantumNous/new-api), [sub2api](https://github.com/Wei-Shaw/sub2api), [OpenRouter](https://openrouter.ai/), and [NVIDIA NIM](https://build.nvidia.com/) upstreams.

## Quick Start

First install [Bun](https://bun.com/docs/installation) if you don't have it.

```bash
bun install
cp config.example.yml config.yml         # edit with your config
bun sync run                             # run sync
bun sync run --only myprovider           # sync one provider
bun sync run --models "claude-*,gpt-4*"  # sync only matching models
bun sync run --verbose                   # run with debug logging
bun sync reset                           # delete all synced data
```

## Web UI

If you'd rather click than type, launch the bundled dashboard:

```bash
bun ui                          # shortcut for `bun sync ui`
bun sync ui --port 4000         # custom port (default 3000)
```

Then open `http://localhost:3000`. Everything the CLI can do is exposed through the UI, no YAML editing required:

- **Dashboard**: run or reset pipelines live. A streaming log panel shows every provider, model, and price in real time, with colors preserved from the CLI output. Pick which providers to touch (matches `--only`), restrict to specific models with glob wildcards (matches `--models`, e.g. `claude-*, gpt-4*`), and hit **Start**. The models filter persists per config, so switching between configs restores your last selection.
- **Configuration**: edit every provider, target, blacklist, price adjustment, model mapping, and per-model overrides through structured forms. Invalid YAML is validated before save and rolled back if it fails.
- **Multiple configs**: create named variants (`debug`, `staging`, `prod`) from the dropdown next to the tabs. Each is stored as `config.<name>.yml` next to the binary (or in the project root in dev mode) and can be switched, duplicated, or deleted without touching the filesystem directly. Cross-config settings (locale, theme, shared blacklist, shared model mapping) live in `config.global.yml`.
- **History**: browse past runs (`logs/YYYY-MM-DD-*.json`) with per-model pass/fail results, costs, and authenticity status. Authenticity auto-blacklist entries are manageable from the same tab.
- **Themes & locales**: toggle dark/light/system and switch between English and 中文; both are remembered across sessions.

The UI is bundled as a single-file binary for every platform, so the target machine does not need Bun installed. Grab the right one from `dist/` after `bun run build` (or release artifacts) and run it directly:

```bash
./new-api-sync-linux-x64 ui      # Linux
./new-api-sync-darwin-arm64 ui   # macOS (Apple silicon)
new-api-sync-windows-x64.exe ui  # Windows
```

## Configuration

Two files are loaded on startup:

- `config.yml` (or a named variant `config.<name>.yml`): the active sync config (target, providers, etc.).
- `config.global.yml` (optional): cross-config settings. `locale`, `theme`, and UI state are stored here. `blacklist` and `modelMapping` defined here merge into every config (global blacklist entries are unioned with per-config; global mapping wins on key collisions).

### Target

| Field               | Description                            |
| ------------------- | -------------------------------------- |
| `baseUrl`           | Your new-api instance URL              |
| `systemAccessToken` | System Access Token (Settings > Other) |
| `userId`            | Your user ID                           |
| `targetPrefix`      | Optional prefix for sync resources     |

### Global Options

| Field                    | Description                                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `testModelTypes`         | Model types to test during sync: `["text", "image", "video", "audio", "embedding"]` (default: `["text"]`). Per-provider setting overrides.   |
| `skipUnprofitableText`   | Drop text models whose effective ratio >= 1 (default: `true`). See Behaviors to Know.                                                        |
| `globalConcurrency`      | Total simultaneous test/probe HTTP requests across the whole run (default: `50`).                                                            |
| `perUpstreamConcurrency` | Default per-baseUrl request cap (default: `5`). Per-provider override allowed for upstreams that tolerate more or less.                      |
| `blacklist`              | Exclude matching groups/models (text only, case-insensitive). Supports glob wildcards and provider-scoped patterns. See Blacklist below.     |
| `modelMapping`           | Rename models: `{ "claude-sonnet-4-5-20250929-thinking": "claude-sonnet-4-5-20250929" }`                                                     |

### new-api Provider (`type: "newapi"`)

| Field                    | Required | Description                                             |
| ------------------------ | -------- | ------------------------------------------------------- |
| `name`                   | yes      | Unique identifier, used as channel tag                  |
| `baseUrl`                | yes      | Provider URL                                            |
| `systemAccessToken`      | yes      | System Access Token from provider                       |
| `userId`                 | yes      | Your user ID on the provider                            |
| `enabledVendors`         |          | Filter by vendor: `anthropic`, `openai`, `google`, etc. |
| `enabledModels`          |          | Glob patterns or per-model overrides (see below)        |
| `testModelTypes`         |          | Override global test types: `["text", "image"]`         |
| `priceAdjustment`        |          | Number or per-key object (see Price Adjustment below)   |
| `perUpstreamConcurrency` |          | Override the global per-upstream concurrency cap        |

### sub2api Provider (`type: "sub2api"`)

Provide either `adminApiKey` (auto-discovers groups) or `groups` (explicit group API keys).

| Field                    | Required | Description                                                       |
| ------------------------ | -------- | ----------------------------------------------------------------- |
| `name`                   | yes      | Unique identifier, used as channel tag                            |
| `baseUrl`                | yes      | Sub2API instance URL                                              |
| `adminApiKey`            |          | Admin API key, auto-discovers groups, accounts, and models        |
| `groups`                 |          | Explicit groups: `[{ "key": "sk-...", "platform": "anthropic" }]` |
| `enabledVendors`         |          | Filter by vendor: `anthropic`, `openai`, `google`                 |
| `enabledModels`          |          | Glob patterns or per-model overrides (see below)                  |
| `testModelTypes`         |          | Override global test types                                        |
| `priceAdjustment`        |          | Number or per-key object (see Price Adjustment below)             |
| `perUpstreamConcurrency` |          | Override the global per-upstream concurrency cap                  |

### OpenRouter Provider (`type: "openrouter"`)

Pulls from [OpenRouter](https://openrouter.ai/). Free models (`prompt=0` and `completion=0`) are emitted as a free tier; paid models are bucketed under a per-vendor channel and a single shared `group_ratio` is picked from the candidate ladder `[1, 0.5, 0.25, 0.1, 0.05, 0.01]` such that every kept model stays at or below canonical retail. Models that don't fit at any candidate are dropped.

| Field                    | Required | Description                                                            |
| ------------------------ | -------- | ---------------------------------------------------------------------- |
| `name`                   | yes      | Unique identifier, used as channel tag                                 |
| `apiKey`                 | yes      | OpenRouter API key                                                     |
| `baseUrl`                |          | Defaults to `https://openrouter.ai/api`                                |
| `models`                 |          | Explicit model IDs (e.g. `moonshotai/kimi-k2.6:free`); skips discovery |
| `enabledVendors`         |          | Filter discovered models by vendor prefix (`anthropic`, `openai`, ...) |
| `enabledModels`          |          | Glob patterns. Bare IDs (no `*`) are also added to the candidate set   |
| `ratio`                  |          | Free-tier group ratio (default `0`)                                    |
| `testModelTypes`         |          | Override global test types                                             |
| `priceAdjustment`        |          | Number or per-key object (see Price Adjustment below)                  |
| `perUpstreamConcurrency` |          | Override the global per-upstream concurrency cap                       |

### NVIDIA NIM Provider (`type: "nvidia"`)

Pulls from [NVIDIA NIM](https://build.nvidia.com/). Text models are emitted as a free tier; image models are emitted with fixed per-request pricing (`quotaType: 1`) against a separate `imageBaseUrl`.

| Field                    | Required | Description                                                          |
| ------------------------ | -------- | -------------------------------------------------------------------- |
| `name`                   | yes      | Unique identifier, used as channel tag                               |
| `apiKey`                 | yes      | NVIDIA API key                                                       |
| `baseUrl`                |          | Defaults to `https://integrate.api.nvidia.com`                       |
| `imageBaseUrl`           |          | Defaults to `https://ai.api.nvidia.com`                              |
| `models`                 |          | Explicit model IDs; skips auto-discovery                             |
| `enabledVendors`         |          | Filter by inferred vendor                                            |
| `enabledModels`          |          | Glob patterns. Bare image-model IDs (no `*`) are added to the set    |
| `ratio`                  |          | Text-tier group ratio (default `1`)                                  |
| `testModelTypes`         |          | Override global test types                                           |
| `priceAdjustment`        |          | Number or per-key object (see Price Adjustment below)                |
| `perUpstreamConcurrency` |          | Override the global per-upstream concurrency cap                     |

### Blacklist

`blacklist` removes matching text models from sync. Non-text types (image, video, audio, embedding) are never filtered by the blacklist.

- **Case-insensitive** match against the model ID.
- **Glob wildcards** supported: `gpt-5.*-codex`, `*-preview`.
- **Provider-scoped patterns** use `provider/pattern` syntax. The part before the slash must match the provider's `name`; the part after is the glob. Example:

  ```yml
  blacklist:
    - nsfw # unscoped: blocks any provider's model containing "nsfw"
    - "*-preview" # unscoped: blocks any provider's preview models
    - duck/gpt-5* # scoped: only blocks gpt-5* models from the "duck" provider
    - yun/claude-*-opus # scoped: only blocks claude opus models from "yun"
  ```

A small built-in blacklist is always merged in to suppress a handful of upstream IDs that are uniformly broken or mis-typed (embedding/audio/video models served as `text`). You don't need to add these in your config.

### Price Adjustment

`priceAdjustment` accepts either a single number or a keyed object:

- **Number:** applies uniformly. Must be in the open range `(-1, 1)`. `-0.5` = 50% cheaper, `0.1` = 10% more expensive.
- **Object:** keyed by model name glob, vendor name, model type, or `default`. Resolved in that order. Must contain a `default` key. Numeric keys for non-text types may go up to `1`; text-type keys (vendors, model globs that resolve to text, and `default`) must stay below `1` so the resulting channel never costs more than calling the upstream directly. Example:

  ```yml
  priceAdjustment:
    default: -0.3
    image: 0.5
    anthropic: -0.1
    gpt-5*: -0.5
  ```

### Per-Model Overrides via `enabledModels`

`enabledModels` accepts string globs or objects keyed by `model`:

```yml
enabledModels:
  - "claude-*-4-5*" # plain glob
  - model: "gpt-5"
    metadata:
      maxOutputTokens: 32768
      isReasoning: true
  - type: "image"
    model: "flux-pro"
    modelPricingGrid:
      - { "size": "1024x1024", "price": 0.04 }
      - { "size": "2048x2048", "price": 0.08 }
```

- `metadata` is forwarded to new-api's per-model `metadata` JSON column (consumed by client UIs to drive per-model behaviors like bumping `max_tokens` for reasoning models).
- `modelPricingGrid` defines fixed per-request pricing tables for image/video/audio models.

## How It Works

1. **Discover**: fetch models/groups from each provider, filter by vendor, blacklist, and glob patterns
2. **Test**: verify each model with a minimal API request
3. **Build desired state**: merge pricing (GroupRatio, ModelRatio, CompletionRatio), build channels and policy
4. **Diff**: compare desired state against current target state
5. **Apply**: create, update, and delete channels, models, and options
6. **Cleanup**: remove orphaned models

Channels are named `{group}-{provider}`. When a provider's models split into multiple price tiers, channels get numeric suffixes: `{group}-{provider}-t0`, `-t1`, etc. Sub-splits (caused by per-model price overrides or task model pins) add a letter: `-t0a`, `-t0b`. Priority is dynamic: cheapest groups first, faster response times get higher priority.

## Behaviors to Know

### Unprofitable Text Models Are Skipped (default on)

By default, text models whose effective ratio (group ratio x `priceAdjustment`) is >= 1.0 are skipped so sync never creates channels more expensive than calling the upstream directly. Non-text types (image, video, audio, embedding) are unaffected.

Disable via global config:

```yml
skipUnprofitableText: false
```

### Hard Pricing Cap

In addition to the unprofitable-text gate, every offer that would charge a user more than the canonical retail ratio (resolved from LiteLLM, then OpenRouter, then basellm) is dropped before sync. There is no user-facing knob for this cap; it is always 1x of canonical retail. This applies to sub2api offers and OpenRouter paid offers.

### Task Model Channel Pinning

Certain video/image models are pinned to specific channel types in new-api: `sora`, `kling`, `vidu`, `jimeng`, `hailuo`, `seedance`, `veo`, `imagen`, `wan`. Some also append a path suffix to the provider's `baseUrl` (e.g., `wan` becomes `/alibailian`). This happens automatically and produces a separate sub-channel.

### Model Metadata Enrichment

During sync, model descriptions and tags are fetched from two public feeds to enrich the metadata shown in new-api:

- [OpenRouter `/api/v1/models`](https://openrouter.ai/api/v1/models): descriptions (preferred)
- [basellm `llm-metadata`](https://basellm.github.io/llm-metadata/api/newapi/models.json): descriptions (fallback) and tags

These calls are best-effort: failures are logged as warnings and do not block the sync. Fuzzy name matching handles version/date-suffix variants (`claude-sonnet-4-5-20250929` resolves to `claude-sonnet-4.5`).

### Authenticity Auto-Blacklist

`logs/authenticity-blacklist.json` is maintained automatically by the test runner to track Anthropic Claude models from providers that failed authenticity checks. This is internal state, but entries can be reviewed and removed from the History tab in the UI.


<!-- bun sync run --only nvda1,open1,open2 -->
