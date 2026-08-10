---
title: "Horizontal Scaling"
sidebar_position: 2
supplementary: true
---

Horizontal scaling (scaling out) increases capacity by adding more
machines to a pool that share the load, rather than making any one
machine bigger.

## Problem it solves

Vertical scaling runs into a hard ceiling: there is always a biggest
instance type or piece of hardware available, and a single machine is
always a single point of failure. Horizontal scaling solves both
problems at once — capacity grows by adding commodity machines instead
of chasing a bigger one, and because there are now multiple machines,
the loss of any one of them doesn't take the whole service down.

## How it works

Instead of one machine handling all requests or all data, work is spread
across a fleet. For request-serving workloads, this requires the
machines to be stateless (or to treat any local state as disposable
cache), so a load balancer can route any incoming request to any
instance interchangeably. For data-holding workloads, this instead
requires partitioning the dataset — via sharding — so each machine owns
a disjoint slice of it rather than every machine holding a full copy.
Either way, the machines have to coordinate: stateless fleets need a
load balancer and health checks; partitioned data needs a routing layer
that knows which shard owns which key, and the shards themselves add
operational surface area (rebalancing, cross-shard queries).

## When to use it

- Load is expected to keep growing past what any single machine could
  handle, so a scaling strategy with no theoretical ceiling is needed.
- High availability matters — the fleet should keep serving traffic even
  if individual instances fail or are taken down for maintenance.
- The workload (or the data) can be made stateless, cacheable, or
  partitionable without requiring strong coordination on every request.

## When not to use it

- The application holds significant in-process state that's expensive to
  externalize (sessions, in-memory caches, sticky connections) and
  there's no time or need to refactor it to be stateless first.
- The workload is inherently hard to partition — for example, a
  workload that requires strongly consistent, low-latency access to the
  same small dataset from every node, where cross-node coordination
  overhead would exceed the benefit of adding nodes.
- The current load fits comfortably on a single, larger machine, and the
  added operational complexity (load balancing, service discovery,
  partition rebalancing) isn't worth it yet.

## Real-world example

A typical stateless web-server fleet behind a load balancer is the
canonical case: any of dozens or hundreds of identical application server
instances can handle any incoming HTTP request, because none of them
hold request-specific state locally — session data lives in a shared
store, and static assets are served from shared or replicated storage.
The load balancer distributes traffic across the fleet and routes around
instances that fail health checks, so adding capacity is a matter of
launching more identical instances rather than resizing an existing one.

## Related patterns

- [Vertical Scaling](/docs/patterns/scaling/vertical-scaling) — the
  simpler alternative of making one machine bigger instead of adding
  more; often applied first before horizontal scaling becomes necessary.
- [Load Balancer](/docs/concepts/load-balancer) — the primer's treatment
  of the component that distributes requests across a horizontally
  scaled fleet.
- [Sharding](/docs/patterns/storage/sharding) — the data-partitioning
  technique that makes horizontal scaling possible for stateful,
  data-holding systems like databases.

## Further reading

- [Scalability — Wikipedia](https://en.wikipedia.org/wiki/Scalability)
- [Elastic Load Balancing — AWS documentation](https://docs.aws.amazon.com/elasticloadbalancing/latest/userguide/what-is-load-balancing.html)
