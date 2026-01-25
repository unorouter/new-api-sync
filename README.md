# new-api-sync

Declarative multi-provider sync for [new-api](https://github.com/Calcium-Ion/new-api) instances. Syncs pricing, groups, channels, and models from upstream providers to your own instance.

## Features

- **Multi-provider support** — Sync from multiple new-api and Neko instances
- **Model testing** — Validates models actually work before creating channels
- **Glob pattern filtering** — Filter models with patterns like `claude-*-4-5`
- **Vendor filtering** — Sync only specific vendors (anthropic, openai, google, etc.)
- **Blacklist** — Exclude groups/models by keyword
- **Dynamic priority** — Faster providers get higher priority automatically
- **Price multipliers** — Per-provider billing adjustments
- **Idempotent** — Safe to run repeatedly; upserts everything, cleans up stale data

## Quick Start

```bash
# Install dependencies
bun install

# Copy and edit config
cp config.example.json config.json

# Run sync
bun run sync

# Reset (delete all synced data)
bun run reset
```

## Configuration

```json
{
  "target": {
    "baseUrl": "https://your-instance.example.com",
    "systemAccessToken": "your-system-access-token",
    "userId": 1
  },
  "blacklist": ["nsfw", "kiro"],
  "providers": [
    {
      "type": "newapi",
      "name": "provider1",
      "baseUrl": "https://upstream-provider.com",
      "systemAccessToken": "provider-system-token",
      "userId": 12345,
      "enabledVendors": ["anthropic", "openai"],
      "enabledModels": ["claude-*-4-5", "gpt-5"],
      "priceMultiplier": 0.5,
      "priority": 10
    },
    {
      "type": "neko",
      "name": "neko",
      "baseUrl": "https://nekocode.ai",
      "sessionToken": "session-cookie-value",
      "enabledVendors": ["anthropic"],
      "priceMultiplier": 0.25
    }
  ]
}
```

### Target

Your new-api instance where channels and settings will be synced.

| Field | Description |
|-------|-------------|
| `baseUrl` | Your instance URL |
| `systemAccessToken` | System Access Token (Settings → Other) |
| `userId` | Your user ID |

### Providers

#### new-api Provider (`type: "newapi"` or omit type)

| Field | Required | Description |
|-------|----------|-------------|
| `name` | ✓ | Unique identifier, used as channel tag |
| `baseUrl` | ✓ | Provider URL |
| `systemAccessToken` | ✓ | System Access Token from provider |
| `userId` | ✓ | Your user ID on the provider |
| `enabledGroups` | | Specific groups to sync (omit for all) |
| `enabledVendors` | | Filter by vendor: `anthropic`, `openai`, `google`, etc. |
| `enabledModels` | | Glob patterns: `["claude-*-4-5", "gpt-5"]` |
| `priceMultiplier` | | Multiply group ratios (e.g., `0.5` = 50% markup) |
| `priority` | | Base priority for channels (default: 0) |

#### Neko Provider (`type: "neko"`)

| Field | Required | Description |
|-------|----------|-------------|
| `name` | ✓ | Unique identifier |
| `baseUrl` | ✓ | Neko instance URL |
| `sessionToken` | ✓ | Session cookie value |
| `enabledVendors` | | Filter by vendor |
| `enabledModels` | | Glob patterns |
| `priceMultiplier` | | Price multiplier |

### Blacklist

Global blacklist applies to group names, descriptions, and model names:

```json
{
  "blacklist": ["nsfw", "kiro", "奇罗"]
}
```

### Model Patterns

`enabledModels` supports glob patterns:

- `claude-*-4-5` — Matches `claude-sonnet-4-5-20250514`, `claude-opus-4-5-20251101`
- `gpt-5` — Exact substring match
- `*-preview` — Matches anything ending in `-preview`

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
- `claude-neko`

### Priority & Failover

- **AutoGroups** sorted by ratio (cheapest first)
- **Dynamic priority** from response time: faster = higher priority
- Failed requests automatically retry on next available channel

## Project Structure

```
src/
├── sync.ts              # Entry point
├── reset.ts             # Reset/cleanup entry point
├── clients/
│   ├── newapi-client.ts # NewApiClient class (unified for target + providers)
│   └── neko-client.ts   # NekoClient class
├── service/
│   ├── sync.ts          # SyncService class
│   └── model-tester.ts  # ModelTester class
└── lib/
    ├── config.ts        # Config loading/validation
    ├── constants.ts     # Constants and utility functions
    └── types.ts         # TypeScript interfaces
```

## Commands

```bash
# Sync with default config
bun run sync

# Sync with custom config
bun run sync ./custom-config.json

# Reset all synced data
bun run reset

# Type check
bun run typecheck
```
