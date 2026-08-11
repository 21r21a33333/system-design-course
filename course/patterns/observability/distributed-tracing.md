---
title: "Distributed Tracing"
sidebar_position: 2
supplementary: true
---

Distributed tracing propagates a unique trace ID across every service a
single request touches, letting engineers reconstruct the full request
path — as a tree of timed spans — and see the latency contributed by each
hop after the fact.

![Distributed Tracing diagram](/img/patterns/distributed-tracing.svg)

## Problem it solves

In a monolith, a slow request can usually be diagnosed with a single
in-process stack trace or profiler run. Once a request fans out across
many independently deployed services, that visibility disappears: each
service only sees its own work, and nothing ties "this database query
was slow" back to "this specific user-facing request timed out." A
request that visits a dozen services has a dozen places latency can hide,
and aggregate per-service metrics can't tell you which hop hurt *this*
request. Distributed tracing restores that end-to-end view by threading
a shared identifier through the whole call graph, so the individual
timings can be stitched back into one coherent picture of a single
request's journey.

## Technical architecture & implementation

**Trace, span, and the tree.** A **trace** represents one request's
entire journey; it's composed of **spans**, each of which is one unit of
work in one service (an HTTP handler, a database query, a cache lookup).
Every span carries a `trace-id` (shared by all spans in the trace), its
own `span-id`, a `parent-span-id` linking it to the span that caused it,
a start timestamp and duration, and a bag of **attributes** (HTTP method,
status code, DB statement). Because each span names its parent, the
collector can rebuild the whole trace as a **tree** even though no single
service ever saw more than its own span. The root span is the entry
point; leaves are the deepest downstream calls.

**Context propagation — inject and extract.** The mechanism that makes
tracing work across a process boundary is **context propagation**. When
a service calls another, it **injects** the current trace context into
the outgoing request — the industry standard is the W3C Trace Context
`traceparent` header, formatted as `version-traceid-spanid-flags`. The
receiving service **extracts** that header and parents its new spans
under the incoming `span-id`. The hardest gaps to close are asynchronous
hops: a message pushed onto a queue or a background job must carry the
trace context as metadata, or the trace breaks at that boundary and the
downstream work orphans into a separate, useless fragment.

**Instrumentation — manual and automatic.** Spans have to be created
somewhere. **Automatic instrumentation** (via an agent or SDK hooks)
wraps common libraries — HTTP clients/servers, database drivers, message
consumers — so the majority of spans appear with no code changes.
**Manual instrumentation** adds spans and attributes around
business-specific logic the auto-instrumentation can't see.
[OpenTelemetry](https://opentelemetry.io/) is the vendor-neutral standard
for both, defining the APIs, the propagation format, and the wire
protocol that feed backends like Jaeger and Zipkin.

**Collectors and backends.** Instrumented services export finished spans
(usually asynchronously, batched) to a **collector**, which buffers,
processes, and forwards them to a storage backend. The backend indexes
spans by `trace-id` and reassembles traces on read, powering the
**waterfall / flame** visualizations engineers actually look at.

**Clock skew across hosts.** Spans are timed on different machines whose
clocks are never perfectly synchronized. Skew can make a child span
appear to start *before* its parent, or make a network hop look negative.
Backends mitigate this by anchoring durations to each span's own local
clock and normalizing offsets against the trace's root, but tracing is
best for *relative* latency attribution within a trace, not for
cross-host absolute-time forensics.

**Differentiation — the three pillars.** Tracing is one of three
observability signals and answers a question the others can't.
**Metrics** ([Distributed Monitoring](/docs/patterns/building-blocks/distributed-monitoring))
are cheap aggregate numbers — "p99 latency is up 200 ms" — but can't say
*which* request or *which* hop. **Logs**
([Distributed Logging](/docs/patterns/building-blocks/distributed-logging))
are discrete per-event records — "this request threw this exception" —
but don't inherently connect events across services or show relative
timing. **Traces** answer "for *this* request, where did the latency go
and which hop failed?" The mature workflow chains them: a metric alert
points at a service, a trace localizes the slow or failing hop, and the
logs for that span's `trace-id` explain why.

## Sampling: head-based vs tail-based

Tracing every request at full fidelity is often too expensive in export
bandwidth and storage, so systems **sample**. The two strategies trade
cost against coverage differently.

- **Head-based sampling** decides at the *start* of the trace (at the
  root) whether to keep it, typically at a fixed probability (e.g. 1%).
  The decision propagates in the `traceparent` sampled flag so every
  service agrees. It's cheap and simple, but it's blind: it decides
  *before* it knows whether the request will error or be slow, so most
  captured traces are boring successful ones and a rare failure is likely
  dropped.
- **Tail-based sampling** buffers *all* spans of a trace at the collector
  until it completes, then decides — keeping every trace that errored or
  exceeded a latency threshold and down-sampling the fast, successful
  majority. This captures the traces you actually want, at the cost of
  buffering complete traces in the collector (memory and complexity), and
  requires all spans of a trace to route to the same decision point.

The common production posture is head-based sampling for baseline
coverage plus tail-based rules to guarantee that slow and failed requests
are always retained.

## Traces vs metrics vs logs

| | Traces | Metrics | Logs |
|---|---|---|---|
| **Shape** | Tree of timed spans per request | Aggregated time series | Discrete event records |
| **Answers** | Where did latency go for *this* request? | Is the fleet healthy in aggregate? | What exactly happened in this event? |
| **Cardinality** | High (per request), so sampled | Low (must stay bounded) | High (often sampled by volume) |
| **Cost driver** | Span export + storage | Series count (labels) | Volume + retention |
| **Best for** | Localizing a slow/failed hop | Alerting, dashboards, SLOs | Root-cause detail, forensics |

The three are complementary, not competing — correlate them by carrying
the `trace-id` into log lines so a trace and its logs join up.

## Code example

A minimal trace model: spans form a tree via `parent_id`, context is
serialized to and from a `traceparent`-style string (`inject` / `extract`),
and the trace computes the end-to-end duration plus each span's
**self-time** — its own duration minus time spent in child spans. High
self-time is the signal that latency lived *in that span*, not in a
downstream call it was waiting on. This is a deterministic, single-threaded
model; real tracing exports spans asynchronously, but the tree math is the
same.

```rust
use std::collections::HashMap;

// A span is one unit of work within a trace: an operation in one service.
// Spans link into a tree via parent_id; the root span has no parent.
#[derive(Clone)]
pub struct Span {
    pub span_id: u64,
    pub parent_id: Option<u64>,
    pub name: String,
    pub start_us: u64,      // microseconds since trace start
    pub duration_us: u64,
    pub attributes: HashMap<String, String>,
}

// A trace collects every span sharing one trace_id, assembled after the
// fact from spans reported independently by each service.
pub struct Trace {
    pub trace_id: u128,
    spans: Vec<Span>,
    next_span_id: u64,
}

impl Trace {
    pub fn new(trace_id: u128) -> Self {
        Trace { trace_id, spans: Vec::new(), next_span_id: 1 }
    }

    // Open a span as a child of `parent` (None => root). Returns its id so
    // callers can nest children under it, mirroring how each service starts a
    // child span for the work it does on behalf of the incoming request.
    pub fn start_span(&mut self, name: &str, parent: Option<u64>, start_us: u64, duration_us: u64) -> u64 {
        let span_id = self.next_span_id;
        self.next_span_id += 1;
        self.spans.push(Span {
            span_id,
            parent_id: parent,
            name: name.to_string(),
            start_us,
            duration_us,
            attributes: HashMap::new(),
        });
        span_id
    }

    pub fn annotate(&mut self, span_id: u64, key: &str, value: &str) {
        if let Some(s) = self.spans.iter_mut().find(|s| s.span_id == span_id) {
            s.attributes.insert(key.to_string(), value.to_string());
        }
    }

    // W3C Trace Context injection: serialize the current span's identity into
    // a `traceparent` header so the next service can extract it and parent its
    // own spans correctly. Format: version-traceid-spanid-flags.
    pub fn inject(&self, span_id: u64) -> String {
        format!("00-{:032x}-{:016x}-01", self.trace_id, span_id)
    }

    // Extract (trace_id, parent_span_id) from a `traceparent` header on the
    // receiving side. Returns None if the header is malformed.
    pub fn extract(header: &str) -> Option<(u128, u64)> {
        let parts: Vec<&str> = header.split('-').collect();
        match parts.as_slice() {
            [_, trace, span, _] => {
                let trace_id = u128::from_str_radix(trace, 16).ok()?;
                let span_id = u64::from_str_radix(span, 16).ok()?;
                Some((trace_id, span_id))
            }
            _ => None,
        }
    }

    // Total wall-clock span of the trace: earliest start to latest end. This
    // is the end-to-end latency the user actually experienced.
    pub fn total_duration_us(&self) -> u64 {
        let start = self.spans.iter().map(|s| s.start_us).min().unwrap_or(0);
        let end = self.spans.iter().map(|s| s.start_us + s.duration_us).max().unwrap_or(0);
        end - start
    }

    // The single slowest span's own duration: the bottleneck hop an engineer
    // should inspect first. In a waterfall it's the widest bar.
    pub fn slowest_span(&self) -> Option<&Span> {
        self.spans.iter().max_by_key(|s| s.duration_us)
    }

    // Self-time (exclusive time) of a span: its duration minus time attributed
    // to its direct children. High self-time means the time was spent *here*,
    // not waiting on a downstream call — the key signal for locating latency.
    pub fn self_time_us(&self, span_id: u64) -> u64 {
        let span = match self.spans.iter().find(|s| s.span_id == span_id) {
            Some(s) => s,
            None => return 0,
        };
        let children: u64 = self
            .spans
            .iter()
            .filter(|s| s.parent_id == Some(span_id))
            .map(|s| s.duration_us)
            .sum();
        span.duration_us.saturating_sub(children)
    }
}
```

Walking a checkout trace — root `GET /checkout` (300 µs) with `auth-service`
(40 µs) and `cart-service` (220 µs) children, and a `db.query` (190 µs)
under cart — `total_duration_us` reports 300, `inject`/`extract` round-trip
the `cart` span through a `traceparent` string, and the self-times land at
40 for the root, 30 for cart, and 190 for the query: the query is where the
latency actually lives, exactly as the waterfall shows.

## Reading a trace waterfall

![Trace waterfall diagram](/img/patterns/distributed-tracing-waterfall.svg)

The waterfall lays each span on a timeline: horizontal position is its
start time, width is its duration, and indentation shows the parent-child
nesting. The eye goes straight to the widest bar on the deepest level —
in the example, the database query dominating cart-service — because that
high self-time is where the request actually spent its time. A span that
ran early and finished before the critical path (auth-service here)
contributes nothing to the end-to-end latency, so optimizing it would be
wasted effort. This is the payoff of tracing: it turns "the request was
slow somewhere" into "the request was slow *here*."

## When to use it

- The system is composed of enough independently deployed services that
  "which service is slow" isn't obvious from any one service's logs.
- Diagnosing tail latency (p99 spikes) requires seeing the whole request
  path, not just aggregate per-service metrics.
- Teams need to attribute latency or errors to specific downstream
  dependencies for capacity planning or SLA accountability.

## When not to use it

- A single-service or tightly-coupled two-tier system gets little value
  from trace propagation — ordinary logging and metrics are simpler and
  sufficient.
- Full 100% sampling at high request volume adds meaningful overhead and
  storage cost; if the team isn't ready to run a collector and a sampling
  strategy, tracing's operational cost may outweigh the benefit.
- If services won't consistently propagate context through every call
  (including async/queue hops), traces will have gaps that undermine
  their value — partial tracing can mislead more than help.

## Use-case scenarios

**Tail-latency hunt across a checkout flow.** A retailer's p99 checkout
latency spikes intermittently while p50 stays flat, so aggregate metrics
only confirm *that* it's slow, not *where*. Tail-based sampling retains
every checkout trace above 1 second; the waterfall shows the slow traces
all share one span — a payment-provider call that occasionally stalls on
connection setup. The fix (a warm connection pool) is targeted precisely
because the trace localized the hop.

**Error propagation in a fan-out request.** A single API request fans out
to eight downstream services; users see sporadic 500s. Traces filtered to
errored requests reveal that failures always originate in one inventory
service and cascade upward as the parent spans mark themselves failed.
The `trace-id` on each span links directly to that service's logs, which
show the underlying database timeout — metrics-then-trace-then-logs in one
correlated path.

**Async pipeline gap detection.** An order-processing pipeline hands work
off through a message queue, and traces mysteriously end at the enqueue
step. The gap itself is the finding: the producer wasn't injecting trace
context into the message, so consumers started orphan traces. Adding
context propagation to the queue metadata reconnects the pipeline into
one end-to-end trace spanning the synchronous and asynchronous halves.

## Related patterns

- [Distributed Monitoring](/docs/patterns/building-blocks/distributed-monitoring) — the metrics pillar; aggregate numbers tell you a service is slow, a trace tells you which hop.
- [Distributed Logging](/docs/patterns/building-blocks/distributed-logging) — the per-event pillar; carry the `trace-id` into log lines to join a trace to its logs.
- [Health Check](/docs/patterns/observability/health-check) — a complementary signal; tracing shows where time went, health checks show whether an instance was even fit to serve.
- [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) — trace data is often what reveals a dependency needs a breaker in the first place.
- [API Gateway](/docs/patterns/api-edge/api-gateway) — a natural place to originate a trace ID for requests entering the system.
- [Service Mesh](/docs/patterns/api-edge/service-mesh) — sidecars can auto-inject and propagate trace context uniformly across services.

## Further reading

- [W3C Trace Context specification](https://www.w3.org/TR/trace-context/) — the `traceparent` header standard.
- [OpenTelemetry: traces](https://opentelemetry.io/docs/concepts/signals/traces/) — the vendor-neutral tracing standard and data model.
- [OpenTelemetry: sampling](https://opentelemetry.io/docs/concepts/sampling/) — head-based vs tail-based sampling in depth.
- [Dapper, a Large-Scale Distributed Systems Tracing Infrastructure (Google)](https://research.google/pubs/pub36356/) — the foundational paper.
- [Jaeger: architecture](https://www.jaegertracing.io/docs/latest/architecture/) — a widely used open-source tracing backend.
- [Zipkin: architecture](https://zipkin.io/pages/architecture.html) — the original open-source distributed tracing system.
