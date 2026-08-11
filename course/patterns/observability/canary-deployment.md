---
title: "Canary Deployment"
sidebar_position: 4
supplementary: true
---

Canary deployment releases a new version to a small percentage of traffic
first — the "canary" slice — compares its error rate, latency, and business
metrics against the unchanged baseline, and only then ramps exposure up in
stages (for example 1% → 5% → 25% → 100%), automatically rolling back if the
canary's metrics degrade, so a bad release is caught while it affects a
fraction of users rather than all of them.

![Canary Deployment diagram](/img/patterns/canary-deployment.svg)

## Problem it solves

A release can pass every automated test and every staging check and still
fail against production — because production has traffic patterns, data
shapes, request mixes, and load that staging never reproduced exactly. A
[blue-green](/docs/patterns/observability/blue-green-deployment) cutover's
all-at-once switch means the very first sign of such a problem is already
hitting 100% of users; its safety net is speed of rollback, not limited
exposure. Canary attacks the exposure directly: send the new version a small,
controlled slice of *real* traffic first, watch how it actually behaves, and
keep the blast radius bounded to that slice until the metrics earn a bigger
one. A load-sensitive or data-sensitive defect that staging missed is caught
while it is degrading 5% of requests, not all of them.

## Technical architecture & implementation

**Weighted routing.** Both versions run at once, and a traffic director — a
load balancer, a [service mesh](/docs/patterns/api-edge/service-mesh), or an
ingress controller — splits requests by *weight*: 5% to the canary, 95% to
the baseline. The mesh/LB weight is the control knob the whole rollout turns.

**Sticky routing.** Splitting purely per-request would flip an individual
user between versions request to request, which corrupts both their
experience and the comparison. Real canaries route **stickily**: a stable key
(user id, session) is hashed into a fixed bucket, so a given user stays on one
version for the whole stage. Raising the weight only ever *adds* users to the
canary — nobody who was on it falls back — which keeps the ramp monotone and
the analysis clean.

**Canary analysis — the comparison, not just a threshold.** The decision to
promote or abort is made by comparing the canary's metrics against the
baseline *running at the same time*, not against a fixed number. Error rate,
p50/p99 latency, saturation, and business KPIs (checkout rate, sign-ups) are
sampled for both populations; because they take the same live traffic, a
region-wide slowdown or a traffic spike moves *both* and does not falsely
condemn the canary. This baseline-relative comparison is what
[automated canary analysis](#automated-canary-analysis) formalizes.

**Ramp, sizing, and duration.** The canary must be **big enough and run long
enough** to gather statistically meaningful signal — 1% of traffic for thirty
seconds tells you almost nothing about a defect that shows up one request in a
thousand. Each stage holds for a soak window during which analysis runs; a
healthy verdict promotes to the next weight, an unhealthy one aborts. Too
small or too short and real regressions slip through unnoticed; too large or
too slow and you have surrendered much of the blast-radius benefit and made
releases painfully slow.

**Automatic rollback.** If any stage's analysis fails, the router shifts the
canary weight back to zero and the rollout stops — exposure was capped at
whatever slice was live when the problem appeared. Because both versions were
already running, abort is a weight change, not a redeploy.

**Failure modes.** The sharpest one is **underpowered analysis**: a canary too
small, too brief, or watching the wrong metrics passes a release that then
fails at 100% — the ramp gave false confidence. **Non-sticky routing**
scrambles the comparison and the user experience. And like blue-green, canary
runs two versions against shared downstream state, so both must stay
compatible with the *same* database and APIs for the whole (longer) rollout —
the expand/contract discipline from the blue-green page applies here too, and
for *longer*, since both versions coexist across every stage.

**Where it sits among siblings.** Canary targets by **traffic percentage** and
ramps gradually while watching metrics.
[Blue-green](/docs/patterns/observability/blue-green-deployment) switches
*everyone* at once and relies on instant rollback.
[Feature flags](/docs/patterns/observability/feature-flags) operate a layer up:
they gate a *feature* inside an already-deployed binary and target by user
*attribute* (tier, region, cohort) rather than by raw traffic share — and they
compose with canary, since you can canary the deployment and then flag-gate the
features inside it.

## Blue-green vs canary vs feature flags

| | Blue-green | Canary | Feature flags |
|---|---|---|---|
| **Unit of change** | Whole environment/version | Whole version | Individual feature |
| **Exposure** | 100% at once (atomic switch) | Small % → ramp to 100% | Per user/segment, any % |
| **Targets by** | N/A (all traffic) | Traffic percentage | User attribute + percentage |
| **Rollback** | Flip pointer back to old env | Shift weight back to 0 | Flip flag off — no redeploy |
| **Extra cost** | 2× production for the window | 2 versions for the rollout | Flag debt + eval infra |
| **Decouples deploy from release?** | No | No | **Yes** |
| **Best at** | Instant, all-or-nothing rollback | Catching prod-only defects early | Trunk-based dev, dark launches, A/B |

The three compose: **deploy** a version with blue-green or canary, then
**release** the features inside it with flags.

## Automated canary analysis

Manual "watch the dashboards" gating does not scale and is inconsistent
between operators. **Automated canary analysis (ACA)** — as in Netflix's
Kayenta/Spinnaker or Argo Rollouts' analysis runs — turns the promote/abort
decision into a repeatable judgment:

- **Paired metrics.** For each metric, compare the canary population to the
  baseline population over the same window, so shared external effects cancel
  out.
- **Scoring, not single thresholds.** Combine many metrics into an aggregate
  score (often with statistical tests, e.g. Mann-Whitney) and require the
  score to clear a bar before promotion — one noisy metric does not veto,
  and one flattering metric does not excuse a real regression.
- **Gated ramp.** A passing score advances to the next weight; a failing one
  aborts and rolls traffic back to baseline automatically.

## Code example

The engine of a canary is the weighted, **sticky** router: a request is
mapped to a version by hashing a stable user key, so the same user stays on
one version and the canary receives a predictable share.

```rust
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Version {
    Baseline,
    Canary,
}

pub struct CanaryRouter {
    // Percentage of users pinned to the canary, 0..=100.
    canary_percent: u8,
}

impl CanaryRouter {
    pub fn new(canary_percent: u8) -> Self {
        Self { canary_percent: canary_percent.min(100) }
    }

    // Ramp the canary to the next stage once analysis says it is healthy.
    pub fn promote_to(&mut self, canary_percent: u8) {
        self.canary_percent = canary_percent.min(100);
    }

    // Map a stable user key into a fixed 0..100 bucket, then compare against
    // the weight. Same user + same weight => same version, always.
    pub fn route(&self, user_id: u64) -> Version {
        let mut h = DefaultHasher::new();
        user_id.hash(&mut h);
        let bucket = (h.finish() % 100) as u8;
        match bucket < self.canary_percent {
            true => Version::Canary,
            false => Version::Baseline,
        }
    }
}

fn main() {
    let router = CanaryRouter::new(5);
    let n: u64 = 100_000;
    let canary = (0..n).filter(|&u| router.route(u) == Version::Canary).count();
    println!("canary share at weight 5: {:.2}%", canary as f64 / n as f64 * 100.0);

    // Ramping only *adds* users to the canary; nobody regresses to baseline.
    let small = CanaryRouter::new(5);
    let big = CanaryRouter::new(25);
    let regressions = (0..n)
        .filter(|&u| small.route(u) == Version::Canary && big.route(u) == Version::Baseline)
        .count();
    println!("users regressed canary->baseline on ramp: {}", regressions);
}
```

Running this over 100,000 users routes 5.09% to the canary at weight 5 —
close to the configured share — and reports **0** users regressing from
canary back to baseline when the weight ramps 5 → 25, confirming the routing
is both proportional and sticky across the ramp.

## When to use it

- You want to validate a release against genuine production traffic and data
  before committing to a full rollout.
- Reliable automated metrics (error rate, latency, business KPIs) exist and
  can drive an automatic promote/abort decision at each stage.
- A subtly bad release is costly enough that bounding its blast radius is
  worth a slower, staged rollout.

## When not to use it

- There are no trustworthy automated metrics to gate stages — canary then
  degenerates into a slow, manual, error-prone process.
- Instant, complete rollback is the only goal and graduated exposure adds no
  value — [blue-green](/docs/patterns/observability/blue-green-deployment) is
  simpler.
- Traffic volume is too low for a small slice to produce statistically
  meaningful signal in a reasonable soak window.
- The change is a single feature inside an already-deployed service — a
  [feature flag](/docs/patterns/observability/feature-flags) targets and rolls
  it out without touching infrastructure routing at all.

## Use-case scenarios

**High-traffic API behind a service mesh.** A payments API ships a new version
to 1% of traffic via mesh weights, with sticky routing by account id.
Automated canary analysis compares the canary's error rate and p99 latency to
the baseline over a ten-minute soak; a clean score promotes to 5%, 25%, then
100%, while a spike in decline-rate at 5% aborts and shifts weight back to
zero — with only 5% of accounts ever exposed.

**Mobile backend rollout.** A backend release ramps gradually while the app
fleet is unchanged. Business KPIs (session length, crash-free rate reported by
clients) sit alongside server metrics in the analysis, so a regression that
only shows up as client-side crashes still aborts the ramp before it reaches
everyone.

**Recommendation model swap.** A new ranking model is canaried to a small,
sticky slice of users so engagement metrics can be compared like-for-like
against the incumbent on live traffic. If click-through and dwell time hold or
improve, the model ramps to 100%; if they drop, it rolls back — a decision
made on real user behavior no offline evaluation could fully predict.

## Related patterns

- [Blue-Green Deployment](/docs/patterns/observability/blue-green-deployment) —
  the all-at-once alternative; canary trades its speed for graduated,
  metric-gated exposure.
- [Feature Flags](/docs/patterns/observability/feature-flags) — a finer-grained,
  application-level way to control exposure by user attribute; composes with
  canary rather than replacing it.
- [Health Check](/docs/patterns/observability/health-check) — one of the
  signals feeding the analysis that gates each stage of the ramp.
- [Load Balancing](/docs/patterns/api-edge/load-balancing) — provides the
  weighted traffic split canary depends on.
- [Service Mesh](/docs/patterns/api-edge/service-mesh) — supplies fine-grained,
  percentage-based routing and per-request metrics ideal for canarying.

## Further reading

- [CanaryRelease — Martin Fowler](https://martinfowler.com/bliki/CanaryRelease.html)
- [Canarying releases — Google SRE Workbook](https://sre.google/workbook/canarying-releases/)
- [Deploy using a canary — AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/rel_tracking_change_management_planned_changes_canary.html)
- [Blue/green deployments with Amazon ECS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-type-blue-green.html)
- [Feature toggle — Wikipedia](https://en.wikipedia.org/wiki/Feature_toggle)
