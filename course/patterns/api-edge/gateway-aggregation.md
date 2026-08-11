---
title: "Gateway Aggregation"
sidebar_position: 6
supplementary: true
---

Gateway Aggregation is a gateway that fans one client request out to
several backend services and combines their responses into a single
client-facing payload, so a client makes one request instead of
orchestrating multiple round trips itself.

![Gateway Aggregation diagram](/img/patterns/gateway-aggregation.svg)

## Problem it solves

A single screen or operation in a client app often needs data from
several backend services — a product page might need product details,
pricing, and reviews from three separate services. If the client calls
each service directly, it pays the latency of every round trip, and on
a high-latency network (mobile, especially) that adds up fast. It also
couples the client to the internal service topology: the client has to
know which three services exist and how to combine their results,
which turns any backend re-decomposition into a client-side change.
Aggregation moves both the fan-out and the merge to the gateway, where
the calls run over a fast internal network and the client sees one
request and one response.

## Technical architecture & implementation

**Fan-out and merge.** The client sends one request for the composite
result it needs. The gateway maps that to N backend calls, issues them,
waits for the responses, and merges them into a single payload shaped
for the client. The client never sees the individual calls; from its
perspective, one request went out and one came back. Because the
fan-out happens inside the gateway — on a fast, typically low-latency
network to the backends — rather than over the client's own connection,
the aggregation is usually far cheaper than the client making the same
calls itself.

**Concurrency is the whole point.** The N calls are almost always
independent of each other, so they must run **in parallel**, not
sequentially. Run in parallel, the gateway's total latency is bounded
by the *slowest* leg; run sequentially, it degenerates into the *sum*
of all legs — which merely moves the round trips from the client's
network to the gateway's without saving any time. If one leg genuinely
depends on another's result, that's sequential *orchestration*, a
heavier operation, not aggregation. This is the single most important
implementation detail and the one most often faked: code that "awaits"
each call one after another looks concurrent but runs serially.

**Per-backend timeouts and an overall budget.** Each leg needs its own
[timeout](/docs/patterns/reliability/timeout), and the aggregation as a
whole needs an overall time budget. Without them, one slow or hung
dependency stalls every aggregated request that touches it, well beyond
that backend's own latency budget — the aggregation is only ever as
fast as its slowest included leg, so an unbounded leg is an unbounded
response.

**Partial-failure handling.** When a fan-out of three has one leg fail
or time out, the gateway must decide: fail the whole request, or return
a **partial response** with the missing piece marked absent and let the
client degrade gracefully. For a product page, a failed reviews service
should usually yield a page without the ratings block, not an error
page — the pattern pairs naturally with [graceful
degradation](/docs/patterns/reliability/graceful-degradation). Which
legs are *required* versus *optional* is a per-endpoint policy the
gateway must encode explicitly.

**Response shaping.** Beyond concatenation, the gateway typically
reshapes — renaming fields, dropping ones the client doesn't need,
flattening nested structures — so the client receives exactly the
payload its screen wants rather than three raw backend schemas stapled
together. This is also where response size is controlled for the
client's network.

**Failure modes.** The dominant one is the **slowest-leg tax**: adding
a chatty or flaky backend to an aggregation makes *every* request that
includes it as slow (or as failure-prone) as that one dependency,
even requests that barely use its data. A second is **fan-out
amplification** — one client request becoming N backend requests
multiplies load, so a spike at the edge is an N× spike downstream. A
third is **over-aggregation**: bundling data that the client actually
consumes independently just adds coupling and delays whichever piece
would have been ready first.

**Aggregation vs. its siblings.** Aggregation is the fan-out-and-merge
facet of the umbrella [API
Gateway](/docs/patterns/api-edge/api-gateway). It differs from [Gateway
Routing](/docs/patterns/api-edge/gateway-routing), which sends a request
to exactly *one* backend rather than combining several. It is often
*implemented inside* a [Backend for
Frontend](/docs/patterns/api-edge/backend-for-frontend), but they're
distinct concerns: a BFF is about tailoring a gateway *per client type*
(the mobile BFF returns a different shape than the web BFF);
aggregation is about *combining multiple calls* into one, which a BFF
happens to be a good home for but is not the same idea.

## Code example

The snippet below fans out to three independent backends on **real OS
threads** with `std::thread::scope`, joins them, and merges — including
partial-failure handling that degrades a failed reviews leg to `None`
rather than failing the whole page.

```rust
use std::thread;
use std::time::Duration;

#[derive(Debug)]
struct ProductPage {
    name: String,
    amount_cents: u32,
    average_rating: Option<f32>, // None when the reviews leg fails/times out
}

// Each stand-in "backend call" sleeps to model network latency, then
// returns. Latencies differ so the fan-out's total is bounded by the
// slowest leg, not the sum.
fn fetch_details(id: u64) -> String {
    thread::sleep(Duration::from_millis(120));
    format!("item-{id}")
}
fn fetch_price(_id: u64) -> u32 {
    thread::sleep(Duration::from_millis(90));
    1999
}
fn fetch_reviews(_id: u64) -> Result<f32, &'static str> {
    thread::sleep(Duration::from_millis(150));
    Ok(4.5)
}

// Fan out to three independent backends on real threads, join them, and
// merge. A scoped thread lets each closure borrow `id` without cloning,
// and guarantees all threads finish before the scope returns.
fn aggregate(id: u64) -> ProductPage {
    thread::scope(|s| {
        let details = s.spawn(|| fetch_details(id));
        let price = s.spawn(|| fetch_price(id));
        let reviews = s.spawn(|| fetch_reviews(id));

        // Partial-failure handling: a panicked or erroring reviews leg
        // degrades to None rather than failing the whole aggregation.
        let rating = match reviews.join() {
            Ok(Ok(r)) => Some(r),
            _ => None,
        };

        ProductPage {
            name: details.join().expect("details thread panicked"),
            amount_cents: price.join().expect("price thread panicked"),
            average_rating: rating,
        }
    })
}
```

Run with the three legs at 120 ms, 90 ms, and 150 ms, `aggregate()`
returns in about **153 ms** — bounded by the single slowest call — not
the **~360 ms** their sum would take run one after another. That
sub-linear total is the entire reason to aggregate; done sequentially,
the gateway would just relocate the round trips without saving any
latency.

## When to use it

- A client screen or operation genuinely needs data from multiple
  backend services and today assembles it with multiple round trips.
- The client is on a high-latency or metered connection (mobile apps
  especially), where reducing round trips has an outsized effect on
  perceived performance.
- You want to hide which and how many backend services back a given
  feature, so they can be split, merged, or replaced without a client
  release.

## When not to use it

- The client only ever needs data from a single backend service —
  there's nothing to aggregate, and plain [Gateway
  Routing](/docs/patterns/api-edge/gateway-routing) is simpler.
- The backend calls have very different latency profiles and one is
  much slower than the rest: the aggregated response is bounded by the
  slowest call, so a single flaky or slow dependency degrades every
  aggregated request that includes it, even ones that don't otherwise
  need much from it.
- The individual pieces of data are consumed independently and don't
  need to arrive together — forcing them into one response just adds
  coupling and delays whichever piece would have been ready first.

## Use-case scenarios

**Mobile product page over a cellular network.** A commerce app's
product screen needs catalog details, live pricing, inventory
availability, and a reviews summary — four services. Rather than have
the phone make four sequential HTTPS calls over a high-latency cellular
link, the app hits one `/products/{id}/page` endpoint. The gateway fans
out to all four backends in parallel over the datacenter's fast
internal network and returns one merged payload, cutting four
round-trip taxes down to one and making the screen feel instant.

**Dashboard composed from many microservices.** An internal operations
dashboard shows account status, recent orders, open tickets, and
billing state on one screen, each owned by a different team's service.
The gateway aggregates them into a single `/dashboard` response, and
crucially marks each block *optional*: if the ticketing service is
down, the dashboard still renders account, orders, and billing with a
"tickets unavailable" placeholder instead of failing the whole page —
partial response over total failure.

**Search results enriched from side services.** A search endpoint
returns a page of result IDs from the search service, then the gateway
fans out to fetch each result's current price and stock from two other
services and stitches them into the response. Per-leg timeouts keep a
slow enrichment service from holding up results the user could already
see; if enrichment times out, results render without the price badge
rather than not at all.

## Related patterns

- [API Gateway](/docs/patterns/api-edge/api-gateway) — the umbrella
  pattern; aggregation is one behavior a gateway can implement. Not
  every gateway aggregates, but every aggregator is a form of gateway.
- [Gateway Routing](/docs/patterns/api-edge/gateway-routing) — the
  one-backend counterpart: routing dispatches to a single service,
  aggregation combines several.
- [Backend for Frontend](/docs/patterns/api-edge/backend-for-frontend) —
  a per-client-type gateway that is a natural home for aggregation
  logic, since different clients want different combinations merged.
- [Graceful Degradation](/docs/patterns/reliability/graceful-degradation) —
  the partial-response discipline that lets an aggregation survive one
  failed or slow leg.
- [Timeout](/docs/patterns/reliability/timeout) — the per-leg bound
  that stops one slow backend from becoming an unbounded aggregated
  response.

## Further reading

- [Gateway Aggregation pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/gateway-aggregation)
- [Backend For Frontend — Sam Newman](https://samnewman.io/patterns/architectural/bff/)
- [std::thread::scope — Rust standard library documentation](https://doc.rust-lang.org/std/thread/fn.scope.html)
