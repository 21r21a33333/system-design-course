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

## Technical architecture & implementation

**Grouping and placement (bin-packing).** Instead of one computational
unit per workload, multiple workloads are grouped onto a smaller number
of shared hosts — several apps in the same App Service plan, several
containers on the same Kubernetes node pool, several batch jobs on the
same VM. Deciding what goes where is a **bin-packing** problem: pack
workloads (items with CPU/memory sizes) onto hosts (bins with fixed
capacity) using as few hosts as possible without overflowing any of
them. Bin-packing is NP-hard, so real schedulers use heuristics —
first-fit-decreasing (sort largest-first, place each on the first host
with room) is the classic one, and the `pack` function in the code
example implements exactly it. Good grouping also matches
**complementary resource shapes**: pairing a CPU-heavy task with a
memory-heavy one fills a host's total capacity better than stacking two
CPU-heavy tasks, and matching similar scaling needs and lifetimes keeps
one workload's rhythm from dictating another's. The immediate effect is
straightforward — fewer hosts, each more fully utilized, for a lower
total bill and less infrastructure to patch, monitor, and manage.

**The scheduler as the mechanism.** In practice a container orchestrator
does the placement continuously. Kubernetes' scheduler, for example,
reads each pod's `requests` (how much it needs, used for placement) and
`limits` (the hard ceiling it can consume, used for enforcement) and
bin-packs pods onto nodes that can satisfy the requests, respecting
constraints like affinity and taints. Consolidation is largely the act
of running many workloads through such a scheduler on a shared node pool
rather than statically pinning each to its own machine.

**The utilization-versus-isolation tradeoff.** Every step toward higher
utilization gives up some isolation, and this is the pattern's defining
tension. Sharing is also its core risk: workloads on the same host now
compete for the same finite CPU, memory, and I/O, and a resource-hungry
or misbehaving workload can degrade every other workload sharing that
host — the
[noisy neighbor](/docs/patterns/antipatterns/noisy-neighbor) problem. A
batch job that suddenly spikes to 100% CPU doesn't just slow itself
down; without something stopping it, it starves every other process
scheduled on the same core. Beyond performance interference, packing
also concentrates **blast radius** (a host failure now takes down every
workload on it, not one) and weakens the **security boundary** (workloads
sharing a kernel are a softer isolation boundary than separate VMs).

**Enforcing limits.** Mitigating interference requires deliberately
enforcing resource limits or quotas per workload — CPU shares, memory
limits, I/O throttling — so one workload's spike is capped rather than
allowed to consume capacity another needs. On Linux these are **cgroups**;
in Kubernetes they're per-pod `requests`/`limits`. Consolidation without
enforced limits trades a cost problem for a reliability problem;
consolidation with limits keeps the cost win while bounding how much
damage one noisy workload can do to its neighbors. Where the isolation
demand is stronger than cgroups provide — hard security boundaries,
regulatory separation — lightweight VMs (Firecracker, gVisor) restore a
firmer boundary at some density cost.

**Consolidation vs. Deployment Stamps.** Both distribute workloads
across shared infrastructure, but their intent is opposite.
Consolidation **packs many different workloads together** onto shared
compute to raise utilization — the workloads are unrelated and the goal
is density. [Deployment Stamps](/docs/patterns/observability/deployment-stamps)
does the reverse: it **replicates a full stack per tenant (or tenant
group)** into separate, self-contained units, deliberately *not* sharing,
so each stamp is an independent blast-radius and scaling boundary.
Consolidation optimizes for cost through sharing; stamping optimizes for
isolation through separation. A large system often does both — stamps at
the tenant boundary, consolidation of small services *within* a stamp.

## Code example

The snippet below models a shared host that assigns each workload a
resource quota and rejects scheduling a workload that would push total
usage past the host's capacity — a simplified stand-in for the limits a
real container runtime or hypervisor enforces — and then a **first-fit-
decreasing bin-packer** that places a set of workloads onto the fewest
hosts. The `fn main` compares the dedicated baseline (one host per
workload) against the packed result and asserts consolidation used fewer
hosts *and* raised mean utilization; on the sample workloads it packs six
workloads from six hosts at 25% mean utilization down to two hosts at 75%.

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

// First-Fit Decreasing bin-packer: sort workloads largest-first, then place
// each on the first host with room; open a new host only when none fits.
// A standard heuristic for an NP-hard packing problem — the same shape a
// real scheduler uses to consolidate pods onto nodes.
fn pack(mut workloads: Vec<Workload>, host_capacity: u32) -> Vec<SharedHost> {
    workloads.sort_by(|a, b| b.cpu_millis.cmp(&a.cpu_millis));
    let mut hosts: Vec<SharedHost> = Vec::new();
    for w in workloads {
        let mut placed = false;
        for host in hosts.iter_mut() {
            let candidate = Workload { name: w.name.clone(), cpu_millis: w.cpu_millis };
            if host.schedule(candidate).is_ok() {
                placed = true;
                break;
            }
        }
        if !placed {
            let mut host = SharedHost { capacity_millis: host_capacity, scheduled: Vec::new() };
            host.schedule(w).expect("a fresh host always fits a single workload");
            hosts.push(host);
        }
    }
    hosts
}

fn mean_utilization(hosts: &[SharedHost]) -> f64 {
    if hosts.is_empty() {
        return 0.0;
    }
    let sum: f64 = hosts
        .iter()
        .map(|h| h.used_millis() as f64 / h.capacity_millis as f64)
        .sum();
    sum / hosts.len() as f64
}

fn main() {
    let host_capacity = 2000;
    let workloads = vec![
        Workload { name: "queue-poller".into(), cpu_millis: 200 },
        Workload { name: "internal-api".into(), cpu_millis: 500 },
        Workload { name: "report-job".into(), cpu_millis: 300 },
        Workload { name: "webhook-fanout".into(), cpu_millis: 700 },
        Workload { name: "thumbnailer".into(), cpu_millis: 900 },
        Workload { name: "metrics-agg".into(), cpu_millis: 400 },
    ];
    let total: u32 = workloads.iter().map(|w| w.cpu_millis).sum();

    // Dedicated baseline: one host per workload — each host runs a single
    // small workload, so utilization is that workload against a whole host.
    let dedicated = workloads.len();
    let dedicated_util = total as f64 / (dedicated as u32 * host_capacity) as f64;

    let hosts = pack(workloads, host_capacity);
    let packed_util = mean_utilization(&hosts);

    println!(
        "dedicated: {dedicated} hosts, mean util {:.0}% -> packed: {} hosts, mean util {:.0}%",
        dedicated_util * 100.0,
        hosts.len(),
        packed_util * 100.0,
    );
    assert!(hosts.len() < dedicated, "consolidation should use fewer hosts");
    assert!(packed_util > dedicated_util, "consolidation should raise utilization");
}
```

`schedule` is where the noisy-neighbor risk is contained: each workload
gets a fixed quota (`cpu_millis`) it can't exceed, and the host refuses
to overcommit total capacity across everything it hosts, rather than
letting workloads compete unbounded for the same cores. `pack` is the
consolidation itself — it collapses many mostly-idle hosts into a few
well-utilized ones, and the assertions make the win concrete: fewer hosts
carrying the same total work at meaningfully higher utilization.

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

## Use-case scenarios

**Kubernetes node pool for many small services.** A cluster runs dozens
of small, unrelated internal services as separate pods on a shared set of
worker nodes rather than a dedicated node per service. The scheduler
bin-packs pods onto nodes by their CPU/memory `requests`, and per-pod
`limits` bound how much of a shared node each workload can consume — so a
misbehaving pod is throttled or OOM-killed rather than allowed to starve
its neighbors. The result is high node utilization with the noisy-neighbor
blast radius capped by quotas.

**Consolidating idle VMs onto shared App Service plans.** An organization
has drifted into dozens of small internal web apps and APIs, each on its
own App Service plan or VM running at a few percent utilization around the
clock. Rehosting several complementary apps (a light API, a scheduled job,
a low-traffic admin site) onto a smaller number of shared plans collapses
the idle capacity into a much lower bill and far fewer machines to patch
and monitor — the classic cost-driven consolidation, valid precisely
because none of these apps individually justifies a whole host.

**Batch jobs packed onto a shared compute pool.** A data team runs many
periodic ETL and reporting jobs that each need a burst of compute for a
few minutes and then nothing. Instead of a standing cluster per job, the
jobs are submitted to a shared pool where a scheduler packs them onto
available hosts by resource request, with per-job quotas so a runaway job
can't monopolize a host. Pairing CPU-heavy transforms with memory-heavy
aggregations on the same host fills capacity better than stacking like
with like, and the pool scales down when the queue drains.

## Related patterns

- [Noisy Neighbor](/docs/patterns/antipatterns/noisy-neighbor) — the core
  failure mode consolidation must guard against: a co-located workload
  monopolizing shared CPU, memory, or I/O and degrading its neighbors,
  which per-workload quotas exist to bound.
- [Deployment Stamps](/docs/patterns/observability/deployment-stamps) —
  the mirror-image pattern: stamps deliberately *replicate isolated
  stacks* per tenant rather than packing workloads together, trading
  density for blast-radius and tenant isolation.
- [Bulkhead](/docs/patterns/reliability/bulkhead) — isolating the
  resource pools (thread pools, connection pools) used by different
  parts of a system is the same noisy-neighbor mitigation applied at the
  application level rather than the infrastructure level.
- [Vertical Scaling](/docs/patterns/scaling/vertical-scaling) — often
  the enabling move behind consolidation: a larger shared host gives
  consolidated workloads more combined headroom to work with.
- [Auto Scaling](/docs/patterns/scaling/auto-scaling) — complements
  consolidation by growing and shrinking the shared host pool as the
  aggregate demand of the packed workloads rises and falls.

## Further reading

- [Compute Resource Consolidation pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/compute-resource-consolidation)
- [Bin packing problem — Wikipedia](https://en.wikipedia.org/wiki/Bin_packing_problem)
- [Resource contention — Wikipedia](https://en.wikipedia.org/wiki/Resource_contention)
- [Kubernetes scheduler — official docs](https://kubernetes.io/docs/concepts/scheduling-eviction/kube-scheduler/)
