---
title: "Index Table"
sidebar_position: 6
supplementary: true
---

An index table is a secondary data structure, keyed by a field other
than the primary or partition key, that maps that field's values to the
location of the matching rows — letting queries that filter or sort by
a non-primary field avoid scanning every partition to find them.

![Index Table diagram](/img/patterns/index-table.svg)

## Problem it solves

A data store that's organized around a primary or shard key serves
queries on that key efficiently: given the key, the store goes directly
to the right partition and the right row. But applications routinely
need to query by other fields too — "find this customer by email" when
the store is keyed by customer ID, or "find all orders placed by this
account" when the store is sharded by order ID. Without a secondary
index, satisfying that query means scanning every partition and
checking every row for a match, an operation whose cost grows with the
size of the entire dataset rather than the size of the result. Relational
databases solve this natively: a B-tree secondary index is a built-in
feature of the engine, maintained automatically on every write. Many
NoSQL and key-value stores, however, are deliberately built around fast
lookups on a single primary key and don't offer that feature — which is
the specific gap the index table pattern fills.

## Technical architecture & implementation

**Reference vs. duplicated payload.** An index table is a second table,
stored alongside the original ("fact") table, whose own key is the field
applications need to query by. Each row maps a value of that secondary
field to enough information to retrieve the matching fact-table row(s) —
and *how much* it stores is the pattern's first design decision.
Duplicating the full row into the index table (denormalized) serves the
secondary query with a single lookup, at the cost of storing the data
twice and updating both copies on every write. Storing only a
*reference* (the primary/shard key) keeps one copy of the data and a
smaller index to maintain, at the cost of a second hop — first the index
table to find the primary key, then the fact table to fetch the row. A
common middle ground, a **covering index**, duplicates only the handful
of fields a specific query actually reads, so that query is answered
entirely from the index table without ever touching the fact table,
while everything else still defers back to it. When the secondary query
also filters or sorts by more than one field, a **composite index** —
keyed on an ordered tuple of fields (`(status, created_at)`) rather than
one — lets the store satisfy the whole predicate from a single
contiguous range of index rows, provided the query's leading fields
match the index's leading fields.

**Keeping it in sync — synchronous vs. eventual.** Whatever shape is
chosen, the index table must be updated on every write to the indexed
field, and *when* that update happens is the central tradeoff. A
**synchronous** update writes the fact row and the index row together,
atomically, so a reader can never observe one without the other — but
this requires the store to support multi-row atomicity (a transaction,
or the two rows being co-located in the same partition), and it makes
every indexed write pay for both writes before it can return. An
**eventual** update commits the fact row, then propagates the index
change asynchronously — via a change stream, a queue, or a background
job — which scales better and keeps the write path fast, at the cost of
a window during which the index is stale: it can still point at a
just-deleted row, miss a just-inserted one, or return a value under its
old key after the field changed.

**Failure modes.** The dangerous states are the ones where the two
tables *disagree*. A crash between the fact write and the index write (in
a non-atomic store) leaves a **dangling index entry** pointing at a row
that doesn't exist, or a fact row with no index entry that queries can't
find. Updating an indexed field is really a *delete-then-insert* in the
index — the row moves from its old key to its new key — and if only half
of that lands, the same record can appear under both keys or neither.
Robust implementations therefore treat the fact table as the source of
truth and make index maintenance **idempotent and re-runnable**: a
reader that follows an index reference and finds no matching fact row
simply skips it, and a periodic reconciliation job rebuilds the index
from the fact table to repair any drift, since the index is always
derivable and never authoritative.

**Local vs. global secondary indexes.** In a sharded store the choice
gains a distributed dimension. A **local secondary index** is stored on
the same shard as the rows it indexes, so it's cheap and transactional
to maintain (the index update and the row update touch one shard) — but
querying it means fanning the query out to *every* shard, because any
shard might hold a match, so it doesn't avoid the scatter for a
value-based lookup. A **global secondary index** is itself partitioned
by the indexed field, independently of how the fact table is sharded, so
a lookup goes straight to the one index partition holding that value —
but maintaining it now spans shards (writing a row on shard A may update
an index partition on shard C), which forces cross-shard coordination or
accepts eventual consistency for the index. DynamoDB makes exactly this
distinction concrete: local secondary indexes are strongly consistent
but confined to a single partition key, while global secondary indexes
span the whole table and are updated asynchronously, and therefore
eventually consistent.

**Cost and index selection.** An index table is never free: it costs
additional storage, and every write to an indexed field becomes at least
two writes instead of one — write amplification that compounds with each
index added. That makes **index selection** a real discipline: build an
index only for a field that is queried often enough, and selectively
enough, that the scan it replaces would genuinely hurt. Indexing a field
that's rarely queried, or one so low-cardinality that a lookup still
returns a huge fraction of the table, pays the write and storage cost
without buying back a meaningfully cheaper read.

## Code example

The snippet below models a minimal index table as a map from a
secondary key to the primary keys of matching rows, updated alongside
the fact table on every insert.

```rust
use std::collections::HashMap;

struct FactTable {
    rows: HashMap<String, String>, // primary key -> row data
}

struct IndexTable {
    // secondary key (e.g. "town") -> primary keys of matching rows
    index: HashMap<String, Vec<String>>,
}

struct CustomerStore {
    facts: FactTable,
    by_town: IndexTable,
}

impl CustomerStore {
    fn insert(&mut self, customer_id: &str, town: &str, data: &str) {
        // Both writes happen together — this is the "keep it in sync"
        // step the pattern requires on every write to an indexed field.
        self.facts.rows.insert(customer_id.to_string(), data.to_string());
        self.by_town
            .index
            .entry(town.to_string())
            .or_default()
            .push(customer_id.to_string());
    }

    // Without the index: would require scanning every row in `facts`.
    // With it: a direct lookup on the secondary key.
    fn find_by_town(&self, town: &str) -> Vec<&String> {
        self.by_town
            .index
            .get(town)
            .into_iter()
            .flatten()
            .filter_map(|id| self.facts.rows.get(id))
            .collect()
    }
}
```

`find_by_town` never touches a row outside the matching town, because
the index table already grouped primary keys by that field — the scan
that a store without secondary indexing would otherwise require is
replaced by a direct lookup.

## Index table vs. materialized view

Both an index table and a
[materialized view](/docs/patterns/storage/materialized-view) are derived
structures kept in sync with source data to make a read faster, and it's
easy to blur them, but they store fundamentally different things. An
index table stores **pointers** — it maps a secondary field's values to
the *locations* (primary keys) of the matching source rows, and the rows
themselves still live in, and are served from, the fact table. A
materialized view stores **results** — the actual output of a query
(often a join or aggregation), precomputed and held as its own table, so
a read consumes the computed answer directly and may never touch the
source tables at all. Put concretely: an index table answers "*where*
are the rows matching this value" and then you fetch them; a materialized
view answers "*here is* the already-computed answer to this query." An
index table doesn't change the shape of the data, only how you find it; a
materialized view changes the shape entirely (rows become sums,
many-table joins become one flat row). The two even compose — a
materialized view can itself carry an index table over one of its columns
to speed lookups into the precomputed result.

## When to use it

- The data store is a NoSQL or key-value store with no built-in
  secondary indexing, and an application needs to query efficiently by
  a field other than the primary or shard key.
- The query is frequent enough that its cost — a full scan without an
  index — is worth the storage and write overhead of maintaining an
  extra structure.
- The store supports either transactional updates across the fact and
  index tables (ideal), or a reliable asynchronous mechanism (a change
  stream, a queue) to propagate updates eventually.

## When not to use it

- The underlying store is relational and already provides native
  secondary indexes — an index table would just be reimplementing, by
  hand and worse, a feature the database engine already gives you.
- The secondary field is queried rarely, or the dataset is small enough
  that a full scan is already fast — the write-amplification and storage
  cost of an index table isn't worth paying.
- The indexed field changes on nearly every write and the application
  can't tolerate any staleness — a rapidly-changing field forces either
  expensive synchronous updates on every write or an index that's
  perpetually a little behind.

## Use-case scenarios

**Login by email over an ID-keyed user store.** A user service keeps its
`users` table keyed (and sharded) by an opaque user ID, because that's
what every internal reference carries. But login arrives with an email
address, not an ID. An `email → user_id` index table turns
authentication's hot-path lookup into a single direct read instead of a
fan-out scan of every shard, and because email changes rarely, keeping
the index in sync costs almost nothing on the write side.

**Azure Table Storage secondary access path.** Azure Table Storage is
efficiently queryable only by partition key and row key — there is no
built-in secondary index. An application storing movies partitioned by
genre (so "find action movies" is fast) that also needs "find movies
starring this actor" creates a second table partitioned by actor name,
each row pointing back to (or duplicating a few fields of) the
corresponding movie — a hand-built index table standing in for the
secondary index the store doesn't provide.

**Global secondary index over a sharded orders table.** An orders store
is sharded by order ID for even write distribution, but support agents
constantly need "all orders for this customer." A global secondary index
partitioned by customer ID resolves that query to a single index
partition instead of scattering it across every shard; because the index
spans shards it's maintained asynchronously and is eventually consistent,
which is acceptable here — a newly placed order appearing in the
customer's list a second late is fine, and reads fall back to the
authoritative orders table for anything the index reference can't
confirm.

## Related patterns

- [Key-Value Store](/docs/patterns/building-blocks/key-value-store) — the
  category of store that most often lacks native secondary indexing and
  therefore benefits from this pattern.
- [Sharding](/docs/patterns/storage/sharding) — index tables are
  especially useful over sharded data; a global secondary index lets a
  query resolve directly to the owning partition via a non-shard-key
  field instead of fanning out to every shard.
- [Materialized View](/docs/patterns/storage/materialized-view) — the
  sibling derived structure that stores precomputed *results* rather than
  *pointers* to source rows; the two are complementary and can be layered.
- [Change Data Capture](/docs/patterns/batch-streaming/change-data-capture) —
  a common mechanism for eventually propagating fact-table writes into an
  asynchronously maintained (global) secondary index.

## Further reading

- [Index Table pattern — Azure Architecture Center (Microsoft)](https://learn.microsoft.com/en-us/azure/architecture/patterns/index-table)
- [Improving data access with secondary indexes (DynamoDB) — AWS docs](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/SecondaryIndexes.html)
- [Database index — Wikipedia](https://en.wikipedia.org/wiki/Database_index)
- [Covering index — Wikipedia](https://en.wikipedia.org/wiki/Database_index#Covering_index)
