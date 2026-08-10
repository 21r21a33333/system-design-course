---
title: "Backend for Frontend"
sidebar_position: 2
supplementary: true
---

Backend for Frontend (BFF) is a dedicated backend layer built for one
specific client type — web, mobile, or a third-party integration —
that shapes and aggregates calls to backend services around that
client's needs, instead of one generic API trying to serve every client
equally well.

## Problem it solves

A single general-purpose API tends to satisfy no client particularly
well. A mobile client on a slow connection wants a small, pre-aggregated
payload with only the fields it renders; a desktop web client can afford
richer, more granular responses and may want several resources combined
differently. A one-size-fits-all API either over-fetches (sends fields
the mobile client will discard, wasting bandwidth and battery) or
under-fetches (forces the client to make several round trips to gather
what one screen needs). Worse, as more client types are added, the
shared API accumulates client-specific conditional logic and becomes a
coordination bottleneck between frontend teams who all depend on the
same backend release cycle.

## How it works

Each client type gets its own backend service, owned ideally by the
team that owns that client. The BFF calls downstream services
(directly, or through a shared [API Gateway](/docs/patterns/api-edge/api-gateway))
and aggregates, filters, and reshapes their responses into exactly what
that client needs in as few round trips as possible. Because each BFF
is scoped to one client, it can evolve independently — a mobile team can
change their BFF's response shape without touching the web BFF or
waiting on a shared backend team.

## When to use it

- Different client types have meaningfully different data, bandwidth,
  or latency needs (e.g. mobile vs. desktop vs. smart-TV).
- Frontend teams want to iterate on their client's API without
  coordinating releases with other client teams.
- A shared generic API has accumulated client-specific branching logic
  that's becoming hard to maintain.

## When not to use it

- All clients need essentially the same data shape — a shared API is
  simpler and avoids duplicating aggregation logic across BFFs.
- The team is small enough that maintaining several BFFs (one per
  client type) is pure overhead rather than a coordination win.
- Adding a BFF just to avoid touching a shared backend, without an
  actual per-client shaping need, mostly adds an extra hop and a new
  service to operate.

## Real-world example

Netflix popularized the BFF pattern to serve its many device types
(TVs, game consoles, mobile, web) — each with very different UI
capabilities and network conditions — through device-tailored API
layers rather than one API trying to fit every device.

## Related patterns

- [API Gateway](/docs/patterns/api-edge/api-gateway) — BFFs are often
  deployed behind a shared gateway that still handles cross-cutting
  concerns like auth and TLS termination for all of them.

## Further reading

- [Backends for Frontends pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/backends-for-frontends)
