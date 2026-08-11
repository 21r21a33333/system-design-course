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

## How it works

Each service that participates in the workflow publishes an event
describing what it just did ("account created," "inventory reserved,"
"file uploaded") onto a shared event bus, typically a message broker or
log. Every other service that needs to react to that fact subscribes to
the relevant event type and, on receiving it, performs its own local
work and — if there's a next step — publishes its own event in turn.
Chaining these publish-and-react steps together is what carries a
workflow to completion: service A's event triggers service B, whose
own event triggers service C, and so on, without any of A, B, or C
having been told about the others directly. No participant needs to
know the full sequence of steps, only which events it cares about and
which event(s) it should emit after handling one — the end-to-end
workflow is not represented anywhere as a single artifact, it's the
emergent result of independently defined event reactions. Adding a new
step to the workflow generally means adding a new subscriber to an
existing event, with no change required to the services already in the
chain.

**Choreography vs. Orchestration.** These are the two ways to sequence
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
its own.

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

The snippet below models the essence of choreography: services
subscribe only to the events they care about, and a workflow's
progress emerges from independent handlers, with nothing tracking the
overall sequence centrally.

```rust
use std::collections::HashMap;

#[derive(Clone, Debug)]
struct Event {
    topic: String,
    payload: String,
}

// Each handler reacts to one topic and may publish a follow-up event.
// It has no knowledge of who published the event it's reacting to,
// or who (if anyone) will react to what it publishes next.
type Handler = fn(&Event) -> Option<Event>;

struct EventBus {
    subscribers: HashMap<String, Vec<Handler>>,
}

impl EventBus {
    fn subscribe(&mut self, topic: &str, handler: Handler) {
        self.subscribers.entry(topic.to_string()).or_default().push(handler);
    }

    // Publishing triggers every subscriber to that topic in turn; any
    // event a handler returns is published back onto the bus, letting
    // the chain continue without a central driver.
    fn publish(&mut self, event: Event) {
        println!("event: {} -> {}", event.topic, event.payload);
        if let Some(handlers) = self.subscribers.get(&event.topic).cloned() {
            for handler in handlers {
                if let Some(next) = handler(&event) {
                    self.publish(next);
                }
            }
        }
    }
}

fn on_order_placed(e: &Event) -> Option<Event> {
    Some(Event { topic: "inventory.reserved".into(), payload: e.payload.clone() })
}

fn on_inventory_reserved(e: &Event) -> Option<Event> {
    Some(Event { topic: "payment.charged".into(), payload: e.payload.clone() })
}
```

Wiring `on_order_placed` to `"order.placed"` and `on_inventory_reserved`
to `"inventory.reserved"` is all either service needs to know — neither
one is aware the other exists, or that a payment step comes after.

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

## Real-world example

Event-driven order fulfillment pipelines commonly use choreography:
an "OrderPlaced" event triggers an independent inventory service to
reserve stock and publish "InventoryReserved," which triggers an
independent payment service to charge the customer and publish
"PaymentCharged," which triggers a shipping service — with no service
in the chain aware that any of the others exist, only that it should
react to one event and emit another.

## Related patterns

- [Saga](/docs/patterns/consistency/saga) — uses choreography (alongside
  orchestration) as one of two ways to sequence a saga's steps
  specifically; this page's choreography-vs-orchestration trade-off is
  the more general version of that same choice.
- [Event-Driven Architecture](/docs/patterns/communication/event-driven-architecture) —
  the broader architectural style choreography is built on top of:
  services reacting to events rather than being called directly.

## Further reading

- [Event-driven architecture — Wikipedia](https://en.wikipedia.org/wiki/Event-driven_architecture)
- [Orchestration and choreography patterns — AWS Prescriptive Guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/orchestration-choreography.html)
