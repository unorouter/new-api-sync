# new-api-sync

TypeScript/Bun project that syncs external AI providers into the new-api target.

## Key Files

| File | Purpose |
|------|---------|
| `src/lib/constants.ts` | Model type inference, endpoint types, vendor matchers, name patterns, testability checks |
| `src/lib/model-tester.ts` | Tests models against upstream (text request per channel type), partitions testable/non-testable |
| `src/lib/pricing.ts` | `resolvePriceAdjustment()` resolves per-model/vendor/type price adjustments from config |
| `src/lib/types.ts` | Shared type definitions |
| `src/lib/http.ts` | HTTP fetch utilities |
| `src/lib/metadata.ts` | Fetches model descriptions from OpenRouter and basellm |
| `src/providers/newapi/provider.ts` | Processes newapi providers: filters groups, tests models, builds channels via `buildGroupChannels()` |
| `src/providers/newapi/client.ts` | HTTP client for newapi instances (pricing, channels, tokens, models) |
| `src/providers/direct/provider.ts` | Direct vendor API key providers |
| `src/providers/direct/discovery.ts` | Auto-discovers models via OpenAI-compat `/v1/models` endpoint |
| `src/providers/sub2api/provider.ts` | sub2api subscription account providers |
| `src/providers/sub2api/client.ts` | HTTP client for sub2api instances |
| `src/providers/nvidia/provider.ts` | NVIDIA NIM provider: text (OpenAI-compat) + image (NIM channel type 58) |
| `src/providers/nvidia/discovery.ts` | Auto-discovers NVIDIA NIM text models |
| `src/lib/model-filter.ts` | Shared model filtering by glob patterns and blacklist (used by direct, nvidia, sub2api) |
| `src/cli.ts` | CLI entry point (Commander.js: `run`, `test`, `reset` commands) |
| `src/core/run.ts` | Full sync pipeline: snapshot, diff, apply |
| `src/core/test-runner.ts` | Test-only pipeline (no apply), saves results to `logs/` |
| `src/core/reset.ts` | Deletes sync-managed resources from target |
| `src/core/pipeline.ts` | Orchestrates providers, builds desired state (channels, models, options) |
| `src/core/diff.ts` | Computes diff between desired state and target snapshot |
| `src/core/apply.ts` | Applies diff to target new-api instance |
| `src/config.ts` | Config parsing and Zod schema (`config.jsonc` format) |

## Model Classification Flow

Models are classified by type (text/image/video/audio/embedding) through this chain:

1. `inferModelType()` in `constants.ts` checks `supported_endpoint_types` from upstream
2. Falls back to model name patterns (`NAME_PATTERN_TYPES`) when endpoints only report text types
3. Upstream instances may not report correct endpoint types (e.g. yunwu reports `["gemini", "openai"]` for image generation models)

`isTestableModel()` determines if a model can be tested with a text request:
- If endpoint data exists and contains a `NON_TESTABLE_ENDPOINT_TYPES` entry: skip
- If endpoint data exists and contains a `TEXT_ENDPOINT_TYPES` entry: testable
- Otherwise: fall back to `NON_TEXT_MODEL_PATTERNS` name check

## Price Adjustment Resolution

`resolvePriceAdjustment()` in `pricing.ts` resolves in this order:
1. Model name glob match against config keys (careful: `"image"` key matches model names containing "image")
2. Vendor name match
3. Model type match
4. `"default"` key

## Channel Creation Flow

`buildGroupChannels()` in `newapi/provider.ts`:
1. Groups models by effective ratio (base group ratio * price adjustment per model)
2. Creates one channel per ratio tier
3. Skips text model tiers with effective ratio > 1 (non-text tiers are allowed above 1)

If a model is misclassified as text when it's actually image/video, it gets filtered out by the ratio > 1 check.

## Debugging

### Check what upstream reports for a model

The sync tries `/api/pricing_new` (V1 format, array with `supported_endpoint_types` per model) first, then falls back to `/api/pricing` (V2 format, nested object without endpoint data).

```bash
# V1 format (pricing_new): has supported_endpoint_types, tags, model_type per model
curl -s "https://<upstream>/api/pricing_new" | jq '[.data[] | select(.model_name == "<model>")] | .[0]'

# V2 format (pricing): model info under .data.model_info, groups under .data.model_group
curl -s "https://<upstream>/api/pricing" | jq '.data.model_info["<model>"]'
curl -s "https://<upstream>/api/pricing" | jq '.data.model_group["<group>"]'
```

### Check target DB
```bash
ssh don "docker exec unorouter-new-api-postgres psql -U newapi -d newapi -t -c \"SELECT * FROM models WHERE model_name LIKE '%pattern%';\""
ssh don "docker exec unorouter-new-api-postgres psql -U newapi -d newapi -t -c \"SELECT id, name, models FROM channels WHERE models LIKE '%pattern%';\""
```

### Common issues
- Model tested but not created: check `inferModelType()` returns correct type, then check if effective ratio > 1 filters it in `buildGroupChannels()`
- Model not tested: check `isTestableModel()` and whether upstream provides endpoint data
- Wrong price adjustment: `resolvePriceAdjustment()` matches config keys as model name globs before checking model type
