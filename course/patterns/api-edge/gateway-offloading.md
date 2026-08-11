---
title: "Gateway Offloading"
sidebar_position: 7
supplementary: true
---

Gateway Offloading moves shared, cross-cutting concerns — TLS
termination, authentication, rate limiting, caching, compression — out
of individual backend services and into the gateway, so no backend has
to reimplement them.

![Gateway Offloading diagram](/img/patterns/gateway-offloading.svg)

## Problem it solves

Concerns like terminating TLS, validating auth tokens, enforcing
quotas, and compressing responses aren't specific to any one service's
business logic, but if every service handles them independently, that
logic — and its certificates, libraries, and configuration — gets
duplicated across the whole fleet. Duplication means duplicated bugs: a
TLS misconfiguration or an auth check that's subtly wrong in one service
doesn't get fixed everywhere at once, and upgrading a shared dependency
(a TLS library version, a new token format) means touching every
service instead of one place. Each service also spends CPU and
complexity budget on plumbing that has nothing to do with what it
actually does. Offloading pulls these concerns into one specialized
layer so they're implemented once, consistently, and maintained in a
single place.

## Technical architecture & implementation

**The offloaded pipeline.** The gateway is configured to handle a fixed
set of shared concerns on behalf of every backend behind it, applied as
an ordered pipeline on the request's way in (and the response's way
out). Incoming HTTPS connections **terminate at the gateway**, which
holds the TLS certificate and forwards to backends over a trusted
internal network (plaintext or a simpler internal TLS). The gateway
**validates auth tokens** or session cookies before forwarding, so a
request that reaches a backend is already authenticated. It **enforces
rate limits and quotas** per client, **validates request shape** (size
limits, required headers), **decompresses** request bodies and
**compresses** responses, and **logs** uniformly. Backends are written
as if they're only ever called by a trusted, already-authenticated
caller on a private network — because that's exactly what the gateway
makes true.

**Why the edge is the right place.** Several of these concerns benefit
from being centralized specifically. TLS termination can use
**specialized hardware or offload cards** and a single certificate
rotation instead of a fleet-wide one. Rate limiting works best where
**every request from a client is visible** in one place — a per-client
budget enforced at the edge protects every backend at once (see the
[Rate Limiter](/docs/patterns/building-blocks/rate-limiter) and
[Throttling](/docs/patterns/building-blocks/throttling) building
blocks). A shared response **cache** at the gateway can serve repeated
reads without any backend being touched. Consistency is the throughline:
one implementation of auth, one of TLS, one of the quota policy, applied
identically to all traffic.

**The trust boundary.** Offloading TLS termination is only safe when
the network between gateway and backends is genuinely trusted.
Terminating TLS at the edge and forwarding plaintext across untrusted
infrastructure reintroduces exactly the exposure the gateway was meant
to remove. In zero-trust environments, backends re-authenticate the
gateway (mutual TLS internally) rather than assuming the private network
is safe — which is where a [Service
Mesh](/docs/patterns/api-edge/service-mesh) or per-instance
[Sidecar](/docs/patterns/api-edge/sidecar) often takes over the
last hop.

**Failure modes.** Centralizing concerns makes the gateway a
**higher-value target and a harder single point of failure**: a bug or
outage in gateway-level auth now takes down authentication for *every*
backend at once, so gateways run as a redundant fleet with their own
health checking. The subtler risk is **logic creep** — offloading is
meant for generic cross-cutting concerns, but it's tempting to keep
adding "just one more" bit of per-service special-casing until the
gateway accretes business logic, becomes a bottleneck every team must
coordinate through, and erodes the independent deployability the
backends were supposed to have. A third is a **cache or
compression correctness bug** at the edge silently affecting all
traffic (e.g. caching a personalized response, or double-compressing).

**Offloading vs. its siblings.** Offloading is the "move cross-cutting
concerns into the edge" facet of the umbrella [API
Gateway](/docs/patterns/api-edge/api-gateway) — closely related to
[Gateway Routing](/docs/patterns/api-edge/gateway-routing) (which
decides *where* a request goes) and [Gateway
Aggregation](/docs/patterns/api-edge/gateway-aggregation) (which
*combines* several backend calls), but distinct: offloading is about
*what work the gateway does on a request's behalf* rather than dispatch
or fan-out. It contrasts most sharply with the
[Sidecar](/docs/patterns/api-edge/sidecar) pattern: a sidecar offloads
the same kinds of concerns but **per instance**, co-located with each
service, whereas a gateway offloads them **centrally** for the whole
fleet. Central offloading gives one uniform policy and one place to
patch; sidecar offloading avoids the single choke point and keeps the
concern close to the service, at the cost of running a proxy alongside
every instance.

## What to offload (and what not to)

The line is whether the concern is *generic* (identical policy across
services, no per-service business meaning) or *service-specific*
(needs domain knowledge). Generic concerns belong at the gateway;
service-specific ones stay in the service.

| Offload to the gateway | Keep in the service |
| --- | --- |
| TLS termination & certificate management | Domain/business logic and validation |
| Authentication (token/cookie verification) | Fine-grained, resource-level authorization |
| Rate limiting & per-client quotas | Data ownership and persistence |
| Response caching of shareable reads | Caching of personalized/per-user results |
| Compression / decompression | Response *semantics* (what the data means) |
| Request-size limits & shape validation | Field-level, schema-specific validation |
| Centralized access logging | Business-event logging and metrics |

The gray zone is authorization: coarse "is this a valid, authenticated
identity" fits the gateway, but "is *this* user allowed to edit *this*
order" needs the service's own data and belongs there — pushing it into
the gateway is the classic logic-creep trap.

## Code example

The snippet below is the offload pipeline itself: TLS is already
terminated by the time this runs, and it strips request validation,
authentication, rate limiting, and decompression off the request so the
backend receives a plain, trusted `BackendRequest`.

```rust
use std::collections::HashMap;

// What the gateway sees off the wire, before it strips cross-cutting
// concerns off on the backend's behalf.
struct RawRequest {
    auth_token: Option<String>,
    body_compressed: bool,
    body_len: usize,
    path: String,
    client_id: String,
}

// What a backend service receives: TLS already terminated, caller
// already authenticated, body already decompressed and size-checked.
struct BackendRequest {
    user_id: u64,
    path: String,
    body: Vec<u8>,
}

const MAX_BODY_BYTES: usize = 1 << 20; // 1 MiB request-size limit

fn validate_token(token: &str) -> Option<u64> {
    // Stand-in for real verification (JWT signature, expiry, audience).
    if token == "valid-token" { Some(42) } else { None }
}

fn decompress(_body: &[u8]) -> Vec<u8> {
    vec![0u8; 8] // stand-in for a real inflate
}

struct Gateway {
    // Requests remaining this window, per client — offloaded rate
    // limiting so no backend re-implements a quota check.
    rate_budget: HashMap<String, u32>,
}

impl Gateway {
    // Runs once, centrally, on every request. Each concern is enforced
    // here and only here, so no backend behind the gateway repeats it.
    fn offload(&mut self, req: RawRequest, body: Vec<u8>) -> Result<BackendRequest, &'static str> {
        // 1. Request validation: reject oversized bodies at the edge.
        if req.body_len > MAX_BODY_BYTES {
            return Err("payload_too_large");
        }

        // 2. Authentication.
        let token = req.auth_token.ok_or("missing_auth_token")?;
        let user_id = validate_token(&token).ok_or("invalid_auth_token")?;

        // 3. Rate limiting per client.
        let remaining = self.rate_budget.entry(req.client_id).or_insert(100);
        if *remaining == 0 {
            return Err("rate_limited");
        }
        *remaining -= 1;

        // 4. Decompression, so the backend always gets a plain body.
        let body = if req.body_compressed { decompress(&body) } else { body };

        Ok(BackendRequest { user_id, path: req.path, body })
    }
}
```

Everything inside `offload` — TLS having already terminated, size
validation, token check, quota, decompression — is logic no backend
service writes or maintains. Each rejection also short-circuits before
the backend is ever consulted, so an oversized, unauthenticated, or
over-quota request never consumes backend capacity.

## When to use it

- Multiple backend services share the same cross-cutting concerns
  (TLS, auth, rate limiting, compression) and currently reimplement
  them independently.
- You want a single place to rotate TLS certificates, upgrade a crypto
  library, or patch an auth vulnerability, instead of coordinating a
  fleet-wide rollout across every service.
- Backend services should be simple to write and reason about, free of
  plumbing that isn't specific to their own business logic.

## When not to use it

- There's only one backend service, or services have genuinely
  different security/compression requirements that don't share cleanly
  — forcing them through one policy set adds friction rather than
  removing it.
- The internal network between gateway and backends isn't actually
  trusted — terminating TLS at the edge and running plaintext
  internally would then reintroduce the exposure the gateway was
  supposed to remove.
- The concern needs per-service business knowledge (resource-level
  authorization, personalized caching) — centralizing it in the gateway
  is logic creep that turns the edge into a bottleneck every team must
  coordinate changes through.

## Use-case scenarios

**Fleet-wide TLS termination and certificate rotation.** A company runs
forty microservices behind one gateway. Rather than provision, install,
and rotate a certificate on every service, TLS terminates at the
gateway on specialized hardware, and backends receive plain internal
traffic. When a certificate is renewed or a TLS library CVE lands, it's
one rotation at the edge — not forty coordinated deploys — and every
backend is fixed simultaneously.

**Centralized auth and quota for a public API.** A SaaS platform sells
API access under tiered plans. The gateway verifies each request's
token, enforces that plan's request-per-second quota, and rejects
oversized payloads — all before a request reaches any backend. The
pricing, orders, and reporting services behind it are written assuming
every request is already authenticated and within quota, so none of
them carries auth or rate-limiting code, and a policy change (a new tier,
a stricter limit) is a single edge config change.

**Edge caching and compression for a content API.** A media company's
read-heavy content API serves the same popular articles to millions of
clients. The gateway caches shareable GET responses and gzips them once
at the edge, so repeated reads are served without touching a backend and
without every service implementing its own compression. Personalized
endpoints are explicitly marked non-cacheable, keeping per-user data out
of the shared cache — the boundary that separates safe offloading from a
correctness bug.

## Related patterns

- [API Gateway](/docs/patterns/api-edge/api-gateway) — the umbrella
  pattern; offloading describes the specific cross-cutting
  responsibilities (TLS, auth, rate limiting, caching, compression) a
  gateway commonly takes on.
- [Gateway Routing](/docs/patterns/api-edge/gateway-routing) and
  [Gateway Aggregation](/docs/patterns/api-edge/gateway-aggregation) —
  the sibling gateway facets (dispatch and fan-out); offloading is the
  cross-cutting-concern facet, usually applied to the same traffic.
- [Sidecar](/docs/patterns/api-edge/sidecar) — offloads the same kinds
  of concerns **per instance** alongside each service, rather than
  **centrally** at the edge; the two are alternative placements of the
  same responsibilities.
- [Rate Limiter](/docs/patterns/building-blocks/rate-limiter) and
  [Throttling](/docs/patterns/building-blocks/throttling) — the
  quota-enforcement building blocks a gateway offloads on the fleet's
  behalf.
- [Service Mesh](/docs/patterns/api-edge/service-mesh) — pushes
  offloaded concerns (mTLS, retries, observability) into a
  per-instance data plane for east-west traffic, complementing the
  gateway's north-south edge.

## Further reading

- [Gateway Offloading pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/gateway-offloading)
- [TLS termination proxy — Wikipedia](https://en.wikipedia.org/wiki/TLS_termination_proxy)
- [What is TLS offloading? — Cloudflare Learning Center](https://www.cloudflare.com/learning/ssl/what-is-ssl-offloading/)
