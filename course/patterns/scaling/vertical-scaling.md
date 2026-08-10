---
title: "Vertical Scaling"
sidebar_position: 1
supplementary: true
---

Vertical scaling (scaling up) increases the capacity of a single existing
machine — more CPU, RAM, disk, or network throughput — rather than adding
more machines to share the load.

## Problem it solves

An application outgrows the resources of the box it runs on: CPU is
pegged, memory is exhausted, or disk I/O can't keep up with request
volume. The simplest possible fix, with no code changes and no new
coordination logic, is to move the workload to a bigger machine. For a
single-instance database, a monolith, or any service that isn't (yet)
built to run as multiple cooperating replicas, vertical scaling is often
the first scaling lever pulled because it requires nothing more than a
resize and a restart.

## How it works

The application, and typically its data, stay on one machine. To scale
up, that machine's instance type or hardware spec is changed to one with
more cores, memory, faster storage, or better network bandwidth — either
by resizing a cloud instance (a brief restart) or by physically upgrading
on-prem hardware. Nothing about the application's architecture changes:
there's still exactly one process (or one primary process) handling all
the work, just with more resources underneath it.

## When to use it

- The system is a single-node component — a primary database, a legacy
  monolith — that wasn't designed to be horizontally distributed.
- Current load is close to, but still under, the ceiling of larger
  available hardware, and buying time with a resize is cheaper than a
  distributed-architecture rewrite.
- Simplicity matters more than headroom: no partitioning logic, no
  load-balancer configuration, no consistency concerns across replicas.

## When not to use it

- Load is expected to keep growing past what the largest available
  instance type can offer — vertical scaling has a hard ceiling; there is
  always a biggest machine you can buy or rent, and eventually you hit it.
- High availability is required: a single scaled-up machine is still a
  single point of failure — if it goes down, the whole service goes down,
  regardless of how much CPU or RAM it had.
- The workload is spiky or unpredictable — resizing typically requires a
  restart, so it doesn't help with sudden, short-lived traffic spikes.

## Real-world example

A common pattern with Amazon RDS is bumping a database from a smaller
instance class (e.g. `db.t3.medium`) to a larger one (e.g.
`db.r6g.2xlarge`) when CPU or memory utilization consistently runs high.
The change gives the database more compute and memory to work with, but
the database is still a single instance — RDS multi-AZ deployments and
read replicas are the separate mechanisms used to address availability
and read throughput, not the instance-class resize itself.

## Related patterns

- [Horizontal Scaling](/docs/patterns/scaling/horizontal-scaling) — the
  alternative that adds more machines instead of a bigger one, avoiding
  vertical scaling's hard ceiling and single-point-of-failure risk.

## Further reading

- [Scalability — Wikipedia](https://en.wikipedia.org/wiki/Scalability)
- [Amazon RDS DB instances — AWS documentation](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Overview.DBInstance.html)
