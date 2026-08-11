---
title: "Leader Election"
sidebar_position: 9
supplementary: true
---

Leader election is the general problem of getting a group of
equivalent, independently running nodes to agree that exactly one of
them is "the leader" for some duration — the node responsible for a
piece of coordination work the rest defer to — and to detect when that
leader is gone and pick a new one, without any node being told in
advance which one it will be.

![Leader Election diagram](/img/patterns/leader-election.svg)

## Problem it solves

Some jobs are actively wrong to run more than once at a time: assigning
the next ID in a sequence, running a scheduled cleanup task, deciding
the order writes are applied in. Running that job on every node
independently produces duplicate IDs, duplicate cleanup runs, or
conflicting write orders — the job needs exactly one owner at a time.
The naive fix, hard-coding one specific node as "the one that does it,"
works until that node crashes, at which point the job simply stops
running, forever, because nothing else was ever told it could take
over. Leader election solves the general version of this problem: it
gives the group a way to designate a single owner dynamically, and —
critically — a way to notice that owner is gone and designate a
replacement automatically, so the coordination role survives the
failure of whichever specific node was holding it.

## Technical architecture & implementation

**The core mechanism.** Every practical leader election scheme reduces
to the same two ingredients: a way for one node to become leader that
every other node agrees to honor, and a way to detect that the leader
is no longer functioning so a new election can start. The first is
usually implemented as a lease or lock held in some shared, strongly
consistent store (a coordination service, or a row in a database with a
uniqueness constraint) — a node acquires the lease, and as long as it
holds it, every other node treats it as leader and defers to it. The
second is usually a heartbeat or lease-expiry mechanism: the leader
must periodically renew its lease before it expires, and if it fails to
— because it crashed, hung, or got network-partitioned away from the
coordination store — the lease expires and any node still able to
reach the store can now acquire it and become the new leader.

**Split-brain — the central failure mode.** The mechanical risk in
every leader election implementation is two nodes simultaneously
believing they are leader — split-brain — and both acting on that
belief at once, which for many of the jobs leader election exists to
protect (assigning sequence numbers, ordering writes) is exactly as bad
as having no leader election at all. This can happen if a leader is
merely slow or network-partitioned rather than actually dead: from the
rest of the cluster's point of view a partitioned leader looks
identical to a crashed one, so the lease can legitimately expire and a
new leader be elected while the original leader — unaware it's been
replaced, because the partition also stops it from seeing lease-expiry
traffic — keeps acting as leader on the other side of the partition. A
correct implementation defends against this with **fencing**: every
lease carries a monotonically increasing term or epoch number, and
anything the leader does downstream (a write to a database, a command
to a worker) must be tagged with that epoch and rejected by the
downstream system if a higher epoch has since been seen — so even if a
stale leader keeps issuing commands after losing its lease, those
commands are refused rather than silently corrupting state alongside
the new leader's.

**Leader Election vs. Raft/Paxos.** This is the most important
distinction on this page, because [Raft](/docs/patterns/consistency/raft)
and [Paxos](/docs/patterns/consistency/paxos) both *contain* a leader
election step and it's easy to conflate the general pattern with those
specific protocols. Leader election is the general-purpose problem
statement — pick one owner, detect its failure, pick a new one — and it
can be solved with mechanisms far simpler than a consensus protocol:
a single lock row in a relational database with a `SELECT ... FOR
UPDATE` and a TTL, for instance, is a legitimate (if less robust)
leader election implementation with no consensus algorithm involved at
all. Raft and Paxos solve a strictly harder, more specific problem —
getting a cluster to agree, with a formal safety proof, on an ordered
replicated log despite arbitrary message delay and node failure — and
Raft's particular leader election sub-step (randomized timeouts,
term numbers, majority vote) is one rigorously specified way to solve
leader election as a byproduct of solving that harder problem. Put
plainly: every Raft cluster does leader election, but not every leader
election needs Raft. Reach for a full consensus protocol when the
leader's decisions must be part of a provably consistent, ordered log
that survives partitions with formal guarantees; reach for a simpler
lease-based leader election when the requirement is just "exactly one
worker runs this job at a time" and the coordination store (not the
election logic itself) is already trusted to be consistent.

## Code example

```rust
use std::time::{Duration, Instant};

struct LeaseStore {
    // The current lease holder's id and the epoch it was granted at,
    // if any. In a real system this lives in a shared, strongly
    // consistent store — not in a single process's memory.
    holder: Option<(u64, u64)>,
    epoch: u64,
    expires_at: Option<Instant>,
}

impl LeaseStore {
    // A node can only acquire the lease if it's unclaimed or expired.
    // Acquiring bumps the epoch, so any commands tagged with an older
    // epoch can be recognized as stale and fenced off downstream.
    fn try_acquire(&mut self, node_id: u64, now: Instant, ttl: Duration) -> Option<u64> {
        let expired = self.expires_at.is_none_or(|exp| now >= exp);
        if expired {
            self.epoch += 1;
            self.holder = Some((node_id, self.epoch));
            self.expires_at = Some(now + ttl);
            Some(self.epoch)
        } else {
            None
        }
    }

    // The leader must renew before expiry or lose the lease to
    // whichever node next calls try_acquire.
    fn renew(&mut self, node_id: u64, epoch: u64, now: Instant, ttl: Duration) -> bool {
        match self.holder {
            Some((holder, held_epoch)) if holder == node_id && held_epoch == epoch => {
                self.expires_at = Some(now + ttl);
                true
            }
            _ => false, // no longer the leader — someone else was elected
        }
    }
}
```

`try_acquire` only succeeds when the lease is unclaimed or has expired,
and every successful acquisition gets a strictly higher `epoch` — a
downstream system that rejects commands tagged with an epoch lower than
the highest it has seen is what turns this lease into a fencing
mechanism, not just an advisory lock.

## When to use it

- Exactly one node in a fleet of otherwise-identical workers must
  perform a piece of coordination work — running a scheduled job,
  issuing sequence numbers, driving a background compaction — and the
  role must transfer automatically if that node fails.
- The coordination store backing the lease (a coordination service, or
  a database) is already trusted to be strongly consistent, so leader
  election can be built as a lease against it rather than as a
  from-scratch consensus protocol.
- Downstream actions taken by the leader can be tagged with an epoch or
  term number, so a stale leader that hasn't yet noticed it lost its
  lease can be fenced off rather than silently causing split-brain.

## When not to use it

- The job in question is naturally idempotent and safe to run
  concurrently from multiple nodes — leader election adds a moving part
  and a failure mode (split-brain, election churn) for a coordination
  guarantee the workload doesn't actually need.
- The system needs a full, provably consistent replicated log across
  partitions and node failures, not just "one worker owns this job" —
  that calls for [Raft](/docs/patterns/consistency/raft) or
  [Paxos](/docs/patterns/consistency/paxos) directly, which specify
  leader election as part of a much stronger overall guarantee.
- There's no reliable fencing mechanism available downstream of the
  leader, and the actions a stale leader could still take after losing
  its lease would be destructive — in that situation a simple lease
  without fencing is actively dangerous, not just imperfect.

## Use-case scenarios

**Distributed cron in a job-scheduling platform.** A fleet of worker
processes all run the same scheduling code so any of them can pick up
work, but a recurring nightly report must run exactly once, not once
per worker. One worker acquires a lease keyed by the job's name before
running it; every other worker that also wakes up to run that job finds
the lease already held and skips it. If the leader crashes mid-run, its
lease expires and the next worker to check picks up the job on the
following cycle.

**Primary selection in a self-managed database cluster.** A cluster of
database replicas needs exactly one of them accepting writes at a time.
The replicas run a lease-based election against an external
coordination store to decide which one is primary; the elected primary
renews its lease continuously, and every write path checks the current
epoch against what it was tagged with, so a former primary that hasn't
yet noticed a network partition has ended can't have its writes
accepted alongside the newly elected primary's.

**Partition ownership in a stream-processing cluster.** A
stream-processing system splits a topic into partitions, and each
partition must be consumed by exactly one worker at a time to preserve
per-partition ordering. Each partition has its own lease; workers
compete to acquire leases for unassigned or expired partitions, so if a
worker holding several partitions crashes, those specific partitions
are picked up by surviving workers within one lease TTL, without a
central scheduler having to detect the failure and manually reassign
work.

## Related patterns

- [Raft](/docs/patterns/consistency/raft) — a specific consensus
  protocol that includes leader election as one rigorously specified
  part of a much stronger guarantee (a provably consistent replicated
  log); use Raft when the leader's output itself must be part of that
  formally verified log, not just when a single job owner is needed.
- [Paxos](/docs/patterns/consistency/paxos) — the earlier, more general
  consensus algorithm Raft's leader election was designed to be an
  easier-to-implement alternative to; the same relationship to plain
  leader election applies.
- [Sequencer](/docs/patterns/building-blocks/sequencer) — a common
  downstream consumer of leader election: the elected leader is
  frequently the node that acts as the sequencer, issuing ordered IDs
  or timestamps as long as it holds the lease.

## Further reading

- [Leader Election pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/leader-election)
- [Leader election — Wikipedia](https://en.wikipedia.org/wiki/Leader_election)
- [The Chubby lock service for loosely-coupled distributed systems — Mike Burrows, Google (OSDI 2006)](https://research.google/pubs/the-chubby-lock-service-for-loosely-coupled-distributed-systems/) — the canonical description of lease-based leader election and locking backed by a consensus-replicated store.
