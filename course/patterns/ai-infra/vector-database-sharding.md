---
title: "Vector Database Sharding"
sidebar_position: 6
supplementary: true
---

Vector database sharding partitions an approximate nearest-neighbor
(ANN) index across multiple nodes when the full set of vectors is too
large to fit in one machine's memory, so similarity search can scale
past a single node's capacity.

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

## How it works

The vector collection is partitioned across shards, each holding a
subset of vectors and its own local ANN index. A query is broadcast to
every shard (scatter), each shard returns its own top-k nearest
neighbors from its local index (gather), and a coordinator merges those
per-shard result lists and re-ranks them to produce the final global
top-k. This scatter-gather-rerank step is unavoidable because most
production ANN index structures — HNSW's proximity graph, IVF's
cluster centroids — are built over the specific vectors they index and
don't merge cleanly: there's no way to combine two independently-built
HNSW graphs or IVF partitions into a single correct index without
substantial rebuild work. That's different from sharding a
conventional database, where each shard can usually answer an
already-complete, independent answer to a point lookup — a vector
search shard, by contrast, only ever returns an approximation of the
*local* top-k, and the true global top-k is only known after merging
all shards' results.

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

## Real-world example

Production vector databases used for large-scale retrieval-augmented
generation and recommendation workloads (open-source and managed
alike) implement this scatter-gather-rerank pattern once a collection
outgrows single-node capacity, splitting the index into shards and
merging query results at read time.

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
