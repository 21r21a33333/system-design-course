---
title: "Distributed Monitoring"
sidebar_position: 3
supplementary: true
---

Distributed monitoring is the practice of aggregating metrics, logs, and
error reports from many service instances into a single place, so
operators can see the health of a whole fleet instead of having to
inspect individual machines one at a time.

## Problem it solves

A monolith running on one box can be monitored by watching that box.
Once a system is decomposed into many service instances running across
many machines — scaling up and down, restarting, getting rescheduled by
an orchestrator — there is no single machine whose logs or metrics tell
the whole story. An error might occur on any one of hundreds of
ephemeral instances, and by the time someone investigates, that
instance may no longer exist. Distributed monitoring solves this by
shipping telemetry off each instance to a central system as it's
generated, so the fleet's health can be observed and alerted on
independently of any individual instance's lifetime.

## How it works

Each service instance emits three broad categories of telemetry:
metrics (numeric time series like request rate, latency, error rate),
logs (discrete event records), and error reports (captured exceptions
with stack traces and context). An agent or SDK on each instance
batches and ships this data to a central collector, which aggregates it
across instances, stores it, and exposes it for dashboards, search, and
alerting.

Server-side and client-side monitoring are related but genuinely
distinct concerns. Server-side error tracking captures exceptions from
backend processes you control end-to-end — the stack traces map
directly to the deployed code, and volume is roughly proportional to
request volume. Client-side (browser and mobile) error tracking has
different problems: production JavaScript and mobile binaries are
typically minified or optimized, so a raw stack trace is useless
without a source map or symbol file to translate it back to the
original source — the monitoring pipeline needs a symbolication step,
usually by uploading source maps or debug symbols at build time.
Client-side traffic also tends to be far higher volume on popular
pages, so many client error trackers apply sampling (reporting only a
percentage of events, or deduplicating identical errors) to keep
ingestion and storage costs bounded, which server-side tracking
usually doesn't need at the same scale.

## When to use it

- The system runs on more than a handful of instances, or instances are
  ephemeral (autoscaled, rescheduled by an orchestrator).
- You need to alert on aggregate health (error rate, latency
  percentiles across the fleet) rather than watching individual boxes.
- Both backend exceptions and frontend/mobile errors need to be
  captured, deduplicated, and triaged.

## When not to use it

- A single long-lived instance with local logging is genuinely
  sufficient — early-stage or low-traffic systems can defer this.
- The overhead of shipping and storing telemetry (network, storage
  cost, agent CPU) isn't justified yet relative to the system's scale.

## Real-world example

Sentry is widely used for both server-side and client-side (browser and
mobile) error tracking, including source-map-based symbolication of
minified JavaScript stack traces. Datadog aggregates metrics, logs, and
traces from large fleets into unified dashboards and alerting.

## Related patterns

- [Distributed Tracing](/docs/patterns/observability/distributed-tracing) — tracing follows a single request across services; monitoring aggregates health across the whole fleet.
- [Distributed Logging](/docs/patterns/building-blocks/distributed-logging) — log aggregation is one of the data sources distributed monitoring consumes.

## Further reading

- [Application performance management — Wikipedia](https://en.wikipedia.org/wiki/Application_performance_management)
- [Source map — Wikipedia](https://en.wikipedia.org/wiki/Minification_(programming)#Source_mapping)
