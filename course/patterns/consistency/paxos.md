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

## How it works

Paxos assigns nodes to (possibly overlapping) roles — **proposers**,
who suggest values, and **acceptors**, who vote on them — and proceeds
in two phases, both requiring agreement from a majority of acceptors
rather than all of them.

**Phase 1 — Prepare/Promise.** A proposer that wants to get a value
agreed on picks a proposal number higher than any it has used before
and sends a "prepare" request carrying that number to the acceptors.
Each acceptor that receives a prepare request with a number higher
than any it has already responded to promises not to accept any future
proposal with a lower number, and replies with that promise — along
with the highest-numbered proposal it has already accepted, if any.
Once the proposer hears back from a majority of acceptors, it has a
promise from enough of the group to proceed.

**Phase 2 — Accept.** The proposer now sends an "accept" request, with
the same proposal number, to that same majority. Critically, the value
it proposes here isn't necessarily its own preferred value: if any
acceptor's Phase 1 reply reported an already-accepted value, the
proposer must adopt the value from the highest-numbered such report
instead — this is what prevents two different values from both ending
up accepted by a majority. Each acceptor that receives this request
accepts it, unless it has since promised a higher-numbered proposal in
the meantime, in which case it refuses. Once a majority of acceptors
have accepted the same value, that value is chosen — permanently, since
any future proposer that runs Phase 1 against a majority is guaranteed
to see that already-accepted value (any two majorities out of the same
group always overlap by at least one node) and is forced to propose it
again rather than something else.

**Why Paxos is hard.** The two-phase, majority-quorum mechanism above
is the core of "Basic Paxos," which only agrees on a single value once.
Real systems need a continuous stream of agreed values (a replicated
log), which requires running many instances of Paxos and handling
leader election, log gaps, and reconfiguration on top — collectively
"Multi-Paxos" — and the original papers describe that extension only
loosely, leaving a large gap between the elegant core algorithm and a
correct, complete implementation. Corner cases around competing
proposers repeatedly outbidding each other (livelock), recovering
correctly after a crash, and safely changing cluster membership are
notoriously easy to get subtly wrong. This gap between "the algorithm
is simple to state" and "the algorithm is simple to implement
correctly" is widely cited as Paxos's biggest practical weakness, and
it's the specific problem [Raft](/docs/patterns/consistency/raft) was
designed to solve — by structuring the same fault-tolerant guarantees
around an explicit leader and log replication that's much easier to
reason about and implement correctly.

## Code example

The snippet below models a single acceptor's state machine for Basic
Paxos — the promise/accept bookkeeping a real acceptor performs on
each incoming message, independent of any particular transport.

```rust
#[derive(Clone, Copy, PartialEq, PartialOrd, Debug)]
struct ProposalId(u64);

struct Acceptor {
    // Highest proposal number promised so far (Phase 1).
    promised: Option<ProposalId>,
    // Highest proposal accepted so far, with its value (Phase 2).
    accepted: Option<(ProposalId, String)>,
}

impl Acceptor {
    // Phase 1: only promise if this id is higher than anything seen.
    fn on_prepare(&mut self, id: ProposalId) -> Result<Option<(ProposalId, String)>, ()> {
        if self.promised.is_none_or(|p| id > p) {
            self.promised = Some(id);
            Ok(self.accepted.clone())
        } else {
            Err(()) // reject: a higher-numbered prepare already seen
        }
    }

    // Phase 2: only accept if no higher prepare arrived in between.
    fn on_accept(&mut self, id: ProposalId, value: String) -> Result<(), ()> {
        if self.promised.is_none_or(|p| id >= p) {
            self.accepted = Some((id, value));
            Ok(())
        } else {
            Err(()) // reject: promised a higher id since this prepare
        }
    }
}
```

A proposer only proceeds to `on_accept` once `on_prepare` has
succeeded against a majority of acceptors, and must switch its
proposed value to the highest-numbered one already accepted, if
`on_prepare` reports one — that adoption rule is what makes the
protocol safe.

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

## Real-world example

Google's Chubby lock service, which underpins coordination for systems
like Bigtable and GFS, is built on Paxos to keep its replicas
consistent and to elect a master among them. Google Spanner's Paxos
groups similarly use it to replicate each shard of data consistently
across multiple data centers, agreeing on the order of writes to that
shard even as individual replicas fail or fall behind.

## Related patterns

- [Raft](/docs/patterns/consistency/raft) — designed specifically as an
  easier-to-understand alternative that achieves the same fault-tolerant
  agreement via explicit leader election and log replication.
- [Quorum](/docs/patterns/consistency/quorum) — the majority-overlap
  principle Paxos's phases rely on to guarantee safety, used there in
  its simpler form for read/write acknowledgment counts rather than
  full value consensus.

## Further reading

- [Paxos (computer science) — Wikipedia](https://en.wikipedia.org/wiki/Paxos_(computer_science))
- [PAXOS Consensus Algorithm — GeeksforGeeks](https://www.geeksforgeeks.org/computer-networks/paxos-consensus-algorithm/)
