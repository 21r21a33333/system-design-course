---
title: "Bulkhead"
sidebar_position: 5
supplementary: true
---

The bulkhead pattern isolates the resources — thread pools, connection
pools, queues — used to call each dependency, so that one dependency
failing or slowing down can't exhaust the resources needed to keep
calling the others.

## Problem it solves

A service that calls several downstream dependencies from a single
shared thread pool has an implicit coupling between them: if one
dependency becomes slow or unresponsive, every thread that calls it can
end up blocked waiting on it. Once enough threads are stuck, the shared
pool is exhausted, and calls to completely unrelated, perfectly healthy
dependencies start failing too — not because they're broken, but
because there's no thread left available to make the call. A single
slow dependency ends up taking the whole service down with it, even
though most of the service's functionality had nothing to do with that
dependency.

## How it works

Instead of one shared pool of resources for all outbound calls, each
dependency (or each class of dependency) gets its own dedicated,
bounded pool — its own thread pool, its own connection pool, its own
request queue with its own size limit. If Dependency A's pool is fully
occupied by slow or hung calls, Dependency B's calls are entirely
unaffected because they draw from a separate pool with its own limit.
The failure is contained within the compartment it started in rather
than spreading. The name comes directly from ship design: a ship's hull
is divided into watertight compartments (bulkheads) so that a breach in
one compartment floods only that section instead of sinking the whole
vessel.

The tradeoff is resource overhead and tuning burden — every isolated
pool needs to be sized appropriately (too small and it becomes a
bottleneck under normal load; too large and the isolation benefit is
diluted along with wasting resources), and more pools means more
configuration and monitoring surface.

## When to use it

- A service calls multiple independent downstream dependencies with
  different reliability or latency characteristics, and a failure in
  one shouldn't be able to affect calls to the others.
- High-value or high-volume dependencies that deserve resource
  guarantees separate from lower-priority ones.
- Typically combined with a circuit breaker per isolated pool, so each
  compartment can also fail fast independently.

## When not to use it

- A service with only one downstream dependency, or dependencies with
  no meaningfully different risk profiles — there's nothing to isolate
  from what.
- Extremely resource-constrained environments where the overhead of
  maintaining multiple separate pools (rather than one shared, larger
  one) isn't affordable.

## Real-world example

Hystrix-style resilience libraries implement the bulkhead pattern by
giving each downstream service call its own dedicated thread pool (or
a semaphore-based limit) sized independently, so that a hang in one
downstream call consumes only its own pool's capacity rather than
starving threads that other, unrelated downstream calls depend on.

## Related patterns

- [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) — commonly applied per bulkhead compartment so each isolated pool also fails fast.

## Further reading

- [Bulkhead (partition) — Wikipedia](https://en.wikipedia.org/wiki/Bulkhead_(partition))
- [Bulkhead pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/bulkhead)
