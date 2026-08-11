---
title: "Throttling"
sidebar_position: 13
supplementary: true
---

Throttling controls how much of a shared resource a system's own
internal work is allowed to consume, degrading the priority, fidelity,
or pace of that work under load rather than flatly rejecting a caller
the way a hard per-client quota does.

![Throttling diagram](/img/patterns/throttling.svg)

## Problem it solves

A system's total capacity has to be shared across everything competing
for it — foreground user requests, background batch jobs, async
processing queues, scheduled reports — and not all of that work is
equally urgent. Left uncontrolled, a burst of background work (a big
nightly export, a backlog of retried jobs, a spike in indexing tasks)
can consume enough of a shared resource — database connections, CPU,
I/O bandwidth — that foreground requests start missing their latency
budget, even though no single external client did anything wrong.
Throttling addresses this by continuously governing how much of a
shared resource a class of internal work is allowed to use, so that
lower-priority work slows down or does less before it ever gets the
chance to starve higher-priority work of the capacity it needs.

## How it works

[Rate limiting](/docs/patterns/building-blocks/rate-limiter) and
throttling are often used loosely as synonyms, but they operate at
different points in the system and produce different outcomes when
triggered:

- **Where the check happens.** A rate limiter is typically enforced at
  the edge, per external client — an API gateway checks "has this API
  key exceeded N requests this minute?" on each incoming request,
  independent of what's happening anywhere else in the system.
  Throttling is typically enforced against a *shared resource*,
  system-wide or per-tenant, based on aggregate consumption across many
  callers or internal processes at once — "is total database connection
  usage from background jobs above the threshold reserved for them
  right now?" is a question about the resource's current state, not
  about any one caller's historical request count.
- **What triggers it.** A rate limiter's decision is a counter check
  against a fixed quota, independent of how loaded the backend actually
  is at that instant — the same client is blocked at request #101
  whether the backend is idle or on fire. A throttle's decision is
  frequently tied to observed resource pressure (queue depth, CPU,
  connection pool saturation) rather than a fixed per-client count, so
  it activates precisely when the shared resource is actually under
  strain and relaxes when it isn't.
- **What happens when it triggers.** This is the mechanical crux of the
  distinction. A rate limiter's response to exceeding the quota is
  binary and externally visible: reject the request, typically with an
  HTTP `429`, and the caller knows it was blocked. Throttling's response
  is a *degradation*, usually invisible to any external caller: lower
  the priority of a background job so it yields CPU to foreground
  requests, reduce the batch size or frequency of an export job, delay
  a queue consumer's next poll, or drop response fidelity (serve a
  cached or lower-resolution result) — the work still happens, just
  slower, later, or in a cheaper form, and often nobody outside the
  system ever receives an error because of it.

Put mechanically: rate limiting asks "has *this specific client*
crossed *its* fixed line?" and answers with accept-or-reject. Throttling
asks "how much of *this shared resource* is under pressure right now?"
and answers by turning a dial on *how much or how fast* lower-priority
work is allowed to proceed — without necessarily telling anyone no.

## Code example

The snippet below models both mechanisms side by side against the same
resource-pressure reading, to make the "reject vs. degrade" difference
concrete rather than asserted.

```rust
struct ResourcePressure {
    // 0-100: how saturated the shared resource currently is.
    utilization_pct: u8,
}

// Rate limiting: fixed per-client quota, independent of resource state.
struct RateLimiter {
    quota_per_minute: u32,
}

impl RateLimiter {
    // Binary accept/reject based purely on this client's own count.
    fn check(&self, requests_this_minute: u32) -> Result<(), &'static str> {
        if requests_this_minute >= self.quota_per_minute {
            Err("429 Too Many Requests")
        } else {
            Ok(())
        }
    }
}

// Throttling: degrades background work based on live resource pressure.
struct Throttle {
    pressure_threshold_pct: u8,
}

impl Throttle {
    // No error returned to anyone — just a slower pace for this work.
    fn batch_size_for(&self, pressure: &ResourcePressure) -> u32 {
        if pressure.utilization_pct >= self.pressure_threshold_pct {
            10 // degraded: smaller batches, less load per cycle
        } else {
            500 // full speed: pressure is low
        }
    }
}
```

`RateLimiter::check` returns a hard reject once a fixed count is
crossed, regardless of how loaded the backend actually is. `Throttle::
batch_size_for` never rejects anything — it reads live pressure and
turns a dial on how much work proceeds, which is the mechanical
difference between the two patterns.

## When to use it

- Background or batch work (exports, reindexing, retries, async
  processing) needs to be prevented from starving latency-sensitive
  foreground requests that share the same backend resources.
- Resource pressure should be managed proactively and continuously
  (CPU, connection pools, I/O), rather than reactively rejecting
  individual callers once a fixed quota is crossed.
- Degrading gracefully — slower, later, or lower-fidelity — is
  acceptable or even preferable to returning an outright error to
  anyone.

## When not to use it

- The goal is a hard, predictable per-client ceiling with a clear
  accept/reject boundary — that's what a rate limiter is for, and
  building a bespoke degrade-under-pressure mechanism for it is
  unnecessary complexity.
- There's no meaningful priority difference between the work competing
  for the resource — throttling exists to protect *something* at the
  expense of *something else*, and without that asymmetry there's
  nothing to prioritize.

## Real-world example

A SaaS platform runs customer-facing API requests and internal nightly
data-export jobs against the same primary database. Under normal load,
export jobs run at full speed; when the database's connection pool
utilization crosses a threshold, the job scheduler throttles export
jobs — reducing their batch size and concurrency, or pausing them
briefly — until pool pressure subsides, without ever returning an error
to the customers making API requests at the same time.

## Related patterns

- [Rate Limiter](/docs/patterns/building-blocks/rate-limiter) — the
  closely related, but mechanically distinct, pattern of enforcing a
  hard per-client quota at the edge with an explicit reject once
  exceeded.

## Further reading

- [Throttling pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/throttling)
- [Rate limiting — Wikipedia](https://en.wikipedia.org/wiki/Rate_limiting)
