---
title: "Graceful Degradation"
sidebar_position: 7
supplementary: true
---

Graceful degradation means serving a reduced but still-useful version
of a response when a non-critical dependency is unavailable, rather than
failing the whole request just because one of the many things it depends
on is down. It *accepts* the failure and works around it — it does not
replace the failed dependency or merely stop calling it.

![Graceful Degradation diagram](/img/patterns/graceful-degradation.svg)

## Problem it solves

A single request often touches several dependencies of very different
importance. A product page might need the core product record from one
service, but also personalization from another, recommendations from a
third, and analytics from a fourth. If the request handler treats every
dependency as equally required, the *least* critical one becomes an
unnecessary single point of failure for the entire request: a
recommendation service having a bad day takes down the ability to view a
product at all — even though recommendations were never essential to
that core function.

That's a waste of a mostly-healthy system. Most of what the user needs
is available; a rigid all-or-nothing handler throws it away over one
unrelated failure. Graceful degradation exists to keep the value that's
still there — render the product, take the order, serve the page —
while quietly dropping or substituting the parts that aren't.

## Technical architecture & implementation

**Criticality tiers (decide what's optional, up front).** The
prerequisite is classifying each dependency *deliberately*, before an
incident, into critical (the request cannot succeed meaningfully without
it) and non-critical (nice to have, but the request still delivers real
value without it). This can't be inferred at runtime — it's a product
and architecture decision. Treating everything as critical defeats the
purpose; treating everything as non-critical risks serving a broken or
misleading response when something that actually mattered failed
silently. Most systems end up with more than two tiers: *must-have*,
*degrade-with-fallback*, and *safe-to-omit*.

**Fallbacks (what to serve instead).** For a non-critical dependency,
the caller wraps the call so a failure or timeout yields a fallback
rather than an error. The common fallbacks, roughly in order of
usefulness: a **cached previous value** (last known recommendations, a
slightly stale price shown *as* stale), a **static/default** response (a
generic "popular items" list instead of personalized ones), or simply
**omitting** that part of the response (hide the recommendations section
entirely). Which one is right depends on whether stale-but-plausible
data is better or worse than nothing for that specific feature.

**Fail fast, then fall back.** Degradation is only graceful if it's
*quick*. A non-critical dependency that hangs for 30 seconds before you
give up on it has already ruined the request, even though you'll
eventually serve the fallback. The pattern therefore pairs with a tight
[timeout](/docs/patterns/reliability/timeout) and a [circuit
breaker](/docs/patterns/reliability/circuit-breaker): the circuit
breaker detects that the dependency is failing and *stops calling it*,
so the handler skips straight to the fallback instead of paying the
timeout on every request. Circuit breaker answers "should I even try?";
graceful degradation answers "what do I serve when the answer is no?"

**Fail-open vs. fail-closed.** For each degraded call you must choose
what a failure *means*. **Fail-open** (proceed as if the dependency said
"yes/allow/empty") is right for enhancement features — if the
recommendation service is down, show no recommendations and move on.
**Fail-closed** (proceed as if it said "no/deny") is right for anything
protective — if the fraud or authorization check is unavailable, you do
*not* fail open and assume the request is allowed. Getting this backward
is how "graceful degradation" becomes a security hole: silently degrading
a permission check to "assume success" isn't graceful, it's a correctness
bug wearing a resilience pattern's clothing.

**Feature toggles as manual degradation.** The same machinery runs
proactively. A feature flag that can turn off an expensive, non-essential
feature lets operators *shed load* during an incident — deliberately
degrading the experience (disable live personalization, serve a static
homepage) to protect the critical path. This is degradation as a
control, not just a reaction to a crash.

**Graceful degradation vs. its siblings.** These reliability patterns
are often grouped together but respond to a failing dependency in
distinctly different shapes, and picking the right one depends on the
distinction. [Failover](/docs/patterns/reliability/failover) *replaces*
the failed component: it keeps a standby ready and redirects traffic so
the **same full capability** keeps being served from a different
instance — nothing is reduced. [Circuit
breaker](/docs/patterns/reliability/circuit-breaker) *stops calling* the
failing dependency to protect the caller from hanging on it — it changes
whether the call is made, but on its own it doesn't decide what to serve
instead. Graceful degradation is the one that *reduces the response*: it
neither substitutes a replacement (like failover) nor merely halts the
call (like circuit breaker), but accepts the dependency's absence and
serves a smaller, still-useful answer. This is exactly the framing on the
[failover](/docs/patterns/reliability/failover) page, from the other
side. The three compose: a circuit breaker trips on the failing
dependency, graceful degradation supplies the fallback while it's open,
and failover (if a standby exists) is what would instead restore the full
capability outright. A robust system layers them — degradation commonly
covers the gap *during a failover window* itself.

## Degradation tiers

A worked classification for a product-page request makes the tiers
concrete:

| Dependency        | Tier                  | Failure behavior                          | Fail mode   |
| ----------------- | --------------------- | ----------------------------------------- | ----------- |
| Product record    | Critical              | Fail the request (no meaningful page)     | fail-closed |
| Pricing           | Critical              | Fail the request (never show wrong price) | fail-closed |
| Inventory / stock | Degrade with fallback | Show "check availability" instead of live | fail-open   |
| Personalization   | Degrade with fallback | Fall back to generic, non-personalized    | fail-open   |
| Recommendations   | Safe to omit          | Hide the section entirely                 | fail-open   |
| Analytics beacon  | Safe to omit          | Drop silently, never block render         | fail-open   |

The critical rows have no graceful reduction — if pricing is wrong or
missing there is no honest smaller answer, so the request fails (or a
[failover](/docs/patterns/reliability/failover) restores the source).
Everything below the line degrades.

## Code example

A typed fallback chain for one non-critical dependency: try the live
source, then a cached value, then a static default. The chain returns the
**first source that succeeds** and records which tier served the response
— so the request always completes with *something useful*, and the code
never throws just because the live source is down. Pure `std`,
deterministic.

```rust
#[derive(Debug, PartialEq)]
enum Source {
    Live,
    Cache,
    Default,
}

#[derive(Debug, PartialEq)]
struct Served {
    recommendations: Vec<u64>,
    source: Source, // which tier actually answered — for logging/metrics
}

struct RecommendationPanel {
    /// Ordered fallbacks, each may fail (return None). Boxed so tests can
    /// inject live/cache outages independently.
    live: Box<dyn Fn() -> Option<Vec<u64>>>,
    cache: Box<dyn Fn() -> Option<Vec<u64>>>,
    default: Vec<u64>, // the static floor — always available
}

impl RecommendationPanel {
    /// Serve recommendations, degrading through the chain. Never fails:
    /// the static default is the guaranteed floor.
    fn serve(&self) -> Served {
        if let Some(r) = (self.live)() {
            return Served { recommendations: r, source: Source::Live };
        }
        // Live is down: fall back to the last cached value (stale but useful).
        if let Some(r) = (self.cache)() {
            return Served { recommendations: r, source: Source::Cache };
        }
        // Cache miss too: serve the generic default rather than erroring.
        Served { recommendations: self.default.clone(), source: Source::Default }
    }
}
```

The guarantee is in the last branch: `serve` has no error path for the
caller to handle, because the static `default` is always reachable — the
worst case is a *reduced* response, never a failed one.

## When to use it

- User-facing requests that aggregate data from multiple independent
  backends, where some enhance the experience but aren't required for it
  to be useful.
- Products where a reduced-but-available experience beats strict
  all-or-nothing correctness — most consumer-facing systems.
- Paired with [timeouts](/docs/patterns/reliability/timeout) and
  [circuit breakers](/docs/patterns/reliability/circuit-breaker) on each
  non-critical dependency, so a hung or failing one degrades that single
  piece quickly instead of stalling the whole request.

## When not to use it

- Dependencies that are genuinely load-bearing for correctness — silently
  degrading a payment, pricing, or authorization check to "assume
  success" is a correctness or security bug, not resilience. Those must
  fail-closed (or fail over to a real replacement).
- Situations where a degraded response would *mislead* the user harmfully
  (e.g. presenting stale pricing as if it were live) rather than clearly
  omitting or labeling the unavailable piece.
- Systems where every dependency really is critical — there's nothing to
  degrade *to*, and the honest answer is to fail the request or rely on
  [failover](/docs/patterns/reliability/failover) instead.

## Use-case scenarios

**E-commerce product page dropping recommendations.** A product page
depends on core product data (critical) and a recommendations service
(safe to omit). When recommendations is slow or down, a circuit breaker
trips, the handler skips the call, and the page renders the product and
lets the customer buy — it simply hides the "customers also bought"
section rather than failing the whole page over a non-essential service.

**News site serving cached content from the edge.** A news homepage's
personalization backend goes down under a traffic spike. Instead of
erroring, the site falls back to a generic, non-personalized edition
served from the [CDN](/docs/patterns/building-blocks/cdn) /
[static content host](/docs/patterns/building-blocks/static-content-hosting) —
a cached, slightly stale front page that every reader can load. Everyone
still gets the news; only the personalization is degraded away, and the
static fallback also sheds load from the struggling origin.

**Streaming app degrading video quality.** A video service detects that
its adaptive-bitrate or CDN capacity is constrained during peak demand.
Rather than failing playback outright, it degrades — dropping to a lower
resolution and disabling non-essential features like preview thumbnails —
so streams keep playing at reduced quality instead of buffering to a
stop. A reduced experience, deliberately chosen over an unavailable one.

## Related patterns

- [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) — detects
  a failing dependency and stops calling it, so the handler jumps
  straight to the degraded fallback instead of paying a timeout every
  request.
- [Failover](/docs/patterns/reliability/failover) — the sibling that
  *replaces* a failed component with a standby to keep full capability,
  rather than reducing the response; the two often layer, with
  degradation covering the failover window.
- [Timeout](/docs/patterns/reliability/timeout) — bounds how long a
  non-critical call may hang before the fallback kicks in, which is what
  makes the degradation *fast* and therefore graceful.
- [Cache-Aside](/docs/patterns/caching/cache-aside) — a warm cache is a
  primary fallback source, letting a degraded path serve a last-known
  value when the live dependency is unavailable.
- [CDN](/docs/patterns/building-blocks/cdn) — serves static fallback
  content (a generic page, a cached response) when a dynamic origin
  dependency is down.

## Further reading

- [Fault tolerance — Wikipedia](https://en.wikipedia.org/wiki/Fault_tolerance)
- [Graceful degradation — Wikipedia](https://en.wikipedia.org/wiki/Graceful_degradation)
- [Graceful Degradation — AWS Well-Architected (Reliability pillar)](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/rel_mitigate_interaction_failure_graceful_degradation.html)
- [Google SRE Book — Handling Overload (graceful degradation & load shedding)](https://sre.google/sre-book/handling-overload/)
- [Fail-safe — Wikipedia](https://en.wikipedia.org/wiki/Fail-safe)
