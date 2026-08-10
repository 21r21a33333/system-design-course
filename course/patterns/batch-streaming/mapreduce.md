---
title: "MapReduce"
sidebar_position: 1
supplementary: true
---

MapReduce is a programming model for processing large datasets by
splitting a job into a map phase that transforms records independently
and in parallel, and a reduce phase that aggregates the mapped results
by key.

## Problem it solves

Processing a dataset too large to fit on one machine — terabytes of log
lines, a web-scale crawl — by hand-writing distributed code is hard to
get right: you need to worry about splitting the input across machines,
scheduling work, handling machine failures mid-job, and collecting
results back together. Most batch jobs, though, share the same shape:
do some per-record transformation, then group and aggregate the
results. MapReduce factors that shared shape out into a reusable
framework, so an engineer writes only two small, sequential functions
and the framework handles parallelism, scheduling, and fault tolerance.

## How it works

The input dataset is split into chunks distributed across many
machines. In the **map phase**, a user-supplied map function runs over
each chunk independently and emits intermediate key-value pairs — for
example, given a line of text, emit `(word, 1)` for every word. Because
each map task only reads its own chunk and writes only its own output,
map tasks run fully in parallel with no coordination between them. The
framework then shuffles the intermediate output, grouping all values
that share a key onto the same machine. In the **reduce phase**, a
user-supplied reduce function runs once per key over all the values
grouped under it and emits a final aggregated result — continuing the
word-count example, summing all the `1`s for a given word into a total
count. The framework, not the user's code, is responsible for
retrying failed map or reduce tasks on other machines and for tracking
job progress.

## When to use it

- Embarrassingly parallel batch workloads over datasets far larger than
  a single machine's memory or disk, where per-record work is
  independent.
- Jobs that tolerate minutes-to-hours of end-to-end latency in exchange
  for processing enormous volumes reliably and without hand-rolled
  distributed coordination.
- Computations that decompose naturally into "transform each record,
  then aggregate by key" — word counts, log analysis, building inverted
  indexes, large joins.

## When not to use it

- Real-time or low-latency processing: a MapReduce job has substantial
  per-job overhead (scheduling, writing intermediate data to disk
  between phases) that makes it unsuited to anything needing
  sub-second or even sub-minute results — see [Stream Processing](/docs/patterns/batch-streaming/stream-processing) instead.
- Iterative algorithms that repeatedly pass over the same data (e.g.
  many machine-learning training loops), where the cost of re-reading
  and re-writing to disk between MapReduce jobs dominates.
- Small datasets that fit comfortably on one machine, where the
  distributed-scheduling overhead outweighs any parallelism gained.

## Real-world example

MapReduce originates from a 2004 Google paper describing how Google
indexed the web internally, using a canonical word-count example to
illustrate the model. Apache Hadoop's MapReduce implementation later
became the widely-used open-source realization of the same model,
running batch jobs across clusters of commodity machines backed by
HDFS for input and intermediate storage.

## Related patterns

- [Stream Processing](/docs/patterns/batch-streaming/stream-processing) — the continuous, low-latency counterpart to MapReduce's scheduled batch model.
- [Lambda / Kappa Architecture](/docs/patterns/batch-streaming/lambda-kappa-architecture) — architectures that combine a MapReduce-style batch layer with a streaming layer.

## Further reading

- [MapReduce — Wikipedia](https://en.wikipedia.org/wiki/MapReduce)
- [Apache Hadoop — Wikipedia](https://en.wikipedia.org/wiki/Apache_Hadoop)
