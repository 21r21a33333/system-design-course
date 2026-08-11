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

## Technical architecture & implementation

**Three axes of translation.** The bridge subscribes to messages on
one system, translates each into the form the other expects, and
republishes it — often in both directions, making the bridge
bidirectional. Translation spans three independent axes: the **wire
protocol** (e.g. AMQP versus a proprietary broker API versus Kafka's
protocol), the **envelope and serialization format** (JSON versus a
binary format like Avro or Protobuf, plus header/property mapping), and
the **addressing scheme** (mapping a queue or topic name on one side to
its equivalent on the other). Neither side needs to know the bridge
exists — a producer publishes to its own broker as always, and the
bridge alone is responsible for landing an equivalent message on the
other system. All the system-specific knowledge is concentrated in the
translation step; the pump that reads-translates-writes is generic.

**Delivery semantics: consume, then produce, then acknowledge.** The
bridge's correctness hinges on the order of three operations against
two brokers it cannot transact across atomically. The safe order is:
read the source message (without acking yet), publish to the
destination, and only *after* the destination confirms the publish, ack
the source. This yields **at-least-once** delivery end to end — if the
bridge crashes after publishing but before acking, the source
redelivers and the message is bridged twice. The unsafe inversion
(ack the source before the destination confirms) risks *losing*
messages on a crash. Because at-least-once means duplicates are
inevitable, the destination side (or its consumers) must be
**idempotent**: the bridge stamps each message with a stable
bridge-level ID and tracks recently forwarded IDs so a redelivered
source message isn't published twice — the dedup discipline covered on
the [Idempotency](/docs/patterns/reliability/idempotency) page.

**Ordering across the bridge.** Even when both brokers preserve order
per queue/partition, a naive concurrent bridge can reorder messages by
processing several in parallel. Preserving order requires either
single-threaded forwarding per ordering key, or partition-aligned
workers that keep each key's messages on one thread. This is a real
cost: throughput often trades directly against strict ordering, and
many bridges are deliberately configured to preserve order only within
a partition, not globally.

**Failure handling and replay.** Sitting on the critical path, the
bridge needs the same reliability engineering as the brokers it
connects: **retries with backoff** on transient destination failures
(see [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff)),
a **dead-letter queue** for messages that repeatedly fail to translate
or publish so they don't block the pump
([Dead-Letter Queue](/docs/patterns/reliability/dead-letter-queue)),
and durable tracking of its position so it can **replay** from a known
offset after an outage rather than losing or double-sending an
unbounded backlog. A poison message that can't be translated must be
quarantined, not retried forever.

**Loop prevention in bidirectional bridges.** When the bridge forwards
in both directions, a message bridged A→B must not be picked up on B
and bridged back to A, forever. Bridges break this loop by stamping a
"bridged-by" marker (or origin ID) on forwarded messages and skipping
any message already carrying the bridge's own marker.

**Bridge vs. gateway vs. adapter.** These blur together but differ in
intent. An **adapter** (the object-level pattern) makes one component's
interface look like another's for a *single caller* — it's an
in-process shim, not a running service moving traffic. A **gateway**
(e.g. an [API Gateway](/docs/patterns/api-edge/api-gateway) or an
[Ambassador](/docs/patterns/integration/ambassador)) sits in the
*synchronous request path* and translates or routes calls a client is
actively waiting on. A messaging bridge is distinct from both: it is an
autonomous, *asynchronous* forwarder that moves messages between two
message-oriented middlewares with no caller blocked on the result —
its concerns are delivery guarantees, ordering, and replay over time,
not request-response latency. When the incompatibility is a
*semantic domain-model* mismatch rather than transport/format, that's
the job of an
[Anti-Corruption Layer](/docs/patterns/integration/anti-corruption-layer),
which a bridge may host but is not itself.

## Code example

The snippet below shows the shape of a minimal bridge: read from one
system's native format, translate, and write to the other's.

```rust
use std::collections::HashSet;

struct SystemAMessage {
    id: String, // stable source-side id used for bridge-level dedup
    topic: String,
    body: Vec<u8>,
}

struct SystemBMessage {
    routing_key: String,
    payload: String,
}

trait SystemAQueue {
    fn poll(&self) -> Option<SystemAMessage>;
    fn ack(&self, id: &str); // remove from source only after dest confirms
}

trait SystemBQueue {
    // Returns Ok on confirmed publish, Err on a transient failure to retry.
    fn publish(&self, message: SystemBMessage) -> Result<(), ()>;
}

// Maps System A's topic naming and binary body into System B's
// routing-key and string-payload conventions. All format-specific
// knowledge lives here; the pump below is protocol-agnostic.
fn translate(msg: &SystemAMessage) -> SystemBMessage {
    SystemBMessage {
        routing_key: format!("bridged.{}", msg.topic),
        payload: String::from_utf8_lossy(&msg.body).to_string(),
    }
}

// Order matters: publish to the destination and only ack the source
// AFTER the publish is confirmed (at-least-once). Dedup on the stable id
// makes the inevitable redeliveries idempotent so nothing is bridged twice.
fn run_bridge(source: &dyn SystemAQueue, dest: &dyn SystemBQueue, seen: &mut HashSet<String>) {
    while let Some(msg) = source.poll() {
        if seen.contains(&msg.id) {
            source.ack(&msg.id); // already forwarded — drop the duplicate
            continue;
        }
        match dest.publish(translate(&msg)) {
            Ok(()) => {
                seen.insert(msg.id.clone());
                source.ack(&msg.id); // safe to remove from source now
            }
            // Leave it un-acked so the source redelivers it and we retry.
            Err(()) => break,
        }
    }
}
```

`translate` holds all the format-specific knowledge; `run_bridge` is
protocol-agnostic and would look the same for any two systems — only
`translate` and the two trait implementations change. The publish →
confirm → ack ordering is what makes the bridge at-least-once, and the
`seen` set is what makes the resulting duplicates harmless.

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

## Use-case scenarios

**Phased cloud migration.** A team is moving off an on-premises
RabbitMQ broker onto a managed cloud service like Azure Service Bus,
but hundreds of producers and consumers can't cut over in one weekend.
A bidirectional bridge forwards messages between the two during the
transition, so a producer still on RabbitMQ reaches a consumer already
migrated to Service Bus and vice versa. Each side moves on its own
schedule, and the bridge is deliberately retired once the last endpoint
has moved — treating it as temporary scaffolding, not permanent
infrastructure.

**Post-merger broker integration.** Two companies merge, each
standardized on a different messaging stack — say one on Kafka, the
other on IBM MQ. Rewriting either estate is off the table on the
integration timeline, so a bridge translates the specific event types
that must flow across the org boundary (orders, customer updates),
mapping topics to queues and re-serializing payloads. Only the shared
subset is bridged; each side keeps its internal messaging private.

**Cross-boundary event feed with loop prevention.** An IoT platform
runs a broker at the edge and a broker in the cloud, and events must
flow both ways — device telemetry up, control commands down. A
bidirectional bridge stamps each forwarded message with an origin
marker so a telemetry event bridged edge→cloud is never re-bridged
back down, and consumers on both sides are idempotent to absorb the
duplicates that at-least-once forwarding inevitably produces.

## Production libraries & getting started

A messaging bridge is served by integration systems, not a single library:
you configure a connector/route that consumes from one broker and produces
to another, handling translation, retries, and offsets. These are the
production tools people reach for rather than writing the pump by hand.

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| Kafka Connect + MirrorMaker 2 | JVM (config-driven) | Connector framework plus MM2 for broker-to-broker replication/bridging with offset tracking | [Connect](https://kafka.apache.org/documentation/#connect) · [MirrorMaker 2](https://kafka.apache.org/documentation/#georeplication) |
| Apache Camel | Java/JVM | Integration framework with 300+ components to route and translate between messaging systems | [Getting started](https://camel.apache.org/getting-started.html) |
| Benthos / Redpanda Connect | Go (config-driven) | Declarative stream processor for wiring inputs to outputs across brokers with transforms | [Benthos](https://www.benthos.dev/docs/about) · [Redpanda Connect](https://docs.redpanda.com/redpanda-connect/about/) |
| Debezium | JVM (Kafka Connect) | CDC connectors that bridge database change streams onto a message bus | [Tutorial](https://debezium.io/documentation/reference/stable/tutorial.html) |
| NATS | Any (Go, Rust, JS, Python clients) | Bridging/gateways to connect NATS clusters and adjacent systems | [Docs](https://docs.nats.io/) |

**Example / reference:** [Kafka MirrorMaker 2 (broker-to-broker bridging)](https://kafka.apache.org/documentation/#georeplication)

## Related patterns

- [Distributed Message Queue](/docs/patterns/building-blocks/distributed-message-queue) —
  the kind of system a messaging bridge connects on each side; the
  bridge translates between two different queue technologies rather
  than being one itself.
- [Idempotency](/docs/patterns/reliability/idempotency) — what makes
  the duplicates an at-least-once bridge inevitably produces harmless
  on the destination side.
- [Dead-Letter Queue](/docs/patterns/reliability/dead-letter-queue) —
  where a message the bridge can't translate or deliver is routed so it
  doesn't block the forwarding pump.
- [Anti-Corruption Layer](/docs/patterns/integration/anti-corruption-layer) —
  handles a *semantic* model mismatch between two systems, a deeper
  translation than the transport/format bridging a messaging bridge does.
- [Ambassador](/docs/patterns/integration/ambassador) — a
  *synchronous*, per-client sidecar proxy, contrasting with the bridge's
  autonomous asynchronous forwarding between brokers.

## Further reading

- [Messaging Bridge pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/messaging-bridge)
- [Enterprise Integration Patterns: Messaging Bridge](https://www.enterpriseintegrationpatterns.com/patterns/messaging/MessagingBridge.html)
- [Apache Kafka MirrorMaker 2 (broker-to-broker bridging)](https://kafka.apache.org/documentation/#georeplication)
- [Enterprise messaging — Wikipedia](https://en.wikipedia.org/wiki/Enterprise_messaging_system)
