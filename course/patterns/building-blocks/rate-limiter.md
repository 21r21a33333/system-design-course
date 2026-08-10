---
title: "Rate Limiter"
sidebar_position: 6
supplementary: true
---

A rate limiter restricts how many requests a client can make within a
given time window, protecting backend resources from being overloaded
by traffic spikes, runaway retries, or abuse.

## Problem it solves

Backend resources — databases, downstream APIs, expensive compute —
have a finite capacity. Without a limiter, a single misbehaving client
(a buggy retry loop, a scraper, or a malicious actor) can consume a
disproportionate share of that capacity and degrade service for every
other client. Rate limiting caps each client's consumption so no one
caller can starve the rest, and it gives the system a predictable way
to shed excess load — rejecting requests cheaply and early — instead of
accepting them and failing expensively later, deeper in the stack.

## How it works

A few algorithms are commonly used, each with different tradeoffs
between accuracy and memory cost:

- **Token bucket.** A bucket holds up to `N` tokens and refills at a
  fixed rate; each request consumes one token, and requests are
  rejected when the bucket is empty. This naturally allows short bursts
  up to the bucket size while enforcing a steady average rate.
- **Fixed window counter.** Count requests in discrete windows (e.g.
  per calendar minute), resetting to zero at each window boundary.
  Simple and cheap, but it allows up to 2x the intended rate right at a
  window boundary (a burst at the end of one window plus a burst at the
  start of the next).
- **Sliding window (log or counter).** A sliding window log tracks the
  timestamp of every request in the trailing window and counts them
  precisely, at the cost of memory proportional to request volume; a
  sliding window counter approximates this by weighting the current and
  previous fixed windows, giving smoother behavior than a fixed window
  with far less memory than a full log.

Where the limiter lives matters as much as which algorithm it uses. A
per-instance, in-memory limiter is cheap and adds no extra network
hop, but each instance only sees its own slice of traffic — a client
distributed across many instances (or hitting the fleet through a load
balancer) can exceed the intended global limit by a factor of the
instance count. A centralized limiter, typically backed by a shared
store like Redis, gives every instance a consistent view of a client's
current usage, at the cost of a network round trip per check and the
limiter store itself becoming a dependency that has to stay available
and fast.

## When to use it

- Protecting a shared backend resource (database, downstream API, quota-
  limited third-party service) from being overwhelmed by any single
  caller.
- Exposing a public or partner-facing API where usage needs to be
  capped per API key, user, or IP.
- Enforcing pricing tiers or fairness across tenants in a multi-tenant
  system.

## When not to use it

- Internal, trusted, low-volume traffic where overload risk is
  negligible — the added latency and complexity aren't justified.
- The real bottleneck is total system capacity, not any one client's
  share of it — capacity planning or autoscaling addresses that,
  rate limiting only protects against unfair or excessive per-client
  usage.

## Real-world example

Stripe's API returns an HTTP `429 Too Many Requests` status with a
`Retry-After` header when a client exceeds its rate limit, signaling
exactly how long to wait before retrying — a pattern common across most
major API providers.

## Related patterns

- [API Gateway](/docs/patterns/api-edge/api-gateway) — the gateway is
  the typical place a centralized rate limiter is enforced, since it
  already sits in front of every request to the backend.

## Further reading

- [Rate limiting — Wikipedia](https://en.wikipedia.org/wiki/Rate_limiting)
- [Rate Limiting pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/rate-limiting-pattern)
