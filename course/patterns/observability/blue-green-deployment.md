---
title: "Blue-Green Deployment"
sidebar_position: 3
supplementary: true
---

Blue-green deployment runs two identical production environments —
"blue" (currently serving live traffic) and "green" (the new version) —
and cuts traffic over atomically once the new environment is verified,
making rollback as simple as switching back.

## Problem it solves

Deploying a new version in place, instance by instance, means the old
and new code inevitably run side by side for the rollout window, and a
failed deployment can leave the system in a partially-updated, hard to
reason about state. Rolling back usually means re-deploying the previous
version, which takes time — time during which users see a broken
service. Blue-green deployment solves this by never modifying the
environment currently serving traffic: the new version is deployed
somewhere else entirely and only receives real traffic once it's already
running and verified.

## How it works

Two full production environments exist: blue is live, green is idle.
The new release is deployed to green while blue continues serving 100%
of traffic, untouched. Once green passes smoke tests and health checks,
a router (load balancer, DNS, or service mesh) switches all traffic from
blue to green in one atomic step. Blue is kept running, unchanged, for
some window after the switch. If anything goes wrong with green, traffic
is switched back to blue instantly — no redeploy needed, because the
previous known-good version was never touched. Once green has proven
stable, blue can be decommissioned or repurposed as the target for the
next release.

## When to use it

- Fast, low-risk rollback is a hard requirement — the switch back to the
  previous version needs to be near-instant.
- The application can tolerate (or is designed for) two full copies of
  production infrastructure running simultaneously, even briefly.
- Database schema changes for the release are backward-compatible with
  both versions, since both blue and green may need to work against the
  same data store during the transition.

## When not to use it

- Running two complete production environments doubles infrastructure
  cost for the duration of the deployment, which can be significant for
  large or stateful systems.
- Long-lived stateful connections (e.g. WebSocket sessions) don't
  migrate cleanly across an atomic cutover without extra handling.
- If the goal is to validate a change against a small slice of real
  traffic before committing to it fully, blue-green's all-or-nothing
  switch doesn't give that — see canary deployment instead.

## Real-world example

Blue-green deployment is a standard pattern supported natively by
managed platforms; AWS Elastic Beanstalk, for instance, offers a
built-in "swap environment URLs" feature that implements exactly this
blue/green cutover for web application environments.

## Related patterns

- [Canary Deployment](/docs/patterns/observability/canary-deployment) — a gradual alternative to blue-green's instant, all-at-once cutover.
- [Load Balancing](/docs/patterns/api-edge/load-balancing) — the mechanism most commonly used to perform the traffic switch.
- [Health Check](/docs/patterns/observability/health-check) — used to verify the green environment before cutover.

## Further reading

- [Blue-green deployment — Wikipedia](https://en.wikipedia.org/wiki/Blue-green_deployment)
- [BlueGreenDeployment — Martin Fowler](https://martinfowler.com/bliki/BlueGreenDeployment.html)
