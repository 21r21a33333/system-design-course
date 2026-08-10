---
title: "Distributed Task Scheduler"
sidebar_position: 10
supplementary: true
---

A distributed task scheduler reliably runs scheduled or delayed jobs
across a fleet of workers, ensuring each job runs on exactly one worker
even when multiple scheduler instances are running for availability,
and recovering cleanly when a worker fails mid-job.

## Problem it solves

A single cron process on one box is a single point of failure — if that
box goes down, every scheduled job silently stops running until someone
notices. The obvious fix, running the scheduler on multiple machines
for redundancy, immediately creates a new problem: if every instance
independently decides "it's time to run this job," the job runs
multiple times instead of zero times, which is just as broken for
jobs that aren't safe to duplicate (charging a customer, sending a
notification, generating a report). A distributed task scheduler is
built specifically to give you both — redundancy across scheduler
instances and exactly-one-worker execution per job.

## How it works

The core mechanism for avoiding duplicate execution is coordination
between scheduler instances via leader election or a distributed lock:
either one instance is elected leader and is the only one that actually
dispatches jobs (with a standby ready to take over if the leader fails),
or every instance can attempt to claim a specific job run via a
short-lived lock, and only the instance that wins the lock executes it.
Both approaches rely on the same underlying primitive — a coordination
service (like a consensus-backed key-value store) that guarantees only
one participant can hold a given lock or leadership term at a time.

Worker-failure handling is a separate concern from scheduler
redundancy: once a job has been dispatched to a worker, that worker can
still crash mid-execution. Schedulers handle this with a lease — the
worker holds the job with a time-bounded lease it must periodically
renew while working; if the lease expires without renewal, the
scheduler assumes the worker died and reassigns the job to another
worker. This is why jobs run by these systems generally need to be
idempotent or safely retryable: a lease can expire due to a slow
worker, not just a dead one, so the same job might occasionally be
picked up twice.

## When to use it

- Scheduled or delayed jobs must run reliably even if a scheduler
  instance or a worker fails mid-job.
- A job must run on exactly one worker per scheduled occurrence —
  duplicate execution would have real side effects.
- Job volume or execution time requires distributing work across many
  worker machines rather than one.

## When not to use it

- A single cron job on a single box, with occasional missed runs being
  an acceptable risk, is sufficient for the workload's importance.
- Jobs are naturally idempotent and cheap enough that occasional
  duplicate execution from a simpler at-least-once scheme causes no
  real harm — the added coordination machinery isn't worth it.

## Real-world example

Apache Airflow schedules and executes DAGs of tasks across a worker
pool, using a metadata database and executor coordination to avoid
duplicate task execution. Kubernetes CronJobs schedule containerized
jobs cluster-wide, relying on the cluster's own leader election among
controller-manager instances to ensure only one triggers each
scheduled run.

## Related patterns

- [Sequencer](/docs/patterns/building-blocks/sequencer) — distributed
  schedulers often need uniquely identified job-run instances, similar
  to the ID-generation problem a sequencer solves.

## Further reading

- [Job scheduler — Wikipedia](https://en.wikipedia.org/wiki/Job_scheduler)
- [Leader election — Wikipedia](https://en.wikipedia.org/wiki/Leader_election)
