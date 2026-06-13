---
title: "We tested 8 third-party Claude resellers for 17 days. 183 of their channels weren't actually serving Claude."
slug: claude-authenticity-investigation
date: 2026-04-26
---

# We tested 8 third-party Claude resellers for 17 days. 183 of their channels weren't actually serving Claude.

Claude is the most in-demand model on the market right now, and also one of the most expensive. That combination, high demand, premium price, has created a thriving market of third-party resellers offering "the same Claude" at a fraction of the official price. Some of them are legitimate. A lot of them aren't.

If you buy "Claude" from a reseller instead of from Anthropic directly, there's a non-trivial chance you're not getting Claude. You're getting a different model, sometimes a much weaker one, with the response dressed up to look like a Claude response.

We've been running automated probes against the Claude endpoints sold by third-party AI gateways for the last 17 days. The methodology is public, the code is open source, and across **8 upstream resellers** we found **183 (channel, model) pairs** that fail authenticity checks against models marketed as `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`, and friends.

The same demand-cheap-supply pressure exists for every premium model. **The same substitution pattern is almost certainly happening to GPT, Gemini, Grok, and every other premium model on these marketplaces.** Claude is just where the gap between official price and resold price is biggest right now, and where we have hard data so far. Probes for other vendors are next.

## How the probes work

Per (channel, model) we send four parallel requests to the standard Anthropic Messages API (`POST /v1/messages`):

| Probe          | Prompt                                                                    | Pass criteria                                                                |
| -------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **emotional**  | `Tell me a 2-sentence sad story about a lost kitten.`                     | No coding-refusal phrases; response ≥ 40 chars                               |
| **creative**   | `Write a haiku about the ocean at sunrise. Only the haiku, nothing else.` | No coding-refusal phrases; response ≥ 25 chars                               |
| **identity**   | `What company created you? Reply with only the company name, one word.`   | Contains `anthropic`; no coding-refusal; no foreign-vendor names             |
| **model-name** | `Which model are you? Reply with only your model name, nothing else.`     | Contains `claude` or `anthropic`; no coding-refusal; no foreign-vendor names |

Three failure types:

- **`coding-tool-refusal`**: response matches a known Kiro Cascade or Codeium / Windsurf Droid refusal pattern (`"I'm here to help with coding"`, `"that's outside what I can help with"`, `"I'm Droid, here to help with coding"`, etc.). The upstream is routing your request to an IDE-assistant product instead of Anthropic, and the product is refusing the prompt because it's not coding.
- **`foreign-identity`**: response identifies as a non-Anthropic vendor (OpenAI, Meta, DeepSeek, Moonshot, Mistral, Llama, Grok, etc.) when asked who made it.
- **`failed`**: wrong-style output without the above signals: no kitten story, no haiku, generic "AI assistant" answer, etc.

Pattern lists and probe code: [`src/core/models/testing/authenticity.ts`](https://github.com/unorouter/new-api-sync/blob/main/src/core/models/testing/authenticity.ts).

## What is _not_ spoofing: Bedrock, Vertex, Foundry

A reseller routing through **AWS Bedrock**, **Google Vertex AI**, or **Azure AI Foundry** is **not** spoofing. Those platforms host real Anthropic Claude weights under license. Same model, same training, same capabilities as `api.anthropic.com`. Buying capacity there at enterprise discount and reselling it is a normal supply chain.

The probes can produce **one false positive** in this case: cloud-hosted Claude sometimes answers the identity probe with `Amazon` / `Google` / `Microsoft` (its host) instead of `Anthropic`, because of system prompts those platforms inject. So a channel flagged _only_ by `foreign-identity` against cloud-host names warrants a manual second look. Channels flagged by **`coding-tool-refusal`** or by foreign vendors with no Claude licensing relationship (OpenAI, Meta, DeepSeek, Moonshot...) are unambiguous, real Bedrock/Vertex/Foundry Claude never produces those responses.

Of the 183 entries:

- **64 `coding-tool-refusal`**: spoofing, no legitimate reading.
- **115 `failed`**: spoofing in the overwhelming majority; failures cluster on emotional/creative/model-name probes, not just identity.
- **4 `foreign-identity`**: we inspected all four; each had additional probe failures beyond the identity answer alone, so we believe they're spoofed too. If you reproduce against your own cloud-hosted Claude and see a lone `foreign-identity` flag, check the other probes before assuming the worst.

## What 17 days of probing turned up

8 upstream resellers (anonymized as `provider-1`..`provider-8`), 183 (channel, model) entries between 2026-04-08 and 2026-04-24.

**By failure type:**

| Type                  | Count |
| --------------------- | ----- |
| `failed`              | 115   |
| `coding-tool-refusal` | 64    |
| `foreign-identity`    | 4     |

**Probe labels that triggered failures** (a channel can fail multiple):

| Probe      | Failures |
| ---------- | -------- |
| emotional  | 110      |
| model-name | 88       |
| identity   | 79       |
| creative   | 47       |

**`emotional` being the biggest catcher is the smoking gun.** Real Claude does not refuse to write a 2-sentence sad story about a kitten. A coding-tool backend dressed as Claude does, every time.

**By upstream reseller:**

| Provider   | Bad channels |
| ---------- | ------------ |
| provider-1 | 58           |
| provider-2 | 30           |
| provider-3 | 29           |
| provider-4 | 21           |
| provider-5 | 17           |
| provider-6 | 15           |
| provider-7 | 8            |
| provider-8 | 5            |

**By Claude model marketed:**

| Model                                  | Bad channels |
| -------------------------------------- | ------------ |
| claude-opus-4-6                        | 27           |
| claude-sonnet-4-6                      | 23           |
| claude-sonnet-4-6-thinking             | 21           |
| claude-haiku-4-5-20251001              | 20           |
| **claude-opus-4-7** (current flagship) | **16**       |
| claude-opus-4-6-thinking               | 14           |
| claude-opus-4-5-20251101               | 12           |
| claude-haiku-4-5-20251001-thinking     | 11           |
| claude-sonnet-4-5-20250929             | 10           |
| claude-opus-4-5-20251101-thinking      | 8            |
| claude-sonnet-4-5-20250929-thinking    | 8            |
| claude-haiku-4-5                       | 5            |
| (others)                               | 8            |

Older Claude variants have higher absolute counts only because they've been on the market longer. Opus 4.7 hit 16 spoofed channels within weeks of release.

**Detections over time:**

```
2026-04-08  +42 entries     2026-04-16  +18
2026-04-11  +18             2026-04-17   +6
2026-04-12   +3             2026-04-19  +11
2026-04-13   +5             2026-04-20   +7
2026-04-14  +13             2026-04-21  +30
2026-04-15  +12             2026-04-24  +18
```

This isn't a static snapshot. Resellers rotate upstreams. A channel that passes today can start serving Kiro tomorrow if the reseller's cheap path goes down. **Authenticity has to be checked continuously.**

## Why this happens

Real Claude is expensive whether you buy from Anthropic or from a licensed cloud reseller (Bedrock/Vertex/Foundry). A reseller advertising Claude below the cheapest licensed price has four options:

1. Eat the loss to acquire users (sustainable only with deep funding).
2. Buy Bedrock/Vertex/Foundry capacity at enterprise discount and resell it. **Legitimate**, but the price floor is still set by what those clouds charge.
3. Run a fraction of traffic through real Claude and route the rest somewhere cheaper, banking on most users not noticing.
4. Route everything through a non-Anthropic backend and hope nobody checks.

Options 3 and 4 are what the probes catch. Coding tools like Kiro and Codeium are tempting backends for option 4 because they have free / near-free personal-use quotas and Anthropic-compatible response shapes. Output looks structurally correct, just stylistically wrong, and most users never notice unless they ask the model something non-coding.

## What's next

We expect (but haven't yet confirmed with the same rigor) the same substitution against:

- **GPT-5.5** (substituted with older GPT versions, OpenAI-compatible distillations, or quantized hosts)
- **Gemini 3.1 Pro** (substituted with smaller Gemini variants or non-Google models entirely)
- **Grok 4.20** (substituted with cheaper general-purpose chat models passed off as the latest xAI release)
- **DeepSeek / Kimi / Qwen latest-version** (silently downgraded to older or smaller variants)

The probe pattern generalizes: pick prompts that produce a stylistically distinctive response from the real model and a recognizably wrong response from anything else. We're extending the suite to these vendors next. PRs welcome with refusal patterns you've seen in the wild.

## Test your own provider in 5 minutes

```bash
curl https://YOUR-PROVIDER/v1/messages \
  -H "x-api-key: $YOUR_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-opus-4-7",
    "max_tokens": 150,
    "messages": [{
      "role": "user",
      "content": "Tell me a 2-sentence sad story about a lost kitten."
    }]
  }'
```

If the response refuses or redirects to coding, your "Claude" is not Claude. Then run the identity probe, content `"What company created you? Reply with only the company name, one word."`, and if the answer isn't `Anthropic`, you have your answer.

---

The Anthropic API is the only authoritative source of Claude. Everything else is a routing decision someone else made on your behalf, and routing decisions can be wrong. Catching them is cheap. We're publishing the tests so nobody has to take anyone's word for it.

**Try the gateway:** [unorouter.com](https://unorouter.com), free tier, rate-limited, no card. File a reproducible bug or a feature request we ship and we'll add API credit to your account.

**Open source probe suite:** [link to repo](https://github.com/unorouter/new-api-sync)
