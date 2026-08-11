---
title: "Ambassador"
sidebar_position: 1
supplementary: true
---

The Ambassador pattern deploys a small helper process alongside a
client application — typically as a sidecar container in the same pod
— that intercepts and handles all of the client's *outbound* network
calls, so the client's own code stays free of retry loops, TLS setup,
and connection-level monitoring.

![Ambassador diagram](/img/patterns/ambassador.svg)

## Problem it solves

Every service that calls another service over the network eventually
needs the same handful of things: retries with backoff, TLS
termination or mutual TLS, connection pooling, timeouts, and metrics
on outbound calls. Implementing that logic inside the application
means either writing it once per language/framework the organization
uses, or pulling in a client library that has to be kept in sync
across every service. Either way, upgrading the retry policy means
redeploying application code that has nothing to do with the change.
The Ambassador pattern moves that logic into a separate process the
application talks to over `localhost`, so the network-handling logic
can be written once, in one language, and upgraded independently of
the application it serves.

## How it works

The client application is configured to send its outbound requests to
`localhost` instead of the real remote endpoint. The ambassador
process, running in the same pod or on the same host, receives that
local call and does the real work: it resolves the actual remote
address, opens (and pools) the TLS connection, retries on transient
failures, trips a circuit breaker if the remote service is unhealthy,
and emits latency/error metrics — then returns the response to the
client exactly as if the client had called the remote service
directly. The client application never sees any of this; as far as it
knows, it made one simple local call. Because the ambassador is a
separate process, it can be upgraded, restarted, or replaced without
touching the application's code or its deploy pipeline.

## Code example

The snippet below shows what an ambassador does conceptually: wrap a
single outbound call in a retry loop with backoff, so the caller only
ever sees a plain `Result`.

```rust
use std::{thread, time::Duration};

struct Ambassador {
    max_retries: u32,
    backoff: Duration,
}

impl Ambassador {
    fn call(&self, request: &str) -> Result<String, String> {
        let mut last_err = String::new();

        for attempt in 0..=self.max_retries {
            match send_request(request) {
                Ok(response) => return Ok(response),
                Err(e) => {
                    last_err = e;
                    if attempt < self.max_retries {
                        thread::sleep(self.backoff * (attempt + 1));
                    }
                }
            }
        }

        Err(format!("all retries exhausted: {last_err}"))
    }
}

// Stands in for the real network call the ambassador makes on the
// client's behalf (TLS handshake, connection pool, etc.).
fn send_request(_request: &str) -> Result<String, String> {
    Err("connection reset".to_string())
}
```

The client application would only ever call `Ambassador::call`; it
never implements the retry loop or backoff policy itself.

## When to use it

- Multiple services, possibly in different languages, need the same
  outbound network resilience (retries, TLS, circuit breaking) and you
  want to implement and upgrade that logic exactly once.
- You're introducing network-level concerns like mTLS or observability
  into an existing application without touching its code.
- The team operating the network layer is different from the team
  owning application logic, and each wants to deploy independently.

## When not to use it

- A single application with simple, low-volume outbound calls — the
  extra process and local network hop add operational complexity that
  isn't worth it for one caller.
- Ultra-low-latency paths where even a local hop to the ambassador
  process is an unacceptable cost.
- The organization already runs a full service mesh — adding
  per-service ambassadors on top duplicates what the mesh's sidecar
  proxies already do.

## Real-world example

Kubernetes commonly implements the Ambassador pattern as a sidecar
container in the same pod as the application container, sharing the
pod's network namespace so the application can reach the ambassador on
`localhost`. Linkerd's early versions and various database-proxy
sidecars (e.g., a local proxy in front of a cloud SQL instance) follow
this exact shape: the application connects to `localhost`, and the
sidecar handles the real, secured connection to the remote endpoint.

## Related patterns

- [Sidecar](/docs/patterns/api-edge/sidecar) — the deployment mechanism
  an ambassador uses; the distinction is that Sidecar is the general
  co-located-helper-process pattern, while Ambassador specifically
  proxies the client's outbound calls.
- [Service Mesh](/docs/patterns/api-edge/service-mesh) — a system-wide
  generalization of the ambassador idea: every service gets its own
  ambassador-like proxy, plus a control plane that configures all of
  them centrally.

## Further reading

- [Ambassador pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/ambassador)
