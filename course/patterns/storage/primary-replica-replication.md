---
title: "Primary-Replica Replication"
sidebar_position: 8
supplementary: true
---

Primary-replica replication keeps multiple full copies of the same
dataset on different machines by designating one node the primary,
which accepts all writes, and propagating every write from the primary
to one or more replicas, which serve reads but do not independently
accept writes of their own.

![Primary-Replica Replication diagram](/img/patterns/primary-replica-replication.svg)

## Problem it solves

A single database instance is a single point of failure — if the disk
fails, the process crashes unrecoverably, or the machine it runs on
disappears, every read and write the application depends on stops
working until that one instance is restored, and any data written
since the last backup may be gone for good. A single instance is also
a hard ceiling on read throughput: every read, no matter how many
application servers are asking, ultimately queues behind the same
machine's CPU, memory, and disk I/O. Primary-replica replication solves
both problems at once by maintaining redundant, continuously
up-to-date copies of the data: if the primary fails, a replica already
holds (almost) everything the primary had and can be promoted to take
over, and in the meantime, reads that don't need the absolute latest
write can be spread across replicas instead of all landing on one
machine.

## Technical architecture & implementation

**Write path.** All writes are directed to the primary, and only the
primary — this single-writer design is what keeps the dataset
internally consistent without requiring the nodes to run a distributed
consensus protocol on every write. After committing a write locally,
the primary records it in a replication stream — commonly the same
write-ahead log the primary already maintains for its own crash
recovery — and ships that stream to each replica. Each replica applies
the incoming stream in order to its own local copy of the data,
converging toward the same state the primary has, just slightly
behind.

**Synchronous vs. asynchronous replication.** How the primary handles
that lag is the central design decision. In *synchronous* replication,
the primary waits for acknowledgment from one or more replicas before
considering the write successful, which guarantees a promoted replica
never loses an acknowledged write, at the direct cost of write latency
now including a network round trip to the replica on every write, and
the primary becoming unable to accept writes at all if the required
replica acknowledgment can't be obtained. In *asynchronous*
replication, the primary commits locally and returns success to the
client immediately, streaming the write to replicas in the background
without waiting — writes are fast and the primary keeps accepting them
even if a replica is slow or briefly unreachable, but there is now a
real replication-lag window during which the primary holds data no
replica has yet, and if the primary fails during that window, whatever
hadn't yet replicated is lost when a replica is promoted in its place.
Most production systems default to asynchronous replication for
throughput and use synchronous replication selectively for data where
that loss window is unacceptable.

**Failover.** When the primary becomes unreachable, one replica must be
promoted to take over as the new primary, and every other replica and
every client needs to be redirected to it — this is the same general
[Failover](/docs/patterns/reliability/failover) mechanism applied
specifically to a replicated data store, and it inherits the same
split-brain risk any failover process has: if the old primary is
merely partitioned rather than actually dead, it may keep accepting
writes on its side of the partition after a replica has already been
promoted, producing two primaries whose data has diverged. Guarding
against this requires the same fencing discipline described on the
[Leader Election](/docs/patterns/consistency/leader-election) page —
a promotion bumps a term or generation number, and the old primary's
writes are rejected by anything downstream once a higher generation
has been observed, rather than trusting the old primary to notice on
its own that it's been replaced.

**Primary-Replica Replication vs. Sharding.** These solve different
problems and are frequently confused because both involve multiple
database instances. [Sharding](/docs/patterns/storage/sharding)
*partitions* data: each shard holds a different, disjoint subset of
the rows, so sharding scales total storage capacity and total write
throughput, because different writes land on different machines — but
it does nothing for a single row's availability, since that row still
lives on exactly one shard, and losing that shard loses that row's
data. Replication *copies* data: every replica holds the same rows the
primary does, so replication scales read throughput and provides
failover safety for the whole dataset, but it does nothing for write
throughput or storage capacity, since every write still has to be
accepted by the single primary and applied to every replica in full.
The two are complementary rather than substitutes, and large systems
commonly use both together: a sharded dataset where each individual
shard is itself a primary-replica set, so the system gets sharding's
write-throughput and capacity scaling and replication's read scaling
and failover safety, layered on top of each other.

## Living with replication lag

Serving reads from asynchronous replicas is where lag stops being an
abstraction and starts producing user-visible anomalies, and a few
recurring ones are worth naming because each has a standard mitigation.

**Read-your-own-writes.** A user updates their profile, the write
commits on the primary, the immediate re-read is routed to a replica
that hasn't received the change yet — and the user sees their *old*
profile, as if the save failed. The usual fix is to route a user's reads
to the primary (or to a replica known to be caught up) for a short window
after that user writes, so they always observe at least their own latest
change even while everyone else reads from lagging replicas.

**Monotonic reads.** Two successive reads by the same user land on two
different replicas at different lag, and the second replica is *further
behind* than the first — so the user watches data appear to travel
backwards in time (a comment they just saw vanishes). Pinning a session
to a single replica, or tracking a per-session read position, keeps a
user's view moving only forward.

**Bounding and monitoring lag.** Because lag is the currency of all of
this, production systems measure it continuously — as a time delta (how
many seconds behind) or a log-position delta — and act on it: a replica
whose lag crosses a threshold is pulled out of the read pool until it
catches up, rather than serving reads so stale they're misleading. Some
systems expose the primary's current write position to clients and let a
read specify "only serve me from a replica that has applied at least up
to position X," turning "read from a fresh-enough replica" into an
explicit, checkable contract rather than a hope.

These are the same consistency guarantees the
[consistency patterns](/docs/patterns/consistency/quorum) formalize;
primary-replica replication is where an application most often meets them
in practice, because "read from a replica" quietly opts into all of them
at once.

## Code example

```rust
struct Primary {
    log: Vec<String>,
}

impl Primary {
    // Commits locally first, then the write is available to be
    // streamed to replicas — replicas never get ahead of the primary.
    fn write(&mut self, value: &str) -> usize {
        self.log.push(value.to_string());
        self.log.len() - 1 // the offset a replica can catch up from
    }
}

struct Replica {
    applied: Vec<String>,
}

impl Replica {
    // Asynchronous catch-up: applies every entry after its own last
    // applied offset, in order. A replica calling this on a lag —
    // rather than after every single primary write — is what makes
    // the replication asynchronous rather than synchronous.
    fn replicate_from(&mut self, primary_log: &[String]) {
        for entry in &primary_log[self.applied.len()..] {
            self.applied.push(entry.clone());
        }
    }

    // How far behind the primary this replica currently is — the
    // concrete, measurable form of "replication lag."
    fn lag(&self, primary: &Primary) -> usize {
        primary.log.len() - self.applied.len()
    }
}
```

`replicate_from` only appends entries the replica hasn't already
applied, in the same order the primary committed them — a replica can
call it on any schedule (after every write for near-synchronous
behavior, or periodically for looser asynchronous behavior) without
changing the correctness of the result, only how far `lag` can grow
between calls.

## When to use it

- Read volume significantly exceeds what a single instance can serve,
  and most reads can tolerate being served from a replica that's
  slightly behind the primary rather than requiring the absolute latest
  write.
- The dataset must survive the failure of any single node — a promoted
  replica needs to be able to take over serving both reads and writes
  with minimal data loss.
- Write volume comfortably fits on a single primary — replication scales
  reads and durability, not write throughput.

## When not to use it

- Write throughput itself is the bottleneck — replication funnels every
  write through one primary regardless of how many replicas exist, so
  it does nothing to relieve write load; [Sharding](/docs/patterns/storage/sharding)
  is the pattern that addresses that.
- The application cannot tolerate reading stale data under any
  circumstances and can't be restructured to read from the primary for
  that specific case — asynchronous replicas are, by construction,
  sometimes behind, and even synchronous replication only guarantees
  durability, not that every replica has applied a write at the instant
  the primary commits it.
- The operational cost of running and monitoring failover — detecting a
  dead primary, promoting a replica, re-pointing clients, guarding
  against split-brain — isn't justified yet by the system's actual
  availability requirements.

## Use-case scenarios

**Read-heavy content platform.** A news site serves far more article
reads than it accepts article edits. Article writes go to the primary
database; reads for rendering pages are spread across several
asynchronous replicas, multiplying read capacity without touching write
capacity, and a few seconds of replication lag before a fresh edit
appears on a replica-served page is an acceptable trade for the
throughput gained.

**Financial ledger requiring zero write loss.** A payments system
cannot lose an acknowledged transaction under any circumstances, even
if the primary fails immediately after committing it. The system uses
synchronous replication to at least one replica in a different failure
domain — a write isn't acknowledged to the caller until that replica
has confirmed it too — accepting the added write latency as the direct
cost of guaranteeing a promoted replica always has every acknowledged
transaction.

**Multi-region disaster recovery for an internal platform.** A company
runs its primary database in one region and maintains an asynchronous
replica in a second, geographically distant region purely for disaster
recovery, not for everyday read traffic. If the primary region becomes
unreachable, the cross-region replica is promoted to primary; the
system accepts that whatever was in flight but not yet replicated at
the moment of the outage may be lost, in exchange for the primary
region's writes never paying a cross-region round trip in normal
operation.

## Related patterns

- [Sharding](/docs/patterns/storage/sharding) — partitions data across
  machines to scale capacity and write throughput, the complementary
  (not competing) technique to replication's copying of data to scale
  reads and durability; large systems commonly combine both.
- [Failover](/docs/patterns/reliability/failover) — the general pattern
  for detecting a failed primary component and redirecting traffic to a
  standby, applied here specifically to promoting a replica when the
  primary database fails.
- [Leader Election](/docs/patterns/consistency/leader-election) — the
  fencing and single-writer discipline a correct primary promotion
  relies on to avoid two nodes both believing they're the primary at
  once.

## Further reading

- [Replication (computing) — Wikipedia](https://en.wikipedia.org/wiki/Replication_(computing))
- [High availability, load balancing, and replication — PostgreSQL documentation](https://www.postgresql.org/docs/current/high-availability.html)
- [MySQL replication — MySQL 8.0 reference manual](https://dev.mysql.com/doc/refman/8.0/en/replication.html)
- [Geodes pattern — Azure Architecture Center (Microsoft)](https://learn.microsoft.com/en-us/azure/architecture/patterns/geodes)
