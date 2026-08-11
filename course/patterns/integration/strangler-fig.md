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

## How it works

A routing facade sits in front of both the legacy system and the new
system, and every incoming request passes through it first. For each
request, the facade decides — based on the route, resource, or some
other identifying attribute — whether the legacy system or the new
system should handle it. Early on, almost everything routes to the
legacy system, since almost nothing has been migrated yet. As each
piece of functionality is rebuilt in the new system, the facade's
routing rule for that piece flips to point at the new system instead.
Over time, the share of traffic reaching the legacy system shrinks
until it's serving nothing, at which point it can be decommissioned
and the facade itself can eventually be removed once every route
points at the new system.

## Code example

The snippet below shows the core routing decision a strangler facade
makes: for a given request, decide which handler — legacy or new —
should serve it.

```rust
struct Request {
    path: String,
}

enum Handler {
    Legacy,
    New,
}

// Routes that have already been migrated to the new system.
const MIGRATED_PREFIXES: &[&str] = &["/api/v2/orders", "/api/v2/users"];

fn route(request: &Request) -> Handler {
    let migrated = MIGRATED_PREFIXES
        .iter()
        .any(|prefix| request.path.starts_with(prefix));

    if migrated {
        Handler::New
    } else {
        Handler::Legacy
    }
}

fn dispatch(request: Request) -> String {
    match route(&request) {
        Handler::Legacy => legacy_handler(&request),
        Handler::New => new_handler(&request),
    }
}

fn legacy_handler(request: &Request) -> String {
    format!("legacy system handled {}", request.path)
}

fn new_handler(request: &Request) -> String {
    format!("new system handled {}", request.path)
}
```

As functionality is rebuilt, entries move into `MIGRATED_PREFIXES` (or,
in production, a feature-flag service) and traffic shifts to
`new_handler` without any change to the routing facade's structure.

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

## Real-world example

Large e-commerce and banking platforms have used the strangler fig
approach to migrate monolithic checkout or account systems to
microservices over multi-year periods, using an API gateway or reverse
proxy as the routing facade and migrating one endpoint or business
capability at a time rather than attempting a single cutover.

## Related patterns

- [Anti-Corruption Layer](/docs/patterns/integration/anti-corruption-layer) — commonly paired
  with Strangler Fig: while the facade routes requests, an ACL keeps
  the new system's domain model clean whenever it still needs to call
  into the legacy system.
- [Feature Flags](/docs/patterns/observability/feature-flags) — a
  common mechanism for implementing the routing decision itself,
  letting the migration be controlled at runtime without redeploying
  the facade.

## Further reading

- [Strangler fig pattern — Wikipedia](https://en.wikipedia.org/wiki/Strangler_fig_pattern)
- [Strangler Fig pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/strangler-fig)
