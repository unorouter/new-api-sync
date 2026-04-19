English | [中文](README.zh.md)

> Friends: [LINUX DO](https://linux.do/) - 新的理想型社区

# new-api-sync

Sync pricing, channels, and models from upstream providers to your [new-api](https://github.com/QuantumNous/new-api) instance. Supports [new-api](https://github.com/QuantumNous/new-api), [sub2api](https://github.com/Wei-Shaw/sub2api), and direct vendor APIs.

## Quick Start

First install [Bun](https://bun.com/docs/installation) if you don't have it.

```bash
bun install
cp config.example.yml config.yml      # edit with your config
bun sync run                          # run sync
bun sync run --only myprovider        # sync one provider
bun sync run --models "claude-*,gpt-4*"  # sync only matching models
bun sync run --verbose                # run with debug logging
bun sync reset                        # delete all synced data
```

## Web UI

If you'd rather click than type, launch the bundled dashboard:

```bash
bun ui                                # shortcut for `bun sync ui`
bun sync ui --port 4000               # custom port (default 3000)
```

Then open `http://localhost:3000`. Everything the CLI can do is exposed through the UI, no YAML editing required:

- **Dashboard** — run, test, and reset pipelines live. A streaming log panel shows every provider, model, and price in real time, with colors preserved from the CLI output. Pick which providers to touch (`--only`), restrict to specific models with glob wildcards (`--models`, e.g. `claude-*, gpt-4*`), and hit **Start**. The models filter persists per config, so switching between configs restores your last selection.
- **Configuration** — edit every provider, target, blacklist, price adjustment, and model mapping through structured forms. Invalid YAML is validated before save and rolled back if it fails.
- **Multiple configs** — create named variants (`debug`, `staging`, `prod`) from the dropdown next to the tabs. Each is stored as `config.<name>.yml` in the project root and can be switched, duplicated, or deleted without touching the filesystem directly.
- **History** — browse past runs (`logs/YYYY-MM-DD-*.json`) with per-model pass/fail results, costs, and authenticity status. Kiro auto-blacklist entries are manageable from the same tab.
- **Themes & locales** — toggle dark/light/system and switch between English and 中文; both are remembered across sessions.

The UI is bundled as a single-file binary for every platform — no Bun install needed on the target machine. Grab the right one from `dist/` after `bun run build` (or release artifacts) and run it directly:

```bash
./new-api-sync-linux-x64 ui         # Linux
./new-api-sync-darwin-arm64 ui      # macOS (Apple silicon)
new-api-sync-windows-x64.exe ui     # Windows
```

## Model Testing

```bash
bun sync test                         # test all models across all providers
bun sync test --only myprovider       # test one provider
bun sync test --verbose               # test with debug logging
```

The `test` command tests every model across all groups without applying any changes to your target instance. Results are saved to `logs/YYYY-MM-DD-model-tests.json`. Re-running the same day skips models that already passed and only retests failures, so you can resume an interrupted run.

Testing ignores `enabledVendors`, `enabledModels`, and the ratio-gate filters (see Behaviors to Know) and tests all model types. Per-provider `testModelTypes` in `config.yml` controls which model categories are tested during regular sync (e.g. `[text, image]`). Omit it to only test text models (the default).

## Configuration

### Target

| Field               | Description                            |
| ------------------- | -------------------------------------- |
| `baseUrl`           | Your new-api instance URL              |
| `systemAccessToken` | System Access Token (Settings > Other) |
| `userId`            | Your user ID                           |
| `targetPrefix`      | Optional prefix for sync resources     |

### Global Options

| Field                  | Description                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `testModelTypes`       | Model types to test during sync: `["text", "image", "video", "audio", "embedding"]` (default: `["text"]`). Per-provider setting overrides this. |
| `skipUnprofitableText` | Drop text models whose effective ratio ≥ 1 (default: `true`). See Behaviors to Know.                                                            |
| `blacklist`            | Exclude matching groups/models (text only, case-insensitive). Supports glob wildcards and provider-scoped patterns. See Blacklist below.        |
| `modelMapping`         | Rename models: `{ "claude-sonnet-4-5-20250929-thinking": "claude-sonnet-4-5-20250929" }`                                                        |

### new-api Provider (`type: "newapi"`)

| Field               | Required | Description                                             |
| ------------------- | -------- | ------------------------------------------------------- |
| `name`              | yes      | Unique identifier, used as channel tag                  |
| `baseUrl`           | yes      | Provider URL                                            |
| `systemAccessToken` | yes      | System Access Token from provider                       |
| `userId`            | yes      | Your user ID on the provider                            |
| `enabledVendors`    |          | Filter by vendor: `anthropic`, `openai`, `google`, etc. |
| `enabledModels`     |          | Glob patterns: `["claude-*-4-5*", "gpt-5*"]`            |
| `testModelTypes`    |          | Override global test types: `["text", "image"]`         |
| `priceAdjustment`   |          | Number or per-key object (see Price Adjustment below)   |

### Direct Provider (`type: "direct"`)

Connect directly to a vendor API (OpenAI, Anthropic, Google, Moonshot, etc.) without an intermediary.

| Field              | Required | Description                                                    |
| ------------------ | -------- | -------------------------------------------------------------- |
| `name`             | yes      | Unique identifier, used as channel tag                         |
| `baseUrl`          | yes      | Vendor API base URL                                            |
| `apiKey`           | yes      | Vendor API key                                                 |
| `vendor`           | yes      | Vendor name: `openai`, `anthropic`, `google`, `moonshot`, etc. |
| `models`           |          | Explicit model list (skips auto-discovery)                     |
| `enabledModels`    |          | Glob patterns for auto-discovered models: `["kimi-*"]`         |
| `channelType`      |          | Override inferred channel type number                          |
| `ratio`            |          | Base group ratio (default 1.0)                                 |
| `discoverEndpoint` |          | Custom discovery endpoint (default `/v1/models`)               |
| `testModelTypes`   |          | Override global test types                                     |
| `priceAdjustment`  |          | Number or per-key object (see Price Adjustment below)          |

### sub2api Provider (`type: "sub2api"`)

Provide either `adminApiKey` (auto-discovers groups) or `groups` (explicit group API keys).

| Field             | Required | Description                                                       |
| ----------------- | -------- | ----------------------------------------------------------------- |
| `name`            | yes      | Unique identifier, used as channel tag                            |
| `baseUrl`         | yes      | Sub2API instance URL                                              |
| `adminApiKey`     |          | Admin API key, auto-discovers groups, accounts, and models        |
| `groups`          |          | Explicit groups: `[{ "key": "sk-...", "platform": "anthropic" }]` |
| `enabledVendors`  |          | Filter by vendor: `anthropic`, `openai`, `google`                 |
| `enabledModels`   |          | Glob patterns: `["claude-*-4-5*", "gpt-5*"]`                      |
| `testModelTypes`  |          | Override global test types                                        |
| `priceAdjustment` |          | Number or per-key object (see Price Adjustment below)             |

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

### Price Adjustment

`priceAdjustment` accepts either a single number or a keyed object:

- **Number:** applies uniformly. `-0.5` = 50% cheaper, `0.1` = 10% more expensive.
- **Object:** keyed by model name glob, vendor name, model type, or `default`. Resolved in that order. Must contain a `default` key. Example:
  ```yml
  priceAdjustment:
    default: -0.3
    image: 0.5
    anthropic: -0.1
    gpt-5*: -0.5
  ```

### Other Options

- **`enabledModels`** supports glob patterns: `claude-*-4-5*` matches `claude-sonnet-4-5-20250929`, `*-preview` matches anything ending in `-preview`

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

By default, text models whose effective ratio (group ratio × `priceAdjustment`) is ≥ 1.0 are skipped so sync never creates channels more expensive than calling the upstream directly. Non-text types (image, video, audio, embedding) are unaffected. Test mode bypasses this gate.

Disable via global config:

```yml
skipUnprofitableText: false
```

### Task Model Channel Pinning

Certain video/image models are pinned to specific channel types in new-api: `sora`, `kling`, `vidu`, `jimeng`, `hailuo`, `seedance`, `veo`, `imagen`, `wan`. Some also append a path suffix to the provider's `baseUrl` (e.g., `wan` → `/alibailian`). This happens automatically and produces a separate sub-channel.

### Model Metadata Enrichment

During sync, model descriptions and tags are fetched from two public feeds to enrich the metadata shown in new-api:

- [OpenRouter `/api/v1/models`](https://openrouter.ai/api/v1/models) — descriptions (preferred)
- [basellm `llm-metadata`](https://basellm.github.io/llm-metadata/api/newapi/models.json) — descriptions (fallback) and tags

These calls are best-effort: failures are logged as warnings and do not block the sync. Fuzzy name matching handles version/date-suffix variants (`claude-sonnet-4-5-20250929` → `claude-sonnet-4.5`).

### Kiro Auto-Blacklist

`logs/kiro-blacklist.json` is maintained automatically by the test runner to track Anthropic Claude models from providers that failed authenticity checks. This is internal state and does not need to be edited.
