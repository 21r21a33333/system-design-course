---
title: "Horizontal Scaling"
sidebar_position: 2
supplementary: true
---

Horizontal scaling (scaling out) increases capacity by adding more
machines to a pool that share the load, rather than making any one
machine bigger. Instead of a single box doing all the work, a fleet of
interchangeable instances does it in parallel behind a load balancer.

![Horizontal Scaling diagram](/img/patterns/horizontal-scaling.svg)

## Problem it solves

[Vertical scaling](/docs/patterns/scaling/vertical-scaling) runs into a
hard ceiling: there is always a biggest instance type available, and a
single machine is always a single point of failure. Horizontal scaling
solves both problems at once. Capacity grows by adding commodity machines
rather than chasing an ever-bigger one — so there's no fixed ceiling — and
because there are now many machines, the loss of any one of them doesn't
take the service down. It also unlocks *elasticity*: when capacity is a
count of identical instances, that count can be raised and lowered
cheaply and continuously, which is the foundation
[auto-scaling](/docs/patterns/scaling/auto-scaling) builds on.

## Technical architecture & implementation

**Scaling out behind a load balancer.** The request-serving tier becomes
a fleet of identical instances, and a
[load balancer](/docs/patterns/api-edge/load-balancing) distributes
incoming requests across them, routing around any instance that fails a
[health check](/docs/patterns/observability/health-check). Adding capacity
is now "launch another identical instance and register it" rather than
"resize and restart the one machine." Because the instances are
interchangeable, capacity scales in fine-grained increments and, within
limits, close to *linearly* — two instances serve roughly twice the
throughput of one.

**The statelessness requirement.** For any instance to handle any
request, the instances must not hold request-specific state locally. If
instance A holds a user's session in memory, the load balancer can't
freely send that user's next request to instance B — you're forced into
sticky sessions, which undermine even load distribution and lose state on
instance failure. The fix is to **externalize state**: sessions go to a
shared store (a distributed cache or database), uploads go to a
[blob store](/docs/patterns/building-blocks/blob-store), and anything an
instance keeps locally is treated as disposable cache. This is important
enough to have its own section below.

**Partitioning the data tier.** Statelessness solves the compute tier, but
the *data* can't simply be replicated to every node once it's large —
each node would need a full copy, and writes would have to fan out
everywhere. Instead the dataset is partitioned via
[sharding](/docs/patterns/storage/sharding): each machine owns a disjoint
slice, and a routing layer maps each key to its owning shard. This is how
horizontal scaling reaches the stateful tier, and it brings its own
operational surface — rebalancing when shards get hot, and cross-shard
queries that touch many nodes at once.

**Near-linear scaling and its limits.** Adding instances does *not* buy
unlimited throughput. Two effects bend the curve, formalized by the
**Universal Scalability Law** (Neil Gunther's extension of Amdahl's law).
First, **contention**: any serial fraction of the work that can't be
parallelized (a shared lock, a single coordinator) caps the speedup no
matter how many nodes you add — this is Amdahl's law. Second,
**coherency**: the cost of nodes coordinating with each other (cache
invalidation, consensus chatter, cross-shard joins) grows roughly
*quadratically* with node count, so past some point adding a node
*reduces* total throughput. The practical lesson: horizontal scaling has
no hard ceiling, but shared bottlenecks and coordination create a soft
one. The `## Code example` models this directly and finds the node count
where more nodes start hurting.

**Shared bottlenecks.** A fleet is only as scalable as its most-shared
dependency. A thousand stateless app servers all hammering one
un-sharded primary database just move the bottleneck downstream — the
database becomes the serial fraction. Scaling out effectively means
scaling out (or relieving, via caching and queues) every shared resource
on the hot path, not just the tier that first ran hot.

**Cost and operational granularity.** Horizontal scaling trades the
super-linear cost curve of huge machines for many cheap commodity ones,
and lets capacity move in small steps. The counterweight is operational
complexity: load balancers, service discovery, health checking,
distributed configuration, partition rebalancing, and the debugging
reality that a request may touch any of dozens of instances.

**Horizontal vs. vertical vs. auto-scaling.** Horizontal scaling adds
**more machines** (scale out) — no ceiling, built-in redundancy, but
requires statelessness or sharding.
[Vertical scaling](/docs/patterns/scaling/vertical-scaling) makes **one
machine bigger** (scale up) — dead simple, but ceiling-bound and a single
point of failure. They're not exclusive: a common pattern is to scale each
instance up to a sensible size *and* run many of them.
[Auto-scaling](/docs/patterns/scaling/auto-scaling) is the automation that
adjusts the instance *count* to match load; it presupposes a
horizontally-scalable, stateless-or-partitioned fleet — you can't safely
add and remove instances that hold irreplaceable local state.

## The statelessness requirement

Statelessness is the load-bearing precondition for scaling out the
compute tier, and it's the piece teams most often get wrong. "Stateless"
doesn't mean the *system* holds no state — it means no request depends on
state that lives *only* in the memory of a specific instance. Concretely:

- **Session and auth state** move to a shared store or a signed token
  (e.g. a JWT) the client carries, so any instance can validate it.
- **Uploads and generated files** go to shared object storage, not the
  local disk of whichever instance handled the upload.
- **In-process caches** are treated as disposable — a cache miss on a
  fresh or restarted instance is a performance hit, never a correctness
  bug — and cross-instance sharing goes through a
  [distributed cache](/docs/patterns/building-blocks/distributed-cache).
- **Long-lived connections** (WebSockets, SSE) either route through a
  shared pub/sub layer or accept that a dropped instance drops its
  connections, to be re-established elsewhere.

Get this right and adding capacity is trivial: launch an instance, add it
to the pool. Get it wrong and you're forced into sticky sessions, which
pin users to instances, unbalance load, and lose state whenever an
instance dies — defeating both the scalability and the availability the
pattern is supposed to deliver.

## Code example

The core tension of scaling out is that throughput does *not* grow forever
with node count. This models the Universal Scalability Law — ideal linear
scaling degraded by a serial **contention** fraction and a quadratic
**coherency** cost — and finds the node count past which adding nodes
actually hurts.

```rust
// Universal Scalability Law: throughput as N nodes are added. Ideal scaling
// is linear (N x per-node capacity), but two real effects bend the curve:
// contention (a serial fraction, sigma) and coherency (cross-node
// coordination that grows quadratically, kappa).
fn usl_throughput(n: f64, per_node: f64, sigma: f64, kappa: f64) -> f64 {
    let scale = n / (1.0 + sigma * (n - 1.0) + kappa * n * (n - 1.0));
    per_node * scale
}

// Smallest N (up to a cap) at which adding one more node no longer improves
// throughput — the peak of the USL curve.
fn peak_node_count(per_node: f64, sigma: f64, kappa: f64, cap: u32) -> u32 {
    let mut best_n = 1u32;
    let mut best_tput = usl_throughput(1.0, per_node, sigma, kappa);
    for n in 2..=cap {
        let t = usl_throughput(n as f64, per_node, sigma, kappa);
        if t > best_tput { best_tput = t; best_n = n; }
    }
    best_n
}

fn main() {
    let per_node = 1000.0; // requests/sec a single node serves alone

    // A near-stateless fleet: tiny serial fraction, negligible coordination.
    let ideal = usl_throughput(50.0, per_node, 0.0, 0.0);
    let good  = usl_throughput(50.0, per_node, 0.02, 0.0);

    // A chatty, coordination-heavy fleet: coherency cost dominates at scale.
    let peak = peak_node_count(per_node, 0.05, 0.001, 500);
    let at_peak = usl_throughput(peak as f64, per_node, 0.05, 0.001);
    let at_2x   = usl_throughput((peak * 2) as f64, per_node, 0.05, 0.001);

    println!("ideal@50={:.0} good@50={:.0} peak_N={} tput@peak={:.0} tput@2x={:.0}",
        ideal, good, peak, at_peak, at_2x);
}
```

Running this prints `ideal@50=50000 good@50=25253 peak_N=31
tput@peak=9038 tput@2x=7916`. Perfectly parallel work scales linearly to
50,000 rps; a mere 2% serial fraction already halves that; and a chatty
fleet peaks at 31 nodes — beyond which throughput actually *falls* (7,916
at 62 nodes, below the 9,038 at 31). That downturn is the coordination
tax made concrete: horizontal scaling has no hard ceiling, but shared
serial work and cross-node chatter impose a soft one.

## When to use it

- Load is expected to grow past what any single machine could handle, so
  a strategy with no theoretical ceiling is needed.
- High availability matters — the fleet should keep serving even if
  individual instances fail or are drained for maintenance.
- The workload (or its data) can be made stateless, cacheable, or
  partitionable without requiring strong coordination on every request.
- The load is variable enough that elastic, fine-grained capacity — the
  thing [auto-scaling](/docs/patterns/scaling/auto-scaling) automates —
  would save real money over a fixed large machine.

## When not to use it

- The application holds significant in-process state (sessions, in-memory
  caches, sticky connections) that's expensive to externalize, and
  there's no time or need to make it stateless first — scale *up* to buy
  time before scaling out.
- The workload is inherently hard to partition — it needs strongly
  consistent, low-latency access to the same small dataset from every
  node, where cross-node coordination would exceed the benefit of adding
  nodes (the coherency term dominates from the start).
- Current load fits comfortably on a single larger machine and the added
  operational complexity — load balancing, service discovery, partition
  rebalancing — isn't worth it yet.

## Use-case scenarios

**Stateless web-server fleet.** The canonical case: dozens or hundreds of
identical application-server instances behind a load balancer, any of
which can serve any HTTP request because none hold request-specific state
locally. Sessions live in a shared store, uploads in object storage.
Adding capacity is launching more identical instances; the load balancer
routes around any that fail health checks. This is the fleet that
[auto-scaling](/docs/patterns/scaling/auto-scaling) then grows and shrinks
automatically.

**Sharded database for write throughput.** A single primary can no longer
absorb the write volume, so the dataset is sharded by customer ID across
many database nodes, each owning a disjoint key range. A routing layer
sends each write to its owning shard, so aggregate write capacity grows
with node count — the horizontal answer for a stateful tier that vertical
scaling's ceiling can no longer serve.

**Stream-processing consumer group.** A high-volume event stream is
partitioned, and a group of consumer instances splits the partitions
between them, each processing its assigned slice in parallel. Adding
consumers (up to the partition count) raises throughput near-linearly;
if a consumer dies, its partitions are reassigned to the survivors —
horizontal scaling and fault tolerance from the same mechanism.

## Related patterns

- [Vertical Scaling](/docs/patterns/scaling/vertical-scaling) — the
  simpler alternative of making one machine bigger; often applied first,
  and frequently combined with horizontal scaling (bigger instances *and*
  more of them).
- [Auto-Scaling](/docs/patterns/scaling/auto-scaling) — automates the
  adding and removing of instances in a horizontally-scaled fleet in
  response to load.
- [Load Balancing](/docs/patterns/api-edge/load-balancing) — the component
  that distributes requests across the fleet and routes around unhealthy
  instances, making the instances interchangeable.
- [Sharding](/docs/patterns/storage/sharding) — the data-partitioning
  technique that extends horizontal scaling to stateful, data-holding
  tiers like databases.
- [Health Check](/docs/patterns/observability/health-check) — the probe a
  load balancer uses to decide which instances in the fleet should
  receive traffic.

## Further reading

- [Scalability — Wikipedia](https://en.wikipedia.org/wiki/Scalability)
- [Amdahl's law — Wikipedia](https://en.wikipedia.org/wiki/Amdahl%27s_law)
- [Neil J. Gunther (Universal Scalability Law) — Wikipedia](https://en.wikipedia.org/wiki/Neil_J._Gunther)
- [Elastic Load Balancing — AWS documentation](https://docs.aws.amazon.com/elasticloadbalancing/latest/userguide/what-is-load-balancing.html)
- [Horizontal Pod Autoscaling — Kubernetes documentation](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)
