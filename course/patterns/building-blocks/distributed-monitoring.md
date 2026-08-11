---
title: "Distributed Monitoring"
sidebar_position: 3
supplementary: true
---

Distributed monitoring is the practice of collecting numeric telemetry —
metrics, and alongside them logs and traces — from many service instances into
a central system, storing it as time series, and evaluating rules against it so
operators can observe and alert on the health of a whole fleet instead of
inspecting individual machines one at a time.

![Distributed Monitoring diagram](/img/patterns/distributed-monitoring.svg)

## Problem it solves

A monolith on one box can be monitored by watching that box. Once a system is
decomposed into many instances across many machines — scaling up and down,
restarting, rescheduled by an orchestrator — no single machine's metrics tell
the whole story. An error might occur on any of hundreds of ephemeral
instances, and by the time someone looks, that instance may be gone. You also
can't wait for a user to report an outage; you need to be *alerted* the moment
aggregate error rate or latency crosses a threshold. Distributed monitoring
solves this by shipping telemetry off each instance to a central system as it's
generated, storing it efficiently as time series, and continuously evaluating
alerting rules against the aggregate — decoupled from any individual instance's
lifetime.

## Technical architecture & implementation

**Metric types.** Instrumentation produces a few fundamental shapes. A
**counter** only ever increases (requests served, errors) — you read its
*rate* over time, not its raw value. A **gauge** goes up and down (in-flight
requests, memory used, queue depth) — a point-in-time snapshot. A **histogram**
buckets observations (request latencies) into cumulative counters, which is how
percentiles are computed cheaply without storing every sample — the code
example implements exactly this. Summaries are a client-side percentile variant
with different aggregation tradeoffs.

**Pull vs. push scrape model.** In the **pull** model (Prometheus), each
instance exposes a `/metrics` endpoint and the monitoring server *scrapes* it
on an interval, discovering targets via service discovery. Pull makes "is this
target up?" a first-class signal (a failed scrape is itself data) and keeps
instances stateless. In the **push** model (StatsD, many hosted agents),
instances *send* metrics to a collector — better for short-lived jobs that may
die before a scrape, and for pushing through network boundaries, but it needs a
gateway to buffer and can't tell "silent" apart from "gone" as cleanly.

**Time-series storage and identity.** A metric is stored as a **time series**
uniquely identified by its **name plus its full label set** — `http_requests_total{method="GET",code="200"}`
is a *different* series from the same metric with `code="500"`. The store is
optimized for append-heavy writes of `(timestamp, value)` points per series and
range reads over time. The code example builds this canonical series key.

**Aggregation and downsampling.** Raw high-resolution points are expensive to
keep forever, and old data is rarely queried at second granularity.
**Downsampling** rolls raw points into coarser aggregates (5-minute, then
1-hour min/max/avg/sum) as they age, and drops the raw points — trading
fidelity for cost, the metrics-world analogue of hot/warm/cold log tiers.
Queries aggregate *across* series too: summing a counter's rate over all
instances gives fleet-wide throughput.

**Alerting rules.** A rule is a query plus a threshold plus a duration:
*"if the 5-minute error-rate exceeds 2% for 10 minutes, fire."* The
**for-duration** guard is what stops a momentary blip from paging someone —
the condition must hold continuously before the alert fires, the monitoring
analogue of the failover failure-threshold. Fired alerts route to
notification and dashboards.

**RED and USE methods.** Two disciplines decide *what* to measure. **RED**
(Rate, Errors, Duration) instruments request-driven services from the caller's
view — how many requests, how many failed, how long they took. **USE**
(Utilization, Saturation, Errors) instruments resources (CPU, disk, queues) —
how busy, how backed-up, how many failures. RED tells you the service is
hurting; USE often tells you *why*.

**The three pillars.** Metrics are one of three observability signals.
**Metrics** are cheap aggregate numbers ("error rate is up") but can't explain
a specific failure. **Logs**
([Distributed Logging](/docs/patterns/building-blocks/distributed-logging))
carry per-event detail ("this request threw this exception"). **Traces**
([Distributed Tracing](/docs/patterns/observability/distributed-tracing)) show
one request's path and timing across services. Mature monitoring correlates all
three: a metric alert points at a service, its logs explain the errors, a trace
shows where the latency accrued.

**Cardinality explosion — the defining failure mode.** Because every distinct
label-value combination is a *new* stored series, putting a high-cardinality
value in a label — `user_id`, `request_id`, a raw URL — multiplies series
without bound. Memory and index cost scale with the *product* of every label's
cardinality, so one careless label can take a monitoring system down harder
than the workload it watches. The discipline is to keep labels low-cardinality
and bounded, and push high-cardinality identifiers into logs or traces, where
they belong.

**Client-side vs. server-side error tracking.** Backend error tracking captures
exceptions from code you control, with stack traces that map to deployed
source. Browser and mobile error tracking is harder: production JavaScript and
mobile binaries are minified/optimized, so a raw stack trace is useless without
**symbolication** — translating it back via a source map or debug symbols
uploaded at build time. Client traffic is also far higher volume, so client
trackers lean heavily on sampling and error-deduplication to bound cost.

## Code example

The load-bearing mechanics are a **cumulative histogram** (how percentiles are
computed at ingestion without storing raw samples) and the **series key** that
makes cardinality explosion concrete: every distinct label set is a new series.

```rust
use std::collections::HashMap;

// A histogram bins observations into fixed cumulative buckets. This is how
// monitoring systems compute latency percentiles cheaply: each bucket is a
// monotonic counter, so a percentile is estimated by interpolation over
// aggregated counts instead of storing every raw sample.
pub struct Histogram {
    bounds: Vec<f64>,  // upper bounds, ascending
    counts: Vec<u64>,  // cumulative: counts[i] = observations <= bounds[i]
    sum: f64,
    total: u64,
}

impl Histogram {
    pub fn new(bounds: Vec<f64>) -> Self {
        let n = bounds.len();
        Histogram { bounds, counts: vec![0; n], sum: 0.0, total: 0 }
    }

    // Cumulative semantics: every bucket whose bound is >= the value counts it.
    pub fn observe(&mut self, value: f64) {
        self.sum += value;
        self.total += 1;
        for (i, &b) in self.bounds.iter().enumerate() {
            if value <= b {
                self.counts[i] += 1;
            }
        }
    }

    // Estimate the value at a percentile (0.0..=1.0): find the first
    // cumulative bucket reaching the target rank and interpolate within it —
    // the standard histogram_quantile approach.
    pub fn quantile(&self, q: f64) -> f64 {
        if self.total == 0 {
            return 0.0;
        }
        let rank = q * self.total as f64;
        let mut prev_count = 0u64;
        let mut prev_bound = 0.0;
        for (i, &cum) in self.counts.iter().enumerate() {
            if cum as f64 >= rank {
                let in_bucket = (cum - prev_count) as f64;
                if in_bucket == 0.0 {
                    return self.bounds[i];
                }
                let position = (rank - prev_count as f64) / in_bucket;
                return prev_bound + (self.bounds[i] - prev_bound) * position;
            }
            prev_count = cum;
            prev_bound = self.bounds[i];
        }
        *self.bounds.last().unwrap_or(&0.0)
    }
}

// A time series is identified by metric name PLUS its label set. Every
// distinct label combination is a NEW series — the mechanism behind
// cardinality explosion: a high-cardinality label (user_id, request_id)
// multiplies stored series without bound.
pub fn series_key(metric: &str, labels: &HashMap<String, String>) -> String {
    let mut pairs: Vec<(&String, &String)> = labels.iter().collect();
    pairs.sort(); // deterministic key regardless of insertion order
    let mut key = String::from(metric);
    key.push('{');
    for (i, (k, v)) in pairs.iter().enumerate() {
        if i > 0 {
            key.push(',');
        }
        key.push_str(k);
        key.push('=');
        key.push_str(v);
    }
    key.push('}');
    key
}
```

Verified at runtime on ten samples over buckets `[10, 50, 100, 500, 1000]`:
`p50 ≈ 50.0`, `p90 ≈ 500.0`, `p99 ≈ 950.0`, and `series_key` yields the sorted,
deterministic `http_requests_total{code=200,method=GET}` regardless of label
insertion order.

## When to use it

- The system runs on more than a handful of instances, or instances are
  ephemeral (autoscaled, rescheduled by an orchestrator).
- You need to alert on aggregate health (error rate, latency percentiles across
  the fleet) rather than watching individual boxes.
- You need cheap, always-on numeric signals to drive dashboards, autoscaling,
  and SLO tracking.

## When not to use it

- A single long-lived instance with local logging is genuinely sufficient —
  early-stage or low-traffic systems can defer this.
- The overhead of shipping and storing telemetry isn't justified yet relative
  to scale.
- What you need is per-event detail to debug one specific failure — that's a
  job for [logs](/docs/patterns/building-blocks/distributed-logging) or
  [traces](/docs/patterns/observability/distributed-tracing), not aggregate
  metrics.

## Use-case scenarios

**SLO-driven alerting for an API platform.** A payments API defines an SLO of
99.9% success and p99 latency under 300 ms. Every instance exposes RED metrics;
the monitoring server scrapes them, and alert rules fire only when the
error-budget burn rate stays elevated for a sustained window — paging on
sustained degradation, not transient blips. Dashboards show fleet-wide rate,
errors, and latency percentiles computed from histograms, so on-call sees
health at a glance.

**Capacity and autoscaling signals.** An orchestrator scales a stateless
service on CPU utilization and request-queue depth (USE-style resource
metrics). The monitoring system feeds these gauges to the autoscaler in near
real time; downsampled history drives capacity planning weeks out. Because the
same metrics power both the fast control loop and the slow planning view,
tiered downsampling keeps years of trend data affordable.

**Frontend error tracking with symbolication.** A consumer web app ships
minified JavaScript. When an error fires in a browser, the client SDK reports it
with a raw stack trace and a build id; the monitoring backend symbolicates it
against source maps uploaded at deploy time, turning gibberish frames back into
real file/line locations. High client traffic makes sampling and
error-deduplication essential so one popular page's error doesn't drown the
ingestion pipeline.

## Related patterns

- [Distributed Logging](/docs/patterns/building-blocks/distributed-logging) — the per-event detail pillar; a metric alert points at a service, logs explain its errors.
- [Distributed Tracing](/docs/patterns/observability/distributed-tracing) — the third pillar: one request's path and timing across services, for locating *where* latency accrues.
- [Health Check](/docs/patterns/observability/health-check) — the per-instance liveness/readiness probe monitoring aggregates into fleet health and up/down signals.
- [Auto-Scaling](/docs/patterns/scaling/auto-scaling) — consumes monitoring metrics (utilization, queue depth) as the control signal for scaling decisions.

## Further reading

- [Application performance management — Wikipedia](https://en.wikipedia.org/wiki/Application_performance_management)
- [Prometheus: metric types](https://prometheus.io/docs/concepts/metric_types/)
- [Google SRE Book: monitoring distributed systems](https://sre.google/sre-book/monitoring-distributed-systems/)
- [The RED method (Grafana / Weaveworks)](https://grafana.com/blog/2018/08/02/the-red-method-how-to-instrument-your-services/)
- [Brendan Gregg: the USE method](https://www.brendangregg.com/usemethod.html)
- [OpenTelemetry metrics specification](https://opentelemetry.io/docs/specs/otel/metrics/)
