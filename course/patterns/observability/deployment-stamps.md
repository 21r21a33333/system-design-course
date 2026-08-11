---
title: "Deployment Stamps"
sidebar_position: 7
supplementary: true
---

Deployment stamps deploy multiple independent, complete copies of an
application's full stack — compute, data, everything — each serving a
subset of customers, tenants, or regions, instead of a single shared
multi-tenant deployment serving everyone at once.

![Deployment Stamps diagram](/img/patterns/deployment-stamps.svg)

## Problem it solves

A single shared deployment serving every tenant is efficient in the
sense that no infrastructure is duplicated, but it concentrates every
tenant's risk into the same failure domain: one tenant's noisy traffic
pattern, one bad migration, one runaway query can degrade or take down
service for every other tenant sharing that deployment, because they're
all running against the same compute and the same data layer. Scaling
has the same shared-fate problem — as the shared system grows, it has
to scale as one increasingly large, increasingly complex unit, and
tenants with wildly different scale or compliance needs (a customer
that needs data kept in a specific region, or isolated for regulatory
reasons) can't easily be accommodated within a single shared deployment
without special-casing logic throughout. Deployment stamps solve this
by giving each subset of tenants its own complete, independent copy of
the stack, so one stamp's problems stay contained to that stamp.

## How it works

A "stamp" (also called a cell or a shard, depending on the vendor) is a
full, independently deployable copy of the entire application stack —
its own compute, its own database, its own queues, everything the
application needs to serve requests end to end, with nothing shared
with any other stamp. Customers or tenants are assigned to a specific
stamp, usually via a routing layer that looks up which stamp a given
tenant belongs to and directs their traffic there; a tenant's data and
traffic never cross into another stamp. Scaling the system to serve
more customers means adding more stamps rather than growing one shared
system ever larger — capacity scales by replication of the whole unit,
not by scaling any single component within a shared unit past its
comfortable limits. This comes at a real infrastructure cost: N stamps
means N complete copies of compute and data, most of which sit at
whatever utilization that stamp's assigned tenants produce, rather than
one shared pool of resources multiplexed efficiently across everyone.
What that cost buys is strong isolation — a bad deploy, a runaway
tenant, or a regional outage affecting one stamp has no path to affect
any other stamp, because there's no shared infrastructure between them
for a problem to travel across.

## Code example

The snippet below models the routing decision — mapping a tenant to its
assigned stamp and confining that tenant's request to that stamp alone.

```rust
struct Stamp {
    id: String,
    tenants: Vec<String>,
}

struct StampRouter {
    stamps: Vec<Stamp>,
}

impl StampRouter {
    // Every tenant maps to exactly one stamp — no request ever spans
    // more than one, which is what gives stamps their isolation.
    fn stamp_for(&self, tenant: &str) -> Option<&Stamp> {
        self.stamps.iter().find(|s| s.tenants.iter().any(|t| t == tenant))
    }

    // Adding capacity means adding a whole new stamp, not resizing an
    // existing shared one.
    fn add_stamp(&mut self, id: &str, tenants: Vec<String>) {
        self.stamps.push(Stamp { id: id.to_string(), tenants });
    }
}

fn route_request(router: &StampRouter, tenant: &str) -> String {
    match router.stamp_for(tenant) {
        Some(stamp) => format!("routing {tenant} to stamp {}", stamp.id),
        None => format!("no stamp assigned for tenant {tenant}"),
    }
}
```

`stamp_for` is the isolation boundary in code: a tenant resolves to
exactly one stamp, so a bug or overload in one stamp's compute or data
has no code path that could ever touch a different tenant's stamp.

## When to use it

- Strong tenant isolation is a hard requirement — regulatory, contractual,
  or simply to guarantee one tenant's load or failure can't affect
  another's.
- Different tenants or regions need independently tunable scale,
  versioning, or even data residency, which a single shared deployment
  can't offer without extensive per-tenant special-casing.
- The team wants to scale capacity by adding replicated units rather
  than continuously scaling one increasingly large shared system.

## When not to use it

- Tenants are small, numerous, and homogeneous enough that shared
  infrastructure is far more cost-efficient, and isolation between them
  isn't a real requirement.
- The added operational overhead of deploying, monitoring, and
  upgrading N independent stamps — instead of one shared system —
  outweighs the isolation benefit for the workload in question.

## Real-world example

A B2B SaaS platform serving large enterprise customers deploys a
separate stamp per major customer (or per small cluster of smaller
customers), each with its own database and application tier, routed to
by a front-door service that maps an incoming request's tenant ID to
its assigned stamp. A performance incident or bad deploy affecting one
enterprise customer's stamp has no way to touch any other customer's
stamp, since neither compute nor data is shared between them.

## Related patterns

- [Horizontal Scaling](/docs/patterns/scaling/horizontal-scaling) —
  scales capacity by adding more instances of a shared system; stamps
  scale by replicating the *entire* stack as an isolated unit instead of
  one shared component.
- [Bulkhead](/docs/patterns/reliability/bulkhead) — isolates resources
  within a single deployment so one consumer can't exhaust another's
  share; stamps apply that same isolation principle at the coarsest
  possible granularity, an entire independent deployment per subset of
  tenants.
- [Geode](/docs/patterns/observability/geode) — also replicates the full
  stack across multiple units, but geodes replicate the *same*
  capability everywhere so any geode can serve any request, prioritizing
  latency over the tenant-partitioning isolation stamps provide.

## Further reading

- [Deployment Stamps pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/deployment-stamp)
- [Multitenancy — Wikipedia](https://en.wikipedia.org/wiki/Multitenancy)
