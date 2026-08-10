---
title: "Health Check"
sidebar_position: 1
supplementary: true
---

A health check is an endpoint a service exposes — commonly `/health` — that
load balancers, orchestrators, and monitoring systems poll to decide whether
an instance is fit to receive traffic or should be pulled out of rotation.

## Problem it solves

A process can be running while still being unable to do useful work: it
might be deadlocked, out of database connections, mid-startup, or stuck
downloading a large config file. If a load balancer only checks "is the TCP
port open," it will keep sending real user traffic to an instance that
accepts connections but can't actually serve them, producing errors or
timeouts for those users. A health check gives the service a way to
actively declare its own fitness, rather than having infrastructure guess
from the outside.

## How it works

The service exposes a lightweight HTTP endpoint that returns a status code
(200 for healthy, non-200 for unhealthy) and optionally a JSON body with
details about downstream dependencies. Two distinct checks are typically
implemented:

- **Liveness** — is the process itself alive and not deadlocked? A failed
  liveness check tells the orchestrator to restart the process, because no
  amount of waiting will fix it.
- **Readiness** — is the process currently able to serve traffic? A
  service can be alive but not ready — for example, still warming an
  in-memory cache, waiting on a database connection pool, or finishing a
  migration. A failed readiness check tells the load balancer to
  temporarily stop routing traffic to this instance, without restarting
  it, until it reports ready again.

Conflating the two is a common mistake: if a readiness failure (e.g. a
downstream dependency is briefly overloaded) is wired to trigger a
restart, the system can enter a crash loop that makes the outage worse
instead of better.

## When to use it

- Any service behind a load balancer or managed by an orchestrator that
  needs to make automatic routing or restart decisions.
- Services with a non-trivial startup sequence (cache warm-up, schema
  migration, connection pool initialization) where "process started"
  and "ready for traffic" are meaningfully different moments.
- Systems that want fast, automatic removal of unhealthy instances from
  rotation without a human in the loop.

## When not to use it

- A trivial static endpoint with no dependencies may not need a separate
  readiness check — liveness alone can be sufficient.
- Health checks that themselves call slow or expensive downstream systems
  can become a new point of failure or cascading load source; keep the
  check itself cheap and bounded.
- Don't use a single shared check for both liveness and readiness when the
  failure semantics genuinely differ — this risks unnecessary restarts.

## Real-world example

Kubernetes distinguishes liveness and readiness probes explicitly: a
failed liveness probe causes the kubelet to restart the container, while
a failed readiness probe only removes the pod's IP from the Service's
load-balanced endpoints until it passes again.

## Related patterns

- [Load Balancer](/docs/concepts/load-balancer) — the primer's component that most directly consumes health check results to decide routing.
- [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) — a client-side complement that reacts to failures a health check may not yet have caught.
- [Graceful Degradation](/docs/patterns/reliability/graceful-degradation) — what a service does internally when a dependency it depends on is unhealthy.

## Further reading

- [Load balancing (computing) — Wikipedia](https://en.wikipedia.org/wiki/Load_balancing_(computing))
