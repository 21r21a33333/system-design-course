---
title: "Distributed Logging"
sidebar_position: 9
supplementary: true
---

Distributed logging collects, aggregates, indexes, and makes searchable the
logs emitted by many service instances, so operators can investigate an issue
across a whole fleet from one place instead of SSH-ing into individual boxes
to read local files. It is the pipeline that turns per-instance log lines into
a queryable, retained, fleet-wide record of what happened.

![Distributed Logging diagram](/img/patterns/distributed-logging.svg)

## Problem it solves

Reading logs by connecting to individual machines works with a handful of
long-lived servers. It breaks down completely once a system runs across many
instances that scale up and down or get rescheduled — the instance relevant to
an incident may not even exist anymore by the time someone looks, and even
when it does, manually checking hundreds of machines for the one that logged
an error is not a workable incident-response process. Worse, a single user
request often fans out across a dozen services; its story is scattered across a
dozen machines' local disks. Distributed logging solves this by shipping every
instance's logs off-box to a central, durable, searchable store as they are
generated, and by carrying enough structure (a shared request/trace id) that
one request's path can be reconstructed from the logs alone.

## Technical architecture & implementation

**The aggregation pipeline.** The canonical shape is
**agent → buffer/transport → index → store**. An **agent** on each host (or a
sidecar, or a logging library in-process) tails or receives log output and
forwards it. A **buffer/transport** stage — often a message queue or an
on-agent memory/disk buffer — decouples bursty producers from a downstream
that ingests at a steadier rate. An **indexer** parses records and builds an
index (frequently an inverted index over fields and free text, the same
structure behind [Distributed Search](/docs/patterns/building-blocks/distributed-search)).
The **store** holds records for a retention window and serves queries by time
range, service, host, severity, or free text.

**Structured logging is the prerequisite.** Emitting each line as a
well-defined object (commonly JSON) with consistent fields — timestamp,
service, severity, `trace_id`, and domain fields — is what makes the pipeline
useful at scale. Free-text logs can still be shipped and stored, but querying
them means fragile string matching; structured logs let the system index and
filter specific fields directly (*"every `ERROR` with this exact `trace_id`
across all services"*). This is the difference between grepping and querying.

**Correlation and trace IDs.** A shared id is injected at the edge and
propagated through every downstream call (in headers, then logged on every
line). At query time, filtering on that id stitches a single request's journey
across services back together — the log-side complement to
[Distributed Tracing](/docs/patterns/observability/distributed-tracing),
which reconstructs the same request as a span tree with timings. Logs tell you
*what happened*; traces tell you *where in the call graph and how long it
took*.

**Backpressure: durable vs. lossy buffering.** The buffer is bounded, and
when the transport can't keep up the agent must choose. A **durable**
(blocking) policy applies [backpressure](/docs/patterns/batch-streaming/backpressure)
to the application — never losing a line, but risking that logging stalls the
service under load. A **lossy** (drop) policy discards records (usually oldest
or lowest severity first) to protect the application's latency, at the cost of
gaps. The one non-negotiable rule: a dropped line must be *counted* and
surfaced as a metric, so lossiness is visible rather than silent. The code
example implements exactly this bounded buffer with both policies.

**Sampling and cardinality.** High-volume, low-value logs (debug lines, health
checks, per-request access logs on a hot path) can swamp the pipeline.
**Sampling** keeps a fraction (or only records above a severity threshold);
this trades completeness for cost. A related failure mode is **cardinality**:
indexing free-form fields with unbounded distinct values (raw URLs with ids,
user identifiers, stack-trace fingerprints) explodes the index and its memory
footprint. Bounding what gets indexed — and pushing high-cardinality detail
into the message body rather than an indexed field — keeps the store tractable.

**Hot / warm / cold retention.** Query demand is heavily skewed toward recent
data, so storage is tiered. **Hot** (fast SSD, fully indexed) holds the last
days for interactive incident queries. **Warm** (cheaper disk, maybe reduced
indexing) holds weeks. **Cold** (object storage like S3, slow to restore) holds
months for compliance and rare deep dives. Records age out from hot to cold on
a schedule, cutting cost by orders of magnitude while keeping recent data fast.

**Where it sits among siblings.** Distributed logging is one of the three
telemetry sources that
[Distributed Monitoring](/docs/patterns/building-blocks/distributed-monitoring)
consumes, alongside metrics and traces. Its indexing machinery is
[Distributed Search](/docs/patterns/building-blocks/distributed-search) applied
to log records. And its transport stage is frequently a
[distributed message queue](/docs/patterns/building-blocks/distributed-message-queue)
providing the buffering and replay described above.

## Code example

The load-bearing mechanism is the agent's **bounded buffer with an explicit
overflow policy** plus severity-threshold sampling on flush. The lesson: the
buffer is finite, so overflow is a design decision (block = durable, drop =
lossy), and lossy drops are counted rather than silent.

```rust
use std::collections::VecDeque;

// A structured log record: consistent fields make it queryable by field.
#[derive(Clone, Debug)]
pub struct LogRecord {
    pub ts_millis: u64,
    pub service: String,
    pub severity: Severity,
    pub trace_id: String, // correlation id threaded through every hop
    pub message: String,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Severity { Debug, Info, Warn, Error }

pub enum Overflow {
    Backpressure, // block the producer until space frees (never lose a line)
    DropOldest,   // drop the oldest buffered record (keep the app fast)
}

pub struct AgentBuffer {
    queue: VecDeque<LogRecord>,
    capacity: usize,
    policy: Overflow,
    dropped: u64, // surfaced as a metric so lossy drops are never silent
}

impl AgentBuffer {
    pub fn new(capacity: usize, policy: Overflow) -> Self {
        AgentBuffer { queue: VecDeque::new(), capacity, policy, dropped: 0 }
    }

    // Returns false only when a Backpressure buffer is full — the caller
    // is expected to retry, and that retry IS the backpressure signal.
    pub fn enqueue(&mut self, rec: LogRecord) -> bool {
        if self.queue.len() < self.capacity {
            self.queue.push_back(rec);
            return true;
        }
        match self.policy {
            Overflow::Backpressure => false,
            Overflow::DropOldest => {
                self.queue.pop_front();
                self.dropped += 1;
                self.queue.push_back(rec);
                true
            }
        }
    }

    // Flush a batch toward the transport/index. Records below the severity
    // threshold are sampled out here to control volume and cost.
    pub fn flush_batch(&mut self, max: usize, min_severity: Severity) -> Vec<LogRecord> {
        let mut batch = Vec::new();
        while batch.len() < max {
            match self.queue.pop_front() {
                Some(rec) if rank(rec.severity) >= rank(min_severity) => batch.push(rec),
                Some(_) => continue, // sampled out below the threshold
                None => break,
            }
        }
        batch
    }

    pub fn dropped_count(&self) -> u64 {
        self.dropped
    }
}

fn rank(s: Severity) -> u8 {
    match s {
        Severity::Debug => 0,
        Severity::Info => 1,
        Severity::Warn => 2,
        Severity::Error => 3,
    }
}
```

## When to use it

- The system runs on enough instances, or instances are ephemeral enough,
  that manually checking individual machines isn't practical.
- Investigating an incident requires correlating log lines across multiple
  services for the same request or time window.
- Logs must be retained and searchable for longer than any single instance's
  local disk or lifetime would allow.

## When not to use it

- A single long-lived instance with local log files is genuinely sufficient
  for the current scale.
- Log volume and the resulting storage/ingestion cost aren't justified yet
  relative to how often logs are actually consulted — start with cheap local
  logs and adopt aggregation when the fleet grows.
- What you actually need is an aggregate numeric signal (error rate, p99
  latency) rather than individual records — that's a job for
  [monitoring metrics](/docs/patterns/building-blocks/distributed-monitoring),
  which are far cheaper to store than full logs.

## Use-case scenarios

**Incident triage across microservices.** A payment fails intermittently in a
platform of forty services. The on-call engineer opens the central log UI,
filters on the failing request's `trace_id`, and instantly sees every line
that request produced across the gateway, auth, payments, and ledger services
— in order, with severities — pinpointing the service that timed out. Without
aggregation this would mean guessing which of hundreds of pods handled the
request and hoping it still exists.

**Regulated retention and audit.** A fintech must retain access and
transaction logs for years for compliance, but only queries the last two weeks
interactively during operations. A tiered pipeline keeps recent logs hot and
fully indexed, ages older logs to warm disk, and finally to cheap object
storage for the multi-year window — restoring a cold slice only for the rare
audit request. Retention policy, not deletion, satisfies the regulator without
paying hot-storage prices for years of data.

**High-volume edge logging with sampling.** A CDN edge fleet emits billions of
access log lines a day. Ingesting all of them verbatim would be ruinously
expensive, so agents sample: every error and a small percentage of successful
requests are shipped and indexed, while raw high-cardinality fields (full URLs,
client ids) stay in the message body rather than indexed columns. Engineers
keep enough signal to debug and measure while the index — and the bill — stay
bounded.

## Related patterns

- [Distributed Monitoring](/docs/patterns/building-blocks/distributed-monitoring) — logs are one of the three telemetry pillars monitoring aggregates, alongside metrics and traces.
- [Distributed Search](/docs/patterns/building-blocks/distributed-search) — the inverted-index machinery that makes centralized logs queryable by field and free text.
- [Distributed Tracing](/docs/patterns/observability/distributed-tracing) — the span-tree complement to correlated logs: same request, reconstructed with timings across services.
- [Distributed Message Queue](/docs/patterns/building-blocks/distributed-message-queue) — the buffering/transport stage that decouples bursty log producers from steadier downstream ingestion.
- [Backpressure](/docs/patterns/batch-streaming/backpressure) — the flow-control response a durable (blocking) buffer applies when the transport can't keep up.

## Further reading

- [Log management — Wikipedia](https://en.wikipedia.org/wiki/Log_management)
- [The twelve-factor app: logs as event streams](https://12factor.net/logs)
- [Elastic Stack (ELK) documentation](https://www.elastic.co/guide/index.html)
- [Grafana Loki documentation](https://grafana.com/docs/loki/latest/)
- [OpenTelemetry logs specification](https://opentelemetry.io/docs/specs/otel/logs/)
