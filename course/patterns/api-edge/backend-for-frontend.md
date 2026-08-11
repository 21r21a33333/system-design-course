---
title: "Backend for Frontend"
sidebar_position: 2
supplementary: true
---

Backend for Frontend (BFF) is a dedicated backend layer built for one
specific client type — web, mobile, or a third-party integration —
that shapes and aggregates calls to backend services around that
client's needs, instead of one generic API trying to serve every client
equally well.

![Backend for Frontend diagram](/img/patterns/backend-for-frontend.svg)

## Problem it solves

A single general-purpose API tends to satisfy no client particularly
well. A mobile client on a slow connection wants a small, pre-aggregated
payload with only the fields it renders; a desktop web client can afford
richer, more granular responses and may want several resources combined
differently. A one-size-fits-all API either over-fetches (sends fields
the mobile client will discard, wasting bandwidth and battery) or
under-fetches (forces the client to make several round trips to gather
what one screen needs). Worse, as more client types are added, the
shared API accumulates client-specific conditional logic and becomes a
coordination bottleneck between frontend teams who all depend on the
same backend release cycle.

## Technical architecture & implementation

**Ownership and deployment.** Each client type — mobile, web, a
partner integration — gets its own backend service, ideally owned and
deployed by the same team that owns that client. This is the
structural point of the pattern: a mobile engineer who wants to change
what fields a screen fetches can ship that change in the mobile BFF
without opening a pull request against a shared backend team's
repository or waiting for that team's release cycle, because the
mobile BFF has no other consumers whose needs could be broken by the
change.

**Aggregation and shaping.** A BFF calls one or more downstream domain
services — directly, or through a shared [API
Gateway](/docs/patterns/api-edge/api-gateway) that handles TLS
termination and auth uniformly in front of every BFF — and combines
their responses into exactly the shape its one client needs. This
typically means three kinds of work: **filtering** (dropping fields the
client won't render, e.g. omitting a product's full description text
from the shape sent to a smart-TV client that only shows a thumbnail
and price), **aggregation** (combining several downstream calls, such
as inventory plus pricing plus reviews, into a single response the
client renders in one screen), and **translation** (reshaping a
generic domain object into whatever structure the client's rendering
layer expects, e.g. flattening a nested object graph into the flat
key-value shape a mobile client's view-binding layer wants). None of
this logic lives in the downstream domain services themselves — they
return their own natural shape and remain unaware of which client
ultimately consumes it.

**Failure modes.** The most common failure is **BFF logic drift into
domain logic**: a BFF is supposed to reshape and aggregate, not decide
business rules (like eligibility or pricing), and once genuine business
logic leaks into a BFF, that logic now exists in every BFF that needs
it, independently maintained and prone to silently diverging between,
say, the web and mobile implementations of the same rule. The second
is **duplicated aggregation logic**: because each BFF independently
calls the same downstream services, a bug or inconsistency in how one
BFF combines two calls (e.g. handling a partial failure from one
downstream service while aggregating) has to be fixed separately in
every other BFF that does similar aggregation, since there's no single
shared aggregation layer to patch once. A third, subtler failure is
**BFF proliferation without ownership** — if a "temporary" BFF is
created for a one-off integration and no team is assigned to maintain
it, it accumulates staleness and breaks silently when a downstream
service's contract changes, since nobody is watching for it.

**Backend for Frontend vs. API Gateway.** The two are easy to conflate
because both sit between clients and backend services, but they solve
different problems. A single [API
Gateway](/docs/patterns/api-edge/api-gateway) is normally one shared
component applying the *same* routing, auth, and rate-limiting rules to
every client type; BFF instead *splits* the layer client-by-client so
each one can shape and aggregate responses differently, which a single
shared gateway configuration generally isn't meant to do per-client at
that granularity. The two compose naturally: a common deployment runs
several BFFs, each doing client-specific aggregation, all sitting
behind one shared gateway that still handles cross-cutting concerns
(TLS termination, top-level auth) uniformly for all of them.

**Backend for Frontend vs. Gateway Aggregation.** Both combine several
downstream calls into one response, so the aggregation mechanics can
look identical — but the organizing principle differs. [Gateway
Aggregation](/docs/patterns/api-edge/gateway-aggregation) collapses a
fan-out into a single round trip primarily to cut chattiness and
latency, and the aggregated shape it returns is typically *generic* —
one composed response that any client can consume. A BFF aggregates in
service of one *specific* client's rendering needs: the same three
downstream calls might be filtered and reshaped one way for the mobile
BFF and another for the web BFF, because the point isn't just "fewer
round trips" but "exactly the payload this client type wants." Put
differently, gateway aggregation is a client-agnostic latency
optimization that can live in a shared gateway, while a BFF is a
client-specific shaping layer that deliberately splits per client — and
a BFF often *uses* aggregation internally as one of its tools.

## Code example

```rust
struct ProductDetails {
    id: String,
    name: String,
    description: String,
    price_cents: u32,
    in_stock: bool,
    review_count: u32,
}

// The full domain object every downstream service returns — the same
// data regardless of which BFF is calling.
fn fetch_product(id: &str) -> ProductDetails {
    ProductDetails {
        id: id.to_string(),
        name: "Wireless Headphones".into(),
        description: "Over-ear, active noise cancellation, 30h battery.".into(),
        price_cents: 24999,
        in_stock: true,
        review_count: 1204,
    }
}

// Mobile BFF: small payload, only what a mobile card view renders.
struct MobileProductCard {
    name: String,
    price_cents: u32,
    in_stock: bool,
}

fn mobile_bff_shape(id: &str) -> MobileProductCard {
    let p = fetch_product(id);
    MobileProductCard { name: p.name, price_cents: p.price_cents, in_stock: p.in_stock }
}

// Web BFF: richer payload, includes fields a desktop layout has room for.
struct WebProductPage {
    name: String,
    description: String,
    price_cents: u32,
    in_stock: bool,
    review_count: u32,
}

fn web_bff_shape(id: &str) -> WebProductPage {
    let p = fetch_product(id);
    WebProductPage {
        name: p.name,
        description: p.description,
        price_cents: p.price_cents,
        in_stock: p.in_stock,
        review_count: p.review_count,
    }
}
```

Both BFFs call the same `fetch_product`, but `mobile_bff_shape` drops
`description` and `review_count` entirely — fields the mobile card view
never renders — while `web_bff_shape` keeps them, showing each BFF
independently deciding what its one client actually needs from the same
underlying domain data.

## When to use it

- Different client types have meaningfully different data, bandwidth,
  or latency needs (e.g. mobile vs. desktop vs. smart-TV).
- Frontend teams want to iterate on their client's API without
  coordinating releases with other client teams.
- A shared generic API has accumulated client-specific branching logic
  that's becoming hard to maintain.

## When not to use it

- All clients need essentially the same data shape — a shared API is
  simpler and avoids duplicating aggregation logic across BFFs.
- The team is small enough that maintaining several BFFs (one per
  client type) is pure overhead rather than a coordination win.
- Adding a BFF just to avoid touching a shared backend, without an
  actual per-client shaping need, mostly adds an extra hop and a new
  service to operate.

## Use-case scenarios

**Streaming platform serving dozens of device types.** A video
streaming service ships apps for phones, smart TVs, game consoles, and
set-top boxes, each with wildly different screen real estate, input
methods, and network reliability. Rather than one generic catalog API
trying to fit all of them, each device family gets its own BFF: the
smart-TV BFF returns large-thumbnail, low-cardinality payloads suited
to a remote-control UI navigated row by row, while the mobile BFF
returns a denser, swipeable payload — both calling the same underlying
catalog and recommendation services, shaped completely differently.

**Airline booking flow split by web and mobile.** An airline's web
booking flow lets users compare many fares side by side in a dense
table and benefits from a single call that returns full fare rules,
baggage details, and seat-map data together. The mobile app, used
mostly for quick rebooking and check-in, needs a much smaller payload
and issues its own lighter-weight BFF calls tailored to a linear,
one-screen-at-a-time flow — letting the mobile team optimize
aggressively for payload size without renegotiating the web team's
richer contract.

**B2B marketplace exposing a partner integration BFF.** A wholesale
marketplace has an internal web app for its own operations staff and
also exposes programmatic access to enterprise partners who integrate
the marketplace into their own procurement systems. The partner-facing
BFF returns a stable, versioned, machine-oriented payload shape
designed for long-term API-contract stability, while the internal web
BFF can change its response shape freely alongside UI redesigns — the
two evolve on completely different cadences because they're separate
services, not shared endpoints on one general API.

## Related patterns

- [API Gateway](/docs/patterns/api-edge/api-gateway) — BFFs are often
  deployed behind a shared gateway that still handles cross-cutting
  concerns like auth and TLS termination for all of them.
- [Gateway Aggregation](/docs/patterns/api-edge/gateway-aggregation) —
  the client-agnostic latency optimization a BFF often uses internally;
  a BFF adds per-client shaping on top of the raw fan-out collapse.

## Further reading

- [Backends for Frontends pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/backends-for-frontends)
- [The BFF Pattern (Backend for Frontend): An Introduction — Sam Newman](https://samnewman.io/patterns/architectural/bff/)
