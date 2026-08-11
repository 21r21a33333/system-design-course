---
title: "Blue-Green Deployment"
sidebar_position: 3
supplementary: true
---

Blue-green deployment runs two identical production environments — "blue"
(currently serving live traffic) and "green" (the new version) — deploys
and verifies the new version on the idle environment while the live one is
untouched, then cuts *all* traffic over atomically in one step, keeping the
old environment warm so rollback is as simple as switching back.

![Blue-Green Deployment diagram](/img/patterns/blue-green-deployment.svg)

## Problem it solves

Deploying a new version in place — restarting instances or swapping binaries
on the machines that are actively serving traffic — means the old and new
code inevitably run side by side for the whole rollout window, and a failed
deploy can leave the fleet in a partially-updated state that is genuinely
hard to reason about: some requests hit v1, some hit v2, and rolling back
means re-running the pipeline in reverse while users watch a broken service.
Blue-green removes the in-place mutation entirely. The live environment is
never touched during a release; the new version is stood up somewhere else,
verified while it serves *zero* real traffic, and only then made live in a
single switch. Because the previous environment is left running exactly as
it was, going back is not a redeploy — it is the same switch in reverse,
measured in seconds.

## Technical architecture & implementation

**Two environments behind one router.** The core setup is two complete,
independently deployable copies of production — same topology, same
capacity — with a single traffic director in front: a load balancer, a
DNS record, a service-mesh route, or a platform primitive like a
deployment slot. Exactly one environment is *active* at any moment; the
router holds a pointer to it. Deploying means pushing the new build to the
idle environment, running smoke tests and a
[health check](/docs/patterns/observability/health-check) against it while
production still flows to the active one, and only flipping the pointer
once the idle environment is proven good.

**The atomic cutover.** The switch itself must be all-or-nothing — there is
no intermediate state where half the users are on each version, which is
precisely what distinguishes blue-green from a
[canary deployment](/docs/patterns/observability/canary-deployment). With a
load balancer or mesh route the flip is close to instant. With **DNS** it is
not: resolvers and clients cache records for the record's **TTL**, so a
DNS-based cutover drains over minutes and both environments must serve
traffic during that window. Lowering the TTL well ahead of the release is
the standard mitigation; relying on a load balancer or mesh for the actual
switch avoids the problem altogether.

**Keeping blue warm for instant rollback.** The rollback guarantee only
holds if the previous environment is left running, unchanged, after the
switch — flip the pointer back and traffic returns to a known-good version
without rebuilding or redeploying anything. This is the pattern's headline
benefit and its headline cost: you pay for two full production environments
for the overlap window. Tearing blue down too early to save money trades
away exactly the instant rollback you adopted blue-green to get.

**The hard part is shared state.** Both environments almost always talk to
*one* database, and that is where blue-green gets subtle. A migration that
green needs but blue cannot tolerate breaks the moment you cut over — and
breaks rollback too, because blue can no longer read the mutated schema. The
discipline is **expand/contract** (see below): make schema changes
backward-compatible so blue and green both work against one database across
the whole switch. In-flight **session and connection state** is the other
snag — long-lived connections (WebSockets, streaming RPCs) pinned to blue do
not migrate across an atomic cutover, so they must be drained gracefully or
re-established by clients against the new active environment.

**Failure modes.** A green environment that passes smoke tests but fails
under real production load is the classic blue-green trap: because the
cutover is all-at-once, the *first* real traffic green sees is 100% of it,
so a load-sensitive defect hits every user simultaneously — the exact risk
that canary's gradual ramp exists to catch. Blue-green's answer is speed of
detection plus the instant flip back, not gradual exposure. A second failure
mode is a rollback that a non-backward-compatible migration has quietly made
impossible; a third is capacity drift, where blue was scaled down while idle
and cannot actually absorb full traffic if you flip back to it.

**Where it sits among siblings.** Blue-green switches *all* traffic at once
and rolls back by switching back;
[canary](/docs/patterns/observability/canary-deployment) shifts a *small
percentage* first and ramps up while watching metrics;
[feature flags](/docs/patterns/observability/feature-flags) decouple deploy
from release so a shipped-but-dark feature is toggled on at runtime without
any redeploy. They compose cleanly: deploy the new version via blue-green,
then release individual features inside it via flags.

## Database migrations: expand/contract

Because both environments share one database, schema changes must be
**backward-compatible with the version that is *not* being deployed** — so
the change is split across releases rather than done in one destructive step:

- **Expand.** Add the new schema element additively — a new nullable column,
  a new table, a new index — in a release both blue and green tolerate.
  Nothing is removed or renamed. Old code ignores the addition; new code can
  start writing to it.
- **Migrate/dual-write.** Backfill existing rows and have the new code write
  to both old and new shapes so the data stays consistent whichever version
  serves a request.
- **Contract.** Only after the new version is fully rolled out *and* you no
  longer need the ability to roll back to the old one do you remove the old
  column or constraint — in a *later* release.

Renaming a column in one shot, or dropping one the old version still reads,
is what turns a routine blue-green cutover into an outage with no way back.

## Code example

The mechanism at the heart of blue-green is a router with an active pointer
plus a **health gate**: the idle environment cannot receive traffic until it
proves healthy, the cutover is atomic, and rollback is a single flip back to
the environment you came from.

```rust
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Color {
    Blue,
    Green,
}

pub struct Router {
    active: Color,
    previous: Color,
}

#[derive(Debug, PartialEq)]
pub enum CutoverError {
    HealthGateFailed,
}

impl Router {
    pub fn new(active: Color) -> Self {
        Self { active, previous: active }
    }

    pub fn active(&self) -> Color {
        self.active
    }

    // Cut all traffic to the idle env, but only if it passes the health gate.
    // A failed smoke test leaves the active pointer exactly where it was.
    pub fn cutover(&mut self, idle_healthy: bool) -> Result<Color, CutoverError> {
        if !idle_healthy {
            return Err(CutoverError::HealthGateFailed);
        }
        let target = self.idle();
        self.previous = self.active;
        self.active = target;
        Ok(self.active)
    }

    // Instant rollback: point back at the environment we came from.
    pub fn rollback(&mut self) -> Color {
        std::mem::swap(&mut self.active, &mut self.previous);
        self.active
    }

    fn idle(&self) -> Color {
        match self.active {
            Color::Blue => Color::Green,
            Color::Green => Color::Blue,
        }
    }
}
```

Exercising this router confirms the invariants that make blue-green safe: a
`cutover` against an unhealthy idle environment returns `HealthGateFailed`
and leaves `active` unchanged, a `cutover` against a healthy one atomically
makes the idle environment active, and a subsequent `rollback` flips straight
back to the previous environment without any redeploy step.

## When to use it

- Fast, low-risk rollback is a hard requirement — the switch back to the
  previous version must be near-instant, not a pipeline re-run.
- The system can tolerate two full production environments running at once,
  at least for the overlap window, and the release cost of that duplication
  is acceptable.
- Schema changes for the release can be made backward-compatible
  (expand/contract) so blue and green both work against the shared database.

## When not to use it

- Doubling production infrastructure for every release is too expensive for
  a large or heavily stateful system, and the availability requirement does
  not justify it.
- You specifically want to validate a change against a *small slice* of real
  traffic before committing — blue-green's all-or-nothing switch does not
  give graduated exposure; use [canary](/docs/patterns/observability/canary-deployment).
- The workload is dominated by long-lived stateful connections that cannot be
  drained or re-established cleanly across an atomic cutover.

## Use-case scenarios

**Stateless web tier on a managed platform.** A public web application runs
two environments behind a platform load balancer with a built-in
slot-swap. Green gets the new build, an automated smoke suite hits it
directly, and a single swap makes it live. A regression spotted in the first
minutes is undone by swapping back to blue, which was left running — total
rollback time is seconds, and no migration was involved because the release
was code-only.

**Release with a schema change, done safely.** A team shipping a feature that
needs a new column runs it as three blue-green releases: an *expand* release
adds the nullable column (both versions tolerate it), a *migrate* release
dual-writes and backfills, and only a later *contract* release removes the
old field once rollback is no longer needed. At every step the shared
database is compatible with whichever environment is active, so any cutover
can be reversed.

**Regulated system needing an auditable, reversible cutover.** A financial
service requires that any production change be reversible within a strict
window. Blue-green gives a clean audit story: the exact build that was live
before the switch is still running, untouched, so "roll back" is a
deterministic pointer flip to a known-good environment rather than a
best-effort re-deploy.

## Related patterns

- [Canary Deployment](/docs/patterns/observability/canary-deployment) — the
  gradual alternative: shifts a small percentage of traffic first and ramps
  up while watching metrics, rather than switching everyone at once.
- [Feature Flags](/docs/patterns/observability/feature-flags) — decouple
  release from deploy at the feature level; compose with blue-green by
  deploying the version this way and toggling features on inside it.
- [Load Balancing](/docs/patterns/api-edge/load-balancing) — the mechanism
  most commonly used to perform the atomic traffic switch between
  environments.
- [Health Check](/docs/patterns/observability/health-check) — gates the
  cutover; the green environment must pass before the router will flip to it.
- [Service Mesh](/docs/patterns/api-edge/service-mesh) — provides
  fine-grained routing that can perform the environment switch (and the
  weighted splits canary needs).

## Further reading

- [BlueGreenDeployment — Martin Fowler](https://martinfowler.com/bliki/BlueGreenDeployment.html)
- [Blue-green deployments — AWS overview whitepaper](https://docs.aws.amazon.com/whitepapers/latest/overview-deployment-options/bluegreen-deployments.html)
- [Blue-green deployment strategies — Microsoft Learn](https://learn.microsoft.com/en-us/azure/spring-apps/enterprise/concepts-blue-green-deployment-strategies)
- [Staging environments (slot swap) — Azure App Service docs](https://learn.microsoft.com/en-us/azure/app-service/deploy-staging-slots)
- [Blue-green deployment — Wikipedia](https://en.wikipedia.org/wiki/Blue-green_deployment)
