---
title: "Feature Flags"
sidebar_position: 5
supplementary: true
---

Feature flags (feature toggles) decouple deploying code from releasing a
feature: new code ships behind a runtime-toggleable flag, "dark," and can
later be enabled for specific users, a percentage of traffic, or specific
environments without a new deployment.

## Problem it solves

Without flags, a deploy and a release are the same event — merging code
and shipping it to every user happen together. That forces long-lived
feature branches (which drift from main and get painful to merge) or
accepts that every merge to main is immediately live for all users. Both
options create risk: a half-finished feature either can't be merged yet,
or gets exposed to production before it's ready. Feature flags let code
merge to main and deploy continuously while the decision of who sees the
feature, and when, is made independently at runtime.

## How it works

New code is wrapped in a conditional that checks a flag's state, usually
via a flag-evaluation client that queries a flag service or config
store. The flag can be toggled without redeploying the service: off for
everyone, on for an internal allow-list, on for a percentage of traffic,
or on only in specific environments. Because the check happens at
runtime, the same deployed binary can serve different behavior to
different users simultaneously, and a flag can be flipped off instantly
if the new code causes a problem — a rollback that doesn't require
touching the deployment pipeline at all.

## When to use it

- Trunk-based development is desired: merging incomplete features to
  main continuously without exposing them to users yet.
- A feature needs to be released gradually to a subset of users
  (percentage rollout, beta cohort, internal dogfooding) independent of
  infrastructure-level traffic splitting.
- Instant kill-switch behavior is valuable — being able to disable a
  problematic feature without a deploy or rollback.

## When not to use it

- Flags left in code after a feature is fully rolled out and stable
  accumulate as tech debt: each one is a permanent branch point that
  must be tested, and unused flags make code harder to read and reason
  about. Flags need an owner and a removal step once a decision (ship
  fully, or remove) has been made.
- A large number of simultaneously active flags multiplies the number of
  effective code paths in production, some combinations of which may
  never get tested together.
- For infrastructure-level rollout of an entire service version (rather
  than a single feature within it), canary or blue-green deployment is
  usually a better-fitting tool.

## Real-world example

Feature flag platforms such as LaunchDarkly are widely used to manage
percentage-based rollouts and instant kill-switches for features across
mobile and backend services without requiring a new app release or
deploy for each targeting change.

## Related patterns

- [Canary Deployment](/docs/patterns/observability/canary-deployment) — infrastructure-level traffic shifting; feature flags provide a finer-grained, application-level equivalent.
- [Blue-Green Deployment](/docs/patterns/observability/blue-green-deployment) — a deployment-time rollback mechanism, complementary to flags' runtime one.

## Further reading

- [Feature toggle — Wikipedia](https://en.wikipedia.org/wiki/Feature_toggle)
- [FeatureToggle — Martin Fowler](https://martinfowler.com/articles/feature-toggles.html)
