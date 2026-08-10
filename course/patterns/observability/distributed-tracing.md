---
title: "Distributed Tracing"
sidebar_position: 2
supplementary: true
---

Distributed tracing propagates a unique trace ID across every service a
single request touches, letting engineers reconstruct the full request
path and the latency contributed by each hop after the fact.

## Problem it solves

In a monolith, a slow request can usually be diagnosed with a single
in-process stack trace or profiler run. Once a request fans out across
many independently deployed services, that visibility disappears: each
service only sees its own logs, and nothing ties "this database query
was slow" back to "this specific user-facing request timed out." As the
number of services a request passes through grows, the odds that any
single one of them is the bottleneck — and the difficulty of finding
which one — both increase. A request that visits a dozen services has a
dozen places latency can be hiding.

## How it works

When a request enters the system, the first service generates a trace
ID (and a span ID for its own unit of work) and attaches them to the
request, typically as HTTP headers. Every downstream service that
receives the request reads that trace ID, creates its own child span
recording start time, end time, and metadata, and forwards the trace ID
onward to anything it calls. Each span reports itself to a central
collector. Because every span from a request shares the same trace ID,
the collector can assemble them into a single tree showing the request's
full path and how long each hop took, even though no individual service
had visibility beyond its own span.

## When to use it

- The system is composed of enough independently deployed services that
  "which service is slow" is not obvious from any single service's logs.
- Diagnosing tail latency (p99 spikes) requires seeing the whole request
  path, not just aggregate per-service metrics.
- Teams need to attribute latency or errors to specific downstream
  dependencies for capacity planning or SLA accountability.

## When not to use it

- A single-service or tightly-coupled two-tier system gets little value
  from trace propagation — ordinary logging and metrics are simpler and
  sufficient.
- Tracing every request at 100% sampling can add meaningful overhead and
  storage cost at high volume; most production systems sample a fraction
  of requests instead, which trades completeness for cost.
- If services aren't willing to consistently propagate the trace context
  through every call (including async/queue-based hops), the trace will
  have gaps that undermine its value.

## Real-world example

OpenTelemetry defines a vendor-neutral standard for generating and
propagating trace context, and tools like Jaeger and Zipkin collect,
store, and visualize the resulting traces as timeline "waterfall" views
showing exactly where time was spent across services.

## Related patterns

- [Health Check](/docs/patterns/observability/health-check) — a complementary signal; tracing shows where time went, health checks show whether an instance was even fit to serve.
- [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) — trace data is often what reveals a dependency needs a circuit breaker in the first place.
- [API Gateway](/docs/patterns/api-edge/api-gateway) — a natural place to originate a trace ID for requests entering the system.

## Further reading

- [Tracing (software) — Wikipedia](https://en.wikipedia.org/wiki/Tracing_(software))
- [AWS X-Ray — how it works](https://docs.aws.amazon.com/xray/latest/devguide/xray-concepts.html)
