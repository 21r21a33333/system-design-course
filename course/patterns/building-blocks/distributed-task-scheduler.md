---
title: "Distributed Task Scheduler"
sidebar_position: 10
supplementary: true
---

A distributed task scheduler reliably runs scheduled, delayed, or queued jobs
across a fleet of workers — deciding *when* each job is due, ensuring each due
occurrence runs on exactly one worker even when multiple scheduler instances
run for availability, and recovering cleanly when a worker fails mid-job.

![Distributed Task Scheduler diagram](/img/patterns/distributed-task-scheduler.svg)

## Problem it solves

A single cron process on one box is a single point of failure — if that box
dies, every scheduled job silently stops until someone notices. The obvious
fix, running the scheduler on several machines for redundancy, immediately
creates a worse problem: if every instance independently decides "it's time to
run this job," the job runs *N* times instead of once — as broken as running it
zero times for anything with side effects (charging a customer, sending a
notification, generating a report). Layer on top: workers crash mid-execution,
clocks drift between machines, and a scheduler that was down for an hour must
decide what to do about the runs it missed. A distributed task scheduler exists
to deliver redundancy *and* single-execution *and* clean recovery, all at once.

## Technical architecture & implementation

**The durable job store.** State cannot live only in a scheduler's memory, or
a restart forgets everything due. A durable store (a database, often the same
one holding application data) is the source of truth: each job row carries its
schedule, `due_at`, current state (`pending`/`running`/`done`/`failed`),
attempt count, and — critically — a **unique run id** per scheduled occurrence.
The run id is what lets the whole system reason about "this specific execution"
for deduplication and leasing; generating collision-free run ids at scale is
the [Sequencer](/docs/patterns/building-blocks/sequencer) problem.

**Coordination to avoid double dispatch.** The core defence against duplicate
execution is coordination between scheduler instances via **leader election**
or a **distributed lock**. Either one instance is elected leader and is the
only one that dispatches (a standby takes over if it fails), or any instance
may attempt to claim a specific run via a short-lived lock and only the winner
dispatches it. Both rest on the same primitive: a consensus-backed store (etcd,
ZooKeeper, or a database row lock) that guarantees only one holder of a given
lock or leadership term at a time. This is exactly the
[Leader Election](/docs/patterns/consistency/leader-election) discipline, and
the correctness argument is the same one [Raft](/docs/patterns/consistency/raft)
makes about a single leader per term.

**Leases and worker-failure recovery.** Scheduler redundancy is separate from
*worker* failure: once a job is dispatched, that worker can still crash. The
standard mechanism is a **lease** — the worker holds the run under a
time-bounded lease it must periodically **renew** while working. If the lease
expires without renewal, the scheduler assumes the worker died and reassigns
the run to another worker. A lease can expire because a worker is merely slow,
not dead, so the same run can occasionally execute twice. That's why job bodies
must be **at-least-once safe**: either naturally idempotent, or guarded by
deduplicating on the run id. See
[Idempotency](/docs/patterns/reliability/idempotency).

**Fencing tokens.** A subtle hazard: a worker whose lease expired might not
know it (GC pause, network stall) and later attempt a write, corrupting state a
newer worker already owns. Each lease grant carries a monotonically increasing
**fencing token**; downstream stores record the highest token they've seen and
reject any write bearing a lower one — the same fencing that guards
[failover](/docs/patterns/reliability/failover) against split-brain. The code
example issues these tokens on each grant.

**Cron vs. delay queues vs. priority.** Scheduling comes in flavors.
**Cron-style** fires on a recurring wall-clock expression. A **delay queue**
runs a one-off job at (or after) a future timestamp — "send this reminder in 24
hours" — commonly implemented as a store indexed by `due_at` that workers poll,
or as a [priority queue](/docs/patterns/batch-streaming/priority-queue) keyed
on time. **Priority** lets urgent jobs preempt bulk work by ordering the ready
set by a priority field rather than pure arrival order.

**Retries and backoff.** A failed job shouldn't retry instantly and hammer a
struggling dependency. Schedulers apply
[retry with exponential backoff](/docs/patterns/reliability/retry-with-backoff)
— increasing delays plus jitter — and cap total attempts, after which the job
is parked (a dead-letter-style state) for inspection rather than retried
forever.

**Sharded worker pools.** Throughput scales by partitioning the job space
across workers — hashing on job id or tenant so each worker owns a slice, the
same partitioning logic a
[distributed message queue](/docs/patterns/building-blocks/distributed-message-queue)
uses for consumer groups. This bounds any one worker's load and localizes the
blast radius of a slow job.

**Clock skew and the two catch-up failure modes.** Machine clocks drift, so
schedulers must not treat "my local clock says now" as ground truth for
coordination — leases use the store's clock or logical time, not each worker's.
Two failure modes bracket recovery. **Missed runs**: after downtime, which
skipped occurrences should still run? A durable scheduler can detect and
backfill them. **Thundering herd**: naively firing *every* missed occurrence at
once — or every worker waking on the same cron tick — floods downstream systems.
The mitigation is to fire the next due slot once and realign (the
`next_fire` logic below), and to add jitter so workers don't synchronize.

## Code example

The load-bearing mechanisms are the **lease table with fencing tokens**
(single-execution + safe reclaim on failure) and **missed-slot-collapsing
schedule math** (avoiding thundering-herd catch-up). Verified at runtime:
after downtime, `next_fire(last=1000, interval=60, now=4000)` returns `4060` —
a single realigned slot, not one fire per missed slot — while a normal tick
`next_fire(1000, 60, 1030)` returns `1060`.

```rust
use std::collections::HashMap;

// A lease guards single execution: a worker may run a job only while it holds
// an unexpired lease on that run id. If the holder crashes, the lease expires
// and another worker can claim it — at-least-once execution, which is why job
// bodies must be idempotent.
#[derive(Clone)]
struct Lease {
    holder: u64,        // worker id
    expires_at: u64,    // logical time (ms)
    fencing_token: u64, // monotonic; lets a store reject a stale holder's write
}

pub struct LeaseTable {
    leases: HashMap<u64, Lease>, // job run id -> lease
    next_token: u64,
}

pub enum Claim {
    Granted { fencing_token: u64 },
    Held,
}

impl LeaseTable {
    pub fn new() -> Self {
        LeaseTable { leases: HashMap::new(), next_token: 1 }
    }

    // Claim a run at time `now`. Succeeds if unheld or the existing lease has
    // expired. Each grant bumps the fencing token so a downstream store can
    // reject writes from a slow, superseded worker.
    pub fn claim(&mut self, run_id: u64, worker: u64, now: u64, ttl: u64) -> Claim {
        let free = match self.leases.get(&run_id) {
            None => true,
            Some(l) => now >= l.expires_at,
        };
        if !free {
            return Claim::Held;
        }
        let token = self.next_token;
        self.next_token += 1;
        self.leases.insert(
            run_id,
            Lease { holder: worker, expires_at: now + ttl, fencing_token: token },
        );
        Claim::Granted { fencing_token: token }
    }

    // A live worker renews before expiry to keep the job. Renewal is rejected
    // if the caller is no longer the holder (it already lost the lease).
    pub fn renew(&mut self, run_id: u64, worker: u64, now: u64, ttl: u64) -> bool {
        match self.leases.get_mut(&run_id) {
            Some(l) if l.holder == worker && now < l.expires_at => {
                l.expires_at = now + ttl;
                true
            }
            _ => false,
        }
    }
}

// Next fire time for a fixed-interval schedule, collapsing every missed slot
// into one hop. After downtime this fires ONCE and realigns, instead of firing
// once per missed slot (a thundering-herd catch-up).
pub fn next_fire(last_fire: u64, interval: u64, now: u64) -> u64 {
    if interval == 0 {
        return now;
    }
    let mut next = last_fire + interval;
    if next <= now {
        let missed = (now - last_fire) / interval;
        next = last_fire + (missed + 1) * interval;
    }
    next
}
```

## When to use it

- Scheduled or delayed jobs must run reliably even if a scheduler instance or a
  worker fails mid-job.
- A job must run on exactly one worker per scheduled occurrence — duplicate
  execution would have real side effects.
- Job volume or execution time requires distributing work across many worker
  machines rather than one.
- You need recurring cron *and* one-off delayed jobs *and* retries managed by
  one durable, observable system rather than scattered ad-hoc timers.

## When not to use it

- A single cron job on a single box, with occasional missed runs an acceptable
  risk, is sufficient for the workload's importance.
- Jobs are naturally idempotent and cheap enough that occasional duplicate
  execution from a simpler at-least-once scheme causes no real harm — the added
  coordination machinery isn't worth it.
- The work is really an immediate reaction to an event, not a time-based
  schedule — a [message queue](/docs/patterns/building-blocks/distributed-message-queue)
  with [competing consumers](/docs/patterns/batch-streaming/competing-consumers)
  fits better than a scheduler.

## Use-case scenarios

**Billing and invoicing runs.** A subscription platform charges thousands of
customers on their renewal dates. A distributed scheduler dispatches each
renewal as a run with a unique id; leader election ensures one scheduler
dispatches, leases ensure one worker charges each customer, and the charge is
idempotent on the run id so a lease expiry during a slow payment call never
double-charges. Failed charges retry with backoff and, after a cap, are parked
for the dunning team — never retried into oblivion.

**Delayed and reminder workloads.** A messaging app schedules "remind me in 3
days" and "send this at 9am in the recipient's timezone" jobs. These land in a
delay queue indexed by `due_at`; workers poll for due runs, claim them under a
lease, and fire. Timezone and clock-skew handling live in the `due_at`
computation, not in per-worker local clocks, so a drifting worker can't fire a
reminder early.

**Batch pipeline orchestration.** A data platform runs nightly ETL DAGs across
a worker pool (the Airflow/Kubernetes-CronJob shape). The scheduler tracks
task-level state in a metadata database, dispatches ready tasks respecting
dependencies, and relies on cluster leader election so only one controller
triggers each scheduled DAG run. After a controller outage, missed-run handling
backfills skipped occurrences deliberately rather than replaying every missed
tick at once and stampeding the warehouse.

## Production libraries & getting started

Options range from durable-workflow engines (Temporal) to queue-backed job runners (BullMQ, Celery, asynq, apalis) and DAG/cron schedulers (Airflow, Quartz).

| Library / Tool | Language / Role | What it gives you | Getting started |
| --- | --- | --- | --- |
| Temporal | JS/Go/Python/Rust | Durable workflows with retries and timers | [Develop docs](https://docs.temporal.io/develop) · [TS quickstart](https://docs.temporal.io/develop/typescript/core-application) |
| BullMQ | JS/TS (Redis) | Redis-backed queues, delayed and repeatable jobs | [BullMQ docs](https://docs.bullmq.io/) |
| apalis | Rust (Redis/SQL) | Background job processing framework | [docs.rs/apalis](https://docs.rs/apalis/latest/apalis/) |
| asynq | Go (Redis) | Distributed task queue with scheduling | [asynq](https://github.com/hibiken/asynq) |
| Celery | Python | Distributed task queue with beat scheduler | [Introduction](https://docs.celeryq.dev/en/stable/getting-started/introduction.html) |
| Apache Airflow | Python (DAGs) | Scheduled workflow orchestration | [Getting started](https://airflow.apache.org/docs/apache-airflow/stable/start.html) |
| Quartz | Java | Cron/interval job scheduling | [Quartz docs](https://www.quartz-scheduler.org/documentation/) |

## Related patterns

- [Leader Election](/docs/patterns/consistency/leader-election) — the coordination primitive that guarantees a single scheduler dispatches each run, avoiding duplicate execution.
- [Failover](/docs/patterns/reliability/failover) — the standby-promotion and fencing discipline that keeps scheduling alive when the active scheduler instance dies.
- [Idempotency](/docs/patterns/reliability/idempotency) — the property that makes at-least-once job execution safe when a lease expires on a slow (not dead) worker.
- [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff) — how failed jobs are re-attempted with increasing, jittered delays rather than hammering a struggling dependency.
- [Sequencer](/docs/patterns/building-blocks/sequencer) — generates the unique run ids each scheduled occurrence needs for leasing and deduplication.
- [Priority Queue](/docs/patterns/batch-streaming/priority-queue) — the ordering mechanism a scheduler uses when urgent jobs must preempt bulk work.

## Further reading

- [Job scheduler — Wikipedia](https://en.wikipedia.org/wiki/Job_scheduler)
- [Leader election — Wikipedia](https://en.wikipedia.org/wiki/Leader_election)
- [Martin Kleppmann: how to do distributed locking (fencing tokens)](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)
- [Apache Airflow: architecture overview](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/overview.html)
- [Kubernetes CronJob documentation](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)
