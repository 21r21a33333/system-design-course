---
title: "Competing Consumers"
sidebar_position: 8
supplementary: true
---

Competing Consumers runs multiple consumer instances against the same
queue or subscription so that each message is delivered to exactly one
of them, letting the group's total processing throughput scale by
simply adding more consumer instances.

![Competing Consumers diagram](/img/patterns/competing-consumers.svg)

## Problem it solves

A single consumer reading a work queue has a hard ceiling on
throughput: whatever one process can chew through per second is the
whole system's capacity, no matter how fast the producer or how large
the backlog gets. Vertically scaling that one consumer (a bigger
machine, more threads in the same process) only goes so far and
usually isn't where the elasticity is needed — what's needed is the
ability to add capacity by adding more workers, the same way a web
tier scales by adding more instances behind a load balancer. Doing
that naively, by just starting more processes that all read the same
queue, immediately raises the question of who gets which message; if
that isn't handled at the queue level, multiple consumers doing the
same work twice (or racing each other) is the likely result.

## Technical architecture & implementation

**The claim-and-acknowledge cycle.** Any number of consumer instances
connect to the same queue or subscription and pull from it
concurrently. The broker guarantees that each message is handed to
exactly one consumer — never broadcast — either by having consumers
compete to claim the next available message or by round-robining
messages across whichever consumers are currently connected and idle.
The unit that makes this safe is the **ack** (acknowledgment): once a
consumer takes a message, the broker doesn't delete it — it hides it
and starts a timer. Only after the consumer explicitly acknowledges
success does the broker remove it. This two-phase claim-then-ack is
what separates competing consumers from a naive "pop from a shared
list": a crash after popping but before finishing would silently lose
the work, whereas a crash before the ack simply lets the message
reappear.

**Visibility timeout / lease / redelivery.** The mechanism that hides a
claimed message goes by different names — SQS calls it a *visibility
timeout*, other brokers call it a *lease* or *ack deadline* — but the
shape is identical: the message is invisible to other consumers for a
bounded window, and if no ack arrives before the window closes, the
broker assumes the consumer died and makes the message visible again
for another worker to claim. This is the core resilience property: the
group survives any single consumer's failure, not just the queue's.
The tuning tension is real — too short a timeout and a slow-but-healthy
worker's message gets redelivered and processed twice; too long and a
genuinely dead worker's message sits stuck for that whole window before
anyone retries it. Long-running handlers often *extend* the lease
periodically (a heartbeat) rather than picking one fixed timeout.

**At-least-once delivery and its consequence.** Because a message can
reappear after a timeout or an ambiguous ack, the delivery guarantee is
**at-least-once**, not exactly-once. A message may be processed more
than once — by a redelivery after a slow ack, by a retry after a
partial failure, or by a broker replay. This is not a defect to be
tuned away; it is the fundamental contract, and it makes
[idempotency](/docs/patterns/reliability/idempotency) a hard requirement
on the handler rather than a nice-to-have (covered below). Systems that
genuinely need each effect to happen once build
[exactly-once semantics](/docs/patterns/batch-streaming/exactly-once-semantics)
on top of this at-least-once substrate, typically via deduplication
keyed on a message ID.

**Failure modes.** Two failure modes dominate operations. A **poison
message** — malformed, referencing deleted state, or otherwise
un-processable — will fail, get redelivered, fail again, and loop
forever, burning a worker slot each cycle. The standard guard is a
*max-receive count*: after N delivery attempts the broker routes the
message to a [dead-letter queue](/docs/patterns/reliability/dead-letter-queue)
for out-of-band inspection instead of retrying it endlessly. The second
is **ordering loss**: because any consumer can claim any message and
finish at any time, two messages for the same logical entity can be
processed concurrently or out of arrival order. Plain competing
consumers offers *no* per-key ordering guarantee — a deliberate
trade for throughput and elasticity.

**Scaling on queue depth.** Since consumers are stateless and
interchangeable with respect to the queue, the group scales by simply
starting or stopping instances — no message needs to know in advance
which consumer will handle it. This pairs naturally with
[auto-scaling](/docs/patterns/scaling/auto-scaling): queue depth (or
oldest-message age) is the ideal scaling signal, since a growing
backlog is a direct measure of consumers falling behind producers. Add
workers until depth stabilizes; scale down when it drains.

**Competing Consumers vs. its siblings.** The distinction from
[Publish-Subscribe](/docs/patterns/communication/pub-sub) is what
happens to each message, not how many consumers exist. In pub-sub's
fan-out, every subscriber gets its own copy of every message — N
subscribers each independently see all N messages because they do
*different* things with the same event (one emails, one indexes).
Competing Consumers is the opposite: N interchangeable peers do the
*same* job and divide *one* workload, each message going to exactly one
of them. Pub-sub multiplies delivery across differing subscribers;
competing consumers divides delivery across identical workers. The
distinction from
[Partitioned Consumption](/docs/patterns/batch-streaming/partitioned-consumption)
and [Sequential Convoy](/docs/patterns/batch-streaming/sequential-convoy)
is ordering: those bind each key to a single lane to preserve per-key
order, sacrificing the free-for-all claim model; plain competing
consumers keeps the free-for-all and gives up ordering in exchange.

## Ordering and idempotency

Because delivery is at-least-once and any worker can claim any message,
a correct competing-consumers handler must assume **both** that a
message may arrive more than once **and** that two related messages may
be processed out of order or concurrently. The two properties are
handled separately:

- **Idempotency** neutralizes duplicates. The handler is written so
  that processing the same message twice has the same effect as
  processing it once — typically by recording a dedup key (the message
  ID, or a natural business key) in a store checked before applying the
  effect, or by making the effect itself naturally idempotent (an
  upsert keyed on a stable ID rather than an unconditional insert or a
  relative `+=`). Without this, a redelivery after a slow ack
  double-charges a card or double-ships an order.

- **Ordering** is *not* something competing consumers gives you, so if
  two messages for the same entity truly must not be reordered, plain
  competing consumers is the wrong pattern — reach for
  [Partitioned Consumption](/docs/patterns/batch-streaming/partitioned-consumption)
  or [Sequential Convoy](/docs/patterns/batch-streaming/sequential-convoy),
  which route same-key messages to the same lane. A common middle
  ground is to keep competing consumers for throughput and make handlers
  *commutative or version-guarded* (ignore a message whose version is
  older than the entity's current state), tolerating reordering rather
  than preventing it.

| Concern | Cause under competing consumers | Standard fix |
| --- | --- | --- |
| Duplicate processing | at-least-once redelivery, slow ack | dedup key / idempotent effect |
| Out-of-order effects | any worker claims any message | version guard, or use a per-key lane |
| Infinite retry | poison message | max-receive count → dead-letter queue |
| Backlog growth | producers outpace consumers | autoscale on queue depth |

## Code example

The snippet below runs a *genuinely concurrent* worker pool: four real
`std::thread`s each pull from one shared queue, and the timing at the
end proves the throughput win is real, not simulated. The unit of work
is a 20 ms sleep standing in for real processing.

```rust
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct Message {
    id: u64,
}

// Stand-in for a broker queue: claim() atomically removes and hands out
// one message. The Mutex makes claims serialize, so concurrent workers
// can never claim the same message — the real broker enforces this
// server-side (e.g. SQS visibility timeout, Kafka partition assignment).
struct Queue {
    messages: VecDeque<Message>,
}

impl Queue {
    fn claim(&mut self) -> Option<Message> {
        self.messages.pop_front()
    }
}

// Each worker pulls from the shared queue until it's drained. Workers
// never coordinate; adding more of them increases total throughput.
fn run_worker(_worker_id: u32, queue: &Arc<Mutex<Queue>>) -> u32 {
    let mut handled = 0;
    loop {
        // Hold the lock only long enough to claim, then release it so
        // other workers can claim while this one processes.
        let msg = queue.lock().unwrap().claim();
        match msg {
            Some(m) => {
                std::thread::sleep(Duration::from_millis(20)); // process(m)
                let _ = m.id;
                handled += 1;
            }
            None => return handled,
        }
    }
}

fn main() {
    let mut q = Queue { messages: VecDeque::new() };
    for id in 0..40 {
        q.messages.push_back(Message { id });
    }
    let queue = Arc::new(Mutex::new(q));

    let start = Instant::now();
    let counts: Vec<u32> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..4)
            .map(|w| {
                let q = Arc::clone(&queue);
                scope.spawn(move || run_worker(w, &q))
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });

    let done: u32 = counts.iter().sum();
    println!("{done} messages across 4 workers in {:?}", start.elapsed());
    println!("per-worker counts: {counts:?}");
}
```

Running this processes 40 messages — which would take ~800 ms on a
single worker — in roughly **260 ms** across four workers, with each
worker handling about ten messages. That near-4× speedup is the
horizontal-throughput property the pattern exists for, and the fact
that the per-worker counts come out balanced (`[10, 10, 10, 10]`) shows
the shared queue naturally load-balances: a worker that happens to
finish faster simply claims the next message sooner, no scheduler
required.

## When to use it

- Throughput on a queue of independent, identical work items needs to
  scale horizontally by adding more consumer processes, rather than
  being capped by a single consumer's capacity.
- Work items don't need to be broadcast to multiple different
  downstream purposes — each item just needs to be processed once, by
  whichever available worker picks it up.
- Consumers can be made stateless and interchangeable with respect to
  the queue, so any instance can pick up any message without needing
  prior context about it.

## When not to use it

- Every consumer actually needs to see every message for a different
  purpose — that's [Publish-Subscribe](/docs/patterns/communication/pub-sub)'s fan-out delivery, not this
  pattern's divide-the-work delivery.
- Messages for the same logical entity must be processed in order
  relative to each other — plain competing consumers gives no ordering
  guarantee across messages, since any consumer can claim any message;
  see [Partitioned Consumption](/docs/patterns/batch-streaming/partitioned-consumption) for scaling out while
  preserving per-key order.
- The workload is so low-volume that a single consumer never becomes a
  bottleneck — running a pool of competing consumers adds operational
  complexity (monitoring, scaling policy, idle-worker cost) that isn't
  earning its keep.

## Use-case scenarios

**Image/video processing worker fleet.** A media platform accepts user
uploads and needs each one transcoded into several resolutions — an
expensive, independent, per-file job. Uploads land on one queue and a
fleet of transcoder workers competes for them; when a marketing push
triples uploads, the fleet auto-scales on queue depth and the extra
workers simply claim more of the same queue. Because transcoding is
idempotent (re-encoding a file yields the same outputs), an at-least-once
redelivery after a worker crash is harmless — the job just reruns.

**Order-fulfillment task processing on SQS.** An e-commerce backend
drops "fulfill order" tasks onto an Amazon SQS standard queue read by a
pool of worker instances. SQS's visibility timeout hides a claimed task
from other workers until it's acknowledged; if a worker dies
mid-fulfillment, the task reappears and another worker retries it.
Handlers dedupe on order ID so a redelivery never double-ships, and a
max-receive count routes any task that fails repeatedly to a
dead-letter queue for a human to inspect rather than looping forever.

**Email/notification dispatch.** A notifications service enqueues
outbound messages (password resets, receipts, digests) that any of many
sender workers can pick up and hand to an email/SMS provider. The
workload is embarrassingly parallel and order-insensitive across
recipients, so competing consumers is a perfect fit; the only
discipline required is idempotency (dedupe on notification ID) so a
redelivered message doesn't send the same email twice.

## Related patterns

- [Publish-Subscribe](/docs/patterns/communication/pub-sub) — fans the
  same message out to every subscriber for different purposes;
  Competing Consumers instead divides a single workload across
  interchangeable workers.
- [Partitioned Consumption](/docs/patterns/batch-streaming/partitioned-consumption) —
  a more structured way to scale out consumers that also preserves
  per-key ordering, which plain competing consumers does not.
- [Sequential Convoy](/docs/patterns/batch-streaming/sequential-convoy) —
  the order-preserving counterpart: same-key messages are pinned to one
  lane, trading the free-for-all claim model for per-key FIFO.
- [Idempotency](/docs/patterns/reliability/idempotency) — the handler
  discipline that makes at-least-once delivery safe, so a redelivered
  message doesn't cause a duplicate effect.
- [Dead-Letter Queue](/docs/patterns/reliability/dead-letter-queue) —
  where poison messages are diverted after a max-receive count instead
  of being retried forever.
- [Auto-Scaling](/docs/patterns/scaling/auto-scaling) — scales the
  consumer pool up and down on queue depth so capacity tracks the
  backlog.

## Further reading

- [Competing Consumers pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/competing-consumers)
- [Amazon SQS visibility timeout — AWS documentation](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)
- [Consumer groups — Apache Kafka documentation](https://kafka.apache.org/documentation/#intro_consumers)
- [Work Queues — RabbitMQ tutorials](https://www.rabbitmq.com/tutorials/tutorial-two-python)
- [Message queue — Wikipedia](https://en.wikipedia.org/wiki/Message_queue)
