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

## How it works

Every service instance gets a sidecar proxy (the "data plane") that
transparently intercepts all inbound and outbound traffic for that
instance. These proxies enforce policy — retries, timeouts, load
balancing, mTLS between services, traffic splitting for canaries — set
by a central "control plane," which also collects telemetry (latency,
error rates, request traces) from every proxy to give operators a
consistent, service-wide view of communication health. Application code
is unaware any of this is happening; it just makes normal network
calls, and the local proxy handles the rest.

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

## Real-world example

Istio and Linkerd are the two most widely adopted service meshes for
Kubernetes, both pairing an Envoy-or-custom-proxy data plane with a
control plane to provide mTLS, retries, and observability across
service-to-service traffic without application code changes.

## Related patterns

- [Sidecar](/docs/patterns/api-edge/sidecar) — the deployment pattern a
  service mesh's data plane is built from; a service mesh is
  essentially sidecars-plus-control-plane at system scale.

## Further reading

- [Service mesh — Wikipedia](https://en.wikipedia.org/wiki/Service_mesh)
