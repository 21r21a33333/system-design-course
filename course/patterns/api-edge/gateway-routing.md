---
title: "Gateway Routing"
sidebar_position: 8
supplementary: true
---

Gateway Routing sends each incoming request from a single endpoint to
one specific backend service — typically chosen by path, host, or
header — so clients can call one address without knowing the backend
topology.

![Gateway Routing diagram](/img/patterns/gateway-routing.svg)

## Problem it solves

A system built from many backend services still wants to present
clients with one stable address to call. Without a routing layer,
clients would need to know the network location of every service
individually — which breaks the moment a service moves, is split in
two, or is renamed, since every client has to be updated in lockstep.
It also leaks internal structure to the outside world: clients
shouldn't need to care that "orders" and "inventory" happen to be
separate services today, especially if that's likely to change as the
system evolves. Gateway Routing puts one stable, public-facing address
in front of the fleet and turns "which service owns this request" into
a configuration decision made at the edge rather than knowledge baked
into every client.

## Technical architecture & implementation

**The route table.** The heart of a routing gateway is an ordered
table of rules, each pairing a match condition with a backend target.
The most common match key is the URL path prefix (`/orders/*` vs
`/users/*`), but the same mechanism keys off the `Host` header (so
`orders.example.com` and `users.example.com` share one gateway),
arbitrary headers (`X-API-Version: 2`), the HTTP method, or a query
parameter. Rules are evaluated **in order, first match wins**, which
makes ordering load-bearing: a specific rule like `/orders/export`
must appear before the general `/orders` rule, or the general rule
shadows it and the export traffic silently lands on the wrong pool.

**Backend service pools.** A route target is rarely a single instance —
it names a *pool* of interchangeable instances of one service. This is
the clean seam between routing and [load
balancing](/docs/patterns/api-edge/load-balancing): the gateway's
routing stage decides *which service* (`/orders` → the orders pool),
and the load-balancing stage decides *which instance within that pool*
handles the request. Conflating the two is a common source of
confusion — routing is the "what," load balancing is the "how many."

**Health-aware routing.** A production gateway does not route blindly
to a configured target; it consults a
[health-check](/docs/patterns/observability/health-check) view of each
pool and skips instances (or whole pools) currently marked down,
falling through to a healthy alternative where one exists. This keeps a
single crashed instance from becoming a wall of 502s: the request is
steered to a live peer instead of a dead target the route table still
lists.

**Versioned, canary, and blue-green routing.** Because the gateway is
the one place every request passes through, it's the natural control
point for progressive delivery. A route can split matched traffic by
weight — send 5% of `/orders` calls to `orders-v2` and the rest to
`orders-v1` — implementing a
[canary](/docs/patterns/observability/canary-deployment) or
[blue-green](/docs/patterns/observability/blue-green-deployment)
rollout that the client never sees. The split should be **deterministic
per request** (hash the request or user ID into the 0–100 bucket)
rather than random per call, so a client and its retries stay pinned to
one version and don't flap between old and new mid-session.

**Rewrite and redirect.** Routing often includes light path
manipulation: stripping a public prefix before forwarding
(`/api/orders/42` → `/42` for the orders pool), or issuing a redirect
for a moved or deprecated route. This stays firmly on the "no business
logic" side of the line — it reshapes the address, not the payload.

**Failure modes.** The dominant risk is **misrouting**: an
overly-broad or mis-ordered prefix that silently sends traffic to the
wrong backend, which surfaces not as an error but as subtly wrong
responses. Closely related is **route-table drift** — the deployed
table diverging from what operators believe is deployed, usually after
a hand-edit or a partially-applied config push, so a route points at a
pool that was renamed or retired. A third is the gateway's own
availability: sitting on every request's path, it concentrates failure,
which is why routing gateways run as a redundant fleet behind their own
load balancing rather than a single instance.

**Gateway Routing vs. its siblings.** Routing is the L7 dispatch facet
of the umbrella [API Gateway](/docs/patterns/api-edge/api-gateway):
sending each request to *the correct one* backend. It differs from a
plain [Reverse Proxy](/docs/patterns/api-edge/reverse-proxy), which
typically fronts one origin and forwards paths without a multi-service
rule table; from [load
balancing](/docs/patterns/api-edge/load-balancing), which spreads load
across identical instances of *one* service rather than choosing
*which* service; and from [Gateway
Aggregation](/docs/patterns/api-edge/gateway-aggregation), which fans
one request out to *several* backends and merges the results instead of
picking exactly one.

## Route table example

A routing gateway's behavior is fully described by its table. A small
one might read:

| Match (first-wins order) | Backend pool | Notes |
| --- | --- | --- |
| `Host: admin.example.com` | `admin-ui` | Host-based split |
| `/orders/export` | `orders-batch` | Specific path before general |
| `/orders/*` (90%) | `orders-v1` | Stable pool |
| `/orders/*` (10%) | `orders-v2` | Canary slice |
| `/users/*` | `users-v1` | Path prefix |
| `/*` | `web` | Catch-all fallback |

The ordering is the contract: move the `/orders/*` rule above
`/orders/export` and the export traffic is captured by the general rule
and never reaches the batch pool.

## Code example

The snippet below shows a route resolver with the two behaviors that
distinguish a real routing gateway from a static lookup: a weighted
**canary split** and **health-aware fallthrough** that skips a pool
that's currently down.

```rust
use std::collections::HashMap;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Health { Up, Down }

// One entry per route. Traffic is split between a stable pool and an
// optional canary pool by a weight (0..=100 percent).
struct Route {
    prefix: &'static str,
    stable: &'static str,
    canary: Option<&'static str>,
    canary_weight: u8,
}

struct Router {
    // Order matters: first matching prefix wins, so more specific
    // prefixes must be listed before their more general parents.
    routes: Vec<Route>,
    health: HashMap<&'static str, Health>,
}

impl Router {
    // `roll` is a caller-supplied 0..100 value (a hash of the request id
    // in production) so canary selection is deterministic per request,
    // not random per retry.
    fn resolve(&self, path: &str, roll: u8) -> Result<&'static str, &'static str> {
        let route = self
            .routes
            .iter()
            .find(|r| path.starts_with(r.prefix))
            .ok_or("no_route")?;

        // Prefer the canary only when it exists, the roll falls in its
        // slice, AND it is currently healthy — otherwise fall through to
        // stable. Health-aware routing skips a pool that is down instead
        // of blindly honoring the weight.
        let chosen = match route.canary {
            Some(canary)
                if roll < route.canary_weight
                    && self.health.get(canary) == Some(&Health::Up) =>
            {
                canary
            }
            _ => route.stable,
        };

        match self.health.get(chosen) {
            Some(Health::Up) => Ok(chosen),
            _ => Err("all_pools_down"),
        }
    }
}
```

Each request resolves to exactly one pool. A 10%-weighted canary sends
low rolls to `orders-v2` and everything else to `orders-v1`; if the
canary pool goes unhealthy, the same call falls through to stable
rather than erroring — the routing decision degrades instead of
breaking.

## When to use it

- Many backend services need to sit behind one public endpoint, and
  clients should be able to call it without knowing which service owns
  which resource.
- You want to be free to move, split, or rename backend services
  without breaking clients, as long as the routes they call stay
  stable.
- You need path-, host-, or header-based routing rules — for example,
  sending a fraction of traffic to a new version of a service
  (canary/blue-green style routing) without the client being aware.

## When not to use it

- There's only one backend service — there's nothing to route between,
  and a plain [Reverse Proxy](/docs/patterns/api-edge/reverse-proxy) is
  simpler than a rules-based routing layer.
- Requests genuinely need data from more than one backend combined into
  a single response — that's [Gateway
  Aggregation](/docs/patterns/api-edge/gateway-aggregation), not plain
  routing, and building it as routing-only would push the merging work
  onto the client.
- The routing rules would need business-logic awareness (not just
  path/host/header matching) to decide where a request goes — that
  logic belongs in a service, not smeared across the edge routing
  layer, where it becomes a shared bottleneck every team must
  coordinate through.

## Use-case scenarios

**One hostname fanning out to independent teams.** A platform runs
`api.example.com/orders` and `api.example.com/users` as entirely
separate deployments owned by different teams, behind one public DNS
name. A Kubernetes Ingress or cloud load balancer inspects the URL path
and dispatches each request to the matching service, so either team can
redeploy, rename their internal service, or split it into two without
the client — or the other team — noticing anything change.

**Canary rollout of a rewritten service.** The orders team has
rewritten their service and wants real production traffic before
committing. They add an `orders-v2` pool and configure the gateway to
route 5% of `/orders` traffic to it, hashed by user ID so each user
sticks to one version. They watch v2's error rate and latency, ramp to
25%, then 100%, and if metrics regress they set the weight back to 0 —
a rollback that's a config change at the edge, with no client release
and no redeploy of the stable pool.

**Host-based multi-tenant edge.** A SaaS product serves each customer
under `{tenant}.app.example.com`. The gateway routes by the `Host`
header to the right tenant-scoped backend (or the right regional
cluster), while a catch-all rule sends the bare marketing domain to the
static site. Adding a tenant is a route-table entry, not a new
public-facing address.

## Related patterns

- [API Gateway](/docs/patterns/api-edge/api-gateway) — the umbrella
  pattern; Gateway Routing is the L7 dispatch facet a general-purpose
  gateway performs, usually the first decision it makes before any
  aggregation or offloading.
- [Gateway Aggregation](/docs/patterns/api-edge/gateway-aggregation) —
  the fan-out counterpart: routing sends a request to one backend,
  aggregation combines results from several into one response.
- [Reverse Proxy](/docs/patterns/api-edge/reverse-proxy) — the simpler
  single-origin forwarder a routing gateway generalizes into a
  multi-service rule table.
- [Load Balancing](/docs/patterns/api-edge/load-balancing) — picks
  *which instance* within the pool a route names; routing picks *which
  pool*.
- [Canary Deployment](/docs/patterns/observability/canary-deployment)
  and [Blue-Green
  Deployment](/docs/patterns/observability/blue-green-deployment) —
  progressive-delivery strategies a weighted route table implements at
  the edge.

## Further reading

- [Gateway Routing pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/gateway-routing)
- [Ingress — Kubernetes documentation](https://kubernetes.io/docs/concepts/services-networking/ingress/)
- [Amazon API Gateway — route request to backend integrations (AWS docs)](https://docs.aws.amazon.com/apigateway/latest/developerguide/welcome.html)
