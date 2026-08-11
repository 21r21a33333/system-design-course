---
title: "Rate Limiter"
sidebar_position: 6
supplementary: true
---

A rate limiter restricts how many requests a client can make within a
given time window, protecting backend resources from being overloaded
by traffic spikes, runaway retries, or abuse.

![Rate Limiter diagram](/img/patterns/rate-limiter.svg)

## Problem it solves

Backend resources — databases, downstream APIs, expensive compute —
have a finite capacity. Without a limiter, a single misbehaving client
(a buggy retry loop, a scraper, or a malicious actor) can consume a
disproportionate share of that capacity and degrade service for every
other client. Rate limiting caps each client's consumption so no one
caller can starve the rest, and it gives the system a predictable way
to shed excess load — rejecting requests cheaply and early — instead of
accepting them and failing expensively later, deeper in the stack. It
is also the enforcement point for a commercial contract: a published
"1000 requests/minute on the Pro plan" quota is only real if something
counts requests and says no at 1001.

## Technical architecture & implementation

**Choosing the algorithm.** Four algorithms dominate, trading accuracy
against memory and CPU:

- **Token bucket.** A bucket holds up to `N` tokens and refills at a
  fixed rate; each request consumes one token, and requests are rejected
  when the bucket is empty. This naturally allows short bursts up to the
  bucket size while enforcing a steady average rate — the burst
  tolerance is often exactly what you want for bursty-but-legitimate
  clients. The **leaky bucket** is its dual: requests enter a queue that
  drains at a fixed rate, smoothing output into a perfectly even stream
  (good for protecting a downstream that hates bursts) at the cost of
  added latency for queued requests.
- **Fixed window counter.** Count requests per discrete window (e.g. per
  calendar minute), resetting to zero at each boundary. Cheap — one
  integer per key — but it allows up to 2× the intended rate at a window
  edge, since a burst at the end of one window plus a burst at the start
  of the next both count as "within limit."
- **Sliding window log.** Store the timestamp of every request in the
  trailing window and count them exactly. Precise and boundary-free, but
  memory grows with request volume, which is costly for high-traffic
  keys.
- **Sliding window counter.** Approximate the log by weighting the
  current and previous fixed-window counts by how far into the current
  window you are. It smooths away the fixed-window boundary burst using
  two integers per key instead of a full timestamp list — the usual
  production default.

**Per-key partitioning.** A limiter is meaningless without a key: it
enforces "N per window *per what*." Common keys are API key, user ID,
tenant ID, or source IP. IP-based keys are the fallback for
unauthenticated traffic but are blunt — an entire corporate NAT or
mobile carrier can share one IP, so a per-IP limit punishes innocent
neighbors (the [Noisy Neighbor](/docs/patterns/antipatterns/noisy-neighbor)
problem). Per-tenant limits usually pair a coarse plan-level quota with
finer per-endpoint sub-limits so one expensive endpoint can't consume
the whole allowance.

**Distributed enforcement.** Where the limiter lives is as important as
the algorithm. A **per-instance, in-memory** limiter is cheap and adds
no network hop, but each instance only sees its own slice of traffic —
a client spread across `M` instances behind a
[load balancer](/docs/patterns/api-edge/load-balancing) can exceed the
intended global limit by up to `M×`. A **centralized** limiter backed by
a shared store (commonly Redis, often via `INCR` with a TTL or a Lua
script for atomicity) gives every instance a consistent view, at the
cost of a round trip per check and a store that must stay fast and
available. The middle ground is **approximate distributed** limiting:
instances keep local counters and periodically reconcile, tolerating
small overshoot in exchange for no per-request coordination.

**The response.** When a request is rejected, the conventional signal
is HTTP `429 Too Many Requests` with a `Retry-After` header telling the
client exactly how long to back off — which, if clients honor it,
prevents the rejection itself from triggering a
[retry storm](/docs/patterns/antipatterns/retry-storm). Well-behaved
APIs also surface remaining quota on *successful* responses (e.g.
`X-RateLimit-Remaining`) so clients can self-pace before hitting the
wall.

**Failure modes.** A centralized store outage forces a fail-open
(admit everything, losing protection) vs. fail-closed (reject
everything, causing a self-inflicted outage) choice — most systems
fail open on the limiter but keep a coarse local backstop. Clock skew
across instances corrupts window boundaries. And a limiter placed too
deep in the stack defeats its own purpose: rejecting a request after
it has already consumed a database connection saves nothing, which is
why limiters belong at the **edge or gateway**, before expensive work
begins.

**Differentiation from siblings.** A rate limiter enforces a *fixed
per-client quota* and answers accept-or-reject regardless of how loaded
the backend is right now — client C is blocked at request 101 whether
the server is idle or on fire. That is deliberately distinct from
[Throttling](/docs/patterns/building-blocks/throttling), which reads
*live resource pressure* and *degrades* work (smaller batches, lower
priority) rather than rejecting a named caller, and from load shedding,
which drops a fraction of *all* traffic to keep the system alive under
overload rather than enforcing any per-client agreement.

## Algorithms compared

| Algorithm | State per key | Burst behavior | Boundary accuracy | Typical use |
| --- | --- | --- | --- | --- |
| Token bucket | tokens + timestamp | allows bursts up to bucket size | exact | bursty-but-legit clients |
| Leaky bucket | queue + drain clock | smooths to constant output | exact | protecting burst-averse downstreams |
| Fixed window | one counter | up to 2× at window edge | poor | cheap, coarse limits |
| Sliding window log | list of timestamps | exact | exact | low-volume, precision-critical |
| Sliding window counter | two counters | smoothed | good (approx) | high-volume production default |

## Code example

A token bucket with lazy refill: rather than a background timer, it
reconstructs the current token level from elapsed time on each check.
`try_acquire` returns the `Retry-After` duration on rejection — the
exact value a server hands back in the header.

```rust
use std::time::{Duration, Instant};

/// A token-bucket rate limiter. Tokens refill continuously at `refill_per_sec`
/// up to `capacity`; each admitted request consumes one token. Bursts up to
/// `capacity` are allowed, while the long-run average is capped at the refill
/// rate.
pub struct TokenBucket {
    capacity: f64,
    refill_per_sec: f64,
    tokens: f64,
    last_refill: Instant,
}

impl TokenBucket {
    pub fn new(capacity: f64, refill_per_sec: f64) -> Self {
        TokenBucket {
            capacity,
            refill_per_sec,
            tokens: capacity, // start full
            last_refill: Instant::now(),
        }
    }

    // Add tokens accrued since the last check, based on elapsed wall time.
    // Lazy refill: no background timer needed, we reconstruct the level on
    // demand from how long it has been.
    fn refill(&mut self, now: Instant) {
        let elapsed = now.duration_since(self.last_refill).as_secs_f64();
        if elapsed > 0.0 {
            self.tokens = (self.tokens + elapsed * self.refill_per_sec).min(self.capacity);
            self.last_refill = now;
        }
    }

    /// Try to admit one request. Returns Ok on success, or Err with the
    /// Duration a caller should wait before a token will be available — the
    /// value a server would surface as an HTTP `Retry-After` header.
    pub fn try_acquire(&mut self, now: Instant) -> Result<(), Duration> {
        self.refill(now);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            Ok(())
        } else {
            let deficit = 1.0 - self.tokens;
            let wait = deficit / self.refill_per_sec;
            Err(Duration::from_secs_f64(wait))
        }
    }
}

fn main() {
    // 5-token bucket refilling at 1 token/sec.
    let mut bucket = TokenBucket::new(5.0, 1.0);
    let start = Instant::now();

    // Burst: the first 5 requests drain the full bucket.
    for i in 1..=5 {
        assert!(bucket.try_acquire(start).is_ok(), "burst request {i} should pass");
    }
    // 6th request in the same instant is rejected, with a ~1s Retry-After.
    match bucket.try_acquire(start) {
        Ok(()) => panic!("bucket should be empty"),
        Err(wait) => println!("rejected; retry after {:.2}s", wait.as_secs_f64()),
    }
    // 3 seconds later, 3 tokens have refilled: 3 more requests pass.
    let later = start + Duration::from_secs(3);
    for _ in 0..3 {
        assert!(bucket.try_acquire(later).is_ok());
    }
    assert!(bucket.try_acquire(later).is_err(), "only 3 tokens refilled");
}
```

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
  share of it — capacity planning,
  [auto-scaling](/docs/patterns/scaling/auto-scaling), or load shedding
  address that; rate limiting only protects against unfair or excessive
  per-client usage.
- You need to protect the system *from itself* by pacing background work
  against live pressure — that's
  [throttling](/docs/patterns/building-blocks/throttling), not a
  per-client quota.

## Use-case scenarios

**Public API with paid tiers.** A payments API caps each account by its
plan — say 100 requests/second on Standard, 1000 on Enterprise — keyed
on the API token. A per-token token bucket at the gateway allows brief
bursts for checkout spikes while holding the sustained average to the
contracted rate; over-limit calls get `429` with `Retry-After` plus
`X-RateLimit-Remaining` on successes so integrators can self-pace.

**Login and abuse protection.** An auth service limits password attempts
to a handful per account per minute and a larger ceiling per source IP,
keyed on both. The tight per-account limit blunts credential-stuffing
without a full IP block that would lock out an entire office behind one
NAT; a sliding-window counter avoids the fixed-window edge that an
attacker could exploit by timing bursts across the boundary.

**Protecting a fragile downstream.** An internal service calls a
third-party provider that itself allows only 50 requests/second. A
leaky-bucket limiter in front of that dependency drains calls at a
constant 50/s regardless of how bursty upstream demand is, smoothing the
outbound stream so the provider never returns its own `429` — trading a
little queuing latency for a downstream that stays happy.

## Production libraries & getting started

Reach for a per-language limiter for in-process quotas; back it with Redis (or enforce at the gateway) when the limit must be shared across many instances.

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| express-rate-limit / rate-limiter-flexible | JS/TS | Middleware token-bucket/window limiters; `rate-limiter-flexible` adds Redis/Mongo backends and GCRA | [express-rate-limit](https://www.npmjs.com/package/express-rate-limit) (browser-live) · [rate-limiter-flexible](https://www.npmjs.com/package/rate-limiter-flexible) (browser-live) |
| governor | Rust | GCRA-based limiter, keyed and in-memory or distributed | [governor docs](https://docs.rs/governor/latest/governor/) |
| `golang.org/x/time/rate` / uber-go/ratelimit | Go | Standard token-bucket limiter; uber's leaky-bucket limiter | [x/time/rate](https://pkg.go.dev/golang.org/x/time/rate) · [uber-go/ratelimit](https://github.com/uber-go/ratelimit) |
| SlowAPI / limits | Python | ASGI/Starlette-friendly limiter; `limits` provides storage-backed strategies | [SlowAPI](https://slowapi.readthedocs.io/en/latest/) · [limits](https://limits.readthedocs.io/en/stable/) |
| redis-cell | Any (Redis) | GCRA rate limiting as a native Redis module (`CL.THROTTLE`) | [redis-cell](https://github.com/brandur/redis-cell) |

For a shared or edge-enforced limit, apply it at the proxy/gateway layer:

| System | What it gives you | Getting started |
| --- | --- | --- |
| Envoy global rate limiting | Centralized rate limits across a fleet via the rate-limit service | [Envoy global rate limiting](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/other_features/global_rate_limiting) |

## Related patterns

- [API Gateway](/docs/patterns/api-edge/api-gateway) — the gateway is
  the typical place a centralized rate limiter is enforced, since it
  already sits in front of every request to the backend.
- [Throttling](/docs/patterns/building-blocks/throttling) — the closely
  related but distinct pattern of protecting a shared resource by
  degrading work under live pressure, rather than rejecting a named
  client against a fixed quota.
- [Load Balancing](/docs/patterns/api-edge/load-balancing) — spreads a
  client across many instances, which is exactly what makes a
  per-instance in-memory limiter under-count and motivates a shared
  counter store.
- [Retry Storm](/docs/patterns/antipatterns/retry-storm) — the failure
  mode a limiter both mitigates (by shedding early) and can worsen (if
  rejected clients ignore `Retry-After` and hammer harder).

## Further reading

- [Rate limiting — Wikipedia](https://en.wikipedia.org/wiki/Rate_limiting)
- [Rate Limiting pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/rate-limiting-pattern)
- [How we built rate limiting capable of scaling to millions of domains — Cloudflare](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/)
- [Stripe rate limiters — Stripe Engineering blog](https://stripe.com/blog/rate-limiters)
- [Token bucket — Wikipedia](https://en.wikipedia.org/wiki/Token_bucket)
