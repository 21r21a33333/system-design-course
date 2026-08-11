---
title: "Reverse Proxy"
sidebar_position: 14
supplementary: true
---

A reverse proxy is a server that sits in front of one or more backend
services and intercepts every incoming request on their behalf,
forwarding each to a backend, then returning that backend's response
to the client as if the proxy itself had produced it.

![Reverse Proxy diagram](/img/patterns/reverse-proxy.svg)

## Problem it solves

Backend services generally shouldn't be exposed to the public internet
directly: doing so leaks their real network addresses and internal
topology to every caller, forces every individual service to
implement its own TLS termination, connection handling, and basic
abuse protection, and means that any operational change to how many
instances exist or where they run is directly visible to, and
potentially breaking for, external clients. A reverse proxy interposes
a single, stable component between clients and backends that absorbs
all of this: clients only ever see and connect to the proxy's address,
never a backend's, so backends can be added, removed, moved, or scaled
with no client-visible change at all. It also gives a single place to
implement functionality that would otherwise have to be duplicated in
every backend — terminating TLS once instead of in every service,
compressing responses once, serving cached or static content without
ever bothering a backend that would just return the same bytes.

## Technical architecture & implementation

**Termination and forwarding.** A reverse proxy fully terminates the
client's connection — for HTTPS traffic this means it holds the TLS
certificate and does the decrypt/encrypt work, so backend services
never need their own certificates or TLS configuration at all — reads
the request, decides (via configured rules: host header, path, or
simply because there's only one backend) which backend should handle
it, opens or reuses a separate connection to that backend, and relays
the request and eventually the response between the two sides. From
the client's perspective, the proxy *is* the server; from the
backend's perspective, the proxy is just another client, and the
backend typically never learns the original caller's real address
unless the proxy explicitly forwards it in a header.

NGINX is one of the most widely deployed pieces of software in this
role — originally built specifically as an HTTP server and reverse
proxy, it's since grown load-balancing and caching features on top,
which is itself a concrete illustration of how naturally those
capabilities layer onto a proxy's basic forward-and-return job. Envoy
is a newer, widely adopted alternative built around dynamic
configuration and rich observability, and is the proxy Istio uses as
its per-instance sidecar in its service mesh data plane.

**What a reverse proxy adds beyond forwarding.** Because every request
passes through it, a reverse proxy is a natural place to add
functionality that would otherwise need to be duplicated across every
backend it fronts: caching responses so a repeated request for the
same resource is served without reaching a backend at all,
compressing responses to save bandwidth, rewriting or filtering
headers, and applying basic protections — hiding backend addresses,
capping connections from a single client — before a request ever
reaches application code. Serving static assets is a particularly
common case: a reverse proxy can answer a request for an unchanging
file directly from its own cache or from disk, without forwarding it
to a backend that would do nothing but read and return the same
bytes, which is the same tier-separation idea covered in more depth on
the [Static Content Hosting](/docs/patterns/building-blocks/static-content-hosting)
page.

**One backend is enough.** A detail that's easy to miss: a reverse
proxy is useful even in front of a single backend instance, because
none of the benefits above — TLS termination, hiding the backend's
real address, caching, compression — depend on there being more than
one instance to choose between. That's the structural difference from
[Load Balancing](/docs/patterns/api-edge/load-balancing): load
balancing is specifically about *distributing* requests across
multiple functionally identical instances, which requires more than
one backend to mean anything, while a reverse proxy's other benefits
apply just as well with exactly one. In practice the two are
frequently combined in a single deployed component — a reverse proxy
in front of many backend instances that also happens to distribute
load across them — but they're separable concerns, and it's common to
run a reverse proxy with load-balancing logic disabled entirely, or a
load balancer that does no other proxying work at all.

**Failure modes.** A reverse proxy sitting in front of every request
to every backend it fronts becomes a concentration point: if it goes
down, everything behind it becomes unreachable even if every backend
instance is perfectly healthy. Production deployments account for
this by running several proxy instances behind a stable address (a
DNS record spread across them, or a lower-layer balancer in front of
the proxy tier itself) with health-checked
[failover](/docs/patterns/reliability/failover) between them, rather
than trusting a single instance to stay up indefinitely. A
misconfigured routing rule is a quieter failure mode: because the
proxy is the sole decision-maker for where a request goes, a bad rule
silently sends traffic to the wrong backend, or to none, in a way
that's invisible to clients until they notice broken behavior rather
than an outright connection failure.

**Reverse Proxy vs. API Gateway.** A reverse proxy is the general
infrastructure primitive: intercept requests, forward them to a
backend, return the response, optionally adding TLS termination,
caching, or compression along the way. [API
Gateway](/docs/patterns/api-edge/api-gateway) is a reverse proxy
*specialized* for fronting a set of APIs, layering API-management
concerns on top of plain proxying — authenticating callers, enforcing
per-client rate limits, aggregating or transforming responses from
multiple backend services into one client-facing shape, and versioning
routes. Every API gateway is, mechanically, a reverse proxy; not every
reverse proxy is an API gateway — a reverse proxy fronting a single
website with no authentication or per-client quotas is doing genuine
reverse-proxy work without any of the API-management layer that would
make it a gateway.

## Code example

```rust
#[derive(Clone, Debug)]
struct Backend {
    name: String,
    address: String,
}

struct ReverseProxy {
    backends: Vec<Backend>,
    // Requests for these paths are answered from the proxy's own
    // cache and never forwarded to a backend at all.
    cached_paths: Vec<String>,
}

enum ProxyOutcome {
    ServedFromCache,
    Forwarded { backend: String },
    NoRoute,
}

impl ReverseProxy {
    // Routes purely by host header — the simplest of several possible
    // rules (path and header-based routing are just as common).
    fn route(&self, host: &str, path: &str) -> ProxyOutcome {
        if self.cached_paths.iter().any(|p| p == path) {
            return ProxyOutcome::ServedFromCache;
        }
        match self.backends.iter().find(|b| b.name == host) {
            Some(backend) => ProxyOutcome::Forwarded { backend: backend.address.clone() },
            None => ProxyOutcome::NoRoute,
        }
    }
}
```

`route` shows the proxy's core decision in miniature: a cache hit is
answered without ever consulting a backend, a recognized host is
forwarded to that backend's real address (which the client never
sees), and anything unrecognized is rejected before it reaches any
backend at all.

## When to use it

- Backend services shouldn't be directly reachable from the public
  internet, and clients should only ever see one stable, public-facing
  address regardless of how many backend instances exist behind it.
- TLS termination, compression, or caching should happen once, in one
  place, instead of being implemented redundantly inside every backend
  service.
- Backend topology needs to change freely — instances added, removed,
  or replaced — without that change being visible to, or breaking,
  any client.

## When not to use it

- A client needs to talk directly to a specific backend for a reason
  that a proxy would interfere with (certain low-level protocols, or a
  requirement for true end-to-end TLS terminated only at the backend
  itself) — adding a proxy in the middle actively breaks the
  requirement rather than serving it.
- The system is simple enough — one backend, internal-only traffic,
  no caching or TLS-termination need — that the extra hop and
  component to operate isn't earning its cost yet.
- The team can't commit to running the proxy itself redundantly — a
  single reverse proxy instance becomes a single point of failure for
  every backend it fronts, which can make availability worse rather
  than better if it's not treated with the same operational care as
  the backends it protects.

## Use-case scenarios

**Public website with TLS termination.** A company runs several
internal web-application instances that speak plain HTTP internally.
A reverse proxy holds the public TLS certificate, terminates HTTPS
from the internet, and forwards decrypted requests to the internal
instances over a private network — no individual instance needs its
own certificate or public exposure.

**Multi-tenant SaaS routing by hostname.** A SaaS platform serves many
customers, each with their own subdomain, from a shared pool of
backend services. A reverse proxy reads the `Host` header on every
incoming request and routes `customer-a.example.com` and
`customer-b.example.com` to the correct backend deployment, letting
the platform add or move a customer's backend without the customer's
DNS or client configuration ever changing.

**Static site with a single origin server.** A small content site runs
on a single application server with no need for load distribution
across multiple instances at all, but still puts a reverse proxy in
front of it purely for TLS termination, response compression, and
serving cached copies of frequently requested pages — demonstrating
that reverse-proxy value doesn't require more than one backend to be
worthwhile.

## Related patterns

- [API Gateway](/docs/patterns/api-edge/api-gateway) — a reverse proxy
  specialized with API-management concerns (auth, per-client rate
  limiting, response aggregation) layered on top of the same
  underlying forward-and-return mechanics.
- [Load Balancing](/docs/patterns/api-edge/load-balancing) — a
  distinct concern that requires multiple backend instances to mean
  anything; reverse-proxy benefits like TLS termination and caching
  apply even with exactly one backend, though the two are frequently
  combined in the same deployed component.
- [Static Content Hosting](/docs/patterns/building-blocks/static-content-hosting) —
  the tier-separation idea a reverse proxy's own caching and
  static-file serving is a lighter-weight version of.
- [Reverse Proxy — concept overview](/docs/concepts/reverse-proxy) —
  this site's earlier primer-derived treatment of reverse proxies, for
  further background.

## Further reading

- [Reverse proxy — Wikipedia](https://en.wikipedia.org/wiki/Reverse_proxy)
- [API Management overview — Microsoft Learn](https://learn.microsoft.com/en-us/azure/architecture/best-practices/api-implementation)
- DesignGurus' System Design Patterns course covers this as "Reverse Proxy" in its The Entry Point (API and Edge) module.
- [System Design roadmap — roadmap.sh](https://roadmap.sh/system-design) — includes Reverse Proxy as a named topic.
