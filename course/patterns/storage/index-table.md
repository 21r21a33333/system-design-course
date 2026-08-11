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

## How it works

An index table is a second table, stored alongside the original ("fact")
table, whose own key is the field applications need to query by. Each
row in the index table maps a value of that secondary field to enough
information to retrieve the matching fact-table row(s) — either the full
duplicated data, or just a reference (the primary/shard key) back to the
fact table. Which of those two approaches to take is the pattern's main
design decision. Duplicating the full row into the index table (denormalized)
serves the secondary query with a single lookup, at the cost of storing
the data twice and updating both copies on every write. Storing only a
reference (normalized) keeps one copy of the data and a smaller index to
maintain, at the cost of a second lookup — first the index table to find
the primary key, then the fact table to fetch the row. A common middle
ground duplicates only the handful of fields the secondary query
actually needs, and defers to the fact table for anything else.

Whichever shape is chosen, the index table has to be kept in sync with
the fact table on every write to the indexed field, and that
synchronization is the pattern's central tradeoff. It can be done
transactionally — writing to both tables atomically, if the store
supports it for co-located data — or eventually, by publishing a change
and letting an asynchronous process update the index table shortly
after. Transactional updates keep the index table always correct but
require the store to support multi-row atomicity; eventual updates scale
better and touch fewer resources per write but leave a window where
the index table can return a stale or missing result. Either way, an
index table is an extra structure: it costs additional storage, and
every write to an indexed field becomes at least two writes instead of
one, so index tables are worth building only for fields that are
actually queried often enough to justify that overhead.

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

## Real-world example

Azure Table Storage has no built-in secondary index: a table is
efficiently queryable only by its partition key and row key. An
application storing movies partitioned by genre (so "find action movies"
is fast) that also needs to answer "find movies starring this actor"
creates a second table partitioned by actor name, with each row pointing
back to (or duplicating) the corresponding movie — a manually built index
table standing in for the secondary index the store doesn't offer
natively.

## Related patterns

- [Key-Value Store](/docs/patterns/building-blocks/key-value-store) — the
  category of store that most often lacks native secondary indexing and
  therefore benefits from this pattern.
- [Sharding](/docs/patterns/storage/sharding) — index tables are
  especially useful over sharded data, letting a query resolve directly
  to the owning shard via a non-shard-key field instead of fanning out
  to every shard.

## Further reading

- [Index Table pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/index-table)
- [Database index — Wikipedia](https://en.wikipedia.org/wiki/Database_index)
