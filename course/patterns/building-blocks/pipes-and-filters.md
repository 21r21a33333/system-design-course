---
title: "Pipes and Filters"
sidebar_position: 15
supplementary: true
---

Pipes and Filters structures a processing task as a sequence of
independent, single-purpose processing steps (filters), each of which
reads input, does exactly one transformation, and writes output,
connected in a chain by pipes that carry data from one filter's output
to the next filter's input.

![Pipes and Filters diagram](/img/patterns/pipes-and-filters.svg)

## Problem it solves

A processing task that involves several distinct transformations —
parse, validate, enrich, transform, write — is often implemented as one
large function or one large service that does all of it in sequence
internally. That works, but it couples every transformation to every
other one: changing how validation works risks breaking parsing code
sitting right next to it in the same function, testing the enrichment
step in isolation means standing up the whole pipeline around it, and
reusing just the transform step in a different pipeline means either
duplicating it or untangling it from the rest. Pipes and Filters solves
this by forcing each transformation into its own independent unit with
a narrow, well-defined interface (consume this kind of input, produce
this kind of output) and no knowledge of what happens before or after
it in the chain — filters become independently testable, independently
reusable, and independently replaceable, and the pipeline as a whole is
just a declared sequence of which filter's output feeds which filter's
input.

## Technical architecture & implementation

**The filter contract.** Each filter is defined purely by its input and
output shape, not by what comes before or after it: a well-formed
filter can be lifted out of one pipeline and dropped into a different
one, as long as the new pipeline's neighboring filters produce and
expect the same shape of data. This independence is what a monolithic
processing function doesn't have — a step buried inside a single large
function is implicitly coupled to that function's local variables and
control flow, while a filter's only contract is its input and output
type. Filters commonly, though not necessarily, run as separate
processes or separate deployable units, which is what makes the "pipe"
half of the name literal rather than just a metaphor — a Unix shell
pipeline (`grep | sort | uniq`) is pipes and filters with actual
operating-system pipes connecting actual separate processes, each
reading stdin and writing stdout with zero awareness of what's on
either end.

**Streaming vs. batch data flow through the pipe.** A pipe can move
data between filters in two different ways, and the choice shapes the
pipeline's latency and memory profile. A pipe can pass data through
**as a stream**, where a filter starts producing output before it has
finished consuming its input and the downstream filter starts
consuming that output immediately — this keeps memory bounded (no
filter needs to hold the entire dataset in memory at once) and lets the
whole pipeline's effective latency approach that of its slowest single
filter rather than the sum of every filter processing the entire
dataset in turn. Alternatively a pipe can pass data **as discrete
batches or messages** — a filter fully finishes processing one unit,
emits a complete result, and only then does the next filter pick it up
— which is simpler to reason about and easier to retry a single failed
unit of, at the cost of the pipeline's overall latency for a given unit
of data being closer to the sum of every filter's individual processing
time for it.

**Failure modes.** Because filters are independent and typically
run as separate processes with a pipe between them, a failure in any
one filter needs an explicit answer: does the pipeline stop entirely,
does the failed unit get skipped and logged, or does it get retried?
A well-designed pipeline treats a filter's failure on a specific unit
of data as a first-class outcome the pipe has to carry forward, not an
exception that silently vanishes — the common approach is routing
failed units to a [Dead Letter Queue](/docs/patterns/reliability/dead-letter-queue)
so that a malformed record blocks neither the rest of the batch nor the
whole pipeline, and can be inspected or reprocessed separately.
Backpressure is the second failure mode worth naming explicitly: if a
downstream filter is slower than the one feeding it, the pipe between
them has to buffer, and an unbounded buffer under sustained backpressure
can exhaust memory just as easily as an unbounded queue would in any
other producer-consumer system — a robust pipe implementation bounds
its buffer and propagates the slowdown backward (the upstream filter
blocks or is throttled) rather than buffering without limit.

**Parallel filters and the ordering trade-off.** Because a filter is
stateless with respect to its neighbors, a slow stage can be *scaled
horizontally* by running many replicas of that one filter and spreading
units across them — the enrichment stage that makes a network call per
record runs with far more instances than a cheap in-memory parse stage.
This is the [Competing
Consumers](/docs/patterns/batch-streaming/competing-consumers) pattern
applied to a single stage of the pipe, and it's what lets each filter be
scaled independently to match its own cost. The trade-off it introduces
is **ordering**: the moment a stage has multiple parallel workers pulling
from the same pipe, units can finish out of the order they entered, so a
pipeline that must preserve order either keeps order-sensitive stages
single-worker or carries a sequence key and re-orders downstream (the
[Sequential Convoy](/docs/patterns/batch-streaming/sequential-convoy)
approach of partitioning by key so same-key units stay serialized while
different keys run in parallel). Deciding, per stage, whether ordering
actually matters is what makes safe parallelization possible.

**Pipes and Filters vs. Event-Driven Architecture / Choreography.**
Pipes and Filters looks superficially similar to an event-driven chain
of services, but the coupling is different in an important way: a
filter is wired to a *specific* next filter through an explicit pipe —
the sequence is a declared, generally linear or tree-shaped chain known
at deployment time — whereas in an event-driven system or
[Choreography](/docs/patterns/consistency/choreography), a service
publishes an event without knowing or caring who (if anyone) is
listening, and the set of subscribers can change independently of the
publisher. Pipes and Filters is the right shape when the sequence of
transformations is fixed and known — this data always goes through
parse, then validate, then enrich, in that order — while choreography
fits better when the set of reactions to a given event is open-ended
and expected to grow without the event's source being touched.

## Code example

```rust
// Each filter has exactly one job and knows nothing about what
// produced its input or what will consume its output.
fn parse(raw: &str) -> Vec<i64> {
    raw.split(',').filter_map(|s| s.trim().parse().ok()).collect()
}

fn filter_negative(values: Vec<i64>) -> Vec<i64> {
    values.into_iter().filter(|&v| v >= 0).collect()
}

fn double(values: Vec<i64>) -> Vec<i64> {
    values.into_iter().map(|v| v * 2).collect()
}

fn sum(values: Vec<i64>) -> i64 {
    values.into_iter().sum()
}

// The pipeline is just a declared sequence of filter calls — reordering,
// removing, or inserting a filter here doesn't require changing any
// individual filter's implementation.
fn run_pipeline(raw: &str) -> i64 {
    let parsed = parse(raw);
    let cleaned = filter_negative(parsed);
    let doubled = double(cleaned);
    sum(doubled)
}
```

Each function — `parse`, `filter_negative`, `double`, `sum` — is
independently testable with its own plain input and output, and
`run_pipeline` is the only place that knows the full sequence; any one
of the four could be swapped for a different implementation, reordered,
or reused in a different pipeline without the others changing at all.

## When to use it

- A processing task naturally decomposes into a fixed sequence of
  independent transformations, and each step benefits from being
  independently testable, reusable, or replaceable.
- Different steps have different scaling or resource needs (one step is
  CPU-bound, another is I/O-bound) and would benefit from being deployed
  or scaled as separate units rather than living inside one monolithic
  process.
- The sequence of steps is stable and known in advance, so a declared,
  linear chain is a more honest representation of the system than an
  open-ended set of event subscribers.

## When not to use it

- The set of reactions to a given step's output needs to grow or change
  independently of that step, or isn't known in advance — that's the
  shape [Choreography](/docs/patterns/consistency/choreography) and
  event-driven architecture fit, not a fixed pipe chain.
- The steps are tightly interdependent and need to share rich context
  or make joint decisions rather than passing a narrow, well-defined
  data shape forward — forcing that into strict filter boundaries adds
  serialization and interface overhead without a real independence
  benefit.
- The processing is simple enough (one or two straightforward steps)
  that the overhead of separate deployable units, pipe infrastructure,
  and per-filter monitoring costs more than it returns.

## Use-case scenarios

**Log-processing pipeline.** A platform ingests raw application logs
through a chain of filters: one parses raw log lines into structured
records, the next filters out records below a configured severity
level, the next enriches each record with metadata looked up from a
service registry, and the last writes the enriched records to a search
index. Each filter is deployed and scaled independently — the
enrichment filter, which makes a network call per record, runs with far
more replicas than the cheap in-memory parsing filter.

**Image-processing service.** A photo-upload service runs uploaded
images through a pipeline of filters: virus scanning, format
validation, resizing into several standard dimensions, and thumbnail
generation, each implemented as an independent filter reading from and
writing to a shared pipe (in practice, a queue). A malformed image that
fails validation is routed to a dead-letter path rather than crashing
or stalling the resize and thumbnail filters waiting behind it.

**Unix-style command-line data processing.** A data engineer
processing a large CSV export chains together small, single-purpose
command-line tools — one to extract specific columns, one to filter
rows matching a condition, one to sort the result, one to deduplicate —
connected with shell pipes. Each tool is independently reusable in
completely different pipelines, and swapping the sort step for a
different sort order requires touching nothing about the extraction or
filtering steps.

## Production libraries & getting started

Most languages ship a native streaming/pipeline primitive; heavier integration and stream-processing frameworks cover the multi-stage, backpressured cases.

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| Node.js `stream` (pipeline/Transform) | JS/TS | Built-in composable readable/transform/writable stages with backpressure via `pipeline()` | [Stream API docs](https://nodejs.org/api/stream.html) |
| `tokio-stream` + `futures` | Rust | Async `Stream` combinators (`map`, `filter`, `then`) to chain filter stages | [tokio-stream docs](https://docs.rs/tokio-stream/latest/tokio_stream/) |
| Go channels pipeline | Go | Idiomatic goroutine + channel stages with fan-out/fan-in and cancellation | [Go blog: Pipelines](https://go.dev/blog/pipelines) |
| Faust | Python | Kafka-based stream processing with agent/stage composition | [Faust introduction](https://faust-streaming.github.io/faust/introduction.html) |
| Bytewax | Python | Dataflow stream processing (Rust core, Python API) | [Bytewax repo & docs](https://github.com/bytewax/bytewax) |

For heavier enterprise integration pipelines (routing, transformation, connectors across systems):

| Tool | What it gives you | Getting started |
| --- | --- | --- |
| Apache Camel | Enterprise integration routes built from pipe/filter components | [Camel getting started](https://camel.apache.org/manual/getting-started.html) |

## Related patterns

- [Choreography](/docs/patterns/consistency/choreography) — the
  event-driven counterpart where a step's output triggers an
  open-ended, independently evolvable set of reactions rather than a
  fixed, declared next filter; use Pipes and Filters when the sequence
  is known and stable, choreography when the set of reactions should be
  free to grow.
- [Dead Letter Queue](/docs/patterns/reliability/dead-letter-queue) —
  the standard way a pipeline handles a unit of data that a filter
  can't process, routing it aside for inspection rather than blocking
  or crashing the rest of the pipeline.
- [Distributed Message Queue](/docs/patterns/building-blocks/distributed-message-queue) —
  the infrastructure a pipe is frequently implemented on top of when
  filters run as separate services rather than in-process functions.
- [Competing Consumers](/docs/patterns/batch-streaming/competing-consumers) —
  how a single slow filter stage is scaled by running many replicas that
  pull from the same pipe, at the cost of cross-unit ordering.
- [Sequential Convoy](/docs/patterns/batch-streaming/sequential-convoy) —
  preserves order *within* a key while still parallelizing across keys,
  the way to parallelize an order-sensitive filter stage safely.

## Further reading

- [Pipes and Filters pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/pipes-and-filters)
- [Pipeline (software) — Wikipedia](https://en.wikipedia.org/wiki/Pipeline_(software))
- [Pipes and Filters — Enterprise Integration Patterns (Hohpe & Woolf)](https://www.enterpriseintegrationpatterns.com/patterns/messaging/PipesAndFilters.html)
