---
title: "Retry with Backoff"
sidebar_position: 2
supplementary: true
---

Retry with backoff re-attempts a failed call after a delay that grows
exponentially with each subsequent failure — typically with random
jitter added — instead of retrying immediately or at a fixed interval.

## Problem it solves

Transient failures — a dropped packet, a momentary network blip, a
dependency briefly overloaded — are often gone a moment later, so simply
giving up on the first failure wastes a good chance of success. But
naive immediate retry is dangerous: if a dependency is struggling
because it's overloaded, every caller retrying instantly adds more load
on top of the load that caused the failure in the first place. If many
callers all fail at once (for example, right after the dependency
recovers from an outage and everyone reconnects simultaneously), they
also all retry at once, hitting it with a synchronized burst — a
"retry storm" — that can re-trigger the very overload the retries were
meant to recover from, or turn a brief blip into an extended outage.

## How it works

After a failed call, the caller waits before retrying, and that wait
grows with each successive failure — commonly doubling each time (100ms,
200ms, 400ms, 800ms...) up to a capped maximum, and often bounded by a
maximum number of attempts. Jitter — randomizing the delay within a
range rather than using the exact computed value — is added specifically
to prevent many callers who failed at the same moment from retrying in
lockstep and re-synchronizing into another burst.

Retrying is only safe for operations that are actually retryable in the
first place. Crucially, only idempotent operations should be retried
automatically — if a request already succeeded on the server but the
response was lost before the caller saw it, retrying a non-idempotent
operation like "charge $50" or "increment inventory by 1" can duplicate
the effect. Reads and operations designed to be idempotent (see
[Idempotency](/docs/patterns/reliability/idempotency)) are safe to retry
blindly; anything else needs either an idempotency mechanism or a
decision to not auto-retry at all.

## When to use it

- The failure is plausibly transient — network errors, timeouts,
  HTTP 429/503 responses — rather than a permanent rejection like a
  validation error or 404.
- The operation being retried is idempotent, or is made safe to retry
  via an idempotency key.
- The caller can afford the added latency of the retry attempts within
  its own timeout budget.

## When not to use it

- The operation isn't idempotent and has no deduplication mechanism —
  retrying risks duplicating side effects (double charges, duplicate
  emails).
- The failure is deterministic (bad request, auth failure) — retrying
  an error that will never succeed just adds latency and load for no
  benefit.
- The caller is already near its own timeout or SLA budget — retries
  consume time that might be better spent failing fast and letting the
  caller's caller decide what to do.

## Real-world example

The AWS SDKs (and most cloud provider SDKs) implement exponential
backoff with jitter as a built-in default retry policy for throttling
and transient network errors, precisely because a large number of
clients hammering a service with synchronized fixed-interval retries is
a well-documented cause of prolonged outages.

## Related patterns

- [Timeout](/docs/patterns/reliability/timeout) — a retry attempt only makes sense after a bounded failure, which timeouts provide.
- [Idempotency](/docs/patterns/reliability/idempotency) — what makes an operation safe to retry without duplicating effects.

## Further reading

- [Exponential backoff — Wikipedia](https://en.wikipedia.org/wiki/Exponential_backoff)
- [Retry behavior — AWS SDKs and Tools Reference Guide](https://docs.aws.amazon.com/general/latest/gr/api-retries.html)
