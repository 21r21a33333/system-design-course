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

## Technical architecture & implementation

**The stamp as a unit.** A "stamp" (also called a *cell*, and the
pattern more broadly *cell-based architecture*) is a full,
independently deployable copy of the entire application stack — its own
compute, its own database, its own queues and caches, everything the
application needs to serve requests end to end, with nothing shared with
any other stamp. The defining constraint is that stamps share *no
runtime data-plane infrastructure*: no shared database, no shared
message bus, no shared cache. This is stricter than sharding, where the
compute tier is usually shared and only the data is partitioned; a stamp
replicates the *whole* stack, compute included. That completeness is the
entire source of its isolation — a problem needs a shared component to
travel across, and by construction there isn't one.

**Tenant assignment and the routing layer.** Every tenant is bound to
exactly one stamp, recorded in an authoritative directory (the
"tenant-to-stamp map"). A thin routing layer — a front door, API
gateway, or geo/tenant-aware load balancer — resolves an incoming
request's tenant identity, looks up its stamp, and forwards the request
there. Crucially the router is deliberately kept *stateless and simple*:
it holds no business logic and no tenant data, only the mapping, so that
the router itself is cheap, easy to make highly available, and never a
place where one tenant's data can leak into another's request path. The
mapping is resolved once and cached; it changes only on tenant placement
or migration, not per request.

**Capacity limits and scaling by replication.** Each stamp has a
declared capacity ceiling — a maximum number of tenants (or maximum
aggregate load) it is provisioned and tested to handle. Scaling the
system to serve more customers means *adding stamps*, not growing any
single stamp past its ceiling. This is the opposite instinct from a
shared system, where growth means scaling one ever-larger unit until
some component hits a wall. Because every stamp is a known, bounded size,
its performance and failure characteristics are predictable and
repeatable — you validate one stamp under load and trust that behavior
across all of them. The cost is real: N stamps means N complete copies
of compute and data, most sitting at whatever utilization their assigned
tenants happen to produce, rather than one pool multiplexed efficiently
across everyone.

**Blast-radius isolation and noisy neighbors.** The payoff for that cost
is a bounded blast radius. A bad deploy, a poisoned cache, a runaway
migration, a [noisy-neighbor](/docs/patterns/antipatterns/noisy-neighbor)
tenant saturating CPU or IOPS — each is confined to a single stamp and
the fraction of tenants living on it, because no other stamp shares the
infrastructure the problem is damaging. This is the
[bulkhead](/docs/patterns/reliability/bulkhead) principle applied at the
coarsest possible granularity: an entire independent deployment per
group of tenants, rather than resource pools inside one deployment.

**Deployment and upgrade per stamp.** Because stamps are independent,
they can be *upgraded independently*, which turns the fleet of stamps
into a natural progressive-rollout vehicle. A new version is deployed to
one stamp first, observed, then rolled stamp-by-stamp across the fleet —
much like a [canary](/docs/patterns/observability/canary-deployment) or
[blue-green](/docs/patterns/observability/blue-green-deployment) release,
except the blast radius of a bad release is a whole tenant group rather
than a percentage of shared traffic. A regression discovered on stamp
one is halted before it reaches the rest.

**Failure modes.** The pattern's own weak points are worth naming.
*Fleet-wide operational overhead*: N stamps means N sets of dashboards,
alerts, migrations, and patches — automation and infrastructure-as-code
are not optional at scale, they're the only way to keep a large fleet
consistent. *Stamp-level hotspots*: if tenant load is uneven, one stamp
can be saturated while others idle, so placement (below) must account
for load, not just tenant count. *The router and the directory* are the
only components every request touches, making them the closest thing to
a shared fate — they must be made highly available and are typically
kept minimal precisely to limit that risk. *Cross-stamp operations* —
anything that must span tenants on different stamps, such as a global
report — cut against the grain of the pattern and need a separate
aggregation path.

## Tenant-to-stamp mapping

The heart of the pattern is the placement decision: which stamp a tenant
lands on, and how that binding is stored and resolved. Common
strategies trade simplicity against control:

| Strategy | How it maps | Best when |
| --- | --- | --- |
| **Directory lookup** | An explicit `tenant → stamp` table, updated on placement | You need per-tenant control, migration, and dedicated stamps for big tenants |
| **Hashing** | `hash(tenant_id) mod N` selects the stamp | Tenants are homogeneous and you want zero placement bookkeeping |
| **Geographic** | Tenant's region determines the stamp | Data residency or latency is the driver |
| **Dedicated** | Named large tenants each get their own stamp | A single tenant's scale or compliance needs full isolation |

Most mature systems use an explicit **directory**, because it is the
only strategy that lets you rebalance load, migrate a growing tenant to
a larger stamp, or carve out a dedicated stamp — all without the
disruptive full reshuffle a plain `mod N` hash forces when N changes.
The directory becomes an operational control plane: onboarding a tenant
is a placement decision, and rebalancing is a migration between stamps.

## Code example

The snippet below models the two decisions that define the pattern:
**placement** (assigning a tenant to the least-loaded stamp that still
has capacity headroom) and **routing** (resolving an already-placed
tenant to its stamp). The capacity ceiling is what forces "add a stamp"
rather than "overload an existing one" once the fleet fills up.

```rust
use std::collections::HashMap;

struct Stamp {
    id: String,
    tenants: Vec<String>,
    // Each stamp has a hard capacity ceiling; new tenants go to a stamp
    // with room, and once every stamp is full the answer is "add a stamp",
    // never "overload an existing one".
    capacity: usize,
}

impl Stamp {
    fn has_room(&self) -> bool {
        self.tenants.len() < self.capacity
    }
}

struct StampRouter {
    stamps: Vec<Stamp>,
    // Explicit tenant -> stamp directory, resolved by lookup rather than
    // recomputed per request, so a tenant's stamp is stable and migratable.
    assignments: HashMap<String, String>,
}

enum PlacementError {
    AlreadyAssigned,
    AllStampsFull,
}

impl StampRouter {
    fn new() -> Self {
        StampRouter { stamps: Vec::new(), assignments: HashMap::new() }
    }

    // Adding capacity means adding a whole new stamp, not resizing a
    // shared one.
    fn add_stamp(&mut self, id: &str, capacity: usize) {
        self.stamps.push(Stamp {
            id: id.to_string(),
            tenants: Vec::new(),
            capacity,
        });
    }

    // The isolation boundary: a tenant resolves to exactly one stamp, so a
    // bug or overload in one stamp's compute or data has no code path that
    // could ever touch another tenant's stamp.
    fn stamp_for(&self, tenant: &str) -> Option<&str> {
        self.assignments.get(tenant).map(|s| s.as_str())
    }

    // Placement picks the least-loaded stamp with room, keeping load even
    // and leaving headroom so no single stamp becomes a noisy-neighbor trap.
    fn assign(&mut self, tenant: &str) -> Result<&str, PlacementError> {
        if self.assignments.contains_key(tenant) {
            return Err(PlacementError::AlreadyAssigned);
        }
        let target = self
            .stamps
            .iter_mut()
            .filter(|s| s.has_room())
            .min_by_key(|s| s.tenants.len());
        match target {
            Some(stamp) => {
                stamp.tenants.push(tenant.to_string());
                self.assignments.insert(tenant.to_string(), stamp.id.clone());
                Ok(self.assignments.get(tenant).unwrap())
            }
            None => Err(PlacementError::AllStampsFull),
        }
    }
}

fn route_request(router: &StampRouter, tenant: &str) -> String {
    match router.stamp_for(tenant) {
        Some(stamp) => format!("routing {tenant} to stamp {stamp}"),
        None => format!("no stamp assigned for tenant {tenant}"),
    }
}
```

`assign` enforces the two invariants that make stamps work: a tenant is
placed exactly once (returning `AlreadyAssigned` otherwise), and when
every stamp is at capacity it returns `AllStampsFull` rather than
silently overloading one — the signal to provision another stamp.
`stamp_for` is then a pure directory read: a tenant resolves to one
stamp, so nothing in one stamp's compute or data has a code path to
another tenant's stamp.

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

## Stamps vs. sharding vs. geode

These three patterns all "make more copies," but of different things and
for different reasons — mixing them up leads to the wrong architecture.

- **Sharding** partitions *data* across nodes and usually keeps a
  *shared* compute tier in front. A single request may fan out across
  shards, and a shared component (the query router, a coordinator) can
  still be a common failure point.
  [Sharding](/docs/patterns/storage/sharding) scales the data layer;
  stamps scale the whole stack.
- **Deployment stamps** replicate the *entire stack* per tenant group,
  sharing *nothing* at runtime. The driver is **isolation** — a bounded
  blast radius and independent per-tenant scale, versioning, and
  residency.
- **[Geode](/docs/patterns/observability/geode)** also replicates the
  full stack, but replicates the *same capability* into every region so
  *any* copy can serve *any* request. The driver is **latency** —
  routing each client to its nearest region — and it depends on
  cross-region data replication, whereas a stamp deliberately keeps a
  tenant's data confined to one stamp.

Put crudely: sharding splits the data, stamps split the tenants, geodes
split the geography.

## Use-case scenarios

**Enterprise B2B SaaS with dedicated stamps.** A platform serving large
enterprise customers deploys a separate stamp per major customer (and
small shared stamps for clusters of smaller ones), each with its own
database and application tier. A front-door service maps an incoming
request's tenant ID to its assigned stamp. A performance incident or bad
deploy affecting one enterprise customer's stamp has no path to touch
any other customer's, since neither compute nor data is shared — and a
customer with a data-residency clause simply gets a stamp provisioned in
the required region without special-casing the shared codebase.

**Hyperscale consumer service using cell-based architecture.** A service
with tens of millions of users partitions them across many uniform
"cells," each a self-contained stack sized to a known user count. A thin
cell-routing layer resolves each user to their cell. When a cell nears
its capacity ceiling, a new cell is provisioned and fresh users are
placed there; a poison-pill request or a bad partial deploy degrades at
most one cell's users, capping the blast radius of any single incident
at a fixed, small fraction of the total user base rather than everyone
at once.

**Regulated multi-tenant platform with per-stamp compliance.** A
healthcare or financial SaaS must keep certain tenants' data isolated
for audit and regulatory reasons. Each regulated tenant (or compliance
class) is placed on its own stamp with its own encryption keys, audit
log, and patch cadence, so a compliance boundary is a physical
deployment boundary rather than an application-level access-control rule
that a bug could bypass. Upgrades roll stamp-by-stamp, letting a change
be validated on a low-risk stamp before reaching regulated ones.

## Related patterns

- [Sharding](/docs/patterns/storage/sharding) — partitions *data* across
  nodes behind a typically shared compute tier; stamps replicate the
  *entire* stack (compute included) as an isolated unit per tenant group.
- [Horizontal Scaling](/docs/patterns/scaling/horizontal-scaling) —
  scales capacity by adding more instances of one shared system; stamps
  scale by replicating the whole stack rather than one shared component.
- [Bulkhead](/docs/patterns/reliability/bulkhead) — isolates resources
  within a single deployment so one consumer can't exhaust another's
  share; stamps apply that same isolation principle at the coarsest
  possible granularity, an entire independent deployment per tenant group.
- [Noisy Neighbor](/docs/patterns/antipatterns/noisy-neighbor) — the
  shared-resource contention problem stamps structurally prevent by
  giving each tenant group its own dedicated infrastructure.
- [Canary Deployment](/docs/patterns/observability/canary-deployment) —
  the progressive-rollout discipline a stamp fleet applies naturally by
  upgrading one stamp at a time before rolling across the rest.
- [Geode](/docs/patterns/observability/geode) — also replicates the full
  stack across multiple units, but replicates the *same* capability
  everywhere so any geode can serve any request, prioritizing latency
  over the tenant-partitioning isolation stamps provide.

## Further reading

- [Deployment Stamps pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/deployment-stamp)
- [Reducing the scope of impact with cell-based architecture — AWS Well-Architected](https://docs.aws.amazon.com/wellarchitected/latest/reducing-scope-of-impact-with-cell-based-architecture/reducing-scope-of-impact-with-cell-based-architecture.html)
- [Shuffle sharding: massive and magical fault isolation — AWS Builders' Library](https://aws.amazon.com/builders-library/workload-isolation-using-shuffle-sharding/)
- [Multitenancy — Wikipedia](https://en.wikipedia.org/wiki/Multitenancy)
