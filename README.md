# new-api-sync

Declarative multi-provider sync for [new-api](https://github.com/QuantumNous/new-api) instances. Syncs pricing, groups, channels, and models from upstream providers to your own instance.

## Features

- **Multi-provider support** — Sync from multiple new-api instances
- **Model testing** — Validates models actually work before creating channels
- **Model name mapping** — Transform complex model names to user-friendly aliases
- **Glob pattern filtering** — Filter models with patterns like `claude-*-4-5`
- **Vendor filtering** — Sync only specific vendors (anthropic, openai, google, etc.)
- **Blacklist** — Exclude groups/models by keyword
- **Dynamic priority** — Faster providers get higher priority automatically
- **Price multipliers** — Per-provider billing adjustments
- **Automatic retries** — Exponential backoff for transient API failures
- **Config validation** — Comprehensive checks with clear error messages
- **Idempotent** — Safe to run repeatedly; upserts everything, cleans up stale data

## Quick Start

```bash
# Install dependencies
bun install

# Copy and edit config
cp config.example.jsonc config.jsonc

# Run sync
bun run sync

# Reset (delete all synced data)
bun run reset
```

### Target

Your new-api instance where channels and settings will be synced.

| Field               | Description                            |
| ------------------- | -------------------------------------- |
| `baseUrl`           | Your instance URL                      |
| `systemAccessToken` | System Access Token (Settings → Other) |
| `userId`            | Your user ID                           |

### Providers

#### new-api Provider (`type: "newapi"` or omit type)

| Field               | Required | Description                                                             |
| ------------------- | -------- | ----------------------------------------------------------------------- |
| `name`              | ✓        | Unique identifier, used as channel tag                                  |
| `baseUrl`           | ✓        | Provider URL                                                            |
| `systemAccessToken` | ✓        | System Access Token from provider                                       |
| `userId`            | ✓        | Your user ID on the provider                                            |
| `enabledGroups`     |          | Specific groups to sync (omit for all)                                  |
| `enabledVendors`    |          | Filter by vendor: `anthropic`, `openai`, `google`, etc.                 |
| `enabledModels`     |          | Glob patterns: `["claude-*-4-5", "gpt-5"]`                              |
| `priceMultiplier`   |          | Multiply group ratios (e.g., `0.5` = 50% discount, `2.0` = 100% markup) |

### Blacklist

Global blacklist applies to group names, descriptions, and model names:

```jsonc
{
  "blacklist": ["nsfw", "kiro", "奇罗"],
}
```

### Model Patterns

`enabledModels` supports glob patterns:

- `claude-*-4-5` — Matches `claude-sonnet-4-5-20250514`, `claude-opus-4-5-20251101`
- `gpt-5` — Exact substring match
- `*-preview` — Matches anything ending in `-preview`

### Model Mapping

Map complex upstream model names to simpler, user-friendly names:

```jsonc
{
  "modelMapping": {
    "claude-sonnet-4-5-20250929-complex-suffix": "claude-sonnet-4-5",
    "gpt-4o-turbo-2024-04-09-preview-extended": "gpt-4o-turbo",
  },
}
```

This is useful for public welfare stations (公益站) that use complex model naming schemes. The original model name is used for upstream API calls, but your channels will expose the simpler mapped name.

## How It Works

1. **Fetch** — For each provider: fetch pricing, filter groups/models
2. **Test** — Test each model with a minimal request to verify it works
3. **Token** — Create/reuse API tokens on upstream for each group
4. **Merge** — Combine all providers: GroupRatio, AutoGroups, ModelRatio, CompletionRatio
5. **Sync** — Update target options, upsert channels, sync model metadata
6. **Cleanup** — Delete stale channels and orphaned models

### Channel Naming

Channels are named `{group}-{provider}` and tagged with the provider name:

- `aws-q-newapi`
- `claude-provider1`

### Priority & Failover

- **AutoGroups** sorted by ratio (cheapest first)
- **Dynamic priority** from response time: faster = higher priority
- Failed requests automatically retry on next available channel

## Commands

```bash
# Sync with default config
bun run sync

# Sync with custom config
bun run sync ./custom-config.jsonc

# Reset all synced data
bun run reset

# Type check
bun run build
```
