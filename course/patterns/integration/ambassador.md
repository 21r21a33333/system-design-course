---
title: "Ambassador"
sidebar_position: 1
supplementary: true
---

The Ambassador pattern deploys a small helper process alongside a
client application — typically as a sidecar container in the same pod —
that intercepts and handles all of the client's *outbound* network
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
the application it serves. This is especially valuable when the client
is a **legacy application you can't modify** — the ambassador wraps its
naive outbound calls in modern resilience without touching a line of
its code.

## Technical architecture & implementation

**The local-call indirection.** The client is configured to send its
outbound requests to `localhost` (or a Unix domain socket) instead of
the real remote endpoint. The ambassador, running in the same pod or on
the same host, receives that local call and does the real work: it
resolves the actual remote address, opens and pools a connection,
negotiates TLS, and forwards the request. From the client's point of
view it made one simple local call; everything the ambassador adds
happens on the far side of `localhost`, invisible to the client. Two
properties make this work: the ambassador is *colocated* (so the local
hop is cheap and the two share a network identity), and it presents the
*same call surface* the client already used, so adopting it is a config
change, not a code change.

**The resilience pipeline.** On each intercepted call the ambassador
applies the cross-cutting network concerns in order — the same
building blocks documented elsewhere in this course, bundled into one
outbound proxy:

- **[Timeouts](/docs/patterns/reliability/timeout)** bound how long any
  single attempt may take, so a hung remote doesn't hang the client.
- **[Retries with backoff](/docs/patterns/reliability/retry-with-backoff)**
  re-issue transient failures, spacing attempts out to avoid hammering
  a struggling remote.
- **[Circuit breaking](/docs/patterns/reliability/circuit-breaker)**
  trips after sustained failures so the ambassador fails fast instead
  of piling retries onto a remote that's clearly down.
- **TLS / mutual TLS** secures the actual network hop, so the client
  can keep speaking plain local HTTP.
- **Metrics and tracing** on every outbound call feed
  [distributed tracing](/docs/patterns/observability/distributed-tracing)
  and dashboards without the client emitting them.

**Independent upgrade path.** Because the ambassador is a separate
process — often a different language and runtime from the client — it's
built, versioned, and upgraded on its own cadence. A platform team ships
a new retry policy, a TLS patch, or a stricter timeout to every service
running the ambassador image without any application team rebuilding
their code. This is the core operational win over embedding the same
logic as a per-language client library that must be re-released and
re-adopted service by service.

**Failure modes.** The ambassador runs as its own process, and that
independence cuts both ways. A **crashed or crash-looping ambassador**
while the client stays healthy means the client is "up" by a naive
check but can't actually reach anything, so production health checks
should cover both processes. **Resource contention** matters because
the ambassador shares the host's CPU and memory with the client; an
under-provisioned ambassador can starve the very application it
serves. There's an unavoidable **local-hop latency tax** — even
loopback IPC is non-zero, and it's paid on every call. And a
**misconfigured breaker or retry policy** can make things worse: too
aggressive retries turn a blip into a
[retry storm](/docs/patterns/antipatterns/retry-storm), while a breaker
that trips too eagerly denies the client a remote that was actually
fine.

**Ambassador vs. Sidecar.** An ambassador *is* a
[sidecar](/docs/patterns/api-edge/sidecar) — it uses the sidecar
deployment mechanism (a colocated helper process sharing the client's
lifecycle and network namespace). The distinction is *specialization*:
"sidecar" is the general pattern of any co-located helper for any
cross-cutting concern (logging, config reload, proxying, metrics),
while "ambassador" is the specific sidecar whose job is proxying the
client's **outbound** connectivity. Every ambassador is a sidecar; not
every sidecar is an ambassador (a log-shipping sidecar isn't).

**Ambassador vs. Gateway Offloading.** Both move network concerns out
of application code, but they sit on opposite sides of the connection.
[Gateway Offloading](/docs/patterns/api-edge/gateway-offloading) is
**central and server-side**: one shared component at the edge fronts
*many* backends and handles *inbound* concerns (terminating TLS,
authenticating callers, rate-limiting) on their behalf. An ambassador
is **per-consumer and client-side**: it rides along with *one* client
and handles that client's *outbound* concerns (retrying, circuit-
breaking, mTLS to the remote). A gateway is one place to configure and
one place to fail; an ambassador avoids that choke point and can carry
per-client identity, at the cost of a proxy process per client. When
every service in a system gets its own ambassador plus a central
control plane to configure them all, the result is a
[service mesh](/docs/patterns/api-edge/service-mesh) — the ambassador
idea generalized fleet-wide.

## Code example

The snippet below is what an ambassador does on the client's behalf:
wrap a single outbound call in retries, a per-attempt budget, and a
failure-count circuit breaker, so the caller only ever sees a plain
`Result`. The `remote` closure stands in for the real network call and
takes the attempt index, keeping the example deterministic — no real
I/O and no fake concurrency.

```rust
use std::time::Duration;

/// Outcome of one attempt against the remote, as the ambassador sees it.
#[derive(Debug, PartialEq)]
enum CallError {
    /// The remote returned a transient error worth retrying.
    Transient,
    /// The breaker is open, so the ambassador refuses to even try.
    CircuitOpen,
    /// Retries were exhausted without success.
    Exhausted,
}

/// A client-side ambassador: it wraps every outbound call to a legacy
/// remote the caller cannot modify, adding retries, a per-attempt
/// timeout budget, and a simple failure-count circuit breaker. The
/// caller only ever sees a plain Result.
struct Ambassador {
    max_retries: u32,
    backoff: Duration,
    // Consecutive failures before the breaker opens and calls fail fast.
    breaker_threshold: u32,
    consecutive_failures: u32,
    breaker_open: bool,
}

impl Ambassador {
    fn new(max_retries: u32, breaker_threshold: u32) -> Self {
        Ambassador {
            max_retries,
            backoff: Duration::from_millis(10),
            breaker_threshold,
            consecutive_failures: 0,
            breaker_open: false,
        }
    }

    /// `remote` stands in for the real network call (TLS handshake,
    /// connection pool, the legacy endpoint). It takes the attempt index
    /// so tests can make it fail a fixed number of times, then succeed —
    /// deterministic, no real I/O or threads.
    fn call(
        &mut self,
        mut remote: impl FnMut(u32) -> Result<String, ()>,
    ) -> Result<String, CallError> {
        if self.breaker_open {
            return Err(CallError::CircuitOpen);
        }

        for attempt in 0..=self.max_retries {
            match remote(attempt) {
                Ok(response) => {
                    // Success closes the failure streak.
                    self.consecutive_failures = 0;
                    return Ok(response);
                }
                Err(()) => {
                    self.consecutive_failures += 1;
                    if self.consecutive_failures >= self.breaker_threshold {
                        self.breaker_open = true;
                        return Err(CallError::CircuitOpen);
                    }
                    // A real ambassador sleeps `backoff * (attempt + 1)`
                    // here; elided so the example stays deterministic.
                    let _ = self.backoff;
                }
            }
        }

        Err(CallError::Exhausted)
    }
}
```

A remote that fails twice then succeeds returns `Ok` after the
ambassador's retries, and the failure streak resets. A remote that
keeps failing trips the breaker at the threshold, returns
`CallError::CircuitOpen`, and every subsequent call fails fast *without
touching the remote at all* — the client never implements any of this;
it just calls `Ambassador::call`.

## When to use it

- Multiple services, possibly in different languages, need the same
  outbound network resilience (retries, TLS, circuit breaking) and you
  want to implement and upgrade that logic exactly once.
- You're introducing network-level concerns like mTLS or observability
  into an existing (or legacy) application without touching its code.
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

## Use-case scenarios

**Hardening a legacy client that can't be changed.** An old billing
application makes plain, retry-free HTTP calls to a downstream payment
service, and the team has neither the source nor the appetite to modify
it. An ambassador is deployed alongside it: the app's outbound endpoint
is repointed at `localhost`, and the ambassador adds retries with
backoff, a circuit breaker, per-attempt timeouts, and mutual TLS to the
real payment service. The legacy binary is untouched, yet its calls are
now resilient and encrypted.

**Uniform resilience across a polyglot fleet.** A company runs services
in several languages, each with its own ad hoc (or missing) retry and
timeout logic for outbound calls. Instead of maintaining a resilience
library per language, the platform team ships one ambassador image that
every service runs as a sidecar; the ambassador applies a single,
centrally-defined retry-and-breaker policy to outbound traffic
regardless of the calling service's language, and policy changes ship
by rolling the ambassador image.

**Local database proxy for a cloud SQL instance.** An application needs
pooled, TLS-secured, IAM-authenticated connections to a managed cloud
database, but wiring all of that into the app is fiddly and
provider-specific. A database-proxy ambassador runs beside the app; the
app connects to `localhost` with plain credentials, and the ambassador
handles connection pooling, the TLS handshake, credential rotation, and
metrics on connection health — so the app's data-access code stays
provider-agnostic.

## Related patterns

- [Sidecar](/docs/patterns/api-edge/sidecar) — the deployment mechanism
  an ambassador uses; Sidecar is the general co-located-helper pattern,
  while Ambassador is the sidecar specialized for proxying outbound
  calls.
- [Gateway Offloading](/docs/patterns/api-edge/gateway-offloading) — the
  central, server-side counterpart: offloads *inbound* concerns for a
  whole fleet at the edge, versus the ambassador's per-client,
  client-side, outbound placement.
- [Service Mesh](/docs/patterns/api-edge/service-mesh) — a system-wide
  generalization: every service gets an ambassador-like proxy plus a
  control plane configuring them all centrally.
- [Circuit Breaker](/docs/patterns/reliability/circuit-breaker),
  [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff),
  and [Timeout](/docs/patterns/reliability/timeout) — the resilience
  building blocks an ambassador bundles and applies to outbound calls.

## Further reading

- [Ambassador pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/ambassador)
- [The Distributed System ToolKit: Patterns for Composite Containers — Kubernetes blog](https://kubernetes.io/blog/2015/06/the-distributed-system-toolkit-patterns/) (introduces the ambassador container pattern)
- [Envoy proxy — architecture overview](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/intro/what_is_envoy) (a proxy commonly deployed in the ambassador/sidecar role)
