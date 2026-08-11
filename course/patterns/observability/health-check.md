---
title: "Health Check"
sidebar_position: 1
supplementary: true
---

A health check is an endpoint or probe a service exposes — commonly
`/health` — that load balancers and orchestrators poll to decide whether
an instance is fit to receive traffic, should be pulled out of rotation,
or should be restarted.

![Health Check diagram](/img/patterns/health-check.svg)

## Problem it solves

A process can be running while still being unable to do useful work: it
might be deadlocked, out of database connections, mid-startup, or stuck
downloading a large config file. If a load balancer only checks "is the
TCP port open," it keeps sending real user traffic to an instance that
accepts connections but can't actually serve them, producing errors or
timeouts for those users. A health check gives the service a way to
actively declare its own fitness, and — crucially — gives the
infrastructure a signal it can *act on automatically*: route around a
degraded instance, or restart a wedged one, without waiting for a human
to notice a spike in the dashboards.

## Technical architecture & implementation

**The probe and its verdict.** A health check is a lightweight endpoint
(or command/TCP probe) that returns a status — HTTP 200 for healthy, a
non-2xx for unhealthy — and optionally a JSON body detailing each
dependency. The consumer isn't a human; it's a load balancer or
orchestrator that polls on an interval and converts the verdict into a
**routing or lifecycle decision**. This is the defining difference from
[distributed monitoring](/docs/patterns/building-blocks/distributed-monitoring):
monitoring aggregates telemetry to *alert a human*, while a health check
drives an *automated* decision — in or out of the pool, alive or restart.

**Liveness vs readiness vs startup.** The single most important design
distinction is *what a failure means*, because different failures demand
different reactions:

- **Liveness** answers "is the process alive and not wedged?" A failed
  liveness check means the process is unrecoverable on its own, so the
  orchestrator **restarts** it. No amount of waiting fixes a deadlock.
- **Readiness** answers "can this instance serve traffic *right now*?" A
  service can be alive but not ready — warming a cache, waiting on a
  connection pool, or briefly cut off from a dependency. A failed
  readiness check **removes the instance from the load-balancer pool**
  without restarting it, and it rejoins automatically when it recovers.
- **Startup** answers "has a slow initialization finished yet?" It runs
  first, with a generous timeout, and *gates* the other two so a service
  with a long boot (schema migration, large cache load) isn't killed by
  an impatient liveness probe before it ever comes up.

**Shallow vs deep checks — and the deep-check trap.** A **shallow** check
verifies only that the process itself is responsive (the event loop
turns, the handler returns). A **deep** check actively touches
dependencies — pings the database, checks the connection pool, calls a
downstream service. Deep checks catch more real problems, but they carry
a dangerous failure mode: if *every* instance's readiness deep-checks the
*same* shared dependency, a single blip in that dependency fails **all**
instances' readiness at once. The load balancer then empties the entire
pool, converting a minor, possibly-transient dependency hiccup into a
total outage — a self-inflicted cascade. The disciplines that contain
this are: keep **liveness shallow** (never let a dependency failure
trigger mass restarts), scope deep checks to *critical* dependencies
only, and treat a non-critical dependency being down as *degraded* (still
serving) rather than *unhealthy* (ejected).

**Frequency, threshold, and timeout.** Three knobs tune the probe.
**Frequency** (how often to poll) trades detection speed against probe
load. **Timeout** bounds how long a slow probe may hang before it counts
as a failure — an unbounded probe can wedge the checker itself.
**Failure threshold** requires N consecutive failures before acting, so a
single transient blip doesn't eject or restart a healthy instance. This
is the exact same threshold discipline that
[failover](/docs/patterns/reliability/failover) uses to avoid reacting to
a momentary network stutter, and that
[distributed monitoring](/docs/patterns/building-blocks/distributed-monitoring)
uses in its alert for-duration guard — react to sustained failure, not
noise.

**Where it sits in the system.** Health checks are the input to several
other patterns. A [load balancer](/docs/patterns/api-edge/load-balancing)
polls readiness to decide its active pool. A
[failover](/docs/patterns/reliability/failover) controller polls the
active instance and promotes a standby on sustained failure. An
orchestrator uses liveness for **self-healing** auto-restart. And a
[circuit breaker](/docs/patterns/reliability/circuit-breaker) is the
*client-side complement*: where a health check is the instance declaring
its own fitness for the infrastructure to act on, a breaker is a caller
independently deciding to stop calling a dependency that's failing *its*
requests — the two catch different failures (a breaker reacts to real
traffic failing before a periodic probe might notice) and are commonly
layered.

**Failure modes.** A check that's *too shallow* reports healthy while the
instance can't serve — the original problem. A check that's *too deep or
too aggressive* causes cascading ejection or restart loops (a readiness
failure wired to trigger a restart can crash-loop an instance during a
dependency blip, making the outage worse). And a check that itself calls
slow, unbounded downstreams becomes a new source of load and its own
point of failure. The safe defaults: shallow liveness, dependency-scoped
readiness, bounded timeouts, and a failure threshold before any action.

## Liveness vs readiness vs startup

![Health probe types diagram](/img/patterns/health-check-probes.svg)

| Probe | Question | Check depth | Action on failure |
|---|---|---|---|
| **Startup** | Has slow init finished? | Boot progress | Keep waiting (kill only after grace period) |
| **Liveness** | Is the process alive? | Shallow (no deps) | **Restart** the process |
| **Readiness** | Can it serve traffic now? | Deep (critical deps) | **Remove** from load-balancer pool |

Conflating readiness and liveness is the classic mistake: wiring a
readiness failure (a downstream briefly overloaded) to a *restart* turns
a recoverable, temporary condition into a crash loop that amplifies the
outage instead of riding it out.

## Code example

A health aggregator that runs liveness and readiness over a set of
dependencies. Each dependency has a **criticality** (critical vs optional)
and a **failure threshold** so a single transient probe doesn't eject the
instance. Readiness collapses the dependency states into a verdict —
`Healthy`, `Degraded` (a non-critical dep is down; still in the pool), or
`Unhealthy` (a critical dep is down; out of the pool) — and `in_pool`
turns that verdict into the routing decision a load balancer consumes.
Deterministic and single-threaded: real probes run on a timer, but the
aggregation logic is identical.

```rust
use std::collections::HashMap;

// A single dependency's probe result. Shallow checks report only the process;
// deep checks actually touch a dependency (DB, cache, downstream service).
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Probe {
    Up,
    Down,
}

// Whether a dependency is required to serve traffic. A DOWN optional
// dependency degrades the instance; a DOWN critical one fails readiness.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Criticality {
    Critical,
    Optional,
}

// The aggregate verdict a health endpoint returns. Degraded still serves
// traffic (stays in the pool) but signals reduced capability; Unhealthy is
// pulled from the load-balancer pool.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Status {
    Healthy,
    Degraded,
    Unhealthy,
}

pub struct Dependency {
    pub name: String,
    pub criticality: Criticality,
    // A failure threshold: consecutive DOWN probes before the dependency is
    // treated as failed, so a single transient blip does not eject the
    // instance. Mirrors the failover/circuit-breaker threshold discipline.
    pub failure_threshold: u32,
    consecutive_down: u32,
    failed: bool,
}

impl Dependency {
    pub fn new(name: &str, criticality: Criticality, failure_threshold: u32) -> Self {
        Dependency {
            name: name.to_string(),
            criticality,
            failure_threshold,
            consecutive_down: 0,
            failed: false,
        }
    }

    // Feed one probe result. Only after `failure_threshold` consecutive DOWN
    // probes is the dependency considered failed; any UP clears the streak.
    pub fn record(&mut self, probe: Probe) {
        match probe {
            Probe::Up => {
                self.consecutive_down = 0;
                self.failed = false;
            }
            Probe::Down => {
                self.consecutive_down += 1;
                if self.consecutive_down >= self.failure_threshold {
                    self.failed = true;
                }
            }
        }
    }
}

pub struct HealthAggregator {
    // Liveness is separate from readiness on purpose: a failed liveness check
    // means "restart the process"; a failed readiness check means "remove from
    // the load-balancer pool" without a restart.
    process_alive: bool,
    deps: Vec<Dependency>,
}

impl HealthAggregator {
    pub fn new(process_alive: bool, deps: Vec<Dependency>) -> Self {
        HealthAggregator { process_alive, deps }
    }

    // Liveness: is the process itself alive? A false here tells an orchestrator
    // to restart the container — no amount of waiting fixes a deadlocked process.
    pub fn liveness(&self) -> Probe {
        match self.process_alive {
            true => Probe::Up,
            false => Probe::Down,
        }
    }

    // Readiness: can this instance serve traffic right now? Any failed CRITICAL
    // dependency makes it Unhealthy (out of pool); a failed OPTIONAL dependency
    // makes it Degraded (still in pool, reduced capability).
    pub fn readiness(&self) -> Status {
        let mut degraded = false;
        for d in &self.deps {
            match (d.failed, d.criticality) {
                (true, Criticality::Critical) => return Status::Unhealthy,
                (true, Criticality::Optional) => degraded = true,
                (false, _) => {}
            }
        }
        match degraded {
            true => Status::Degraded,
            false => Status::Healthy,
        }
    }

    // The routing decision a load balancer makes from readiness: keep the
    // instance in the pool unless it is Unhealthy.
    pub fn in_pool(&self) -> bool {
        self.readiness() != Status::Unhealthy
    }

    // A per-dependency snapshot, the kind of detail a deep `/health` endpoint
    // returns as a JSON body for operators.
    pub fn report(&self) -> HashMap<String, bool> {
        self.deps.iter().map(|d| (d.name.clone(), !d.failed)).collect()
    }
}
```

Exercising it: a critical Postgres dependency that fails past its
threshold makes readiness `Unhealthy` and `in_pool` false (ejected); an
optional Redis dependency failing makes it `Degraded` but `in_pool` stays
true (still serving, minus caching); a two-probe blip followed by an `Up`
clears the streak and readiness returns to `Healthy`; and a dead process
returns `Down` from `liveness`, the signal to restart.

## When to use it

- Any service behind a load balancer or managed by an orchestrator that
  needs to make automatic routing or restart decisions.
- Services with a non-trivial startup sequence (cache warm-up, schema
  migration, connection-pool init) where "process started" and "ready for
  traffic" are meaningfully different moments.
- Systems that want fast, automatic removal or restart of unhealthy
  instances without a human in the loop.

## When not to use it

- A trivial static endpoint with no dependencies may not need a separate
  readiness check — a shallow liveness check can be sufficient.
- Don't make health checks call slow or expensive downstream systems
  indiscriminately — a deep check over a shared dependency can become a
  cascading-load source and a new point of failure; keep it cheap and
  bounded.
- Don't wire a single shared check to both liveness and readiness when the
  failure semantics differ — that risks unnecessary, outage-amplifying
  restarts.

## Use-case scenarios

**Kubernetes pod with a warm-up cache.** A service loads a large in-memory
cache at boot. A **startup** probe with a long timeout gates the others so
the pod isn't killed mid-load; once it passes, a shallow **liveness**
probe guards against deadlocks (restart on failure) and a **readiness**
probe checks the database connection pool (remove from the Service
endpoints on failure). A brief database blip pulls the pod from rotation
without restarting it, and it rejoins the moment readiness passes again.

**Load-balancer pool with graceful degradation.** A product API depends on
Postgres (critical) and Redis (optional cache). When Redis fails past its
threshold, readiness reports **Degraded** — the instance stays in the pool
and serves slower, uncached responses rather than being ejected, an
application of [graceful degradation](/docs/patterns/reliability/graceful-degradation).
Only a Postgres failure — where the instance genuinely can't serve — flips
it to **Unhealthy** and out of the pool.

**Failover controller health-checking a primary.** An active-passive
database pair uses a [failover](/docs/patterns/reliability/failover)
controller that health-checks the primary on an interval. It requires a
sustained failure (N consecutive misses) before promoting the standby, so
a single dropped heartbeat doesn't trigger a disruptive, unnecessary
switchover. The health check is the detection half of failover; the
promotion and fencing are the rest.

## Production libraries & getting started

Most stacks combine a platform-level prober (Kubernetes probes, a load balancer's target checks) with a framework module that exposes the actual liveness/readiness endpoints from inside your app.

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| Kubernetes probes | Platform (any lang) | Liveness, readiness, and startup probes that restart or de-route pods | [kubernetes.io — configure probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/) |
| Spring Boot Actuator | Java | Ready-made `/actuator/health` with liveness/readiness groups | [docs.spring.io — Actuator endpoints](https://docs.spring.io/spring-boot/reference/actuator/endpoints.html) |
| NestJS Terminus | JS/TS | Composable health indicators (DB, disk, HTTP) behind a health endpoint | [docs.nestjs.com — Terminus](https://docs.nestjs.com/recipes/terminus) |
| hellofresh/health-go | Go | Aggregates dependency checks into one JSON health handler | [github.com/hellofresh/health-go](https://github.com/hellofresh/health-go) |
| gin-healthcheck | Go | Drop-in health endpoint and checks for the Gin framework | [github.com/tavsec/gin-healthcheck](https://github.com/tavsec/gin-healthcheck) |
| py-healthcheck | Python | Health/environment endpoints for Flask and Tornado apps | [pypi.org/project/py-healthcheck](https://pypi.org/project/py-healthcheck/) |
| gRPC Health Checking Protocol | Protocol (any lang) | Standard `Check`/`Watch` RPC so infra can probe gRPC services | [grpc — health-checking spec](https://github.com/grpc/grpc/blob/master/doc/health-checking.md) |
| Consul checks | Platform (any lang) | Service-registry health checks that gate discovery and routing | [developer.hashicorp.com — Consul checks](https://developer.hashicorp.com/consul/docs/services/usage/checks) |

## Related patterns

- [Load Balancing](/docs/patterns/api-edge/load-balancing) — the component that most directly consumes readiness results to decide its routing pool.
- [Failover](/docs/patterns/reliability/failover) — uses sustained health-check failure as the trigger to promote a standby; the check is failover's detection half.
- [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) — the client-side complement that reacts to failing requests a periodic health probe may not yet have caught.
- [Graceful Degradation](/docs/patterns/reliability/graceful-degradation) — the "Degraded" verdict in action: serve reduced capability rather than eject when a non-critical dependency is down.
- [Distributed Monitoring](/docs/patterns/building-blocks/distributed-monitoring) — aggregates per-instance health into fleet-wide up/down signals and alerts humans, where a health check drives automated routing.
- [Auto-Scaling](/docs/patterns/scaling/auto-scaling) — only routes to and counts instances that pass readiness, so scaling reacts to genuinely-serving capacity.

## Further reading

- [Kubernetes: liveness, readiness, and startup probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/) — the canonical three-probe model.
- [Health Endpoint Monitoring pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/health-endpoint-monitoring)
- [Google SRE Book: handling overload and health checking](https://sre.google/sre-book/handling-overload/) — why deep checks can cascade.
- [AWS ELB health checks](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html) — thresholds, intervals, and timeouts in a production load balancer.
