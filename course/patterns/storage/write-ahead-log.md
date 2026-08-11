---
title: "Write-Ahead Log"
sidebar_position: 3
supplementary: true
---

A write-ahead log (WAL) is a durability primitive: every intended
mutation is first appended to a sequential, append-only log on durable
storage and **fsynced before** it is applied to the main data structure —
so if a crash interrupts the update, the log alone holds enough
information to replay and reconstruct the correct state on restart.

![Write-Ahead Log diagram](/img/patterns/write-ahead-log.svg)

## Problem it solves

In-memory structures and on-disk B-trees are fast to mutate but fragile:
a crash or power loss mid-update can leave the structure half-written and
inconsistent, and anything not yet flushed to disk is simply lost.
Flushing every mutation straight into its final on-disk location before
acknowledging would be durable, but those writes are scattered
**random-access** writes across a large structure — slow, seek-bound, and
throughput-limiting. A WAL breaks the deadlock by separating *durably
recorded* from *applied*: the change is made safe by a cheap sequential
append, and the expensive in-place update happens afterward, lazily, at
the engine's convenience. The write-ahead **ordering rule** — log and
fsync *before* apply — is the entire correctness guarantee.

## Technical architecture & implementation

**Log records and the LSN.** Each entry is a **log record** describing one
change, stamped with a monotonically increasing **log sequence number
(LSN)** that orders every mutation globally and lets recovery, replicas,
and checkpoints all refer to an exact position in the stream. Records
usually carry a checksum (CRC) so a torn write from a crash mid-append is
detected and truncated rather than replayed as garbage.

**The write path.** On each mutation the engine serializes a record,
**appends** it to the log's tail, and issues an **fsync** (or
`fdatasync`); only once that returns is the write acknowledged as durable.
Because it's a pure append to the end of a file, this is a **sequential
write** — dramatically cheaper than the random-access writes the main
structure would need, since sequential I/O avoids seeks (and even on SSDs
has lower, more predictable latency). The actual structure — a B-tree,
memtable, or key-value map — is updated afterward, often batched.

**Group commit.** The fsync is the expensive step, so engines **batch**
it: many concurrent transactions' records are appended and made durable by
a *single* shared fsync (**group commit**). This trades a tiny latency
increase per transaction for a large throughput gain, since fsync cost is
amortized across the whole batch instead of paid per write — the standard
way a WAL sustains high commit rates.

**Redo vs undo logging.** What a record contains defines the recovery
style. **Redo logging** records the *new* value (or the operation) so
recovery re-applies committed changes that hadn't reached the data pages —
this is what lets writes be lazy and is the common case (Postgres, most
LSM engines). **Undo logging** records the *old* value so an interrupted,
uncommitted transaction can be rolled *back*. Real engines (e.g. ARIES,
the classic algorithm) combine both — redo to reach the crash point, undo
to remove effects of transactions that never committed — enabling the
"steal/no-force" buffer policy that makes databases fast.

**Checkpoints to bound replay.** Without a bound, recovery would replay the
log from the beginning of time. A **checkpoint** periodically flushes the
applied data structure to disk and writes a marker recording the LSN up to
which everything is safely persisted; recovery then only needs to replay
records *after* the last checkpoint. Checkpoint frequency is a tuning
dial — frequent checkpoints shorten recovery but add steady I/O; infrequent
ones do the opposite. Old log segments before the checkpoint (and before
the oldest replica's position) can then be recycled or archived.

**Log shipping as replication and CDC.** The same replay mechanism that
recovers a crash also **replicates**: stream the primary's WAL to a
replica and have it apply the identical record sequence to converge on the
same state — this is physical/streaming replication as used by
[primary-replica replication](/docs/patterns/storage/primary-replica-replication).
The log is likewise the cleanest source for
[change data capture](/docs/patterns/batch-streaming/change-data-capture):
tailing the WAL yields an exact, ordered stream of every committed change
to feed search indexes, caches, and downstream systems — which is why
"read the log" (Postgres logical decoding, MySQL binlog) beats polling.

**Failure mode — the fsync lie.** The WAL's guarantee is only as strong as
fsync actually being durable. Operating systems, virtualized disks, and
consumer SSDs with volatile write caches have historically acknowledged an
fsync while data sat in a cache that a power loss would erase — silently
breaking the ordering guarantee. Correct WAL deployments require
end-to-end durable-write behavior (battery-backed cache, honored flushes),
and this class of bug is notoriously hard to detect until a crash exposes
lost "committed" data.

**WAL vs event sourcing.** A WAL is an *internal recovery and replication*
mechanism: the log is an implementation detail beneath the real system of
record (the B-tree, the table), and it can be truncated once its changes
are safely applied and shipped. [Event sourcing](/docs/patterns/storage/event-sourcing)
inverts this — the append-only event log *is* the domain system of record,
events are first-class business facts retained indefinitely, and current
state is a derived projection. Same append-only shape, opposite role: the
WAL serves the data structure; in event sourcing the log *is* the truth
and the data structures serve it.

## Recovery: checkpoint + replay

The recovery walkthrough, following the log tape in the diagram:

1. **Locate the last checkpoint.** Recovery scans backward (or reads a
   control file) to find the most recent checkpoint marker — say LSN 43 —
   which guarantees every change up to that point is already durable in the
   data structure. Nothing before it needs replaying.
2. **Redo forward from the checkpoint.** Replay records **after** the
   checkpoint in LSN order (44, 45, …), re-applying each committed mutation
   to rebuild the state that was in memory but not yet flushed when the
   crash hit.
3. **Handle the torn tail.** The final record may be a partial, torn write
   from the crash; its bad CRC flags it and recovery truncates the log
   there rather than replaying corruption.
4. **Undo the uncommitted (if using undo/ARIES).** Any changes belonging to
   transactions that logged but never reached a commit record are rolled
   back using undo information, so half-finished transactions leave no
   trace.
5. **Resume.** The structure now exactly matches the last acknowledged,
   committed state; normal operation continues, appending at the recovered
   tail.

The code example demonstrates steps 1–2 and 5 deterministically: it drops
the in-memory table entirely (simulating a crash) and reconstructs it from
the log alone.

## Code example

An append-only log with `append` + (simulated) fsync, an `apply` step that
mutates the in-memory table, and a `recover` that rebuilds the table purely
by replaying the durable log after a simulated crash. The ordering — log
first, then apply — is the invariant the whole scheme rests on.

```rust
use std::collections::HashMap;

// One logged mutation. A real engine also stamps an LSN and a CRC per record.
#[derive(Clone)]
enum Record {
    Set { key: String, value: i64 },
    Delete { key: String },
}

// The durable log: records survive a crash because they were appended and
// fsynced before ever being applied to the in-memory table.
#[derive(Default)]
struct Wal {
    committed: Vec<Record>,
}

impl Wal {
    // Append + (simulated) fsync. Only after this returns is the write durable.
    fn append(&mut self, r: Record) {
        self.committed.push(r);
        // fsync() here in a real system — the point at which the write is safe.
    }
}

#[derive(Default)]
struct Store {
    table: HashMap<String, i64>,
    wal: Wal,
}

impl Store {
    // Durable path: log first, fsync, THEN apply. The ordering IS the guarantee.
    fn set(&mut self, key: &str, value: i64) {
        let r = Record::Set { key: key.to_string(), value };
        self.wal.append(r.clone());
        self.apply(&r);
    }

    fn delete(&mut self, key: &str) {
        let r = Record::Delete { key: key.to_string() };
        self.wal.append(r.clone());
        self.apply(&r);
    }

    fn apply(&mut self, r: &Record) {
        match r {
            Record::Set { key, value } => {
                self.table.insert(key.clone(), *value);
            }
            Record::Delete { key } => {
                self.table.remove(key);
            }
        }
    }

    fn get(&self, key: &str) -> Option<i64> {
        self.table.get(key).copied()
    }

    // Rebuild the in-memory table purely by replaying the durable log.
    fn recover(wal: Wal) -> Store {
        let mut s = Store::default();
        for r in &wal.committed {
            s.apply(r);
        }
        s.wal = wal;
        s
    }
}

fn main() {
    let mut store = Store::default();
    store.set("balance:alice", 100);
    store.set("balance:bob", 50);
    store.set("balance:alice", 90); // alice pays bob 10
    store.set("balance:bob", 60);

    let before = (store.get("balance:alice"), store.get("balance:bob"));

    // Crash: the in-memory table vanishes; only the fsynced log survives.
    let salvaged_wal = store.wal;
    let recovered = Store::recover(salvaged_wal);
    let after = (recovered.get("balance:alice"), recovered.get("balance:bob"));

    println!("before crash: alice={:?} bob={:?}", before.0, before.1);
    println!("after replay: alice={:?} bob={:?}", after.0, after.1);
    assert_eq!(before, after, "recovery must reconstruct the exact pre-crash state");
    println!("state reconstructed from the log alone: OK");
}
```

Running this prints identical balances before the crash and after replay
(`alice=90`, `bob=60`) and the assertion holds — the reconstructed state is
*exactly* the pre-crash state, produced from nothing but the log. That is
the entire promise of a WAL made concrete.

## When to use it

- You need crash-recovery guarantees for a data structure that would be
  too slow to fsync into its final location on every write.
- You're building or operating replication or CDC — shipping a WAL is
  simpler and more efficient than replaying application-level queries, and
  it's the natural change stream for downstream consumers.
- Write throughput matters and the workload tolerates a brief window where
  "durable" (in the log) and "applied" (in the queryable structure) are
  momentarily out of sync.

## When not to use it

- The data is small or non-critical enough that writing directly to disk
  and accepting a small loss window on crash is fine — a WAL is machinery
  for a problem you don't have.
- You need reads to reflect writes with zero replication lag in lock-step;
  WAL-based replication is typically asynchronous or near-synchronous.
- The operational overhead — log rotation, checkpointing, compaction,
  archival, and the storage the log itself consumes — isn't justified at
  your scale.

## Use-case scenarios

**Relational database crash recovery.** PostgreSQL writes every change to
its WAL and fsyncs it before touching the heap and index pages, so a crash
mid-transaction is recovered by replaying the log forward from the last
checkpoint. The same WAL then drives streaming replication to standbys and,
via logical decoding, feeds change data capture pipelines — one mechanism
serving durability, replication, and CDC at once.

**LSM-tree key-value store.** A store like RocksDB or Cassandra appends
each write to a WAL *and* to an in-memory memtable; the memtable is flushed
to an immutable sorted file only periodically, so a crash between flushes
would lose recent writes were it not for the WAL, which is replayed on
restart to repopulate the memtable. Group commit batches the fsyncs to keep
the write path fast.

**Log-structured message broker.** Apache Kafka takes the idea to its
limit: the storage engine *is* a WAL — each partition is literally an
append-only log on disk, producers append and "applying" a message just
means a consumer reads further along it. Durability, ordering, and replay
for late or replaying consumers all fall directly out of the log being the
primary structure rather than a recovery aid beneath one.

## Production libraries & getting started

You almost never write a WAL by hand — you inherit one from the storage engine
you build on, whether a full SQL database, an embedded key-value store, or an
LSM engine you link into your own process.

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| PostgreSQL WAL | System (SQL) | Physical write-ahead log driving crash recovery, checkpoints, streaming replication, and logical decoding | [WAL introduction](https://www.postgresql.org/docs/current/wal-intro.html) |
| SQLite (WAL mode) | System (embedded) | Opt-in WAL journal mode giving concurrent readers with a single writer and faster commits | [WAL mode docs](https://www.sqlite.org/wal.html) |
| RocksDB | C++ (embeddable) | LSM engine whose WAL replays the memtable on restart; group commit batches fsyncs | [Write-Ahead Log format](https://github.com/facebook/rocksdb/wiki/Write-Ahead-Log-File-Format) |
| MySQL InnoDB redo log | System (SQL) | InnoDB's redo (WAL) log for crash recovery, with configurable durability and group commit | [InnoDB redo log](https://dev.mysql.com/doc/refman/8.0/en/innodb-redo-log.html) |
| `sled` | Rust | Embedded key-value store with a lock-free log-structured design and internal WAL | [docs.rs](https://docs.rs/sled/latest/sled/) |
| `redb` | Rust | Embedded copy-on-write B-tree KV store; durable commits without a separate replay log | [docs.rs](https://docs.rs/redb/latest/redb/) |

**Example / reference:** [PostgreSQL WAL internals](https://www.postgresql.org/docs/current/wal-internals.html) documents the on-disk record and segment format of a production write-ahead log.

## Related patterns

- [Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication) —
  streaming the WAL to standbys is how physical replication converges a
  replica on the primary's exact state.
- [Change Data Capture](/docs/patterns/batch-streaming/change-data-capture) —
  tailing the WAL yields the exact, ordered change stream that CDC ships to
  downstream systems.
- [Event Sourcing](/docs/patterns/storage/event-sourcing) — inverts the
  WAL's role: the append-only log becomes the domain system of record, not
  an internal recovery mechanism beneath one.
- [Failover](/docs/patterns/reliability/failover) — a hot standby kept in
  sync via WAL shipping is what makes a fast, low-loss failover possible.
- [Two-Phase Commit](/docs/patterns/consistency/two-phase-commit) — a
  participant's durable prepare/commit decisions are themselves recorded in
  a WAL so it survives a crash mid-protocol.

## Further reading

- [Write-ahead logging — Wikipedia](https://en.wikipedia.org/wiki/Write-ahead_logging)
- [PostgreSQL: Write-Ahead Logging (WAL) — official docs](https://www.postgresql.org/docs/current/wal-intro.html)
- [PostgreSQL: WAL configuration — official docs](https://www.postgresql.org/docs/current/wal-configuration.html)
- [Write-Ahead Log — Patterns of Distributed Systems, Martin Fowler](https://martinfowler.com/articles/patterns-of-distributed-systems/write-ahead-log.html)
- [Apache Kafka — Wikipedia](https://en.wikipedia.org/wiki/Apache_Kafka)
