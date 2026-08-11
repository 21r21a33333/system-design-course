---
title: "Federation"
sidebar_position: 9
supplementary: true
---

Federation splits a single monolithic data store or service into
several independent stores, divided by function or domain — orders in
one, users in another, inventory in a third — rather than by a hash or
range of a shared key the way sharding does, so each functional area
can be scaled, operated, and evolved on its own.

![Federation diagram](/img/patterns/federation.svg)

## Problem it solves

A single database backing an entire application eventually becomes a
bottleneck along more than one dimension at once: it's a single point
of contention for every team touching every feature, a single schema
that every change has to be coordinated against, and a single capacity
unit that has to be sized for the sum of every feature's peak load at
once, even though different features rarely peak together. Sharding by
a key like user ID addresses the capacity dimension but does nothing
for the organizational one — every shard still holds the entire
schema, so a change to the orders table still has to be coordinated
across teams that have nothing to do with orders. Federation solves the
organizational and functional coupling directly: by splitting the data
store along functional boundaries instead of a hash of a key, each
functional store's schema, scaling profile, and even underlying
database technology become independent decisions, and a team owning
one functional area can change or scale its store without touching or
even understanding the others.

## Technical architecture & implementation

**Splitting by function, not by key.** The defining move in federation
is choosing the partition boundary along the application's functional
domains — users, orders, inventory, billing, catalog — rather than
along a value computed from a row's key. Each resulting federate is a
complete, independent store for its domain: it has its own schema, its
own connection pool, and commonly its own choice of database engine
entirely, since a catalog service optimized for full-text search and a
billing service requiring strict transactional guarantees have little
reason to share a storage technology just because they once lived in
the same database. This is a design-time, largely static decision
(which domain does this table belong to) rather than a runtime routing
function computed per request the way a shard key is.

**Routing and query patterns.** An application (or a routing/gateway
layer in front of the federates) directs each request to the federate
that owns the relevant domain, typically based on the API endpoint or
service boundary being called rather than a hash computation — a
request for order history goes to the orders federate, a request for a
user's profile goes to the users federate, with no ambiguity about
which store to query because the split was made along exactly those
lines. The mechanical cost this introduces is the same shape as
sharding's cross-shard problem, but it shows up at the level of
features rather than rows: any operation that needs data from more than
one federate — a page that shows a user's name (users federate) next to
their order history (orders federate) — can no longer be satisfied by
a single query to a single store. It requires the calling layer to
query each relevant federate separately and assemble the result, or a
dedicated aggregation layer (see
[Gateway Aggregation](/docs/patterns/api-edge/gateway-aggregation)) to
do that assembly centrally, and any true cross-domain transaction
(updating both a user's balance and an order's status atomically)
requires the same distributed-transaction machinery — or a
[Saga](/docs/patterns/consistency/saga) — that any multi-store system
needs, since there's no longer a single database engine that can
enforce atomicity across both.

**Failure and consistency implications.** Because each federate is
independent, the failure of one doesn't directly take down the others
— the orders federate being unreachable doesn't stop users from
reading their profiles from the still-healthy users federate, which is
a real availability benefit over a single monolithic store where every
feature shares the same fate. The trade is that the system as a whole
loses any single consistent view: there is no longer one transaction
log or one point of strict consistency spanning all the data, so a
read that combines data from two federates can observe a
moment-in-time inconsistency (one federate reflecting a slightly older
or newer state than the other) that would have been impossible when
both lived in the same database and the same transaction.

**Federation vs. Sharding.** Both split a data store into multiple
physical instances, and it's easy to conflate them, but the axis of
the split is different and it changes what each is good for.
[Sharding](/docs/patterns/storage/sharding) splits *rows within one
logical schema* by a key, so every shard looks structurally identical
(the same tables, the same schema) and holds a disjoint subset of the
same kind of data — it scales one domain's capacity and write
throughput horizontally. Federation splits *the schema itself* along
functional lines, so each federate looks structurally different from
the others and holds an entirely different kind of data — it scales
organizational and operational independence between domains, not the
capacity of any single domain. The two compose naturally: a large
system commonly federates first (orders, users, inventory as separate
stores) and then, if any one federate's data volume outgrows a single
instance, shards that specific federate independently by a key, with
the sharding decision made per-federate rather than for the whole
system at once.

## Code example

```rust
use std::collections::HashMap;

#[derive(Clone, Debug)]
enum Domain {
    Users,
    Orders,
    Inventory,
}

// Each federate is a fully independent store — no shared schema or
// connection with the others, only a domain it's authoritative for.
struct Federate {
    domain: Domain,
    records: HashMap<String, String>,
}

// The routing layer decides which federate owns a request based on
// domain, not on a hash of a key the way a shard router would.
struct FederationRouter {
    federates: Vec<Federate>,
}

impl FederationRouter {
    fn route(&mut self, domain: &Domain) -> Option<&mut Federate> {
        self.federates
            .iter_mut()
            .find(|f| std::mem::discriminant(&f.domain) == std::mem::discriminant(domain))
    }

    // A cross-domain read has to query each relevant federate
    // separately and assemble the result here — no single store can
    // answer it in one query.
    fn user_order_summary(&self, user_id: &str, order_id: &str) -> Option<(String, String)> {
        let users = self.federates.iter().find(|f| matches!(f.domain, Domain::Users))?;
        let orders = self.federates.iter().find(|f| matches!(f.domain, Domain::Orders))?;
        let name = users.records.get(user_id)?.clone();
        let order = orders.records.get(order_id)?.clone();
        Some((name, order))
    }
}
```

`route` picks a federate purely by which domain owns the request;
`user_order_summary` shows the structural cost of federation directly —
combining data that spans two domains means querying two independent
stores and assembling the result in application code, rather than one
join against one schema.

## When to use it

- The application has clearly separable functional domains — users,
  orders, billing, catalog — each with different scaling profiles,
  different teams owning them, or different storage-technology needs.
- Organizational coupling (every team's schema change contending for
  the same database, the same migration queue, the same on-call
  rotation) is a bigger practical problem right now than any single
  domain's raw capacity.
- Cross-domain reads and transactions are relatively rare, or already
  go through a service boundary (an API call, an aggregation layer)
  rather than a direct cross-table query, so splitting the underlying
  stores doesn't break an existing access pattern.

## When not to use it

- The domains are tightly coupled with frequent cross-domain
  transactions that must be atomic — federation turns every one of
  those into a distributed-transaction or saga problem that a single
  shared database would have handled natively and more simply.
- The actual problem is capacity or write throughput within a single
  domain, not organizational or technological independence between
  domains — that's what [Sharding](/docs/patterns/storage/sharding)
  addresses directly, without introducing cross-domain query
  complexity.
- The system is small enough, or early enough, that a single
  well-organized schema with clear internal boundaries (even if not
  physically separate stores) gives most of the organizational benefit
  without the operational overhead of running and coordinating several
  independent stores.

## Use-case scenarios

**E-commerce platform split by domain.** A growing e-commerce company
federates its once-monolithic database into separate stores for users,
catalog, orders, and inventory, each owned by a different team and each
free to choose its own scaling strategy — the catalog store adopts a
search-optimized engine for product discovery, while the orders store
stays on a strictly transactional relational database, and a
[Gateway Aggregation](/docs/patterns/api-edge/gateway-aggregation) layer
assembles product-detail pages that need both catalog and inventory
data from their respective federates.

**Enterprise SaaS platform organized by business capability.** A B2B
SaaS product federates its data store along business-capability lines —
billing, user management, and product-usage analytics each get their
own store, operated by the team that owns that capability, with
different compliance and retention requirements handled independently
(billing data under stricter audit retention than usage analytics)
rather than forcing one shared schema and one shared retention policy
across data that has fundamentally different requirements.

**Media platform separating hot and cold data domains.** A video
platform federates metadata (titles, descriptions, view counts) into
one store optimized for frequent small reads and writes, and archival
transcoding job history into a separate store optimized for large,
infrequently-read batch records — the two domains have such different
access patterns that keeping them in one schema on one engine would
mean tuning that engine for a compromise that serves neither pattern
well.

## Related patterns

- [Sharding](/docs/patterns/storage/sharding) — splits rows within one
  logical schema by a key to scale a single domain's capacity and
  write throughput; federation splits the schema itself along
  functional lines instead, and the two compose (federate first, then
  shard an individual federate if it outgrows one instance).
- [Gateway Aggregation](/docs/patterns/api-edge/gateway-aggregation) —
  the common way to assemble a response that spans more than one
  federate into a single API answer, since no single federate can
  satisfy a cross-domain query on its own.
- [Saga](/docs/patterns/consistency/saga) — the pattern for maintaining
  correctness across a multi-step operation that touches more than one
  federate, since federation removes the single-database transaction
  boundary that would otherwise make such an operation atomic for
  free.
- **Not to be confused with:** [Federated
  Identity](/docs/patterns/api-edge/federated-identity), an unrelated
  pattern despite the shared name — Federated Identity is about
  delegating user *authentication* to an external identity provider
  (OAuth2, OIDC, SAML) so an application doesn't manage its own
  passwords. This page, Federation, is about splitting an
  application's own *data storage or internal services* by function.
  The two solve completely different problems and neither implies or
  requires the other; a federated data store has no particular
  relationship to how its users log in.

## Further reading

- [Federated database system — Wikipedia](https://en.wikipedia.org/wiki/Federated_database_system)
- [Data federation — Wikipedia](https://en.wikipedia.org/wiki/Data_federation)
