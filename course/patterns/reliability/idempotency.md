---
title: "Idempotency"
sidebar_position: 3
supplementary: true
---

An idempotent operation produces the same result and the same
observable effect no matter how many times it is applied — calling it
once or calling it five times leaves the system in the same state as
calling it exactly once.

## Problem it solves

Networks are unreliable in a specific, annoying way: a client can fail
to receive a response even when the server successfully processed the
request. From the client's point of view, a timed-out "charge card"
call is indistinguishable from one that silently succeeded. If the
client's only recourse is to retry, and the operation isn't idempotent,
that retry risks applying the effect twice — charging the customer
twice, sending a duplicate notification, incrementing a counter an
extra time. Idempotency is what makes it safe to retry a request
without knowing whether the original attempt actually succeeded.

## How it works

Some operations are naturally idempotent: setting a field to a fixed
value (`status = "shipped"`), or a `DELETE` on a resource that's already
gone, produce the same end state regardless of repetition. HTTP's own
semantics reflect this — `GET`, `PUT`, and `DELETE` are specified as
idempotent, while `POST` is not, precisely because `POST` typically
means "create a new thing" or "apply a delta," where repeating it
creates a second thing or applies the delta twice.

For operations that are inherently non-idempotent by nature — like
"charge this card" or "place this order" — idempotency is added
explicitly via an idempotency key: the client generates a unique
identifier (a UUID, typically) for a given logical operation and sends
it along with the request. The server records which keys it has already
processed and, on seeing a repeated key, returns the stored result of
the original attempt instead of re-executing the operation. This turns
"retry the request" and "the request definitely happens once" into
compatible goals — the client can retry freely, and the server
deduplicates by key rather than by trusting that the client only sends
each logical request once.

## When to use it

- Any operation that a client might legitimately retry — which, given
  network unreliability, is effectively every write operation exposed
  over a network.
- Payment, order-creation, and other operations where a duplicate
  execution has a real financial or user-facing cost.
- Combined with [retry with backoff](/docs/patterns/reliability/retry-with-backoff), so retries are safe by construction
  rather than by hoping failures never actually reached the server.

## When not to use it

- Pure read operations, which are naturally idempotent already and need
  no extra mechanism.
- Operations where deduplication state itself is expensive to maintain
  indefinitely — most implementations expire idempotency keys after a
  bounded window (e.g. 24 hours), which is a reasonable tradeoff since
  clients don't retry indefinitely either.

## Real-world example

Stripe's API accepts an `Idempotency-Key` header on POST requests: if a
client sends the same key twice — for instance because the first
response was lost to a network timeout — Stripe returns the result of
the original request instead of creating a second charge. This is
Stripe's documented, public mechanism for making payment creation safe
to retry.

## Related patterns

- [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff) — the retry strategy that idempotency makes safe to use on writes.

## Further reading

- [Idempotence — Wikipedia](https://en.wikipedia.org/wiki/Idempotence)
- [HTTP — Wikipedia](https://en.wikipedia.org/wiki/HTTP)
