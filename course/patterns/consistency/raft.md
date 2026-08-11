---
title: "Raft"
sidebar_position: 8
supplementary: true
---

Raft is a consensus algorithm that gets a cluster of nodes to agree on
a replicated log — and stay in agreement despite node failures — by
first electing a single leader and then having that leader drive all
log replication, a structure chosen specifically to be easier to
understand and implement correctly than Paxos.

![Raft diagram](/img/patterns/raft.svg)

## Problem it solves

[Paxos](/docs/patterns/consistency/paxos) proves that consensus among
unreliable, asynchronous nodes is achievable, but its core algorithm
only agrees on a single value, and extending it to the continuous
replicated log real systems need (Multi-Paxos) is notoriously
under-specified and difficult to implement correctly — competing
proposers, crash recovery, and cluster membership changes are all
easy to get subtly wrong in a from-scratch Paxos implementation. Raft
was designed from the outset to solve the exact same problem —
fault-tolerant agreement on an ordered log, tolerating the failure of
a minority of nodes — while being *understandable*: its authors
explicitly decomposed the problem into separable, more intuitive
pieces so that engineers could implement it correctly without first
becoming distributed-systems researchers.

## How it works

Raft separates consensus into two connected mechanisms: electing a
leader, and having that leader replicate a log to the rest of the
cluster.

**Roles.** Every node is in exactly one of three states at a time.
A **leader** is the single node that accepts client requests, appends
them to its own log, and replicates those entries to the rest of the
cluster — in normal operation there is exactly one. A **follower** is
a passive node that accepts log entries and leader heartbeats and
otherwise does nothing on its own initiative. A **candidate** is the
transient state a follower enters when it decides an election is
needed, in order to try to become the new leader.

**Leader election.** The leader periodically sends heartbeat messages
to every follower to assert that it's still alive. Each follower
resets a randomized election timeout on every heartbeat it receives;
if that timeout elapses with no heartbeat — because the leader crashed
or the network partitioned it away — the follower assumes the leader
is gone, transitions to candidate, increments a term counter, votes
for itself, and requests votes from every other node. A candidate that
collects votes from a majority of the cluster becomes the new leader
for that term and starts sending its own heartbeats; a node that
receives a vote request only grants its vote if it hasn't already
voted for someone else in that term and the candidate's log is at
least as up to date as its own, which keeps a node with stale data
from being elected. The timeout being **randomized** (rather than
fixed) per node is what keeps this reliable at scale: if every
follower's timeout were identical, many nodes would time out
simultaneously and split the vote repeatedly with no majority forming;
randomizing means, with high probability, one follower's timer fires
first, it requests votes before any other candidate emerges, and the
election resolves cleanly in a single round.

**Log replication.** Once elected, the leader is the sole entry point
for new log entries: a client request becomes a new entry appended to
the leader's log, which the leader then sends to every follower.
Once a majority of nodes (leader included) have durably stored an
entry, the leader considers it *committed* and applies it to its own
state machine, and followers apply it once they learn it's committed
(on the next heartbeat or append). This majority-acknowledgment
requirement is the same core safety mechanism
[Quorum](/docs/patterns/consistency/quorum) relies on — a committed
entry is guaranteed to survive the failure of any minority of nodes,
since any future leader election requires a majority vote, and that
majority necessarily overlaps with the majority that had the
committed entry. If the leader fails, one of the followers is elected
in its place through the same election mechanism, and the cluster
continues with a new term.

## Code example

The snippet below models the follower side of leader election: a
randomized timeout that resets on every heartbeat, and fires into a
candidacy attempt when the leader goes quiet.

```rust
use std::time::{Duration, Instant};

#[derive(PartialEq, Debug)]
enum Role {
    Follower,
    Candidate,
    Leader,
}

struct RaftNode {
    role: Role,
    term: u64,
    voted_for: Option<u64>,
    last_heartbeat: Instant,
    // Randomized per node so timeouts don't fire in lockstep and
    // split every election — this is what makes elections converge.
    election_timeout: Duration,
}

impl RaftNode {
    fn on_heartbeat(&mut self, leader_term: u64) {
        if leader_term >= self.term {
            self.term = leader_term;
            self.role = Role::Follower;
            self.last_heartbeat = Instant::now();
        }
    }

    // Called on a periodic tick; starts an election once the
    // randomized timeout has elapsed with no heartbeat seen.
    fn tick(&mut self, now: Instant) {
        if self.role != Role::Leader
            && now.duration_since(self.last_heartbeat) > self.election_timeout
        {
            self.role = Role::Candidate;
            self.term += 1;
            self.voted_for = Some(self.term); // votes for itself
            // In a full implementation: send RequestVote to peers,
            // and become Leader on receiving a majority of votes.
        }
    }
}
```

Each node's `election_timeout` is drawn independently from a range
(commonly 150-300ms); that spread is the whole mechanism that keeps
elections from repeatedly splitting when a leader disappears.

## When to use it

- A cluster needs a strongly consistent, ordered, replicated log —
  configuration state, a replicated database's write-ahead log,
  cluster membership — that survives the failure of a minority of
  nodes.
- The team wants an implementable, well-documented consensus algorithm
  without owning the complexity of a from-scratch Paxos
  implementation.
- A single leader driving all writes is an acceptable trade-off — the
  workload doesn't need multiple nodes accepting writes concurrently.

## When not to use it

- The workload needs multiple nodes to accept writes concurrently
  without funneling everything through one leader — Raft's
  single-leader design makes the leader a throughput ceiling and, until
  a re-election completes, a temporary unavailability point for writes.
- Only a minimum-acknowledgment guarantee is needed for simple
  reads/writes, not full ordered-log agreement — plain
  [Quorum](/docs/patterns/consistency/quorum) reads/writes are simpler
  and sufficient.
- Extremely wide-area deployments where heartbeat and election
  round-trip latency across regions would make elections slow or
  leader heartbeats a chatty, latency-sensitive liability.

## Real-world example

etcd, the strongly consistent key-value store Kubernetes uses for all
of its cluster state, uses Raft to replicate every write across its
member nodes and to elect a new leader automatically if the current
one fails. HashiCorp Consul similarly uses Raft to keep its service
catalog and configuration data consistent across the servers in a
Consul cluster, electing a leader the same way to serialize writes to
that replicated state.

## Related patterns

- [Paxos](/docs/patterns/consistency/paxos) — the earlier consensus
  algorithm Raft was explicitly designed to be a more understandable,
  more implementable alternative to, while providing the same
  fault-tolerant agreement guarantees.
- [Sequencer](/docs/patterns/building-blocks/sequencer) — leader
  election, as used in Raft, is the same underlying idea a centralized
  ID-issuing sequencer relies on: a single, currently-agreed-upon
  authority coordinating an ordered stream, elected or assigned rather
  than contended for on every operation.

## Further reading

- [Raft (algorithm) — Wikipedia](https://en.wikipedia.org/wiki/Raft_(algorithm))
- [Raft Consensus Algorithm — GeeksforGeeks](https://www.geeksforgeeks.org/system-design/raft-consensus-algorithm/)
