---
title: "API Gateway"
sidebar_position: 1
supplementary: true
---

An API gateway is a single entry point that sits in front of a set of
backend services, handling cross-cutting concerns — authentication, rate
limiting, routing, and request/response transformation — so individual
services don't each have to reimplement them.

## Problem it solves

When clients call backend services directly, every service ends up
duplicating the same plumbing: verifying auth tokens, enforcing rate
limits, logging requests, and translating between the client's preferred
protocol and whatever the service speaks internally. That duplication is
error-prone (each team implements auth slightly differently) and it
leaks internal topology to the outside world — clients need to know
which of dozens of services to call for which piece of functionality,
and any internal refactor (splitting or merging services) becomes a
breaking change for every client.

## How it works

Clients send all requests to the gateway instead of to individual
services. The gateway authenticates the request, checks it against rate
limits, and looks up a routing rule to decide which backend service (or
services) should handle it. It forwards the request, optionally
transforming the payload (e.g. combining responses from several
services, or translating a client-friendly JSON shape into whatever an
internal service expects), and returns the result. Because the gateway
sees every request, it's also a natural place to centralize logging,
metrics, and API versioning. It can be a single shared component, or —
in stricter designs — split per client type (see [Backend for
Frontend](/docs/patterns/api-edge/backend-for-frontend)).

## When to use it

- Multiple independent client types (web, mobile, partners) need a
  stable, unified entry point into a system built from many services.
- Cross-cutting concerns (auth, rate limiting, TLS termination) should
  be enforced consistently in one place rather than reimplemented per
  service.
- You want to hide internal service topology so it can evolve — split,
  merge, or rewrite services — without breaking external clients.

## When not to use it

- A small system with one or two services gets little benefit from an
  extra network hop and a new component to operate.
- The gateway is at risk of accumulating actual business logic (not
  just routing/auth) — once that happens it becomes a monolithic
  bottleneck that every team must coordinate changes through, which
  defeats the purpose of having independently deployable services
  behind it.
- Extremely latency-sensitive internal service-to-service calls, where
  the added hop through the gateway isn't justified.

## Real-world example

Amazon API Gateway is a managed service for creating, publishing, and
securing REST, HTTP, and WebSocket APIs in front of backend compute
(Lambda, EC2, or any HTTP endpoint), handling authorization, throttling,
and monitoring centrally. Kong is a widely used open-source/self-hosted
API gateway offering the same category of routing, auth, and rate
limiting as a plugin-based proxy in front of microservices.

## Related patterns

- [Reverse Proxy](/docs/concepts/reverse-proxy) — the primer's broader
  treatment of the proxying mechanism an API gateway is built on.
- [Backend for Frontend](/docs/patterns/api-edge/backend-for-frontend) —
  a variant that splits the gateway per client type instead of sharing
  one gateway across all clients.

## Further reading

- [API management — Wikipedia](https://en.wikipedia.org/wiki/API_management)
- [What is Amazon API Gateway? — AWS docs](https://docs.aws.amazon.com/apigateway/latest/developerguide/welcome.html)
