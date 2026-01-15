# new-api-sync

Sync pricing, groups, and channels from multiple upstream new-api providers to your own instance.

## Features

- **Multi-provider support**: Sync from multiple upstream new-api sites
- **Automatic token creation**: Creates tokens on upstream providers automatically
- **Idempotent**: Safe to run multiple times - upserts everything, deletes stale channels
- **Failover routing**: Configures auto-group with cheapest-first ordering
- **Pricing sync**: Syncs both input (ModelRatio) and output (CompletionRatio) pricing

## Quick Start

1. Copy the example config:
   ```bash
   cp config.example.json config.json
   ```

2. Edit `config.json` with your providers:
   ```json
   {
     "target": {
       "url": "https://your-instance.example.com",
       "adminToken": "sk-xxx"
     },
     "providers": [
       {
         "name": "newapi",
         "baseUrl": "https://www.newapi.ai",
         "accessToken": "your-system-access-token",
         "enabledGroups": ["aws-q", "cc", "gemini"],
         "priority": 10
       }
     ]
   }
   ```

3. Run sync:
   ```bash
   bun run sync
   ```

## Configuration

### Target

Your new-api instance where channels and settings will be synced.

### Providers

| Field           | Description                                              |
| --------------- | -------------------------------------------------------- |
| `name`          | Unique identifier, used as channel prefix                |
| `baseUrl`       | Provider URL (e.g., `https://www.newapi.ai`)             |
| `accessToken`   | System Access Token from provider's account settings     |
| `enabledGroups` | (Optional) Subset of groups to sync. Omit for all groups |
| `priority`      | (Optional) Higher = preferred in failover (default: 0)   |

## How It Works

1. For each provider: fetch `/api/pricing`, filter groups, ensure tokens exist
2. Merge all providers: GroupRatio, AutoGroups (cheapest first), ModelRatio, CompletionRatio
3. Update target options
4. Sync channels: upsert new, delete stale

### Channel Naming

Channels are named `{provider}-{group}`: `newapi-aws-q`, `newapi-cc`, etc.

### Failover Order

AutoGroups sorted by ratio (cheapest first). Failed requests retry on next cheapest.

## Multi-Provider Example

```json
{
  "target": {
    "url": "https://your-instance.example.com",
    "adminToken": "sk-xxx"
  },
  "providers": [
    {
      "name": "newapi",
      "baseUrl": "https://www.newapi.ai",
      "accessToken": "token-1",
      "enabledGroups": ["aws-q", "cc", "gemini"],
      "priority": 10
    },
    {
      "name": "provider2",
      "baseUrl": "https://other-newapi.example.com",
      "accessToken": "token-2",
      "priority": 5
    }
  ]
}
```
