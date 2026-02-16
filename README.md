# new-api-sync

Sync pricing, channels, and models from upstream providers to your [new-api](https://github.com/QuantumNous/new-api) instance. Supports [new-api](https://github.com/QuantumNous/new-api) and [sub2api](https://github.com/Wei-Shaw/sub2api) providers.

## Quick Start

```bash
bun install
cp config.example.jsonc config.jsonc  # edit with your config
bun sync                              # run sync
bun reset                             # delete all synced data
```

## Configuration

### Target

| Field               | Description                            |
| ------------------- | -------------------------------------- |
| `baseUrl`           | Your new-api instance URL              |
| `systemAccessToken` | System Access Token (Settings > Other) |
| `userId`            | Your user ID                           |

### new-api Provider (`type: "newapi"`)

| Field               | Required | Description                                             |
| ------------------- | -------- | ------------------------------------------------------- |
| `name`              | yes      | Unique identifier, used as channel tag                  |
| `baseUrl`           | yes      | Provider URL                                            |
| `systemAccessToken` | yes      | System Access Token from provider                       |
| `userId`            | yes      | Your user ID on the provider                            |
| `enabledGroups`     |          | Specific groups to sync (omit for all)                  |
| `enabledVendors`    |          | Filter by vendor: `anthropic`, `openai`, `google`, etc. |
| `enabledModels`     |          | Glob patterns: `["claude-*-4-5*", "gpt-5*"]`           |
| `priceAdjustment`   |          | Price adjustment (e.g. `-0.5` = 50% cheaper, `0.1` = 10% more expensive) |

### sub2api Provider (`type: "sub2api"`)

Provide either `adminApiKey` (auto-discovers groups) or `groups` (explicit group API keys).

| Field            | Required | Description                                                          |
| ---------------- | -------- | -------------------------------------------------------------------- |
| `name`           | yes      | Unique identifier, used as channel tag                               |
| `baseUrl`        | yes      | Sub2API instance URL                                                 |
| `adminApiKey`    |          | Admin API key — auto-discovers groups, accounts, and models          |
| `groups`         |          | Explicit groups: `[{ "key": "sk-...", "platform": "anthropic" }]`    |
| `enabledVendors` |          | Filter by vendor: `anthropic`, `openai`, `google`                    |
| `enabledModels`  |          | Glob patterns: `["claude-*-4-5*", "gpt-5*"]`                        |
| `priceAdjustment`|          | Price adjustment (e.g. `-0.1` = 10% cheaper, `0.1` = 10% more expensive) |

### Options

- **`blacklist`** — Exclude matching groups/models: `["kiro", "nsfw"]`
- **`enabledModels`** — Glob patterns: `claude-*-4-5*` matches `claude-sonnet-4-5-20250929`, `*-preview` matches anything ending in `-preview`
- **`modelMapping`** — Rename models: `{ "claude-sonnet-4-5-20250929-thinking": "claude-sonnet-4-5-20250929" }`

## How It Works

1. **Fetch** providers, filter groups/models by vendor, blacklist, and patterns
2. **Test** each model with a minimal API request to verify it works
3. **Merge** pricing from all providers (GroupRatio, ModelRatio, CompletionRatio)
4. **Sync** channels, models, and options to target
5. **Cleanup** stale channels and orphaned models

Channels are named `{group}-{provider}`. Priority is dynamic: cheapest groups first, faster response times get higher priority.
