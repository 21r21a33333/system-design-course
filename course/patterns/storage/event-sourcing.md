---
title: "Event Sourcing"
sidebar_position: 4
supplementary: true
---

Event sourcing stores every change to application state as an
immutable, append-only sequence of events, rather than overwriting rows
with their current values — the current state of any entity is derived
by replaying its events from the beginning (or from a snapshot).

![Event Sourcing diagram](/img/patterns/event-sourcing.svg)

## Problem it solves

A conventional data model keeps only the current state: update a row and
the previous value is gone. That's efficient to query but throws away
history — you can't answer "what was this account's balance last
Tuesday" or "why did this order end up cancelled" without a separate,
often bolted-on audit log that's easy to forget to update consistently,
and easy to let drift out of agreement with the real data. Event
sourcing solves this by making the history the *primary* source of truth
instead of an afterthought: the sequence of events that happened is
never lost, because it's the only thing actually stored. Current state
stops being something you save and mutate, and becomes something you
*compute* — which means it can never silently disagree with the history
that produced it.

## Technical architecture & implementation

**The event store is append-only and immutable.** Instead of a table of
current rows, the system stores an ordered log of events —
`AccountOpened`, `FundsDeposited`, `FundsWithdrawn` — each an immutable
fact about something that *already happened*, keyed to the entity
(aggregate) it concerns. Events are only ever appended; nothing is
updated or deleted in the normal course of operation. A correction is
itself a new event (`FundsWithdrawalReversed`), never an edit to a past
one — the same "you don't edit the past, you emit a new fact" discipline
that [event-driven architecture](/docs/patterns/communication/event-driven-architecture)
relies on, applied here as the storage model rather than as a messaging
convention.

**Current state is a fold over events.** To answer "what is this
entity's state right now," the system loads that entity's events in
order and *folds* them through an `apply` function that carries each
event's effect into an accumulating state, producing the current value
as a computed result. The command side validates a request against the
current folded state and, if it's legal, appends one or more new events;
the invariant is that every stored event is already valid, so replay
never needs to reject anything. This cleanly separates *deciding*
(command handling, which can fail) from *evolving* (the pure `apply`
fold, which cannot).

**Snapshots bound replay cost.** The obvious cost is that a read that
used to be a single row lookup now replays potentially thousands of
events. Systems address this with **snapshots**: a periodically cached
fold result at a known version. A read restores the latest snapshot and
replays only the *tail* of events recorded after it, turning an
unbounded replay into a bounded one. Crucially, a snapshot is derived
data, not a second source of truth — delete every snapshot and full
state still rebuilds from the events alone, which is exactly what makes
snapshots safe to discard and regenerate whenever the fold logic
changes.

**Replay is a superpower, not just a cost.** Because state is computed
from an immutable log, you can fix a bug in the derivation logic and
replay the whole history to produce corrected state; reconstruct state
as of any past instant for debugging or audit ("what did this look like
the moment the incident fired"); or build an entirely new read model
after the fact by replaying existing events into it. None of this is
possible when you only stored the latest row.

**Projections turn events into queryable read models.** The event store
answers "give me one aggregate's events" efficiently, but it is *not*
built for ad-hoc queries like "all accounts overdrawn this month." Those
are served by **projections**: subscribers that fold the event stream
into read-optimized views (a SQL table, a search index, a cache). This
is precisely the read side of [CQRS](/docs/patterns/storage/cqrs), and
each projection is effectively a
[materialized view](/docs/patterns/storage/materialized-view) over the
log. Projections lag the write side slightly, so an event-sourced system
is eventually consistent on its query paths — the same stale-read window
CQRS reasons about.

**Hard parts: schema evolution and deletion.** Two problems make event
sourcing genuinely harder than mutable storage. Event **schema
evolution** — reasoning about what an old event means under today's
business logic, and versioning or upcasting old shapes into new ones —
is a design burden with no equivalent in a simple column migration.
And an append-only, never-deleted log collides with **deletion
requirements** like GDPR's right to erasure; the usual answer is
crypto-shredding (encrypt personal data per-subject and throw away the
key) rather than literally rewriting history, because rewriting breaks
every downstream projection's assumptions.

**Differentiating it from WAL, CDC, and EDA.** These all involve logs of
changes, and conflating them is the classic confusion. A
[write-ahead log](/docs/patterns/storage/write-ahead-log) is an
*internal* durability mechanism — the database appends physical/row-level
changes so it can recover after a crash — and it is not a domain-level
source of truth; its records mean nothing outside the storage engine and
are pruned once checkpointed.
[Change data capture](/docs/patterns/batch-streaming/change-data-capture)
*derives* an event stream after the fact from a mutable database's
changelog: the database is still the source of truth and events are a
downstream projection of row diffs. Event sourcing inverts that — events
are captured *first* and are themselves the source of truth, carrying
domain intent (`OrderCancelled`) rather than a reconstructed row diff.
And [event-driven architecture](/docs/patterns/communication/event-driven-architecture)
uses events as *integration messages* between services; event sourcing
uses events as *persistence* within one aggregate's boundary. A system
can event-source internally and still publish separate integration
events outward — the two are different jobs for the word "event."

## Snapshots and schema evolution in practice

Two operational realities dominate a mature event-sourced system.
Snapshotting cadence is a tuning knob: snapshot too rarely and cold
reads replay long tails; snapshot too often and you spend storage and
write effort caching state you rarely read. Teams usually snapshot every
N events per aggregate, or on a size/time threshold, and always keep the
raw events so a snapshot can be rebuilt. Schema evolution is handled with
explicit **event versioning** (`FundsDeposited.v2` adds a currency
field) plus **upcasters** that transform old serialized events into the
current shape at load time, so the `apply` fold only ever sees today's
schema. Getting this wrong — mutating the meaning of an existing event
type in place — silently corrupts every replay and every projection,
which is why event schemas are treated as a long-lived public contract.

## Code example

The essence of event sourcing is deterministic: current state is a pure
fold (`apply`) over an immutable event stream, and a snapshot plus the
tail after it must reconstruct exactly the same state as a full replay
from scratch. That equality is the correctness invariant that makes
snapshotting safe. The `main` below asserts both a full replay's result
and the snapshot-equals-full-replay invariant.

```rust
// Domain events: immutable facts about what happened to an account.
#[derive(Clone, Debug)]
enum LedgerEvent {
    Opened { owner: String },
    Deposited { amount: u64 },
    Withdrawn { amount: u64 },
}

// The current state is NOT stored — it is a fold over the event history.
#[derive(Clone, Debug, PartialEq)]
struct Account {
    owner: String,
    balance: u64,
    version: u64, // number of events folded in; the snapshot's resume point
}

impl Account {
    fn empty() -> Self {
        Account { owner: String::new(), balance: 0, version: 0 }
    }

    // apply is a pure fold step: given a state and one event, produce the
    // next state. It never rejects — validation happens in the command
    // handler before an event is ever appended, so every stored event is a
    // fact that already happened and must be replayable.
    fn apply(&self, event: &LedgerEvent) -> Account {
        let mut next = self.clone();
        next.version += 1;
        match event {
            LedgerEvent::Opened { owner } => next.owner = owner.clone(),
            LedgerEvent::Deposited { amount } => next.balance += amount,
            LedgerEvent::Withdrawn { amount } => next.balance -= amount,
        }
        next
    }
}

// Rebuild current state by replaying an event stream from a starting state.
// Replaying from Account::empty() reconstructs full history; replaying from
// a snapshot only needs the events recorded after that snapshot.
fn replay<'a>(start: Account, events: impl IntoIterator<Item = &'a LedgerEvent>) -> Account {
    events.into_iter().fold(start, |state, event| state.apply(event))
}

// A snapshot is just a cached fold result at a known version, stored to bound
// how many events a cold read must replay. It is derived data, never the
// source of truth — deleting every snapshot loses nothing.
#[derive(Clone)]
struct Snapshot {
    state: Account,
    through_version: u64,
}

fn snapshot_at(events: &[LedgerEvent], through_version: u64) -> Snapshot {
    let state = replay(Account::empty(), events.iter().take(through_version as usize));
    Snapshot { state, through_version }
}

// Load = restore the snapshot, then replay only the tail of events recorded
// after it. This MUST equal a full replay from scratch — that equality is the
// core correctness invariant of snapshotting.
fn load(events: &[LedgerEvent], snapshot: &Snapshot) -> Account {
    let tail = events.iter().skip(snapshot.through_version as usize);
    replay(snapshot.state.clone(), tail)
}

fn main() {
    let events = vec![
        LedgerEvent::Opened { owner: "ada".to_string() },
        LedgerEvent::Deposited { amount: 100 },
        LedgerEvent::Withdrawn { amount: 30 },
        LedgerEvent::Deposited { amount: 5 },
    ];

    let full = replay(Account::empty(), events.iter());
    assert_eq!(full.balance, 75);
    assert_eq!(full.version, 4);

    // Snapshot after the first two events, then load = snapshot + tail replay.
    let snap = snapshot_at(&events, 2);
    let loaded = load(&events, &snap);
    assert_eq!(loaded, full); // snapshot + tail == full replay from scratch
}
```

Because `apply` is pure and total, folding the same events always yields
the same state, and `load` (snapshot plus tail) provably equals `replay`
from `empty()` — so a snapshot is only ever a performance optimization,
never a place correctness can hide. Change the fold logic, throw away the
snapshots, and the corrected state re-derives from the events unchanged.

## When to use it

- An audit trail — proving exactly what happened and when, in order — is
  a first-class requirement, not an add-on (finance, compliance,
  healthcare, anything with regulators or disputes).
- You need to reconstruct historical state, debug "how did we get here"
  after the fact, or replay history to backfill or fix a read model.
- The domain is naturally event-shaped (orders, payments, bookings) with
  meaningful business events rather than anonymous field updates.
- You already want [CQRS](/docs/patterns/storage/cqrs) read models — an
  event log is the most natural, complete feed to project them from and
  to rebuild them when their shape changes.

## When not to use it

- The domain is simple CRUD with no real need for history — event
  sourcing adds substantial complexity (replay logic, snapshotting,
  schema versioning, projection infrastructure) for no corresponding
  benefit.
- Query patterns need current state cheaply and immediately, and the team
  isn't prepared to build and operate the projection and snapshot
  infrastructure that makes reads fast.
- The event schema is likely to churn frequently and unpredictably,
  making long-term replay and upcasting of old events hard to reason
  about.
- Hard deletion of historical data is a routine, load-bearing
  requirement that crypto-shredding can't satisfy for your regulatory
  posture.

## Use-case scenarios

**Bank / payments ledger.** An account balance is derived by replaying
an immutable ledger of debits and credits rather than stored as a
mutable number — regulators require a complete, tamper-evident audit
trail, and "replay the events" is exactly how double-entry bookkeeping
already works. Snapshots per account keep balance reads fast; disputes
are resolved by reconstructing state as of any past moment.

**Order lifecycle.** An order moves through `Placed`, `PaymentCaptured`,
`Shipped`, `Delivered`, `Returned` — each a business event. Storing the
sequence rather than a single mutable `status` column means the full
"how did this order reach its current state" story is always available
for support and analytics, and a new read model (say, a returns-analytics
dashboard) can be built later by replaying orders that already happened.

**Audit-heavy internal domains.** Access-control changes, configuration
edits, or approvals in a compliance-sensitive system are event-sourced
so that "who changed what, when, and in what order" is inherent to the
data model rather than a separate audit log that can drift, be bypassed,
or be forgotten on a new write path.

## Production libraries & getting started

You rarely build an event store from scratch — these are the databases and frameworks that provide the append-only log, optimistic-concurrency guarantees, snapshotting, and projection plumbing described above.

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| EventStoreDB (KurrentDB) | Multi-language (gRPC clients) | Purpose-built event-store database: append-only streams, optimistic concurrency, catch-up subscriptions, and server-side projections | [developers.eventstore.com](https://developers.eventstore.com/getting-started/) |
| Marten | .NET / PostgreSQL | Turns Postgres into an event store + document DB, with async projections and inline/live aggregation | [martendb.io](https://martendb.io/events/) |
| Axon Framework | Java / JVM | Full DDD + event-sourcing + CQRS framework: aggregates, event store, command/event buses, sagas | [docs.axoniq.io](https://docs.axoniq.io/home/) |
| Eventuous | .NET | Lightweight event-sourcing library with pluggable stores (EventStoreDB, Postgres) and subscriptions | [eventuous.dev](https://eventuous.dev/) |
| eventsourcing | Python | Aggregate roots, event stores, snapshots, and application layer for event-sourced domains | [eventsourcing.readthedocs.io](https://eventsourcing.readthedocs.io/en/stable/) |
| Emmett | JS / TS | Node event-sourcing toolkit: event stores, command handling, and projections with a functional API | [event-driven-io.github.io/emmett](https://event-driven-io.github.io/emmett/getting-started.html) |
| cqrs-es | Rust | Opinionated CQRS + event-sourcing framework with pluggable persistence (Postgres, DynamoDB) | [doc.rust-cqrs.org](https://doc.rust-cqrs.org/) |
| Commanded | Elixir | Event-sourced aggregates, command routing, event handlers, and process managers on the BEAM | [hexdocs.pm/commanded](https://hexdocs.pm/commanded/Commanded.html) |

**Example / reference:** [serverlesstechnology/cqrs (cqrs-es source + Postgres store)](https://github.com/serverlesstechnology/cqrs)

## Related patterns

- [CQRS](/docs/patterns/storage/cqrs) — the natural companion: event
  sourcing supplies the write-side log of truth, CQRS projects it into
  purpose-built read models. Common together but independent — you can
  use either without the other.
- [Write-Ahead Log](/docs/patterns/storage/write-ahead-log) — an
  internal durability log the storage engine replays to recover; event
  sourcing promotes the same append-then-replay idea to be the
  *application's* domain source of truth.
- [Change Data Capture](/docs/patterns/batch-streaming/change-data-capture) —
  derives an event stream *after the fact* from a mutable database's
  changelog; event sourcing captures domain events *first* as the truth.
- [Event-Driven Architecture](/docs/patterns/communication/event-driven-architecture) —
  uses events as integration messages between services; event sourcing
  uses events as persistence within an aggregate. A system can do both.
- [Materialized View](/docs/patterns/storage/materialized-view) — each
  event-sourced projection is a materialized view precomputed over the
  event log to serve queries the log itself can't answer efficiently.
- [Saga](/docs/patterns/consistency/saga) — coordinates multi-step,
  cross-aggregate workflows in an event-sourced system without
  distributed transactions.

## Further reading

- [Event Sourcing — Martin Fowler](https://martinfowler.com/eaaDev/EventSourcing.html)
- [Event Sourcing pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing)
- [Event sourcing — microservices.io (Chris Richardson)](https://microservices.io/patterns/data/event-sourcing.html)
- [Event store — Wikipedia](https://en.wikipedia.org/wiki/Event_store)
- [Turning the database inside-out — Martin Kleppmann](https://www.confluent.io/blog/turning-the-database-inside-out-with-apache-samza/)
