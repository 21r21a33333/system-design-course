---
title: "Semantic Caching"
sidebar_position: 5
supplementary: true
---

Semantic caching stores LLM responses keyed by the *meaning* of the
prompt — measured as embedding similarity — rather than an exact string
match, so that a paraphrased but equivalent query can still hit the
cache.

## Problem it solves

A conventional cache keyed on the exact request string is nearly
useless for LLM traffic, because the same underlying question rarely
arrives as the same literal text. "What's your refund policy?" and
"How do refunds work?" are semantically identical requests that would
miss an exact-match cache every time, forcing a full — and expensive —
LLM call for both. Given that LLM calls are priced per token and add
meaningful latency, a cache that can only catch byte-identical repeats
captures a small fraction of the redundant traffic a real system sees.

## How it works

Each incoming prompt is converted to an embedding vector. Instead of
looking up an exact key, the cache performs a nearest-neighbor search
against previously cached prompt embeddings (typically backed by a
vector database or in-memory ANN index). If a cached prompt's embedding
is within a configured similarity threshold of the new prompt's
embedding, the cache treats them as equivalent and returns the stored
response instead of calling the LLM. If no sufficiently similar entry
exists, the request proceeds to the model as normal, and its prompt
and response are added to the cache for future lookups. The one
configuration decision that determines whether this works well is the
similarity threshold.

## When to use it

- High-traffic LLM-backed features (support chatbots, search
  assistants, FAQ-style queries) where many distinct users ask
  semantically similar questions in different words.
- Cost and latency from repeated, near-duplicate LLM calls are
  measurable problems worth trading some cache-accuracy risk to
  reduce.
- Responses are relatively stable and don't need to vary per exact
  phrasing of a question.

## When not to use it

- Responses must be deterministic and exactly reproducible per unique
  input — even prompts that are semantically close but not identical
  may warrant genuinely different answers (e.g. anything
  personalized, transactional, or safety-sensitive). The similarity
  threshold is a precision/recall tradeoff with real consequences on
  both sides: set it too loose, and prompts that are related but not
  actually equivalent — "cancel my subscription" versus "pause my
  subscription" — get treated as cache hits, and the caller receives a
  wrong or subtly mismatched answer with no signal that anything went
  wrong.
- Traffic has little repetition, or diversity in phrasing is low
  enough that an exact-match cache already captures most of the
  benefit at lower risk. Set the threshold too tight instead and the
  cache rarely matches anything, eroding the savings that motivated
  using it in the first place — tuning this threshold correctly is the
  central design decision of this pattern.

## Real-world example

Azure API Management's AI gateway offers semantic caching as a built-in
policy for LLM APIs, comparing the vector proximity of an incoming
prompt against previously cached completions to decide whether to
reuse a stored response instead of forwarding the request to the model
backend.

## Related patterns

- [Cache](/docs/concepts/cache) — the primer's general treatment of
  caching; semantic caching is a specialization of the same idea keyed
  by meaning instead of an exact key.
- [LLM Gateway](/docs/patterns/ai-infra/llm-gateway) — semantic caching
  is commonly implemented as a policy inside the gateway, since it
  already sees every prompt and response.

## Further reading

- [Semantic similarity — Wikipedia](https://en.wikipedia.org/wiki/Semantic_similarity)
- [AI gateway capabilities in Azure API Management](https://learn.microsoft.com/en-us/azure/api-management/genai-gateway-capabilities)
