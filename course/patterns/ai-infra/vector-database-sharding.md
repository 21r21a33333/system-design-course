---
title: "Vector Database Sharding"
sidebar_position: 6
supplementary: true
---

Vector database sharding partitions an approximate nearest-neighbor
(ANN) index across multiple nodes when the full set of vectors is too
large to fit in one machine's memory, so similarity search can scale
past a single node's capacity.

![Vector Database Sharding diagram](/img/patterns/vector-database-sharding.svg)

## Problem it solves

Vector search indexes are built to answer "find the k most similar
vectors" queries quickly, but the data structures that make this fast
(graph- or cluster-based indexes) generally need to live in memory to
hit acceptable latency. As an embedding collection grows — millions to
billions of vectors, each hundreds of dimensions — it eventually
exceeds what a single machine can hold in RAM. Sharding solves the
capacity problem the same way it does for any data store: split the
data across multiple nodes so each holds a fraction of it. But vector
indexes have a structural property that makes this materially harder
than sharding a conventional row-oriented database.

## Technical architecture & implementation

**Scatter.** A query embedding is broadcast to every shard
simultaneously rather than routed to a single shard the way a
conventional sharded database routes a point lookup by key — there's no
way to know in advance which shard holds the true nearest neighbors, so
every shard has to be searched. This is the first structural difference
from row-oriented sharding: a well-chosen shard key on a conventional
database lets most queries hit exactly one shard, but a vector query
fundamentally can't be routed that way, since "nearest" is a property
of the whole collection, not something a static partitioning scheme can
predict per query.

**Local search — gather.** Each shard runs the query against its own
independently-built local ANN index (an HNSW graph, an IVF cluster
structure, or similar) and returns its own local top-k nearest
neighbors. Critically, a shard's local top-k is an answer to a
*different, smaller* question than the one actually being asked — "what
are the k nearest neighbors among the vectors this shard happens to
hold," not "what are the k nearest neighbors overall." A shard has no
visibility into any other shard's contents, so it cannot know whether
its own 5th-best local match is actually better or worse than another
shard's 1st-best match.

**Merge and re-rank.** A coordinator collects every shard's local top-k
results, combines them into one list, and re-sorts by score to produce
the final global top-k. This step is unavoidable because production ANN
index structures don't merge cleanly across shards — an HNSW graph is
built incrementally over the specific vectors inserted into it, and
there's no operation that combines two independently-built HNSW graphs
(or two IVF partitions) into one correct unified index without
substantial rebuild work. That structural fact is exactly why the
scatter-gather-rerank pattern exists at all: it works around indexes
that can't merge, by never merging the indexes themselves and only
merging their query-time *results* instead.

**Failure modes.** The central failure mode is **recall loss from
per-shard k being too small**. If each shard only returns its local
top-5 but the true global top-10 draws unevenly from shards (say, 8 of
the 10 true nearest neighbors happen to live on one shard), a per-shard
k of 5 permanently discards 3 of those true neighbors before they ever
reach the merge step — the coordinator can only re-rank what it
received, and a result that was never sent can't be recovered by
better merging. This is a pure recall/cost tradeoff: increasing
per-shard k reduces this risk but increases the data volume every shard
sends back, and the corrective factor needed depends on how skewed the
data's true nearest-neighbor distribution is across shards, which isn't
generally known in advance. A second failure mode is **shard imbalance**:
if vectors aren't distributed roughly evenly across shards (e.g. a
naive insertion-order or hash scheme colliding with real-world data
skew), one shard becomes both a capacity and latency hot spot, and
because scatter-gather waits on every shard before merging, the overall
query latency is bounded by the *slowest* shard, not the average one.

**Vector database sharding vs. RAG's retrieval stage.** These are not
separate mechanisms so much as adjacent layers: sharding is what a
vector index does internally once it outgrows one node, while
[RAG Pipeline](/docs/patterns/ai-infra/rag-pipeline)'s retrieval stage
is the *caller* of that index, issuing exactly the similarity queries
sharding exists to scale. A RAG pipeline's re-ranking step is a
separate, second re-rank happening *after* retrieval returns its
results — distinct from the merge-time re-rank a sharded vector
database performs internally just to produce one coherent global top-k
in the first place; a large-scale RAG deployment typically has both
happening at different layers of the same request.

## Code example

```rust
use std::sync::mpsc;
use std::thread;

#[derive(Clone)]
struct StoredVector {
    id: u32,
    embedding: Vec<f32>,
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

#[derive(Clone, Debug)]
struct ScoredMatch {
    id: u32,
    score: f32,
}

struct Shard {
    vectors: Vec<StoredVector>,
}

impl Shard {
    // Each shard only ever knows its own local top-k — it has no
    // visibility into what any other shard holds, which is exactly why
    // a global top-k can't be known until results are merged.
    fn local_top_k(&self, query: &[f32], k: usize) -> Vec<ScoredMatch> {
        let mut scored: Vec<ScoredMatch> = self
            .vectors
            .iter()
            .map(|v| ScoredMatch { id: v.id, score: cosine_similarity(query, &v.embedding) })
            .collect();
        scored.sort_by(|a, b| b.score.partial_cmp(&a.score).expect("no NaN scores"));
        scored.truncate(k);
        scored
    }
}

struct Coordinator {
    shards: Vec<Shard>,
}

impl Coordinator {
    // Scatter: broadcast the query to every shard concurrently, each on
    // its own thread, so shard search latency is bounded by the
    // slowest shard rather than the sum of all shards. Gather + re-rank:
    // merge every shard's local top-k and re-sort — only after merging
    // is the true global top-k known.
    fn search(&self, query: Vec<f32>, per_shard_k: usize, global_k: usize) -> Vec<ScoredMatch> {
        let (tx, rx) = mpsc::channel();

        thread::scope(|scope| {
            for shard in &self.shards {
                let tx = tx.clone();
                let query = query.clone();
                scope.spawn(move || {
                    let local_results = shard.local_top_k(&query, per_shard_k);
                    tx.send(local_results).expect("channel open");
                });
            }
        });
        drop(tx);

        let mut merged: Vec<ScoredMatch> = rx.into_iter().flatten().collect();
        merged.sort_by(|a, b| b.score.partial_cmp(&a.score).expect("no NaN scores"));
        merged.truncate(global_k);
        merged
    }
}
```

`thread::scope` runs every shard's `local_top_k` call in parallel and
guarantees all of them finish before the scope block exits, which is
what makes the coordinator's overall latency bounded by the slowest
individual shard rather than the sum of all shards searched
sequentially. The subsequent merge and truncate to `global_k` is the
re-rank step — it's the only point in this whole flow where a
result's *global* rank, as opposed to its local rank within one shard,
is actually determined.

## When to use it

- The vector collection has grown beyond what a single node's memory
  can hold, and the index simply won't fit.
- Query throughput has outgrown what a single node can serve, and
  sharding is being used for horizontal read scaling in addition to
  capacity.
- The chosen vector database or index library supports the
  scatter-gather query pattern natively, so the merge/re-rank
  complexity is handled by the system rather than hand-rolled.

## When not to use it

- The full vector collection and its index comfortably fit in one
  node's memory — a single-node index is simpler, faster (no
  network hop for scatter-gather), and has no merge/re-rank overhead.
- Extremely high recall guarantees are required and the accuracy loss
  from approximating per-shard top-k results (rather than searching a
  single unified index) isn't acceptable for the use case.

## Use-case scenarios

**Enterprise document-search platform spanning millions of files.** A
company indexes the full text of every internal document, email
attachment, and wiki page across a large organization into embeddings
for semantic search, reaching a scale where the resulting index no
longer fits in one machine's memory. Vectors are sharded across a
cluster of nodes, and a search query fans out to every shard, merges
results, and returns a single ranked list to the calling RAG pipeline —
transparent to that caller, which only ever sees one logical index
despite the underlying sharding.

**Reverse image search at a stock-photo marketplace.** A stock-photo
platform lets users upload an image and find visually similar photos
across a catalog of hundreds of millions of images, each represented as
an image embedding. The catalog's scale requires sharding across many
nodes purely for capacity, and because the platform also serves heavy
concurrent search traffic, sharding additionally provides horizontal
read scaling — each shard serves a fraction of both the data and the
query load, rather than one node bearing both.

**Recommendation candidate generation at a large e-commerce catalog.**
An online retailer generates personalized product recommendations by
embedding both products and user preference vectors, then performing a
nearest-neighbor search across tens of millions of product embeddings
to find candidates for a downstream ranking model. Query latency
budgets here are tight because this candidate-generation step runs on
every page load; sharding lets each shard's local search run
concurrently rather than scanning the full catalog sequentially,
keeping the scatter-gather round-trip within the page's overall latency
budget.

## Related patterns

- [Sharding](/docs/patterns/storage/sharding) — the general
  data-partitioning pattern; vector database sharding is a
  specialization complicated by ANN indexes not merging across
  shards.
- [RAG Pipeline](/docs/patterns/ai-infra/rag-pipeline) — the retrieval
  stage of a RAG pipeline is exactly the kind of vector-similarity
  query that sharding needs to scale.

## Further reading

- [Vector database — Wikipedia](https://en.wikipedia.org/wiki/Vector_database)
