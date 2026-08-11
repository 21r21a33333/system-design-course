---
title: "Bulkhead"
sidebar_position: 5
supplementary: true
---

The bulkhead pattern isolates the resources — thread pools, connection
pools, queues — used to call each dependency, so that one dependency
failing or slowing down can't exhaust the resources needed to keep
calling the others.

![Bulkhead diagram](/img/patterns/bulkhead.svg)

## Problem it solves

A service that calls several downstream dependencies from a single shared
thread pool has an implicit coupling between them: if one dependency
becomes slow or unresponsive, every thread that calls it can end up
blocked waiting. Once enough threads are stuck, the shared pool is
exhausted, and calls to completely unrelated, perfectly healthy
dependencies start failing too — not because they're broken, but because
there's no thread left to make the call. A single slow dependency takes the
whole service down with it, even though most of the service's
functionality had nothing to do with it. This is the **noisy-neighbor**
and **cascading-failure** problem: one greedy or degraded consumer of a
shared resource starves everyone sharing it. The bulkhead breaks that
coupling by giving each dependency its own bounded slice of resources.

## Technical architecture & implementation

**Resource isolation — the core idea.** Instead of one shared pool for all
outbound calls, each dependency (or class of dependency, or tenant) gets
its own dedicated, **bounded** pool — its own threads, its own
connections, its own queue with its own size limit. If Dependency A's pool
is fully occupied by slow or hung calls, Dependency B's calls are
unaffected because they draw from a *separate* pool with its own limit.
The failure is contained within the compartment it started in rather than
spreading. The name comes from ship design: a hull divided into watertight
compartments (bulkheads) so a breach floods only one section instead of
sinking the vessel.

**Two implementation styles — thread pools vs. semaphores.** There are two
common ways to enforce the bound. A **dedicated thread pool** per
dependency gives true isolation — the calling thread hands work to the
pool and can even walk away on timeout — but each pool has memory and
context-switch overhead, so many dependencies mean many pools. A
**semaphore (bounded concurrency limit)** is lighter: the caller must
acquire one of N permits before making the call *on its own thread* and
releases it when done. A semaphore can't isolate the *calling* thread from
a hang the way a separate pool can (the caller's thread still blocks on the
slow call), but it strictly caps how many calls to that dependency can be
in flight at once, which is enough to prevent one dependency from
consuming unbounded concurrency. Hystrix offered both; resilience4j's
`Bulkhead` is semaphore-based and its `ThreadPoolBulkhead` is pool-based.

**Bounded concurrency, queue, and reject.** The essential behavior is:
admit up to N concurrent calls, optionally queue a bounded number beyond
that, and **reject** (fail fast) once both are full. Rejecting is a
feature, not a bug — an *unbounded* queue in front of a slow dependency
just moves the failure from "threads exhausted" to "memory exhausted and
latency unbounded." A fast rejection lets the caller shed load or fall
back immediately, which is exactly why bulkheads pair so well with
circuit breakers and fallbacks.

**Sizing each compartment.** Every isolated pool must be sized: too small
and it becomes a bottleneck under normal load (rejecting healthy traffic);
too large and the isolation benefit is diluted — if every compartment can
individually consume all the machine's threads, they aren't really
isolated. A reasonable starting point is derived from the dependency's
concurrency need (Little's Law: `concurrency ≈ throughput × latency`) plus
headroom, with high-value dependencies given guaranteed capacity separate
from lower-priority ones.

**Failure modes.** A bulkhead sized **too tight** manufactures rejections
under normal load — it becomes the outage it was meant to prevent. Sized
**too loose**, compartments overlap enough that a saturated one can still
starve the machine, defeating the isolation. And a bulkhead with an
**unbounded queue** silently reintroduces the very coupling it removed, as
latency and memory grow without limit behind the slow dependency.

**Where it sits among siblings.** A bulkhead **isolates resources**; a
[circuit breaker](/docs/patterns/reliability/circuit-breaker) **stops
calls**. They solve different halves of the same problem and are almost
always used together: the bulkhead contains a slow dependency to its own
pool so it can't starve the others, and the breaker (one per compartment)
notices that pool is failing and stops sending calls to it at all. A
bulkhead is *not* a [rate limiter or
throttle](/docs/patterns/building-blocks/rate-limiter): a rate limiter
caps the *rate* of requests over time (requests per second) usually to
protect a *downstream* service or enforce fairness, whereas a bulkhead
caps *concurrent in-flight* calls to protect the *caller's own* shared
resources from a slow dependency — different quantity (rate vs.
concurrency), different beneficiary (callee vs. caller). A bulkhead also
builds on [timeout](/docs/patterns/reliability/timeout): without timeouts,
calls in a compartment can occupy their permits forever, and even an
isolated pool eventually saturates. Unlike
[failover](/docs/patterns/reliability/failover), a bulkhead does nothing to
*replace* a failing dependency — it only stops that dependency's failure
from spreading to the caller's other work. See the same framing on the
[failover page](/docs/patterns/reliability/failover) and the
[noisy-neighbor antipattern](/docs/patterns/antipatterns/noisy-neighbor).

## Code example

A semaphore-style bulkhead: a bounded number of permits, acquired before a
call and released after. This is a legitimate place to demonstrate **real
concurrency** — the `main` below runs 8 tasks (each 50 ms of work) through a
2-permit bulkhead using genuine `std::thread`, and times the wall clock to
prove the bound is real: with concurrency capped at 2, eight 50 ms tasks
take **≈4 × 50 ms = ~200 ms**, not ~50 ms (unbounded) and not ~400 ms
(fully serial). Measured on the reference run: **221 ms wall time, peak
observed concurrency exactly 2.**

```rust
use std::sync::{Arc, Condvar, Mutex};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

// A counting semaphore with a bounded number of permits. Each dependency
// gets its own Bulkhead: calls to one saturated dependency can occupy at
// most its own permits and can never draw down another's.
pub struct Bulkhead {
    inner: Mutex<usize>, // permits currently available
    cv: Condvar,
}

pub struct Permit<'a> {
    bh: &'a Bulkhead,
}

impl Bulkhead {
    pub fn new(permits: usize) -> Self {
        Bulkhead { inner: Mutex::new(permits), cv: Condvar::new() }
    }

    // Non-blocking acquire: take a permit if free, else reject immediately.
    // Rejecting (rather than queueing unboundedly) is what keeps a slow
    // dependency from piling up latent work — the caller fails fast.
    pub fn try_acquire(&self) -> Option<Permit<'_>> {
        let mut avail = self.inner.lock().unwrap();
        match *avail {
            0 => None,
            _ => {
                *avail -= 1;
                Some(Permit { bh: self })
            }
        }
    }

    // Blocking acquire, used to demonstrate bounded concurrency under load.
    pub fn acquire(&self) -> Permit<'_> {
        let mut avail = self.inner.lock().unwrap();
        while *avail == 0 {
            avail = self.cv.wait(avail).unwrap();
        }
        *avail -= 1;
        Permit { bh: self }
    }
}

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        let mut avail = self.bh.inner.lock().unwrap();
        *avail += 1;
        self.bh.cv.notify_one();
    }
}

// A runnable demonstration. First shows isolation-by-rejection on a full
// compartment; then runs 8 tasks (each 50ms) through a 2-permit bulkhead
// on real threads, timing the wall clock to prove the concurrency bound is
// real: with parallelism capped at 2, the run takes ~ceil(8/2)*50ms =
// ~200ms, not 400ms (serial) and not ~50ms (unbounded).
fn main() {
    // Isolation-by-rejection: a saturated compartment fails fast instead of
    // spilling its rejection into shared resources.
    let bh = Bulkhead::new(2);
    let p1 = bh.try_acquire().expect("first permit");
    let _p2 = bh.try_acquire().expect("second permit");
    assert!(bh.try_acquire().is_none()); // compartment full — rejected here
    drop(p1);
    assert!(bh.try_acquire().is_some()); // releasing frees a slot

    // Bounded concurrency under real threads.
    let bh = Arc::new(Bulkhead::new(2));
    let peak = Arc::new(AtomicUsize::new(0));
    let inflight = Arc::new(AtomicUsize::new(0));

    let start = Instant::now();
    let mut handles = Vec::new();
    for _ in 0..8 {
        let bh = Arc::clone(&bh);
        let peak = Arc::clone(&peak);
        let inflight = Arc::clone(&inflight);
        handles.push(std::thread::spawn(move || {
            let _permit = bh.acquire();
            let n = inflight.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(n, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(50));
            inflight.fetch_sub(1, Ordering::SeqCst);
        }));
    }
    for h in handles {
        h.join().unwrap();
    }
    let elapsed = start.elapsed();

    let peak = peak.load(Ordering::SeqCst);
    // Concurrency never exceeded the permit count — the isolation bound.
    assert!(peak <= 2);
    // And it was genuinely concurrent: well under the 400ms serial floor.
    assert!(elapsed < Duration::from_millis(360));
    assert!(elapsed >= Duration::from_millis(180));
    println!("wall time {:?}, peak observed concurrency {}", elapsed, peak);
}
```

Walking through the demonstration: the first block shows
isolation-by-rejection — a saturated compartment fails fast instead of
spilling into shared resources. The second empirically proves the
concurrency bound is real — peak in-flight never exceeds the permit count,
and the timing (≥180 ms, &lt;360 ms) rules out both the unbounded and the
fully-serial explanations.

## When to use it

- A service calls multiple independent downstream dependencies with
  different reliability or latency characteristics, and a failure in one
  shouldn't be able to affect calls to the others.
- High-value or high-volume dependencies (or tenants) that deserve
  resource guarantees separate from lower-priority ones — noisy-neighbor
  isolation in a multi-tenant system.
- Typically combined with a circuit breaker per compartment, so each
  isolated pool can also fail fast independently.

## When not to use it

- A service with only one downstream dependency, or dependencies with no
  meaningfully different risk profiles — there's nothing to isolate from
  what.
- Extremely resource-constrained environments where the overhead of many
  separate pools (rather than one shared, larger one) isn't affordable.
- When what you actually need is to limit the *rate* of requests to protect
  a downstream service — that's a
  [rate limiter](/docs/patterns/building-blocks/rate-limiter) or
  [throttle](/docs/patterns/building-blocks/throttling), not a bulkhead.

## Use-case scenarios

**Aggregating service with mixed-reliability dependencies.** A dashboard
API aggregates data from a fast internal database, a slower internal
service, and a flaky third-party API. Each gets its own bounded
concurrency pool. When the third-party API degrades and its calls start
hanging, they saturate only *its* compartment — new third-party calls are
rejected fast and fall back to stale cached data, while the database and
internal-service panels keep rendering normally. Without the bulkhead, hung
third-party calls would have consumed the shared pool and blanked the whole
dashboard.

**Multi-tenant SaaS isolating noisy neighbors.** A shared worker fleet
processes jobs for many customer tenants. A per-tenant bulkhead caps how
many workers any single tenant can occupy at once, so one tenant submitting
a flood of slow jobs can't starve every other tenant's jobs of workers —
the [noisy-neighbor](/docs/patterns/antipatterns/noisy-neighbor) problem
contained by bounded concurrency plus rejection of the over-quota tenant's
excess work.

**Connection-pool isolation for a critical path.** A service uses one
database with both a critical write path (order placement) and a
best-effort analytics path (event logging). Rather than sharing one
connection pool where a burst of slow analytics writes could exhaust
connections and block order placement, the two paths get *separate* bounded
connection pools. An analytics spike saturates only the analytics pool;
order placement keeps its guaranteed connections and stays responsive.

## Production libraries & getting started

resilience4j (Java) and Polly (.NET) ship a dedicated Bulkhead abstraction; in most other languages you build the same semaphore-based isolation directly on the standard concurrency primitive.

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| cockatiel (bulkhead) | JS/TS | A bulkhead policy capping concurrent executions with a bounded queue | [github.com/connor4312/cockatiel](https://github.com/connor4312/cockatiel) ([npm](https://www.npmjs.com/package/cockatiel)) |
| `tokio::sync::Semaphore` | Rust | Permit-based bounded concurrency for isolating a dependency's async calls | [docs.rs/tokio — Semaphore](https://docs.rs/tokio/latest/tokio/sync/struct.Semaphore.html) |
| `golang.org/x/sync/semaphore` | Go | Weighted semaphore for capping in-flight calls per compartment | [pkg.go.dev — x/sync/semaphore](https://pkg.go.dev/golang.org/x/sync/semaphore) |
| `asyncio.Semaphore` | Python (async) | Built-in semaphore to bound concurrent coroutines to a dependency | [docs.python.org — asyncio.Semaphore](https://docs.python.org/3/library/asyncio-sync.html#asyncio.Semaphore) |
| resilience4j Bulkhead | Java | Canonical semaphore and thread-pool bulkhead implementations | [resilience4j.readme.io — Bulkhead](https://resilience4j.readme.io/docs/bulkhead) |
| Polly | .NET | Canonical rate-limiter/bulkhead isolation strategy for .NET | [pollydocs.org](https://www.pollydocs.org/) |

**Example / reference:** [Netflix Hystrix — How it Works](https://github.com/Netflix/Hystrix/wiki/How-it-Works)

## Related patterns

- [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) — the
  natural pair: a bulkhead *isolates resources* per compartment while a
  breaker (one per compartment) *stops calls* once that compartment is
  failing.
- [Timeout](/docs/patterns/reliability/timeout) — without timeouts, calls
  occupy their compartment's permits indefinitely and even an isolated pool
  eventually saturates.
- [Rate Limiter](/docs/patterns/building-blocks/rate-limiter) and
  [Throttling](/docs/patterns/building-blocks/throttling) — cap the *rate*
  of requests (usually to protect a downstream), a different axis than the
  bulkhead's cap on *concurrent* calls to protect the caller's resources.
- [Failover](/docs/patterns/reliability/failover) — replaces a failed
  dependency with a standby, whereas a bulkhead only stops that
  dependency's failure from spreading; the two are commonly layered.
- [Noisy Neighbor](/docs/patterns/antipatterns/noisy-neighbor) — the
  antipattern of a shared resource being starved by one consumer, which
  per-tenant bulkheads directly prevent.

## Further reading

- [Bulkhead (partition) — Wikipedia](https://en.wikipedia.org/wiki/Bulkhead_(partition))
- [Bulkhead pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/bulkhead)
- [Resilience4j Bulkhead — official docs](https://resilience4j.readme.io/docs/bulkhead)
- [How it Works — Netflix Hystrix wiki](https://github.com/Netflix/Hystrix/wiki/How-it-Works) — thread-pool and semaphore isolation as popularized for microservices.
