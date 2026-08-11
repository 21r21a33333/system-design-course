---
title: "Gateway Offloading"
sidebar_position: 7
supplementary: true
---

Gateway Offloading moves shared, cross-cutting concerns — SSL/TLS
termination, authentication, compression — out of individual backend
services and into the gateway, so no backend has to reimplement them.

![Gateway Offloading diagram](/img/patterns/gateway-offloading.svg)

## Problem it solves

Concerns like terminating TLS, validating auth tokens, and compressing
responses aren't specific to any one service's business logic, but if
every service handles them independently, that logic — and its
certificates, libraries, and configuration — gets duplicated across the
whole fleet. Duplication means duplicated bugs: a TLS misconfiguration
or an auth-check that's subtly wrong in one service doesn't get fixed
everywhere at once, and upgrading a shared dependency (a TLS library
version, a new auth token format) means touching every service instead
of one place. Each service also spends CPU and complexity budget on
plumbing that has nothing to do with what it actually does.

## How it works

The gateway is configured to handle a specific set of shared concerns
on behalf of every backend behind it. Incoming HTTPS connections
terminate at the gateway, which holds the TLS certificate and forwards
requests to backends over a trusted internal network (often
unencrypted or with simpler internal TLS). The gateway validates auth
tokens or session cookies before forwarding, so a request that reaches
a backend has already been authenticated. It can decompress request
bodies and compress responses on the way back out, and enforce other
shared policy — request size limits, standard security headers —
uniformly. Backend services are written as if they're only ever called
by a trusted, already-authenticated caller on a private network,
because that's exactly what the gateway makes true.

## Code example

The snippet below shows the shape of the decision: which concerns the
gateway strips off a request before a backend ever sees it, versus what
a backend service handler looks like once those concerns are gone.

```rust
struct RawRequest {
    tls_client_hello: bool,
    auth_token: Option<String>,
    body_compressed: bool,
    path: String,
}

struct BackendRequest {
    // TLS is already terminated, auth already checked, body already
    // decompressed — the backend only sees a plain, trusted request.
    user_id: u64,
    path: String,
    body: Vec<u8>,
}

fn validate_token(token: &str) -> Option<u64> {
    // Stand-in for real token verification (JWT signature, expiry, etc.).
    if token == "valid-token" { Some(42) } else { None }
}

fn decompress(_body: &[u8]) -> Vec<u8> {
    vec![] // stand-in
}

// Runs once, in the gateway, on every request — not duplicated per service.
fn offload(request: RawRequest, body: Vec<u8>) -> Result<BackendRequest, &'static str> {
    let token = request.auth_token.ok_or("missing auth token")?;
    let user_id = validate_token(&token).ok_or("invalid auth token")?;

    let body = if request.body_compressed {
        decompress(&body)
    } else {
        body
    };

    Ok(BackendRequest { user_id, path: request.path, body })
}
```

Everything inside `offload` — TLS having already terminated, token
validation, decompression — is logic no backend service has to write
or maintain; each one just receives an already-clean `BackendRequest`.

## When to use it

- Multiple backend services share the same cross-cutting concerns
  (TLS, auth, compression, rate limiting) and currently reimplement
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
  trusted (e.g. it spans untrusted infrastructure) — terminating TLS at
  the edge and running plaintext internally would then reintroduce the
  exposure the gateway was supposed to remove.
- Centralizing these concerns makes the gateway a much higher-value
  target and a harder single point of failure: a bug or outage in
  gateway-level auth now affects every backend behind it at once,
  which needs to be weighed against the duplication it avoids.

## Real-world example

Cloud load balancers and API gateways commonly terminate TLS at the
edge — AWS Application Load Balancer and API Gateway, for instance,
handle certificate management and TLS termination centrally, so
backend targets receive plain HTTP (or simpler internal TLS) and never
handle a certificate themselves. The same gateways typically validate
an auth token or API key before a request is ever forwarded, so
backend services can assume every request they receive is already
authenticated.

## Related patterns

- [API Gateway](/docs/patterns/api-edge/api-gateway) — Gateway
  Offloading describes a specific set of responsibilities (TLS, auth,
  compression) that an API gateway commonly takes on; it's one facet
  of what a gateway does, not a separate component.

## Further reading

- [Gateway Offloading pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/gateway-offloading)
- [TLS termination proxy — Wikipedia](https://en.wikipedia.org/wiki/TLS_termination_proxy)
