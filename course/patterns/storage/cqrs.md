---
title: "CQRS"
sidebar_position: 5
supplementary: true
---

Command Query Responsibility Segregation (CQRS) splits an application's
write path (commands, which change state) from its read path (queries,
which return state) into separate models — and often separate physical
stores — each independently optimized and scaled, with the read side kept
in sync asynchronously and therefore eventually consistent.

![CQRS diagram](/img/patterns/cqrs.svg)

## Problem it solves

A single, normalized schema is usually a good fit for writes: it avoids
duplication and keeps updates consistent by keeping each fact in one
place. But that same schema is often a poor fit for reads, which
frequently need denormalized, aggregated, or search-optimized views
spanning many entities — forcing either expensive joins at read time or a
schema that compromises between two very different jobs. The tension gets
worse under scale, because reads and writes rarely grow at the same rate:
a product catalog might take a trickle of writes and a firehose of reads,
yet a shared model forces both onto the same store, the same indexes, and
the same scaling decisions. CQRS resolves this by admitting that writes
and reads have fundamentally different requirements and letting each be
modeled, tuned, and scaled independently.

## Technical architecture & implementation

**The command side owns correctness.** Commands are state-changing
intentions — `PlaceOrder`, `RestockProduct`. They flow through a write
model that validates business rules and invariants against current state
and then mutates it, typically over a normalized, transactional store
where consistency is the priority. A rejected command changes nothing,
so an invalid transition never escapes to the read side. This side is
tuned for *writing correctly*, not for serving queries.

**The query side owns read shape.** Queries are served from one or more
separate read models, each denormalized and shaped for a specific access
pattern — a search index for text lookups, a pre-aggregated table for a
dashboard, a single-row "product card" for a browse page. A read model
holds *no* business rules; those were already enforced write-side. It
just reshapes accepted facts so a query is a direct lookup instead of a
join-heavy computation. This is why a CQRS read model is very often a
[materialized view](/docs/patterns/storage/materialized-view): a
precomputed, query-optimized projection of the write model's data.

**Synchronization is asynchronous — the core tradeoff.** Something must
carry accepted changes from the write side to each read model. The usual
mechanisms are publishing an **event** on every successful command
(especially natural when paired with
[event sourcing](/docs/patterns/storage/event-sourcing)) or capturing the
write via [change data capture](/docs/patterns/batch-streaming/change-data-capture)
and projecting the resulting stream. Either way the propagation is
asynchronous, so the read model is *not* guaranteed to reflect the latest
write the instant it lands. Callers of the read side work with
**eventually consistent** data, and the application must decide, per use
case, whether that lag (typically milliseconds to low seconds) is
acceptable.

**The stale-read window and read-your-writes.** The most common trap is a
user performing a write and immediately querying a read model that hasn't
caught up — they see their own change missing and think it failed.
Standard mitigations: route latency-sensitive read-your-own-write flows
back through the write store directly; return the new state
optimistically from the command response rather than re-querying; or
surface a "pending" state until the projection confirms. Recognizing
*which* reads can tolerate lag and which can't is most of the design work
in adopting CQRS.

**Multiple purpose-built read models.** A single write model can feed
many read models simultaneously — a search index, a reporting rollup, an
export feed — each optimized for its own consumers and scaled
independently of the others and of the write side. Adding a new read
model later is just adding a new projection subscriber; if a read model's
shape needs to change, it can be rebuilt from scratch by re-projecting
from the change feed (or, with event sourcing, by replaying the event
log) rather than migrated in place.

**Failure modes.** The synchronization pipeline is the fragile part. A
stuck or lagging projector makes the read side silently stale — a subtle
correctness bug that looks like nothing is wrong until someone notices
old data, so consumer-lag monitoring is not optional. Because delivery is
usually at-least-once, projectors must be **idempotent** (see
[idempotency](/docs/patterns/reliability/idempotency)), typically
deduplicating by event id or sequence number so a redelivered change
doesn't double-apply. And more moving parts — two models, a feed, and
eventual-consistency reasoning on every read path — is real complexity
that most CRUD applications simply don't need.

**CQRS vs. event sourcing — what each is and how they combine.** They are
routinely confused because they pair so often, but they are independent
choices. **CQRS** is about *separating read and write models*; it says
nothing about *how* the write model stores data. **Event sourcing** is
about *storing state as a log of events*; it says nothing about read/write
separation. You can do plain CQRS with two ordinary databases synced by
CDC and no events as truth; you can event-source a single aggregate and
read its state right back by folding events with no separate read model.
Their sweet spot is the *combination*: an event-sourced write model
produces an immutable, ordered log that is the ideal feed for projecting
CQRS read models — and for rebuilding them by replay. CQRS is the
read/write split; event sourcing is the write-side storage decision that
makes that split especially powerful.

## Read models and eventual consistency

Treating each read model as disposable is the mental shift that makes
CQRS manageable. A read model is derived data — a cache of the write
side's truth in a convenient shape — so it can be dropped and rebuilt
whenever its schema changes or a projection bug is fixed, without
touching the authoritative write store. That safety net is what lets
teams iterate on query shapes freely. The price is that every read path
must be designed knowing it may be briefly behind: SLAs on projection lag,
explicit read-your-writes handling where users expect immediacy, and
monitoring that alerts when a projector falls behind rather than letting
stale reads accumulate unnoticed. Eventual consistency isn't a bug to
paper over in CQRS — it's the defining property to design around.

## Code example

CQRS in miniature: a **command side** that validates against current
write-model state and *emits events* (rejecting invalid commands so no
bad transition escapes), and a separate **projection** that folds those
events into a denormalized read model holding no business rules. The
`main` below drives commands through the write side, projects the emitted
events into the read model, confirms an illegal command is rejected and
leaves the read model untouched, and asserts the read model reflects the
accepted command sequence.

```rust
use std::collections::HashMap;

// --- Write side: commands are validated intentions; events are the facts a
// successful command produces. The write model owns invariants. ---
enum Command {
    CreateProduct { id: u64, name: String, price: u64 },
    Restock { id: u64, qty: u32 },
    Sell { id: u64, qty: u32 },
}

#[derive(Clone)]
enum Event {
    ProductCreated { id: u64, name: String, price: u64 },
    Restocked { id: u64, qty: u32 },
    Sold { id: u64, qty: u32 },
}

// The write model: normalized, consistency-focused, tuned for validation —
// not for the shapes queries want.
#[derive(Default)]
struct WriteModel {
    stock: HashMap<u64, u32>,
    exists: HashMap<u64, bool>,
}

impl WriteModel {
    // Validate against current write state, then EMIT events. Returning an
    // error means no event is produced, so the read side never sees an
    // invalid transition. This is the command side of CQRS.
    fn handle(&mut self, cmd: Command) -> Result<Vec<Event>, &'static str> {
        match cmd {
            Command::CreateProduct { id, name, price } => {
                if self.exists.contains_key(&id) {
                    return Err("product already exists");
                }
                self.exists.insert(id, true);
                self.stock.insert(id, 0);
                Ok(vec![Event::ProductCreated { id, name, price }])
            }
            Command::Restock { id, qty } => {
                let s = self.stock.get_mut(&id).ok_or("no such product")?;
                *s += qty;
                Ok(vec![Event::Restocked { id, qty }])
            }
            Command::Sell { id, qty } => {
                let s = self.stock.get_mut(&id).ok_or("no such product")?;
                if *s < qty {
                    return Err("insufficient stock"); // invariant enforced here
                }
                *s -= qty;
                Ok(vec![Event::Sold { id, qty }])
            }
        }
    }
}

// --- Read side: a denormalized projection shaped for one query pattern —
// "browse products with price and availability." Updated ASYNCHRONOUSLY from
// the write side's events, which is why it is only eventually consistent. ---
#[derive(Clone, PartialEq, Debug)]
struct ProductCard {
    name: String,
    price: u64,
    in_stock: u32,
}

#[derive(Default)]
struct CatalogReadModel {
    cards: HashMap<u64, ProductCard>,
}

impl CatalogReadModel {
    // The projection: fold events into a read-optimized view. It holds no
    // business rules — those were already enforced write-side. It just
    // reshapes facts for fast reads.
    fn project(&mut self, event: &Event) {
        match event {
            Event::ProductCreated { id, name, price } => {
                self.cards.insert(*id, ProductCard { name: name.clone(), price: *price, in_stock: 0 });
            }
            Event::Restocked { id, qty } => {
                if let Some(c) = self.cards.get_mut(id) {
                    c.in_stock += qty;
                }
            }
            Event::Sold { id, qty } => {
                if let Some(c) = self.cards.get_mut(id) {
                    c.in_stock -= qty;
                }
            }
        }
    }

    fn card(&self, id: u64) -> Option<&ProductCard> {
        self.cards.get(&id)
    }
}

fn main() {
    let mut write = WriteModel::default();
    let mut read = CatalogReadModel::default();

    // Drive commands through the write side; the events it emits are what
    // later update the read side (here, synchronously for a deterministic
    // demo — in production a broker/CDC carries them, hence the stale window).
    let commands = vec![
        Command::CreateProduct { id: 1, name: "Keyboard".to_string(), price: 4999 },
        Command::Restock { id: 1, qty: 10 },
        Command::Sell { id: 1, qty: 3 },
    ];

    for cmd in commands {
        let events = write.handle(cmd).expect("valid command");
        for ev in &events {
            read.project(ev); // the projection step: write events -> read model
        }
    }

    // A rejected command emits no events, so the read model is untouched.
    assert!(write.handle(Command::Sell { id: 1, qty: 999 }).is_err());

    // The read model reflects the sequence of accepted commands.
    let card = read.card(1).unwrap();
    assert_eq!(card, &ProductCard { name: "Keyboard".to_string(), price: 4999, in_stock: 7 });
}
```

The write model never serves the query, and the read model never
enforces a rule — that separation is the whole point. In this demo the
projection runs synchronously right after each command for determinism;
in production the events travel over a broker or CDC feed, which is
exactly where the eventual-consistency window comes from.

## When to use it

- Read and write workloads have very different shapes or scaling needs —
  reads vastly outnumber writes and need denormalized, search-friendly,
  or pre-aggregated views a normalized write schema can't serve cheaply.
- Different parts of the system need different read representations of the
  same data (a dashboard, a search index, an export feed) that would be
  awkward to serve from one shared schema.
- The domain already produces meaningful events — especially if paired
  with [event sourcing](/docs/patterns/storage/event-sourcing) — that
  read models can subscribe to and rebuild from.
- You can tolerate an eventual-consistency lag on the affected read paths
  and are prepared to handle read-your-writes where users expect
  immediacy.

## When not to use it

- The read and write patterns are simple and similar enough that one
  schema serves both well — CQRS adds a second model, a synchronization
  mechanism, and eventual-consistency reasoning for no real gain. Most
  CRUD applications are firmly here.
- The application cannot tolerate any lag between a write and that write
  being visible on every read path, and can't isolate the few reads that
  genuinely need immediacy.
- The team isn't ready to operate and monitor the propagation pipeline
  that keeps read models in sync — a stuck or lagging projector becomes a
  subtle, hard-to-detect correctness bug.

## Use-case scenarios

**High-read product catalog.** A normalized, transactional store
(products, inventory, pricing) is the write model; browse and search
pages are served from a separate denormalized search index (something
like Elasticsearch) updated asynchronously as products and stock change.
The write side stays small and consistent; the read side scales
independently to absorb a firehose of reads, trading a small propagation
delay for fast, flexible querying the normalized store can't provide.

**Reporting and analytics dashboards.** An operational database takes the
writes; a separate, pre-aggregated read model (rollup tables, a columnar
store) serves dashboards. Heavy analytical queries never touch — or slow
down — the transactional write path, and the aggregation shape is tuned
purely for the reports, rebuilt from the change feed whenever a new
metric is needed.

**Collaboration / activity feeds.** A write model records discrete
actions (comments, edits, reactions); a fan-out read model materializes
each user's personalized feed. Writes are cheap point-appends; the
expensive fan-out is done once on the read side and cached in the exact
shape the timeline UI renders, so a feed load is a single lookup rather
than a cross-entity join at request time.

## Related patterns

- [Event Sourcing](/docs/patterns/storage/event-sourcing) — the most
  natural source of the change feed that keeps CQRS read models in sync,
  and the log that lets them be rebuilt by replay; common but optional
  pairing.
- [Materialized View](/docs/patterns/storage/materialized-view) — a CQRS
  read model *is* usually a materialized view: a precomputed,
  query-optimized projection of the write model's data.
- [Change Data Capture](/docs/patterns/batch-streaming/change-data-capture) —
  an alternative to explicit events for feeding read models: derive the
  sync stream from the write database's changelog.
- [Event-Driven Architecture](/docs/patterns/communication/event-driven-architecture) —
  the messaging substrate that commonly carries a command's emitted
  events from the write side to the projectors.
- [Saga](/docs/patterns/consistency/saga) — coordinates multi-step writes
  across services in a CQRS/event-driven system without distributed
  transactions.
- [Idempotency](/docs/patterns/reliability/idempotency) — the discipline
  projectors need so at-least-once redelivery of change events doesn't
  double-apply to a read model.

## Further reading

- [CQRS — Martin Fowler](https://martinfowler.com/bliki/CQRS.html)
- [CQRS pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs)
- [Command Query Responsibility Segregation (CQRS) — microservices.io (Chris Richardson)](https://microservices.io/patterns/data/cqrs.html)
- [Command Query Responsibility Segregation — Wikipedia](https://en.wikipedia.org/wiki/Command_Query_Responsibility_Segregation)
