---
title: "Noisy Neighbor"
sidebar_position: 8
supplementary: true
---

The noisy neighbor antipattern occurs in a multi-tenant system when one
tenant consumes a disproportionate share of a shared resource — CPU,
disk I/O, database connections, network bandwidth — and, in doing so,
degrades performance for every other tenant sharing that same resource.
The system as a whole may show healthy aggregate utilization while
specific tenants experience real, unexplained slowdowns caused entirely
by someone else's load.

![Noisy Neighbor diagram](/img/patterns/noisy-neighbor.svg)

## How it manifests

The signature symptom is uncorrelated latency: tenant A's request
volume and resource usage are flat and unremarkable, yet tenant A's
p99 latency spikes at times that correlate precisely with tenant B
running a large batch job or an unusually heavy query — nothing about
tenant A's own behavior explains the degradation they're experiencing.
Support tickets in this shape are hard to diagnose from the inside
because the affected tenant's own logs and metrics look completely
normal; the cause is entirely external to them and invisible without
per-tenant resource attribution across the whole shared system.

It commonly shows up at the database layer first — a shared database
serving many tenants where one tenant runs an unusually expensive
report query, a bulk import, or simply has a much larger data volume
than others, and that single tenant's query saturates I/O or holds
locks that stall unrelated queries for every other tenant on the same
instance. It also shows up at the compute layer: containers or
processes for different tenants co-located on the same host, sharing
CPU and memory bandwidth, where one tenant's CPU-bound workload starves
CPU time actually needed by others — a starvation problem that can
happen even when the host's overall CPU utilization number looks
unremarkable in aggregate, because the contention is about scheduling
fairness in a given moment, not raw total capacity.

The underlying structural cause is always the same: no enforced,
per-tenant limit on the shared resource. Nothing stops one tenant from
consuming as much of the shared pool as their workload happens to
demand, so the system's fairness (or lack of it) is entirely
incidental — however the underlying scheduler, connection pool, or I/O
subsystem happens to arbitrate contention, with no tenant-aware policy
directing it. Two tenants with wildly different workload sizes sharing
infrastructure sized for the average case is the most common trigger:
a platform built assuming roughly similar tenant sizes gets one
customer whose usage is 100x the median, and that one customer's normal
behavior becomes everyone else's noisy neighbor.

## Why it happens

Multi-tenancy without per-tenant resource isolation is usually the
simpler, cheaper starting architecture: one shared database, one shared
compute cluster, no per-tenant quotas to configure, monitor, or
justify — and it works fine as long as tenants are similarly sized and
none of them is unusually demanding. Building real per-tenant isolation
(resource quotas, dedicated connection pool slices, cgroup-level CPU
limits) is genuine additional infrastructure work that isn't needed for
correctness — the system functions correctly without it, it just isn't
fair under contention — so it's easy to defer, especially before the
platform has any tenant large enough to actually cause the problem.

It also tends to be discovered reactively rather than designed against
proactively: a platform grows from a handful of small, similarly sized
early customers to a mix that includes one much larger account, and the
noisy-neighbor effect only becomes visible once that size disparity
actually exists in production traffic — there was no single moment
where a design decision was clearly wrong, just an assumption (tenants
are roughly comparable in size) that stoped holding as the customer
base diversified.

## Code example (the antipattern)

```rust
// A shared connection pool with no per-tenant limit — any single
// tenant can acquire as many connections as they ask for, up to the
// pool's total capacity, starving every other tenant sharing it.
struct SharedConnectionPool {
    total_capacity: u32,
    in_use: u32,
}

impl SharedConnectionPool {
    fn acquire(&mut self, _tenant_id: u64, requested: u32) -> Result<u32, String> {
        // No check against how much this specific tenant already
        // holds — a single large tenant can claim the entire pool.
        if self.in_use + requested > self.total_capacity {
            return Err("pool exhausted".to_string());
        }
        self.in_use += requested;
        Ok(requested)
    }
}
```

## The fix

```rust
use std::collections::HashMap;

// The same shared pool, but with a per-tenant cap enforced on top of
// the total capacity — no single tenant can claim more than their
// fair share, regardless of how much of the pool is otherwise idle.
struct FairConnectionPool {
    total_capacity: u32,
    in_use: u32,
    per_tenant_cap: u32,
    tenant_usage: HashMap<u64, u32>,
}

impl FairConnectionPool {
    fn acquire(&mut self, tenant_id: u64, requested: u32) -> Result<u32, String> {
        let current = *self.tenant_usage.get(&tenant_id).unwrap_or(&0);

        if current + requested > self.per_tenant_cap {
            return Err(format!(
                "tenant {tenant_id} exceeded its per-tenant connection cap"
            ));
        }
        if self.in_use + requested > self.total_capacity {
            return Err("pool exhausted".to_string());
        }

        self.in_use += requested;
        self.tenant_usage.insert(tenant_id, current + requested);
        Ok(requested)
    }
}
```

The fix adds a `per_tenant_cap` check that's evaluated independently of
the pool's overall remaining capacity — a tenant is rejected once
*they* hit their fair share, even if the pool as a whole still has
capacity to give. That guarantees any single tenant's usage is bounded
regardless of how aggressively they try to consume the shared resource,
which is exactly the guarantee an unbounded shared pool doesn't
provide.

## How to detect it

Per-tenant resource usage dashboards, if they exist, showing one
tenant's consumption (query volume, CPU time, connection count) far
outside the range of others is the direct signal — the prerequisite for
detecting this at all is having per-tenant attribution on shared
resource metrics in the first place, which many systems don't build
until they've already been burned by not having it. Correlating one
tenant's latency degradation against a *different* tenant's load spikes
(rather than against their own request volume) is the diagnostic step
that confirms noisy-neighbor specifically, as opposed to the affected
tenant simply sending more traffic than usual. At the infrastructure
level, host-level metrics showing CPU steal time, I/O wait, or run-queue
length spiking while any individual co-located tenant's own reported
usage looks unremarkable point at contention for a shared, unmetered
resource rather than any one workload being at fault in isolation.

## When it's actually fine

In a genuinely single-tenant system, or a multi-tenant system where
all tenants are contractually and practically guaranteed to be small
and similarly sized relative to total capacity, the added complexity of
per-tenant quotas may not be justified — the operational cost of
building and maintaining fairness enforcement should be weighed against
how likely a size disparity actually is to occur. It's also acceptable,
even by design, in systems with tiered service levels where certain
tenants are deliberately allotted a larger guaranteed share of shared
infrastructure as part of what they're paying for — that's differentiated
resource allocation by design, not an accidental noisy-neighbor effect,
as long as it's an explicit, provisioned allocation rather than an
unbounded free-for-all.

## Related patterns

- [Rate Limiter](/docs/patterns/building-blocks/rate-limiter) — enforces
  a per-client (per-tenant) cap on request rate, which is the
  request-level analog of the per-tenant resource cap that fixes noisy
  neighbor at the connection- or resource-pool level.
- [Throttling](/docs/patterns/building-blocks/throttling) — degrades
  the pace or fidelity of a tenant's own work under load rather than
  flatly rejecting it, a complementary way to keep one tenant's
  workload from crowding out others sharing the same infrastructure.
- [Bulkhead](/docs/patterns/reliability/bulkhead) — isolates resource
  pools (thread pools, connection pools) per dependency; the same
  isolation principle applied per-tenant rather than per-dependency is
  exactly what prevents noisy neighbor.

## Further reading

- [Noisy Neighbor antipattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/antipatterns/noisy-neighbor/)
- [Multitenancy — Wikipedia](https://en.wikipedia.org/wiki/Multitenancy)
