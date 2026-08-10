---
title: "Sidecar"
sidebar_position: 3
supplementary: true
---

The sidecar pattern deploys a helper process alongside a main
application process — on the same host or in the same pod — to handle
cross-cutting concerns like networking, logging, or configuration,
without the main application needing that logic built into it.

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

## How it works

A sidecar is a second process or container deployed alongside the main
application, sharing its host (or pod, in Kubernetes) and lifecycle —
they start and stop together. The main application either talks to the
sidecar directly (e.g. sending all outbound traffic through it) or the
sidecar transparently intercepts traffic to and from the application.
Because the sidecar is a separate process, it can be written in a
different language, upgraded independently of app code deploys, and
reused unmodified across services written in different stacks — the
application only needs to know how to talk to its local sidecar, not
implement the cross-cutting logic itself.

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

## Real-world example

Istio deploys an Envoy proxy as a sidecar next to every application
container in the mesh; the proxy transparently handles traffic routing,
retries, and mTLS for the application without the application code
being aware of it.

## Related patterns

- [Service Mesh](/docs/patterns/api-edge/service-mesh) — a fleet of
  sidecar proxies plus a control plane, extending the sidecar idea to
  system-wide service-to-service communication.

## Further reading

- [Sidecar pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/sidecar)
