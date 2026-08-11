---
title: "Timeout"
sidebar_position: 1
supplementary: true
---

A timeout bounds how long a caller will wait for a dependency to respond
before giving up and treating the call as failed, rather than waiting
indefinitely for a reply that may never come.

![Timeout diagram](/img/patterns/timeout.svg)

## Problem it solves

Without a timeout, a caller blocked on a slow or hung dependency holds
onto whatever resource it used to make that call — a thread, a database
connection, a socket — for as long as the dependency takes to respond,
which in a failure scenario can be forever. As concurrent requests pile
up waiting on the same struggling dependency, the caller exhausts its own
thread pool or connection pool. New requests then queue behind the
exhausted pool, and the caller itself becomes slow or unresponsive to
*its* callers. A single slow dependency several hops downstream can
cascade into an outage across the whole call chain, even though every
individual service is technically "up." A timeout is the mechanism that
converts an unbounded hang into a bounded, predictable failure the caller
can actually act on.

## Technical architecture & implementation

**What a timeout actually bounds.** A timeout is a maximum duration
attached to a single operation — a network request, a database query, a
lock acquisition. When it fires, the caller stops waiting and returns
control to its own logic, typically raising or returning an error. The
essential property is not that the call succeeds faster but that *failure*
becomes fast and predictable: resource holding time is capped, so the
thread or connection is released back to the pool instead of being pinned
indefinitely.

**Layered timeouts — connect vs. read vs. overall.** A single number is
rarely enough. A **connect timeout** bounds establishing the connection
(TCP handshake, TLS negotiation) and is usually short, because a
connection that won't establish quickly probably won't establish at all.
A **read/response timeout** bounds waiting for bytes once connected and is
typically longer, since it covers the dependency actually doing work. On
top of both sits an **overall (request) deadline** — the total wall-clock
budget for the operation end to end, including any retries. Setting only a
per-attempt read timeout while leaving the overall deadline unbounded is a
common bug: three retries of a 5-second read timeout can quietly consume
15 seconds against a caller that expected a 2-second response.

**Setting the value from latency percentiles.** A timeout chosen by
guesswork is either so long it never prevents pool exhaustion or so short
it trips on normal, healthy latency and manufactures failures. The right
basis is the dependency's observed latency distribution: set the timeout
a margin above the **p99** (or p99.9 for critical paths), not the mean. If
a service's p99 is 300 ms, a 500 ms–1 s timeout gives headroom for normal
variance while still failing fast well before it could exhaust an upstream
pool. Timeouts should be reviewed as latency drifts — a value set against
last year's p99 slowly becomes either too tight or too loose.

**Deadline propagation.** In a call chain, a *fresh* timeout at every hop
is wrong: it lets total latency balloon far past what the original caller
budgeted. The correct model is a single **deadline** — an absolute
expiry time — that travels with the request (e.g. a `grpc-timeout` header
or a context deadline) and shrinks as time is consumed. Each downstream
hop is bounded by whatever budget actually remains, so a slow early hop
automatically tightens the ceiling on everything after it. See the
[deadline propagation](#deadline-propagation) walkthrough below.

**Cancellation.** Firing a timeout should ideally *cancel* the underlying
work, not just stop waiting for it. If the caller abandons the wait but
the downstream request keeps running, the dependency is still doing (now
useless) work — wasted load that can deepen an overload. Proper
cancellation propagates the abort downstream so abandoned work is actually
stopped.

**Failure modes.** A timeout set **too short** trips under ordinary load
variance, converting healthy-but-slow calls into hard failures — often
worse than no timeout if it isn't paired with sensible retry. A timeout
set **too long** barely bounds anything, letting resources stay pinned
long enough to still cause exhaustion. Timeouts also interact sharply with
retries: a short timeout plus aggressive retry can multiply load on an
already-struggling dependency, which is exactly the
[retry storm](/docs/patterns/antipatterns/retry-storm) antipattern.

**Where it sits among siblings.** A timeout is the foundational layer the
other reliability patterns build on. [Retry with
Backoff](/docs/patterns/reliability/retry-with-backoff) is *what a caller
does after* a timeout fires; a retry only makes sense because the timeout
bounded the failure quickly enough to act on. A [Circuit
Breaker](/docs/patterns/reliability/circuit-breaker) *stops calling
altogether* once timeouts and errors cross a threshold — it protects the
caller from continuing to pay the timeout cost on a dependency that is
clearly down. A [Bulkhead](/docs/patterns/reliability/bulkhead) *isolates
the resources* a call draws from, so even calls that do time out only
exhaust their own compartment. Unlike
[Failover](/docs/patterns/reliability/failover), a timeout does nothing to
replace the failing dependency — it only bounds the caller's exposure to
it.

## Deadline propagation

Consider a gateway with a 1000 ms budget calling Service A, which calls
Service B, which calls Service C. With per-hop timeouts set independently
(say 800 ms each), the chain could run for well over a second before
anything gives up. With a *propagated deadline*, the budget is shared and
shrinks:

- Gateway starts a 1000 ms deadline and calls A. A spends 300 ms of work,
  then calls B — passing along the deadline, of which **700 ms** remains.
- B spends 500 ms, then calls C with **200 ms** left.
- C's own work needs 400 ms. It is bounded by the 200 ms that actually
  remains, not a fresh 800 ms local timeout, so it times out honestly
  against the request-level budget instead of overrunning it.

The rule: every hop passes down the *remaining* budget, and each call is
capped at `min(local_limit, remaining_budget)`. The code example below
implements exactly this shrinking-budget model with an injectable clock.

## Code example

A `Deadline` is an absolute point on a monotonic clock, propagated down a
call chain. Each hop is bounded by the smaller of its own per-hop limit
and the budget that actually remains, so a slow early hop tightens the
ceiling on everything after it. The clock is injected as a plain
`Duration` so the transitions are fully deterministic under test.

```rust
use std::time::Duration;

// A deadline is an absolute point on a monotonic clock, not a per-call
// duration. Propagating the deadline (rather than a fresh timeout at each
// hop) is what makes the remaining budget shrink correctly down a call
// chain: every downstream call inherits only the time actually left.
#[derive(Clone, Copy, Debug)]
pub struct Deadline {
    at: Duration, // absolute monotonic instant the overall request expires
}

#[derive(Debug, PartialEq)]
pub enum CallError {
    DeadlineExceededBeforeStart, // no budget remained before the call began
    TimedOut,                    // the call ran past the remaining budget
}

impl Deadline {
    // Create a deadline `budget` from now (the current monotonic time).
    pub fn after(now: Duration, budget: Duration) -> Self {
        Deadline { at: now.saturating_add(budget) }
    }

    // Time left before the deadline at the given `now`. Zero once expired.
    pub fn remaining(&self, now: Duration) -> Duration {
        self.at.saturating_sub(now)
    }

    // Run one hop under this deadline. The call is only permitted the
    // smaller of its own per-hop limit and the remaining shared budget.
    // Returns the time after the hop.
    pub fn call(
        &self,
        now: Duration,
        per_hop_limit: Duration,
        elapsed: Duration,
    ) -> Result<Duration, CallError> {
        let remaining = self.remaining(now);
        if remaining.is_zero() {
            return Err(CallError::DeadlineExceededBeforeStart);
        }
        // The effective timeout is bounded by the overall deadline, so a
        // generous per-hop limit can never overrun the request budget.
        let effective = per_hop_limit.min(remaining);
        match elapsed <= effective {
            true => Ok(now.saturating_add(elapsed)),
            false => Err(CallError::TimedOut),
        }
    }
}
```

The core invariant: across a three-hop chain, hop C fails not because its
own 800 ms limit was exceeded but because the *shared* 200 ms budget was —
the deadline propagates and shrinks correctly, keeping the chain from
overrunning.

## When to use it

- On every call to a remote dependency — network, database, downstream
  service, external API — with no exceptions, since any of these can hang.
- Anywhere a shared, finite resource (thread, connection, lock) is held
  for the duration of the call.
- As the foundational layer beneath retry, circuit-breaker, and bulkhead
  logic, all of which depend on calls failing fast enough to act on.

## When not to use it

- Not "don't use a timeout" — remote calls essentially always need one —
  but a timeout so aggressive it fires under normal load variance just
  converts transient slowness into outright failures, which is worse than
  a well-chosen value if it isn't paired with sensible retry.
- A timeout is not a substitute for addressing an underlying slow
  dependency; it bounds the caller's blast radius, not the root cause.
- For purely local, in-process, non-blocking computation there is nothing
  to hang on, so a timeout adds machinery without protecting anything.

## Use-case scenarios

**HTTP client to a third-party API.** A checkout service calls an external
tax-calculation API on every order. The client is configured with a 1 s
connect timeout and a 2 s read timeout, chosen from the vendor's published
p99 of ~700 ms. When the vendor has a bad minute, calls fail in 2 s
instead of hanging until the socket dies, the checkout thread is released,
and a fallback (a cached tax estimate) is used — so a vendor blip degrades
one field rather than freezing checkout.

**Database query guardrail.** A reporting service runs ad-hoc queries that
occasionally hit a pathological plan and run for minutes, pinning a
connection from a small pool. A statement timeout caps any single query at
5 s; a query that exceeds it is aborted, the connection returns to the
pool, and the request fails cleanly rather than starving every other
request of connections.

**gRPC call chain with a propagated deadline.** A mobile API gateway sets
a 1.2 s deadline on an incoming request and passes it through every
downstream gRPC hop via the standard deadline header. A slow
authentication hop that eats 900 ms automatically leaves the profile and
recommendations hops only 300 ms — they fail fast against the shrunken
budget instead of letting the user wait four seconds for a response the
client already gave up on.

## Related patterns

- [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff) —
  what a caller does *after* a timeout fires; a retry is only meaningful
  because the timeout bounded the failure quickly enough to react.
- [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) — stops
  calling a dependency altogether once its timeouts and errors cross a
  threshold, so the caller stops paying the timeout cost on a dead dep.
- [Bulkhead](/docs/patterns/reliability/bulkhead) — isolates the resource
  pool a call draws from, so even calls that time out only exhaust their
  own compartment rather than the whole service.
- [Failover](/docs/patterns/reliability/failover) — replaces a failed
  dependency with a standby, whereas a timeout only bounds the caller's
  exposure to the failure without fixing or replacing it.
- [Retry Storm](/docs/patterns/antipatterns/retry-storm) — the antipattern
  a too-short timeout combined with aggressive retry can trigger.

## Further reading

- [Timeout (computing) — Wikipedia](https://en.wikipedia.org/wiki/Timeout_(computing))
- [Timeouts, retries, and backoff with jitter — Amazon Builders' Library](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)
- [Addressing cascading failures — Google SRE Book](https://sre.google/sre-book/addressing-cascading-failures/)
- [Reliable microservices data exchange / gRPC deadlines — grpc.io blog](https://grpc.io/blog/deadlines/)
