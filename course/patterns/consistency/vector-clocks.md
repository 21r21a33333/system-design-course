---
title: "Vector Clocks"
sidebar_position: 4
supplementary: true
---

A vector clock is a per-node counter vector — one counter per
participating node — attached to each update, used to determine the
causal order of events across a distributed system and to detect when
two updates happened concurrently, without relying on synchronized
wall-clock time.

## Problem it solves

In a distributed system, physical clocks on different machines are
never perfectly synchronized, so timestamping updates with wall-clock
time and comparing them to decide which is "newer" is unreliable —
clock drift or skew can make an update that actually happened later
appear to have an earlier timestamp. This matters a lot in systems that
allow writes to be accepted by multiple replicas (for availability),
because when those replicas' updates are later compared — say, during
a quorum read — the system needs a reliable way to tell whether one
update causally followed from (and should supersede) another, or
whether the two updates happened independently and now genuinely
conflict and need to be reconciled.

## How it works

Every node maintains a vector of counters, one entry per node in the
system (e.g. `{A: 2, B: 1, C: 0}`). Whenever a node produces a new
event or update, it increments its own entry in the vector and attaches
the resulting vector to that update. When a node receives an update
from another node, it merges the incoming vector into its own by taking
the entry-wise maximum, then increments its own entry again. To compare
two vectors, the rule is: vector X "happened before" vector Y if every
entry in X is less than or equal to the corresponding entry in Y, and
at least one entry is strictly less — in that case Y causally descends
from X and safely supersedes it. If neither vector is less-than-or-equal
to the other (each has at least one entry higher than the other's), the
two updates are **concurrent**: neither one is aware of the other, and
the system has a genuine conflict that only application-level logic (or
the end user) can resolve — for example, by merging both versions or
asking the client to pick one.

## When to use it

- Multiple replicas can accept writes independently (multi-master or
  leaderless replication) and the system needs to detect, rather than
  silently overwrite, conflicting concurrent updates.
- Causal ordering between events matters more than a total, globally
  agreed order — the system only needs to know "did A happen before B,
  after B, or independently of B."
- The application is willing to handle conflict resolution explicitly
  (last-writer-wins is not acceptable because it silently discards one
  of two legitimate concurrent updates).

## When not to use it

- The system already has a single leader per piece of data (single-
  writer replication), so writes are naturally totally ordered and
  there's no concurrent-write conflict to detect in the first place.
- The number of nodes that can independently write is large or grows
  frequently — vector clocks grow linearly with the number of distinct
  writers, and pruning stale entries safely is nontrivial engineering
  overhead.
- The application can tolerate simple last-writer-wins semantics — the
  extra complexity of tracking and reconciling concurrent versions
  isn't worth it if silently picking one write over another is fine.

## Real-world example

Amazon's original Dynamo system (described in Amazon's 2007 Dynamo
paper, which also inspired DynamoDB and Cassandra) used vector clocks
to track the causal history of each object version across replicas.
When a read encountered multiple versions of an object whose vector
clocks were concurrent rather than causally ordered, Dynamo returned
all of the conflicting versions to the application (or, in the shopping
cart example from the paper, merged them automatically) rather than
picking one arbitrarily and silently losing data.

## Related patterns

- [Quorum](/docs/patterns/consistency/quorum) — quorum reads are exactly
  the situation where multiple replica versions get compared, and
  vector clocks are what let that comparison detect real conflicts
  instead of assuming the most recent write always wins.

## Further reading

- [Vector clock — Wikipedia](https://en.wikipedia.org/wiki/Vector_clock)
- [Dynamo (storage system) — Wikipedia](https://en.wikipedia.org/wiki/Dynamo_(storage_system))
