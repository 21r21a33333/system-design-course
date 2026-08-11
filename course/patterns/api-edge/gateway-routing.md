---
title: "Gateway Routing"
sidebar_position: 8
supplementary: true
---

Gateway Routing sends each incoming request from a single endpoint to
one specific backend service — typically chosen by path or header — so
clients can call one address without knowing the backend topology.

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
system evolves.

## How it works

The gateway exposes one public endpoint. For each incoming request, it
inspects some routing key — most commonly the URL path (`/orders/*` vs
`/users/*`), but sometimes a header, hostname, or query parameter — and
looks it up against a set of routing rules to decide which single
backend service should handle that request. It forwards the request
there largely as-is and relays the response back. Unlike a plain
reverse proxy in front of one service, a routing gateway holds rules
for many services at once and picks between them per request; unlike
[Gateway Aggregation](/docs/patterns/api-edge/gateway-aggregation), it
sends each request to exactly one backend rather than fanning it out to
several and merging the results.

## Code example

The snippet below shows the core routing decision: given a request
path, pick the single backend service that should handle it.

```rust
struct Request {
    path: String,
}

#[derive(Debug, PartialEq)]
enum Backend {
    Orders,
    Inventory,
    Users,
}

struct Route {
    prefix: &'static str,
    backend: Backend,
}

fn routing_table() -> Vec<Route> {
    vec![
        Route { prefix: "/orders", backend: Backend::Orders },
        Route { prefix: "/inventory", backend: Backend::Inventory },
        Route { prefix: "/users", backend: Backend::Users },
    ]
}

fn route(request: &Request, table: &[Route]) -> Option<Backend> {
    table
        .iter()
        .find(|route| request.path.starts_with(route.prefix))
        .map(|route| match route.backend {
            Backend::Orders => Backend::Orders,
            Backend::Inventory => Backend::Inventory,
            Backend::Users => Backend::Users,
        })
}

fn dispatch(request: Request) -> Result<String, &'static str> {
    let table = routing_table();
    match route(&request, &table) {
        Some(backend) => Ok(format!("routed {} to {:?}", request.path, backend)),
        None => Err("no matching route"),
    }
}
```

Each request produces exactly one `Backend`; adding a new service is a
one-line addition to `routing_table` with no change to `dispatch`
itself.

## When to use it

- Many backend services need to sit behind one public endpoint, and
  clients should be able to call it without knowing which service owns
  which resource.
- You want to be free to move, split, or rename backend services
  without breaking clients, as long as the routes they call stay
  stable.
- You need path- or header-based routing rules — for example, sending
  a fraction of traffic to a new version of a service (canary/blue-green
  style routing) without the client being aware.

## When not to use it

- There's only one backend service — there's nothing to route between,
  and a plain reverse proxy is simpler than a rules-based routing
  layer.
- Requests genuinely need data from more than one backend combined into
  a single response — that's [Gateway
  Aggregation](/docs/patterns/api-edge/gateway-aggregation), not plain
  routing, and building it as routing-only would push the merging work
  onto the client.
- The routing rules would need business-logic awareness (not just
  path/header matching) to decide where a request goes — that logic
  belongs in a service, not smeared across the edge routing layer.

## Real-world example

Kubernetes Ingress controllers and cloud load balancers commonly
implement gateway routing: a single external hostname fans out to
different backend services based on URL path or the `Host` header,
letting a team run `api.example.com/orders` and
`api.example.com/users` as entirely separate deployments behind one
public DNS name. Amazon API Gateway's route- and path-based mappings to
different Lambda functions or HTTP backends work the same way.

## Related patterns

- [API Gateway](/docs/patterns/api-edge/api-gateway) — Gateway Routing
  is the basic dispatch behavior a general-purpose API gateway
  performs; routing is usually the first decision a gateway makes
  before any aggregation or offloading happens.
- [Gateway Aggregation](/docs/patterns/api-edge/gateway-aggregation) —
  the fan-out counterpart to routing: routing sends a request to one
  backend, aggregation combines results from several into one response.

## Further reading

- [Gateway Routing pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/gateway-routing)
- [API management — Wikipedia](https://en.wikipedia.org/wiki/API_management)
