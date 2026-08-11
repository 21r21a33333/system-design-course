---
title: "Quorum"
sidebar_position: 3
supplementary: true
---

Quorum consistency requires a minimum number of replica nodes to
acknowledge a read or write before the operation counts as successful,
sized so that every read set and every write set are guaranteed to
overlap on at least one node that has the latest value.

![Quorum diagram](/img/patterns/quorum.svg)

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

## Technical architecture & implementation

**Write path.** A client's write is sent to all N replicas
concurrently, not one at a time — sending them sequentially would make
write latency the sum of every replica's response time rather than
just the slowest of the first W to respond, which defeats the purpose
of tuning W for a latency target in the first place. The write is
considered successful the moment W of the N replicas acknowledge it;
the remaining N-W replicas may still be catching up (or briefly
unreachable) without blocking the client, which is what makes W < N
configurations more available than requiring every replica to
acknowledge.

**Read path and version reconciliation.** A read is likewise sent to
(at least) R replicas concurrently, and the coordinator handling the
read waits for R responses before returning. Because different
replicas may hold different versions of the value (some caught up to
the latest write, some lagging), the read has to determine which
response is actually newest — typically via a version number, a
timestamp, or (in systems that need to detect genuinely concurrent,
conflicting writes rather than just picking the latest) a mechanism
like [Vector Clocks](/docs/patterns/consistency/vector-clocks). The
**W + R > N invariant** is what guarantees this comparison is
meaningful at all: because any W-sized write set and any R-sized read
set drawn from the same N nodes must share at least one common node
(the pigeonhole principle — W + R exceeding N means the two sets can't
be fully disjoint), every read is mathematically guaranteed to contact
at least one replica that has the most recent acknowledged write, so
the newest version among the R responses really is the latest one, not
just the latest one that happened to be sampled.

**Tuning W and R.** The choice of W and R relative to N is a genuine
trade-off knob, not just a correctness parameter. W=N, R=1 makes reads
maximally fast and available (any single replica answers) at the cost
of every write needing every replica to be up; W=1, R=N inverts that
trade for fast, available writes at the cost of slow, less available
reads. A balanced majority quorum, W=R = a bit over half of N, splits
the cost between the two operations and additionally tolerates just
under half of N failing while still satisfying both quorums — which is
why it's the most common default when neither reads nor writes are
clearly more latency-sensitive than the other.

**Failure modes.** The most direct failure is choosing **W + R ≤ N**,
which breaks the overlap guarantee entirely — read and write quorums
can then be fully disjoint sets of nodes, so a read can complete
successfully while never contacting the replica that has the latest
write, silently returning stale data with no error to signal it
happened. A second, subtler failure mode is a **sloppy quorum** (used
by some systems during a partition to keep accepting writes by
substituting a healthy-but-non-canonical node for an unreachable one)
trading strict overlap guarantees for availability during the outage —
this is a deliberate, documented trade-off in systems that support it,
but silently changes the consistency guarantee for any operation that
falls back to it, which callers relying on strict quorum overlap need
to be aware of. A third is **clock or version-tag disagreement** across
replicas: if the mechanism used to decide "which response is newest"
is itself unreliable (e.g. relying on wall-clock timestamps that
aren't synchronized), the read can pick the wrong version as "latest"
even though the overlap guarantee correctly delivered the right data
among the R responses.

## Code example

```rust
use std::sync::mpsc;
use std::thread;

#[derive(Clone, Copy, Debug)]
struct VersionedValue {
    version: u64,
    value: u32,
}

struct Replica {
    id: u32,
    stored: VersionedValue,
}

// Sends the write to every replica concurrently and returns once W
// acknowledgments have arrived — not once all N have, which is what
// lets W < N configurations stay available despite a slow or
// unreachable replica among the remaining N - W.
fn quorum_write(replicas: &[Replica], new_value: VersionedValue, w: usize) -> usize {
    let (tx, rx) = mpsc::channel();

    for replica in replicas {
        let tx = tx.clone();
        let id = replica.id;
        thread::spawn(move || {
            // In a real system this would be a network write; here the
            // ack is immediate, but the point is that all N fire at once.
            tx.send(id).expect("channel open");
            let _ = new_value; // would be persisted by this replica
        });
    }
    drop(tx);

    rx.iter().take(w).count()
}

// Reads from R replicas and returns the highest version among them —
// valid only because W + R > N guarantees at least one of these R
// replicas has the most recent acknowledged write.
fn quorum_read(responses: &[VersionedValue]) -> Option<VersionedValue> {
    responses.iter().max_by_key(|v| v.version).copied()
}
```

`quorum_write` fires all N sends concurrently and stops counting once W
acknowledgments arrive, mirroring how a real quorum write doesn't wait
on stragglers beyond the W it needs; `quorum_read` trusts the highest
version number among the R responses it receives specifically because
the W + R > N invariant guarantees one of those R replicas is
guaranteed to hold it.

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

## Use-case scenarios

**Shopping-cart service tuning per-operation consistency.** An
e-commerce platform's shopping-cart service replicates cart state
across 5 nodes. Adding an item to the cart uses a low W (fast,
available writes, since losing a rare concurrent add is low-stakes and
recoverable) while reading the cart at checkout uses a higher R,
trading a little more read latency for a much stronger guarantee that
checkout sees every item the customer actually added — the same
underlying replica set, tuned differently per operation based on which
one's correctness matters more.

**IoT sensor telemetry system prioritizing write availability.** A
fleet-tracking platform ingests location pings from thousands of
vehicles into a replicated store with N=3 per shard. Writes use W=1 so
ingestion never stalls even if two of the three replicas in a shard are
temporarily unreachable — losing a small amount of read freshness is
acceptable for a live-tracking dashboard that refreshes every few
seconds anyway, and the low W keeps write throughput high under heavy,
continuous ingestion load.

**Distributed configuration store requiring strong read guarantees.**
A feature-flag service used to gate a payment-critical code path
replicates its flag values across 5 nodes with a majority quorum,
W=R=3. Because a stale read here could mean a payment path runs with
an outdated flag value, the service accepts the extra latency of
contacting 3 replicas on every read in exchange for the mathematical
guarantee that any read quorum overlaps any prior write quorum,
ensuring a flag flip is visible to every subsequent read once the write
that made it has been acknowledged.

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
- [Dynamo: Amazon's Highly Available Key-value Store — DeCandia et al. (SOSP 2007)](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf) — the original source for tunable R/W/N quorums, sloppy quorums, and hinted handoff.
