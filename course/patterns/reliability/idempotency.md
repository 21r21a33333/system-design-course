---
title: "Idempotency"
sidebar_position: 3
supplementary: true
---

An idempotent operation produces the same result and the same
observable effect no matter how many times it is applied — calling it
once or calling it five times leaves the system in the same state as
calling it exactly once. It is the property that makes a retry safe
even when the caller can't tell whether the original attempt succeeded.

![Idempotency diagram](/img/patterns/idempotency.svg)

## Problem it solves

Networks fail in a specific, maddening way: a client can fail to
receive a response even when the server successfully processed the
request. From the client's point of view, a timed-out "charge card"
call is indistinguishable from one that silently succeeded — the bytes
that would have told the two apart are exactly the bytes that got lost.
If the client's only recourse is to retry, and the operation isn't
idempotent, that retry risks applying the effect twice: charging the
customer twice, placing two orders, sending a duplicate notification,
incrementing a counter an extra time.

This isn't a rare edge case. Every reliability mechanism that improves
delivery does so by *repeating* work. [Retry with
backoff](/docs/patterns/reliability/retry-with-backoff) re-sends
requests. Message brokers that guarantee *at-least-once* delivery
redeliver on any ambiguity. Load balancers re-route a request whose
backend went silent. Each of these turns a single logical intent into
possibly-many physical attempts — and idempotency is the property that
keeps "possibly many attempts" from meaning "possibly many effects."

## Technical architecture & implementation

**Natural idempotency (design the operation to be repeatable).** The
cheapest idempotency is the kind you get for free from the shape of the
operation. Setting a field to a fixed value (`status = "shipped"`), or
a `DELETE` on a resource that's already gone, produce the same end
state regardless of repetition. HTTP encodes this directly: `GET`,
`PUT`, and `DELETE` are specified as idempotent, while `POST` is not —
precisely because `POST` usually means "create a new thing" or "apply a
delta," where repeating it creates a second thing or applies the delta
twice. Whenever you can express a write as "set to this absolute value"
rather than "adjust by this amount," you convert an at-risk operation
into a naturally safe one.

**Idempotency keys (bolt safety onto non-idempotent operations).** Some
operations are non-idempotent by nature — "charge this card," "place
this order" — and no amount of API design makes a second charge harmless
on its own. For these, the client generates a unique **idempotency key**
(a UUID) for a given logical operation and sends it with the request.
The server maintains a **dedup store** mapping key → the recorded result
of the first attempt. On the first request for a key it executes the
side effect, records the result under the key, and returns it. On any
repeat of the same key it *skips the side effect entirely* and returns
the stored result. This is what reconciles "retry freely" with "the
effect happens exactly once": the client can resend as often as it
likes, and the server deduplicates by key rather than by trusting the
client to send each intent only once.

**Idempotent consumers (dedup in message pipelines).** The same idea
carries into queues and streams. A consumer reading an at-least-once
stream will occasionally see the same message twice — on redelivery
after a crash, a rebalance, or an ack that was lost in flight. An
**idempotent consumer** deduplicates by a stable identifier: the
producer's message ID, a business key, or (for a partitioned log) the
partition offset it has already committed past. Combining *at-least-once
delivery* with *idempotent processing* is the pragmatic way most systems
achieve an **exactly-once effect** without the heavy machinery of true
exactly-once transactional delivery — see [exactly-once
semantics](/docs/patterns/batch-streaming/exactly-once-semantics). This
matters especially under [competing
consumers](/docs/patterns/batch-streaming/competing-consumers), where
several workers share a queue and a redelivered message may land on a
*different* worker than the one that first (partially) processed it, so
the dedup state must live in shared storage, not worker memory.

**Making the write itself idempotent.** The most robust designs push
idempotency down to the database so it holds even if the application
layer double-fires. An **upsert** (insert-or-update keyed on a unique
constraint) collapses repeated inserts into one row. A **conditional
write** — compare-and-set, or "update only if `version = N`" — lets a
second attempt detect that the first already applied and become a no-op.
A unique index on the idempotency key turns a duplicate into a
constraint violation the application can catch and treat as success.
These make the storage layer the final arbiter, so idempotency doesn't
depend on the dedup cache being perfectly available.

**Failure modes to design against.** Two mistakes recur. First, **key
reuse across different payloads**: if a client reuses an idempotency key
for a genuinely different request, a naive server returns the *old*
result and silently drops the new operation. Robust implementations
fingerprint the request body and reject a reused key whose payload
differs, rather than masking a real second intent. Second, **dedup-store
TTL too short**: keys are usually expired after a bounded window (Stripe
holds them ~24 hours) because clients don't retry forever and unbounded
dedup state is expensive — but if the window is shorter than the
client's real retry horizon, a late retry sails past an expired key and
double-executes. The TTL must outlive the longest retry schedule that
can reach it.

**Where it sits among siblings.** Idempotency is a property of the
*operation*, not a runtime posture toward a dependency. That's the clean
line between it and its neighbors: [retry with
backoff](/docs/patterns/reliability/retry-with-backoff) *depends on*
idempotency (retrying a non-idempotent write is a bug), [circuit
breaker](/docs/patterns/reliability/circuit-breaker) and
[failover](/docs/patterns/reliability/failover) change *how or whether*
a call is made, and idempotency changes what happens when the *same*
call arrives more than once. It is the quiet precondition that makes all
the others safe to apply to writes.

## Idempotency keys — the request lifecycle

A single keyed request walks a small state machine on the server:

1. **Receive** request with header `Idempotency-Key: <uuid>`.
2. **Look up** the key in the dedup store.
   - *Hit, completed:* return the stored response — no side effect runs.
   - *Hit, in-flight:* a concurrent duplicate is mid-flight; block or
     return `409 Conflict` so two copies don't both execute.
   - *Miss:* claim the key (mark in-flight), execute the side effect,
     store `{key → response, payload fingerprint}`, mark completed, and
     return the response.
3. **Expire** the key after a TTL longer than any legitimate retry
   window.

The in-flight state is what makes this concurrency-safe: without it, two
duplicates that arrive within milliseconds can both miss the store and
both execute. Claiming the key atomically (a conditional insert)
serializes them.

## Code example

A keyed request handler over an in-memory dedup store. The side effect
here is a `charge` that increments a running total, demonstrating the
essential property: a **second call with the same key returns the stored
result and does not run the side effect again**, while a *different* key
does execute. Pure `std`, single-threaded and deterministic.

```rust
use std::collections::HashMap;

/// The recorded outcome of a first, successful execution.
#[derive(Clone, Debug, PartialEq)]
struct ChargeResult {
    charge_id: u64,
    amount_cents: u64,
}

struct PaymentService {
    // Dedup store: idempotency key -> (payload fingerprint, stored result).
    seen: HashMap<String, (u64, ChargeResult)>,
    next_charge_id: u64,
    // Observable side effect: total money actually moved. If idempotency
    // works, a replayed key must NOT increase this.
    total_charged: u64,
}

#[derive(Debug, PartialEq)]
enum ChargeError {
    // Same key, different request body — a real second intent hiding
    // behind a reused key. Refuse rather than silently returning the old one.
    KeyReusedWithDifferentPayload,
}

impl PaymentService {
    fn new() -> Self {
        PaymentService { seen: HashMap::new(), next_charge_id: 1, total_charged: 0 }
    }

    /// Idempotent charge. `fingerprint` stands in for a hash of the request body.
    fn charge(
        &mut self,
        key: &str,
        fingerprint: u64,
        amount_cents: u64,
    ) -> Result<ChargeResult, ChargeError> {
        if let Some((seen_fp, result)) = self.seen.get(key) {
            // Replay: return the recorded result, run no side effect...
            if *seen_fp != fingerprint {
                // ...unless the key was reused for a different payload.
                return Err(ChargeError::KeyReusedWithDifferentPayload);
            }
            return Ok(result.clone());
        }

        // First time for this key: run the side effect exactly once.
        let result = ChargeResult { charge_id: self.next_charge_id, amount_cents };
        self.next_charge_id += 1;
        self.total_charged += amount_cents;
        self.seen.insert(key.to_string(), (fingerprint, result.clone()));
        Ok(result)
    }
}
```

The load-bearing line is that `total_charged` reads `2500` after two
identical calls, not `5000`: the second call takes the early return and
never touches the side effect.

## When to use it

- Any operation a client might legitimately retry — which, given network
  unreliability, is effectively every write exposed over a network.
- Payment, order-creation, and other operations where a duplicate has a
  real financial or user-facing cost.
- Message consumers on an at-least-once broker, where redelivery is
  normal and processing a message twice must not double its effect.
- As the mandatory partner to [retry with
  backoff](/docs/patterns/reliability/retry-with-backoff): retries are
  safe *by construction* only when the target is idempotent.

## When not to use it

- Pure read operations, which are naturally idempotent already and need
  no extra mechanism.
- Operations where the dedup state is genuinely expensive to keep and
  the cost of a rare duplicate is negligible — though the usual fix is a
  bounded TTL, not skipping idempotency entirely.
- Cases where "the same request again" legitimately *should* create a new
  entity every time (e.g. an audit-log append) — there, deduplication
  would be a correctness bug, not a safeguard.

## Use-case scenarios

**Payment charge over a flaky mobile network.** A checkout app fires
"charge $25" and the response times out. The app can't tell whether the
charge went through, so it retries with the *same* idempotency key. The
payment provider sees the key already completed and returns the original
charge record — the customer is charged once, and the app shows a
success it can trust.

**Order-submit with a double-click.** A shopper impatiently clicks "Place
Order" twice. The frontend attaches one idempotency key to the logical
order and sends it on both clicks. The server's conditional insert on
the key lets the first through and turns the second into a return of the
same order, so no duplicate order is created — the classic
double-submit, solved at the write layer rather than by disabling the
button.

**Webhook receiver deduplicating redeliveries.** A provider guarantees
at-least-once webhook delivery and will resend an event until it gets a
`2xx`. The receiver (see [webhooks](/docs/patterns/communication/webhooks))
records each event's unique ID in a dedup store; a redelivered event is
recognized and acknowledged without re-running its handler, so a
"payment.succeeded" event fulfills the order exactly once even if the
provider delivers it three times.

## Related patterns

- [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff) —
  the retry strategy that idempotency makes safe to apply to writes;
  they are almost always deployed together.
- [Exactly-Once Semantics](/docs/patterns/batch-streaming/exactly-once-semantics) —
  at-least-once delivery plus idempotent processing is the standard,
  practical route to an exactly-once *effect*.
- [Competing Consumers](/docs/patterns/batch-streaming/competing-consumers) —
  when workers share a queue, redelivery may hit a different worker, so
  idempotency (with shared dedup state) is what keeps parallel
  consumption correct.
- [Dead Letter Queue](/docs/patterns/reliability/dead-letter-queue) —
  the terminal home for a message that keeps failing; retries feeding a
  DLQ still require idempotent processing so the pre-DLQ attempts don't
  double-apply.

## Further reading

- [Idempotence — Wikipedia](https://en.wikipedia.org/wiki/Idempotence)
- [Designing robust and predictable APIs with idempotency — Stripe](https://stripe.com/blog/idempotency)
- [Idempotency-Key HTTP header — IETF draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)
- [Making retries safe with idempotent APIs — AWS Builders' Library](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/)
- [HTTP idempotent methods — MDN](https://developer.mozilla.org/en-US/docs/Glossary/Idempotent)
