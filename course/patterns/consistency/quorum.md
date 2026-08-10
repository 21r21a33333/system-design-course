---
title: "Quorum"
sidebar_position: 3
supplementary: true
---

Quorum consistency requires a minimum number of replica nodes to
acknowledge a read or write before the operation counts as successful,
sized so that every read set and every write set are guaranteed to
overlap on at least one node that has the latest value.

## Problem it solves

In a replicated system with N copies of the data, requiring every
single replica to acknowledge a write before it succeeds (N-of-N)
gives strong consistency but means the whole write fails if even one
replica is slow or down — availability suffers badly as N grows.
Requiring only one replica to acknowledge (1-of-N) is highly available,
but a subsequent read from a different, not-yet-updated replica can
return stale data with no guarantee of ever seeing the write. Quorum
consistency sits between these extremes: it lets an operator tune how
many nodes must participate in a write (W) and a read (R) out of N
total replicas, trading off consistency, availability, and latency
without going to either extreme.

## How it works

A write is sent to all N replicas but is only considered successful
once W of them acknowledge it; a read is sent to (at least) R replicas
and the most recent value among their responses is returned. The key
invariant is choosing W and R such that **W + R > N**. Because any W
nodes and any R nodes drawn from the same pool of N must share at least
one common node (by the pigeonhole principle), every read quorum is
guaranteed to overlap with every prior write quorum on at least one
node — so at least one of the nodes a read contacts will have the
latest acknowledged write, and the read can identify and return the
most recent version (typically using a version number or timestamp to
tell which response is newest). Common configurations include W=N,
R=1 (fast reads, slower writes), W=1, R=N (fast writes, slower reads),
or a balanced majority quorum such as W=R=⌈(N+1)/2⌉, which also
tolerates the failure of up to ⌊(N-1)/2⌋ nodes while still completing
operations.

## When to use it

- The system needs configurable consistency without hard-coding either
  full replication (N-of-N) or single-node reads/writes.
- Different operations in the same system have different consistency
  needs — for example, a critical balance update might use a strict
  majority quorum while a low-stakes read (like a "last seen" counter)
  uses a lower R for lower latency.
- Availability during partial node failure matters: as long as W (or R)
  nodes out of N are reachable, the operation can still succeed even if
  some replicas are down.

## When not to use it

- The system needs true linearizability across all operations, not just
  read-after-write consistency for a single key — quorum reads/writes
  alone don't provide the stronger guarantees a consensus protocol
  (like Raft or Paxos) gives for coordinating cluster-wide state, such
  as leader election.
- Cross-datacenter latency makes contacting W or R nodes per operation
  too slow for the application's latency budget — a single-leader
  design with local reads (accepting more staleness) may fit better.
- The data model doesn't have a clean way to compare which of several
  concurrent versions is "newest" — quorum reads need some ordering
  mechanism (timestamps, version vectors) to resolve conflicting
  responses.

## Real-world example

Amazon DynamoDB offers a choice between eventually consistent reads
(cheaper, may return stale data shortly after a write) and strongly
consistent reads (always reflect the most recent successful write),
letting applications pick the right trade-off per request. Apache
Cassandra, built on the same Dynamo lineage, exposes this trade-off
more directly: clients choose a consistency level per request — such as
`ONE`, `QUORUM`, or `ALL` — that determines how many of the N replicas
must respond, and operators commonly pair `QUORUM` writes with `QUORUM`
reads specifically to get the W + R > N overlap guarantee.

## Related patterns

- [Vector Clocks](/docs/patterns/consistency/vector-clocks) — used
  alongside quorum reads to detect when multiple replicas hold
  genuinely concurrent, conflicting versions rather than a simple
  most-recent-wins update.
- [Consistency Patterns](/docs/concepts/consistency-patterns) — the
  primer's broader treatment of weak, eventual, and strong consistency
  models that quorum sits within.

## Further reading

- [Quorum (distributed computing) — Wikipedia](https://en.wikipedia.org/wiki/Quorum_(distributed_computing))
- [DynamoDB read consistency — AWS documentation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html)
