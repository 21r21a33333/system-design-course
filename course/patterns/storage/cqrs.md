---
title: "CQRS"
sidebar_position: 5
supplementary: true
---

Command Query Responsibility Segregation (CQRS) splits an application's
write path (commands, which change state) from its read path (queries,
which return state) into separate models — and often separate physical
stores — instead of using one schema for both.

## Problem it solves

A single, normalized schema is usually a good fit for writes: it avoids
duplication and keeps updates consistent. But that same schema is often
a poor fit for reads, which frequently need denormalized, aggregated,
or search-optimized views spanning many entities — forcing either
expensive joins at read time or a schema that compromises between two
very different jobs. CQRS resolves the tension by admitting that writes
and reads have fundamentally different requirements and letting each be
modeled — and scaled — independently.

## How it works

Commands (state-changing requests like "place order") go through a
write model that enforces business rules and invariants, typically
backed by a normalized, transactional store. Queries (read requests
like "show this customer's order history with product names and
current shipping status") are served from a separate read model, often
a denormalized store, a search index, or a materialized view, shaped
specifically for the access patterns callers need. Something has to
propagate changes from the write side to the read side — usually by
publishing an event on every command and having a subscriber update the
read model asynchronously.

That asynchronous propagation is the core tradeoff: the read model is
not guaranteed to reflect the very latest write the instant it happens,
so callers of the read side are working with eventually consistent
data. Applications adopting CQRS have to decide, per use case, whether
that lag (typically milliseconds to low seconds) is acceptable, and
sometimes route latency-sensitive read-your-own-write scenarios back
through the write store directly.

CQRS pairs naturally with [event sourcing](/docs/patterns/storage/event-sourcing):
if the write side already produces an immutable, ordered log of
domain events as its source of truth, that log is a natural, complete
feed to replay into one or more purpose-built read models — and if a
read model's shape needs to change, it can simply be rebuilt from
scratch by replaying the event log again, rather than migrated in
place.

## When to use it

- Read and write workloads have very different shapes or very different
  scaling needs (e.g. reads vastly outnumber writes and need
  denormalized, search-friendly views).
- The domain already produces meaningful events (especially if paired
  with event sourcing) that a read model can subscribe to.
- Different parts of the system need different read representations of
  the same underlying data (a dashboard view, a search index, an
  export feed) that would be awkward to serve from one shared schema.

## When not to use it

- The read and write patterns are simple and similar enough that one
  schema serves both well — CQRS adds a second model, a synchronization
  mechanism, and eventual-consistency reasoning for no real gain.
- The application cannot tolerate any lag between a write and that
  write being visible on every read path.
- The team isn't prepared to operate and monitor the propagation
  pipeline that keeps the read model in sync — a stuck or lagging
  synchronizer becomes a subtle, hard-to-detect correctness bug.

## Real-world example

Large e-commerce platforms commonly keep a normalized, transactional
store (orders, inventory, pricing) as the write model, while product
search and browse pages are served from a separate, denormalized search
index (built with something like Elasticsearch) that's updated
asynchronously as products and inventory change — trading a small
propagation delay for read performance and flexible querying that the
normalized store isn't built for.

## Related patterns

- [Event Sourcing](/docs/patterns/storage/event-sourcing) — the most
  natural source of the change feed that keeps a CQRS read model in
  sync with the write model.
- [Saga](/docs/patterns/consistency/saga) — a complementary pattern for
  coordinating multi-step writes across services in a CQRS/event-driven
  system without distributed transactions.

## Further reading

- [CQRS — Martin Fowler](https://martinfowler.com/bliki/CQRS.html)
- [Command Query Responsibility Segregation (CQRS) pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs)
