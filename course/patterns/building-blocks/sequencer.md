---
title: "Sequencer"
sidebar_position: 2
supplementary: true
---

A sequencer generates unique, ideally roughly time-ordered identifiers
across many distributed nodes, without funneling every ID request
through a single counter that would become both a bottleneck and a
single point of failure.

## Problem it solves

An auto-increment primary key works fine on one database instance, but
the moment writes are sharded across many nodes, a single shared
counter becomes a serialization point every write has to wait on —
exactly the kind of bottleneck sharding was meant to eliminate. At the
same time, many systems still want IDs that are roughly sortable by
creation time, because that makes range scans, pagination, and
debugging far easier than with a fully random identifier. A sequencer
is the general pattern for generating IDs that are unique across the
whole fleet, generated locally without a per-request round trip to a
central authority, and — where possible — ordered.

## How it works

There are a few common approaches, trading off coordination, ordering,
and implementation complexity:

- **Centralized ID service.** A dedicated service hands out blocks of
  IDs (e.g. "you may use 1000–1999") to each requesting node, which
  then assigns from its local block without further coordination until
  it runs out. This keeps IDs strictly ordered and simple, at the cost
  of the service being a dependency every node needs on startup — and
  a potential bottleneck if blocks are requested too frequently.
- **UUIDs.** Each node generates a 128-bit identifier locally (e.g.
  UUIDv4, random) with a collision probability low enough to ignore in
  practice. No coordination and no bottleneck at all, but the IDs carry
  no ordering information, which hurts index locality and makes
  time-based queries and debugging harder.
- **Structured schemes (Snowflake-style).** Twitter's Snowflake format
  packs a millisecond timestamp, a worker/machine ID, and a per-worker
  sequence number into a single 64-bit integer. Because the timestamp
  occupies the high bits, IDs generated later sort after IDs generated
  earlier, giving rough global ordering. Each worker generates IDs
  independently using only its own clock and worker ID — no
  coordination with other workers is needed, and uniqueness is
  guaranteed by the worker-ID/sequence combination as long as worker
  IDs are assigned without overlap.

## When to use it

- Multiple nodes need to independently generate unique IDs without a
  synchronous round trip to a shared counter on every write.
- Rough time-ordering of IDs is valuable for index locality, sorting,
  or debugging, but strict global ordering isn't required.
- The system is already sharded or distributed and a single
  auto-increment counter would reintroduce a bottleneck.

## When not to use it

- A single database instance already provides auto-increment IDs
  cheaply and the system has no plans to shard — adding a sequencer is
  unnecessary complexity.
- Strict, gapless, globally ordered sequence numbers are a hard
  requirement (e.g. financial ledger entries) — that generally needs a
  single serialized source of truth, not a distributed scheme.
- Random, non-ordered unique IDs are perfectly acceptable — plain
  UUID generation is simpler than deploying a structured-ID scheme.

## Real-world example

Twitter's Snowflake service was built to replace an auto-incrementing
MySQL column that could no longer keep up with tweet volume, and its
timestamp+worker+sequence design has since been adopted, in similar
form, by Discord and Instagram for the same reason: unique, roughly
sortable IDs generated independently across many machines.

## Related patterns

- [Sharding](/docs/patterns/storage/sharding) — sharded systems are the
  main reason a single auto-increment counter stops working and a
  sequencer becomes necessary.

## Further reading

- [Snowflake ID — Wikipedia](https://en.wikipedia.org/wiki/Snowflake_ID)
- [Universally unique identifier — Wikipedia](https://en.wikipedia.org/wiki/Universally_unique_identifier)
