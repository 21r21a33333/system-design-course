---
title: "MapReduce"
sidebar_position: 1
supplementary: true
---

MapReduce is a programming model for processing large datasets by
splitting a job into a map phase that transforms records independently
and in parallel, and a reduce phase that aggregates the mapped results
by key — with the framework handling data distribution, scheduling, and
fault tolerance so the engineer writes only the two functions.

![MapReduce diagram](/img/patterns/mapreduce.svg)

## Problem it solves

Processing a dataset too large for one machine — terabytes of log lines,
a web-scale crawl — by hand-writing distributed code is hard to get
right: you must split the input across machines, schedule work, handle
machines that die mid-job, deal with stragglers that run slow, and
collect results back together. Most batch jobs, though, share the same
shape: do some per-record transformation, then group and aggregate the
results by key. MapReduce factors that shared shape out into a reusable
framework, so an engineer supplies two small functions and the framework
handles parallelism, scheduling, and recovery from failure. The
insight that made it practical at scale is **data locality**: rather
than pulling terabytes across the network to the compute, the scheduler
ships the small map function *to the machines that already hold the
data*, so most reads are local disk, not network.

## Technical architecture & implementation

**Map → shuffle → reduce.** The input is split into chunks spread across
many machines. In the **map phase**, a user-supplied map function runs
over each chunk independently and emits intermediate key-value pairs —
for word count, `(word, 1)` for every word. Because each map task reads
only its own chunk and writes only its own output, map tasks run fully
in parallel with zero coordination. The framework then **shuffles**:
every emitted value is routed to a bucket by its key so that all values
sharing a key land together. In the **reduce phase**, a user-supplied
reduce function runs once per key over all its grouped values and emits
the aggregate — summing the `1`s for each word into a count.

**Combiner and partitioner.** Two hooks shape the shuffle, which is the
expensive part because it moves data across the network. A **combiner**
is a map-side pre-aggregation — for word count, summing the local `1`s
for a word before shipping, so `(the, 47)` crosses the wire instead of
forty-seven separate `(the, 1)` pairs. It works only when reduce is
associative and commutative, and it can dramatically cut shuffle
traffic. A **partitioner** decides which reduce task owns which key
(typically `hash(key) mod R`); a skewed partitioner sends too many keys
to one reducer and creates a straggler.

**Sort-merge in the shuffle.** Each reducer's input arrives from many
mappers and must be presented grouped by key. The framework sorts each
mapper's output by key, then merges the sorted streams reducer-side — a
sort-merge that also gives reduce its keys in sorted order for free,
which is why MapReduce output is naturally sorted.

**Fault tolerance by deterministic re-execution.** Machines fail
routinely at cluster scale, and MapReduce's answer is disarmingly
simple: because map and reduce are pure functions of their input and
intermediate output is written to disk, a task that fails (or whose
machine dies) is simply **re-run** on another node from the same input.
No checkpoint of partial progress is needed — determinism means the
re-run produces the identical result. A master node tracks each task's
state and reschedules the failed ones.

**Stragglers and speculative execution.** A job finishes only when its
slowest task does, and a single sluggish machine (a failing disk, a
noisy neighbor) can stall the whole job. The framework fights this with
**speculative execution**: near the end of a phase it launches *backup*
copies of the remaining in-progress tasks on other machines and takes
whichever finishes first, cancelling the loser. This is safe precisely
because tasks are deterministic and idempotent.

**Where it sits, and what superseded it.** MapReduce is strictly a
*batch* model over **bounded** input: a job starts, processes a fixed
dataset, and ends — the opposite of
[stream processing](/docs/patterns/batch-streaming/stream-processing),
which runs continuously over **unbounded** input. Its main limitation
is that every job materializes intermediate results to disk between map
and reduce, and chaining jobs (as iterative algorithms require) re-reads
and re-writes that data each round. **DAG engines like Apache Spark**
superseded raw MapReduce for most workloads by keeping intermediate
data in memory and scheduling a whole graph of stages at once — but they
kept the same map/shuffle/reduce primitives underneath, so understanding
MapReduce is understanding the layer Spark is built on. In a
[Lambda architecture](/docs/patterns/batch-streaming/lambda-kappa-architecture),
MapReduce (or a Spark batch job) is the classic batch layer.

## Worked example: word count

Trace three input splits through the phases:

| Phase | Data |
| --- | --- |
| **Splits** | `"the cat sat"`, `"the dog sat"`, `"the cat ran"` |
| **Map** (parallel) | `(the,1)(cat,1)(sat,1)` · `(the,1)(dog,1)(sat,1)` · `(the,1)(cat,1)(ran,1)` |
| **Shuffle** (group by key) | `the:[1,1,1]` · `cat:[1,1]` · `sat:[1,1]` · `dog:[1]` · `ran:[1]` |
| **Reduce** (sum) | `the→3` · `cat→2` · `sat→2` · `dog→1` · `ran→1` |

A combiner would collapse each split's duplicates before the shuffle
(e.g. `map 1` ships nothing repeated here, but a split like
`"the the the"` would ship `(the,3)` rather than three pairs).

## Code example

This is a single-process MapReduce doing exactly the worked example: the
map runs on **real threads** (`std::thread::scope`), one per split, then
a shuffle groups by key, then reduce sums each group. The `main`
harness times it to prove the map phase is genuinely concurrent — four
splits each doing 50 ms of simulated work finish in about 60 ms wall
time, not 200 ms.

```rust
use std::collections::HashMap;
use std::time::{Duration, Instant};

// A map task: turn one input split into intermediate (key, value) pairs.
// Word count emits (word, 1) for every word in the split.
fn map_split(split: &str) -> Vec<(String, u64)> {
    std::thread::sleep(Duration::from_millis(50)); // simulated per-split work
    split
        .split_whitespace()
        .map(|w| {
            let word: String = w.chars().filter(|c| c.is_alphanumeric()).collect();
            (word.to_lowercase(), 1u64)
        })
        .filter(|(w, _)| !w.is_empty())
        .collect()
}

// The reduce function: fold all values under one key into a single result.
fn reduce(_key: &str, values: &[u64]) -> u64 {
    values.iter().sum()
}

// Drive map (parallel, one thread per split) -> shuffle (group by key)
// -> reduce (once per key). Returns the final key -> count table.
fn run(splits: &[&str]) -> HashMap<String, u64> {
    // MAP: real threads, one per split, running concurrently.
    let mapped: Vec<Vec<(String, u64)>> = std::thread::scope(|scope| {
        let handles: Vec<_> = splits
            .iter()
            .map(|s| scope.spawn(move || map_split(s)))
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });

    // SHUFFLE: group every emitted value by its key.
    let mut grouped: HashMap<String, Vec<u64>> = HashMap::new();
    for pairs in mapped {
        for (key, value) in pairs {
            grouped.entry(key).or_default().push(value);
        }
    }

    // REDUCE: one call per key over all its grouped values.
    grouped
        .into_iter()
        .map(|(key, values)| {
            let total = reduce(&key, &values);
            (key, total)
        })
        .collect()
}

fn main() {
    let splits = [
        "the cat sat on the mat",
        "the dog sat on the log",
        "the cat and the dog",
        "a cat a dog a bird",
    ];
    let start = Instant::now();
    let counts = run(&splits);
    let elapsed = start.elapsed();

    assert_eq!(counts["the"], 6);
    assert_eq!(counts["cat"], 3);
    assert_eq!(counts["dog"], 3);
    println!("4 splits x 50ms each ran in {:?}", elapsed);
}
```

Running it prints roughly `4 splits x 50ms each ran in 60ms` — sub-linear
in the number of splits, which is the whole point of the parallel map
phase; a sequential version would take about 200 ms. The shuffle and
reduce then produce the counts the assertions check.

## When to use it

- Embarrassingly parallel batch workloads over datasets far larger than
  one machine's memory or disk, where per-record work is independent.
- Jobs that tolerate minutes-to-hours of latency in exchange for
  processing enormous volumes reliably without hand-rolled distributed
  coordination.
- Computations that decompose naturally into "transform each record,
  then aggregate by key" — word counts, log analysis, inverted-index
  builds, large distributed joins, ETL into a warehouse.

## When not to use it

- Real-time or low-latency work: per-job scheduling overhead plus
  writing intermediate data to disk between phases rules out sub-minute
  results — use [stream processing](/docs/patterns/batch-streaming/stream-processing)
  instead.
- Iterative algorithms that pass over the same data repeatedly (many ML
  training loops, graph algorithms), where re-reading and re-writing to
  disk between jobs dominates — a DAG/in-memory engine like Spark fits
  far better.
- Datasets small enough to fit on one machine, where distributed
  scheduling overhead outweighs any parallelism gained.

## Use-case scenarios

**Building an inverted index for web search.** The original motivating
use case: map over a crawl emitting `(term, doc_id)` for every term in
every document, shuffle to group all documents per term, and reduce to
emit each term's sorted postings list. The result is exactly the
inverted index a [distributed search](/docs/patterns/building-blocks/distributed-search)
system serves — computed reliably across thousands of machines with
failed tasks re-run transparently.

**Nightly log analytics.** An engineering org processes a day's raw
request logs to compute per-endpoint traffic, error rates, and
percentile latencies. Map parses each log line into `(endpoint, metric)`
pairs, a combiner pre-aggregates per machine to shrink the shuffle, and
reduce rolls each endpoint's metrics into a daily summary table — a
scheduled batch job where hours of latency is entirely acceptable.

**Large-scale ETL and joins.** Consolidating clickstream events with a
user dimension table means a distributed join over billions of rows. A
MapReduce (or Spark) job maps both inputs to a common join key, shuffles
so matching records co-locate, and reduces to emit the joined,
enriched rows into a data warehouse — the kind of bounded, high-volume
transformation the model was built for.

## Related patterns

- [Stream Processing](/docs/patterns/batch-streaming/stream-processing) —
  the continuous, low-latency counterpart over unbounded input; the
  contrast (bounded batch vs. unbounded stream) is the key distinction.
- [Lambda / Kappa Architecture](/docs/patterns/batch-streaming/lambda-kappa-architecture) —
  Lambda's batch layer is classically a MapReduce/Spark job; Kappa
  argues a replayable stream can replace it.
- [Distributed Search](/docs/patterns/building-blocks/distributed-search) —
  the inverted index a search cluster serves is a canonical MapReduce
  output.
- [Pipes and Filters](/docs/patterns/building-blocks/pipes-and-filters) —
  the more general "chain of transformation stages" idea that
  map→shuffle→reduce is a specialized, distributed instance of.

## Further reading

- [MapReduce — Wikipedia](https://en.wikipedia.org/wiki/MapReduce)
- [MapReduce: Simplified Data Processing on Large Clusters — Dean & Ghemawat (Google, 2004)](https://research.google/pubs/mapreduce-simplified-data-processing-on-large-clusters/)
- [Apache Hadoop MapReduce tutorial — official docs](https://hadoop.apache.org/docs/stable/hadoop-mapreduce-client/hadoop-mapreduce-client-core/MapReduceTutorial.html)
- [Apache Spark — official site](https://spark.apache.org/)
