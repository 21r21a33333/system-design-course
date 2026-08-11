---
title: "Monolithic Persistence"
sidebar_position: 6
supplementary: true
---

Monolithic persistence is using one data store — usually a single
relational database — for every kind of data an application has,
regardless of how differently that data is actually shaped and
accessed. Transactional order records, full-text searchable product
descriptions, time-series metrics, and session cache entries all end up
in the same database, forced through the same access patterns and
scaling levers, even though each has a genuinely different shape and a
purpose-built store would serve it far better.

![Monolithic Persistence diagram](/img/patterns/monolithic-persistence.svg)

## How it manifests

The clearest symptom is a single relational database instance hosting
tables that have almost nothing in common in how they're used: a
`sessions` table taking thousands of tiny, latency-sensitive
read/writes per second sits next to an `orders` table needing strict
transactional consistency, sitting next to a `product_search_index`
table being scanned with `LIKE '%...%'` queries because there's no
dedicated full-text search engine, sitting next to a `metrics` table
ingesting a continuous stream of time-series writes. Each workload
would be well served by a store designed for it — a key-value cache,
a relational store, a search index, a time-series database — but all
four are instead competing for the same connection pool, the same
buffer cache, and the same disk I/O on one instance.

The competition between workloads is where the pain shows up
operationally: a burst of session-cache traffic evicts pages the
order-processing workload needs from the database's buffer cache,
slowing down unrelated transactional queries; a full-table scan from a
naive search query holds locks or consumes I/O bandwidth that a
concurrent checkout transaction needed. None of these workloads are
individually misbehaving — they're just fundamentally different access
patterns forced to share one resource pool sized and tuned for none of
them particularly well. Schema design also suffers: a table optimized
for the transactional workload (highly normalized, strict foreign
keys) is a poor fit for the search workload (which wants denormalized,
read-optimized documents), so one of the two access patterns ends up
compromised no matter how the schema is designed, because a single
schema can't simultaneously be ideal for both.

Scaling responses reveal the coupling most starkly: scaling to handle
more session-cache load means scaling the entire database instance —
CPU, memory, disk, licensing cost, all of it — even though the actual
bottleneck is a workload that a dedicated in-memory cache could absorb
at a fraction of the cost, and scaling for it wouldn't require touching
anything the order-processing workload depends on.

## Why it happens

A single database is genuinely the simplest way to start: one
connection string, one backup process, one operational surface to
learn and monitor, one place all data lives that any new feature can
just write into. For an early-stage product this is a legitimate
advantage — the team doesn't yet know which workloads will need special
treatment, and provisioning a specialized store for every kind of data
speculatively would be premature. Every new feature that needs to
persist something naturally reaches for the database that's already
there, already has connection pooling configured, already has
migrations set up — adding a table is a five-minute task; standing up
and operating a new kind of data store is a multi-day one, with real
ongoing operational cost (another system to monitor, secure, back up,
and staff expertise for).

The mismatch also grows gradually rather than arriving all at once —
each individual table added to the shared database was, on its own, a
reasonable and small addition; it's only in aggregate, once the
database is hosting a dozen genuinely different workloads, that the
cumulative contention becomes a real problem. By the time it's visible
in production metrics, migrating any one workload out to a dedicated
store is a much bigger undertaking than it would have been to start
that workload in the right place originally, which is exactly what
makes the antipattern sticky once established.

## Code example (the antipattern)

```rust
// One repository backed by a single relational database, used for
// three workloads with very different access patterns: transactional
// order records, ephemeral session data, and full-text search.
struct RelationalDb;

impl RelationalDb {
    fn insert_order(&self, _order_id: u64) {}
    // Ephemeral, high-frequency session writes hitting the same
    // instance and connection pool as the transactional order data.
    fn set_session(&self, _session_id: &str, _payload: &str) {}
    // A LIKE-based scan standing in for full-text search, run against
    // the same instance and buffer cache as the other two workloads.
    fn search_products_like(&self, _term: &str) -> Vec<String> {
        Vec::new()
    }
}

struct OrderService {
    db: RelationalDb,
}

impl OrderService {
    fn place_order(&self, order_id: u64, session_id: &str, cart_summary: &str) {
        self.db.insert_order(order_id);
        self.db.set_session(session_id, cart_summary);
    }

    fn search(&self, term: &str) -> Vec<String> {
        self.db.search_products_like(term)
    }
}
```

## The fix

```rust
// Each workload gets a store shaped for its access pattern: a
// relational store for transactional order data, a key-value store
// for ephemeral session state, and a dedicated search index for
// full-text queries.
struct RelationalDb;
impl RelationalDb {
    fn insert_order(&self, _order_id: u64) {}
}

struct KeyValueCache;
impl KeyValueCache {
    // Session writes now hit a store built for high-frequency,
    // low-latency key-value access instead of sharing the relational
    // database's connection pool and buffer cache.
    fn set_session(&self, _session_id: &str, _payload: &str, _ttl_secs: u32) {}
}

struct SearchIndex;
impl SearchIndex {
    // Full-text queries now run against a store built for that access
    // pattern instead of a LIKE scan competing for the same I/O the
    // transactional workload needs.
    fn search(&self, _term: &str) -> Vec<String> {
        Vec::new()
    }
}

struct OrderService {
    db: RelationalDb,
    cache: KeyValueCache,
    search_index: SearchIndex,
}

impl OrderService {
    fn place_order(&self, order_id: u64, session_id: &str, cart_summary: &str) {
        self.db.insert_order(order_id);
        self.cache.set_session(session_id, cart_summary, 1800);
    }

    fn search(&self, term: &str) -> Vec<String> {
        self.search_index.search(term)
    }
}
```

The fix isn't "use more databases for their own sake" — it's matching
each workload's store to its actual access pattern: session data gets a
TTL-aware key-value store instead of competing for relational locks and
buffer cache it doesn't need, and search gets an index built for
ranking and relevance instead of a linear scan. Each store can now be
scaled, tuned, and operated independently, and load on one no longer
degrades the others.

## How to detect it

Database-level resource contention metrics — buffer cache hit rate
dropping in correlation with bursts from a specific workload, lock wait
time spiking during a different workload's queries — that don't
correspond to the *overall* query volume but to a *specific* table or
query pattern are the clearest sign multiple unrelated workloads are
sharing one resource pool. Query logs showing full scans or
pattern-matching queries (`LIKE '%...%'`) standing in for what should be
indexed search, run against the same instance as transactional
queries, is a direct structural signal. Capacity planning conversations
are also a tell: if scaling the database to handle one workload's
growth (say, session volume) requires scaling the entire instance —
and therefore paying for and re-tuning capacity the other, unrelated
workloads don't need — that coupling is the antipattern showing up as
an operational and cost problem, not just a performance one.

## When it's actually fine

Early on, or for a genuinely small application, one database for
everything is the right call, not a compromise — the operational
overhead of running several specialized stores is real and shouldn't be
paid before there's evidence a workload needs it. It's also fine when
the workloads sharing the store really are similar in shape and volume
— several tables that are all low-volume, all transactional, all
queried the same way don't need to be split apart just because they
represent different domain concepts; splitting stores is about
mismatched *access patterns*, not about domain boundaries on their own.
And regulatory or operational constraints sometimes make a single
store the deliberate choice — a requirement that all customer data live
in one auditable, backed-up system can outweigh the performance
benefits of splitting workloads apart, if that requirement is a genuine
hard constraint rather than an assumption nobody's revisited.

## Libraries & tools that prevent this

Polyglot persistence means routing each workload to a store shaped for its access pattern instead of forcing everything through one relational instance; these production stores are the fit-for-purpose destinations that a monolithic database's mismatched workloads should migrate to.

| Library / Tool | Language | How it helps | Getting started |
| --- | --- | --- | --- |
| Redis | Any (server + clients) | In-memory key-value store for the ephemeral, high-frequency session/cache workload that should never share a relational buffer cache | [redis.io/docs](https://redis.io/docs/latest/) |
| Elasticsearch | Any (REST + clients) | Dedicated full-text search engine, replacing `LIKE '%...%'` scans that otherwise contend with transactional queries | [elastic.co getting started](https://www.elastic.co/guide/en/elasticsearch/reference/current/getting-started.html) |
| OpenSearch | Any (REST + clients) | Apache-2.0 search/analytics engine for the search workload, an open alternative to Elasticsearch | [opensearch.org getting started](https://opensearch.org/docs/latest/getting-started/) |
| TimescaleDB | SQL / any client | Time-series database (Postgres extension) for the metrics-ingest workload that shouldn't compete with order transactions | [docs.timescale.com](https://docs.timescale.com/getting-started/latest/) |
| ClickHouse | SQL / any client | Column-oriented store for high-volume analytical/aggregation workloads separated out of the transactional instance | [clickhouse.com quick start](https://clickhouse.com/docs/en/getting-started/quick-start) |
| MinIO | Any (S3 API) | S3-compatible object storage for large blobs/documents that don't belong in relational rows | [min.io docs](https://min.io/docs/minio/linux/index.html) |

**Example / reference:** [Polyglot Persistence — Martin Fowler](https://martinfowler.com/bliki/PolyglotPersistence.html)

## Related patterns

- [Federation](/docs/patterns/storage/federation) — splits a
  monolithic store into several independent stores divided by function
  or domain, which is the direct structural fix once workloads are
  mismatched enough to justify separate stores.
- [CQRS](/docs/patterns/storage/cqrs) — separates the write model from
  the read model, which is often the first split that reveals a single
  store is serving two workloads (transactional writes and read-heavy
  queries) that would each be better served differently.

## Further reading

- [Monolithic Persistence antipattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/antipatterns/monolithic-persistence/)
- [Polyglot persistence — Wikipedia](https://en.wikipedia.org/wiki/Polyglot_persistence)
- [Polyglot Persistence — Martin Fowler](https://martinfowler.com/bliki/PolyglotPersistence.html)
