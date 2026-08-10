---
title: "Distributed Logging"
sidebar_position: 9
supplementary: true
---

Distributed logging collects, aggregates, and makes searchable the logs
emitted by many service instances, so operators can investigate an
issue across a whole fleet from one place instead of SSH-ing into
individual boxes to read local log files.

## Problem it solves

Reading logs by connecting to individual machines works when there are
a handful of long-lived servers. It breaks down completely once a
system runs across many instances that scale up and down or get
rescheduled — an instance relevant to an incident might not even exist
anymore by the time someone goes looking for it, and even when it does,
manually checking dozens or hundreds of machines for the one that
logged an error is not a workable incident-response process. Log
aggregation solves this by shipping every instance's logs off-box to a
central, durable, searchable store as they're generated.

## How it works

An agent on each instance tails log output and forwards it to a
central pipeline, which typically buffers through a queue before
writing to a store optimized for log search (often built around an
inverted index, similar to [Distributed
Search](/docs/patterns/building-blocks/distributed-search)). From
there, logs are queryable across the whole fleet by time range,
service, host, or free-text search.

The prerequisite that makes this actually useful at scale is structured
logging: emitting each log line as a well-defined object (commonly
JSON) with consistent fields — timestamp, service name, severity,
request ID, and so on — rather than free-form text. Free-text logs can
still be shipped and stored centrally, but querying them means
falling back to string matching or fragile regexes; structured logs let
the aggregation system index and filter on specific fields directly
(e.g. "show me every `ERROR`-severity log with this exact request ID
across all services"), which is what makes it possible to actually
correlate a single request's path through many services from its logs
alone.

## When to use it

- The system runs on enough instances, or instances are ephemeral
  enough, that manually checking individual machines isn't practical.
- Investigating an incident requires correlating log lines across
  multiple services for the same request or time window.
- Logs need to be retained and searchable for longer than any single
  instance's local disk or lifetime would allow.

## When not to use it

- A single long-lived instance with local log files is genuinely
  sufficient for the system's current scale.
- Log volume and the resulting storage/ingestion cost aren't justified
  yet relative to how often logs are actually consulted.

## Real-world example

The ELK stack (Elasticsearch for storage/search, Logstash or Beats for
collection, Kibana for visualization) is a widely used log-aggregation
pipeline. Grafana Loki takes a lighter-weight approach, indexing only
log metadata (labels) rather than full text, trading some query
flexibility for lower storage cost.

## Related patterns

- [Distributed Monitoring](/docs/patterns/building-blocks/distributed-monitoring) — log aggregation is one of the telemetry sources distributed monitoring consumes alongside metrics and error reports.

## Further reading

- [Log management — Wikipedia](https://en.wikipedia.org/wiki/Log_management)
