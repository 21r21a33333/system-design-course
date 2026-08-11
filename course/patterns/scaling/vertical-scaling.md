---
title: "Vertical Scaling"
sidebar_position: 1
supplementary: true
---

Vertical scaling (scaling up) increases the capacity of a single existing
machine — more CPU cores, RAM, faster storage, or network throughput —
rather than adding more machines to share the load. The workload stays on
one box; that box just gets bigger.

![Vertical Scaling diagram](/img/patterns/vertical-scaling.svg)

## Problem it solves

An application outgrows the resources of the box it runs on: CPU is
pegged, memory is exhausted, or disk I/O can't keep up with request
volume. The simplest possible fix — no code changes, no new coordination
logic, no distributed-systems failure modes — is to move the workload to
a bigger machine. For a single-instance database, a monolith, or any
service not yet built to run as multiple cooperating replicas, vertical
scaling is usually the first lever pulled because it requires nothing
more than picking a larger instance type and restarting. It buys real
headroom with almost zero engineering, which is exactly why it's the
right *first* move so often — and why teams overreach for it long after a
distributed approach would serve them better.

## Technical architecture & implementation

**The resize mechanism.** Scaling up means changing the machine's
instance type or hardware spec to one with more cores, memory, faster
storage, or better bandwidth. In the cloud this is a control-plane
operation: stop the instance, change its type (e.g. `db.t3.medium` →
`db.r6g.2xlarge`), start it again — the disk and network identity are
preserved, only the compute envelope changes. On-prem it means physically
adding RAM or swapping the host. Crucially, **nothing about the
application's architecture changes**: there's still exactly one process
(or one primary) doing all the work, just with more resources beneath it.
No load balancer, no partition map, no consistency protocol across
replicas — the very absence of those is the pattern's whole appeal.

**The hard ceiling.** This is the defining limitation. There is always a
biggest machine you can rent or buy, and a workload that keeps growing
will eventually reach it. Cloud providers publish a finite ladder of
instance sizes; the top rung is a wall. Past that point no resize helps,
and the only remaining move is to distribute the work across machines —
i.e. switch to
[horizontal scaling](/docs/patterns/scaling/horizontal-scaling). Planning
a system's growth means knowing roughly where that wall is *before* you
back into it.

**Super-linear cost at the high end.** Doubling a small instance is
cheap and roughly doubles both capacity and price. But the largest tiers
carry a premium — specialized big-memory or many-core hardware is
disproportionately expensive — so the dollars-per-unit-of-capacity curve
bends *upward* as you climb. The `## Code example` below models exactly
this: cost per thousand units of capacity nearly doubles from the
smallest tier to the largest, so the last doublings of headroom are the
most expensive ones you'll ever buy.

**Resize downtime.** Most resizes require a restart, so scaling up is not
a live, hitless operation the way adding a stateless instance behind a
load balancer is. A managed database resize is a maintenance event
measured in minutes; a self-managed one is a planned outage. Because of
that restart, vertical scaling is a poor tool for **spiky, short-lived**
load — by the time the bigger machine is up, the spike may be over. This
is precisely the gap that
[auto-scaling](/docs/patterns/scaling/auto-scaling) fills by adding and
removing *instances* rather than resizing one.

**It's still a single point of failure.** A bigger machine is still one
machine. All the CPU and RAM in the world doesn't change the fact that if
that box dies, the service dies with it. Availability comes from
*redundancy* — running more than one instance and being able to fail
over — which is a horizontal concern, not something a resize provides.
Managed offerings layer separate mechanisms (multi-AZ standbys, read
replicas) on top precisely because the instance-class resize itself does
nothing for availability.

**Vertical vs. horizontal vs. auto-scaling.** These three are the scaling
trio and are easy to conflate. Vertical scaling makes **one machine
bigger** (scale up); it is the simplest but is ceiling-bound and offers
no redundancy.
[Horizontal scaling](/docs/patterns/scaling/horizontal-scaling) adds
**more machines** (scale out); it has no hard ceiling and provides
redundancy, at the cost of statelessness requirements and operational
complexity.
[Auto-scaling](/docs/patterns/scaling/auto-scaling) is the **automation**
that adds or removes capacity (usually horizontally) in response to
load. The common, healthy progression is: scale up first because it's
free engineering-wise; scale out once you approach the ceiling, need
redundancy, or need to absorb spikes; automate that scale-out with
auto-scaling once the load is variable enough to warrant it.

## Vertical vs. horizontal vs. auto-scaling

| Dimension            | Vertical (scale up)        | Horizontal (scale out)         | Auto-scaling                        |
| -------------------- | -------------------------- | ------------------------------ | ----------------------------------- |
| What changes         | One machine gets bigger    | More machines added            | Instance count adjusts itself       |
| Ceiling              | Hard (largest tier)        | Effectively none               | Bounded by max, but elastic         |
| Redundancy           | None (single box)          | Built-in (many instances)      | Built-in (fleet)                    |
| App changes needed   | None                       | Statelessness / sharding       | Horizontal-ready workload           |
| Reacts to spikes     | Poorly (resize + restart)  | Yes, if capacity is pre-added  | Yes, automatically                  |
| Cost curve           | Super-linear at high end   | Near-linear, fine granularity  | Pay for what load requires          |
| Operational surface  | Minimal                    | Load balancer, discovery       | Controller, metrics, policies       |

## Code example

The model below captures vertical scaling's two hard truths — a finite
ladder of tiers (a **ceiling**) and **super-linear** pricing at the top —
as plain data plus a selection function.

```rust
#[derive(Clone, Copy)]
struct Tier {
    name: &'static str,
    capacity: u32,     // work units/sec this machine can serve
    monthly_cost: u32, // dollars/month
}

// The catalog is finite and ordered by size; the last entry is the ceiling.
fn tiers() -> Vec<Tier> {
    vec![
        Tier { name: "small",   capacity: 1_000,  monthly_cost: 70 },
        Tier { name: "medium",  capacity: 2_000,  monthly_cost: 150 },
        Tier { name: "large",   capacity: 4_000,  monthly_cost: 340 },
        Tier { name: "xlarge",  capacity: 8_000,  monthly_cost: 800 },
        Tier { name: "2xlarge", capacity: 16_000, monthly_cost: 2_100 },
    ]
}

// Cheapest single tier that meets the demand — or None if demand exceeds the
// biggest machine (the vertical-scaling ceiling has been hit).
fn choose_tier(demand: u32) -> Option<Tier> {
    tiers().into_iter().find(|t| t.capacity >= demand)
}

// Dollars per 1000 units of capacity — rises as tiers get bigger.
fn cost_per_kunit(t: &Tier) -> f64 {
    t.monthly_cost as f64 / (t.capacity as f64 / 1000.0)
}

fn main() {
    let ts = tiers();
    let bottom = cost_per_kunit(&ts[0]);
    let top = cost_per_kunit(&ts[ts.len() - 1]);
    println!("cost/kunit: small={:.1} 2xlarge={:.1}", bottom, top);

    // A demand that fits: pick the cheapest sufficient machine.
    let t = choose_tier(5_000).expect("fits under the ceiling");
    println!("demand 5000 -> {} ({} cap)", t.name, t.capacity);

    // A demand past the ceiling: vertical scaling alone cannot serve it.
    let ceiling = ts.last().unwrap().capacity;
    println!("demand {} -> {:?} (must scale out)",
        ceiling + 1, choose_tier(ceiling + 1).map(|t| t.name));
}
```

Running this prints `cost/kunit: small=70.0 2xlarge=131.2` — the per-unit
price nearly doubles up the ladder — then selects `xlarge` for a demand of
5,000, and returns `None` for any demand above 16,000, which is the model
saying in code what the pattern says in prose: past the largest tier, only
scaling *out* remains.

## When to use it

- The system is a single-node component — a primary database, a legacy
  monolith — that wasn't designed to be horizontally distributed, and
  making it distributed is a bigger project than the current pressure
  justifies.
- Current load is close to, but still under, the ceiling of larger
  available hardware, and buying time with a resize is far cheaper than a
  distributed-architecture rewrite.
- Simplicity is the priority: no partitioning logic, no load-balancer
  configuration, no cross-replica consistency concerns — one box, one
  process, more resources.

## When not to use it

- Load is expected to keep growing past the largest available instance
  type. Vertical scaling has a hard ceiling; plan the switch to
  [horizontal scaling](/docs/patterns/scaling/horizontal-scaling) *before*
  you hit the wall, not after.
- High availability is required. A single scaled-up machine is still a
  single point of failure — if it goes down, the whole service goes down,
  regardless of how much CPU or RAM it had. Redundancy is horizontal.
- The workload is spiky or unpredictable. Resizing needs a restart, so it
  can't absorb sudden, short-lived traffic spikes — that's a job for
  [auto-scaling](/docs/patterns/scaling/auto-scaling) over a horizontal
  fleet.

## Use-case scenarios

**Relational database under growing load.** A team's primary Postgres
instance on Amazon RDS starts running hot on CPU and memory as the product
grows. Rather than shard the database (a major project touching every
query path), they bump the instance from `db.t3.large` to `db.r6g.2xlarge`
during a maintenance window. It buys a year of headroom for a config
change and a restart — and they revisit read replicas and sharding only
when the largest sensible instance class is in sight.

**Latency-sensitive in-memory service.** A pricing engine keeps a large
reference dataset entirely in RAM for microsecond lookups. Splitting the
dataset across nodes would add network hops to the hot path, so the team
keeps it on a single big-memory instance and scales *up* — a rare case
where vertical scaling is preferred not for simplicity but because
distributing the data would make the core operation slower.

**Bridging to a rebuild.** A legacy monolith is being incrementally
carved into services via the strangler-fig approach, but that migration
will take quarters. Meanwhile traffic is rising now. The team scales the
monolith's host up one tier to survive the interim, treating vertical
scaling as a deliberate stopgap that keeps the lights on while the real,
horizontal-friendly architecture is built alongside it.

## Production libraries & getting started

Scaling up is usually a control-plane operation on a managed service — resize an instance type, or let a controller right-size a workload's resource requests. These are the production tools that grow a single machine or pod rather than adding more of them.

| Library / Tool | Language | What it gives you | Getting started |
| -------------- | -------- | ----------------- | --------------- |
| Amazon RDS instance resize | Config / AWS | Change a managed database to a larger instance class (more CPU/RAM) as a maintenance operation | [Modifying a DB instance](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Overview.DBInstance.Modifying.html) |
| Google Compute Engine machine-type change | Config / GCP | Stop an instance and move it to a machine type with more cores or memory | [Change machine type](https://cloud.google.com/compute/docs/instances/changing-machine-type-of-stopped-instance) |
| Azure VM resize | Config / Azure | Resize a virtual machine to a different size (more vCPUs, memory, bandwidth) | [Resize a VM](https://learn.microsoft.com/en-us/azure/virtual-machines/resize-vm) |
| Kubernetes Vertical Pod Autoscaler (VPA) | Go / YAML | Recommends and applies right-sized CPU/memory `requests` for a pod based on observed usage | [Vertical Pod Autoscaler](https://github.com/kubernetes/autoscaler/tree/master/vertical-pod-autoscaler) |
| Kubernetes resource requests & limits | YAML | Sets the per-container CPU/memory envelope that vertical right-sizing tunes | [Managing resources](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/) |

**Example / reference:** [Amazon RDS DB instance classes](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Overview.DBInstance.html)

## Related patterns

- [Horizontal Scaling](/docs/patterns/scaling/horizontal-scaling) — the
  alternative that adds more machines instead of a bigger one, avoiding
  vertical scaling's hard ceiling and single-point-of-failure risk; the
  usual next step once scaling up runs out.
- [Auto-Scaling](/docs/patterns/scaling/auto-scaling) — automates
  capacity changes (usually horizontal); the answer to the spiky-load
  case a resize handles poorly.
- [Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication) —
  the separate mechanism that adds read throughput and availability to a
  scaled-up database, which the instance resize itself does not provide.
- [Sharding](/docs/patterns/storage/sharding) — the data-partitioning
  technique you reach for when a single database, however large, can no
  longer hold or serve the dataset.

## Further reading

- [Scalability — Wikipedia](https://en.wikipedia.org/wiki/Scalability)
- [Amazon RDS DB instances — AWS documentation](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Overview.DBInstance.html)
- [Amdahl's law — Wikipedia](https://en.wikipedia.org/wiki/Amdahl%27s_law)
