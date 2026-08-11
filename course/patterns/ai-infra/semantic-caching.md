---
title: "Semantic Caching"
sidebar_position: 5
supplementary: true
---

Semantic caching stores LLM responses keyed by the *meaning* of the
prompt — measured as embedding similarity — rather than an exact string
match, so that a paraphrased but equivalent query can still hit the
cache.

![Semantic Caching diagram](/img/patterns/semantic-caching.svg)

## Problem it solves

A conventional cache keyed on the exact request string is nearly
useless for LLM traffic, because the same underlying question rarely
arrives as the same literal text. "What's your refund policy?" and
"How do refunds work?" are semantically identical requests that would
miss an exact-match cache every time, forcing a full — and expensive —
LLM call for both. Given that LLM calls are priced per token and add
meaningful latency, a cache that can only catch byte-identical repeats
captures a small fraction of the redundant traffic a real system sees.

## Technical architecture & implementation

**Lookup path.** Each incoming prompt is converted to an embedding
vector using the same embedding model consistently across every prompt
— mixing embedding models (or model versions) makes vectors
incomparable, since different models place semantically similar text at
different points in different vector spaces. Instead of looking up an
exact key, the cache performs a nearest-neighbor search against
previously cached prompt embeddings, typically backed by an ANN index
for the same reasons described on the
[Vector Database Sharding](/docs/patterns/ai-infra/vector-database-sharding)
page once the cache holds enough entries that a linear scan is too
slow. The search returns the closest cached prompt and its similarity
score; if that score clears a configured **similarity threshold**, the
cache treats the two prompts as equivalent and returns the stored
response without calling the LLM at all. If no cached entry clears the
threshold, the request proceeds to the model normally, and the new
prompt/response pair is added to the cache for future lookups.

**The threshold is the entire design.** Unlike a conventional cache,
where "hit or miss" is an unambiguous exact match, a semantic cache's
hit/miss boundary is a continuous similarity score cut at an arbitrary
threshold — there is no value of that threshold that is simply
"correct." Set it too loose, and prompts that are topically related but
not actually equivalent — "cancel my subscription" and "pause my
subscription" — clear the threshold and return the wrong cached
response, with the caller receiving a confidently wrong answer and no
signal anything went wrong, since a cache hit looks identical to a
correctly-generated response from the outside. Set it too tight, and
near-duplicate prompts that should hit rarely clear the bar, and the
cache's savings evaporate. Because there's no universally correct
value, this threshold generally needs to be tuned per deployment
against real traffic and validated against the cost of a wrong answer
for that specific use case, not set once from a rule of thumb.

**Invalidation.** A semantic cache has the same staleness problem any
cache does, with one added wrinkle: because a cache entry can be
returned for many different but semantically similar future prompts,
invalidating or expiring one entry effectively invalidates the answer
for an entire *neighborhood* of prompts, not just the one exact
original request. If the underlying facts a cached response depends on
change (a policy update, new pricing), every prompt within similarity
range of the stale cached entry now risks returning outdated
information until that entry is invalidated or expires — a TTL alone
doesn't fully solve this if the underlying facts change faster than the
TTL window.

**Failure modes.** Beyond a badly tuned threshold, the other common
failure is **embedding-model mismatch after a model upgrade**: if the
embedding model used to compute new query vectors is upgraded without
re-embedding the existing cache, new queries are compared against
old-model vectors in what is now effectively a different vector space,
and similarity scores become meaningless — the cache either stops
matching things it should, or starts matching things it shouldn't, with
no obvious symptom pointing at the actual cause.

**Semantic caching vs. RAG.** Both patterns embed a query and run a
similarity search, which invites conflating them, but they ask
different questions. RAG's search asks "which source documents are
relevant to this query" and always proceeds to a fresh generation
grounded in whatever it finds. Semantic caching's search asks "have I
already generated a response to a sufficiently similar query" and, on a
hit, skips generation entirely. The two compose naturally: semantic
caching checked first, with a miss falling through to a full
[RAG Pipeline](/docs/patterns/ai-infra/rag-pipeline) run — but they are
not substitutes for one another, since a RAG retrieval "hit" still
requires a full LLM call, while a semantic cache hit requires none.

## Code example

```rust
struct CacheEntry {
    prompt_embedding: Vec<f32>,
    response: String,
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a * norm_b)
}

enum CacheResult {
    Hit { response: String, similarity: f32 },
    Miss,
}

struct SemanticCache {
    entries: Vec<CacheEntry>,
    // The single tuning knob governing the precision/recall tradeoff —
    // too low and unrelated prompts match; too high and the cache
    // rarely fires at all.
    similarity_threshold: f32,
}

impl SemanticCache {
    // Finds the nearest cached prompt by cosine similarity and treats it
    // as a hit only if it clears the configured threshold — a real
    // implementation backs this with an ANN index, but the decision
    // rule is identical: closest match, gated by a threshold.
    fn lookup(&self, query_embedding: &[f32]) -> CacheResult {
        let best = self
            .entries
            .iter()
            .map(|e| (cosine_similarity(query_embedding, &e.prompt_embedding), e))
            .max_by(|a, b| a.0.partial_cmp(&b.0).expect("no NaN scores"));

        match best {
            Some((similarity, entry)) if similarity >= self.similarity_threshold => {
                CacheResult::Hit { response: entry.response.clone(), similarity }
            }
            _ => CacheResult::Miss,
        }
    }

    fn insert(&mut self, prompt_embedding: Vec<f32>, response: String) {
        self.entries.push(CacheEntry { prompt_embedding, response });
    }
}
```

`lookup` only returns `Hit` when the best match's similarity is at or
above `similarity_threshold` — the same query embedding compared
against the same cached entries can flip from a hit to a miss purely by
changing that one number, which is exactly the tuning tradeoff the
prose above describes: there's no threshold value that's correct in the
abstract, only one that's correct for a given deployment's tolerance
for a wrong cached answer.

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

## Use-case scenarios

**Public FAQ chatbot for a telecom provider.** A telecom's support
chatbot fields large volumes of near-duplicate questions about the same
handful of topics — billing dates, outage status, plan changes — phrased
differently by thousands of distinct customers. A moderately loose
similarity threshold is appropriate here because the underlying answers
are genuinely generic and not personalized per customer, so a cache hit
across differently-worded but equivalent questions carries low risk of
returning a subtly wrong, customer-specific answer.

**Internal code-search assistant at a software company.** Engineers ask
an internal LLM-backed tool questions like "how do I authenticate to
the payments service" repeatedly across a large engineering
organization, often phrased differently by different engineers asking
about the same underlying service. Because engineering questions here
are relatively stable day to day (the answer doesn't usually change
hour to hour), a semantic cache with a moderate threshold and a
same-day TTL captures most of the redundant traffic without much risk
of returning genuinely outdated guidance.

**Transactional banking assistant — cache deliberately tuned tight.** A
bank's LLM-backed assistant answers both generic questions ("what are
your hours") and account-specific ones ("what's my current balance").
The semantic cache is configured with a very tight similarity threshold
and is explicitly *not* applied at all to any prompt classified as
transactional or account-specific — a caching layer here can only
safely handle the generic-question traffic, and the design has to
actively exclude the account-specific traffic rather than trust the
threshold alone to distinguish them, since the cost of a wrongly cached
balance or transaction answer is unacceptable regardless of how the
threshold is tuned.

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
