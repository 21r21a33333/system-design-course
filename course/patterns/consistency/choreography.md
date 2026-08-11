---
title: "Choreography"
sidebar_position: 5
supplementary: true
---

Choreography is a coordination style in which each service reacts to
events published by other services and decides for itself what to do
next, with no central component directing the overall workflow.

![Choreography diagram](/img/patterns/choreography.svg)

## Problem it solves

Any workflow that spans more than one service — provisioning a new
account, running a multi-stage data pipeline, fulfilling an order —
needs *something* to decide which step runs next after each step
finishes. The straightforward answer is a central coordinator that
calls each service in turn and tracks progress. But that coordinator
then has to know about every participant and every step in the
workflow, becomes a dependency every one of those services now shares,
and is a single place where a bug or an outage can stall the entire
process. Choreography solves the same "what happens next" problem
without introducing that central component at all: each service is
told, once, which events it should react to, and after that the
workflow's progress emerges from services independently responding to
each other, with no single node holding — or needing to hold — the
full picture.

## Technical architecture & implementation

**Publish, react, emit.** Each service that participates in the
workflow publishes an event describing what it just did ("account
created," "inventory reserved," "file uploaded") onto a shared event
bus, typically a message broker or log. Every other service that needs
to react to that fact subscribes to the relevant event type and, on
receiving it, performs its own local work and — if there's a next step —
publishes its own event in turn. Chaining these publish-and-react steps
together is what carries a workflow to completion: service A's event
triggers service B, whose own event triggers service C, and so on,
without any of A, B, or C having been told about the others directly. No
participant needs to know the full sequence of steps, only which events
it cares about and which event(s) it should emit after handling one —
the end-to-end workflow is not represented anywhere as a single
artifact, it's the emergent result of independently defined event
reactions. Adding a new step generally means adding a new subscriber to
an existing event, with no change to the services already in the chain.

**The event bus is the coupling boundary.** Because no service holds a
reference to any other, the only shared contract is the event *type* and
its payload schema. That contract is what lets teams deploy and evolve
their services on independent release cycles — the property choreography
is chosen for. The bus itself is almost always a
[pub-sub](/docs/patterns/communication/pub-sub) topic or a log-based
[distributed message queue](/docs/patterns/building-blocks/distributed-message-queue),
and choreography inherits that substrate's delivery semantics wholesale.
Choreography is best understood as a *coordination style layered on*
[Event-Driven Architecture](/docs/patterns/communication/event-driven-architecture) —
that page covers the broker, event richness, and eventual-consistency
mechanics in depth; this page is specifically about using events to
*sequence a workflow* with no coordinator.

**Idempotency and ordering are not optional.** Real brokers deliver
*at-least-once*: after a crash or a lost acknowledgement, the same event
can arrive twice. Every handler must therefore be **idempotent** —
reacting to the same "inventory.reserved" event a second time must not
reserve twice — usually by deduplicating on an event id or making the
effect naturally repeatable (see
[Idempotency](/docs/patterns/reliability/idempotency)). Ordering is
typically guaranteed only *per partition/key*, so causally related events
for one workflow instance must share a partition key, or handlers must
tolerate seeing them out of order. Events that repeatedly fail handling
are routed to a
[dead-letter queue](/docs/patterns/reliability/dead-letter-queue) rather
than blocking the topic — the poison-message discipline that keeps one
bad event from stalling every workflow behind it.

**Failure modes.** The trade choreography makes shows up under failure.
Because the flow lives in no single artifact, **cyclic dependencies**
are easy to create by accident — service A reacts to B's event and B
reacts to A's, and an unlucky payload can bounce forever; catching this
requires actually tracing the subscription graph, since nothing declares
it. **End-to-end visibility** is the headline cost: answering "what
state is workflow instance X in?" or "why did this order stall?" means
reconstructing the sequence from
[distributed tracing](/docs/patterns/observability/distributed-tracing)
spans and logs after the fact, because no component holds the whole
picture. And a **missing subscriber** is a silent bug — if no service
happens to react to an emitted event, the workflow simply stops with no
error anywhere, which is why unroutable events should be dead-lettered
rather than dropped.

**Choreography vs. orchestration.** These are the two ways to sequence
a multi-step distributed workflow, and the choice is really about where
the "what happens next" logic lives. Choreography spreads that logic
across every participant's event handlers: there's no single point of
failure and no shared coordinator every service has to depend on, but
because the workflow logic isn't written down anywhere as a whole, it's
genuinely hard to answer "what is the current state of workflow X?" or
"what's the full sequence of steps this process goes through?" without
tracing event subscriptions across every service involved — debugging a
stuck or misbehaving workflow means reconstructing that sequence after
the fact, often from logs or distributed traces. Orchestration takes
the opposite trade: a central orchestrator component explicitly calls
each service and tracks the workflow's state, so the whole sequence is
visible in one place and easy to step through, at the cost of that
orchestrator being a new component every participating service now
depends on, and a potential bottleneck or single point of failure of
its own. The table below summarizes the two.

| | Choreography | Orchestration |
| --- | --- | --- |
| "What next" logic | Spread across each service's handlers | Centralized in one coordinator |
| Coupling | Loose — only the event type is shared | Every step depends on the orchestrator |
| End-to-end visibility | Emergent; reconstructed from traces | Explicit; the coordinator holds state |
| Single point of failure | None | The orchestrator |
| Adding a step | Subscribe a new service to an event | Edit the coordinator's flow |
| Debugging a stuck instance | Hard — trace subscriptions across services | Easier — inspect coordinator state |

> **Relationship to `saga.md`.** [Saga](/docs/patterns/consistency/saga)
> covers choreography specifically as one of two ways to implement a
> saga — a workflow of local transactions with compensating undo
> actions. This page covers the general choreography-vs-orchestration
> coordination-style choice on its own terms: it applies to any
> multi-step distributed workflow, not only ones that need
> transactional undo semantics. A choreographed data pipeline or a
> choreographed multi-stage approval process is choreography with no
> saga or compensation involved at all.

## Code example

The snippet below models the essence of choreography: services subscribe
only to the topics they care about, do their local step, and emit the
next event, with nothing tracking the overall sequence centrally. It
carries the flow all the way through — including the failure branch,
where a `payment.declined` fact triggers the inventory service to
compensate its own earlier step with no coordinator ordering it to. The
`log` exists only so the emergent sequence can be observed after the
fact, which is exactly how a real choreography is debugged.

```rust
use std::collections::HashMap;

// An event is an immutable fact: something a service just did. Its `topic`
// is the only thing other services key off — no service names a recipient,
// it just announces what happened and moves on.
#[derive(Clone, Debug)]
pub struct Event {
    pub topic: String,
    pub order_id: u64,
}

// A handler reacts to one topic, does its local work, and may emit the next
// event(s). It has no knowledge of who published the event it reacts to, or
// who (if anyone) reacts to what it emits — that wiring lives only in the bus.
type Handler = fn(&Event) -> Vec<Event>;

pub struct EventBus {
    // topic -> subscribers. Producers and consumers are decoupled: neither
    // holds a reference to the other, only the shared topic string.
    subscribers: HashMap<String, Vec<Handler>>,
    // An append-only trace of every topic delivered, in order. Nothing in a
    // choreography holds the end-to-end flow; this log is how an operator
    // reconstructs it after the fact.
    pub log: Vec<String>,
}

impl EventBus {
    pub fn new() -> Self {
        EventBus { subscribers: HashMap::new(), log: Vec::new() }
    }

    pub fn subscribe(&mut self, topic: &str, handler: Handler) {
        self.subscribers.entry(topic.to_string()).or_default().push(handler);
    }

    // Publishing runs every subscriber to the topic; each event a handler
    // returns is fed back through the bus, so the workflow advances with no
    // central driver. A breadth-first queue keeps ordering deterministic
    // and avoids unbounded recursion on long chains.
    pub fn publish(&mut self, event: Event) {
        let mut queue = vec![event];
        while !queue.is_empty() {
            let ev = queue.remove(0);
            self.log.push(ev.topic.clone());
            if let Some(handlers) = self.subscribers.get(&ev.topic).cloned() {
                for handler in handlers {
                    for next in handler(&ev) {
                        queue.push(next);
                    }
                }
            }
        }
    }
}

// Order service reacts to a placed order and asks inventory to reserve.
fn on_order_placed(e: &Event) -> Vec<Event> {
    vec![Event { topic: "inventory.reserved".into(), order_id: e.order_id }]
}

// Inventory reserved -> ask payment to charge.
fn on_inventory_reserved(e: &Event) -> Vec<Event> {
    vec![Event { topic: "payment.requested".into(), order_id: e.order_id }]
}

// Payment service: even order ids succeed, odd order ids are declined. A
// decline emits a failure event instead of the success event — the failure
// is just another fact on the bus, and upstream services subscribe to it.
fn on_payment_requested(e: &Event) -> Vec<Event> {
    match e.order_id % 2 {
        0 => vec![Event { topic: "payment.charged".into(), order_id: e.order_id }],
        _ => vec![Event { topic: "payment.declined".into(), order_id: e.order_id }],
    }
}

// Inventory also subscribes to the payment-declined event and reacts by
// compensating its own earlier step — releasing what it reserved. No
// coordinator told it to; it reacts to the failure fact like any other.
fn on_payment_declined(e: &Event) -> Vec<Event> {
    vec![Event { topic: "inventory.released".into(), order_id: e.order_id }]
}

pub fn wire(bus: &mut EventBus) {
    bus.subscribe("order.placed", on_order_placed);
    bus.subscribe("inventory.reserved", on_inventory_reserved);
    bus.subscribe("payment.requested", on_payment_requested);
    bus.subscribe("payment.declined", on_payment_declined);
}
```

Publishing `order.placed` with an even `order_id` produces the log
`order.placed → inventory.reserved → payment.requested →
payment.charged`: each service reacted to one event and emitted the next,
and the happy path completed with no coordinator. Publishing with an odd
`order_id` instead produces `… → payment.declined → inventory.released` —
the payment service's failure *fact* is what triggers the inventory
service to run its own compensation, which is choreographed saga recovery
in miniature. Neither service was ever told the other exists; the whole
flow, success and failure alike, is emergent from the wiring in `wire`.

## When to use it

- The set of services participating in a workflow changes over time,
  and new steps should be addable without modifying existing services.
- No single team or component naturally owns the whole workflow, and
  introducing a shared orchestrator would create an unwanted central
  dependency across team boundaries.
- The steps are naturally reactive — each one only needs to know "when
  X happens, do Y" — rather than needing a global view of progress to
  decide what to do.

## When not to use it

- The workflow has many steps with branching or conditional logic, and
  understanding or debugging the end-to-end flow at a glance matters —
  that logic is scattered across every service's handlers in
  choreography and is much easier to follow when it lives in one
  orchestrator.
- Operators need a reliable, centralized way to answer "how far along
  is this specific workflow instance?" — choreography has no built-in
  place to track that; it must be reconstructed from distributed events
  and logs after the fact.
- The steps have real ordering or exclusivity requirements that are
  much simpler to enforce by direct control than by relying on every
  participant to correctly react to the right events in the right way.

## Use-case scenarios

**CI/CD pipeline across independent tools.** A "CodePushed" event
triggers an independent build service to compile and publish
"BuildSucceeded," which triggers a test service to run the suite and
publish "TestsPassed," which triggers a deployment service — with no
service in the chain aware that any of the others exist, only that it
should react to one event and emit another. Adding a new stage (a
security scan, say) means subscribing it to an existing event; nothing
already in the chain has to change. The workflow's decentralization
matches an organization where each stage is owned by a different team.

**Choreographed order fulfillment across bounded contexts.** An order
service emits `OrderPlaced` and forgets about it. Inventory reacts by
reserving stock and emits `InventoryReserved`; payment reacts to *that*
and emits `PaymentCharged` or `PaymentDeclined`; shipping reacts to the
charge. On a decline, inventory reacts to the failure event by releasing
its hold — a choreographed saga where the compensation is itself just
another event reaction, exactly as in the code above. No team owns the
end-to-end flow, and each context deploys on its own cadence; the cost
is that "where is order 4711 stuck?" has to be answered from traces.

**Multi-stage media-processing pipeline.** An "UploadCompleted" event
kicks off a chain of independent workers: transcode to several bitrates,
extract a thumbnail, run content moderation, then publish. Each worker
subscribes to the previous stage's completion event and emits its own,
so the pipeline scales each stage independently and absorbs bursts
through the broker. A new stage — say, subtitle generation — is added by
subscribing a new worker to an existing event, with no change to the
workers already in the chain.

## Related patterns

- [Saga](/docs/patterns/consistency/saga) — uses choreography (alongside
  orchestration) as one of two ways to sequence a saga's steps
  specifically; this page's choreography-vs-orchestration trade-off is
  the more general version of that same choice.
- [Event-Driven Architecture](/docs/patterns/communication/event-driven-architecture) —
  the broader architectural style choreography is built on top of:
  services reacting to events rather than being called directly.
- [Publish-Subscribe](/docs/patterns/communication/pub-sub) — the
  messaging primitive the event bus is usually built on, delivering each
  event to every subscribed service.
- [Compensating Transaction](/docs/patterns/consistency/compensating-transaction) —
  the undo mechanism a choreographed saga triggers by publishing a
  failure event that upstream services react to, as in the code above.
- [Idempotency](/docs/patterns/reliability/idempotency) and
  [Dead Letter Queue](/docs/patterns/reliability/dead-letter-queue) — the
  reliability disciplines that make at-least-once, unroutable, and
  poison events safe in a choreographed flow.

## Further reading

- [Event-driven architecture — Wikipedia](https://en.wikipedia.org/wiki/Event-driven_architecture)
- [Choreography pattern — AWS Prescriptive Guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/saga-choreography.html)
- [Orchestration pattern — AWS Prescriptive Guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/saga-orchestration.html)
- [Saga design pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/saga)
