---
title: "Event Sourcing"
sidebar_position: 4
supplementary: true
---

Event sourcing stores every change to application state as an
immutable, append-only sequence of events, rather than overwriting rows
with their current values — the current state of any entity is derived
by replaying its events from the beginning (or from a snapshot).

## Problem it solves

A conventional data model keeps only the current state: update a row and
the previous value is gone. That's efficient to query but throws away
history — you can't answer "what was this account's balance last
Tuesday" or "why did this order end up cancelled" without a separate,
often bolted-on audit log that's easy to forget to update consistently.
Event sourcing solves this by making the history the primary source of
truth instead of an afterthought: the sequence of events that happened
is never lost, because it's the only thing actually stored.

## How it works

Instead of a table of current rows, the system stores a log of events —
`AccountOpened`, `FundsDeposited`, `FundsWithdrawn` — each an immutable
fact about something that already happened, keyed to the entity it
concerns and ordered. To answer "what is this entity's state right
now," the system loads all events for that entity and folds them,
in order, through a function that applies each event's effect,
producing the current state as a computed result rather than a stored
one. Because nothing is ever overwritten, the full history of how an
entity reached its current state is automatically preserved and
directly queryable — a complete audit trail comes for free. It also
means state can be reconstructed as of any past point in time, and
bugs in the state-derivation logic can be fixed and the whole history
safely replayed to rebuild correct current state.

The cost shows up in two places. First, queries that used to be a
simple row lookup now require replaying potentially many events, so
systems typically maintain periodic snapshots of computed state to
avoid replaying an entity's entire history on every read. Second, event
schemas evolve over time, and reasoning about "what does this old event
mean under the current version of the business logic" is a genuinely
harder design problem than just migrating a column.

## When to use it

- An audit trail — proving exactly what happened and when, in order —
  is a first-class requirement, not an add-on (finance, compliance,
  healthcare).
- You need to reconstruct historical state, debug "how did we get here"
  after the fact, or replay history to backfill a new read model.
- The domain is naturally event-shaped (orders, payments, bookings) with
  meaningful business events rather than just field updates.

## When not to use it

- The domain is simple CRUD with no real need for history — event
  sourcing adds substantial complexity (replay logic, snapshotting,
  schema evolution) for no corresponding benefit.
- Query patterns need current state cheaply and quickly, and the team
  isn't prepared to build and maintain the read-model/snapshot
  infrastructure that makes that fast.
- The event schema is likely to change frequently and unpredictably,
  making long-term replay of old events difficult to reason about.

## Real-world example

Banking and payment ledger systems are a canonical fit: an account
balance is derived by replaying the ledger of debits and credits rather
than stored as a mutable number, both because regulators require a
complete, immutable audit trail and because "replay the events" is
exactly how double-entry bookkeeping already works conceptually.

## Related patterns

- [Write-Ahead Log](/docs/patterns/storage/write-ahead-log) — a WAL is
  an append-only log used internally for durability; event sourcing
  promotes that same append-only-log idea to be the application's
  actual data model.
- [CQRS](/docs/patterns/storage/cqrs) — pairs naturally with event
  sourcing, since a read-optimized model is typically built by
  replaying the event log into a separate queryable store.

## Further reading

- [Event sourcing — Martin Fowler](https://martinfowler.com/eaaDev/EventSourcing.html)
- [Domain-driven design — Wikipedia](https://en.wikipedia.org/wiki/Domain-driven_design)
