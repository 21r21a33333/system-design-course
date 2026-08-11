---
title: "Failover"
sidebar_position: 8
supplementary: true
---

Failover is the process of detecting that an active component has
stopped working and automatically redirecting its traffic to a standby
component that takes over the same responsibility, so the system as a
whole keeps functioning through the failure of any one part.

![Failover diagram](/img/patterns/failover.svg)

## Problem it solves

Every individual machine, process, and network link fails eventually —
hardware dies, processes crash, data centers lose power. If a system's
availability depends on one specific instance of a component staying
up continuously, that instance is a single point of failure: the
moment it goes down, everything depending on it goes down with it,
for however long it takes a human to notice and manually bring up a
replacement. Failover exists to remove the human, and the delay, from
that recovery path: a standby instance is kept ready in advance, health
is checked continuously rather than after a complaint comes in, and
the moment the active instance is judged unhealthy, traffic is
redirected to the standby automatically — turning what would otherwise
be an extended, manually-diagnosed outage into a bounded, automatic
interruption.

## Technical architecture & implementation

**Health detection.** Failover starts with deciding an active
component is actually unhealthy, which is harder than it sounds — a
component that's merely slow, or briefly unreachable due to a
transient network blip, looks identical from the outside to one that
has actually failed. Implementations typically use a health check
(a periodic probe — a ping, a lightweight endpoint call) combined with
a failure threshold (missing N consecutive checks, not just one) before
declaring the component down, trading a slightly longer detection delay
for resistance to false positives that would trigger an unnecessary
failover. Declaring a healthy component dead is its own failure mode:
it triggers a disruptive failover for no reason and, if the standby
isn't actually equivalent, can make things worse rather than better.

**Standby readiness — hot, warm, and cold.** How ready the standby is
when failover is triggered is the central design lever, and it trades
readiness cost against failover speed. A **hot standby** is already
running and continuously kept in sync with the active instance's state
(commonly via the same replication mechanism described on the
[Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication)
page, for stateful components) — failover is close to instantaneous
because the standby has almost nothing left to catch up on, at the
cost of running and paying for a fully provisioned second instance at
all times. A **warm standby** is running but not continuously
synchronized — it needs a catch-up step (replaying recent state,
pulling a recent snapshot) before it can safely take over, which is
cheaper to keep running but adds real seconds-to-minutes to the
failover window. A **cold standby** isn't running at all until needed
— it has to be provisioned or booted from scratch on failover, which is
the cheapest to keep idle and the slowest to actually fail over to,
often minutes.

**Redirecting traffic.** Detecting failure and having a ready standby
isn't sufficient on its own — something has to actually redirect
callers to the new active instance, whether that's a load balancer
removing the failed instance from its pool and adding the standby, a
DNS record updated to point at a new address, or (for a replicated data
store specifically) a promotion step that makes a replica the new
primary. This redirection step is where split-brain risk enters: if the
original active instance is only partitioned rather than truly dead, it
may still be reachable by some clients even after the standby has taken
over, and both may now believe they're the active one. Guarding against
this requires the same fencing discipline described on the
[Leader Election](/docs/patterns/consistency/leader-election) page — a
failover should bump a generation number that downstream systems use to
reject actions from the instance that's been superseded.

**Failover vs. Bulkhead / Circuit Breaker / Graceful Degradation.**
These reliability patterns are frequently grouped together but solve
different-shaped problems, and the distinction matters for picking the
right one. [Circuit Breaker](/docs/patterns/reliability/circuit-breaker)
and [Bulkhead](/docs/patterns/reliability/bulkhead) are about a
*caller's* posture toward a dependency that's failing — stop calling
it, isolate its resource pool from unrelated calls — and neither one
does anything to bring the failing dependency itself back; they protect
the caller from a bad dependency, they don't fix or replace it.
[Graceful Degradation](/docs/patterns/reliability/graceful-degradation)
is about serving a *reduced* response when a non-critical dependency is
unavailable, accepting the failure and working around it rather than
routing around it to a replacement. Failover is the odd one out among
these: it's specifically about there being a standby *replacement* for
the failed component, and traffic being redirected to that replacement
so the same full capability keeps being served, just from a different
instance — it doesn't reduce what's offered (unlike graceful
degradation) and it doesn't just protect a caller's own resources
(unlike bulkhead); it restores the capability itself by substituting
in an equivalent component. A robust system commonly layers several of
these together: a circuit breaker stops hammering a failing primary
while a failover process promotes a standby, and graceful degradation
covers whatever gap remains during the failover window itself.

## Code example

```rust
#[derive(Clone, Copy, PartialEq, Debug)]
enum Health {
    Healthy,
    Unhealthy,
}

struct FailoverController {
    active: u64,
    standby: u64,
    consecutive_failures: u32,
    // A failover isn't triggered on one bad check — that would react
    // to a transient blip as if it were a real failure.
    failure_threshold: u32,
    generation: u64,
}

impl FailoverController {
    // Called on every health-check tick against the current active
    // instance. Returns the new active instance if a failover happened.
    fn observe(&mut self, health: Health) -> Option<u64> {
        match health {
            Health::Healthy => {
                self.consecutive_failures = 0;
                None
            }
            Health::Unhealthy => {
                self.consecutive_failures += 1;
                if self.consecutive_failures >= self.failure_threshold {
                    std::mem::swap(&mut self.active, &mut self.standby);
                    self.generation += 1; // fences the demoted instance
                    self.consecutive_failures = 0;
                    Some(self.active)
                } else {
                    None
                }
            }
        }
    }
}
```

`observe` only swaps `active` and `standby` once `consecutive_failures`
crosses `failure_threshold`, and every swap increments `generation` —
that counter is what a downstream system checks to reject any lingering
writes or commands from the instance that just got demoted.

## When to use it

- A component's downtime directly translates to system-wide downtime,
  and the business impact of an extended manual recovery is
  unacceptable relative to the cost of running a standby.
- The component's state (if any) can be kept sufficiently in sync on a
  standby — via replication, periodic snapshots, or the standby being
  stateless — that taking over doesn't itself lose or corrupt data.
- Health can be checked reliably enough, with a low enough false-positive
  rate, that automatic failover doesn't itself become a source of
  disruptive, unnecessary switchovers.

## When not to use it

- The component is stateless and trivially replaceable behind a load
  balancer already spreading load across many equivalent instances —
  that's ordinary horizontal scaling and load balancing, not failover,
  and adding failover-specific machinery on top is unnecessary
  complexity.
- The cost of a hot or warm standby (continuously running, continuously
  synchronized infrastructure) isn't justified by the actual
  availability requirement, and a documented manual recovery process
  within an acceptable time window is genuinely sufficient.
- Split-brain protection (fencing, generation numbers) can't be
  reliably implemented for the component in question — an automatic
  failover without that protection risks making an outage worse by
  creating two simultaneously active instances instead of one clearly
  failed one.

## Use-case scenarios

**Active-passive database cluster.** A relational database runs as a
primary with a synchronously replicated standby in a separate
availability zone. A failover controller health-checks the primary
continuously; on sustained failure, it promotes the standby, updates
the connection endpoint clients use, and fences the old primary so any
delayed writes it attempts post-partition are rejected rather than
silently diverging from the newly promoted primary's state.

**Multi-region API gateway.** A global API is served from a primary
region with a fully provisioned hot standby region kept in sync via
continuous data replication. A global health-check and traffic-routing
layer monitors the primary region's error rate and latency; if it
crosses a sustained threshold, DNS and routing are updated to send all
traffic to the standby region within seconds, with the failed region
fenced off from accepting further writes until it's confirmed healthy
and deliberately failed back.

**Cold-standby disaster recovery for a batch-processing system.** An
internal nightly batch pipeline runs on a single provisioned cluster
with no continuously running standby, only infrastructure-as-code
templates and a recent data snapshot ready to be deployed. On a
sustained cluster failure, an operator (or an automated runbook)
provisions a fresh cluster from those templates and restores the
snapshot — a failover measured in minutes rather than seconds, which is
an acceptable trade for not paying to keep a duplicate cluster running
around the clock for a workload that only needs to complete once a day.

## Production libraries & getting started

Failover is operated at the infrastructure layer, not dropped in as a library — the "implementation" is a database HA manager, a proxy with health checks, or an orchestrator that promotes a standby and reroutes traffic. The table lists the systems that actually perform failover, by the component they protect.

| Library / Tool | Layer | What it gives you | Getting started |
| --- | --- | --- | --- |
| Patroni | Postgres HA | Template for a HA Postgres cluster with automatic leader election + promotion | [docs](https://patroni.readthedocs.io/en/latest/) · [repo](https://github.com/zalando/patroni) |
| repmgr | Postgres HA | Replication + automatic failover management for Postgres primaries/standbys | [docs](https://repmgr.org/docs/current/index.html) |
| Redis Sentinel | Redis HA | Monitors a master, elects and promotes a replica, updates clients on failover | [Sentinel docs](https://redis.io/docs/latest/operate/oss_and_stack/management/sentinel/) |
| HAProxy + keepalived | Load balancer / VIP | Health-checked backend removal + VRRP floating IP so a standby LB takes over | [HAProxy docs](https://docs.haproxy.org/) · [keepalived](https://www.keepalived.org/) |
| Kubernetes | Orchestrator | Liveness/readiness probes + Deployments reschedule failed pods automatically | [probes docs](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/) |
| Amazon RDS Multi-AZ | Managed DB | Cloud-managed synchronous standby with automatic cross-AZ failover | [Multi-AZ docs](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.html) |

## Related patterns

- [Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication) —
  the data-layer mechanism a hot or warm standby typically relies on to
  stay synchronized enough that failover doesn't lose acknowledged
  writes.
- [Leader Election](/docs/patterns/consistency/leader-election) — the
  fencing and single-active-owner discipline a correct failover needs
  to avoid split-brain when the original active instance turns out to
  be partitioned rather than truly dead.
- [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) and
  [Bulkhead](/docs/patterns/reliability/bulkhead) — protect a *caller*
  from a failing dependency by stopping calls or isolating resources,
  which is a different response than failover's redirection to a
  standby replacement; the two are commonly layered together.
- [Graceful Degradation](/docs/patterns/reliability/graceful-degradation) —
  serves a reduced response when a dependency is unavailable rather
  than substituting in a full replacement, often covering the gap
  during a failover window itself.

## Further reading

- [Failover — Wikipedia](https://en.wikipedia.org/wiki/Failover)
- [Redundancy and disaster recovery — Azure Well-Architected Framework](https://learn.microsoft.com/en-us/azure/well-architected/reliability/redundancy)
