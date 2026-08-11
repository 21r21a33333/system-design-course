---
title: "Publish-Subscribe"
sidebar_position: 1
supplementary: true
---

Publish-Subscribe (pub-sub) is a messaging pattern in which senders
(publishers) write messages to a named topic rather than to a specific
recipient, and the broker delivers an independent copy of each message to
every subscriber currently interested in that topic — so publishers never
know who, or how many, consumers exist.

![Publish-Subscribe diagram](/img/patterns/pub-sub.svg)

## Problem it solves

In a direct request-response or point-to-point queue setup, adding a new
consumer of an event means changing the producer to notify it. As a
system grows, this couples services that should be independent: the
order-service ends up holding a list of everyone who cares about "order
placed" — the email-service, the analytics-service, the fraud-service —
and every new interested party is a code change and a redeploy of the
producer. Worse, the producer's latency and failure surface now depend on
each of those callbacks. Pub-sub removes the producer from that equation
entirely. The publisher emits one message to a topic and moves on; the
broker is responsible for fanning it out to whoever is listening. New
consumers subscribe to the topic without the publisher ever being aware
they joined, and a slow or dead consumer affects only its own delivery,
not the publish path.

## Technical architecture & implementation

**Topic-based fan-out.** The topic (also called a channel or, in
RabbitMQ, an exchange) is the rendezvous point. A publisher addresses a
topic, never a subscriber; a subscriber registers against a topic, never
a publisher. The broker holds the set of current subscriptions and, on
each publish, delivers a copy to every matching one. This total decoupling
in space (neither side holds a reference to the other), time (a subscriber
processes at its own pace), and synchronization (publish returns without
waiting for consumers) is the defining property of the pattern.

**Filtering — topic vs. content/attribute.** The coarsest routing is by
topic name alone: subscribe to `order.placed`, get every message on it. Finer
routing filters *within* a topic — RabbitMQ topic exchanges match routing
keys like `order.*.eu`, while Google Cloud Pub/Sub and AWS SNS support
attribute/content filters so a subscriber receives only messages whose
metadata matches a predicate (e.g. only `high-value` orders). Filtering at
the broker saves consumers from receiving and discarding traffic they
don't want.

**Push vs. pull delivery.** In *push*, the broker actively delivers to a
subscriber endpoint (a webhook, a callback) as messages arrive. In *pull*,
the subscriber asks the broker for the next batch on its own schedule,
which gives the consumer natural flow control — it never receives faster
than it can handle. Google Pub/Sub offers both; Kafka is fundamentally
pull. The code example below models pull delivery via a per-subscriber
mailbox.

**Durable vs. ephemeral subscriptions.** An *ephemeral* subscription only
receives messages published while it is connected; disconnect and you miss
what happened in the gap. A *durable* subscription retains messages for a
subscriber that is offline, so it catches up on reconnect. Log-based
brokers like Kafka take this further with *retained/replayable* topics: the
messages are kept for a retention window and a new or recovering
subscriber can rewind to any offset and replay history.

**Fan-out vs. consumer groups — a critical distinction.** Pub-sub's default
is that *each subscriber gets its own copy*. But subscribers are often
scaled out into a **consumer group** where the group collectively gets one
copy — the messages are load-balanced across the group's members so each
message is processed once by the group, not once per member. This is the
[competing consumers](/docs/patterns/batch-streaming/competing-consumers)
pattern layered inside a subscription. Kafka expresses both at once: every
consumer *group* is an independent subscriber (each group sees every
message), while members *within* a group share the partitions. Getting this
wrong — expecting fan-out but configuring a shared group, or vice versa —
is a classic source of "some events silently went missing" bugs.

**Delivery guarantees, ordering, idempotency.** Most brokers deliver
*at-least-once*: a message can be redelivered after a consumer crash or a
lost acknowledgement, so consumers must be **idempotent** — see
[Idempotency](/docs/patterns/reliability/idempotency) — to tolerate
duplicates. Ordering is typically guaranteed only *per partition/key*, not
globally across a topic, so designs that need order must route related
messages to the same key. Messages that repeatedly fail delivery are
routed to a [dead-letter queue](/docs/patterns/reliability/dead-letter-queue)
rather than blocking the stream or being dropped silently.

**Where the broker lives.** The transport underneath is usually a
[distributed message queue](/docs/patterns/building-blocks/distributed-message-queue):
Kafka topics, Google Cloud Pub/Sub, AWS SNS/SQS, NATS, and RabbitMQ
exchanges all provide the fan-out and durability described here, differing
mainly in retention model (retain-and-replay vs. delete-on-ack) and
delivery semantics.

## Pub-sub vs. point-to-point

The sibling messaging model is the point-to-point queue, and the
difference is who consumes a given message.

| Aspect | Pub-sub (topic) | Point-to-point (queue) |
| --- | --- | --- |
| Recipients of one message | Every subscriber gets a copy | Exactly one consumer takes it |
| Coupling | Publisher unaware of subscribers | Sender targets a specific queue |
| Adding a consumer | Subscribe; producer unchanged | Competes for the same messages |
| Typical use | Fan-out an event to many reactors | Distribute work across a pool |
| Scaling a consumer | Consumer group *within* a subscription | Add workers (competing consumers) |

The two compose: a pub-sub topic can fan out to several subscriptions, and
*each* subscription can internally be a competing-consumers group. So "many
independent services react, and each service is itself horizontally scaled"
is pub-sub fan-out on the outside, point-to-point load-balancing on the
inside.

## Code example

An in-process broker captures the mechanism: a topic maps to a set of
subscriptions, each with its own ordered mailbox and optional attribute
filter. `publish` fans out a *clone* to every matching subscription, so no
subscriber can consume another's copy; `pull` drains one subscription's
mailbox independently; `unsubscribe` removes a subscription so later
publishes skip it. The runnable checks confirm each subscriber receives its
own copies, that a filtered subscriber only gets matching messages, and
that draining or unsubscribing one subscriber never affects another.

```rust
use std::collections::HashMap;
use std::collections::VecDeque;

// A message is an immutable, cloneable record. Each subscriber receives
// its OWN copy — pub-sub fan-out, not a shared queue where one consumer
// steals the message from the others.
#[derive(Clone, Debug, PartialEq)]
pub struct Message {
    pub topic: String,
    pub payload: String,
}

// One subscription = one independent, ordered mailbox. Durable in the
// sense that messages accumulate until the subscriber pulls them; a real
// broker would bound this and shed or dead-letter on overflow.
#[derive(Default)]
struct Subscription {
    // Optional attribute filter: only messages whose payload contains
    // this substring are delivered (a stand-in for content/attribute
    // filtering as in Google Pub/Sub filters or RabbitMQ topic bindings).
    filter: Option<String>,
    mailbox: VecDeque<Message>,
}

pub struct Broker {
    // topic -> (subscriber id -> subscription). The broker is the only
    // component both publishers and subscribers know about.
    topics: HashMap<String, HashMap<u64, Subscription>>,
    next_id: u64,
}

impl Broker {
    pub fn new() -> Self {
        Broker { topics: HashMap::new(), next_id: 0 }
    }

    // Register interest in a topic. Returns a subscriber id used to pull
    // and to unsubscribe. Only messages published AFTER this call reach
    // this subscriber (ephemeral subscription semantics).
    pub fn subscribe(&mut self, topic: &str, filter: Option<&str>) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        let sub = Subscription { filter: filter.map(|s| s.to_string()), mailbox: VecDeque::new() };
        self.topics.entry(topic.to_string()).or_default().insert(id, sub);
        id
    }

    pub fn unsubscribe(&mut self, topic: &str, id: u64) {
        if let Some(subs) = self.topics.get_mut(topic) {
            subs.remove(&id);
        }
    }

    // Fan out: every current subscriber whose filter matches gets its own
    // copy. The publisher never learns who — or how many — received it,
    // and gets no reply. Returns the number of copies delivered.
    pub fn publish(&mut self, msg: Message) -> usize {
        let mut delivered = 0;
        if let Some(subs) = self.topics.get_mut(&msg.topic) {
            for sub in subs.values_mut() {
                let matches = match &sub.filter {
                    Some(f) => msg.payload.contains(f.as_str()),
                    None => true,
                };
                if matches {
                    sub.mailbox.push_back(msg.clone());
                    delivered += 1;
                }
            }
        }
        delivered
    }

    // Pull-style delivery: a subscriber drains its own mailbox. Because
    // each subscription owns a distinct VecDeque, one slow subscriber
    // can't starve or reorder another's stream.
    pub fn pull(&mut self, topic: &str, id: u64) -> Vec<Message> {
        match self.topics.get_mut(topic).and_then(|s| s.get_mut(&id)) {
            Some(sub) => sub.mailbox.drain(..).collect(),
            None => Vec::new(),
        }
    }
}
```

Publishing one `high-value` order to three subscribers — two unfiltered,
one filtered on `high-value` — delivers three copies; a plain order
delivers only two. Draining the email subscriber leaves analytics' mailbox
untouched, and unsubscribing analytics means the next publish reaches only
email. That independence per subscriber is exactly what distinguishes
pub-sub fan-out from a shared work queue.

## When to use it

- Multiple independent consumers need to react to the same event, and the
  set of consumers changes over time — you want to add one without
  touching the producer.
- Producers and consumers should deploy independently, without coordinated
  releases, and the producer must not inherit consumers' latency or
  failures.
- The natural shape is "one thing happened, many parties care" — a fan-out,
  not a hand-off.

## When not to use it

- The producer needs a response back from the consumer. Pub-sub is
  fire-and-forget by design; use request-response or
  [asynchronous request-reply](/docs/patterns/communication/asynchronous-request-reply)
  when a reply is required.
- Exactly one consumer should ever handle each message — that's a
  point-to-point queue with
  [competing consumers](/docs/patterns/batch-streaming/competing-consumers),
  not fan-out.
- Strict *global* ordering across a whole topic matters and the broker only
  guarantees per-partition order — you'd have to collapse to a single
  partition and lose the parallelism.
- Only one tightly-coupled consumer will ever exist — a direct call or a
  simple queue has fewer moving parts.

## Use-case scenarios

**Fanning out a media upload.** A user uploads a file; the storage service
publishes one `file.uploaded` event. Independent subscribers — a
thumbnailer, a virus scanner, a search indexer — each receive their own
copy and run in parallel, none aware of the others. Adding a "generate
captions" step later is a new subscription, with zero change to the upload
service. Google Cloud Pub/Sub and AWS SNS are the usual managed brokers
here.

**Real-time UI updates via lightweight pub-sub.** A collaborative app uses
Redis pub/sub (ephemeral, fire-and-forget) to push presence and cursor
updates to all connected server instances, which relay them to browsers.
Missing a message during a blip is acceptable — the next update supersedes
it — so the ephemeral, no-durability model is a feature, not a gap.

**Event backbone with replay.** An organization runs Kafka as the shared
backbone: each domain publishes to topics, and every consuming team runs
its own consumer group, independently reading every event. When a team
ships a new service or fixes a bug, it rewinds its group's offset and
replays history to rebuild its state — the retained log makes onboarding a
new subscriber a replay rather than a backfill request to the producer.

## Related patterns

- [Event-Driven Architecture](/docs/patterns/communication/event-driven-architecture) —
  the architectural style that most commonly uses pub-sub as its transport;
  pub-sub is the messaging primitive, EDA is the system built on it.
- [Distributed Message Queue](/docs/patterns/building-blocks/distributed-message-queue) —
  the broker infrastructure that provides the fan-out, durability, and
  replay pub-sub relies on.
- [Competing Consumers](/docs/patterns/batch-streaming/competing-consumers) —
  scales a *single* subscription across a worker pool; composes inside a
  pub-sub subscription as a consumer group.
- [Idempotency](/docs/patterns/reliability/idempotency) — required of
  consumers because pub-sub brokers typically deliver at-least-once.
- [Dead Letter Queue](/docs/patterns/reliability/dead-letter-queue) — where
  messages that repeatedly fail delivery are routed instead of blocking or
  vanishing.

## Further reading

- [Publish-subscribe pattern — Wikipedia](https://en.wikipedia.org/wiki/Publish%E2%80%93subscribe_pattern)
- [Google Cloud Pub/Sub overview — Google Cloud docs](https://cloud.google.com/pubsub/docs/overview)
- [Publish-subscribe messaging model — Google Cloud docs](https://cloud.google.com/pubsub/docs/publish-message-overview)
- [Redis Pub/Sub — Redis docs](https://redis.io/docs/latest/develop/interact/pubsub/)
