---
title: "Paxos"
sidebar_position: 7
supplementary: true
---

Paxos is a consensus algorithm that gets a group of nodes — any of
which can be slow, crash, or drop messages — to agree on a single
value, correctly and safely, as long as a majority of the nodes remain
reachable.

![Paxos diagram](/img/patterns/paxos.svg)

## Problem it solves

Distributed systems routinely need a set of independent nodes to agree
on one thing — who the leader is, what the next entry in a replicated
log should be, whether a transaction commits — despite messages being
delayed or lost and nodes crashing or restarting at arbitrary times.
Simply having one node broadcast its answer and having everyone accept
it doesn't work: that node might crash mid-broadcast, leaving some
nodes with the value and others without it, or two nodes might each
believe they're in charge and broadcast conflicting values
concurrently. Paxos solves this generally and provably: it guarantees
that the group converges on exactly one agreed value, never two
different ones, and that this holds no matter how messages are
delayed or reordered — the only requirement is that a majority (a
quorum) of nodes are up and can communicate for long enough to
complete the protocol.

## Technical architecture & implementation

Paxos assigns nodes to (possibly overlapping) roles and reaches
agreement through two message rounds, each requiring participation from
a **majority** of acceptors rather than all of them. Understanding it
means understanding three things: the roles, the two phases, and the
single adoption rule that makes the whole thing safe.

**The three roles.** A **proposer** takes a client's desired value and
tries to get it chosen. An **acceptor** is a voter: it responds to
proposers and stores the minimal state (a highest promise, a highest
accepted proposal) that makes the protocol safe. A **learner** is a
node that just needs to find out which value was ultimately chosen so
it can act on it. In practice a single physical node usually plays
several roles at once, but keeping them conceptually separate is what
makes the algorithm's guarantees tractable to reason about.

**Phase 1 — Prepare/Promise.** A proposer picks a proposal number `n`
higher than any it has used before and sends `Prepare(n)` to the
acceptors. Each acceptor that receives a prepare request with a number
higher than any it has already responded to makes a **promise**: it
will reject any future proposal numbered below `n`, and it replies with
that promise plus the highest-numbered proposal it has *already
accepted*, if any. Once the proposer hears promises back from a
majority, it has learned two things — a majority won't undercut it, and
whatever value (if any) might already be on its way to being chosen.

**Phase 2 — Accept/Accepted.** The proposer sends `Accept(n, v)` to
that same majority. Critically, `v` is **not** necessarily its own
preferred value: if any Phase-1 promise reported an already-accepted
value, the proposer *must* adopt the value from the highest-numbered
such report. Each acceptor accepts the request unless it has since
promised a higher-numbered proposal, in which case it refuses. Once a
majority have accepted the same `(n, v)`, `v` is **chosen** —
permanently.

**The adoption rule and why one value is chosen forever.** Safety rests
on a single invariant: *if a value has been chosen, every
higher-numbered proposal that could ever be chosen has that same
value*. It holds because any two majorities of the same set overlap in
at least one acceptor (this is exactly the majority-overlap guarantee
that [Quorum](/docs/patterns/consistency/quorum) is built on). So a
future proposer running Phase 1 against a majority is guaranteed to hear
from at least one acceptor that already accepted the chosen value, and
the adoption rule forces that proposer to re-propose it rather than
something new. A chosen value can therefore never change — the algorithm
converges, it never contradicts itself.

**Proposal numbers must be unique and monotonic.** If two proposers
could pick the same number, an acceptor couldn't tell their messages
apart and the promise/accept bookkeeping would break. Implementations
guarantee uniqueness by partitioning the number space per proposer
(e.g. a round counter in the high bits, a stable proposer id in the low
bits), so every proposal number is globally distinct and each proposer's
numbers strictly increase.

**Safety vs. liveness — dueling proposers.** Paxos guarantees *safety*
(only one value is ever chosen) unconditionally, but it does **not**
guarantee *liveness* on its own. Two proposers can livelock: proposer A
completes Phase 1 with number 5; proposer B then completes Phase 1 with
number 6, invalidating A's promises; A retries with 7, invalidating B's;
and so on forever, with neither ever completing Phase 2. Nothing is
*wrong* — no bad value is chosen — but no progress is made. The standard
fix is to elect a single **distinguished proposer** (a leader) so that,
in the common case, only one proposer is issuing proposals at a time.

**Why Paxos is hard.** Everything above is "Basic Paxos" (also called
Single-Decree Paxos): it agrees on exactly one value, once. Real systems
need a continuous *log* of agreed values, which means running an
instance of Paxos per log slot and layering on leader election, log-gap
filling, and reconfiguration — collectively **Multi-Paxos**. The
original papers specify that extension only loosely, leaving a large gap
between the elegant core and a correct, complete implementation. The
corner cases — livelock, crash recovery, safe membership change — are
notoriously easy to get subtly wrong. This gap between "simple to state"
and "simple to implement correctly" is Paxos's most-cited practical
weakness, and it is precisely what [Raft](/docs/patterns/consistency/raft)
was designed to close.

## Basic Paxos: the two phases

![Basic Paxos two-phase message flow](/img/patterns/paxos-phases.svg)

The two rounds map directly to the diagram above. Phase 1 discovers
whether anything is already in flight and locks out lower-numbered
proposals; Phase 2 commits a value to a majority. The subtlety lives
entirely in the transition between them — the proposer's freedom in
Phase 2 is constrained by what Phase 1 revealed:

- **No accepted value reported** → the proposer is free to push its own
  value. This is the only situation in which a brand-new value enters
  the system.
- **An accepted value reported** → the proposer must abandon its own
  value and re-propose the highest-numbered accepted one, carrying a
  possibly-already-chosen value safely forward.

This is why Paxos is often described as an algorithm that "discovers"
the chosen value rather than one that "decides" it: once a value is on
its way to a majority, the protocol's own rules conspire to keep
proposing it.

## Multi-Paxos: agreeing on a log

Agreeing on a single value is rarely the end goal; systems want an
ordered, replicated **log** of values — command 1, then command 2, and
so on. Multi-Paxos treats each log position as an independent Basic
Paxos instance, but with a crucial optimization: **a stable leader
amortizes Phase 1**.

- **One-time Phase 1.** A leader runs Phase 1 *once* with a high
  proposal number that covers all future log slots, rather than paying
  for a prepare round on every single command.
- **Streamlined Phase 2.** For each new command, the leader skips
  straight to `Accept` for the next log slot. In the steady state,
  committing an entry costs a single round trip to a majority — one
  `Accept`, one `Accepted` — which is what makes Multi-Paxos practical
  for high-throughput replication.
- **Leader as distinguished proposer.** Because only the leader
  proposes, dueling proposers (and their livelock) disappear in the
  common case. If the leader fails, a new proposer runs Phase 1 again,
  learns any half-finished entries via the adoption rule, and takes over
  — the same safety machinery that protects a single value protects the
  whole log across leader changes.

The moment you write "leader," "log," and "take over after failure,"
you have described the *shape* of [Raft](/docs/patterns/consistency/raft):
Raft is, in effect, a Multi-Paxos-class protocol re-derived from the
ground up around an explicit strong leader, so that the log-replication
and leader-handoff mechanics Multi-Paxos leaves implicit become the
concrete, specified center of the algorithm.

## Paxos vs. Raft vs. Two-Phase Commit

These three are frequently confused because all involve "getting
distributed nodes to agree," but only two of them are consensus, and the
distinction is load-bearing:

| Property | Paxos | Raft | Two-Phase Commit |
| --- | --- | --- | --- |
| Problem class | Consensus | Consensus | Atomic commit |
| Agrees on | One value / a log | A replicated log | One transaction's commit/abort |
| Tolerates node failure | Minority may fail | Minority may fail | **Blocks** if coordinator fails |
| Requires unanimity | No — majority quorum | No — majority quorum | **Yes** — every participant must vote |
| Structure | Symmetric proposers/acceptors | Strong single leader | Coordinator + participants |
| Designed for | Provable correctness | Understandability | Cross-database atomicity |

The essential split: **consensus tolerates the failure of a minority and
still makes progress**, because a majority quorum can proceed without the
stragglers. **[Two-phase commit](/docs/patterns/consistency/two-phase-commit)
is not consensus** — it requires *unanimous* agreement and *blocks* the
moment the coordinator fails after participants have voted, holding locks
until it recovers. Paxos and Raft would keep going; 2PC cannot. Reaching
for 2PC when what you actually need is fault-tolerant agreement is a
common and costly mismatch.

## Code example

The snippet below models a single acceptor's state machine for Basic
Paxos — the promise/accept bookkeeping a real acceptor performs on
each incoming message, independent of any particular transport.

```rust
#[derive(Clone, Copy, PartialEq, PartialOrd, Eq, Ord, Debug)]
struct ProposalId(u64);

// A single acceptor's durable state. These two fields are the entire
// memory an acceptor needs to make Basic Paxos safe.
struct Acceptor {
    // Highest proposal number promised in Phase 1.
    promised: Option<ProposalId>,
    // Highest-numbered proposal accepted in Phase 2, with its value.
    accepted: Option<(ProposalId, String)>,
}

impl Acceptor {
    fn new() -> Self {
        Acceptor { promised: None, accepted: None }
    }

    // Phase 1: promise only if `id` beats every number seen so far, and
    // return any value already accepted so the proposer can adopt it.
    fn on_prepare(&mut self, id: ProposalId) -> Result<Option<(ProposalId, String)>, ()> {
        if self.promised.is_none_or(|p| id > p) {
            self.promised = Some(id);
            Ok(self.accepted.clone())
        } else {
            Err(()) // reject: a higher-numbered prepare already promised
        }
    }

    // Phase 2: accept only if no higher prepare arrived in between.
    fn on_accept(&mut self, id: ProposalId, value: String) -> Result<(), ()> {
        if self.promised.is_none_or(|p| id >= p) {
            self.promised = Some(id);
            self.accepted = Some((id, value));
            Ok(())
        } else {
            Err(()) // reject: promised a higher id since this prepare
        }
    }
}

// The proposer's safety-critical rule. After gathering Phase-1 promises
// from a majority, the value it may propose in Phase 2 is the value of
// the highest-numbered already-accepted proposal reported, if any; only
// if none was reported may it propose its own value. This single rule is
// what guarantees a value, once chosen, can never change.
fn value_to_propose(
    promises: &[Option<(ProposalId, String)>],
    own_value: String,
) -> String {
    promises
        .iter()
        .flatten()
        .max_by_key(|(id, _)| *id)
        .map(|(_, v)| v.clone())
        .unwrap_or(own_value)
}
```

`on_accept` refuses any proposal numbered below the acceptor's highest
promise, so a stale proposer can never sneak a value in behind a newer
one. `value_to_propose` encodes the adoption rule: a proposer that hears
*any* already-accepted value from its majority is forced to re-propose
the highest-numbered one rather than its own — which is exactly why a
value that has already reached a majority can never be displaced by a
different one, no matter how proposals interleave.

## When to use it

- A group of nodes must agree on a single value with a strict
  correctness guarantee — never two different accepted values — that
  tolerates the failure of a minority of nodes.
- The system is building foundational consensus infrastructure from
  first principles and needs the flexibility (and is willing to accept
  the complexity) of implementing the core algorithm directly.
- Academic or reference correctness matters more than ease of
  implementation — Paxos's guarantees are extremely well studied and
  proven.

## When not to use it

- A team wants consensus without owning the significant complexity of
  correctly implementing Multi-Paxos's leader election, log
  replication, and reconfiguration — [Raft](/docs/patterns/consistency/raft)
  provides the same fault-tolerant guarantees with a design explicitly
  built to be easier to understand and implement correctly.
- A battle-tested consensus library or coordination service (e.g. one
  built on Paxos or Raft internally) already meets the need — very few
  systems benefit from implementing consensus from scratch.
- The problem only needs a minimum-acknowledgment guarantee for reads
  and writes, not full agreement on an ordered sequence of values —
  [Quorum](/docs/patterns/consistency/quorum) alone is a much simpler
  fit for that narrower need.

## Use-case scenarios

**Distributed lock and coordination service.** Google's Chubby lock
service — which underpins coordination for systems like Bigtable and
GFS — is built on Paxos to keep its handful of replicas consistent and
to elect a master among them. Clients acquire locks and read small
pieces of critical configuration through Chubby; Paxos ensures every
replica agrees on the exact order of those lock acquisitions and
releases, so even if a replica crashes or a network link flaps, no two
clients are ever told they both hold the same exclusive lock.

**Geo-replicated database shards.** Google Spanner replicates each shard
of data across multiple data centers using a Paxos group per shard. The
group agrees on the order of writes to that shard, so a client that
commits a write in one region and a client that reads it in another see
a single, consistent history — and the shard stays available for both as
long as a majority of its replicas (which may span continents) can
communicate, tolerating the loss of any single region's replica.

**Replicated configuration / metadata store.** A cluster manager needs a
small, fiercely consistent store for cluster-wide truth — which node
owns which partition, what the current schema version is. A Paxos-based
replicated state machine holds that metadata: every change is a value
agreed by a majority before it takes effect, so a stale or partitioned
node can never hand a client an out-of-date view that contradicts what
the rest of the cluster has already committed.

## Production libraries & getting started

Paxos is almost never consumed as a drop-in library — it is an algorithm embedded inside larger systems, and most teams that want "consensus as a dependency" reach for Raft instead. The honest landscape is a handful of research/academic implementations plus the production systems that famously run Paxos (or a Paxos variant) internally.

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| libpaxos | C | Reference implementation of Basic/Multi-Paxos from the academic literature; useful for learning and experiments, not a supported product | [Repository](https://bitbucket.org/sciascid/libpaxos) |
| Google Chubby | (system, internal) | Lock service whose replicated database is kept consistent by Multi-Paxos — the canonical "Paxos in production" case study | [Chubby paper (OSDI 2006)](https://research.google/pubs/the-chubby-lock-service-for-loosely-coupled-distributed-systems/) |
| Google Spanner | (managed system) | Globally distributed database that replicates each shard with a Paxos state machine per group | [Spanner docs](https://cloud.google.com/spanner/docs) |
| Apache ZooKeeper (ZAB) | Java | Coordination service using Zab, a Paxos-family atomic broadcast protocol; the widely deployed way to get Paxos-grade agreement without writing it yourself | [ZooKeeper docs](https://zookeeper.apache.org/doc/current/recipes.html) |
| etcd / Raft | Go | The pragmatic default: if you want consensus as a library, teams pick Raft over Paxos — see the [Raft page](/docs/patterns/consistency/raft) | [etcd docs](https://etcd.io/docs/latest/) |

**Example / reference:** [Spanner: Google's Globally-Distributed Database (OSDI 2012)](https://research.google/pubs/spanner-googles-globally-distributed-database-2/)

## Related patterns

- [Raft](/docs/patterns/consistency/raft) — designed specifically as an
  easier-to-understand alternative that achieves the same fault-tolerant
  agreement via an explicit strong leader and log replication; if you
  are building on consensus rather than researching it, Raft is almost
  always the better starting point.
- [Quorum](/docs/patterns/consistency/quorum) — the majority-overlap
  principle Paxos's two phases rely on to guarantee safety, used there in
  its simpler form for read/write acknowledgment counts rather than full
  value consensus.
- [Leader Election](/docs/patterns/consistency/leader-election) — the
  "distinguished proposer" Paxos needs for liveness (and that Multi-Paxos
  relies on to amortize Phase 1) is exactly a leader-election problem;
  the two patterns compose.
- [Two-Phase Commit](/docs/patterns/consistency/two-phase-commit) — an
  *atomic-commit* protocol often mistaken for consensus; unlike Paxos it
  requires unanimity and blocks on coordinator failure rather than
  tolerating a minority failure.
- [Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication) —
  the data-replication layer a Paxos/Multi-Paxos group ultimately drives:
  consensus decides the *order* of writes, replication carries them to
  every copy.
- [Multi-Master Replication](/docs/patterns/consistency/multi-master-replication) —
  the availability-favoring alternative when Paxos's synchronous
  cross-node round trip is too costly for the write path: every node
  accepts writes independently and reconciles conflicts afterward
  instead of agreeing before the write is acknowledged.

## Further reading

- [Paxos (computer science) — Wikipedia](https://en.wikipedia.org/wiki/Paxos_(computer_science))
- [Paxos Made Simple — Leslie Lamport (PDF)](https://lamport.azurewebsites.net/pubs/paxos-simple.pdf)
- [Paxos Made Live: An Engineering Perspective — Google (PDF)](https://static.googleusercontent.com/media/research.google.com/en//archive/paxos_made_live.pdf)
- [PAXOS Consensus Algorithm — GeeksforGeeks](https://www.geeksforgeeks.org/computer-networks/paxos-consensus-algorithm/)
