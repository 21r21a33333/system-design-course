---
title: "Publish-Subscribe"
sidebar_position: 1
supplementary: true
---

Publish-Subscribe (pub-sub) decouples senders (publishers) from receivers
(subscribers) through an intermediary — a message broker or topic — so
publishers never know who, or how many, consumers exist.

## Problem it solves

In a direct request-response or point-to-point queue setup, adding a new
consumer of an event means changing the producer's code to notify it. As
a system grows, this couples services that should be independent: the
order-service shouldn't need to know that both the email-service and the
analytics-service care about "order placed" events.

## How it works

Publishers write messages to a named topic. The broker maintains zero or
more subscriptions on that topic; each subscriber receives its own copy
of every message published after it subscribed. Publishers and
subscribers never call each other directly — both only talk to the
broker. Most brokers support either fan-out (every subscriber gets every
message) or filtered delivery (subscribers register interest in a subset
via a filter/pattern).

## When to use it

- Multiple independent consumers need to react to the same event, and the
  set of consumers changes over time.
- Producers and consumers should be deployable independently, without
  coordinated releases.
- You want to add a new consumer without touching the producer at all.

## When not to use it

- The producer needs a response back from the consumer (pub-sub is
  fire-and-forget by design — use request-response instead).
- Strict ordering across all consumers matters and the broker doesn't
  guarantee it (many pub-sub systems only guarantee order per-partition,
  not globally).
- A single, tightly-coupled consumer is the only one that will ever exist
  — a direct call or a simple queue is simpler and has fewer moving parts.

## Real-world example

Google Cloud Pub/Sub and AWS SNS are managed pub-sub services widely used
to fan out a single event (e.g. a file upload) to multiple independent
downstream processors (thumbnailing, virus scanning, indexing) without
those processors knowing about each other.

## Related patterns

- [Event-Driven Architecture](/docs/patterns/communication/event-driven-architecture) — pub-sub is the most common transport for it.
- [Dead Letter Queue](/docs/patterns/reliability/dead-letter-queue) — where undeliverable pub-sub messages typically end up.
- [Asynchronism](/docs/concepts/asynchronism) — the primer's broader treatment of message/task queues.

## Further reading

- [Publish-subscribe pattern — Wikipedia](https://en.wikipedia.org/wiki/Publish%E2%80%93subscribe_pattern)
- [Google Cloud Pub/Sub overview](https://cloud.google.com/pubsub/docs/overview)
