---
title: "Multi-Master Replication"
sidebar_position: 10
supplementary: true
---

Multi-master replication lets more than one replica accept writes directly,
each propagating those writes to the others in the background, so no single
node's availability gates whether the system can accept writes at all.

![Multi-Master Replication diagram](/img/patterns/multi-master-replication.svg)

## Problem it solves

[Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication)
gives every replica a consistent view of the data, but only one node — the
primary — is allowed to accept writes. Every client far from the primary
pays a full round trip on every write, and when the primary fails, the
system has to choose between stalling writes until a new primary is
promoted or serving stale reads from a replica. That single-writer
constraint is exactly what multi-master removes: every master accepts
writes to its own local storage immediately, without waiting on any other
node, so writes are fast and available everywhere, and losing one master
doesn't stop the others from serving both reads and writes. The
system pays for that flexibility later, in the background, in the form of
**write conflicts** — two masters can each accept a write to the same
record before either knows about the other's write, and something has to
decide which one wins.

## Technical architecture & implementation

**Local writes, asynchronous propagation.** Each master commits an
incoming write to its own durable storage and returns success to the
client immediately — it does not wait for any other master to acknowledge
the write first. The write is then shipped to every other master in the
background, typically as an entry in a replication log, the same way
[Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication)
ships its log to replicas — the difference is that here, every node is
both a source and a destination of that log, not just one.

**There is no global clock, so you build one.** Deciding whether two writes
to the same record are the *same event seen twice*, one write that
causally followed the other, or two writes that happened independently at
the same time, requires some notion of ordering across machines that don't
share a clock. Three common building blocks: **per-record version
counters** (each master increments a counter it owns on every write to a
record), **[Vector Clocks](/docs/patterns/consistency/vector-clocks)** (a
counter per master, giving each write a fingerprint of everything that
master had seen when it made the write), or **loosely synchronized
wall-clock timestamps** (simpler, but require clock-skew handling so two
masters don't disagree about which timestamp is actually later). Version
vectors are the more precise tool: they can prove that one write causally
dominates another (so the later one is simply correct and there's no real
conflict), and they can also prove the negative — that two writes were
truly concurrent, so no amount of "which one is more recent" reasoning
based on causality alone can resolve it.

**Resolving a genuine conflict.** When two writes are provably concurrent,
some rule has to pick a winner (or merge both), and every master needs to
apply the *same* rule so they all converge on the same answer independently
rather than needing to talk to each other again. The simplest rule is
**last-write-wins by timestamp**, with a deterministic tiebreaker (such as
master id) for exact ties. It is also the crudest: it silently discards
one of the two writes, which is fine for data where "the newer value wins"
is actually correct (a user's display name, a cache entry) and wrong for
data where both writes carried information that mattered (two masters each
appending an item to the same shopping cart). For the latter, an
application-supplied merge function — or a data structure specifically
designed to merge deterministically regardless of arrival order, a
**CRDT** (conflict-free replicated data type) — avoids silently dropping
one write.

**What this trades away.** There is no way to offer a true cross-master
transaction: a read-then-write on one master can't be guaranteed
unaffected by a write landing concurrently on another master, because the
two masters aren't coordinating in real time — they're each proceeding
independently and reconciling afterward. The best achievable consistency
level is *eventual* consistency, not strong consistency. What multi-master
buys back in exchange is availability: because every master keeps serving
both reads and writes on its own, taking one master down for maintenance,
or losing one entirely, never puts the system into a read-only state the
way losing a primary-replica system's primary does.

## Code example

```rust
use std::collections::{HashMap, HashSet};

type MasterId = &'static str;

#[derive(Clone, Debug, PartialEq)]
struct VersionVector(HashMap<MasterId, u64>);

impl VersionVector {
    fn get(&self, master: MasterId) -> u64 {
        *self.0.get(master).unwrap_or(&0)
    }

    // True if `self` has seen everything `other` has seen, and something
    // more -- i.e. `self` causally happened after `other`.
    fn dominates(&self, other: &VersionVector) -> bool {
        let masters: HashSet<MasterId> =
            self.0.keys().chain(other.0.keys()).copied().collect();
        masters.iter().all(|&m| self.get(m) >= other.get(m))
            && masters.iter().any(|&m| self.get(m) > other.get(m))
    }
}

#[derive(Clone, Debug)]
struct Record {
    value: &'static str,
    version: VersionVector,
    written_at_master: MasterId,
    write_timestamp_ms: u64,
}

#[derive(Debug, PartialEq)]
enum Merged {
    KeepLocal,
    KeepIncoming,
    Conflict,
}

// Reconciles a local record against an incoming record replicated in from
// another master. If one version vector dominates the other, that write
// causally happened after and simply wins -- no real conflict. If neither
// dominates, both writes happened concurrently, and the reconciler falls
// back to last-write-wins, breaking exact-timestamp ties on master id so
// every master that sees both writes resolves the conflict identically.
fn reconcile(local: &Record, incoming: &Record) -> (Merged, &'static str) {
    if local.version.dominates(&incoming.version) {
        return (Merged::KeepLocal, local.value);
    }
    if incoming.version.dominates(&local.version) {
        return (Merged::KeepIncoming, incoming.value);
    }
    let incoming_wins = incoming.write_timestamp_ms > local.write_timestamp_ms
        || (incoming.write_timestamp_ms == local.write_timestamp_ms
            && incoming.written_at_master > local.written_at_master);
    if incoming_wins {
        (Merged::Conflict, incoming.value)
    } else {
        (Merged::Conflict, local.value)
    }
}
```

`dominates` is what tells causally-ordered writes apart from truly
concurrent ones: if `local`'s version vector already contains everything
`incoming`'s does (and something more), `incoming` can't have known about
anything `local` doesn't already reflect, so `local` wins outright with no
conflict. Only when neither vector dominates the other does `reconcile`
fall through to the last-write-wins tiebreak — and that tiebreak is
symmetric by construction, so masters `A` and `B` reconciling the same pair
of writes in opposite order still agree on the same winner.

## When to use it

- Clients write from many geographically distributed locations, and
  routing every write back to one designated primary would add
  unacceptable latency.
- Availability during a node failure or network partition matters more
  than strong consistency — every master must keep accepting writes even
  if it's cut off from the others.
- Conflicts are either rare in practice (writes to a given record
  naturally cluster near one location) or cheaply reconcilable
  (append-only logs, additive counters, CRDT-friendly data shapes).

## When not to use it

- The workload needs a real cross-datacenter transaction or global
  invariant — the canonical failure case is two masters each approving a
  withdrawal against the same account balance before either learns about
  the other's write, silently overspending the account. That requires
  [Two-Phase Commit](/docs/patterns/consistency/two-phase-commit) or
  [Paxos](/docs/patterns/consistency/paxos) instead.
- Conflicts are frequent and hard to reconcile automatically — inventory
  counts that must never go negative, or any workload where "pick one
  write and discard the other" is actually a data-loss bug, not a
  reasonable trade-off.
- A single designated writer is already good enough for the workload's
  latency needs — [Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication)
  gets most of multi-master's availability story with a simpler
  consistency model and no reconciliation logic to build or reason about.

## Use-case scenarios

**Globally distributed active-active database for a consumer app.** A
shopping-cart or user-preferences service serves users on multiple
continents, and routing every write back to one region would add 100ms+ of
pure network latency on top of normal processing time. Each region runs
its own master, accepting writes locally, and infrequent conflicts (a user
editing their profile from two devices near-simultaneously) are resolved
with last-write-wins, which is an acceptable trade-off since profile edits
are rarely truly concurrent and rarely both meaningfully different.

**Offline-first collaborative or mobile applications.** A note-taking or
task-management app lets a user edit on their phone while offline, then
reconnects and syncs. Each device is effectively its own master: it
accepts local writes with no network at all, then reconciles with the
server (and other devices) once connectivity returns. Conflicting edits
made offline on two devices are exactly the multi-master conflict case,
usually resolved with a CRDT-style merge (for structured data like a task
list) or last-write-wins (for simple fields).

**Multi-region configuration or metadata propagation.** A service needs
its configuration (feature flags, routing rules, DNS-style records) to be
editable from whichever region an operator happens to be working in, and
available for reads everywhere with low latency, tolerating a short
propagation delay after a change. Multi-master fits because writes here
are infrequent enough that conflicts are rare, and the read-heavy,
low-latency-everywhere access pattern is exactly what a single-primary
system would make expensive.

## Production libraries & getting started

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| Amazon DynamoDB Global Tables | Managed (any) | Multi-region, multi-master tables with automatic last-writer-wins conflict resolution | [Documentation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GlobalTables.html) |
| Apache CouchDB | Erlang (HTTP API) | Multi-master replication with an explicit revision tree that surfaces conflicts to the application instead of silently discarding writes | [Replication guide](https://docs.couchdb.org/en/stable/replication/index.html) |
| Riak KV | Erlang (HTTP/Protobuf API) | Dotted version vectors for conflict detection, with siblings surfaced to the client when a merge can't be resolved automatically | [Documentation](https://docs.riak.com/riak/kv/latest/) |
| Galera Cluster | C++ (MySQL/MariaDB) | Certification-based multi-master replication for MySQL/MariaDB, rejecting a conflicting transaction at commit time rather than reconciling after the fact | [Documentation](https://galeracluster.com/library/documentation/) |
| Azure Cosmos DB | Managed (any) | Multi-region writes with a choice of conflict-resolution policy (last-writer-wins, custom merge procedure, or manual) | [Documentation](https://learn.microsoft.com/en-us/azure/cosmos-db/conflict-resolution-policies) |

## Related patterns

- [Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication) —
  the single-writer alternative multi-master exists to avoid; simpler to
  reason about, but every write funnels through one node.
- [Vector Clocks](/docs/patterns/consistency/vector-clocks) — the
  conflict-detection mechanism this pattern's code example builds on, used
  here to tell a causally-later write apart from a truly concurrent one.
- [Quorum](/docs/patterns/consistency/quorum) — a different way to accept
  writes from multiple nodes, built around requiring enough
  acknowledgments up front rather than reconciling independent writes
  after the fact.
- [Two-Phase Commit](/docs/patterns/consistency/two-phase-commit) and
  [Paxos](/docs/patterns/consistency/paxos) — the strongly-consistent
  alternatives that give up multi-master's independent-write availability
  in exchange for a real cross-node transaction or agreement.
- [Transactions Across Datacenters](/docs/patterns/consistency/transactions-across-datacenters) —
  this course's condensed walkthrough of where multi-master fits among the
  other techniques for running a datastore across multiple datacenters.

## Further reading

- [Multi-master replication — Wikipedia](https://en.wikipedia.org/wiki/Multi-master_replication)
- [Conflict-free replicated data type — Wikipedia](https://en.wikipedia.org/wiki/Conflict-free_replicated_data_type) — the more principled alternative to last-write-wins for data where discarding a concurrent write is unacceptable
- [Vector Clock — Wikipedia](https://en.wikipedia.org/wiki/Vector_clock) — the underlying mechanism behind this pattern's conflict-detection code
