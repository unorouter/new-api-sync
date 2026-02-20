# new-api-sync

Sync pricing, channels, and models from upstream providers to your [new-api](https://github.com/QuantumNous/new-api) instance. Supports [new-api](https://github.com/QuantumNous/new-api), [sub2api](https://github.com/Wei-Shaw/sub2api), and direct vendor API providers.

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

| Field               | Required | Description                                                              |
| ------------------- | -------- | ------------------------------------------------------------------------ |
| `name`              | yes      | Unique identifier, used as channel tag                                   |
| `baseUrl`           | yes      | Provider URL                                                             |
| `systemAccessToken` | yes      | System Access Token from provider                                        |
| `userId`            | yes      | Your user ID on the provider                                             |
| `enabledGroups`     |          | Specific groups to sync (omit for all)                                   |
| `enabledVendors`    |          | Filter by vendor: `anthropic`, `openai`, `google`, etc.                  |
| `enabledModels`     |          | Glob patterns: `["claude-*-4-5*", "gpt-5*"]`                             |
| `priceAdjustment`   |          | Price adjustment (e.g. `-0.5` = 50% cheaper, `0.1` = 10% more expensive) |

### Direct Provider (`type: "direct"`)

Connect directly to a vendor API (OpenAI, Anthropic, Google, Moonshot, etc.) without an intermediary.

| Field             | Required | Description                                                              |
| ----------------- | -------- | ------------------------------------------------------------------------ |
| `name`            | yes      | Unique identifier, used as channel tag                                   |
| `vendor`          | yes      | Vendor name: `openai`, `anthropic`, `google`, `moonshot`, etc.           |
| `apiKey`          | yes      | Vendor API key                                                           |
| `baseUrl`         |          | Custom base URL (defaults to vendor's official URL)                      |
| `enabledModels`   |          | Glob patterns: `["kimi-*", "moonshot-*"]`                                |
| `groupRatio`      |          | Fixed group ratio (cannot be used with `priceAdjustment`)                |
| `priceAdjustment` |          | Price adjustment (e.g. `-0.1` = 10% cheaper, `0.1` = 10% more expensive) |

### sub2api Provider (`type: "sub2api"`)

Provide either `adminApiKey` (auto-discovers groups) or `groups` (explicit group API keys).

| Field             | Required | Description                                                              |
| ----------------- | -------- | ------------------------------------------------------------------------ |
| `name`            | yes      | Unique identifier, used as channel tag                                   |
| `baseUrl`         | yes      | Sub2API instance URL                                                     |
| `adminApiKey`     |          | Admin API key — auto-discovers groups, accounts, and models              |
| `groups`          |          | Explicit groups: `[{ "key": "sk-...", "platform": "anthropic" }]`        |
| `enabledVendors`  |          | Filter by vendor: `anthropic`, `openai`, `google`                        |
| `enabledModels`   |          | Glob patterns: `["claude-*-4-5*", "gpt-5*"]`                             |
| `priceAdjustment` |          | Price adjustment (e.g. `-0.1` = 10% cheaper, `0.1` = 10% more expensive) |

### Options

- **`blacklist`** — Exclude matching groups/models: `["kiro", "nsfw"]`
- **`enabledModels`** — Glob patterns: `claude-*-4-5*` matches `claude-sonnet-4-5-20250929`, `*-preview` matches anything ending in `-preview`
- **`modelMapping`** — Rename models: `{ "claude-sonnet-4-5-20250929-thinking": "claude-sonnet-4-5-20250929" }`

## How It Works

1. **Discover** — fetch models/groups from each provider, filter by vendor, blacklist, and glob patterns
2. **Test** — verify each model with a minimal API request
3. **Build desired state** — merge pricing (GroupRatio, ModelRatio, CompletionRatio), build channels and policy
4. **Diff** — compare desired state against current target state
5. **Apply** — create, update, and delete channels, models, and options
6. **Cleanup** — remove orphaned models

Channels are named `{group}-{provider}`. Priority is dynamic: cheapest groups first, faster response times get higher priority.

<!-- bun sync run --only sub2api -->
<!-- bun sync run config.debug.jsonc --only yun -->
