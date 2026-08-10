---
title: "Event-Driven Architecture"
sidebar_position: 2
supplementary: true
---

Event-driven architecture (EDA) is a style where services react to
events representing a state change — "order placed," "payment
captured" — rather than being invoked directly by a caller that expects
an immediate response.

## Problem it solves

In a purely synchronous, direct-call architecture, every service that
needs to know about a state change has to be called explicitly by the
service that caused it. That producer ends up hard-coded with knowledge
of every downstream consumer, and a slow or failing consumer can block
or fail the whole call chain. EDA breaks that: the producer emits a fact
about something that happened and moves on, regardless of how many
services care or how long they take to process it.

## How it works

An event producer emits a small, immutable record of something that
already happened (not a command to do something) onto an event bus —
typically a pub-sub topic or log-based broker. Event consumers subscribe
independently and process the event at their own pace. Two coordination
styles emerge on top of this:

- **Choreography** — each service reacts to events and emits its own
  events in turn, with no central controller. Simple to add services to,
  but the overall workflow is implicit and harder to trace as a whole.
- **Orchestration** — a central coordinator (see
  [Saga](/docs/patterns/consistency/saga)) explicitly calls or listens for
  each step and decides what happens next. Easier to reason about and
  debug, at the cost of a component that knows about the whole flow.

Because consumers process events asynchronously and independently, the
system as a whole is only eventually consistent — a consumer might read
stale state for a short window after an event fires, until it catches up.

## When to use it

- Multiple services need to react to the same fact, and that set of
  services changes over time.
- Workflows naturally decompose into independent steps that don't need
  to complete synchronously with the triggering action.
- The system needs to absorb bursts of activity without back-pressuring
  the producer — consumers can lag and catch up later.

## When not to use it

- The caller needs a synchronous, authoritative answer before proceeding
  (e.g. "was this payment approved?") — request-response is a better fit.
- The team can't yet operate the extra infrastructure (broker, dead
  letter handling, monitoring for consumer lag) that EDA requires.
- Strong, immediate consistency across services is a hard requirement —
  eventual consistency is a fundamental property of this style, not a
  tunable knob.

## Real-world example

E-commerce checkout pipelines commonly emit an "OrderPlaced" event once
an order is accepted, which independent downstream services — payment
capture, inventory reservation, shipping label generation, notification
email — each consume and act on without the order service knowing any of
them exist.

## Related patterns

- [Publish-Subscribe](/docs/patterns/communication/pub-sub) — the most common transport mechanism for delivering events.
- [Saga](/docs/patterns/consistency/saga) — orchestrates a sequence of events/compensations to keep a multi-step workflow consistent.

## Further reading

- [Event-driven architecture — Wikipedia](https://en.wikipedia.org/wiki/Event-driven_architecture)
- [What do you mean by "Event-Driven"? — martinfowler.com](https://martinfowler.com/articles/201701-event-driven.html)
