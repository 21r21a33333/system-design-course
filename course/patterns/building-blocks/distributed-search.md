---
title: "Distributed Search"
sidebar_position: 8
supplementary: true
---

Distributed search builds and serves a search index — typically an
inverted index — across a large, sharded and replicated set of
documents, answering full-text and faceted queries with relevance
ranking that a plain database index isn't built to provide, by fanning
each query out to every shard in parallel and merging the results.

![Distributed Search diagram](/img/patterns/distributed-search.svg)

## Problem it solves

A relational database's B-tree index is excellent at exact-match and
range lookups on a column, but it can't efficiently answer "which
documents contain these words, ranked by relevance" or "which products
match this text and also fall within this price range and category."
Doing that with `LIKE '%term%'` scans the whole table and gets slower as
data grows, with no notion of relevance ranking. Full-text and faceted
search need a fundamentally different data structure — an index built
around *terms* and their relationships to documents — and at scale, that
index itself must be sharded and queried in parallel, the same way the
underlying document set would be.

## Technical architecture & implementation

**The inverted index.** The core structure inverts the natural mapping.
Instead of documents→words (a "forward" index), it stores each *term* →
a **postings list** of the documents containing it, so a query for a
term is a direct lookup rather than a scan. Each posting typically
carries the term frequency and positions within the document, which
powers phrase queries and ranking. Postings lists are kept sorted by
document ID and heavily compressed (delta + variable-byte encoding) so
that multi-term queries can intersect or union them with fast merges.

**Analysis: text → terms.** Before indexing, text runs through an
*analysis* pipeline: **tokenization** (splitting into words),
**normalization** (lowercasing, Unicode folding), **stemming** or
lemmatization (`running` → `run`), and stop-word handling. The exact
same pipeline must run at query time, or a query term won't match the
indexed form — a subtle, common bug. Getting analysis right (language,
synonyms, n-grams for partial matching) is most of what makes search
feel "good."

**Relevance scoring — TF-IDF and BM25.** Matching isn't enough; results
must be *ranked*. **TF-IDF** weights a term high when it appears often in
a document (term frequency) but is rare across the corpus (inverse
document frequency), so common words contribute little. **BM25**, the
modern default in Lucene/Elasticsearch, refines this with term-frequency
saturation (the tenth occurrence adds less than the second) and document-
length normalization (a match in a short title outweighs one in a long
body). Scores from every matching shard must be comparable, which is why
corpus-wide statistics like document frequency sometimes need a
coordinating pass.

**Sharding + replication of the index.** At scale both the index and the
query load are partitioned. The document set is split into **shards**,
each holding a *complete* inverted index over its own subset of
documents. Each shard is then **replicated** across nodes for
availability and read throughput. Choosing the shard count is a
commitment: too few and shards grow too large to query fast; too many
and per-query coordination overhead dominates and every query touches
too many nodes.

**Scatter-gather query execution.** A query is broadcast to every shard
**in parallel** (one replica per shard). Each shard computes its own
local top-k matches and returns them; a coordinating node **gathers**
those partial results, merges them, and re-ranks into a global top-k —
the scatter-gather pattern. The crucial performance property: total
latency tracks the **slowest shard**, not the sum of shards, so search
scales by adding shards *and* nodes — but a single slow "straggler"
shard bounds the whole query, which is why replicas and hedged requests
matter. Faceted search rides alongside this: each shard also returns
count aggregations over structured fields (category, price bucket,
brand), merged so the UI can show "127 results, 40 in Electronics"
without a separate query per facet.

**Keeping the index in sync.** The search index is almost never the
system of record — it's a derived view of data that lives in a database.
Keeping it current means feeding it changes via
[change data capture](/docs/patterns/batch-streaming/change-data-capture)
or dual writes, accepting that the index is *eventually* consistent with
the source. Indexing is also not instant: most engines make a document
searchable only after a periodic *refresh*, so "write then immediately
search" may miss the just-written document.

**Where it sits among siblings.** Distributed search shares the
[sharding](/docs/patterns/storage/sharding) discipline of a partitioned
database, and its scatter-gather is the read-side dual of how a sharded
store fans out a query. But its purpose is the inverse of a
[key-value store](/docs/patterns/building-blocks/key-value-store) or
[blob store](/docs/patterns/building-blocks/blob-store): those are built
to fetch a value by a *known key* and deliberately can't look inside
their values, whereas a search index exists precisely to find keys by
*content*. The two are complementary — the search index returns document
IDs, and the key-value or blob store serves the documents themselves.

## Code example

The engine of distributed search is the concurrent scatter-gather: a
per-shard inverted index plus a fan-out that queries all shards in
parallel and merges their local top matches. This uses real threads
(`std::thread::scope`), and the timing test proves the concurrency is
genuine — four shards each doing 50 ms of work finish in ~55 ms wall
time, not ~200 ms.

```rust
use std::collections::HashMap;
use std::time::Duration;

#[derive(Default)]
pub struct Shard {
    // term -> postings list of (doc_id, term frequency in that doc)
    index: HashMap<String, Vec<(u64, u32)>>,
    doc_count: u64,
}

fn tokenize(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase())
        .filter(|w| !w.is_empty())
        .collect()
}

impl Shard {
    pub fn add(&mut self, doc_id: u64, text: &str) {
        self.doc_count += 1;
        let mut tf: HashMap<String, u32> = HashMap::new();
        for term in tokenize(text) {
            *tf.entry(term).or_insert(0) += 1;
        }
        for (term, freq) in tf {
            self.index.entry(term).or_default().push((doc_id, freq));
        }
    }

    // Local top matches for a term, scored by term frequency (a stand-in for
    // BM25). Simulated per-shard latency makes the parallel win measurable.
    pub fn query(&self, term: &str, work: Duration) -> Vec<(u64, u32)> {
        std::thread::sleep(work);
        let mut hits = self.index.get(term).cloned().unwrap_or_default();
        hits.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        hits
    }
}

// Fan a query out to every shard in parallel, then merge into a global ranking.
pub fn scatter_gather(shards: &[Shard], term: &str, work: Duration, top_k: usize) -> Vec<(u64, u32)> {
    let mut merged: Vec<(u64, u32)> = std::thread::scope(|scope| {
        let handles: Vec<_> = shards
            .iter()
            .map(|s| scope.spawn(move || s.query(term, work)))
            .collect();
        handles.into_iter().flat_map(|h| h.join().unwrap()).collect()
    });
    merged.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    merged.truncate(top_k);
    merged
}
```

## When to use it

- Users need full-text search — relevance-ranked results over
  unstructured or semi-structured text — which a database's standard
  index can't provide efficiently.
- The document set or query volume is too large for a single-node search
  index to hold or serve.
- Faceted filtering and aggregation over search results (by category,
  price, date) must be fast and combined with text relevance.

## When not to use it

- Queries are exact-match or range lookups on structured fields — a
  standard database index handles this well, and running a separate
  search cluster adds real operational overhead.
- The document set is small enough that even a naive scan is fast
  enough and relevance ranking isn't needed.
- Keeping the search index in sync with the system of record (via change
  data capture or dual writes) isn't worth the complexity for the query
  patterns actually needed.

## Use-case scenarios

**E-commerce product search with facets.** A retailer indexes millions
of products; a shopper's query for "wireless headphones" must rank by
relevance *and* let them filter by brand, price band, and rating in one
round trip. Each shard returns local top matches plus facet counts;
the coordinator merges them into a ranked page with sidebar counts. BM25
handles relevance, replicas keep p99 low during peak traffic, and change
data capture pushes price and stock updates into the index within
seconds.

**Log and observability search.** An engineering org ingests terabytes
of logs per day into an Elasticsearch/OpenSearch cluster, sharded by
time. During an incident, engineers run ad-hoc full-text queries
("`error` AND `payment` in the last 15 minutes") that scatter across the
relevant time-shards and gather in seconds — impossible with a
relational `LIKE` scan at that volume. Older time-shards roll to cheaper
storage as query frequency drops.

**Site-wide content and documentation search.** A large documentation
site or knowledge base indexes every page, applying stemming and
synonyms so "cancel subscription" also matches "cancelling my plan."
The index is a derived view kept in sync from the content database; a
periodic refresh makes new articles searchable, and faceting by product
area and version narrows results. The search cluster returns page IDs
that the app resolves against its content store for rendering.

## Related patterns

- [Sharding](/docs/patterns/storage/sharding) — distributed search
  indexes are sharded across nodes using the same core tradeoffs
  (shard-key choice, rebalancing cost) as a sharded database.
- [Change Data Capture](/docs/patterns/batch-streaming/change-data-capture) —
  the mechanism that keeps a derived search index in sync with the
  system-of-record database it indexes.
- [Key-Value Store](/docs/patterns/building-blocks/key-value-store) — the
  complement to search: search finds document IDs by content, the
  key-value store fetches the documents by that ID.
- [Materialized View](/docs/patterns/storage/materialized-view) — a
  search index is itself a specialized materialized view, a precomputed
  read model derived from source data to serve queries the source can't
  answer efficiently.

## Further reading

- [Search engine indexing — Wikipedia](https://en.wikipedia.org/wiki/Search_engine_indexing)
- [Inverted index — Wikipedia](https://en.wikipedia.org/wiki/Inverted_index)
- [Okapi BM25 — Wikipedia](https://en.wikipedia.org/wiki/Okapi_BM25)
- [Elasticsearch: shards and replicas — official docs](https://www.elastic.co/guide/en/elasticsearch/reference/current/scalability.html)
- [Apache Lucene scoring (TFIDFSimilarity / BM25)](https://lucene.apache.org/core/9_0_0/core/org/apache/lucene/search/similarities/TFIDFSimilarity.html)
