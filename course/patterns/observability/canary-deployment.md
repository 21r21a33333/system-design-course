---
title: "Canary Deployment"
sidebar_position: 4
supplementary: true
---

Canary deployment rolls out a new version to a small percentage of
traffic or instances first, monitors error rates and latency, and
gradually increases exposure — rather than switching all traffic at once
the way blue-green deployment does.

## Problem it solves

Even a release that passes every automated test and staging check can
still fail against real production traffic patterns, data shapes, or
load that staging never reproduced exactly. Blue-green's atomic cutover
means the very first sign of such a problem is already affecting 100% of
users. Canary deployment solves this by exposing the new version to only
a small, controlled slice of real traffic first, so a bad release is
caught while it's only affecting a fraction of users — and can be pulled
back before it ever reaches everyone.

## How it works

The new version is deployed alongside the old one, but the router sends
it only a small percentage of traffic (e.g. 1-5%) — the "canary" slice —
while the rest continues to hit the stable version. Error rates,
latency, and other key metrics for the canary are compared against the
baseline. If the canary looks healthy, its traffic share is increased in
stages (e.g. 5% → 25% → 50% → 100%), with a monitoring pause at each
step. If at any stage the canary's metrics degrade, traffic is routed
back to the stable version and the rollout is aborted, having limited
the blast radius to whatever percentage was live at that point.

## When to use it

- The team wants to validate a release against genuine production
  traffic and data before committing to a full rollout.
- Automated metrics (error rate, latency, business KPIs) exist and are
  reliable enough to make an automatic promote/abort decision at each
  stage.
- The risk of a subtly bad release is high enough that limiting its
  blast radius is worth a slower rollout.

## When not to use it

- Running two versions simultaneously for an extended rollout period
  costs more operationally than a fast, all-at-once switch, and requires
  both versions to be compatible with the same downstream data and APIs
  for longer.
- If instant, complete rollback is the priority and gradual traffic
  shifting isn't needed, blue-green is simpler.
- Without good automated metrics to gate each stage, canary rollout
  becomes a manual, slow, and error-prone process.

## Real-world example

Managed traffic-shifting features — such as AWS CodeDeploy's linear and
canary deployment configurations for Lambda and ECS — implement this
pattern by shifting a specified percentage of traffic to the new version
on a schedule and rolling back automatically if configured CloudWatch
alarms fire.

## Related patterns

- [Blue-Green Deployment](/docs/patterns/observability/blue-green-deployment) — the all-at-once alternative canary deployment trades speed for safety against.
- [Health Check](/docs/patterns/observability/health-check) — one input to the metrics gating each stage of the rollout.
- [Feature Flags](/docs/patterns/observability/feature-flags) — a complementary, finer-grained way to control exposure independent of infrastructure-level traffic splitting.

## Further reading

- [Feature toggle — Wikipedia](https://en.wikipedia.org/wiki/Feature_toggle)
- [CanaryRelease — Martin Fowler](https://martinfowler.com/bliki/CanaryRelease.html)
