---
title: "Distributed Search"
sidebar_position: 8
supplementary: true
---

Distributed search builds and serves a search index — typically an
inverted index — across a large, sharded set of documents, supporting
full-text and faceted queries that a plain database index isn't built
to answer efficiently.

## Problem it solves

A relational database's B-tree index is excellent at exact-match and
range lookups on a column, but it can't efficiently answer "which
documents contain these words, ranked by relevance" or "which products
match this text and also fall within this price range and category."
Doing that with `LIKE '%term%'` scans the whole table and gets slower
as data grows, with no notion of relevance ranking. Full-text and
faceted search need a fundamentally different data structure — an
index built around terms and their relationships to documents — and at
scale, that index itself needs to be sharded and queried in parallel,
the same way the underlying document set would be.

## How it works

The core structure is an inverted index: instead of mapping documents
to the words they contain (a "forward" mapping), it maps each term to
the list of documents containing it, so a query for a term is a direct
lookup rather than a scan. Building the index involves tokenizing text
into terms, normalizing them (lowercasing, stemming), and often
weighting terms by relevance (e.g. TF-IDF or BM25) so results can be
ranked, not just matched.

At scale, both the index and the query load are sharded: the document
set is split across nodes (each shard holds a complete inverted index
for its subset of documents), and a query is broadcast to every shard
in parallel, with each shard returning its own top matches that are
then merged and re-ranked by a coordinating node — a scatter-gather
pattern. Faceted search extends this by maintaining, alongside the term
index, count aggregations over structured fields (category, price
range, brand) so a UI can show "127 results, of which 40 are in
Electronics" without a separate query per facet.

## When to use it

- Users need full-text search — relevance-ranked results over
  unstructured or semi-structured text — which a database's standard
  index can't provide efficiently.
- The document set or query volume is too large for a single-node
  search index to hold or serve.
- Faceted filtering and aggregation over search results (by category,
  price, date) needs to be fast and combined with text relevance.

## When not to use it

- Queries are exact-match or range lookups on structured fields — a
  standard database index already handles this well, and running a
  separate search cluster adds real operational overhead.
- The document set is small enough that even a naive scan is fast
  enough, and relevance ranking isn't needed.
- Keeping the search index in sync with the system of record (via
  change data capture or dual writes) isn't worth the added complexity
  for the query patterns actually needed.

## Real-world example

Elasticsearch and Apache Solr are the two dominant distributed search
engines, both built on an inverted-index core, both sharding documents
across nodes and scatter-gathering queries across shards.

## Related patterns

- [Sharding](/docs/patterns/storage/sharding) — distributed search
  indexes are sharded across nodes using the same core tradeoffs
  (shard-key choice, rebalancing cost) as a sharded database.

## Further reading

- [Search engine indexing — Wikipedia](https://en.wikipedia.org/wiki/Search_engine_indexing)
- [Inverted index — Wikipedia](https://en.wikipedia.org/wiki/Inverted_index)
