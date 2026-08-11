---
title: "Event-Driven Architecture"
sidebar_position: 2
supplementary: true
---

Event-driven architecture (EDA) is a system-level architectural style in
which components communicate by producing and reacting to events —
immutable records of something that already happened, like "order placed"
or "payment captured" — routed through an event broker, rather than
invoking each other directly and waiting for a response.

![Event-Driven Architecture diagram](/img/patterns/event-driven-architecture.svg)

## Problem it solves

In a purely synchronous, direct-call architecture, every service that
needs to know about a state change has to be called explicitly by the
service that caused it. That producer ends up hard-coded with knowledge of
every downstream consumer, and a slow or failing consumer can block or fail
the whole call chain — a checkout that must synchronously call payment,
inventory, shipping, and email is only as available and as fast as the
slowest of them. EDA breaks that chain: the producer records a fact about
what happened and moves on, regardless of how many services care or how
long they take. Consumers subscribe independently, process at their own
pace, and can be added, removed, or restarted without the producer
noticing. The trade is that the system becomes eventually consistent and
its end-to-end behavior becomes emergent rather than written down in one
place — the discoverability cost this page keeps returning to.

## Technical architecture & implementation

**Events are immutable facts, not commands.** The unit of communication is
an event describing something that *already occurred* — `OrderPlaced`, not
`PlaceOrder`. This framing matters: a command names a specific recipient
and expects it to act, which re-couples producer to consumer; an event just
announces a fact and lets any number of consumers decide independently
whether and how to react. Events are immutable — you never edit a past
fact, you emit a new one (`OrderCancelled`) — which is what makes them safe
to replay and to fan out.

**The event broker decouples producers from consumers.** Producers publish
to a broker — almost always a [pub-sub](/docs/patterns/communication/pub-sub)
topic or a log-based [distributed message queue](/docs/patterns/building-blocks/distributed-message-queue)
such as Kafka — and consumers subscribe to event types they care about.
Neither references the other; the event *type* is the only shared contract.
This is what lets teams evolve producers and consumers on independent
release cycles.

**Three event styles — the central design choice.** How much an event
carries determines the coupling and the failure modes, and is important
enough to get its own table below. Briefly: a *notification* is a thin "it
happened, here's an id," and the consumer calls back to fetch detail;
*event-carried-state-transfer* puts the data the consumer needs *inside*
the event so no callback is required; *event sourcing* makes the event log
itself the system of record. Event sourcing is a storage decision with its
own deep mechanics — see
[Event Sourcing](/docs/patterns/storage/event-sourcing) and the read-model
split in [CQRS](/docs/patterns/storage/cqrs) — so this page treats it only
as one point on the event-richness spectrum rather than re-teaching it.

**Choreography vs. orchestration.** Once services react to events, a
multi-step workflow can be sequenced two ways. In *choreography* each
service reacts to events and emits its own in turn, with no central
controller — simple to extend but with the workflow implicit across every
handler. In *orchestration* a central coordinator drives each step and
tracks progress — easy to reason about at the cost of a shared dependency.
This choice is general enough to have its own page; see
[Choreography](/docs/patterns/consistency/choreography) for the
coordination trade-off and [Saga](/docs/patterns/consistency/saga) for the
version specialized to workflows with compensating undo actions. EDA is the
substrate both are built on; it doesn't prescribe which you use.

**Eventual consistency and idempotency.** Because consumers process
asynchronously and independently, the system is only eventually consistent:
right after an event fires, a consumer that hasn't caught up will read stale
state for a window. And because brokers deliver at-least-once, the same
event can arrive twice after a crash or a lost ack — so consumers must be
**idempotent** (see [Idempotency](/docs/patterns/reliability/idempotency)),
deduplicating by event id or making their effect naturally repeatable. The
code example below builds idempotent dedup into the router itself.

**Ordering and dead-lettering.** Ordering is generally guaranteed only
per-key/partition, so causally related events must share a key or consumers
must tolerate reordering. Events that repeatedly fail processing are routed
to a [dead-letter queue](/docs/patterns/reliability/dead-letter-queue)
rather than blocking the stream or being dropped — the poison-message
handling that keeps one bad event from stalling a partition.

**The core tradeoff — decoupling vs. discoverability.** EDA buys extreme
decoupling and independent evolution, but pays in traceability: no single
artifact describes "what happens when an order is placed," so answering it
means tracing subscriptions and distributed traces across services.
[Distributed tracing](/docs/patterns/observability/distributed-tracing) and
a well-governed event catalog are what make an EDA operable at scale; without
them the emergent behavior becomes genuinely hard to reason about.

## Event notification vs. event-carried-state-transfer vs. event sourcing

These three styles are the practical knobs of EDA. They differ in how much
state the event carries and who owns the truth.

| | Event notification | Event-carried-state-transfer | Event sourcing |
| --- | --- | --- | --- |
| Payload | Thin: id + "it happened" | Full: the data consumers need | The event *is* the record |
| Consumer callback | Yes — calls producer for detail | No — event is self-contained | No — replays the log |
| Coupling | Runtime (callback) coupling | Schema coupling on payload | Coupling to the event log |
| Source of truth | Producer's database | Producer's database | The event store itself |
| Main risk | Callback load; producer availability | Stale/duplicated data; large events | Schema evolution; replay cost |
| Depth link | — | — | [Event Sourcing](/docs/patterns/storage/event-sourcing) / [CQRS](/docs/patterns/storage/cqrs) |

Most real systems mix them: a thin notification to trigger reactions, plus
a fatter carried-state event where consumers would otherwise stampede the
producer with callbacks, and event sourcing reserved for domains where the
full history is itself valuable.

## Code example

The heart of EDA is a router that dispatches immutable events to
type-subscribed consumers, deduplicates redelivered events (at-least-once
safety), lets a consumer emit follow-up events so a choreographed workflow
advances with no central driver, and dead-letters events no consumer
handles. The runnable checks confirm a redelivered event is processed once
and that an unroutable event is dead-lettered rather than lost.

```rust
use std::collections::HashMap;
use std::collections::HashSet;

// An event is an immutable fact: something that ALREADY happened. It
// carries an id (for idempotent dedup), a type used for routing, and a
// payload. The producer emits it and moves on — it never learns who
// consumed it or what they did.
#[derive(Clone, Debug)]
pub struct Event {
    pub id: u64,
    pub kind: String,
    pub payload: String,
}

// A consumer reacts to one event type. Returning follow-up events lets a
// choreographed workflow advance with no central coordinator: one
// handler's output becomes the next handler's input.
type Consumer = fn(&Event) -> Vec<Event>;

pub struct EventRouter {
    // event type -> the consumers subscribed to it. Producers and
    // consumers are decoupled: neither references the other, only the type.
    routes: HashMap<String, Vec<Consumer>>,
    // At-least-once delivery means the same event id can arrive twice;
    // consumers must be idempotent. The router enforces dedup centrally.
    seen: HashSet<u64>,
    // Events that matched no consumer, or that a consumer explicitly
    // rejected, land here — the dead-letter path.
    dead_letters: Vec<Event>,
}

impl EventRouter {
    pub fn new() -> Self {
        EventRouter { routes: HashMap::new(), seen: HashSet::new(), dead_letters: Vec::new() }
    }

    pub fn on(&mut self, kind: &str, consumer: Consumer) {
        self.routes.entry(kind.to_string()).or_default().push(consumer);
    }

    // Deliver one event. Duplicate ids are dropped (idempotent intake).
    // Unroutable events are dead-lettered. Follow-up events emitted by
    // consumers are dispatched in turn — choreography, driven by data.
    pub fn dispatch(&mut self, event: Event) {
        let mut queue = vec![event];
        while let Some(ev) = queue.pop() {
            if !self.seen.insert(ev.id) {
                continue; // already processed — at-least-once safety net
            }
            match self.routes.get(&ev.kind) {
                Some(consumers) => {
                    let consumers = consumers.clone();
                    for c in consumers {
                        for follow_up in c(&ev) {
                            queue.push(follow_up);
                        }
                    }
                }
                None => self.dead_letters.push(ev),
            }
        }
    }

    pub fn dead_letters(&self) -> &[Event] {
        &self.dead_letters
    }
}
```

Because `dispatch` records every event id in `seen` before running its
consumers, delivering the same `OrderPlaced` twice runs its handlers only
once — the idempotent intake every at-least-once system needs. A consumer
returning a `payment.requested` event feeds it back through the same
router, which is choreography in miniature: the workflow advances with no
component holding the whole sequence.

## When to use it

- Multiple services need to react to the same fact, and that set of services
  changes over time — you want to add a reactor without touching the
  producer.
- Workflows decompose into independent steps that needn't complete
  synchronously with the triggering action.
- The system must absorb bursts without back-pressuring the producer —
  consumers can lag and catch up.
- Audit history or replay of past behavior is valuable (pushing toward the
  event-sourcing end of the spectrum).

## When not to use it

- The caller needs a synchronous, authoritative answer before proceeding
  ("was this payment approved?") — request-response or
  [asynchronous request-reply](/docs/patterns/communication/asynchronous-request-reply)
  fits better.
- Strong, immediate consistency across services is a hard requirement —
  eventual consistency is fundamental to this style, not a tunable knob.
- The team can't yet operate the extra infrastructure — broker, dead-letter
  handling, consumer-lag monitoring, and the tracing needed to follow an
  emergent flow.
- The workflow is a single, fixed, tightly-coupled sequence with one owner —
  a direct call or an explicit orchestrator is simpler than an event web.

## Use-case scenarios

**E-commerce checkout backbone.** Accepting an order emits one
`OrderPlaced` event. Payment capture, inventory reservation, shipping-label
generation, and the notification email each consume it independently and
proceed at their own pace; the order service knows none of them. New
reactions (loyalty points, fraud scoring) are added as subscribers. The
flow is choreographed, so a saga with compensating actions handles the case
where payment succeeds but inventory can't be reserved.

**Bank ledger via event sourcing.** A payments platform records every
balance change as an immutable event in an append-only store, deriving
current balances by replaying them. The full history is the source of truth
— indispensable for audit and dispute resolution — and a
[CQRS](/docs/patterns/storage/cqrs) read model projects those events into
fast balance queries. This is EDA at the event-sourcing end of the
spectrum, where the log *is* the database.

**IoT / telemetry ingestion.** Thousands of devices publish
carried-state-transfer events (a full sensor reading, no callback) to a
Kafka backbone. Independent consumers — real-time alerting,
[stream processing](/docs/patterns/batch-streaming/stream-processing) for
rollups, cold-storage archival — each read the same stream via their own
consumer groups, absorbing bursts without ever back-pressuring the devices.

## Production libraries & getting started

EDA is architectural — it's served by event brokers plus event-modelling
libraries rather than one drop-in package. In practice you pick a broker for
transport, a portable event envelope (CloudEvents), and optionally a
framework that models events and choreography.

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| CloudEvents SDKs | JS/TS, Go, Python, Rust, others | A vendor-neutral event envelope so producers/consumers agree on a portable event schema across brokers | [SDK JS](https://github.com/cloudevents/sdk-javascript) · [SDK Go](https://github.com/cloudevents/sdk-go) · [spec](https://cloudevents.io/) |
| Apache Kafka | Any (JVM/Go/Python/Rust clients) | Log-based, replayable event backbone with consumer groups and partition ordering | [Quickstart](https://kafka.apache.org/quickstart) |
| NATS / JetStream | Any (Go, Rust, JS, Python clients) | Lightweight pub-sub plus a durable, replayable JetStream stream layer | [JetStream docs](https://docs.nats.io/nats-concepts/jetstream) |
| Watermill | Go | Library for building event-driven/CQRS apps over Kafka, NATS, and more with router + middleware | [Getting started](https://watermill.io/docs/getting-started/) |
| AWS EventBridge | Any (via AWS SDKs) | Managed event bus with schema registry, routing rules, and fan-out to targets | [Get started](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-get-started.html) |
| Axon Framework | Java/JVM | Framework modelling events, aggregates, and choreography/sagas for event-sourced systems | [Overview](https://developer.axoniq.io/axon-framework/overview) |

**Example / reference:** [Watermill getting-started](https://watermill.io/docs/getting-started/)

## Related patterns

- [Publish-Subscribe](/docs/patterns/communication/pub-sub) — the messaging
  primitive EDA most commonly runs on; pub-sub is the transport, EDA is the
  architecture built on it.
- [Choreography](/docs/patterns/consistency/choreography) — the
  decentralized coordination style EDA enables, where the workflow emerges
  from services reacting to each other's events.
- [Saga](/docs/patterns/consistency/saga) — sequences a multi-step,
  cross-service workflow (choreographed or orchestrated) with compensating
  undo actions, keeping it consistent under eventual consistency.
- [Event Sourcing](/docs/patterns/storage/event-sourcing) and
  [CQRS](/docs/patterns/storage/cqrs) — the storage-side patterns for the
  event-sourcing end of the spectrum: the event log as source of truth and
  the separate read model derived from it.
- [Idempotency](/docs/patterns/reliability/idempotency) and
  [Dead Letter Queue](/docs/patterns/reliability/dead-letter-queue) — the
  reliability disciplines that make at-least-once event processing safe.

## Further reading

- [Event-driven architecture — Wikipedia](https://en.wikipedia.org/wiki/Event-driven_architecture)
- [What do you mean by "Event-Driven"? — martinfowler.com](https://martinfowler.com/articles/201701-event-driven.html)
- [Event-driven architecture style — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/guide/architecture-styles/event-driven)
- [What is Event-Driven Architecture? — Confluent](https://www.confluent.io/learn/event-driven-architecture/)
