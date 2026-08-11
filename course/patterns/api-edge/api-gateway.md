---
title: "API Gateway"
sidebar_position: 1
supplementary: true
---

An API gateway is a single entry point that sits in front of a set of
backend services, handling cross-cutting concerns — authentication, rate
limiting, routing, and request/response transformation — so individual
services don't each have to reimplement them.

![API Gateway diagram](/img/patterns/api-gateway.svg)

## Problem it solves

When clients call backend services directly, every service ends up
duplicating the same plumbing: verifying auth tokens, enforcing rate
limits, logging requests, and translating between the client's preferred
protocol and whatever the service speaks internally. That duplication is
error-prone (each team implements auth slightly differently) and it
leaks internal topology to the outside world — clients need to know
which of dozens of services to call for which piece of functionality,
and any internal refactor (splitting or merging services) becomes a
breaking change for every client.

## Technical architecture & implementation

**Request pipeline.** A gateway processes every inbound request through
an ordered chain of stages, each of which can short-circuit the
request before it reaches a backend. A typical order is: TLS
termination, authentication (validating a token or API key),
authorization (does this identity have permission for this route),
rate limiting (has this client exceeded its quota), routing (which
backend or backends handle this path), and finally request
transformation (reshaping the payload into what the backend expects)
before forwarding. Each stage rejecting early matters operationally —
an unauthenticated request never consumes a backend's capacity or
counts against a rate limit meant for legitimate traffic, because it's
turned away at the authentication stage, before routing is even
evaluated.

**Routing and aggregation.** The routing stage matches the incoming
path (and sometimes method, host header, or a version segment) against
a table of rules mapping to backend services, similar in spirit to the
routing a plain [Reverse Proxy](/docs/patterns/api-edge/reverse-proxy)
performs but keyed to API resources rather than arbitrary paths. Beyond
simple one-to-one forwarding, a gateway can implement **aggregation**:
a single client-facing endpoint fans out to several backend services in
parallel, and the gateway combines their responses into one payload
before returning it — sparing the client several round trips for data
that's conceptually one screen's worth of information. This only pays
off when the fanned-out calls are independent of each other; if one
downstream call depends on another's result, the gateway is doing
sequential orchestration rather than aggregation, which is a heavier
and slower operation to run on the request's critical path.

**Rate limiting and quota enforcement.** Because the gateway sees every
request from every client, it's the natural place to enforce per-client
quotas — a request counter (often a sliding window or token bucket) is
checked and updated per identified client before the request is
allowed to proceed. This protects backends from a single misbehaving
or overly aggressive caller without every backend needing its own
awareness of who's calling it; a backend service behind the gateway can
generally assume any request that reaches it already passed rate
limiting, rather than re-implementing the check itself.

**Failure modes.** Because the gateway sits on every request's path, it
concentrates failure risk in a way individual backends don't: if the
gateway itself is down, every backend behind it becomes unreachable
even though each one is individually healthy, which is why gateway
deployments are run as a redundant fleet behind their own load
balancing rather than a single instance. A subtler failure is
**aggregation partial failure** — if a gateway fans a request out to
three backends and one times out, the gateway has to decide whether to
fail the whole client request, return a partial response with the
failure noted, or retry just the failed leg; naively blocking on all
three with no timeout budget of its own means one slow backend can
stall every aggregated request that touches it, well beyond that
backend's own latency budget. A third failure mode is **gateway logic
creep**: once business logic beyond pure routing and auth starts
accumulating in gateway configuration or plugin code, every team
depending on that logic now needs to coordinate through the gateway's
release process, which erodes the independent-deployability the
backend services behind it were supposed to have.

**API Gateway vs. Reverse Proxy.** An [API
Gateway](/docs/patterns/api-edge/api-gateway) is, mechanically, a
[Reverse Proxy](/docs/patterns/api-edge/reverse-proxy) — it terminates
client connections and forwards to a backend exactly as a plain reverse
proxy does — with an API-management layer added on top: per-client
authentication and authorization, request/response transformation, and
aggregation across multiple backend calls, rather than just forwarding
bytes. Every API gateway is a reverse proxy underneath; a reverse proxy
fronting a single website with no per-client auth or aggregation logic
is doing genuine proxy work without qualifying as a gateway.

**API Gateway vs. Backend for Frontend.** Both sit between clients and
backend services, but a single API gateway is normally one shared
component serving every client type with the same routing and
transformation rules, while [Backend for
Frontend](/docs/patterns/api-edge/backend-for-frontend) splits that
layer per client type specifically so each one can shape responses
differently without the others' requirements interfering. The two
compose rather than compete: it's common to run several BFFs behind one
shared gateway, with the gateway handling cross-cutting concerns
(TLS, auth) uniformly and each BFF handling client-specific shaping.

**API Gateway vs. Service Mesh.** Both intercept traffic and enforce
cross-cutting concerns without each service reimplementing them, which
invites confusion — but they sit on different axes of traffic. An API
gateway handles **north-south** traffic: requests entering the system
from outside clients, where per-client authentication, quotas, and a
stable public contract matter most. A
[Service Mesh](/docs/patterns/api-edge/service-mesh) handles
**east-west** traffic: the calls services make to each other inside the
system, where mutual TLS between workloads, retries, and traffic
shaping for canary rollouts matter most. They are complementary layers,
not alternatives — a system commonly runs a gateway at its edge for
inbound client traffic and a mesh internally for service-to-service
calls, and neither removes the need for the other.

## Code example

```rust
use std::collections::HashMap;

#[derive(Clone, Debug)]
struct Route {
    path_prefix: String,
    backend: String,
}

#[derive(Debug, PartialEq)]
enum GatewayOutcome {
    Rejected(&'static str),
    Forwarded { backend: String },
}

struct ApiGateway {
    routes: Vec<Route>,
    // Requests remaining this window, per client ID.
    rate_budget: HashMap<String, u32>,
}

impl ApiGateway {
    // Each stage can short-circuit before a backend is ever consulted:
    // an unauthenticated or over-quota request never reaches routing.
    fn handle(&mut self, client_id: &str, token_valid: bool, path: &str) -> GatewayOutcome {
        if !token_valid {
            return GatewayOutcome::Rejected("unauthenticated");
        }

        let remaining = self.rate_budget.entry(client_id.to_string()).or_insert(100);
        if *remaining == 0 {
            return GatewayOutcome::Rejected("rate_limited");
        }
        *remaining -= 1;

        match self.routes.iter().find(|r| path.starts_with(&r.path_prefix)) {
            Some(route) => GatewayOutcome::Forwarded { backend: route.backend.clone() },
            None => GatewayOutcome::Rejected("no_route"),
        }
    }
}
```

`handle` mirrors the real pipeline order: authentication first, then
rate limiting, then routing — each check rejects before the more
expensive work below it runs, so a client that's already over quota
never causes a routing-table lookup, let alone a backend call.

## When to use it

- Multiple independent client types (web, mobile, partners) need a
  stable, unified entry point into a system built from many services.
- Cross-cutting concerns (auth, rate limiting, TLS termination) should
  be enforced consistently in one place rather than reimplemented per
  service.
- You want to hide internal service topology so it can evolve — split,
  merge, or rewrite services — without breaking external clients.

## When not to use it

- A small system with one or two services gets little benefit from an
  extra network hop and a new component to operate.
- The gateway is at risk of accumulating actual business logic (not
  just routing/auth) — once that happens it becomes a monolithic
  bottleneck that every team must coordinate changes through, which
  defeats the purpose of having independently deployable services
  behind it.
- Extremely latency-sensitive internal service-to-service calls, where
  the added hop through the gateway isn't justified.

## Use-case scenarios

**Ride-hailing platform unifying dozens of microservices.** A
ride-hailing company runs separate services for trip matching, pricing,
driver location, and payments, each independently deployable. The
mobile app talks to a single API gateway that authenticates the rider,
enforces per-rider rate limits on location-polling endpoints (to stop a
buggy client from hammering the location service), and routes
`/trips/*` and `/payments/*` to their respective backends — letting the
platform split, merge, or rewrite any of those services without ever
changing the app's client code or its one configured endpoint.

**Financial data provider metering third-party API access.** A market
data company sells API access to trading firms under different pricing
tiers, each with a contracted request-per-second quota. The gateway
identifies each caller by API key, enforces that firm's specific quota
before any request reaches the pricing-data backend, and logs
per-client usage centrally for billing — none of which the pricing
service itself needs to know about, since a request that reaches it has
already passed authentication and quota enforcement.

**Retail platform aggregating a product page.** An e-commerce site's
product page needs pricing, inventory availability, and personalized
recommendations, each served by a separate backend team's service. The
gateway exposes one `/products/{id}/page` endpoint that fans out to all
three backends in parallel and merges their responses into a single
payload, sparing the mobile client three separate round trips (and
three separate timeout budgets to manage) for what the user experiences
as one screen loading.

## Production libraries & getting started

You rarely build a gateway from scratch — you pick an existing one and
configure routes, auth, and rate limits as data. These are the production
gateways teams actually run:

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| Kong Gateway | Lua / C (on NGINX/OpenResty) | Plugin-driven gateway: auth, rate limiting, transformations, observability | [Kong Gateway docs](https://docs.konghq.com/gateway/latest/) |
| Envoy | C++ | High-performance L7 proxy and gateway core (also the data plane behind many meshes) | [Envoy docs](https://www.envoyproxy.io/docs/envoy/latest/) |
| Amazon API Gateway | Managed (AWS) | Fully managed REST/HTTP/WebSocket gateway with auth, throttling, and usage plans | [Amazon API Gateway docs](https://docs.aws.amazon.com/apigateway/latest/developerguide/welcome.html) |
| Apigee | Managed (Google Cloud) | Enterprise API management: gateway, developer portal, analytics, monetization | [Apigee docs](https://cloud.google.com/apigee/docs) |
| Tyk | Go | Open-source gateway with a dashboard, developer portal, and GraphQL support | [Tyk docs](https://tyk.io/docs/) |
| KrakenD | Go | Stateless, declarative gateway focused on aggregation and high throughput | [KrakenD docs](https://www.krakend.io/docs/) |
| Spring Cloud Gateway | Java | Programmatic gateway for Spring/JVM stacks with reactive routing and filters | [Spring Cloud Gateway docs](https://docs.spring.io/spring-cloud-gateway/reference/) |

**Example / reference:** [Envoy docs](https://www.envoyproxy.io/docs/envoy/latest/)

## Related patterns

- [Reverse Proxy](/docs/patterns/api-edge/reverse-proxy) — the broader
  pattern covering the proxying mechanism an API gateway is built on.
- [Backend for Frontend](/docs/patterns/api-edge/backend-for-frontend) —
  a variant that splits the gateway per client type instead of sharing
  one gateway across all clients.

## Further reading

- [API management — Wikipedia](https://en.wikipedia.org/wiki/API_management)
- [What is Amazon API Gateway? — AWS docs](https://docs.aws.amazon.com/apigateway/latest/developerguide/welcome.html)
- [Gateway Aggregation pattern — Microsoft Learn](https://learn.microsoft.com/en-us/azure/architecture/patterns/gateway-aggregation)
