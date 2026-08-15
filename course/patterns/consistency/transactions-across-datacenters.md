---
title: "Transactions Across Datacenters"
sidebar_position: 11
supplementary: true
---

Running a read-write, user-facing datastore out of a single datacenter is
comparatively easy; the moment you try to run it out of more than one,
every consistency and transaction guarantee you took for granted is back
up for negotiation. This page condenses Ryan Barrett's 2009 Google I/O
talk on exactly that problem — grounded in real choices the Google App
Engine datastore team made — into the five techniques for multihoming a
datastore, what each one actually costs, and why the "obviously correct"
technique (full transactional consistency everywhere) is usually not the
one real systems pick.

![Comparing the five cross-datacenter replication techniques by consistency support versus write-latency cost](/img/patterns/transactions-across-datacenters.svg)

## Why running one datacenter isn't enough — and why multihoming isn't free

Two different kinds of failure push a system toward more than one
datacenter. **Catastrophic failure** is the dramatic version — fire, a
sustained power outage, a natural disaster — rare, but total while it
lasts. **Expected failure** is the mundane version that happens far more
often: routine hardware attrition across a large enough fleet, and
planned maintenance that takes some piece of the datacenter offline on
purpose. Neither is optional to plan for once a service is large enough
that "wait for it to come back" is an unacceptable answer. A third,
non-failure reason is **geolocality**: physical distance imposes a real
speed-of-light floor on latency — a coast-to-coast round trip across the
continental US is roughly 30ms of pure propagation delay before any
routing or queuing overhead, and that number only grows for genuinely
distant users. Serving from a datacenter near your users is a direct way
to cut that floor.

None of this is free, though. Bandwidth and connectivity between
datacenters is far more constrained and far more expensive than bandwidth
inside one, and cross-datacenter latency is an order of magnitude higher
than intra-datacenter latency. Every technique below is really a
different answer to the same question: how much of that cost are you
willing to pay, and when — on every write, or only in the background?

For the underlying vocabulary — weak, eventual, and strong consistency —
see [Consistency Patterns](/docs/concepts/consistency-patterns); this page
assumes that background and focuses on the *mechanisms* that get you each
level across datacenters specifically.

## Five techniques, evaluated the same way

The talk evaluates every technique on the same four axes, and it's worth
naming them up front because no technique wins on all four:

1. **Consistency & transaction support** — after a write succeeds, what can a reader in another datacenter rely on?
2. **Latency & throughput cost** — does adding this technique slow down every write, or does it stay off the hot path?
3. **Data-loss window** — if a datacenter is destroyed right now, how much recent data is gone for good?
4. **Failover behavior** — when a datacenter has to be taken down (planned or not), do the others keep serving writes, or go read-only?

| Technique | Consistency | Latency cost | Data-loss window | Failover |
| --- | --- | --- | --- | --- |
| Backups | Weak (unless snapshotted at a consistent point) | None — fully offline | Everything since the last backup | Restore from backup; downtime during restore |
| [Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication) | Strong at the primary, eventual at replicas | Low — async, off the write's hot path | Small: whatever hadn't replicated yet | Replicas go read-only until a new primary is promoted |
| [Multi-Master Replication](/docs/patterns/consistency/multi-master-replication) | Eventual, with conflict reconciliation | Low — async, off the write's hot path | Small, per-master | Every master keeps serving reads *and* writes |
| [Two-Phase Commit](/docs/patterns/consistency/two-phase-commit) | Strong, real cross-datacenter transactions | High — synchronous, ~2 cross-datacenter round trips per write | None for committed writes | Needs *n*+1 datacenters so one can go down without stalling commits |
| [Paxos](/docs/patterns/consistency/paxos) | Strong, real cross-datacenter agreement | High — synchronous, but better throughput than 2PC (no single coordinator serializing every write) | None for committed writes | Tolerates losing a minority of datacenters outright |

### Backups — the sledgehammer

The simplest possible answer: periodically copy everything, store the
copy somewhere else. It's entirely offline, so it doesn't touch your live
system's latency or throughput at all — but a full copy of a large
dataset can take hours, and unless the copy is taken from a single
consistent snapshot (by timestamp or version), a backup made while writes
are still landing can itself lose transactional consistency: read one
side of a transfer early in the backup window and the other side late,
and the backup captures a state that never actually existed. Backups are
necessary regardless of which other technique you pick — they're the only
defense against a bug that corrupts data rather than a datacenter that
disappears — but they're a baseline, not a substitute for a live
multihoming strategy.

### Primary-Replica Replication — asynchronous, one writer

See [Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication)
for the full mechanism. One datacenter's primary accepts every write;
replicas in other datacenters replicate asynchronously in the background
and can serve reads. Because replication doesn't block the write path,
this preserves close to single-datacenter latency and throughput. The
trade-off shows up on failover: the other datacenters can serve reads
immediately, but not writes, until a replica is promoted to primary and
every client is confirmed to be pointed at it — during that window, the
system is read-only.

### Multi-Master Replication — asynchronous, every writer

See [Multi-Master Replication](/docs/patterns/consistency/multi-master-replication)
for the full mechanism. Every datacenter accepts writes locally instead of
forwarding them to one primary, so there's no read-only window during
failover — every master just keeps going. The cost is that two datacenters
can accept conflicting writes to the same record before either learns
about the other's write, and the best consistency level achievable is
eventual, not strong, because there's no way to offer a real transaction
across masters that aren't coordinating in real time.

### Two-Phase Commit — synchronous, strong, and a bottleneck

See [Two-Phase Commit](/docs/patterns/consistency/two-phase-commit) for the
full mechanism. This is the first technique on this list that's genuinely
*online*: a write reports success or failure to the caller only after
every participating datacenter has durably prepared it, and the
coordinator has confirmed all of them agree. That gives real
cross-datacenter transactional atomicity — a write either lands in every
participating datacenter or none of them — at the cost of roughly two
full cross-datacenter round trips added to every write's latency, and a
coordinator that every transaction in that set serializes through. The
often-repeated story about NASDAQ makes the latency budget concrete: two
datacenters running two-phase commit across a dedicated 27-mile run of
fiber, engineered specifically to keep the round trip under the two-to-
three-millisecond window the protocol needed to stay usable — a reminder
that "just add two-phase commit" is really a statement about physical
distance and dedicated infrastructure, not only software.

### Paxos / Consensus — synchronous, strong, and distributed

See [Paxos](/docs/patterns/consistency/paxos) for the full mechanism.
Paxos targets the same strong-consistency goal as two-phase commit, but
without a fixed per-transaction coordinator: a write only needs agreement
from a *majority* of participating datacenters, not all of them, and
because there's no single node every transaction funnels through, multiple
Paxos rounds can run concurrently instead of serializing through one
coordinator — meaningfully better throughput than 2PC. The latency cost is
the same order of magnitude, though: agreement is still synchronous,
still roughly two cross-datacenter round trips, so nothing here escapes
the fundamental cost of getting multiple datacenters to agree before
telling the caller a write succeeded.

## Code example

```rust
#[derive(Debug, PartialEq)]
enum Strategy {
    PrimaryReplica,
    MultiMaster,
    TwoPhaseCommit,
    Paxos,
}

// Picks a starting-point cross-datacenter replication strategy along the
// same axes the talk evaluates every technique on: does the workload need
// real strong consistency (a cross-datacenter transaction), can the write
// path absorb a synchronous cross-datacenter round trip, how many
// datacenters participate, and does every datacenter need to accept writes
// locally rather than forwarding them to one writer.
fn choose_replication_strategy(
    needs_strong_consistency: bool,
    every_datacenter_must_accept_writes: bool,
    write_latency_budget_ms: u32,
    datacenter_count: usize,
) -> Strategy {
    // Strong consistency is only available synchronously, and only if the
    // latency budget can absorb a cross-datacenter round trip -- wanting
    // Paxos doesn't change the fact that a sub-100ms write budget can't
    // afford one, which is exactly the constraint that pushed Google App
    // Engine's datastore to primary-replica despite wanting Paxos.
    if needs_strong_consistency && write_latency_budget_ms >= 150 {
        return if datacenter_count > 2 {
            Strategy::Paxos
        } else {
            Strategy::TwoPhaseCommit
        };
    }
    // Otherwise every option left on the table is asynchronous, so the
    // choice is purely about who's allowed to accept a write locally.
    if every_datacenter_must_accept_writes {
        Strategy::MultiMaster
    } else {
        Strategy::PrimaryReplica
    }
}
```

The important branch is the first one: wanting strong consistency isn't
enough to justify a synchronous protocol if the write-latency budget can't
absorb one — `needs_strong_consistency` alone doesn't select Paxos or 2PC,
it only does so *jointly* with a latency budget of 150ms or more. That's
not an arbitrary threshold; it's the same conclusion App Engine's own team
reached in production, covered next.

## A real system, compressed: how Google App Engine actually chose

App Engine's datastore team evaluated all five techniques above for
real, against a concrete existing write-latency budget: single-digit to
low tens of milliseconds per write, competing directly against relational
databases running one machine away from the application server. Two-phase
commit and Paxos both would have given them real cross-datacenter
transactions — precisely the property they say they wanted most — but both
would have pushed every write's latency up to roughly 150–250ms, an order
of magnitude past what they'd committed to. No version of "trust us, it's
worth it" was going to be credible against that gap. So the datastore
ships on **primary-replica replication** across datacenters: asynchronous,
one designated master, replicas serving reads and taking over as master on
failover after a brief read-only window. It's a deliberate trade —
weaker cross-datacenter guarantees than Paxos would give, bought back with
latency the product couldn't have shipped without.

That doesn't mean Paxos went unused — it's just not on the hot per-write
path. App Engine runs Paxos internally for exactly the coordination tasks
where paying a couple of round trips is cheap relative to how rarely it
happens: a distributed lock service used heavily across Google
infrastructure, and moving an application's serving state from one
datacenter to another. The lesson generalizes past this one system: strong
cross-datacenter agreement is worth its cost when it happens rarely and
the cost of getting it wrong is high, and worth avoiding when it would sit
on every single write a user is waiting on. As the talk's own conclusion
puts it, there's no fully "green" row in the comparison table above — every
technique is a genuine trade-off, and the right one depends on what your
specific application can't afford to lose.

## Related patterns

- [Multi-Master Replication](/docs/patterns/consistency/multi-master-replication) —
  the full mechanism behind the asynchronous, every-datacenter-writes
  technique summarized above.
- [Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication) —
  the full mechanism behind the asynchronous, single-writer technique App
  Engine's datastore actually ships on.
- [Two-Phase Commit](/docs/patterns/consistency/two-phase-commit) and
  [Paxos](/docs/patterns/consistency/paxos) — the two synchronous,
  strongly-consistent techniques, and the coordinator-vs-quorum trade-off
  between them.
- [Consistency Patterns](/docs/concepts/consistency-patterns) — the weak/
  eventual/strong vocabulary this page's comparison table is built on.
- [Availability vs. Consistency](/docs/concepts/availability-vs-consistency) —
  the CAP-theorem framing behind why every technique above trades one for
  the other rather than offering both for free.

## Source(s) and further reading

- [Transactions Across Datacenters — Google I/O 2009 (Ryan Barrett)](https://www.youtube.com/watch?v=srOgpXECblk) — the original talk this page condenses
- [Transactions across datacenters — snarfed.org](http://snarfed.org/transactions_across_datacenters_io.html) — Ryan Barrett's own companion write-up for the talk
- [CAP twelve years later: How the "rules" have changed — Eric Brewer](https://www.infoq.com/articles/cap-twelve-years-later-how-the-rules-have-changed/) — the CAP-theorem framing the talk opens with, revisited by its own author
