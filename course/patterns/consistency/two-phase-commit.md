---
title: "Two-Phase Commit"
sidebar_position: 1
supplementary: true
---

Two-phase commit (2PC) is a coordinator-driven protocol that gets a group
of independent databases or services to agree on committing or aborting
a single transaction together, so a multi-participant write is never left
half-applied.

![Two-Phase Commit diagram](/img/patterns/two-phase-commit.svg)

## Problem it solves

A transaction that spans multiple independent databases — for example,
debiting an account in one service and crediting it in another — can't
rely on a single local ACID transaction, because each database only
knows how to commit or roll back its own state. Without coordination,
one participant could commit its half of the change while another fails
or times out, leaving the system in an inconsistent state where the
transaction is half-done and no single node knows the overall outcome.

## Technical architecture & implementation

**Phase 1: prepare.** The coordinator sends a `PREPARE` message to
every participant in parallel — not sequentially, since a sequential
prepare would make the transaction's latency the sum of every
participant's prepare time instead of the slowest one. Each participant
independently does everything required to guarantee it *can* commit
later: validating constraints, acquiring the necessary locks, and
writing the pending change to its own durable write-ahead log so the
decision survives a crash. It then replies `YES` (ready) or `NO`
(abort, e.g. a constraint violation or a lock conflict). The
durability requirement is what makes a `YES` vote a binding promise —
a participant that has logged its prepared state to durable storage can
recover that state and honor its vote even if it crashes and restarts
before phase 2 arrives.

**Phase 2: commit or abort.** Once the coordinator has collected a vote
from every participant (or a timeout elapses), it makes one global
decision: `COMMIT` if every vote was `YES`, `ABORT` if any vote was `NO`
or missing. That decision is itself written to the coordinator's own
durable log before being sent out, so the coordinator can recover and
resend the same decision if it crashes mid-broadcast. The decision is
then sent to every participant, each of which applies it (commit and
release locks, or roll back and release locks) and acknowledges. Only
after every participant has acknowledged does the coordinator consider
the transaction fully finished and discard its log entry for it.

**Why prepare has to run in parallel.** Two-phase commit's whole cost
is proportional to the *slowest* participant's prepare time only if
prepare messages go out concurrently; issuing them one at a time turns
an already latency-sensitive protocol into one whose cost is the *sum*
of every participant's prepare latency, which compounds badly as the
number of participants grows. This is a real, measurable difference —
not just a style preference — because every participant is holding
locks for the entire duration prepare is outstanding, and a longer
prepare window means more contention for whatever those locks protect.

**Failure modes.** The defining weakness is the coordinator as a
**blocking single point of failure**: once a participant has voted
`YES`, protocol rules forbid it from unilaterally deciding to commit or
abort — it must wait for the coordinator's decision, because acting
independently risks disagreeing with what the coordinator eventually
decides for everyone else. If the coordinator crashes after collecting
all `YES` votes but before broadcasting the decision, every participant
is stuck holding its locks indefinitely, unable to make progress on
its own, until the coordinator recovers (or an operator manually
intervenes) — this is called the **blocking problem** and is 2PC's
best-known limitation. A second, subtler failure mode is a participant
that crashes *after* voting `YES` but *before* persisting that vote
durably: on recovery it has no record of having promised to commit,
and may incorrectly abort a transaction the coordinator believes
already succeeded, producing exactly the inconsistency 2PC exists to
prevent. This is why the durable log write during prepare isn't
optional — skipping it reopens the correctness gap the whole protocol
is built to close.

## Code example

```rust
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Vote {
    Yes,
    No,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Decision {
    Commit,
    Abort,
}

struct Participant {
    name: &'static str,
    // Simulated prepare work (validation, locking, durable log write).
    prepare_delay: Duration,
    will_vote_yes: bool,
}

// Sends PREPARE to every participant concurrently — each participant's
// prepare work runs on its own thread, so total prepare time is the
// slowest single participant, not the sum of all of them.
fn prepare_phase(participants: Vec<Participant>) -> Vec<(&'static str, Vote)> {
    let (tx, rx) = mpsc::channel();

    for p in participants {
        let tx = tx.clone();
        thread::spawn(move || {
            thread::sleep(p.prepare_delay);
            let vote = if p.will_vote_yes { Vote::Yes } else { Vote::No };
            tx.send((p.name, vote)).expect("channel open");
        });
    }
    drop(tx);

    rx.iter().collect()
}

// The coordinator's phase-2 decision: commit only if every vote was Yes.
fn decide(votes: &[(&'static str, Vote)]) -> Decision {
    if votes.iter().all(|(_, v)| *v == Vote::Yes) {
        Decision::Commit
    } else {
        Decision::Abort
    }
}
```

`prepare_phase` spawns one thread per participant so their prepare
delays overlap rather than stack — the coordinator waits only as long
as the slowest participant takes, matching how a real 2PC coordinator
issues `PREPARE` to every participant in parallel rather than one at a
time.

## When to use it

- All participants are within a well-controlled, low-latency environment
  (e.g. a single data center) where coordinator failures are rare and
  recovery is fast.
- Strict atomicity across a small, fixed set of participants is
  required, and briefly held locks are acceptable.
- The underlying resource managers already support the XA (or similar)
  two-phase protocol, so the coordination logic doesn't have to be
  built from scratch.

## When not to use it

- The transaction is long-running or spans services owned by different
  teams — holding locks across a slow or unreliable step blocks
  unrelated work and creates tight coupling between services that
  should be independently deployable.
- High availability matters more than strict atomicity — a coordinator
  outage stalling every in-flight transaction is often worse than
  eventual consistency achieved through compensating actions.
- Participants span unreliable wide-area networks, where the odds of a
  coordinator or network failure during the window between prepare and
  commit are non-trivial.

## Use-case scenarios

**Core banking ledger transfer within one data center.** A bank moves
funds between two account services that each maintain their own
database, within a single tightly controlled data center where network
partitions between the two are rare and short-lived. Two-phase commit
guarantees the debit and credit either both happen or neither does —
acceptable here because the transaction is fast, both participants are
on the same low-latency network, and the operational team can act
quickly if a coordinator failure ever does leave the transaction
blocked.

**Distributed SQL database committing a multi-shard write.** A
distributed relational database splits a table's rows across several
storage nodes by key range, and a single transaction that updates rows
on two different shards needs those two shard-local writes to commit
atomically together. The database's internal transaction coordinator
runs a two-phase commit across the specific storage nodes involved in
that transaction — a purpose that fits 2PC well because the
"participants" are internal storage nodes under the same operational
control, not independently owned services across a wide-area network.

**Enterprise resource-planning system coordinating XA-compliant
resources.** An enterprise application needs a single business
transaction to update both a relational database and a message queue
atomically — if the database write commits but the outbound message
is never enqueued, downstream systems never learn about a change that
supposedly happened. A transaction manager coordinates both
XA-compliant resources through a standard two-phase commit protocol,
which is a well-established fit for this case because both resources
are typically colocated in the same data center and the transaction
completes quickly, keeping the blocking window short.

## Related patterns

- [Saga](/docs/patterns/consistency/saga) — the usual alternative for
  distributed transactions that are long-running or cross service
  boundaries, trading strict atomicity for a sequence of local
  transactions with compensating actions.
- [Quorum](/docs/patterns/consistency/quorum) — a different mechanism for
  getting distributed nodes to agree, built around a minimum number of
  acknowledgments rather than unanimous voting.

## Further reading

- [Two-phase commit protocol — Wikipedia](https://en.wikipedia.org/wiki/Two-phase_commit_protocol)
- [Saga distributed transactions — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/saga)
