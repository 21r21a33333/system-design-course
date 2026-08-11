---
title: "Service Mesh"
sidebar_position: 4
supplementary: true
---

A service mesh is a dedicated infrastructure layer — a fleet of sidecar
proxies alongside every service instance, coordinated by a control
plane — that handles service-to-service communication concerns like
retries, mutual TLS, traffic shaping, and observability transparently
to application code.

![Service Mesh diagram](/img/patterns/service-mesh.svg)

## Problem it solves

Once a system has more than a handful of services, service-to-service
communication grows its own set of hard problems: how do you retry a
failed call safely, encrypt traffic between every pair of services,
gradually shift traffic to a new version for a canary release, or get a
consistent view of latency and error rates across every hop? Solving
these one service at a time — via a shared library baked into each
service, as with the plain [Sidecar](/docs/patterns/api-edge/sidecar)
pattern applied piecemeal — still requires every service to opt in and
stay upgraded. A service mesh centralizes this so it applies uniformly
and can be managed independently of application deploys.

## Technical architecture & implementation

**Data plane.** Every service instance is deployed with a sidecar proxy
sharing its network namespace, and traffic redirection (commonly via
`iptables` rules or an equivalent kernel-level redirect installed at
pod startup) transparently routes all inbound and outbound traffic
through that proxy without the application needing to know a proxy
exists. When service A calls service B, the call actually goes:
A's application code to A's local sidecar, A's sidecar to B's local
sidecar (over an encrypted connection using per-workload certificates,
which is what "mutual TLS between every pair of services" means
concretely), and finally B's sidecar to B's application code. Each
sidecar independently enforces the policy it's been given — retry an
idempotent call up to N times with backoff, time out a call after a
configured duration, split a percentage of traffic to a canary version
— purely by intercepting the traffic already flowing through it.

**Control plane.** A logically central control plane holds the
mesh-wide configuration (which services exist, what policy applies to
which route, which certificates are valid) and pushes it out to every
sidecar's data plane, typically over a long-lived streaming connection
so policy changes propagate without redeploying any application. The
control plane also aggregates the telemetry every sidecar emits —
per-hop latency, error rates, retry counts — into a single, consistent
view of service-to-service health, which is otherwise hard to get when
every service might be instrumented differently or not at all.
Critically, the control plane is an out-of-band configuration and
observability layer, not something in the data path of any individual
request — a request between two services flows sidecar-to-sidecar
without the control plane being involved in that specific call at all.

**Certificate rotation and mTLS.** Because every sidecar needs a
verifiable identity to establish mutual TLS with its peers, the control
plane typically runs (or integrates with) a certificate authority that
issues short-lived, workload-scoped certificates to each sidecar and
rotates them automatically well before expiry. This is what lets mTLS
be enforced mesh-wide without every application team managing its own
certificate lifecycle — the sidecar handles issuance, rotation, and
presenting the right certificate on every connection, transparently to
the application it fronts.

**Failure modes.** The most consequential failure is a **control-plane
outage**: because the control plane isn't in the request path,
already-configured sidecars keep enforcing their last-known policy and
existing traffic keeps flowing, but new policy changes (a fresh canary
split, an updated retry budget, a revoked certificate) stop propagating
until the control plane recovers — a "silent" degradation rather than
an outright one, since nothing breaks immediately. A second is
**misconfigured mesh-wide policy**: because policy is applied uniformly
across every sidecar, a single bad configuration change (an overly
aggressive retry policy, a wrong mTLS requirement) can degrade or break
traffic for every service in the mesh simultaneously, which is a much
wider blast radius than a bug in one service's own code. A third is
**added per-hop latency**: every call now makes two extra local hops
(through the caller's sidecar, then the callee's), which is usually
small but is a real, cumulative cost across a request that fans out
through many service-to-service calls.

**Service Mesh vs. Sidecar.** A service mesh's data plane is literally
built from the [Sidecar](/docs/patterns/api-edge/sidecar) pattern
applied to every instance in the system — the relationship is
compositional, not competing: sidecar describes the single-instance
deployment mechanism (a helper process colocated with one application),
while service mesh is what emerges when that mechanism is applied
consistently across an entire fleet and paired with a control plane
that configures and observes all of them as one coordinated system. A
handful of services each running one bespoke sidecar for a specific
purpose is using the sidecar pattern without constituting a mesh; a
mesh implies uniform policy and centralized control across the fleet.

## Code example

```rust
#[derive(Clone, Debug)]
struct RetryPolicy {
    max_attempts: u32,
}

#[derive(Clone, Debug)]
struct MeshPolicy {
    retry: RetryPolicy,
    mtls_required: bool,
}

// A sidecar's view of the world: it enforces whatever policy the
// control plane last pushed, without the application knowing.
struct SidecarProxy {
    service_name: String,
    policy: MeshPolicy,
}

#[derive(Debug, PartialEq)]
enum CallResult {
    Success,
    RejectedNoMtls,
    ExhaustedRetries,
}

impl SidecarProxy {
    // Simulates intercepting an outbound call: enforces mTLS, then
    // retries a failing call up to the configured policy limit —
    // application code never sees any of this, it just calls out.
    fn call_peer(&self, peer_has_valid_cert: bool, mut attempt_fails: impl FnMut() -> bool) -> CallResult {
        if self.policy.mtls_required && !peer_has_valid_cert {
            return CallResult::RejectedNoMtls;
        }

        for _ in 0..self.policy.retry.max_attempts {
            if !attempt_fails() {
                return CallResult::Success;
            }
        }
        CallResult::ExhaustedRetries
    }

    // Applied when the control plane pushes a new configuration —
    // no application redeploy required.
    fn apply_policy(&mut self, new_policy: MeshPolicy) {
        self.policy = new_policy;
    }
}
```

`call_peer` models the two things a sidecar enforces transparently:
rejecting a peer without a valid certificate before ever attempting the
call, and retrying a failing call up to the policy's limit — both
happening in the proxy, with the application's own code never touching
either concern.

## When to use it

- The system has enough services that consistently enforcing mTLS,
  retries, and traffic policy across all of them by hand (or via
  per-language libraries) has become unmanageable.
- You need fine-grained traffic control — canary rollouts, traffic
  mirroring, circuit breaking — applied uniformly without changing
  application code.
- Uniform, mesh-wide observability (latency, error rates, request
  tracing) across service-to-service calls is a requirement.

## When not to use it

- A small number of services doesn't justify the mesh's operational
  complexity — running and upgrading a control plane and a sidecar per
  instance is real ongoing work, and debugging traffic issues now
  involves an extra layer.
- The team doesn't yet have strong operational familiarity with the
  chosen mesh implementation; a misconfigured mesh can cause
  system-wide outages precisely because it sits on every request path.
- The added latency of routing every call through a local proxy isn't
  acceptable for the workload.

## Use-case scenarios

**Bank enforcing mTLS across a regulated microservices estate.** A
bank operating under strict data-in-transit encryption requirements
runs several hundred internal services communicating over a private
network. Rather than requiring every team to correctly implement TLS
certificate handling in every service's own language and framework, a
service mesh issues and rotates per-service certificates automatically
and rejects any connection that doesn't present a valid one — giving
compliance a single, auditable place to verify mTLS is enforced
mesh-wide instead of having to inspect every individual service's
configuration.

**E-commerce platform running canary releases.** An online retailer
wants to roll out a new version of its checkout service to 5% of
production traffic before a full release, then ramp up gradually if
error rates stay flat. The mesh's control plane pushes a traffic-split
rule to every sidecar that calls the checkout service, routing that
percentage of calls to the new version — with no change to any calling
service's code, and an instant rollback available by pushing an updated
split (100% back to the stable version) the moment an error-rate spike
is observed.

**SaaS platform standardizing observability across polyglot services.**
A platform team supports services written in several different
languages across many product teams, and previously had inconsistent
latency and error-rate instrumentation because each team's tracing
library integration varied in quality. Adopting a service mesh gives
every service consistent request-level telemetry for free, emitted by
the sidecar regardless of what language or framework the service behind
it is written in, letting the platform team build one dashboard that
covers every service in the mesh rather than reconciling several
different instrumentation approaches.

## Related patterns

- [Sidecar](/docs/patterns/api-edge/sidecar) — the deployment pattern a
  service mesh's data plane is built from; a service mesh is
  essentially sidecars-plus-control-plane at system scale.

## Further reading

- [Service mesh — Wikipedia](https://en.wikipedia.org/wiki/Service_mesh)
- [Istio architecture (data plane and control plane) — Istio docs](https://istio.io/latest/docs/ops/deployment/architecture/)
- [What's a service mesh? — CNCF / Linkerd explainer](https://linkerd.io/what-is-a-service-mesh/)
