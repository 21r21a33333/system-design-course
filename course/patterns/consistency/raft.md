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

## Technical architecture & implementation

Raft's central design bet is *decomposition*: instead of one dense
protocol, it splits consensus into three separable sub-problems —
**leader election**, **log replication**, and **safety** — that can each
be reasoned about mostly on their own. A strong single leader ties them
together: at any moment there is at most one leader, and all log flow
runs through it.

**Roles.** Every node is in exactly one of three states. A **leader**
accepts client requests, appends them to its own log, and replicates
them to everyone else — in normal operation there is exactly one. A
**follower** is passive: it accepts log entries and heartbeats and does
nothing on its own initiative. A **candidate** is the transient state a
follower enters when it decides an election is needed and tries to
become leader.

**Terms as a logical clock.** Raft divides time into **terms**, each a
consecutive integer. Every term begins with an election; a term has at
most one leader (or none, if an election splits). Every message carries
its sender's term, and terms impose a total order on events without any
physical clock: a node that sees a higher term than its own immediately
steps down to follower and adopts that term, and any message from a
*stale* (lower) term is rejected outright. This one rule — higher term
wins, lower term is ignored — is how Raft detects and defers to a newer
leader and discards the authority of a superseded one.

**Leader election.** The leader periodically sends **heartbeats** (empty
`AppendEntries`) to assert it is alive. Each follower resets a
randomized **election timeout** on every heartbeat; if that timeout
elapses with no heartbeat — the leader crashed or was partitioned away —
the follower becomes a candidate, increments its term, votes for itself,
and sends `RequestVote` to every peer. A candidate that collects votes
from a **majority** becomes leader for that term and starts its own
heartbeats. A voter grants its vote only if it hasn't already voted in
that term *and* the candidate's log is at least as up-to-date as its own
(the election restriction, below). **Randomizing** the timeout per node
is what makes this converge: identical timeouts would make many
followers time out at once and split the vote repeatedly; a random
spread means one timer usually fires first, that node canvasses votes
before any rival emerges, and the election resolves in a single round.

**Log replication.** Once elected, the leader is the sole entry point
for writes. A client request becomes a new entry — carrying the current
term and the command — appended to the leader's log, which the leader
then pushes to every follower via `AppendEntries`. Once a **majority**
(leader included) have durably stored an entry, the leader marks it
**committed**, advances its `commitIndex`, and applies the command to
its state machine; followers apply it once they learn it is committed
(piggybacked on the next `AppendEntries`). This majority-acknowledgment
requirement is the same overlap guarantee
[Quorum](/docs/patterns/consistency/quorum) relies on: a committed entry
survives any minority failure, because any future election needs a
majority vote and that majority necessarily overlaps the majority that
stored the entry.

**Safety — Log Matching and the election restriction.** Two properties
keep logs from diverging. The **Log Matching property**: if two logs
contain an entry at the same index and term, then the logs are identical
in all entries up to that index. `AppendEntries` enforces it by
including the (index, term) of the entry *preceding* the ones it sends;
a follower rejects the append if that preceding entry doesn't match,
prompting the leader to walk back and re-send until the logs align, then
overwrite any conflicting tail. The **election restriction** protects
already-committed entries: a candidate only wins if its log is at least
as up-to-date as a voting majority's (higher last term wins; on a tie,
the longer log wins). Since a committed entry sits on a majority, and
any winning candidate must be at least as up-to-date as some node in
every majority, **a candidate missing a committed entry can never
win** — committed entries are never lost across leader changes.

**Committing entries from previous terms.** A subtle rule: a leader may
*not* consider an entry from an *earlier* term committed just because it
is now stored on a majority — doing so was shown to be unsafe, because a
later leader could still overwrite it. Instead, a new leader commits
old-term entries *indirectly*: it replicates a fresh entry from its
**current** term, and once that current-term entry commits on a
majority, the Log Matching property carries all preceding entries
(including the old-term ones) to committed status with it. This is one
of the most easily-missed correctness details in Raft, and getting it
wrong reopens the exact log-loss hole the algorithm exists to close.

**Membership changes (joint consensus).** Changing the cluster's node
set is dangerous if handled naively: if some nodes switch to the new
configuration before others, two disjoint majorities could form and
elect two leaders. Raft avoids this with **joint consensus** — a
transitional configuration in which decisions require a majority of
*both* the old and the new node sets simultaneously, so no split is
possible during the switchover. The cluster commits into the joint
configuration, then commits out of it into the new one, never leaving a
window where the old and new majorities don't overlap.

**Failure modes.** A **split vote** (two candidates each get some votes,
neither a majority) simply times out and retries — randomized timeouts
make a repeat split unlikely. A **leader crash** stops heartbeats,
triggers a follower timeout, and elects a replacement in a new term; the
new leader reconciles any followers whose logs diverged via the Log
Matching back-off. A **partitioned old leader** on the minority side
keeps trying to replicate but can never reach a majority, so it commits
nothing; when the partition heals it sees the higher term of the new
leader and steps down, discarding its uncommitted tail.

## Leader election and terms

![Raft leader election with randomized timeouts](/img/patterns/raft.svg)

The election path in the diagram above is the whole of Raft's
availability story. Because writes flow only through the leader, the
cluster is briefly unavailable for writes during an election — the
window from the leader's failure to a successor's victory. Raft keeps
that window small and bounded:

- **Detection is a timeout, not a probe.** Followers don't actively
  health-check the leader; they simply notice the *absence* of
  heartbeats. Tune the timeout range (commonly 150–300ms) against your
  network's round-trip time and jitter: too low and transient delays
  trigger needless elections; too high and recovery drags.
- **One leader per term, enforced by votes.** A node votes at most once
  per term, so two candidates cannot both amass a majority in the same
  term — the majority-quorum overlap makes a double election impossible.
- **Terms make stale leaders harmless.** A revived or unpartitioned old
  leader carries an old term; the first higher-term message it sees
  forces it to step down, so it can never resume issuing writes as if
  nothing happened.

## Log replication and safety

![Raft log replication and the commit index](/img/patterns/raft-log.svg)

Leader election picks *who* drives the log; replication and its safety
rules govern *what ends up in it*. The diagram traces an entry from the
leader's append to a committed `commitIndex`:

- **Append, then replicate, then commit.** An entry is durable on the
  leader first, replicated to followers via `AppendEntries`, and only
  declared committed once a majority store it. Until then it is
  leader-only and may still be overwritten if the leader changes.
- **`commitIndex` is monotonic and majority-gated.** The leader advances
  it only when the majority condition is met, and never moves it
  backward; followers learn the committed prefix on subsequent appends
  and apply exactly that prefix, in order, to their state machines.
- **Divergent tails are truncated, never merged.** If a follower's log
  conflicts with the leader's, the Log Matching back-off finds the last
  agreeing index and the follower discards everything after it — logs
  are made to *match* the leader, never reconciled entry-by-entry.

## Raft vs. Paxos vs. Two-Phase Commit

All three are often lumped together as "agreement protocols," but only
two are consensus, and confusing them leads to real design mistakes:

| Property | Raft | Paxos | Two-Phase Commit |
| --- | --- | --- | --- |
| Problem class | Consensus | Consensus | Atomic commit |
| Agrees on | A replicated log | One value / a log | One transaction's outcome |
| Tolerates node failure | Minority may fail | Minority may fail | **Blocks** if coordinator fails |
| Requires unanimity | No — majority quorum | No — majority quorum | **Yes** — all must vote |
| Structure | Strong single leader | Symmetric proposers/acceptors | Coordinator + participants |
| Design priority | Understandability | Provable correctness | Cross-resource atomicity |

Raft and [Paxos](/docs/patterns/consistency/paxos) solve the *same*
problem — fault-tolerant agreement tolerating a minority failure — and
differ mainly in presentation: Raft fixes a strong leader and specifies
the log mechanics that Multi-Paxos leaves implicit, trading a little
generality for a great deal of understandability.
[Two-phase commit](/docs/patterns/consistency/two-phase-commit) is a
different beast: it is *not* consensus. It demands **unanimous** votes
and **blocks** — holding locks indefinitely — the moment its coordinator
fails after participants have voted. A Raft cluster keeps serving through
a leader crash; a 2PC transaction stalls until its coordinator recovers.
When you need agreement that *survives* failures rather than agreement
that *stalls* on them, you want consensus, not 2PC.

## Code example

The snippet below models Raft's two safety-critical decisions: the
vote-granting rule (with the **election restriction**) and the
**majority-commit** condition. These are the checks that guarantee a
committed entry is never lost across a leader change.

```rust
// A log entry carries the leader term in which it was created. That
// term is what the election restriction compares on.
#[derive(Clone, Copy, PartialEq, Debug)]
struct Entry {
    term: u64,
    // (a real entry also carries the client command; elided here)
}

// (lastLogTerm, lastLogIndex) summarizes how up-to-date a log is.
// Raft's ordering: a log is "at least as up-to-date" as another if its
// last term is higher, or the terms tie and its last index is >=.
fn at_least_as_up_to_date(a: (u64, u64), b: (u64, u64)) -> bool {
    a.0 > b.0 || (a.0 == b.0 && a.1 >= b.1)
}

struct Node {
    term: u64,
    voted_for: Option<u64>,
    log: Vec<Entry>,
}

impl Node {
    fn last(&self) -> (u64, u64) {
        match self.log.last() {
            Some(e) => (e.term, self.log.len() as u64),
            None => (0, 0),
        }
    }

    // Grant a vote only for a term the node hasn't already voted in, AND
    // only if the candidate's log is at least as up-to-date as ours.
    // This election restriction is what guarantees a candidate missing a
    // committed entry can never win — so committed entries survive every
    // leader change.
    fn on_request_vote(
        &mut self,
        cand_term: u64,
        cand_id: u64,
        cand_last: (u64, u64),
    ) -> bool {
        match () {
            _ if cand_term < self.term => false, // stale term: reject
            _ => {
                if cand_term > self.term {
                    self.term = cand_term; // newer term: step down, reset vote
                    self.voted_for = None;
                }
                let free = self.voted_for.is_none() || self.voted_for == Some(cand_id);
                match free && at_least_as_up_to_date(cand_last, self.last()) {
                    true => {
                        self.voted_for = Some(cand_id);
                        true
                    }
                    false => false,
                }
            }
        }
    }
}

// An entry is committed once it is stored on a strict majority of the
// cluster. That majority necessarily overlaps every election-winning
// majority, so a committed entry is present in the next leader's log.
fn is_committed(replicas_with_entry: usize, cluster_size: usize) -> bool {
    replicas_with_entry * 2 > cluster_size
}
```

`on_request_vote` refuses a candidate whose log is behind the voter's,
so a node that missed committed entries cannot gather a majority and
become leader. `is_committed` encodes the majority rule; combined, they
are why Raft can lose any minority of nodes — and hand off leadership
across crashes — without ever dropping a committed entry. Each node's
election timeout (the randomized 150–300ms spread shown in the diagram
above) drives *when* `on_request_vote` gets called; these functions
govern *who is allowed to win*.

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

## Use-case scenarios

**Kubernetes cluster state in etcd.** etcd, the strongly consistent
key-value store Kubernetes uses for all of its cluster state, uses Raft
to replicate every write across its member nodes and to elect a new
leader automatically if the current one fails. Every object the control
plane persists — pods, services, secrets — is a committed Raft log
entry, so the cluster's view of "what should be running" survives the
loss of a minority of etcd members and never forks into two conflicting
histories.

**Service discovery and configuration in Consul.** HashiCorp Consul uses
Raft to keep its service catalog and configuration data consistent
across the servers in a cluster, electing a leader the same way to
serialize writes to that replicated state. Reads can be served from any
server for scale, while writes funnel through the elected leader so
registrations and health-status changes apply in one agreed order —
critical when many services are registering and deregistering
concurrently across the fleet.

**Replicated log for a distributed database.** A distributed SQL or
message system often runs a Raft group per partition/shard: the shard's
leader orders and commits every write to that shard's replicated log,
and followers apply the same log to stay byte-for-byte consistent. When
a leader's node fails, a follower with an up-to-date log is elected and
the shard keeps serving writes within an election timeout — the
single-shard availability the election restriction and majority-commit
rules exist to guarantee.

## When to layer it

Raft rarely stands alone; it is the coordination core beneath several
higher-level patterns. Leader election and the replicated log it
provides are what a
[Failover](/docs/patterns/reliability/failover) controller uses to pick
and fence a new primary, what a
[Distributed Task Scheduler](/docs/patterns/building-blocks/distributed-task-scheduler)
uses to ensure exactly one scheduler is dispatching work, and what a
[Sequencer](/docs/patterns/building-blocks/sequencer) uses to hand out a
single monotonic stream of ids from one agreed authority.

## Related patterns

- [Paxos](/docs/patterns/consistency/paxos) — the earlier consensus
  algorithm Raft was explicitly designed to be a more understandable,
  more implementable alternative to, while providing the same
  fault-tolerant agreement guarantees.
- [Leader Election](/docs/patterns/consistency/leader-election) — Raft's
  first sub-problem in isolation; many systems need only "pick one owner
  and notice when it dies," which is leader election without the full
  replicated log.
- [Quorum](/docs/patterns/consistency/quorum) — the majority-overlap
  guarantee Raft's commit and election rules both rest on, in its
  simpler read/write-acknowledgment form.
- [Two-Phase Commit](/docs/patterns/consistency/two-phase-commit) — an
  atomic-commit protocol frequently confused with consensus; it requires
  unanimity and blocks on coordinator failure, whereas Raft tolerates a
  minority failure and keeps serving.
- [Sequencer](/docs/patterns/building-blocks/sequencer) — relies on the
  same single-agreed-authority idea Raft's leader provides: one
  coordinator issuing an ordered stream rather than every node contending
  on each operation.

## Further reading

- [In Search of an Understandable Consensus Algorithm (the Raft paper) — Ongaro & Ousterhout (PDF)](https://raft.github.io/raft.pdf)
- [The Raft Consensus Algorithm — raft.github.io (with visualizations)](https://raft.github.io/)
- [Raft (algorithm) — Wikipedia](https://en.wikipedia.org/wiki/Raft_(algorithm))
- [Raft Consensus Algorithm — GeeksforGeeks](https://www.geeksforgeeks.org/system-design/raft-consensus-algorithm/)
