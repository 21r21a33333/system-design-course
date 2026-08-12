---
title: "Cascading Failures"
sidebar_position: 9
supplementary: true
---

A cascading failure is a **positive feedback loop**: one component's
failure raises the probability that another one fails too, which raises
it further, and so on — turning a small, survivable problem into a total
outage in minutes. It's the single most dangerous failure mode a
distributed system has, because the very things engineers reach for
under pressure — retrying, redistributing load, restarting servers,
adding capacity — can *accelerate* the cascade instead of stopping it if
applied without understanding why the loop is spinning. This page
condenses Google's SRE Book chapter on the topic: every named technique
it introduces, kept intact, with the padding trimmed.

![Cascading failure feedback loop](/img/patterns/cascading-failures.svg)

## Why cascading failures happen

**Server overload is the primary cause.** A cluster fails, its traffic
shifts to a healthy cluster, that cluster's load jumps (say 1,000 → 1,200
QPS), it can't absorb the increase, its frontends start crashing, and its
*successful* request rate drops below what it was handling before the
shift even happened. The failure domain that absorbed the traffic is now
itself failing, and the pattern repeats outward. This spreads globally in
minutes, not hours.

**Resource exhaustion cascades internally, too.** One resource running
out triggers a chain reaction through others:

- **CPU exhaustion** → more in-flight requests pile up → longer queues →
  higher latency and memory pressure → thread starvation → health checks
  start failing → internal watchdogs crash the process.
- **Memory exhaustion** → tasks get killed by the container manager, or
  (worse) trigger more garbage collection — a classic **GC death spiral**:
  less CPU available → requests get slower → more requests held in memory
  at once → more GC → even less CPU.
- **Thread/file-descriptor exhaustion** → new connections fail, health
  checks fail, and the server looks dead to its load balancer even if the
  process is technically still running.

**Once servers start failing, the load balancer makes it worse.**
Servers returning errors get excluded from rotation — sensible in
isolation, but it concentrates 100% of the load onto whatever's left,
which is exactly the mechanism that turns "a few servers are struggling"
into "all servers are struggling." A server doesn't even need to crash to
trigger this: entering a **lame duck state** (alive but failing health
checks) has the identical effect.

**Recovery isn't just "undo the trigger."** A service healthy at 10,000
QPS that started crash-looping at 11,000 QPS often won't stabilize again
at 9,000 QPS — it may need to drop to something like 1,000 QPS before the
crash loop stops, because the crash loop itself (not just the original
traffic bump) is now the active problem.

## Preventing overload before it cascades

**Load test until it breaks — this is the single most important step.**
Everything else on this page is a response to a specific failure mode;
load testing is how you find out which failure mode your system actually
has (which resource exhausts first, at what QPS, and how ungracefully).
Test gradual ramps *and* traffic impulses (they stress caching
differently), and test whether the system returns to normal on its own
once load drops, or needs manual intervention.

**Reject early instead of failing late — load shedding.** Once a server
is near its limit, doing a *little* less useful work and staying alive
beats doing zero useful work because it crashed. Two concrete techniques:
**per-task throttling** (return `503` once in-flight requests cross a
threshold, before the server melts down) and **queue discipline** — swap
a plain FIFO queue for **LIFO**, or for the **CoDel** algorithm, which
drops requests that have been queued so long the caller probably already
gave up on them. A request queued for 10 seconds behind a page load the
user already refreshed is wasted work either way; CoDel just stops
pretending otherwise.

**Degrade gracefully instead of degrading uniformly.** Serve a cheaper,
lower-quality result instead of the full one — search only an in-memory
cache subset, use a faster/less-accurate ranking pass — covered in full
in [Graceful Degradation](/docs/patterns/reliability/graceful-degradation).
The one addition worth calling out here: **an untested degraded-mode code
path is a broken code path.** If degraded mode only ever runs during a
real incident, you're debugging new code for the first time under the
worst possible conditions. Exercise it regularly — run a small slice of
servers permanently near their degradation threshold — so it's proven
before you actually need it.

**Rate-limit at every layer that can say no.** Reverse proxies limit by
IP (blunt, good for DDoS). Load balancers can drop indiscriminately under
global overload, or selectively — keep interactive sessions, drop
prefetch and batch traffic first. Individual tasks rate-limit themselves
so load-balancing *fluctuations* (not just sustained overload) don't
overwhelm any one instance.

**Manage queue size deliberately, not by accident.** Rule of thumb: keep
queue length at or below roughly 50% of thread-pool size, so the server
rejects early rather than accepting work it can't get to. A 10:1
queue-to-thread ratio at 100ms processing time means a *1.1 second* total
handling time — the request "succeeds," a full second late. Bursty
traffic may genuinely need a bigger queue; that's a deliberate trade,
sized against burst frequency and processing time, not a default.

**Retry only what's worth retrying, and cap how much.** Full depth is in
[Retry with Backoff](/docs/patterns/reliability/retry-with-backoff) and
the [Retry Storm](/docs/patterns/antipatterns/retry-storm) it prevents —
the one number worth memorizing from the SRE book here: retries
**multiply** across layers. Three retries at each of three stacked layers
isn't 9 extra attempts, it's 4³ = **64** attempts landing on the
database from one user action. A **retry budget** (a system-wide cap —
e.g. "retries may be at most 10% of traffic") is what stops that
multiplication from being unbounded.

**Propagate one deadline down the whole call chain — don't invent a new
one at every hop.** Full mechanics and code are in
[Timeout § Deadline propagation](/docs/patterns/reliability/timeout#deadline-propagation).
What the SRE book adds is *why this matters more than it looks*: a
service that ignores the incoming deadline and waits on its own fixed
timeout does work the caller has already given up on — "no credit for
late assignments." Worse, if that in-flight work holds a thread until its
own timeout fires, a small fraction of permanently-slow requests can
exhaust an entire thread pool. Concretely: 1,000 QPS, 100ms typical, but
**5%** of requests never complete and each one holds a thread for a
100-second deadline — that 5% alone demands 50 × 100 = **5,000**
concurrently-held threads against a pool of 1,000. The result isn't a 5%
error rate, it's roughly an **80% error rate**, because *everyone* is
now queued behind threads pinned by the unlucky 5%. This is why you watch
**latency percentiles, not the mean** — the mean hides exactly this
failure shape.

**Treat a cold cache as a real failure mode, not an edge case.** New
clusters, post-maintenance restarts, and task restarts all start with an
empty cache. Distinguish a **latency cache** (nice to have — the service
survives fine without it, just slower) from a **capacity cache** (a hard
dependency — the service *cannot* sustain expected load without it). A
capacity cache needs deliberate overprovisioning and a gradual
load ramp-up on cold start, never a straight-to-100%-traffic cutover.

**Keep calls flowing downward through the stack, never sideways.** Fix
problems at the lowest layer they occur in; that repairs both that layer
and everything above it. The trap to avoid is **intra-layer
communication** — backend A proxying to backend B on error, or
rebalancing peer-to-peer — because under load this can produce a
**distributed deadlock** (every thread pool saturated waiting on a peer
while simultaneously fielding requests from that same peer) and it
*amplifies* load exactly when the system has the least spare capacity to
absorb amplification. If a backend can't serve a request, it should tell
the *frontend* to retry elsewhere — never silently proxy sideways.

## Code example

None of the reliability pages elsewhere in this course implement
**admission control** — the server-side gate that decides, on every
incoming request, whether to do the work or shed it — so here it is: a
combined in-flight threshold (load shedding) and a CoDel-style
"has this request been queued too long to be worth serving" check (queue
management), the two techniques from the sections above that don't
already have a dedicated code example on another page.

```rust
use std::time::{Duration, Instant};
use std::collections::VecDeque;

// Admits or sheds work before it reaches the expensive part of the
// server. Two independent gates, checked in order — either one alone is
// incomplete: a threshold alone doesn't help work that's *already*
// queued past the point of being useful, and a queue-age check alone
// doesn't stop the queue from growing unboundedly in the first place.
pub struct AdmissionGate {
    max_in_flight: usize,
    max_queue_wait: Duration, // CoDel-style: drop if queued longer than this
    in_flight: usize,
    queue: VecDeque<Instant>, // enqueue time of each still-waiting request
}

pub enum Decision {
    Admit,
    ShedOverloaded,  // 503: in-flight threshold already exceeded
    ShedStale,       // request sat in queue past max_queue_wait — caller
                      // has likely already given up; doing the work now
                      // wastes capacity on a response nobody will use
}

impl AdmissionGate {
    pub fn new(max_in_flight: usize, max_queue_wait: Duration) -> Self {
        AdmissionGate { max_in_flight, max_queue_wait, in_flight: 0, queue: VecDeque::new() }
    }

    // Call when a request arrives.
    pub fn on_arrive(&mut self, now: Instant) -> Decision {
        // Gate 1 — load shedding: reject early rather than queue behind
        // work the server has already proven it can't keep up with.
        if self.in_flight >= self.max_in_flight {
            return Decision::ShedOverloaded;
        }
        self.queue.push_back(now);
        Decision::Admit
    }

    // Call immediately before actually doing the work (i.e. right after
    // this request reaches the front of the queue). This is the CoDel
    // check: even though the request was admitted, time may have passed
    // while it waited — if that wait already exceeds the budget, the
    // caller has plausibly moved on, so drop it instead of doing wasted
    // work on their behalf.
    pub fn on_dequeue(&mut self, enqueued_at: Instant, now: Instant) -> Decision {
        self.queue.retain(|&t| t != enqueued_at);
        if now.duration_since(enqueued_at) > self.max_queue_wait {
            return Decision::ShedStale;
        }
        self.in_flight += 1;
        Decision::Admit
    }

    pub fn on_complete(&mut self) {
        self.in_flight = self.in_flight.saturating_sub(1);
    }
}
```

Tracing the logic: `on_arrive` is the per-task throttle (reject once
in-flight work is already at capacity); `on_dequeue` is the CoDel check
(reject if this request has been waiting long enough that finishing it
no longer helps anyone); `on_complete` frees the slot. Both shed paths
return fast, cheap errors instead of consuming the resources a full
request would.

## Testing for it before it happens to you

- **Push every component past its breaking point on purpose.** Watch
  *how* it fails — a graceful slowdown is very different from a hard
  crash, and you want to know which one you have before an incident
  teaches you the hard way.
- **Test both gradual ramps and traffic impulses** — caching and
  autoscaling react very differently to each.
- **Test return-to-nominal, not just the failure itself.** Does the
  system recover on its own once load drops, or does it need a human to
  intervene, and how far does load need to drop before it does?
- **For stateful/cached services, check correctness under load, not just
  throughput** — concurrency bugs that never show up at low QPS often
  appear exactly when the system is stressed.
- **Test your biggest clients' retry behavior specifically**, not just
  your own service. Does a large client queue work while you're down?
  Does it use randomized exponential backoff, or will its recovery be a
  synchronized thundering herd the moment you come back?
- **Deliberately fail your noncritical backends** (both "absent" and
  "present but never responds") and confirm a noncritical dependency
  can't sink the whole request path — a long deadline on a
  supposedly-optional call can still exhaust frontend resources if
  nothing bounds it.

## The emergency playbook — once it's already happening

- **Add resources, if you have slack capacity.** Cheapest fix when it's
  available — but a true death spiral can outrun what you can add fast
  enough, so don't assume this alone will resolve it.
- **Stop the scheduler from killing "unhealthy" tasks.** A cluster
  manager killing tasks that fail health checks can turn "half the fleet
  is starting up" into "the fleet never has enough running instances to
  make progress." Distinguish **process health** ("is the binary
  responding at all?") from **service health** ("can it usefully handle
  requests *right now*?") — the first should very rarely trigger a kill;
  the second is what load balancers should route around instead.
- **Restart wedged servers — but find the root cause first.** Restarts
  help with GC death spirals, deadlocks, and threads stuck on requests
  with no deadline. They can *hurt* if the real problem is a cold cache,
  since a restart just re-triggers the cold-start problem. Canary the
  restart on a small slice before rolling it out everywhere.
- **Drop traffic — the last resort, in order:** (1) fix the actual
  trigger (e.g. add the missing capacity), (2) cut load aggressively —
  1% of normal if it's a full crash loop, not a token 20% cut, (3) let
  the survivors stabilize, (4) ramp back up gradually so caches warm and
  connections re-establish instead of instantly re-triggering the same
  cascade. Drop the least-important traffic first if you can
  differentiate it (prefetch before interactive).
- **Enter a pre-built degraded mode**, if one exists — this only works if
  it was designed and tested in advance (see Testing, above).
- **Turn off anything non-critical sharing the same resources** — index
  updates, backups, batch analytics jobs — that are quietly competing
  with the serving path for the exact resource that's exhausted.
- **Block "queries of death"** — specific requests identified as
  disproportionately expensive or crash-triggering — while the rest of
  the fix is applied.

> "Once a service passes its breaking point, it is better to allow some
> user-visible errors or lower-quality results to slip through than to
> try to fully serve every request." — the SRE Book's closing principle,
> and arguably the whole chapter compressed into one sentence.

## A real incident, compressed

A documentary airs in Japan; traffic to a Google service spikes past what
the Asian datacenter was provisioned for — at the same time as an
unrelated planned rollout. The service *had* real defenses in place
(graceful degradation dropping images and maps under load, retries with
randomized backoff, non-critical calls on their own timeouts) — and it
still went into a crash-loop, because tasks started dying one by one, got
restarted by the scheduler, and each restart briefly shrank the fleet's
serving capacity further, feeding the loop. SREs stopped it by manually
adding capacity to the region. Afterward, two structural fixes replaced
the manual save: cross-region overflow (route excess traffic to
*neighboring* datacenters automatically) and autoscaling (grow capacity
with load instead of waiting for a human to notice). The lesson isn't
"they lacked defenses" — they had most of the list above — it's that
defenses reduce the odds and the blast radius, they don't make cascades
impossible.

## Related patterns

- [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff) —
  and its evil twin, the [Retry Storm](/docs/patterns/antipatterns/retry-storm)
  antipattern this whole page is partly about avoiding.
- [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) — stops
  calling a dependency that's clearly down instead of continuing to feed
  the cascade.
- [Timeout](/docs/patterns/reliability/timeout) — the deadline-propagation
  mechanics referenced above live here in full.
- [Bulkhead](/docs/patterns/reliability/bulkhead) — bounded pools and
  queues per dependency, so one overloaded dependency can't exhaust
  resources shared by everything else.
- [Graceful Degradation](/docs/patterns/reliability/graceful-degradation) —
  the reduced-quality-response mechanics referenced above live here in full.
- [Failover](/docs/patterns/reliability/failover) — redirects to a
  standby when the primary is the thing cascading.

## Source(s) and further reading

- [Addressing Cascading Failures — Google SRE Book, ch. 22](https://sre.google/sre-book/addressing-cascading-failures/) —
  the original, full-depth chapter this page condenses; read it directly
  for the complete worked examples and case study this page trims.
- [Exponential Backoff And Jitter — AWS Architecture Blog](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
- [CoDel — Wikipedia](https://en.wikipedia.org/wiki/CoDel)
