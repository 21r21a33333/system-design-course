---
title: "Sidecar"
sidebar_position: 3
supplementary: true
---

The sidecar pattern deploys a helper process alongside a main
application process — on the same host or in the same pod — to handle
cross-cutting concerns like networking, logging, or configuration,
without the main application needing that logic built into it.

![Sidecar diagram](/img/patterns/sidecar.svg)

## Problem it solves

Concerns like TLS termination, retries, service discovery, and
structured logging are needed by nearly every service in a system, but
implementing them inside each service means reimplementing (or
importing a client library for) the same logic in every language and
framework the organization uses. That couples infrastructure concerns
to the application's runtime and release cycle: upgrading the retry
logic means redeploying every service that embeds it. Teams want a way
to attach this shared behavior to a service without touching that
service's code.

## Technical architecture & implementation

**Colocation and lifecycle coupling.** A sidecar is deployed as a
second process or container sharing the main application's host (or
pod, in a container orchestrator) — critically, they're scheduled,
started, and stopped as one deployable unit, never independently
placed on different hosts. That colocation is what makes local,
low-latency interprocess communication (a loopback network call, or a
shared Unix domain socket) a viable way for the application to talk to
its sidecar, and it's also what lets the sidecar assume the same
network identity as the application it fronts for purposes like
per-instance mTLS certificates.

**Traffic interception vs. explicit calls.** There are two ways the
application and sidecar interact. In the **explicit** model, the
application code is written to call its local sidecar directly for a
specific concern — for example, writing all structured logs to a local
socket the logging sidecar listens on, rather than to disk or a remote
log service itself. In the **transparent interception** model,
network-level redirection (commonly `iptables` rules configured at
container startup) routes all of the application's inbound and outbound
traffic through the sidecar without any application code change at
all — the application makes what looks like a normal outbound call, and
the sidecar transparently sits in the path applying retries, mTLS, or
routing before the packet ever reaches the network. Transparent
interception is more powerful (zero application code changes needed)
but harder to debug, since a networking issue might originate in
application code, the sidecar, or the redirection rules connecting
them, and distinguishing between the three requires more care than with
an explicit local call.

**Independent upgrade path.** Because the sidecar is a separate
process — often in a completely different language and runtime from
the application — it can be built, versioned, and upgraded on its own
release cadence. A platform team can ship a sidecar security patch or a
new retry-policy feature to every service running that sidecar image
without any individual application team rebuilding or redeploying their
own code, which is the core operational win over embedding the same
logic as a language-specific library dependency inside every service.

**Failure modes.** The sidecar can fail independently of the
application it fronts, and that independence cuts both ways: a sidecar
crash-looping while the application process stays healthy means the
application is still "up" by a naive health check, while silently
losing whatever the sidecar provided — TLS termination, retries,
service discovery — until the sidecar is restarted too, which is why
production health checks for a sidecar-fronted service typically check
both processes, not just the application's own liveness. A second
failure mode is **resource contention**: the sidecar consumes memory
and CPU on the same host as the application, and an under-provisioned
sidecar (or one handling unexpectedly high traffic) can starve the
application it's meant to be supporting, especially in resource-capped
container environments where the two share a fixed quota. A third is
**added local-hop latency**: even loopback interprocess communication
has real, non-zero cost, and a chain of several sidecar-mediated
concerns (logging, then retries, then mTLS) on both the caller and
callee side accumulates a small but measurable latency tax on every
call.

**Sidecar vs. Service Mesh.** A sidecar is the single-instance building
block: one helper process attached to one application instance for
whatever cross-cutting concern it's built for. [Service
Mesh](/docs/patterns/api-edge/service-mesh) is what results when that
same sidecar mechanism is deployed to *every* instance across a system
and paired with a central control plane that configures and observes
all of them together — a service mesh's data plane literally is a fleet
of sidecars. A single team running one sidecar for one specific purpose
(say, a logging sidecar next to one service) is using the sidecar
pattern without needing a full mesh's control plane or mesh-wide policy
machinery at all.

**Sidecar vs. Gateway Offloading.** Both move a cross-cutting concern
(TLS, auth, retries) out of application code, so they can feel like the
same idea — the difference is *where* the offloaded logic runs relative
to the instances it serves. [Gateway
Offloading](/docs/patterns/api-edge/gateway-offloading) pushes the
concern to a single shared component at the edge that fronts *many*
backend instances, so the logic is centralized and the backends behind
it never see it. A sidecar pushes the same kind of concern to a helper
that is colocated *one-per-instance*, riding along with each application
rather than sitting in front of a fleet. That placement drives the
tradeoffs: a gateway is one place to configure and one place to fail,
but it can't hold per-instance identity (like an instance-specific mTLS
certificate) the way a sidecar sharing its application's network
identity can, and it terminates concerns at the edge rather than all
the way down at each instance — which is exactly why service meshes
choose the sidecar placement for mutual TLS between individual services.

## Code example

```rust
struct SidecarConfig {
    max_retries: u32,
    tls_enabled: bool,
}

// Represents the sidecar process's own view: it starts and stops with
// the application, and exposes a local call surface the application
// uses instead of implementing this logic itself.
struct LoggingSidecar {
    config: SidecarConfig,
    buffered_lines: Vec<String>,
}

impl LoggingSidecar {
    // The application calls this local method (in the transparent
    // model, an intercepted network call plays the same role) —
    // it never implements retry or TLS logic itself.
    fn send_log(&mut self, line: &str, mut attempt_fails: impl FnMut() -> bool) -> bool {
        for _ in 0..self.config.max_retries {
            if !attempt_fails() {
                self.buffered_lines.push(line.to_string());
                return true;
            }
        }
        false
    }
}

// The application only ever calls this — it has no idea a sidecar,
// retries, or TLS are involved underneath.
fn application_logs_event(sidecar: &mut LoggingSidecar, message: &str) -> bool {
    let mut attempts = 0;
    sidecar.send_log(message, move || {
        attempts += 1;
        attempts < 2 // fails once, then succeeds
    })
}
```

`application_logs_event` is the entire surface the application code
ever touches — `send_log`'s retry loop, and whatever transport or TLS
handling a real sidecar would add underneath it, stay fully inside the
sidecar and never leak into application logic.

## When to use it

- The same infrastructure concern (proxying, logging, config reload,
  metrics collection) needs to be applied consistently across services
  written in different languages.
- You want to update or patch this shared behavior without redeploying
  every application that uses it.
- The application platform (e.g. Kubernetes) already supports
  colocating multiple containers per deployment unit.

## When not to use it

- The overhead of an extra process per instance (memory, and the added
  latency of an extra local hop) isn't justified for a small or
  low-traffic service.
- Only one service will ever need the behavior — embedding it directly
  in that service is simpler than standing up a reusable sidecar.
- The interprocess communication between app and sidecar becomes a
  bottleneck for very latency-sensitive calls.

## Use-case scenarios

**Polyglot microservices standardizing outbound retries.** A company
runs services written in several different languages, each historically
implementing its own ad hoc retry logic (or none at all) for calls to
flaky downstream dependencies. Rather than writing and maintaining a
retry library in every language, the platform team ships a single
sidecar image that every service deploys alongside itself; the sidecar
intercepts outbound calls and applies a consistent retry-with-backoff
policy regardless of what language the calling service is written in.

**Legacy application gaining TLS without a code change.** An
older application, written in a framework with no easy path to modern
TLS configuration, needs to satisfy a new requirement that all
service-to-service traffic be encrypted. Rather than rewriting the
application's networking code, a TLS-terminating sidecar is deployed
alongside it; the sidecar handles certificate presentation and
encryption for all traffic in and out, and the legacy application
keeps making the same plain-HTTP calls it always has to its local
sidecar.

**Configuration-reload sidecar for a stateful service.** A caching
service needs its in-memory configuration (feature flags, routing
weights) updated frequently without restarting the process, which
would drop its warm cache. A sidecar watches a central configuration
store for changes and writes updates to a local file or socket the
main application polls, decoupling "how config changes are fetched and
validated" from the application's own code, which only needs to know
how to read from its local, already-validated source.

## Production libraries & getting started

The sidecar pattern is usually realized through a container
orchestrator's native support for co-scheduled containers, plus a
purpose-built sidecar runtime or proxy for the concern being offloaded.

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| Kubernetes sidecar containers | YAML / Go platform | Native co-scheduled helper containers sharing a Pod's network and lifecycle | [Getting started](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/) |
| Dapr | Go (sidecar runtime) | A portable sidecar exposing service invocation, pub/sub, state, and secrets over local APIs | [Getting started](https://docs.dapr.io/getting-started/) |
| Envoy | C++ | The de facto sidecar proxy for transparent traffic interception, retries, and mTLS | [Getting started](https://www.envoyproxy.io/docs/envoy/latest/start/start) |

**Example / reference:** [Sidecar pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/sidecar)

## Related patterns

- [Service Mesh](/docs/patterns/api-edge/service-mesh) — a fleet of
  sidecar proxies plus a control plane, extending the sidecar idea to
  system-wide service-to-service communication.
- [Gateway Offloading](/docs/patterns/api-edge/gateway-offloading) — the
  same concern moved to a single shared edge component rather than a
  colocated helper per instance; contrast the placement and its
  tradeoffs.

## Further reading

- [Sidecar pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/sidecar)
- [Sidecar containers — Kubernetes documentation](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/)
