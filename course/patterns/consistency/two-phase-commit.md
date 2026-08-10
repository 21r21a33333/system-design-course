---
title: "Two-Phase Commit"
sidebar_position: 1
supplementary: true
---

Two-phase commit (2PC) is a coordinator-driven protocol that gets a group
of independent databases or services to agree on committing or aborting
a single transaction together, so a multi-participant write is never left
half-applied.

## Problem it solves

A transaction that spans multiple independent databases — for example,
debiting an account in one service and crediting it in another — can't
rely on a single local ACID transaction, because each database only
knows how to commit or roll back its own state. Without coordination,
one participant could commit its half of the change while another fails
or times out, leaving the system in an inconsistent state where the
transaction is half-done and no single node knows the overall outcome.

## How it works

A designated coordinator drives two phases. In the **prepare phase**, the
coordinator asks every participant to do all the work needed to commit —
validate constraints, acquire locks, write the change to a durable log —
and reply "yes" (ready to commit) or "no" (abort). Crucially, a
participant that votes "yes" guarantees it can commit later no matter
what, so it holds its locks and waits. In the **commit/abort phase**,
once the coordinator has collected votes from everyone, it makes the
final decision: if all participants voted "yes," it sends a commit
message to all of them; if any voted "no" (or timed out), it sends
abort to all of them. Participants then apply that decision and release
their locks.

The protocol's major weakness is that the coordinator is a **blocking
single point of failure**. Once a participant votes "yes" in the
prepare phase, it cannot unilaterally decide to commit or abort — it
must wait for the coordinator's final instruction. If the coordinator
crashes after prepare has succeeded everywhere but before it sends the
commit/abort decision, every participant is stuck holding its locks
indefinitely, unable to make progress on its own, until the coordinator
recovers (or an operator intervenes). This blocking behavior is why 2PC
is a poor fit for transactions that span slow or unreliable networks,
or that run for a long time.

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

## Real-world example

The XA standard, implemented by most major relational databases and
message brokers, is the classic implementation of two-phase commit;
Java's JTA (Java Transaction API) uses it to coordinate commits across
multiple XA-compliant resources such as separate databases in the same
application. Distributed SQL databases like Google Spanner and
CockroachDB also use two-phase commit internally to atomically commit
transactions that touch data on multiple storage nodes, though they
pair it with additional mechanisms to reduce the blocking window.

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
