# proxy-sync

Declarative multi-provider sync for new-api instances. Sync pricing, groups, and channels from multiple upstream API proxy sites to your own new-api instance with automatic failover.

## Features

- **Multi-provider support**: Sync from multiple upstream new-api sites
- **Automatic token creation**: Creates tokens on upstream providers automatically
- **Idempotent**: Run multiple times safely - upserts everything, deletes stale resources
- **Failover routing**: Configures auto-group with cheapest-first ordering
- **Model pricing sync**: Syncs both input (ModelRatio) and output (CompletionRatio) pricing

## Quick Start

1. Copy the example config:
   ```bash
   cp config.example.json config.json
   cp .env.example .env
   ```

2. Edit `.env` with your credentials:
   ```bash
   # Target instance (your new-api)
   ADMIN_TOKEN=your-admin-token

   # Provider: packyapi
   PACKYAPI_ACCESS_TOKEN=your-access-token
   PACKYAPI_USER_ID=123
   ```

3. Edit `config.json` with your providers:
   ```json
   {
     "target": {
       "url": "https://ai-api.coding.global",
       "adminToken": "${ADMIN_TOKEN}"
     },
     "providers": [
       {
         "name": "packyapi",
         "baseUrl": "https://packyapi.com",
         "auth": {
           "accessToken": "${PACKYAPI_ACCESS_TOKEN}",
           "userId": "${PACKYAPI_USER_ID}"
         },
         "enabledGroups": ["aws-q", "cc", "gemini"],
         "priority": 10
       }
     ]
   }
   ```

4. Run sync:
   ```bash
   bun run sync
   ```

## Configuration

### Target

Your new-api instance where channels and settings will be synced.

```json
{
  "target": {
    "url": "https://ai-api.coding.global",
    "adminToken": "${ADMIN_TOKEN}"
  }
}
```

### Providers

Upstream new-api sites to sync from. Each provider requires:

| Field | Description |
|-------|-------------|
| `name` | Unique identifier, used as group prefix (e.g., `packyapi-aws-q`) |
| `baseUrl` | Provider URL (e.g., `https://packyapi.com`) |
| `auth.accessToken` | Your access token from the provider's account settings |
| `auth.userId` | Your user ID on the provider |
| `enabledGroups` | (Optional) Subset of groups to sync. Omit for all groups |
| `priority` | (Optional) Higher = preferred in failover (default: 0) |

### Options

```json
{
  "options": {
    "tokenNamePrefix": "ai-api-sync",
    "deleteStaleChannels": true
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `tokenNamePrefix` | `"proxy-sync"` | Prefix for tokens created on upstream |
| `deleteStaleChannels` | `true` | Delete channels for removed providers/groups |

### Environment Variables

Config values support `${VAR_NAME}` interpolation from environment variables.

## How It Works

### Sync Flow

```
1. For each provider:
   - Fetch /api/pricing → groups, models, ratios
   - Filter to enabledGroups (if specified)
   - Ensure tokens exist on upstream (create if missing)
   - Collect: prefixed groups, model ratios, channel specs

2. Merge all providers:
   - GroupRatio: { "packyapi-aws-q": 0.15, "otherprovider-cheap": 0.2, ... }
   - AutoGroups: sorted by ratio (cheapest first)
   - ModelRatio + CompletionRatio: merged (lowest wins for duplicates)

3. Update target options

4. Sync channels:
   - Upsert: create or update each provider-group channel
   - Delete: remove stale channels (provider prefix match but not in config)
```

### Channel Naming

Channels are named `{provider}-{group}`:
- `packyapi-aws-q`
- `packyapi-cc`
- `otherprovider-cheap`

### Failover Order

AutoGroups are sorted by ratio (cheapest first). When a request fails on one channel, it automatically retries on the next cheapest option.

Example order:
```
packyapi-aws-q (0.15x) → otherprovider-cheap (0.2x) → packyapi-gemini (0.6x) → packyapi-cc (1.0x)
```

### Token Management

Tokens are created on upstream providers with:
- Name: `{tokenNamePrefix}-{group}` (e.g., `ai-api-sync-aws-q`)
- Unlimited quota
- Never expires

Existing tokens with matching names are reused.

## Multi-Provider Example

```json
{
  "target": {
    "url": "https://ai-api.coding.global",
    "adminToken": "${ADMIN_TOKEN}"
  },
  "providers": [
    {
      "name": "packyapi",
      "baseUrl": "https://packyapi.com",
      "auth": {
        "accessToken": "${PACKYAPI_ACCESS_TOKEN}",
        "userId": "${PACKYAPI_USER_ID}"
      },
      "enabledGroups": ["aws-q", "cc", "gemini"],
      "priority": 10
    },
    {
      "name": "otherprovider",
      "baseUrl": "https://other-api.com",
      "auth": {
        "accessToken": "${OTHER_ACCESS_TOKEN}",
        "userId": "${OTHER_USER_ID}"
      },
      "priority": 5
    }
  ],
  "options": {
    "tokenNamePrefix": "ai-api-sync"
  }
}
```

Result on your instance:
- **Groups**: `packyapi-aws-q`, `packyapi-cc`, `packyapi-gemini`, `otherprovider-*`, `auto`
- **Channels**: One per provider-group combination
- **AutoGroups**: All groups sorted by ratio for failover

## Programmatic Usage

```typescript
import { sync, loadConfig } from "./src";

// From config file
const config = await loadConfig("./config.json");
const report = await sync(config);

// Or inline config
const report = await sync({
  target: {
    url: "https://ai-api.coding.global",
    adminToken: process.env.ADMIN_TOKEN!,
  },
  providers: [
    {
      name: "packyapi",
      baseUrl: "https://packyapi.com",
      auth: {
        accessToken: process.env.PACKYAPI_ACCESS_TOKEN!,
        userId: Number(process.env.PACKYAPI_USER_ID!),
      },
    },
  ],
});

console.log(report);
// {
//   success: true,
//   providers: [{ name: "packyapi", success: true, groups: 14, ... }],
//   channels: { created: 2, updated: 5, deleted: 1 },
//   options: { updated: ["GroupRatio", "AutoGroups", ...] },
//   errors: []
// }
```

## Cron Setup

Run sync periodically to keep pricing up to date:

```bash
# Every hour
0 * * * * cd /path/to/proxy-sync && bun run sync >> /var/log/proxy-sync.log 2>&1
```

## File Structure

```
proxy-sync/
├── src/
│   ├── main.ts              # Entry point
│   ├── index.ts             # Exports: sync, loadConfig, clients, types
│   ├── sync.ts              # Main sync orchestration
│   ├── types.ts             # All type definitions
│   ├── clients/
│   │   ├── upstream-client.ts  # Fetch pricing, create/get tokens on upstream
│   │   └── target-client.ts    # Update options, upsert/delete channels on target
│   └── lib/
│       ├── config.ts        # JSON loader with ${ENV_VAR} interpolation
│       └── utils.ts         # Logging helpers
├── config.json              # Your config (gitignored)
├── config.example.json      # Example config
├── .env                     # Your secrets (gitignored)
├── .env.example             # Example env vars
├── package.json
├── tsconfig.json            # With @/* path alias to src/*
└── README.md
```

## License

MIT
