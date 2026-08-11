---
title: "Gateway Aggregation"
sidebar_position: 6
supplementary: true
---

Gateway Aggregation is a gateway that combines several backend calls
into a single client-facing response, so a client makes one request
instead of orchestrating multiple round trips itself.

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

## How it works

The client sends one request to the gateway for the composite result it
needs. The gateway fans that request out to the relevant backend
services — typically in parallel, since the calls are usually
independent of each other — waits for the responses, merges them into
a single payload shaped for the client, and returns that one response.
The client never sees the individual backend calls; from its
perspective, one request went out and one response came back. Because
the fan-out happens inside the gateway (on a fast, typically
low-latency network to the backends) rather than over the client's own
network connection, the aggregation is usually far cheaper than having
the client make the same calls itself.

## Code example

The snippet below shows the core of an aggregating handler: fan out to
several backends concurrently, then merge their results into one
response.

```rust
struct ProductDetails { name: String }
struct PriceInfo { amount_cents: u32 }
struct ReviewSummary { average_rating: f32, count: u32 }

struct ProductPage {
    name: String,
    amount_cents: u32,
    average_rating: f32,
    review_count: u32,
}

// Stand-ins for calls to independent backend services.
fn fetch_details(id: u64) -> ProductDetails {
    ProductDetails { name: format!("item-{id}") }
}
fn fetch_price(id: u64) -> PriceInfo {
    PriceInfo { amount_cents: 1999 }
}
fn fetch_reviews(id: u64) -> ReviewSummary {
    ReviewSummary { average_rating: 4.5, count: 128 }
}

// In production these three calls would run concurrently (e.g. via
// async tasks or a thread pool) rather than sequentially, so the
// gateway's total latency is bounded by the slowest call, not the sum.
fn aggregate_product_page(id: u64) -> ProductPage {
    let details = fetch_details(id);
    let price = fetch_price(id);
    let reviews = fetch_reviews(id);

    ProductPage {
        name: details.name,
        amount_cents: price.amount_cents,
        average_rating: reviews.average_rating,
        review_count: reviews.count,
    }
}
```

`aggregate_product_page` is the entire contract the client depends on:
one function call in, one merged struct out. Running the three fetches
concurrently is the detail that makes aggregation worth doing at all —
done sequentially, the gateway would just move the round trips from the
client's network to its own without saving any latency.

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
  there's nothing to aggregate, and a plain [API
  Gateway](/docs/patterns/api-edge/api-gateway) route is simpler.
- The backend calls have very different latency profiles and one is
  much slower than the rest: the aggregated response is bounded by the
  slowest call, so a single flaky or slow dependency degrades every
  aggregated request that includes it, even ones that don't otherwise
  need much from it.
- The individual pieces of data are consumed independently and don't
  need to arrive together — forcing them into one response just adds
  coupling and delays whichever piece would have been ready first.

## Real-world example

Mobile apps for content- or commerce-heavy products commonly use a
Backend for Frontend layer that internally performs gateway
aggregation: a single "get home screen" or "get product page" endpoint
fans out to catalog, pricing, inventory, and recommendation services
and returns one merged JSON payload, rather than making the mobile
client issue four separate API calls over a cellular connection.

## Related patterns

- [API Gateway](/docs/patterns/api-edge/api-gateway) — Gateway
  Aggregation is one behavior an API gateway can implement; not every
  gateway aggregates, but every aggregator is a form of gateway.
- [Backend for Frontend](/docs/patterns/api-edge/backend-for-frontend) —
  a gateway split per client type is a natural place to put
  aggregation logic, since different clients often want different
  combinations of backend data merged together.

## Further reading

- [Gateway Aggregation pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/gateway-aggregation)
- [API management — Wikipedia](https://en.wikipedia.org/wiki/API_management)
