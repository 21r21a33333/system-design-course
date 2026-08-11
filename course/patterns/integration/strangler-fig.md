---
title: "Strangler Fig"
sidebar_position: 3
supplementary: true
---

The Strangler Fig pattern migrates a legacy system incrementally by
routing a growing share of functionality to new services while the
legacy system keeps handling everything not yet migrated, until the
legacy system has nothing left to do and can be retired.

![Strangler Fig diagram](/img/patterns/strangler-fig.svg)

## Problem it solves

Rewriting a large legacy system in one shot is risky: the rewrite
takes months or years, nothing new ships to users in the meantime, and
the "big bang" cutover at the end is a single high-stakes moment where
everything can go wrong at once. Business requirements also keep
changing while the rewrite is in progress, so the target the rewrite
is aiming at keeps moving. The Strangler Fig pattern — named after the
strangler fig vine, which grows around a host tree and gradually
replaces it without the tree ever being felled outright — avoids this
by migrating one piece of functionality at a time, shipping each piece
as it's ready, and keeping the legacy system fully operational for
everything that hasn't moved yet.

## Technical architecture & implementation

**The routing facade.** The whole pattern hinges on interposing a
facade — a reverse proxy, an API gateway, or an in-process router —
between callers and the two systems, so that no client ever addresses
the legacy system or the new system directly. Every request enters the
facade, which consults a **migration table** keyed by some stable
attribute of the request (URL path, resource type, tenant ID, or a
feature flag) and forwards it to whichever system currently owns that
capability. The facade must be introduced *before* any migration
begins, even while it forwards 100% of traffic to the legacy system,
because the facade's stable public contract is what lets the systems
behind it change without clients noticing. Its routing logic should be
data-driven, not code: a cutover should be a table edit or a flag
flip, ideally at runtime, so migrating a capability doesn't require
redeploying the facade itself.

**Per-capability cutover, not per-request.** The unit of migration is a
*capability* — a coherent slice of behavior like "order creation" or
"user profiles" — not an individual request. When a capability is
rebuilt in the new system, its routing rule flips atomically so that
all traffic for that capability moves together; leaving half of one
capability's requests on each side invites subtle inconsistencies. Each
cutover is deliberately small so that if it misbehaves, the blast
radius is one capability and the fix is flipping its rule back. This
per-capability reversibility is the pattern's core safety property.

**Data synchronization during the overlap.** The hardest part is rarely
the routing — it's the data. While a capability is mid-migration, or
while a migrated capability still shares data with capabilities that
haven't moved, the old and new systems both need a consistent view of
that data. Teams handle this with one of a few approaches:
[change data capture](/docs/patterns/batch-streaming/change-data-capture)
streaming writes from the legacy database into the new one, dual writes
(the facade or the new service writes to both, accepting the added
failure modes), or keeping a single shared datastore that both systems
read while only their owned capabilities write. Whichever approach,
there's an unavoidable window where two systems have opinions about the
same data, and reconciling divergence — not routing — is where most
strangler-fig migrations get stuck.

**Rollback and verification.** Because each cutover is one rule change,
rollback is a rule change too: point the capability back at the legacy
system. Many teams add a *verification* step before flipping fully —
running the new implementation in shadow (mirroring live traffic to the
new system, comparing results, but still serving the legacy response)
or a [canary](/docs/patterns/observability/canary-deployment) that
sends a small percentage to the new system first. This catches
behavioral divergence against real traffic before the capability is
fully strangled.

**Failure modes.** The facade itself becomes a single point of failure
for *all* traffic, so it needs the same redundancy and health-checking
as any critical edge component. The subtler failure is a migration that
**stalls**: the last few capabilities are the ugliest, most-coupled
parts of the legacy system, the pressure to finish fades once the
painful bits are moved, and the organization ends up running two
systems plus a facade indefinitely — paying the cost of the pattern
without ever collecting its payoff, which is retiring the legacy
system.

**Strangler Fig vs. Blue-Green vs. Anti-Corruption Layer.** These are
easy to conflate but solve different-shaped problems.
[Blue-Green Deployment](/docs/patterns/observability/blue-green-deployment)
switches an *entire* system from one version to another in a single
flip (with the old version kept ready for instant rollback) — it's a
whole-system, short-lived cutover, whereas strangler fig is a
capability-by-capability migration that runs for months. The
[Anti-Corruption Layer](/docs/patterns/integration/anti-corruption-layer)
is not an alternative but a frequent *companion*: during a strangler
migration the new system often still has to call the legacy one, and an
ACL sits on that boundary translating legacy models into the new
system's clean domain model so the legacy's quirks don't leak into the
code being built to replace it.

## Routing and the migration lifecycle

A strangler migration moves through the same lifecycle for each
capability, and the routing table is the ledger that tracks where every
capability sits.

![Strangler Fig migration stages](/img/patterns/strangler-fig-stages.svg)

| Stage | Facade routing | What's happening |
| --- | --- | --- |
| Facade introduced | 100% legacy | Proxy in front of legacy; no behavior change, stable contract established |
| Build | 100% legacy | New implementation of a capability being written; data sync being wired |
| Shadow / canary | Legacy serves; new observed | New system receives mirrored or small-percentage traffic; results compared |
| Cutover | Capability → new | Routing rule flips; new system now owns this capability's traffic |
| Rollback (if needed) | Capability → legacy | Rule flipped back on divergence; blast radius is one capability |
| Strangled | 100% new for all | Legacy has no remaining traffic and can be decommissioned |
| Facade removal | direct to new | Once every capability is on the new system, the facade can be retired |

The migration is only truly "done" at the last two rows — a common
trap is treating cutover of the easy capabilities as success while the
legacy system lingers on for the hard ones.

## Code example

The snippet below is the core of a strangler facade: a mutable
per-capability routing table plus the two backends. It uses
longest-prefix matching so a request path resolves to the capability
that owns it, defaults unmatched routes to the legacy system (the safe
direction), and exposes `cutover` as the single state change a
migration step — or a rollback — makes.

```rust
use std::collections::HashMap;

/// Which system currently owns a capability.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Target {
    Legacy,
    New,
}

/// The strangler facade: a mutable routing table plus the two backends.
/// Every request consults the table; capabilities flip from Legacy to
/// New one at a time as each is migrated, with no change to the facade.
struct Facade {
    // capability prefix -> which system owns it right now
    routes: HashMap<&'static str, Target>,
}

impl Facade {
    fn new() -> Self {
        let mut routes = HashMap::new();
        // Early in the migration everything still points at the legacy system.
        routes.insert("/orders", Target::Legacy);
        routes.insert("/users", Target::Legacy);
        routes.insert("/billing", Target::Legacy);
        Facade { routes }
    }

    // Longest-prefix match, so "/orders/42" resolves to the "/orders"
    // capability. Anything unmatched stays on the legacy system by
    // default — the safe direction while migrating.
    fn target_for(&self, path: &str) -> Target {
        self.routes
            .iter()
            .filter(|(prefix, _)| path.starts_with(**prefix))
            .max_by_key(|(prefix, _)| prefix.len())
            .map(|(_, target)| *target)
            .unwrap_or(Target::Legacy)
    }

    // Cutover of a single capability: the only state change a migration
    // step makes. Reversible by flipping back to Legacy for a rollback.
    fn cutover(&mut self, capability: &'static str, to: Target) {
        self.routes.insert(capability, to);
    }

    fn dispatch(&self, path: &str) -> String {
        match self.target_for(path) {
            Target::Legacy => format!("legacy served {path}"),
            Target::New => format!("new served {path}"),
        }
    }
}
```

Before cutover, `dispatch("/orders/42")` returns `"legacy served
/orders/42"`; after `cutover("/orders", Target::New)`, the same request
returns `"new served /orders/42"`, while `"/users/7"` still goes to
legacy and an unknown path defaults to legacy. Flipping `/orders` back
to `Target::Legacy` is a full rollback of that one capability — the
structure of the facade never changes.

## When to use it

- Migrating off a legacy monolith or an aging system where a full
  rewrite-and-cutover is too risky or would take too long to be
  practical.
- The legacy system must stay operational and serving production
  traffic throughout the migration — there's no maintenance window
  long enough for a full replacement.
- You want to validate each migrated piece against real traffic before
  moving on to the next one, catching problems early and small.

## When not to use it

- The system is small enough that a full rewrite is genuinely faster
  and lower-risk than building and maintaining a routing facade.
- The legacy system's internals are so tightly coupled that no
  meaningful functionality can be peeled off independently — anything
  less than an all-at-once rewrite won't actually work.
- There's no appetite to operate two systems (and a routing layer) in
  parallel for an extended period, which the pattern inherently
  requires.

## Use-case scenarios

**E-commerce monolith to microservices.** A retailer's monolithic
platform handles catalog, cart, checkout, and fulfillment in one
codebase. An API gateway is introduced as the facade routing all
traffic to the monolith unchanged, then capabilities are peeled off one
at a time — catalog first (mostly read, low risk), then cart, then the
high-stakes checkout flow last. Each new service is shadow-tested
against live traffic before its route flips, change data capture keeps
product and inventory data in sync during the overlap, and a bad
cutover is rolled back by pointing that one route back at the monolith.

**Core banking account system.** A bank moves account and transaction
handling off a decades-old core onto new services, where a big-bang
cutover is unthinkable because a wrong balance is a regulatory
incident. The facade routes by account segment: a small cohort of
low-risk accounts is migrated first, verified against the legacy system
running in parallel (both compute the balance, results are reconciled),
and only once reconciliation is clean for weeks is the next cohort
moved. The legacy core stays authoritative for every account not yet
migrated for the entire multi-year program.

**Internal HR platform replacement.** An enterprise replaces an aging
in-house HR tool feature by feature — leave requests, then expense
approvals, then org-chart management — behind a reverse proxy. Because
each feature is fairly independent, cutovers are quick, and the team
uses feature flags so the routing decision can be flipped per user
group (piloting expenses with one department before rolling it out
company-wide) without redeploying the proxy.

## Related patterns

- [Anti-Corruption Layer](/docs/patterns/integration/anti-corruption-layer) —
  commonly paired with Strangler Fig: while the facade routes requests,
  an ACL keeps the new system's domain model clean whenever it still
  needs to call into the legacy system during the migration.
- [Blue-Green Deployment](/docs/patterns/observability/blue-green-deployment) —
  a whole-system, single-flip cutover with instant rollback; contrast
  with strangler fig's long-running, capability-by-capability
  migration.
- [Canary Deployment](/docs/patterns/observability/canary-deployment) —
  the incremental-traffic technique often used to verify a single
  capability's new implementation before its route is fully cut over.
- [Change Data Capture](/docs/patterns/batch-streaming/change-data-capture) —
  a common way to keep the legacy and new datastores in sync during the
  overlap window while capabilities straddle both systems.
- [Feature Flags](/docs/patterns/observability/feature-flags) — a common
  mechanism for implementing the routing decision itself, letting the
  migration be controlled at runtime without redeploying the facade.

## Further reading

- [StranglerFigApplication — martinfowler.com](https://martinfowler.com/bliki/StranglerFigApplication.html) (Martin Fowler's original naming of the pattern)
- [Strangler Fig pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/strangler-fig)
- [Strangler fig pattern — Wikipedia](https://en.wikipedia.org/wiki/Strangler_fig_pattern)
