---
title: "Compute Resource Consolidation"
sidebar_position: 5
supplementary: true
---

Compute resource consolidation runs multiple small, low-utilization
workloads on shared compute infrastructure instead of giving each
workload its own dedicated, mostly-idle instance, VM, or container host,
so the underlying hardware is actually used instead of sitting idle.

![Compute Resource Consolidation diagram](/img/patterns/compute-resource-consolidation.svg)

## Problem it solves

It's natural to give each distinct task its own computational unit — its
own VM, its own container host, its own App Service plan — because it
keeps the logical design simple: one task, one deployment, no
interference. But every computational unit costs money and consumes
capacity whether it's busy or not, and most individual workloads don't
come close to using a full modern instance's CPU or memory around the
clock. A task that polls a queue every few seconds, or a small internal
API with light traffic, might use a few percent of a dedicated host's
capacity, with the rest simply paid for and unused. Multiply that
pattern across dozens of small workloads and the organization is paying
for — and operationally managing — far more idle capacity than the
actual work requires.

## How it works

Instead of one computational unit per workload, multiple workloads are
grouped onto a smaller number of shared hosts — several apps in the
same App Service plan, several containers on the same Kubernetes node
pool, several batch jobs on the same VM. Grouping is typically done by
matching workloads with complementary or compatible resource profiles:
tasks with similar scaling needs, similar lifetimes, and ideally
different resource-usage shapes (pairing a CPU-heavy task with a
memory-heavy one uses the host's total capacity better than pairing two
CPU-heavy tasks together). The immediate effect is straightforward —
fewer hosts, each one more fully utilized, for a lower total bill and
less infrastructure to patch, monitor, and manage.

That sharing is also the pattern's core risk: workloads on the same host
now compete for the same finite CPU, memory, and I/O, and a resource-hungry
or misbehaving workload can degrade every other workload sharing that
host — the "noisy neighbor" problem. A batch job that suddenly spikes to
100% CPU doesn't just slow itself down; without something stopping it,
it starves every other process scheduled on the same core. Mitigating
this requires deliberately enforcing resource limits or quotas per
workload — CPU shares, memory limits, I/O throttling — so that one
workload's spike is capped rather than allowed to consume capacity
another workload needs. Consolidation without enforced limits trades a
cost problem for a reliability problem; consolidation with limits keeps
the cost win while bounding how much damage one noisy workload can do
to its neighbors.

## Code example

The snippet below models a shared host that assigns each workload a
resource quota and rejects scheduling a workload that would push total
usage past the host's capacity — a simplified stand-in for the limits a
real container runtime or hypervisor enforces.

```rust
struct Workload {
    name: String,
    cpu_millis: u32, // requested CPU quota, in thousandths of a core
}

struct SharedHost {
    capacity_millis: u32,
    scheduled: Vec<Workload>,
}

impl SharedHost {
    fn used_millis(&self) -> u32 {
        self.scheduled.iter().map(|w| w.cpu_millis).sum()
    }

    // Enforces a quota per workload so one noisy workload can't consume
    // capacity beyond what it was granted, and can't overcommit the host.
    fn schedule(&mut self, workload: Workload) -> Result<(), String> {
        if self.used_millis() + workload.cpu_millis > self.capacity_millis {
            return Err(format!(
                "host at capacity: cannot schedule '{}'",
                workload.name
            ));
        }
        self.scheduled.push(workload);
        Ok(())
    }
}

fn consolidate_example() -> Result<(), String> {
    let mut host = SharedHost { capacity_millis: 2000, scheduled: Vec::new() };
    host.schedule(Workload { name: "queue-poller".into(), cpu_millis: 200 })?;
    host.schedule(Workload { name: "internal-api".into(), cpu_millis: 500 })?;
    host.schedule(Workload { name: "report-job".into(), cpu_millis: 300 })?;
    Ok(())
}
```

`schedule` is where the noisy-neighbor risk is contained: each workload
gets a fixed quota (`cpu_millis`) it can't exceed, and the host refuses
to overcommit total capacity across everything it hosts, rather than
letting workloads compete unbounded for the same cores.

## When to use it

- Several workloads are each individually low-utilization but together
  would use a shared host efficiently — a queue poller, a light internal
  API, a periodic batch job.
- The workloads have compatible scaling and lifetime characteristics, so
  grouping them doesn't force one task's scaling needs onto another.
- Resource limits or quotas can be enforced per workload, so
  consolidation doesn't turn into unmanaged resource contention.

## When not to use it

- A workload performs critical, fault-tolerant, or highly sensitive work
  that needs its own isolated failure domain and security context — a
  crash or compromise in a neighboring workload shouldn't be able to
  reach it.
- Workloads have sharply conflicting scalability or resource profiles —
  two compute-intensive tasks, or two memory-hungry tasks, sharing a
  host defeats the purpose and just relocates the contention.
- The platform or team can't enforce per-workload resource limits — without
  quotas, consolidation trades a cost problem for an unpredictable
  reliability problem.

## Real-world example

A Kubernetes cluster commonly runs many small, unrelated services as
separate pods on the same set of worker nodes rather than giving each
service a dedicated node, using CPU and memory `requests`/`limits` per
pod to bound how much of the shared node each workload can consume —
consolidating workloads onto shared infrastructure while using resource
quotas specifically to prevent one pod's spike from starving its
neighbors.

## Related patterns

- [Bulkhead](/docs/patterns/reliability/bulkhead) — isolating the
  resource pools (thread pools, connection pools) used by different
  parts of a system is the same noisy-neighbor mitigation applied at the
  application level rather than the infrastructure level.
- [Vertical Scaling](/docs/patterns/scaling/vertical-scaling) — often
  the enabling move behind consolidation: a larger shared host gives
  consolidated workloads more combined headroom to work with.

## Further reading

- [Compute Resource Consolidation pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/compute-resource-consolidation)
- [Resource contention — Wikipedia](https://en.wikipedia.org/wiki/Resource_contention)
