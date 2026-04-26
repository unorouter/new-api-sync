---
title: "We tested 8 third-party Claude resellers for 17 days. 183 of their channels weren't actually serving Claude."
slug: claude-authenticity-investigation
date: 2026-04-26
---

# We tested 8 third-party Claude resellers for 17 days. 183 of their channels weren't actually serving Claude.

If you buy "Claude" from a reseller instead of from Anthropic directly, there's a non-trivial chance you're not getting Claude. You're getting a different model, sometimes a much weaker one, with the response dressed up to look like a Claude response.

This isn't a hunch. We've been running automated probes against the Claude endpoints sold by third-party AI gateways for the last 17 days. The probes are simple, the methodology is public, and the results are unambiguous: a large fraction of channels marketed as `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`, and friends are not running Claude at all.

We focused on Claude because Claude is the model people most aggressively try to resell on the cheap right now. **The same substitution pattern is almost certainly happening to GPT, Gemini, DeepSeek, and every other premium model on the same gateway marketplaces.** Claude is just where the demand is loudest, the margins are thinnest, and where we had the strongest signal to design tests around. The probe approach generalizes to any model with a recognizable identity and output style; we're starting with Claude and expanding from there.

Here's what we found, how we found it, and how to test your own provider in five minutes.

## TL;DR

- We probed Claude endpoints from **8 distinct upstream resellers** between 2026-04-08 and 2026-04-24.
- **183 (channel, model) pairs failed authenticity checks.**
- **64** of those failures matched the signature of Kiro Cascade or Codeium being served as "Claude": the model refuses normal requests with stock developer-tool boilerplate ("I'm here to help with coding", "that's outside what I can help with").
- **115** failed Anthropic identity checks: wrong company name, wrong model name, or output style that does not match Claude's.
- **4** explicitly identified themselves as a non-Anthropic vendor when asked who made them. (Note: cloud-hosted Claude on AWS Bedrock, Google Vertex, and Azure AI Foundry is **legitimate** real Claude. We discuss that distinction in detail below.)
- Every modern Claude variant is on the list, including the current flagship **Opus 4.7**. The previous-generation Opus 4.6, Sonnet 4.6, and Sonnet 4.6 thinking have the highest absolute counts simply because they've been on the market longer; Opus 4.7 was already at 16 spoofed channels within weeks of release.
- **Claude is the focus, not the limit.** The same gateways resell GPT, Gemini, DeepSeek, Kimi, and others. We expect the same substitution to be happening there too; this post documents what we have hard data on so far.
- The whole probe suite is open source and runs against any Anthropic-compatible endpoint. Probes for other vendors are next.

## What "spoofed" means here

We are not claiming these resellers are running adversarial fine-tunes designed to fool a Turing test. We're claiming something simpler and more provable: when you ask a normal question, you get back a response that no real Claude model would ever produce.

There are three failure modes we see consistently.

**1. Coding-assistant refusals from a non-Claude product.**

If you ask real Claude `Tell me a 2-sentence sad story about a lost kitten`, it writes you a story. It does not hesitate. It does not redirect you to coding tasks. Many resold "Claude" channels respond with phrases like:

> "I'm here to help with coding, development workflows, CLI commands..."
> "That's outside what I can help with. I'm focused on software development..."
> "I'm Droid, here to help with coding..."
> "Let me clarify my actual role..."

These are the canned refusal patterns of **Kiro Cascade** and **Codeium / Windsurf's Droid**. They're products built for IDE assistance, not general-purpose chat. When a "Claude" channel produces them, the upstream is routing your request through one of those tools instead of through Anthropic, and the tool is refusing the prompt because it's not coding.

**2. Wrong model identity.**

We ask `What company created you? Reply with only the company name, one word.` Real Claude says `Anthropic`. Spoofed channels return `OpenAI`, `Meta`, `DeepSeek`, `Moonshot`, or other vendors that have no licensing relationship with Anthropic. Those answers mean the response is coming from a different model entirely.

(Cloud-hosted Claude is a separate case: Claude on AWS Bedrock, Google Vertex, or Azure AI Foundry sometimes mentions Amazon, Google, or Microsoft because that's its hosting environment. Those are legitimate, licensed deployments of real Anthropic weights. See "What is *not* spoofing" below.)

**3. Wrong model name.**

We ask `Which model are you? Reply with only your model name, nothing else.` Real Claude reports a Claude model. Spoofed channels report `gpt-4`, `gemini`, `llama`, or (most amusingly) describe themselves as a generic "AI assistant" with no model name at all.

## What is *not* spoofing: Bedrock, Vertex, Foundry

Before going further, an important clarification, because it's a common and **legitimate** pattern.

A reseller routing your "Claude" request through **AWS Bedrock**, **Google Vertex AI**, or **Azure AI Foundry** is not spoofing. Those three platforms host real, official Anthropic Claude weights under licensed agreements with Anthropic. The model you get back from a Bedrock-hosted Claude endpoint is the same model you'd get from `api.anthropic.com`, with the same weights, the same training, and the same capabilities. The output is not stylistically different in any way our probes can detect, because it isn't different.

This is why a lot of legitimate resellers exist at all: they buy capacity through Bedrock/Vertex/Foundry (often at enterprise volume discounts) and resell access to it. That's a normal supply chain, the same way a CDN resells AWS bandwidth or a data center resells colocated power. The model is real.

Our probes can produce **false positives** against legitimate cloud-hosted Claude in one specific case: if the model, when asked "what company created you?", names its hosting platform (`Amazon`, `Google`, `Microsoft`) instead of `Anthropic`. We've seen Bedrock-hosted Claude do this occasionally because the system prompts those platforms inject can shift the model's answer to identity questions. We're treating that as a known limitation:

- Channels flagged only by `foreign-identity` against `amazon`, `aws`, `bedrock`, `google`, `vertex`, `azure`, or `foundry` need a manual second look before being called spoofed.
- Channels flagged by **`coding-tool-refusal`** are categorically different. Real Claude on Bedrock, Vertex, or Foundry does not produce Kiro/Codeium boilerplate. Ever. A `coding-tool-refusal` is unambiguous evidence that the upstream is not Anthropic-licensed Claude in any form.
- Channels flagged by **identity probes against non-cloud foreign vendors** (OpenAI, Meta, DeepSeek, Moonshot, etc.) are also unambiguous: those vendors do not host Claude under any agreement, so the response cannot be coming from real Claude.
- Channels flagged by the **emotional**, **creative**, and **model-name** probes are also unaffected by the cloud-hosting caveat: Bedrock/Vertex/Foundry Claude writes the kitten story, writes the haiku, and reports a Claude model name correctly.

So of the 183 entries in our blacklist, the rule of thumb is:

- The **64 `coding-tool-refusal` entries** are spoofing. There is no legitimate reading.
- The **115 `failed:` entries** are spoofing in the overwhelming majority of cases (the failures are clustered on emotional/creative/model-name probes, not just identity).
- The **4 `foreign-identity` entries** are the ones that warrant a manual second look. We've inspected all four and the evidence in each case includes additional probe failures beyond just the company-name answer, so we're confident they're spoofed too, but if you reproduce the test against your own cloud-hosted Claude and see a `foreign-identity` flag in isolation, don't assume the worst without checking the other probes first.

We're updating the probe suite to whitelist the legitimate cloud-host names when they appear *alongside* a correct Claude model identity, so this edge case stops generating noise. Pull requests welcome.

## How the probes work

Per (channel, model) we send four parallel requests to the standard Anthropic Messages API (`POST /v1/messages`):

| Probe          | Prompt                                                                    | Pass criteria                                                                        |
| -------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **emotional**  | `Tell me a 2-sentence sad story about a lost kitten.`                     | No coding-refusal phrases; response ≥ 40 chars                                       |
| **creative**   | `Write a haiku about the ocean at sunrise. Only the haiku, nothing else.` | No coding-refusal phrases; response ≥ 25 chars                                       |
| **identity**   | `What company created you? Reply with only the company name, one word.`   | Contains "anthropic"; no coding-refusal phrases; no foreign-vendor names             |
| **model-name** | `Which model are you? Reply with only your model name, nothing else.`     | Contains "claude" or "anthropic"; no coding-refusal phrases; no foreign-vendor names |

If any probe response contains a known Kiro/Codeium refusal pattern, the channel is flagged as `coding-tool-refusal`. If any response identifies as a different vendor (AWS, Google, OpenAI, DeepSeek, Qwen, Moonshot, Mistral, Llama, Grok, etc.), the channel is flagged as `foreign-identity`. If the channel just produces wrong-style output without those signals, it's flagged `failed:` plus the probe labels that didn't pass.

The full pattern lists and the probe code are here:

```
src/core/models/testing/authenticity.ts
```

Anyone can clone it, point it at any Anthropic-compatible endpoint, and reproduce the result.

## What 17 days of probing turned up

Across 8 upstream resellers (anonymized as `provider-1` through `provider-8`), our blacklist accumulated **183** (channel, model) entries:

**By failure type:**

| Type                                                 | Count |
| ---------------------------------------------------- | ----- |
| `failed` (general identity / output mismatch)        | 115   |
| `coding-tool-refusal` (Kiro / Codeium boilerplate)          | 64    |
| `foreign-identity` (claims to be a non-Claude model) | 4     |

**Probe labels that triggered failures (a single channel can fail multiple):**

| Probe      | Failure count |
| ---------- | ------------- |
| emotional  | 110           |
| model-name | 88            |
| identity   | 79            |
| creative   | 47            |

The fact that **emotional** is the single biggest catcher is the smoking gun. Real Claude does not refuse to write a 2-sentence sad story about a kitten. A coding-tool backend dressed as Claude does, every time.

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

| Model                               | Bad channels claiming to serve it |
| ----------------------------------- | --------------------------------- |
| claude-opus-4-6                     | 27                                |
| claude-sonnet-4-6                   | 23                                |
| claude-sonnet-4-6-thinking          | 21                                |
| claude-haiku-4-5-20251001           | 20                                |
| claude-opus-4-7                     | 16                                |
| claude-opus-4-6-thinking            | 14                                |
| claude-opus-4-5-20251101            | 12                                |
| claude-haiku-4-5-20251001-thinking  | 11                                |
| claude-sonnet-4-5-20250929          | 10                                |
| claude-opus-4-5-20251101-thinking   | 8                                 |
| claude-sonnet-4-5-20250929-thinking | 8                                 |
| claude-haiku-4-5                    | 5                                 |
| (others)                            | 8                                 |

**Detections over time:**

```
2026-04-08  +42 entries
2026-04-11  +18
2026-04-12   +3
2026-04-13   +5
2026-04-14  +13
2026-04-15  +12
2026-04-16  +18
2026-04-17   +6
2026-04-19  +11
2026-04-20   +7
2026-04-21  +30
2026-04-24  +18
```

This isn't a static snapshot. Resellers rotate upstreams. A channel that passes today can start serving Kiro tomorrow if the reseller's cheap path goes down or their margins get squeezed. Authenticity has to be checked continuously, not once.

## Why this happens

The economics are simple. Real Claude API access is expensive, whether you buy it from Anthropic directly or from a licensed cloud reseller (AWS Bedrock, Google Vertex, Azure AI Foundry). A reseller advertising Claude at half the cheapest licensed price has roughly four options:

1. Eat the loss to acquire users (sustainable only with deep funding).
2. Buy capacity at enterprise-volume discounts on Bedrock/Vertex/Foundry and resell it. **This is legitimate** and the model stays real, but the price floor is still set by what those cloud providers charge.
3. Run a small fraction of traffic through real (Anthropic or cloud-licensed) Claude and route the rest somewhere cheaper, banking on most users not noticing.
4. Route everything through a cheaper non-Anthropic backend and hope nobody checks.

Options 3 and 4 are what authenticity probes catch. Coding tools like Kiro and Codeium are particularly tempting backends for option 4 because they have generous personal-use quotas and Anthropic-compatible response shapes. The "Claude" output looks structurally correct, just stylistically wrong, and most users never notice unless they ask the model to do something non-coding.

## Why we started with Claude (and what's next)

We don't think Claude is the only model getting substituted. We started with Claude for three reasons:

1. **Demand and price gap.** Claude Opus and Sonnet are the most expensive frontier models on the market right now, and at the same time the most-asked-for on reseller marketplaces. The bigger the gap between official price and resold price, the bigger the incentive to substitute the backend.
2. **Strongest signal.** Real Claude has an unusually distinctive style: willingness to engage emotional/creative prompts, consistent identity answers, refusal patterns that are nothing like Kiro's or Codeium's. That makes spoofing easier to detect than for, say, generic chat assistants where any plausible reply could pass.
3. **A specific cheap backend exists.** Kiro Cascade and Codeium / Windsurf's Droid have free or near-free quotas, Anthropic-compatible response shapes, and recognizable refusal text. They're a ready-made substitute that resellers can wire up in an afternoon. We don't yet know of a similarly turnkey substitute for GPT-5 or Gemini, but the economic pressure is identical, so we expect the substitutes to exist or to emerge.

What we expect (but have not yet confirmed with the same rigor) is that the same gateways are doing the same thing to:

- **GPT-4 / GPT-5 / o-series channels** (substituted with cheaper OpenAI-compatible models, open-weight distillations, or quantized hosts)
- **Gemini Pro / Ultra channels** (substituted with smaller Gemini variants or non-Google models entirely)
- **DeepSeek / Kimi / Qwen channels marketed as the latest version** (silently downgraded to older or smaller variants)

The probe pattern is the same for every model: pick prompts that produce a stylistically distinctive response when answered by the real model, and that produce a recognizably wrong response when answered by anything else. We're extending the test suite to GPT, Gemini, and the major Chinese open-source families next. The architecture is already there; it's just additional probe definitions per vendor.

If you operate a gateway, run a model-quality benchmark, or just have a strong intuition about how a specific model "should" sound, we'd take pull requests. The probe interface is small.

## How to test your own provider in 5 minutes

If you're paying for Claude through any third-party gateway, you can run these four prompts yourself. No tooling required, just curl or a Postman tab.

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

If the response refuses, redirects to coding, or says anything resembling "I'm here to help with development", your "Claude" is not Claude. Repeat with the identity prompt:

```json
{
  "role": "user",
  "content": "What company created you? Reply with only the company name, one word."
}
```

If the answer is anything other than `Anthropic`, you have your answer.

## What we built around this

We run these probes continuously against every upstream channel before exposing it to users, and channels that fail go on a blacklist that's checked on every routing decision. The probe code, the blacklist format, the gateway, and the entire stack are open source. You can self-host the same thing we run in production, or just borrow the probe suite and run it against whatever gateway you're already using.

If you want to skip self-hosting, we offer the routed endpoint at [unorouter.ai](https://unorouter.ai): same authenticity guarantees, free tier with rate limits to try it without a card, paid tier for production use. The free tier exists specifically so you can compare its Claude output against your current provider's. Run the four prompts above against both, side by side. The difference is not subtle.

## A note on naming names

This post anonymizes the upstream resellers because the goal is to make the **methodology** the story, not eight specific companies. Anyone running the open-source probe suite can produce their own list and decide whether to publish names. We've contacted each of the affected resellers with the data we have. If they fix their routing, channels come off the blacklist automatically; the test reruns every day.

If you operate a reseller and want to verify your own channels against this suite before customers start asking, the code is here:

- Repo: [link]
- Probe source: `src/core/models/testing/authenticity.ts`
- Open an issue or PR with additional refusal patterns you've seen in the wild.

## What to do with this

If you're a developer paying for "Claude" through any third party:

1. Run the four prompts above today against your current provider.
2. Compare against [console.anthropic.com](https://console.anthropic.com) on the same prompts.
3. If they don't match, you're not getting what you paid for.

If you're a reseller:

1. Run the probe suite against your own upstreams before listing them.
2. Don't list a "Claude" channel that fails any of these four checks.
3. Recheck daily, your upstreams will swap models on you without warning.

The Anthropic API is the only authoritative source of Claude. The OpenAI API is the only authoritative source of GPT. Google's API is the only authoritative source of Gemini. Everything else is a routing decision someone else made on your behalf, and routing decisions can be wrong. The good news is that catching them is cheap. We're publishing the tests so nobody has to take anyone's word for it (including ours), and we'll keep extending them to every model that ends up on these gateways.

---

**Try the gateway:** [unorouter.ai](https://unorouter.ai), free tier, rate-limited, no card. We'll add API credit to your account if you file a reproducible bug or a feature request we ship.

**The probe suite is open source:** [link to repo]

**Discussion:** [comment thread / forum link]
