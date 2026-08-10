---
title: "Dead Letter Queue"
sidebar_position: 6
supplementary: true
---

A dead letter queue (DLQ) is a separate queue that messages are routed
to after they repeatedly fail processing, so they stop blocking the
main queue and can be inspected or replayed later instead of being
silently dropped.

## Problem it solves

In a message queue, a single malformed or unprocessable message — a
"poison message" — can be a serious problem if the consumer's failure
handling is naive. If a failed message is simply left at the front of
the queue and retried immediately, and it fails every single time
(because the failure is due to the message's content, not a transient
blip), it blocks every message behind it indefinitely: the consumer
gets stuck retrying the same poison message forever while the rest of
the queue backs up. The alternative failure mode is just as bad —
silently dropping messages that fail processing loses data with no
visibility into what happened or why, making the failure invisible
until someone downstream notices something is missing.

## How it works

The consumer (or the queue infrastructure itself) tracks how many times
a given message has been attempted. Once that count exceeds a
configured threshold, the message is removed from the main queue and
placed on a separate dead-letter queue instead of being retried again
or discarded. This unblocks the main queue immediately — subsequent
messages can be processed normally — while preserving the failed
message for later action: an engineer can inspect it to diagnose why it
failed (bad schema, missing dependency, bug in a specific edge case),
fix the underlying issue, and then redrive the message back into the
main queue for reprocessing, or discard it if it turns out to be
genuinely invalid.

## When to use it

- Any queue-based or event-driven consumer where a single bad message
  could otherwise stall processing for every message behind it.
- Systems where losing a message silently is unacceptable and failures
  need to be visible and diagnosable rather than invisible.
- Paired with [retry with backoff](/docs/patterns/reliability/retry-with-backoff) for transient failures — the DLQ is
  the destination after retries are exhausted, not a replacement for
  retrying in the first place.

## When not to use it

- Message ordering is strict and moving a message out of sequence into
  a DLQ (and later redriving it) would violate the order guarantees the
  consumer depends on — this needs a different failure strategy, such
  as pausing the whole partition.
- Extremely high-volume, low-value messages where the operational cost
  of monitoring and triaging a DLQ exceeds the value of the messages
  that end up there — in that case, a monitored discard might be more
  practical than retaining every failure.

## Real-world example

AWS SQS supports a redrive policy that specifies a `maxReceiveCount`:
once a message has been received (and not deleted, implying processing
failed) that many times, SQS automatically moves it to a configured
dead-letter queue, where it can be inspected via CloudWatch alarms and
later redriven back to the source queue once the underlying issue is
fixed.

## Related patterns

- [Publish-Subscribe](/docs/patterns/communication/pub-sub) — pub-sub and other queue-based delivery mechanisms are the systems whose undeliverable messages a DLQ typically catches.
- [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff) — governs the retry attempts that happen before a message is finally routed to the DLQ.

## Further reading

- [Dead letter queue — Wikipedia](https://en.wikipedia.org/wiki/Dead_letter_queue)
- [Amazon SQS dead-letter queues — AWS documentation](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)
