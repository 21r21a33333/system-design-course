---
title: "Circuit Breaker"
sidebar_position: 4
supplementary: true
---

A circuit breaker stops a caller from repeatedly invoking a dependency
that has crossed a failure threshold — failing fast instead — and
periodically allows a probe call through to detect recovery, moving
between closed, open, and half-open states.

## Problem it solves

A timeout bounds how long a single call can hang, but it doesn't stop
the caller from dutifully retrying the same failing dependency, request
after request, each one still paying the full timeout cost before
failing. If a downstream service is down or overloaded, every caller
still attempting calls to it is spending threads, connections, and
latency budget on requests that are very likely to fail anyway. That
wasted effort doesn't just fail to help the callee recover — it actively
harms the caller, whose own resources (thread pool, connection pool)
get tied up waiting on calls that were doomed from the start, degrading
the caller's ability to serve any of its own traffic, including
requests that don't even depend on the failing service.

## How it works

A circuit breaker wraps calls to a dependency and tracks recent
failures. It has three states:

- **Closed** — the normal state. Calls pass through to the dependency,
  and failures are counted. If failures exceed a configured threshold
  (e.g. 50% of the last 20 calls), the breaker trips to open.
- **Open** — calls are rejected immediately, without attempting to
  reach the dependency at all, typically returning a fast error or a
  fallback value. After a cooldown period, the breaker moves to
  half-open.
- **Half-open** — a limited number of trial calls are allowed through.
  If they succeed, the breaker closes and normal traffic resumes; if
  they fail, it reopens and the cooldown restarts.

This is the key distinction from a plain timeout: a timeout still
attempts every call and only bounds how long each one takes to fail; a
circuit breaker in the open state skips the attempt entirely, protecting
the caller's own resources the moment a dependency is known to be
unhealthy, and only spends resources probing occasionally rather than
on every request.

## When to use it

- Calls to a remote dependency that can fail for an extended period
  (not just a single transient blip), where continuing to call it adds
  no value and only consumes caller resources.
- Any dependency whose failure could otherwise cascade upstream through
  resource exhaustion in the caller.
- Paired with a fallback response (cached data, a default value, a
  degraded experience) so tripping the breaker doesn't just convert one
  failure mode into another.

## When not to use it

- Low-volume or non-critical internal calls where the added complexity
  (state tracking, tuning thresholds, monitoring trip events) isn't
  worth it.
- As a substitute for actually fixing a chronically failing dependency
  — it manages the symptom for callers, not the root cause.

## Real-world example

Netflix's Hystrix library popularized the circuit breaker pattern for
modern microservice architectures, wrapping calls to downstream
services with configurable failure thresholds, fallbacks, and
open/half-open/closed state tracking to prevent cascading failures
across Netflix's service graph. Though Hystrix itself is no longer
actively developed, its design directly shaped later libraries like
resilience4j.

## Related patterns

- [Timeout](/docs/patterns/reliability/timeout) — bounds a single call; a circuit breaker decides whether to attempt the call at all.
- [Bulkhead](/docs/patterns/reliability/bulkhead) — often paired with a circuit breaker so failures in one dependency's isolated resources trip its own breaker without touching others.

## Further reading

- [CircuitBreaker — martinfowler.com](https://martinfowler.com/bliki/CircuitBreaker.html)
- [Circuit breaker design pattern — Wikipedia](https://en.wikipedia.org/wiki/Circuit_breaker_design_pattern)
