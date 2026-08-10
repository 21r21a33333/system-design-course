---
title: "Graceful Degradation"
sidebar_position: 7
supplementary: true
---

Graceful degradation means serving a reduced but still-useful version
of a response when a non-critical dependency fails, rather than failing
the entire request just because one of many things it depends on is
unavailable.

## Problem it solves

A single request often touches several dependencies of very different
importance — a page might need the primary content from one service,
but also personalization data, recommendations, or analytics from
others. If the request handler treats every dependency as equally
required, then the least critical one becomes an unnecessary single
point of failure for the entire request: a recommendation service
having a bad day takes down the ability to view a product at all, even
though recommendations were never essential to that core function. This
wastes the value of having a mostly-healthy system — most of what the
user needs is available, but a rigid all-or-nothing request handler
throws it away because of one unrelated failure.

## How it works

The prerequisite is deciding, up front and deliberately, which
dependencies are critical (the request cannot succeed meaningfully
without them) and which are non-critical (nice to have, but the request
still delivers real value without them). For non-critical dependencies,
the caller wraps the call so that a failure — or a timeout — results in
a fallback: a cached previous value, a default/empty state, or simply
omitting that part of the response, instead of propagating the failure
and aborting the whole request. Critical dependencies don't get this
treatment — if the core data source is down, there usually isn't a
meaningful reduced version of the response to serve, and failing
outright (or via a circuit breaker's fallback) is the honest answer.

This distinction has to be made explicitly for each dependency; treating
everything as critical by default defeats the purpose, and treating
everything as non-critical risks serving a broken or misleading
response when something that actually mattered failed silently.

## When to use it

- User-facing requests that aggregate data from multiple independent
  backend services, where some enhance the experience but aren't
  strictly required for it to be useful.
- Systems where availability of a reduced experience is preferable to
  strict all-or-nothing correctness — most consumer-facing products.
- Paired with circuit breakers and timeouts on each non-critical
  dependency, so a hung or failing dependency degrades that one piece
  quickly rather than stalling the whole request.

## When not to use it

- Dependencies that are actually load-bearing for correctness — silently
  degrading a payment or authorization check to "assume success" isn't
  graceful, it's a correctness bug wearing a resilience pattern's
  clothing.
- Situations where a degraded response would mislead the user in a
  harmful way (e.g. showing stale pricing as if it were current) rather
  than simply omitting the unavailable piece.

## Real-world example

An e-commerce product page typically depends on several backend calls:
core product data (title, price, description) and, separately, a
recommendation service for "customers also bought" suggestions. If the
recommendation service is slow or down, a gracefully degraded page
still renders the product and lets the customer buy it — it simply
omits the recommendations section — rather than failing the entire page
load over a service that was never essential to completing a purchase.

## Related patterns

- [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) — the mechanism that typically detects a non-critical dependency's failure and triggers the fallback path.

## Further reading

- [Fault tolerance — Wikipedia](https://en.wikipedia.org/wiki/Fault_tolerance)
- [Fail-safe — Wikipedia](https://en.wikipedia.org/wiki/Fail-safe)
