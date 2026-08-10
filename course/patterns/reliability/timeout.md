---
title: "Timeout"
sidebar_position: 1
supplementary: true
---

A timeout bounds how long a caller will wait for a dependency to respond
before giving up and treating the call as failed, rather than waiting
indefinitely for a reply that may never come.

## Problem it solves

Without a timeout, a caller blocked on a slow or hung dependency holds
onto whatever resource it used to make that call — a thread, a database
connection, a socket — for as long as the dependency takes to respond,
which in a failure scenario can be forever. As concurrent requests pile
up waiting on the same struggling dependency, the caller exhausts its own
thread pool or connection pool. New requests then queue behind the
exhausted pool, and the caller itself becomes slow or unresponsive to
*its* callers. A single slow dependency several hops downstream can
cascade into an outage across the whole call chain, even though every
individual service is technically "up."

## How it works

The caller sets a maximum duration for a call — a network request, a
database query, a lock acquisition — and if no response arrives within
that window, it aborts the call and returns control to its own logic,
typically raising or returning an error that the caller can then handle
(retry, fall back, or propagate the failure). This bounds resource
holding time and turns an indefinite hang into a fast, predictable
failure. Timeouts are usually layered: a connect timeout (time to
establish a connection) is often shorter than a read/response timeout
(time to receive the actual reply).

Picking the value matters as much as having one at all. A timeout set
by guesswork is either so long it doesn't prevent resource exhaustion,
or so short it trips on normal, healthy latency. The right approach is
to base it on the dependency's own published or measured SLA — for
example, if a service's p99 latency is documented or observed at 300ms,
a timeout of 500ms–1s gives headroom for normal variance while still
failing fast well before it would cause pool exhaustion upstream.

## When to use it

- On every call to a remote dependency — network, database, downstream
  service, external API — with no exceptions, since any of these can
  hang.
- Anywhere a shared, finite resource (thread, connection) is held for
  the duration of the call.
- As the foundational layer beneath retry and circuit-breaker logic,
  which both depend on calls failing fast enough to act on.

## When not to use it

- A timeout so aggressive it fires under normal load variance just
  converts transient slowness into outright failures — this is worse
  than no protection if it isn't paired with sensible retry logic.
- It isn't a substitute for addressing the underlying slow dependency;
  it only bounds the blast radius of the caller, not the root cause.

## Real-world example

Most HTTP client libraries (for example Java's `HttpClient`, Go's
`net/http`, and browsers' `fetch`) ship with no timeout, or an
effectively infinite one, by default — which is a well-known source of
production incidents. Production guidance for essentially every major
HTTP client and cloud SDK explicitly recommends setting connect and
read timeouts explicitly rather than relying on defaults.

## Related patterns

- [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff) — what a caller does after a timeout fires.
- [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) — stops calling a dependency altogether once its timeouts/failures cross a threshold.

## Further reading

- [Timeout (computing) — Wikipedia](https://en.wikipedia.org/wiki/Timeout_(computing))
- [Circuit Breaker pattern — martinfowler.com](https://martinfowler.com/bliki/CircuitBreaker.html)
