---
title: "Dead Letter Queue"
sidebar_position: 6
supplementary: true
---

A dead letter queue (DLQ) is a separate queue that messages are routed
to after they repeatedly fail processing, so a single unprocessable
message stops blocking the main queue and stops disappearing silently —
it lands somewhere it can be inspected, root-caused, and replayed.

![Dead Letter Queue diagram](/img/patterns/dead-letter-queue.svg)

## Problem it solves

In a message queue, a single malformed or unprocessable message — a
**poison message** — is dangerous out of all proportion to its size,
because the consumer's naive failure handling amplifies it. If a failed
message is left at the front of the queue and retried immediately, and
it fails *every* time (because the failure is inherent to the message's
content, not a transient blip), it blocks every message behind it
indefinitely: the consumer spins forever on the same poison message
while the backlog grows without bound. This is a head-of-line block that
can take down an entire pipeline over one bad record.

The opposite reflex is just as harmful. Silently *dropping* a message
that fails processing loses data with no trace — the failure is
invisible until something downstream notices a gap days later, by which
point the original message and the context around it are gone. A DLQ
threads between these two failure modes: it neither blocks the queue nor
loses the message.

## Technical architecture & implementation

**Attempt counting and the threshold.** The consumer, or the broker
itself, tracks how many times a given message has been delivered without
a successful acknowledgement. Once that count crosses a configured
**maximum receive count** (`maxReceiveCount` in SQS; a delivery-attempt
header elsewhere), the message is *moved* to the DLQ rather than being
redelivered again. The threshold is a deliberate tradeoff: too low and
you dead-letter messages that a couple more retries would have cleared
(a brief downstream blip); too high and a genuine poison message wastes
many cycles and delays every message stuck behind it before it's finally
set aside.

**Retry first, dead-letter last.** A DLQ is not a replacement for
retrying — it's the *terminal destination* after retries are exhausted.
The healthy path is: attempt → fail → back off → retry (see [retry with
backoff](/docs/patterns/reliability/retry-with-backoff)) → and only once
the bounded retry budget is spent does the message go to the DLQ. This
ordering matters because the two mechanisms target different failures.
Retry handles **transient** faults (a dependency that was briefly down, a
lock that was briefly held) that clear on their own. The DLQ handles
**deterministic** faults (a schema the consumer can't parse, a
referenced entity that doesn't exist, a bug in one edge case) that will
never clear no matter how many times you retry — so continuing to retry
them is pure waste and continuing to hold them at the head is pure
blockage.

**Moving, not copying — and unblocking.** The defining action is that
the message *leaves* the main queue. The moment it's moved to the DLQ,
the consumer is free to pick up the next message and the pipeline flows
again. The failed message is preserved intact on the DLQ — typically
with metadata about *why* and *how many times* it failed — so no data is
lost and the head-of-line block is cleared in the same step.

**Poison-message detection and metadata.** A good DLQ entry is
diagnosable. Implementations attach the original message body plus
context: the exception or error, the number of attempts, the source
queue, and a timestamp. This is what turns a DLQ from a graveyard into a
triage queue — an engineer (or an automated classifier) can look at a
message and immediately see *bad schema* vs *missing dependency* vs *bug
in a specific branch*, without having to reconstruct the failure from
logs.

**Alerting on DLQ depth.** A DLQ that nobody watches is just a slower way
to lose data. The operational discipline is to alarm on DLQ **depth** (or
its rate of growth): a non-empty DLQ means messages are failing
deterministically and needs a human. A *sudden* spike usually signals a
systemic problem — a bad deploy, a downstream schema change, an expired
credential — where many messages are poisoned by the same root cause at
once, which is exactly the situation you most want a page for.

**Ordering caveat.** Moving a message out of sequence into a DLQ (and
later redriving it) breaks strict ordering guarantees. In a system where
a consumer depends on processing a partition's messages in order, quietly
dead-lettering message #5 and continuing with #6 may be incorrect — the
right response there is often to *pause the whole partition* on a
persistent failure rather than skip past it. Relatedly, under [competing
consumers](/docs/patterns/batch-streaming/competing-consumers) the DLQ is
shared across all workers, so its depth reflects the fleet's total
poison rate, not any one worker's.

**Where it sits among siblings.** The DLQ is downstream of everything
else in the reliability stack for a message. [Retry with
backoff](/docs/patterns/reliability/retry-with-backoff) is what happens
*before* it (bounded retries), and a
[distributed message queue](/docs/patterns/building-blocks/distributed-message-queue)
is the substrate it's built into. Where
[idempotency](/docs/patterns/reliability/idempotency) makes those
pre-DLQ retries *safe*, the DLQ decides *when to stop retrying at all*.
It is the pattern's answer to "retries can't be infinite — so where does
a message go when the budget runs out?"

## Redrive / replay

Getting messages *into* the DLQ is only half the pattern; getting the
recoverable ones back out is the other half.

- **Redrive (replay):** after the root cause is fixed — a consumer
  bug patched, a downstream dependency restored, a schema migration
  applied — the operator redrives messages from the DLQ back to the
  source queue, where they're processed normally with the now-corrected
  consumer. SQS exposes this as a built-in "start message move task."
- **Discard:** some DLQ messages are genuinely, permanently invalid
  (corrupt data, a request for a deleted resource). Those are inspected,
  logged, and deleted — the DLQ made the loss a *deliberate, visible*
  decision instead of a silent one.
- **Partial redrive:** because DLQ entries carry the failure reason, you
  can redrive selectively — replay only the messages that failed for the
  now-fixed reason and leave the rest for further triage.

Redrive is where idempotency becomes non-negotiable: a message that
partially applied before failing, then gets redriven, will be processed
*again* — so the consumer must be idempotent or the replay double-applies
whatever the first attempt already did.

## Code example

A minimal processor that gives each message a bounded retry budget and
routes it to the DLQ once the budget is spent. It exhibits the two
core behaviors: a message that eventually succeeds is *not* dead-lettered,
and a permanently-failing (poison) message lands on the DLQ after exactly
`max_attempts` tries — not before, not never. Pure `std`, deterministic.

```rust
#[derive(Debug, Clone)]
struct Message {
    id: u64,
    payload: String,
}

#[derive(Debug)]
struct DeadLetter {
    message: Message,
    attempts: u32,
    reason: String,
}

struct Processor {
    max_attempts: u32,
    dlq: Vec<DeadLetter>,
    processed: Vec<u64>,
}

impl Processor {
    fn new(max_attempts: u32) -> Self {
        Processor { max_attempts, dlq: Vec::new(), processed: Vec::new() }
    }

    /// Deliver a message, retrying up to `max_attempts`. `handle` returns
    /// Ok on success or Err(reason) on a failed attempt. After the budget
    /// is exhausted, the message is routed to the DLQ instead of looping.
    fn deliver<F>(&mut self, msg: Message, mut handle: F)
    where
        F: FnMut(&Message, u32) -> Result<(), String>,
    {
        for attempt in 1..=self.max_attempts {
            match handle(&msg, attempt) {
                Ok(()) => {
                    self.processed.push(msg.id);
                    return;
                }
                Err(reason) if attempt == self.max_attempts => {
                    // Budget spent: terminal route to the DLQ, unblocking the queue.
                    self.dlq.push(DeadLetter { message: msg, attempts: attempt, reason });
                    return;
                }
                Err(_) => continue, // transient: back off and retry (elided)
            }
        }
    }
}
```

The routing decision hinges on the `attempt == self.max_attempts` guard:
a transient failure loops back to retry, but the *last* failed attempt
takes the DLQ branch instead of retrying into an infinite loop.

## When to use it

- Any queue-based or event-driven consumer where a single bad message
  could otherwise stall processing for everything behind it.
- Systems where losing a message silently is unacceptable and failures
  must be visible, countable, and diagnosable.
- Alongside [retry with
  backoff](/docs/patterns/reliability/retry-with-backoff) — the DLQ is
  the destination *after* retries are exhausted, complementing them
  rather than replacing them.

## When not to use it

- Strict-ordering consumers, where moving a message out of sequence into
  a DLQ (and later redriving it) would violate the order guarantees the
  consumer depends on — pausing the partition is usually the better
  strategy there.
- Extremely high-volume, low-value message streams where the operational
  cost of monitoring and triaging a DLQ exceeds the value of the messages
  that land there — a monitored, counted discard may be more practical
  than retaining every failure.
- Failures that are purely transient and always self-clear within the
  retry budget — if nothing is ever genuinely poison, the DLQ stays empty
  and adds only configuration overhead (though it costs little to keep as
  a safety net).

## Use-case scenarios

**Order-processing pipeline with a schema-breaking event.** An orders
service consumes events from a broker. A producer deploys a change that
emits an event the consumer can't parse. Without a DLQ, that event jams
at the head of the queue and every subsequent order stalls behind it.
With a DLQ, the unparseable event is retried a few times, moved aside,
and the pipeline keeps flowing; an alarm on DLQ depth pages the team,
who fix the consumer and redrive the parked events.

**Payment webhook consumer hitting a downstream outage.** A consumer
processes payment webhooks by calling a ledger service that briefly goes
down. Retries with backoff clear the *transient* failures once the ledger
recovers. But a webhook referencing a since-deleted account fails
deterministically every time — that one exhausts its retry budget and
lands on the DLQ, where an engineer sees "account not found," confirms
it's unrecoverable, and discards it deliberately rather than letting it
loop forever.

**Bad-deploy blast radius contained by a DLQ.** A new consumer version
ships with a bug that throws on one common message shape. DLQ depth
spikes within minutes and triggers a page — the spike itself is the
signal that this is a *systemic* fault, not scattered bad data. The team
rolls back the deploy, then redrives the DLQ so every message the buggy
version rejected is reprocessed correctly by the restored version, with
no data lost.

## Production libraries & getting started

A DLQ is a broker feature, not a library you import — you configure it on the queue and use the broker's client to consume/redrive it. Kafka is the exception: the core broker has no native DLQ, so the DLQ lives in the framework consuming it (Kafka Connect's error-DLQ, or Spring Kafka's dead-letter topics).

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| Amazon SQS DLQ | any (AWS SDK) | Broker-native DLQ via `maxReceiveCount` + built-in redrive | [SQS DLQ docs](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html) · [JS SDK](https://github.com/aws/aws-sdk-js-v3) |
| RabbitMQ dead-letter exchange | any (AMQP client) | Route rejected/expired/over-limit messages to a DLX to preserve them | [DLX docs](https://www.rabbitmq.com/docs/dlx) (browser-live; 403 to curl) |
| Azure Service Bus DLQ | any (Azure SDK) | Built-in per-entity dead-letter sub-queue with reason metadata | [Service Bus DLQ docs](https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-dead-letter-queues) |
| Kafka Connect error DLQ | JVM / config | `errors.deadletterqueue.topic.name` routes unprocessable records to a DLQ topic | [Confluent deep dive](https://www.confluent.io/blog/kafka-connect-deep-dive-error-handling-dead-letter-queues/) |
| Spring Kafka (DLT) | Java/Kotlin | `DeadLetterPublishingRecoverer` + `@RetryableTopic` produce a dead-letter topic after retries | [error-handling docs](https://docs.spring.io/spring-kafka/reference/kafka/annotation-error-handling.html) |
| BullMQ failed set | JS/TS (Redis) | Jobs that exhaust attempts move to a `failed` set for inspection/retry | [retrying failing jobs](https://docs.bullmq.io/guide/retrying-failing-jobs) |

## Related patterns

- [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff) —
  governs the bounded retry attempts that happen *before* a message is
  finally routed to the DLQ; the DLQ is where those retries terminate.
- [Distributed Message Queue](/docs/patterns/building-blocks/distributed-message-queue) —
  the substrate a DLQ is built on; the main queue and the dead-letter
  queue are two queues in the same broker.
- [Competing Consumers](/docs/patterns/batch-streaming/competing-consumers) —
  a shared DLQ collects poison messages from an entire fleet of workers
  pulling the same queue.
- [Idempotency](/docs/patterns/reliability/idempotency) — required for
  safe redrive, since a replayed message is processed again and must not
  double-apply what a prior partial attempt already did.
- [Pub-Sub](/docs/patterns/communication/pub-sub) — pub-sub and other
  queue-based delivery mechanisms are the systems whose undeliverable
  messages a DLQ typically catches.

## Further reading

- [Dead letter queue — Wikipedia](https://en.wikipedia.org/wiki/Dead_letter_queue)
- [Amazon SQS dead-letter queues — AWS documentation](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)
- [Amazon SQS dead-letter queue redrive — AWS documentation](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues-redrive.html)
- [RabbitMQ dead letter exchanges — official docs](https://www.rabbitmq.com/docs/dlx)
- [Azure Service Bus dead-letter queues — Microsoft Learn](https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-dead-letter-queues)
