---
title: "Messaging Bridge"
sidebar_position: 7
supplementary: true
---

A messaging bridge is an intermediary that connects two otherwise-
incompatible messaging systems — different protocols, message formats,
or brokers entirely — translating messages between them so services on
each side can communicate without either one adopting the other's
technology.

![Messaging Bridge diagram](/img/patterns/messaging-bridge.svg)

## Problem it solves

Organizations rarely run on a single messaging system for long.
Mergers bring together two companies that each standardized on a
different broker; a years-long migration means old and new systems
have to coexist and interoperate for a transition period; different
teams adopt different technologies for legitimate reasons of their
own. In every one of these cases, services on one side need to react
to events produced on the other side, but rewriting every producer and
consumer to speak a single, shared messaging technology is expensive,
slow, and often impossible if one side is a third party or a system no
longer being actively developed. Without something in between, the two
sides simply can't talk to each other at all.

## How it works

The bridge subscribes to messages on one messaging system, translates
each one into the format and protocol the other system expects, and
republishes it there — and often does the same in the opposite
direction, making the bridge bidirectional. Translation covers three
things: the wire protocol (e.g. AMQP versus a proprietary broker API),
the message envelope and serialization format (e.g. JSON versus a
binary format), and the addressing scheme (mapping a queue or topic
name on one side to its equivalent on the other). Neither side needs
to know the bridge exists — a producer just publishes to its own
broker as it always has, and the bridge is solely responsible for
getting an equivalent message to the other system. Because it sits on
the critical path for every bridged message, the bridge itself becomes
a component that needs the same reliability engineering (retries,
dead-lettering, monitoring) as the brokers on either side of it.

## Code example

The snippet below shows the shape of a minimal bridge: read from one
system's native format, translate, and write to the other's.

```rust
struct SystemAMessage {
    topic: String,
    body: Vec<u8>,
}

struct SystemBMessage {
    routing_key: String,
    payload: String,
}

trait SystemAQueue {
    fn poll(&self) -> Option<SystemAMessage>;
}

trait SystemBQueue {
    fn publish(&self, message: SystemBMessage);
}

// Maps System A's topic naming and binary body into System B's
// routing-key and string-payload conventions.
fn translate(msg: SystemAMessage) -> SystemBMessage {
    let routing_key = format!("bridged.{}", msg.topic);
    let payload = String::from_utf8_lossy(&msg.body).to_string();
    SystemBMessage { routing_key, payload }
}

fn run_bridge(source: &dyn SystemAQueue, dest: &dyn SystemBQueue) {
    while let Some(msg) = source.poll() {
        let translated = translate(msg);
        dest.publish(translated); // System B never sees System A's format
    }
}
```

`translate` is where all the format-specific knowledge lives; `run_bridge`
itself is protocol-agnostic and would look the same regardless of which
two systems were being connected — only `translate` and the two trait
implementations change.

## When to use it

- Two organizations with different messaging infrastructure need to
  integrate, such as after a merger or acquisition, and rewriting
  either side isn't realistic on the required timeline.
- A gradual migration from one broker to another is underway, and
  producers and consumers are being moved incrementally rather than in
  one cutover — the bridge lets both old and new systems keep working
  during the transition.
- A third-party or legacy system only speaks a protocol the rest of
  the organization has moved away from, and it can't be modified.

## When not to use it

- Both sides can standardize on one messaging technology without
  significant cost — a bridge is a permanent-feeling piece of
  infrastructure that's easy to accumulate and hard to retire; avoid
  introducing one if the underlying incompatibility can just be
  removed.
- The two systems' delivery guarantees are fundamentally mismatched
  (e.g. one is at-most-once, the other requires exactly-once) in a way
  the bridge can't reconcile — translating the message format doesn't
  automatically translate the delivery semantics, and that mismatch
  needs to be resolved explicitly, not silently bridged over.
- Message volume or latency requirements are high enough that the
  bridge itself would become a bottleneck or single point of failure
  between the two systems.

## Real-world example

Enterprise Service Bus (ESB) products historically included messaging
bridge components to connect IBM MQ, Microsoft Message Queuing, and
JMS-based brokers within the same organization; more recently, cloud
migrations commonly bridge an on-premises broker like RabbitMQ to a
managed cloud service like Azure Service Bus during a phased cutover,
retiring the bridge once every producer and consumer has moved.

## Related patterns

- [Distributed Message Queue](/docs/patterns/building-blocks/distributed-message-queue) —
  the kind of system a messaging bridge connects on each side; the
  bridge translates between two different queue technologies rather
  than being one itself.

## Further reading

- [Messaging Bridge pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/messaging-bridge)
- [Enterprise messaging — Wikipedia](https://en.wikipedia.org/wiki/Enterprise_messaging_system)
