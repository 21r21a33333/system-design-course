---
title: "RAG Pipeline"
sidebar_position: 7
supplementary: true
---

Retrieval-Augmented Generation (RAG) retrieves relevant documents via
vector similarity search and injects them into an LLM's prompt as
context, so the model answers using retrieved, current information
instead of relying solely on what was baked into it during training.

![RAG Pipeline diagram](/img/patterns/rag-pipeline.svg)

## Problem it solves

A trained LLM's knowledge is frozen at training time and general
purpose — it has no access to an organization's private documents, and
it can't reflect anything that changed after training finished.
Fine-tuning the model on new or proprietary data is expensive, slow to
iterate on, and still has to be redone every time the underlying data
changes. RAG sidesteps both problems: instead of teaching the model new
facts by retraining it, relevant facts are retrieved at query time from
an external, independently updatable data source and handed to the
model as context in the prompt itself. Updating the data means
updating the retrieval index, not retraining anything.

## Technical architecture & implementation

**Ingestion — chunking and embedding.** Source documents are split into
smaller passages (**chunking**) before anything is indexed, since
embedding and retrieving whole long documents loses precision — a
100-page document's single embedding vector is a blurry average of
everything in it, and retrieving that whole document also wastes
context-window space on the sections irrelevant to any given query.
Chunk size is a real tuning parameter: chunks too small lose
surrounding context a passage needs to make sense on its own; chunks
too large reintroduce the precision loss chunking exists to avoid.
Each chunk is converted into a vector via an embedding model and stored
in a vector index (see [Vector Database Sharding](/docs/patterns/ai-infra/vector-database-sharding)
for how that index scales past single-node capacity).

**Retrieval.** At query time, the user's query is embedded with the
same embedding model used during ingestion — a mismatch here (a
different model, or a different model version) makes query and chunk
vectors incomparable, since embedding spaces aren't portable across
models. A similarity search against the index returns the chunks whose
vectors are closest to the query vector. This step is deliberately
tuned for high recall over high precision: it returns more candidates
than will ultimately be used, because a fast approximate search over
many chunks reliably includes some only marginally relevant results
alongside the genuinely relevant ones, and it's cheaper to over-fetch
and filter than to risk under-fetching and missing the right chunk
entirely.

**Re-ranking.** Because retrieval over-recalls by design, a re-ranking
step commonly follows: a smaller, more precise (and per-item more
expensive) model re-scores each retrieved candidate against the query
directly — often a cross-encoder that looks at the query and a
candidate chunk together, rather than comparing two independently
computed vectors — and keeps only the strongest matches. This two-stage
design (cheap broad retrieval, then expensive precise re-ranking on a
small candidate set) is a standard precision/cost tradeoff: running the
expensive re-ranker over the entire corpus for every query would be far
too slow, but running it over only the retrieval stage's top-N
candidates is affordable.

**Prompt assembly and generation.** The original query and the
surviving, re-ranked chunks are combined into a single prompt sent to
the LLM, which generates its answer grounded in that injected context.
The order and formatting of chunks inside the prompt is not incidental:
models exhibit measurable positional bias toward information near the
start or end of a long context window, so how retrieved chunks are
arranged inside the prompt can affect how much the model actually uses
them.

**Failure modes.** The dominant failure mode is **silent retrieval
failure**: if no chunk in the index is actually relevant to the query
(the knowledge base simply doesn't contain the answer), retrieval still
returns *something* — the top-k most-similar chunks exist by
construction — and the LLM may generate a fluent, confident-sounding
answer grounded in irrelevant context rather than indicating it doesn't
know. This is functionally a hallucination with a retrieval-shaped
cause, not a generation-shaped one, and it's easy to misdiagnose as a
model quality problem when the actual defect is in the index or the
similarity threshold. A second failure mode is **embedding drift**: if
the chunking or embedding logic changes without re-embedding the entire
existing index, old chunks and new queries are being compared in
subtly incompatible vector spaces, degrading retrieval quality in a way
that's hard to detect because search still returns results — just worse
ones.

**Evaluating a RAG pipeline.** Because a RAG failure can originate in
either the retrieval stage or the generation stage, evaluating one
end-to-end score ("was the final answer good") tells you little about
*where* to fix a regression. Production RAG evaluation is therefore
usually split by stage, along the lines of:

| Question | Stage measured | What a low score points at |
| --- | --- | --- |
| Did retrieval surface the chunks that actually contain the answer? | Retrieval | Chunking, embedding model, index recall, or too-low top-k |
| Are the retrieved chunks actually relevant to the query? | Retrieval + re-rank | Similarity threshold or a weak/absent re-ranker |
| Is the generated answer supported by the retrieved chunks (faithfulness)? | Generation | Prompt assembly, positional bias, or model grounding |
| Does the answer address what the user actually asked? | Generation | Prompt construction or an off-target retrieval upstream |

Separating retrieval-quality metrics from generation-quality metrics is
what lets the earlier "silent retrieval failure" be diagnosed as a
retrieval defect rather than misattributed to the model — a distinction a
single blended score erases.

**RAG vs. semantic caching.** Both patterns sit in front of an LLM call
and use embedding similarity, which makes them easy to conflate, but
they answer different questions. RAG's similarity search asks "which
*source documents* are relevant to this query" and feeds the answer
into a fresh generation. [Semantic Caching](/docs/patterns/ai-infra/semantic-caching)'s
similarity search asks "have I already generated an answer to a
*sufficiently similar query* before" and, on a hit, skips generation
entirely by returning a previously computed response. The two are
commonly layered: semantic caching in front of a RAG pipeline to skip
re-running retrieval and generation for a repeated question, with RAG
itself only invoked on a cache miss.

## Code example

```rust
struct Chunk {
    id: u32,
    text: &'static str,
    embedding: Vec<f32>,
}

// Cosine similarity — the standard distance metric ANN indexes
// optimize for approximate search over.
fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a * norm_b)
}

struct RetrievedChunk {
    chunk_id: u32,
    text: &'static str,
    score: f32,
}

// Stage 1: retrieval — a fast approximate search returning the top `k`
// candidates by embedding similarity. Deliberately over-inclusive.
fn retrieve(query_embedding: &[f32], chunks: &[Chunk], k: usize) -> Vec<RetrievedChunk> {
    let mut scored: Vec<RetrievedChunk> = chunks
        .iter()
        .map(|c| RetrievedChunk { chunk_id: c.id, text: c.text, score: cosine_similarity(query_embedding, &c.embedding) })
        .collect();
    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).expect("no NaN scores"));
    scored.truncate(k);
    scored
}

// Stage 2: re-ranking — a more precise scorer that re-orders retrieval's
// candidates and drops anything below a relevance floor.
fn rerank(query_terms: &[&str], candidates: Vec<RetrievedChunk>, min_relevance: f32) -> Vec<RetrievedChunk> {
    let mut reranked: Vec<RetrievedChunk> = candidates
        .into_iter()
        .map(|mut c| {
            let matches = query_terms.iter().filter(|t| c.text.contains(**t)).count();
            c.score = matches as f32 / query_terms.len().max(1) as f32;
            c
        })
        .filter(|c| c.score >= min_relevance)
        .collect();
    reranked.sort_by(|a, b| b.score.partial_cmp(&a.score).expect("no NaN scores"));
    reranked
}
```

`retrieve` deliberately over-fetches by embedding similarity alone —
note chunk 3 in a fuller example (an off-topic passage with a
coincidentally similar embedding) would still make it through this
stage. `rerank` is the stage that actually enforces relevance, scoring
each surviving candidate against the query directly and dropping
anything under `min_relevance` — which is exactly the two-stage
recall-then-precision structure a production RAG pipeline relies on.

## When to use it

- Answers need to reflect information that's private, proprietary, or
  changes more often than retraining a model is practical.
- Reducing hallucination matters, and grounding responses in
  retrieved source text (which can also be cited back to the user) is
  valuable.
- The knowledge base is large enough that it can't fit directly in a
  single prompt's context window, so relevant pieces must be selected
  rather than included wholesale.

## When not to use it

- The required knowledge is small enough to fit directly in the
  prompt every time — retrieval adds pipeline complexity with no
  benefit if there's nothing to filter down from.
- The task depends on general reasoning or creativity rather than
  specific factual recall, where retrieved context adds little.
- Extremely low latency is required and the added retrieval and
  re-ranking round-trips before the LLM call even starts aren't
  acceptable for the use case.

## Use-case scenarios

**Internal engineering documentation assistant.** A software company
indexes its internal wikis, runbooks, and past incident post-mortems so
engineers can ask natural-language questions ("how do we roll back a
failed migration on service X") and get an answer grounded in the
company's actual, frequently-changing documentation rather than a
general-purpose LLM's generic (and potentially outdated or simply
wrong) knowledge of how that specific service works. Because
documentation changes daily, the pipeline re-embeds and re-indexes
changed pages incrementally rather than requiring any model retraining.

**Contract and policy analysis for a legal team.** A legal department
uses RAG over a firm's contract repository so a lawyer can ask
"what termination clauses exist across our vendor contracts" and
receive an answer citing the specific contracts and clauses retrieved,
rather than a plausible-sounding answer with no traceable source. The
ability to show which source chunks grounded the answer is treated as
a hard requirement here, not a nice-to-have, since an ungrounded answer
in a legal context carries direct liability risk if it's wrong.

**Customer-support chatbot over a product's help center.** A SaaS
company's support chatbot answers user questions by retrieving relevant
help-center articles rather than relying on the LLM's training data,
which may predate the product's current UI or feature set entirely. As
the product changes and new help articles are published, the pipeline
only needs the new articles chunked and embedded into the index — the
underlying LLM never needs retraining to reflect a UI change that
happened last week.

## Related patterns

- [Vector Database Sharding](/docs/patterns/ai-infra/vector-database-sharding) —
  the retrieval stage's similarity search is exactly the workload that
  vector database sharding scales past single-node capacity.
- [Semantic Caching](/docs/patterns/ai-infra/semantic-caching) — can sit in
  front of a RAG pipeline's final LLM call to avoid re-running
  retrieval and generation for semantically repeated queries.

## Further reading

- [Retrieval-augmented generation — Wikipedia](https://en.wikipedia.org/wiki/Retrieval-augmented_generation)
- [Vector database — Wikipedia](https://en.wikipedia.org/wiki/Vector_database)
- [Lewis et al., 2020 — Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks](https://arxiv.org/abs/2005.11401)
- [LangChain — retrieval and RAG concepts](https://python.langchain.com/docs/concepts/rag/)
- [Pinecone — chunking strategies for RAG](https://www.pinecone.io/learn/chunking-strategies/)
