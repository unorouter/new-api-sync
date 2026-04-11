English | [中文](README.zh.md)

# new-api-sync

Sync pricing, channels, and models from upstream providers to your [new-api](https://github.com/unorouter/new-api) instance. Supports [new-api](https://github.com/unorouter/new-api), [sub2api](https://github.com/unorouter/sub2api), direct vendor APIs, and NVIDIA NIM.

## Quick Start

```bash
bun install
cp config.example.jsonc config.jsonc  # edit with your config
bun sync run                          # run sync
bun sync run --only myprovider        # sync one provider
bun sync reset                        # delete all synced data
```

## Model Testing

```bash
bun sync test                         # test all models across all providers
bun sync test --only myprovider       # test one provider
```

The `test` command tests every model across all groups without applying any changes to your target instance. Results are saved to `logs/YYYY-MM-DD-model-tests.json`. Re-running the same day skips models that already passed and only retests failures, so you can resume an interrupted run.

Testing ignores `enabledVendors` and `enabledModels` filters and tests all model types. Per-provider `testModelTypes` in `config.jsonc` controls which model categories are tested during regular sync (e.g. `["text", "image"]`). Omit it to only test text models (the default).

## Configuration

### Target

| Field               | Description                            |
| ------------------- | -------------------------------------- |
| `baseUrl`           | Your new-api instance URL              |
| `systemAccessToken` | System Access Token (Settings > Other) |
| `userId`            | Your user ID                           |
| `targetPrefix`      | Optional prefix for sync resources     |

### Global Options

| Field            | Description                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `testModelTypes` | Model types to test during sync: `["text", "image", "video", "audio", "embedding"]` (default: `["text"]`). Per-provider setting overrides this. |
| `blacklist`      | Exclude matching groups/models: `["kiro", "nsfw"]`                                                                                              |
| `modelMapping`   | Rename models: `{ "claude-sonnet-4-5-20250929-thinking": "claude-sonnet-4-5-20250929" }`                                                        |

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

### NVIDIA NIM Provider (`type: "nvidia"`)

Connect to NVIDIA NIM APIs. Text models are auto-discovered; image models must be listed in `enabledModels`.

| Field             | Required | Description                                                          |
| ----------------- | -------- | -------------------------------------------------------------------- |
| `name`            | yes      | Unique identifier, used as channel tag                               |
| `apiKey`          | yes      | NVIDIA API key                                                       |
| `baseUrl`         |          | Text model endpoint (default `https://integrate.api.nvidia.com`)     |
| `imageBaseUrl`    |          | Image model endpoint (default `https://ai.api.nvidia.com`)           |
| `models`          |          | Explicit model list (skips auto-discovery)                           |
| `enabledModels`   |          | Glob patterns; literal image model names are auto-added to discovery |
| `ratio`           |          | Base group ratio (default 1.0)                                       |
| `testModelTypes`  |          | Override global test types                                           |
| `priceAdjustment` |          | Number or per-key object (see Price Adjustment below)                |

### Price Adjustment

`priceAdjustment` accepts either a single number or a keyed object:

- **Number:** applies uniformly. `-0.5` = 50% cheaper, `0.1` = 10% more expensive.
- **Object:** keyed by model name glob, vendor name, model type, or `"default"`. Resolved in that order. Must contain a `"default"` key. Example:
  ```jsonc
  { "default": -0.3, "image": 0.5, "anthropic": -0.1, "gpt-5*": -0.5 }
  ```

### Other Options

- **`enabledModels`** supports glob patterns: `claude-*-4-5*` matches `claude-sonnet-4-5-20250929`, `*-preview` matches anything ending in `-preview`

## How It Works

1. **Discover** — fetch models/groups from each provider, filter by vendor, blacklist, and glob patterns
2. **Test** — verify each model with a minimal API request
3. **Build desired state** — merge pricing (GroupRatio, ModelRatio, CompletionRatio), build channels and policy
4. **Diff** — compare desired state against current target state
5. **Apply** — create, update, and delete channels, models, and options
6. **Cleanup** — remove orphaned models

Channels are named `{group}-{provider}`. Priority is dynamic: cheapest groups first, faster response times get higher priority.
