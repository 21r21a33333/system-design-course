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

## Technical architecture & implementation

**Throttling vs. rate limiting.**
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

**Admission control and QoS tiers.** The dial throttling turns is
usually driven by an **admission-control** decision: before a unit of
work is allowed to start, the throttle checks whether the shared
resource has headroom for it *given its priority*. Work is classified
into **quality-of-service tiers** — interactive foreground requests
above async processing above best-effort batch — and the throttle
admits, delays, or degrades each tier against a different pressure
threshold. Foreground work might be admitted until the connection pool
is 95% full; batch export might start shedding at 60%, so it yields
headroom *before* foreground work is ever at risk. This is what lets a
system stay responsive to users while quietly slowing everything else.

**Signals that drive the dial.** A throttle is only as good as the
pressure signal it reads. Common signals are connection-pool
saturation, CPU load, request queue depth, and downstream latency or
error rate. Queue depth is often the most direct: a growing queue *is*
the definition of arrivals outpacing service, and is the same signal
[backpressure](/docs/patterns/batch-streaming/backpressure) and
[queue-based load leveling](/docs/patterns/batch-streaming/queue-based-load-leveling)
act on. Signals should be smoothed (e.g. an exponential moving average)
and paired with hysteresis — a higher threshold to *start* throttling
than to *stop* — so the dial doesn't oscillate rapidly around a single
tipping point.

**Backpressure as the propagation mechanism.** Throttling one stage
only helps if the slowdown propagates upstream rather than piling work
in a queue between stages. **Backpressure** is that propagation: a
throttled consumer stops pulling, which fills its input buffer, which
signals the producer to slow down, all the way back to the source.
Without backpressure, throttling a downstream stage just moves the
overload into an unbounded in-memory queue that eventually exhausts
memory — so throttling and
[backpressure](/docs/patterns/batch-streaming/backpressure) are almost
always deployed together.

**Failure modes.** A throttle that reads a *stale* pressure signal
reacts too late — admitting work into a resource that's already
saturated. Too-aggressive throttling starves lower-priority work
indefinitely (a batch job that never runs because foreground load never
fully subsides), so throttles usually guarantee some minimum floor of
progress. And a throttle with no hysteresis flaps between full-speed and
degraded, producing sawtooth load that's worse than either steady
state. Finally, throttling shapes *your own* work — it does nothing
against an external client flooding the edge; that's the
[rate limiter's](/docs/patterns/building-blocks/rate-limiter) job, and
the two protect different boundaries.

**Differentiation from siblings.** Beyond rate limiting, throttling sits
near several load-management patterns.
[Queue-based load leveling](/docs/patterns/batch-streaming/queue-based-load-leveling)
absorbs bursts into a buffer so a downstream sees a smooth arrival rate;
throttling is what *drains* that buffer at a pace the resource can
sustain. A [priority queue](/docs/patterns/batch-streaming/priority-queue)
orders *which* buffered work runs next; throttling governs *how much*
runs at all. And load shedding *drops* excess work outright under
extreme overload, where throttling merely *slows* it — throttling is the
graduated response, shedding the last resort when even the slowest pace
is too much.

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

## Use-case scenarios

**Nightly exports vs. live API traffic.** A SaaS platform runs
customer-facing API requests and internal nightly data-export jobs
against the same primary database. Under normal load, export jobs run at
full speed; when the connection pool crosses a pressure threshold, the
scheduler throttles exports — reducing batch size and concurrency, or
pausing them briefly — until pool pressure subsides, without ever
returning an error to the customers making API requests at the same
time. The export finishes later, but the users never notice a thing.

**Tiered async processing under a spike.** A media platform transcodes
uploads through a worker pool shared by two tiers: interactive
"processing your upload now" jobs and bulk re-encode jobs for an old
catalog. When queue depth climbs, the admission controller keeps
admitting interactive jobs but throttles bulk re-encodes down to a
trickle — they still make progress on a guaranteed floor of workers, but
yield the bulk of capacity to the tier a user is actively waiting on. As
the queue drains past the lower hysteresis threshold, bulk work ramps
back up.

**Downstream-aware outbound throttling.** A service calls an internal
dependency and watches its latency and error rate as the pressure
signal. When the dependency's p99 latency climbs — a sign it's near
saturation — the caller throttles its own outbound concurrency, slowing
the rate it issues calls rather than piling on and pushing the
dependency into collapse. Paired with a
[circuit breaker](/docs/patterns/reliability/circuit-breaker) for the
hard-failure case, this graduated slowdown keeps a strained dependency
usable instead of tipping it over.

## Production libraries & getting started

Throttling usually comes bundled in a resilience library (alongside bulkhead, retry, and circuit-breaker) or is enforced at the API gateway; where a plain quota is enough, reuse the [rate-limiter](/docs/patterns/building-blocks/rate-limiter) libraries.

Resilience libraries (rate-limiter + bulkhead modules):

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| resilience4j | Java | Canonical resilience toolkit: RateLimiter, Bulkhead, TimeLimiter, CircuitBreaker | [resilience4j getting started](https://resilience4j.readme.io/docs/getting-started) |
| Polly | .NET | Rate-limit, bulkhead-isolation, timeout, and circuit-breaker strategies | [Polly docs](https://www.pollydocs.org/) |
| Failsafe | Java | Composable rate limiter, bulkhead, and other resilience policies | [Failsafe](https://failsafe.dev/) |

Gateway / infrastructure-level throttling:

| System | What it gives you | Getting started |
| --- | --- | --- |
| Kong | Rate-limiting/throttling plugin at the API gateway | [Kong rate limiting](https://docs.konghq.com/hub/kong-inc/rate-limiting/) |
| Envoy | Global rate limiting across a service fleet | [Envoy global rate limiting](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/other_features/global_rate_limiting) |
| AWS API Gateway | Usage plans with request throttling and burst limits | [API Gateway request throttling](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-request-throttling.html) |

## Related patterns

- [Rate Limiter](/docs/patterns/building-blocks/rate-limiter) — the
  closely related, but mechanically distinct, pattern of enforcing a
  hard per-client quota at the edge with an explicit reject once
  exceeded; throttling protects a shared resource by degrading work
  under live pressure instead.
- [Backpressure](/docs/patterns/batch-streaming/backpressure) — the
  mechanism that propagates a throttled stage's slowdown upstream so
  overload doesn't just accumulate in an unbounded queue.
- [Queue-Based Load Leveling](/docs/patterns/batch-streaming/queue-based-load-leveling) —
  absorbs bursts into a buffer that throttling then drains at a
  sustainable pace.
- [Priority Queue](/docs/patterns/batch-streaming/priority-queue) —
  orders which buffered work runs next, complementing throttling's
  control over how much runs at all.
- [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) — the
  hard-failure counterpart: where throttling slows a strained
  dependency, a breaker stops calling a failing one outright.

## Further reading

- [Throttling pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/throttling)
- [Rate limiting — Wikipedia](https://en.wikipedia.org/wiki/Rate_limiting)
- [Using load shedding to avoid overload — Amazon Builders' Library](https://aws.amazon.com/builders-library/using-load-shedding-to-avoid-overload/)
- [Handling overload — Google SRE Book, Ch. 21](https://sre.google/sre-book/handling-overload/)
