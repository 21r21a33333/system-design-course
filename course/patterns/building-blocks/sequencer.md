---
title: "Sequencer"
sidebar_position: 2
supplementary: true
---

A sequencer generates unique, ideally roughly time-ordered identifiers
across many distributed nodes, without funneling every ID request
through a single counter that would become both a bottleneck and a
single point of failure.

![Sequencer diagram](/img/patterns/sequencer.svg)

## Problem it solves

An auto-increment primary key works fine on one database instance, but
the moment writes are sharded across many nodes, a single shared
counter becomes a serialization point every write has to wait on —
exactly the kind of bottleneck [sharding](/docs/patterns/storage/sharding)
was meant to eliminate. At the same time, many systems still want IDs
that are roughly sortable by creation time, because that makes range
scans, pagination, and debugging far easier than with a fully random
identifier — and it keeps newly inserted rows clustered at the "end" of
a B-tree index rather than scattered across it, which matters a lot for
write throughput. A sequencer is the general pattern for generating IDs
that are unique across the whole fleet, generated locally without a
per-request round trip to a central authority, and — where possible —
ordered.

## Technical architecture & implementation

**The three core approaches.** Sequencing schemes trade coordination
against ordering and simplicity:

- **Central allocator (ranges/tickets).** A dedicated service hands out
  blocks of IDs ("you may use 1000–1999") to each node, which then
  assigns from its local block without further coordination until it
  runs out. IDs stay strictly ordered and dense, but the service is a
  dependency every node needs, and requesting blocks too small too often
  reintroduces the very round trip the pattern set out to avoid. A block
  reservation must be durable — if a node crashes mid-block, the unused
  tail is simply skipped, which is why these schemes guarantee
  uniqueness but not gaplessness.
- **Coordination-free random (UUID).** Each node generates a 128-bit
  value locally with a collision probability low enough to ignore
  (UUIDv4 is 122 random bits). Zero coordination and zero bottleneck,
  but the IDs carry no ordering, which scatters index inserts and hurts
  locality.
- **Structured, coordination-free (Snowflake-style).** Pack a
  millisecond timestamp, a worker/machine ID, and a per-worker sequence
  into a single 64-bit integer. Because the timestamp sits in the high
  bits, later IDs sort after earlier ones — rough global ordering — while
  each worker generates independently using only its own clock and
  worker ID.

**The Snowflake bit layout.** Twitter's original Snowflake used a
64-bit signed integer split as: 1 unused sign bit, 41 bits of
millisecond timestamp (relative to a custom epoch, giving ~69 years of
range), 10 bits of worker ID (1024 workers), and 12 bits of sequence
(4096 IDs per worker per millisecond). The choice is a budget: spend
bits on more workers and you have fewer per-millisecond IDs, and vice
versa. The 41-bit timestamp being most-significant is the whole trick —
it's what makes the integer sort by time.

**Uniqueness and monotonicity guarantees.** Uniqueness holds as long as
**worker IDs never overlap** — the entire scheme rests on disjoint
worker IDs, so assigning them (via ZooKeeper/etcd registration, a config
map, or a stable ordinal from a StatefulSet) is the operationally
critical part. Within a worker, IDs are strictly monotonic: same
millisecond advances the sequence; a new millisecond resets it. IDs are
*roughly* time-ordered globally but not strictly — two workers minting
in the same millisecond can produce IDs whose relative order doesn't
match their true wall-clock order down to the microsecond.

**Clock hazards.** The timestamp component makes the wall clock part of
correctness, which introduces two failure modes. **Sequence exhaustion**
— more than 4096 IDs in one millisecond — must block and spin to the next
millisecond rather than overflow into the worker bits. Worse is the
**backward clock**: an NTP correction, leap-second smear, or VM live
migration can move the clock earlier, and minting an ID with an earlier
timestamp than one already issued breaks monotonicity and risks
duplicates within the rewound window. A correct generator refuses to
issue IDs while `now < last_timestamp` — it errors or waits out the
drift rather than producing a smaller ID.

**Choosing between schemes.** **UUIDv4** is simplest and needs nothing,
but is random. **ULID** and **UUIDv7** keep the 128-bit width and global
uniqueness of UUID while making the high bits a millisecond timestamp,
so they sort by time like Snowflake without any worker-ID coordination —
often the sweet spot for application-level IDs today. **Snowflake** is
64 bits (half the storage, better index density) and needs worker-ID
assignment, which pays off at very high volume where the narrower key
and coordination-free generation both matter.

**Differentiation from siblings.** A sequencer answers "give me a unique,
sortable ID" — it is not a
[distributed lock](/docs/patterns/consistency/leader-election) or a
consensus mechanism. It deliberately avoids the per-write coordination
that [leader election](/docs/patterns/consistency/leader-election) and
consensus protocols impose; the price is that it provides *rough*
ordering and uniqueness, not the *strict, gapless, globally serialized*
sequence those stronger primitives can. When you truly need a single
total order (a financial ledger's entry numbers), a sequencer is the
wrong tool — you need a serialized source of truth.

## ID scheme comparison

| Scheme | Width | Time-ordered | Coordination needed | Notes |
| --- | --- | --- | --- | --- |
| UUIDv4 | 128-bit | no | none | fully random; poor index locality |
| ULID / UUIDv7 | 128-bit | yes (ms prefix) | none | sortable without worker IDs |
| Snowflake | 64-bit | yes (rough) | disjoint worker IDs | compact; clock-dependent |
| Central allocator | any | yes (dense) | central service | strict/dense; service is a dependency |

## Code example

A Snowflake-style composer with the two guardrails that make it correct:
sequence rollover within a millisecond, and a hard refusal to mint IDs
when the clock has moved backward. Time is injected as a parameter so
the logic is deterministically testable.

```rust
/// A Snowflake-style 64-bit ID composer. Layout (high → low bits):
///
///   1 bit  unused / sign (always 0, keeps the i64 positive)
///  41 bits millisecond timestamp since a custom epoch (~69 years of range)
///  10 bits worker id (up to 1024 independent generators)
///  12 bits per-millisecond sequence (up to 4096 IDs per worker per ms)
const WORKER_BITS: u64 = 10;
const SEQUENCE_BITS: u64 = 12;

const MAX_WORKER: u64 = (1 << WORKER_BITS) - 1; // 1023
const MAX_SEQUENCE: u64 = (1 << SEQUENCE_BITS) - 1; // 4095

const WORKER_SHIFT: u64 = SEQUENCE_BITS;
const TIMESTAMP_SHIFT: u64 = SEQUENCE_BITS + WORKER_BITS;

#[derive(Debug, PartialEq)]
pub enum IdError {
    ClockWentBackward,
    WorkerIdOutOfRange,
}

pub struct Snowflake {
    epoch_ms: u64,
    worker_id: u64,
    last_ms: u64,
    sequence: u64,
}

impl Snowflake {
    pub fn new(epoch_ms: u64, worker_id: u64) -> Result<Self, IdError> {
        if worker_id > MAX_WORKER {
            return Err(IdError::WorkerIdOutOfRange);
        }
        Ok(Snowflake { epoch_ms, worker_id, last_ms: 0, sequence: 0 })
    }

    /// Generate the next ID given the current wall-clock time in ms.
    /// `now_ms` is injected so the logic is deterministically testable.
    pub fn next_id(&mut self, now_ms: u64) -> Result<u64, IdError> {
        // Guard against a backward clock jump (NTP correction, VM migration).
        // Minting IDs with an earlier timestamp than an already-issued ID would
        // break monotonicity and risk duplicates within the rewound window.
        if now_ms < self.last_ms {
            return Err(IdError::ClockWentBackward);
        }

        if now_ms == self.last_ms {
            // Same millisecond: advance the sequence.
            self.sequence = (self.sequence + 1) & MAX_SEQUENCE;
            if self.sequence == 0 {
                // Sequence exhausted (4096 IDs this ms). Spin to the next ms.
                let mut next = now_ms;
                while next <= self.last_ms {
                    next += 1;
                }
                self.last_ms = next;
            }
        } else {
            // A newer millisecond: reset the sequence.
            self.sequence = 0;
            self.last_ms = now_ms;
        }

        let ts = self.last_ms - self.epoch_ms;
        let id = (ts << TIMESTAMP_SHIFT)
            | (self.worker_id << WORKER_SHIFT)
            | self.sequence;
        Ok(id)
    }
}

fn main() {
    const EPOCH: u64 = 1_700_000_000_000; // custom epoch (ms)
    let mut gen = Snowflake::new(EPOCH, 42).unwrap();

    // IDs minted in the same ms are strictly increasing via the sequence.
    let a = gen.next_id(EPOCH + 1000).unwrap();
    let b = gen.next_id(EPOCH + 1000).unwrap();
    assert!(b > a, "same-ms IDs must be monotonic");

    // A later timestamp yields a larger ID and resets the sequence to 0.
    let c = gen.next_id(EPOCH + 2000).unwrap();
    assert!(c > b, "later-ms ID must be larger");
    assert_eq!(c & MAX_SEQUENCE, 0, "sequence resets on a new ms");

    // The worker id is recoverable from the middle bits.
    assert_eq!((c >> WORKER_SHIFT) & MAX_WORKER, 42);

    // A backward clock is refused rather than silently issuing a duplicate.
    assert_eq!(gen.next_id(EPOCH + 500), Err(IdError::ClockWentBackward));
}
```

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
  UUIDv4 generation is simpler than deploying a structured-ID scheme
  and its worker-ID assignment.

## Use-case scenarios

**Sharded social feed.** A social platform shards posts across hundreds
of databases and needs each post to carry a unique, time-sortable ID so
a user's timeline can be paginated by "everything after this ID" without
a global sort. Snowflake IDs let every write node mint IDs from its own
clock and worker ID; the timestamp prefix keeps a shard's inserts
appended to the index tail and makes cross-shard merges into a feed a
simple numeric sort.

**Order numbers in a distributed commerce backend.** An e-commerce
system generates order IDs across multiple regional services. Using
UUIDv7 gives globally unique, time-ordered IDs with no worker-ID
coordination at all — attractive when services come and go elastically
and assigning stable worker ordinals would be operational friction — at
the cost of a wider 128-bit key than Snowflake.

**High-throughput event ingestion.** A telemetry pipeline stamps
hundreds of thousands of events per second per node with IDs. A central
allocator handing out large ID ranges keeps IDs dense and strictly
ordered per stream, and the per-node local block means the allocator is
touched only once per few thousand events — amortizing its cost while
avoiding a per-event round trip, accepting the allocator as a startup
dependency and tolerating skipped ranges when a node dies mid-block.

## Related patterns

- [Sharding](/docs/patterns/storage/sharding) — sharded systems are the
  main reason a single auto-increment counter stops working and a
  sequencer becomes necessary.
- [Leader Election](/docs/patterns/consistency/leader-election) — the
  coordination primitive a central allocator (or worker-ID registry)
  relies on, and the stronger tool to reach for when *strict* global
  ordering is required instead of rough ordering.
- [Consistent Hashing](/docs/patterns/storage/consistent-hashing) — the
  companion technique for deciding *which* shard a keyed write lands on,
  once the sequencer has produced the key.

## Further reading

- [Snowflake ID — Wikipedia](https://en.wikipedia.org/wiki/Snowflake_ID)
- [Snowflake — Twitter's original ID generator (source, archived)](https://github.com/twitter-archive/snowflake/tree/snowflake-2010)
- [Universally unique identifier — Wikipedia](https://en.wikipedia.org/wiki/Universally_unique_identifier)
- [The ULID specification](https://github.com/ulid/spec)
- [RFC 9562: UUID versions 6, 7, and 8](https://www.rfc-editor.org/rfc/rfc9562)
