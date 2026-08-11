---
title: "Design a Zero-Downtime Deployment System"
sidebar_position: 20
---

Every other case study in this course designs a system that serves traffic; this one designs the system that changes what code is serving that traffic, while it's serving it, without anyone using the service noticing. The hard constraint is that "deploy a new version" and "cause an outage" must never be the same event, even when the new version turns out to be broken.

*Educative's Grokking Modern System Design Interview course covers this same system in its "Design a Deployment System" module.*

## Step 1: Outline use cases and constraints

### Use cases

#### We'll scope the problem to handle the following use cases

* **Operator** triggers a deployment of a new service version to production
* **Service** rolls the new version out gradually, verifying it's healthy before shifting meaningful traffic to it
* **Service** automatically halts or rolls back a deployment if the new version shows errors or degraded behavior
* **Operator** can manually and immediately roll back to the previous version at any time
* **Service** supports releasing a specific feature to a subset of users independently of the underlying code deployment
* **Service** deploys without any period where zero healthy instances are serving traffic
* **Service** has strong observability into a rollout's health at every stage, since a rollout decision (proceed, pause, abort) is only as good as the signal it's based on

#### Out of scope

* The build/artifact pipeline that compiles and packages code before it's ready to deploy (this design starts from "a deployable artifact exists" and covers getting it safely into production)
* Database schema migrations, beyond a brief mention of the backward-compatibility constraint they impose on this design
* Infrastructure provisioning (standing up entirely new hardware/capacity) as opposed to deploying new code onto existing capacity
* Multi-region deployment sequencing/ordering strategy (a real and important extension, touched on briefly, not designed in depth)

### Constraints and assumptions

#### State assumptions

* A service being deployed runs 500 instances in steady state behind a load balancer, sized for its own peak traffic independent of this design
* Deployments happen frequently — assume an average of 20 deployments per day across a mid-sized engineering organization's services, spread across many independent teams and services rather than concentrated on one
* At no point during a deployment may the number of instances actively able to serve traffic drop below what's needed to handle current load — a deployment is not permitted to be the cause of a capacity-induced outage
* A newly deployed instance must be verified healthy before it receives real production traffic — "the process started" and "this instance is safe to serve users" are treated as different, separately-checked moments
* A rollout must be abortable and reversible quickly — detecting a bad deployment and stopping its blast radius from growing further matters more than completing the rollout fast
* Rolling back must be at least as fast and reliable as rolling forward — a system that can deploy safely but rolls back slowly or unreliably has only solved half the problem
* Some releases need to be decoupled from deployment entirely — a feature that's risky from a product or business standpoint (not a stability standpoint) may need to be enabled for a small percentage of users independent of which code version is currently deployed everywhere

#### Calculate usage

* Deployment frequency: 20 deployments/day across the organization → 20 / 86,400 ≈ roughly one deployment kicking off every **~70 minutes on average**, though in practice these cluster during working hours across many independent services rather than spreading evenly across 24 hours — the absolute rate is low enough that this design is not a high-throughput system in the way most other case studies in this course are; it's a low-frequency, high-stakes-per-event workflow, and the design effort goes into making each individual rollout safe, not into handling a high volume of them
* Instance-level rollout granularity: rolling out to 500 instances in batches of 10% (50 instances) at a time means **10 batches per full rollout** — sized so that if a batch reveals a problem, at most 10% of capacity has received the new version, not the whole fleet, bounding the blast radius of a bad batch to a known, small fraction of total capacity
* Health-check overhead: assuming each of the 500 instances is polled for health roughly every 5 seconds, that's 500 / 5 ≈ **~100 health-check requests/sec** for this one service's steady-state monitoring — a trivial load in isolation, but worth noting it multiplies across every service the organization runs, which is why health checks need to be cheap, bounded operations (per the constraint below) rather than expensive ones
* Rollout duration budget: if each batch needs roughly 2 minutes of soak time (time spent observing the new version's metrics before proceeding to the next batch, discussed in Step 3) across 10 batches, a full gradual rollout takes on the order of **~20 minutes** end to end under normal conditions — slow compared to flipping a switch instantly, and that slowness is a deliberate, load-bearing tradeoff: it's the time budget spent buying the ability to catch a bad release before it reaches all 500 instances, not wasted overhead
* Rollback speed target: because a bad deployment is actively harming users for every second it continues, rollback needs to be dramatically faster than roll-forward — this design targets rolling back within roughly the time of a single batch's soak window (on the order of a couple of minutes), not by repeating the full gradual process in reverse, discussed further in Step 3

## Step 2: Create a high-level design

![Zero-Downtime Deployment System high-level architecture](/img/case-studies/deployment-system-overview.svg)

An **operator** (a person, or an automated pipeline acting on their behalf) submits a new deployable artifact to a **deployment orchestrator**, which is responsible for the entire rollout's lifecycle: bringing up new-version instances, verifying they're healthy via **health checks**, incrementally shifting live traffic to them through the **load balancer / traffic router**, and continuously watching a **metrics and monitoring** feed for signs the new version is unhealthy. Old-version instances are kept running, untouched, until the orchestrator has confidence the new version is good — which is what makes rollback fast: reversing a rollout means shifting traffic back to instances that were never actually removed, not re-deploying the previous version from scratch. A separate **feature flag service** lets specific behavior inside an already-deployed version be turned on or off for specific users independent of this rollout machinery entirely, decoupling "is this code running in production" from "is this behavior currently visible to users."

The organizing idea behind this whole design is that a deployment's risk is a function of **blast radius times detection latency** — how much traffic could a bad version affect, multiplied by how long it takes to notice and react. Every mechanism in this design (batching, health checks, gradual traffic shifting, automated rollback triggers) exists to shrink one or both of those two numbers, rather than to make deployment itself faster; deliberately, per Step 1's math, this design accepts a slower rollout in exchange for a small, bounded, quickly-detected blast radius if something goes wrong.

## Step 3: Design core components

### Use case: Service rolls out a new version gradually with health verification

The hard problem is choosing, and mechanically implementing, a rollout *strategy* — how new-version capacity comes online and how traffic moves to it — since this decision is what determines a bad release's blast radius at every point during the rollout.

**Core spec: three named strategies, compared explicitly**

| Strategy | Mechanics | Blast radius during rollout | Rollback speed |
|---|---|---|---|
| **Rolling** | Replace old-version instances with new-version ones a batch at a time, in place; old instances in a batch are torn down as soon as their replacements are healthy | Shrinks gradually as batches proceed, but old-version capacity is *permanently reduced* each batch — there's no full old-version fleet left to fall back to once several batches have gone | Slow — reversing means rolling forward again with the old artifact, batch by batch |
| **Blue-green** | Stand up an entirely separate new-version environment ("green") alongside the fully intact old one ("blue"); cut traffic over atomically, all at once, once green is verified | 100% the instant cutover happens — there is no partial-exposure stage at all | Fast — blue was never torn down, so reverting is a single routing change back |
| **Canary** | Shift a small percentage of traffic to new-version instances, observe, then increase the percentage in stages, while old-version instances keep serving the rest throughout | Bounded and staged — a bad release is only ever exposed to the current stage's traffic percentage, never more, until it's proven healthy | Fast if old-version capacity is kept intact throughout (this design's choice) — see below |

This design uses **canary**, specifically because Step 1 requires both a small, bounded blast radius *during* the rollout (which rolling only partially gives, and blue-green doesn't give at all) and fast rollback (which blue-green gives cleanly, but canary alone doesn't guarantee unless old-version capacity is deliberately preserved). The mechanism below is canary staging layered on top of blue-green's "never tear down the known-good environment" discipline — getting canary's bounded exposure during rollout and blue-green's instant, clean rollback simultaneously.

```python
from enum import Enum
from dataclasses import dataclass, field


class Stage(Enum):
    PENDING = "pending"
    CANARY_5 = "canary_5"
    CANARY_25 = "canary_25"
    FULL_100 = "full_100"
    ROLLED_BACK = "rolled_back"


@dataclass
class CanaryDeployment:
    """State machine for one service's gradual rollout. `traffic_router`
    and `metrics` are injected dependencies (a load balancer's traffic-
    split API and a metrics source respectively) so the state machine
    itself stays pure control-flow, testable without real infra.
    """
    service_id: str
    error_rate_threshold: float          # e.g. 0.02 == 2% error rate trips rollback
    stage: Stage = Stage.PENDING
    history: list = field(default_factory=list)

    STAGE_ORDER = [Stage.CANARY_5, Stage.CANARY_25, Stage.FULL_100]
    STAGE_TRAFFIC_PCT = {Stage.CANARY_5: 5, Stage.CANARY_25: 25, Stage.FULL_100: 100}

    def start(self, traffic_router):
        self.stage = Stage.CANARY_5
        traffic_router.set_new_version_traffic_pct(self.service_id, 5)
        self.history.append(self.stage)

    def observe_and_advance(self, traffic_router, metrics):
        """Called after each stage's soak period. Checks the new
        version's error rate against baseline; either promotes to the
        next stage, or triggers automatic rollback.
        """
        if self.stage in (Stage.FULL_100, Stage.ROLLED_BACK):
            return self.stage  # nothing left to do

        current_error_rate = metrics.error_rate(self.service_id, version="new")
        if current_error_rate > self.error_rate_threshold:
            self.rollback(traffic_router, reason=f"error_rate {current_error_rate:.3f} "
                                                   f"exceeded threshold {self.error_rate_threshold:.3f}")
            return self.stage

        next_index = self.STAGE_ORDER.index(self.stage) + 1
        if next_index >= len(self.STAGE_ORDER):
            return self.stage  # already at FULL_100

        self.stage = self.STAGE_ORDER[next_index]
        traffic_router.set_new_version_traffic_pct(self.service_id, self.STAGE_TRAFFIC_PCT[self.stage])
        self.history.append(self.stage)
        return self.stage

    def rollback(self, traffic_router, reason):
        """Automatic-rollback branch: instantly shift all traffic back
        to the old version. Old-version capacity was never torn down
        (per the blue-green-style discipline above), so this is a
        routing change, not a redeploy.
        """
        traffic_router.set_new_version_traffic_pct(self.service_id, 0)
        self.stage = Stage.ROLLED_BACK
        self.history.append((Stage.ROLLED_BACK, reason))
```

**Worked trace — a bad release caught and auto-rolled-back at the 25% stage:**

```python
class FakeTrafficRouter:
    def __init__(self):
        self.pct = {}
    def set_new_version_traffic_pct(self, service_id, pct):
        self.pct[service_id] = pct

class FakeMetrics:
    def __init__(self, error_rates_by_stage):
        self._rates = error_rates_by_stage  # {stage_index: error_rate}
        self._calls = 0
    def error_rate(self, service_id, version):
        rate = self._rates[self._calls]
        self._calls += 1
        return rate

router = FakeTrafficRouter()
# healthy at 5%, but the bug only manifests once 25% of real traffic hits it
metrics = FakeMetrics({0: 0.001, 1: 0.05})
deploy = CanaryDeployment(service_id="checkout-svc", error_rate_threshold=0.02)

deploy.start(router)
assert deploy.stage == Stage.CANARY_5 and router.pct["checkout-svc"] == 5

deploy.observe_and_advance(router, metrics)     # 0.001 < 0.02 -> promote
assert deploy.stage == Stage.CANARY_25 and router.pct["checkout-svc"] == 25

deploy.observe_and_advance(router, metrics)     # 0.05 > 0.02 -> auto-rollback
assert deploy.stage == Stage.ROLLED_BACK and router.pct["checkout-svc"] == 0
```

For each batch, the orchestrator starts new-version instances, waits for them to report healthy via [Health Check](/docs/patterns/observability/health-check) — specifically a **readiness** check, not just liveness, since an instance that's merely running but hasn't finished warming up or connecting to its dependencies is not yet safe to receive real traffic — and only then begins directing live traffic to that stage through the load balancer. Tools like Argo Rollouts and Flagger implement roughly this stage-and-soak canary mechanics as an off-the-shelf Kubernetes controller, as one illustrative example of the general shape rather than a prescription for how this design must be built.

**Data structures:**
* `CanaryDeployment` — `service_id`, `error_rate_threshold`, `stage` (a `Stage` enum), `history` (ordered list of transitions, doubling as an audit trail)
* `Stage` — `PENDING`, `CANARY_5`, `CANARY_25`, `FULL_100`, `ROLLED_BACK`

**Trade-offs:**
* **The gotcha — blast radius is the concept tying all three strategies together, and it's not the same axis as "speed."** Rolling shrinks blast radius gradually but permanently gives up old-version fallback capacity as it goes; blue-green gives perfect rollback but zero blast-radius protection during the cutover itself (100% of traffic hits new code the instant the switch flips); canary is the only one of the three that keeps blast radius small *and* bounded at every single stage of the rollout, not just before or after it — the cost is a rollout that takes meaningfully longer than either alternative, which Step 1's ~20-minute rollout budget treats as a deliberate, acceptable trade, not an oversight.
* Critically, because old-version instances are never removed until a stage is confirmed healthy, total serving capacity never drops below what's needed — new-version capacity is *added* to the serving pool as it's verified, and only *then* is a corresponding slice of old-version capacity drawn down, satisfying Step 1's "never fewer instances than needed" constraint.

### Use case: Service automatically halts or rolls back a deployment on failure signals

A gradual rollout only actually protects users if something is watching it and empowered to act — a canary that silently degrades and gets promoted to 100% anyway because no one was looking has all of the rollout time cost of this design with none of the safety benefit. `observe_and_advance` above is exactly this watchdog: it runs after every stage's soak period and is the sole gate on forward progress.

**Data structures:** reuses `CanaryDeployment` above; `metrics.error_rate(service_id, version="new")` represents the broader metrics feed (error rate, latency percentiles, and any service-specific business metric worth gating on), not just narrow liveness/readiness — a batch can be individually "healthy" by health-check standards while still showing an elevated error rate on real requests that a health check endpoint alone wouldn't surface.

**Trade-offs:**
* If a stage's metrics cross the defined `error_rate_threshold`, `rollback()` fires automatically rather than waiting for a human to notice and intervene — matching the automatic-abort behavior [Canary Deployment](/docs/patterns/observability/canary-deployment) describes generally. This design's `rollback()` doesn't just halt forward progress, it actively reverts already-shifted traffic back to 0% on the new version — a stricter response than "stop but leave whatever's already been shifted," since a halted-but-not-reverted rollout still leaves some fraction of users on a version already shown to be unhealthy.

### Use case: Operator manually and immediately rolls back to the previous version

Because old-version instances are deliberately kept running and healthy throughout a rollout rather than being torn down as soon as new-version instances come up, a manual rollback is structurally just "shift traffic back" — a load-balancer routing change, not a redeploy.

**Data structures:** no new state — a manual rollback is an operator directly invoking `CanaryDeployment.rollback()` with a human-supplied `reason`, the identical method the automatic path calls.

**Trade-offs:**
* This is the direct payoff of the blue-green-style "keep the previous known-good environment fully intact" principle borrowed into this design's rollout mechanism: the previous version was never in a half-decommissioned state at any point, so reverting to it doesn't require rebuilding or re-verifying anything, only re-pointing traffic — satisfying the rollback-speed target from Step 1's math.
* There is deliberately only one rollback code path in this design (`rollback()`), exercised either by a human decision or an automated trigger, rather than two different mechanisms that could behave inconsistently or be tested to different degrees of confidence.

### Use case: Service supports releasing a feature to a subset of users independent of deployment

Not every risky change is a code deployment — a product decision (show a new checkout flow to 10% of users, enable a feature only for beta customers) needs its own gradual-exposure mechanism that doesn't require redeploying to change who sees what.

**Data structures:** `feature_flags` — `flag_key`, `enabled_pct` or an explicit `cohort` rule, `updated_at` — held by the feature flag service, structurally separate from `CanaryDeployment`'s traffic-percentage state.

**Trade-offs:**
* [Feature Flags](/docs/patterns/observability/feature-flags) solve this at the application layer: new code ships to production, already deployed everywhere via the rollout mechanism above, but sits behind a runtime-evaluated flag that's off (or partially on) until a separate decision — made through the feature flag service (a managed product like [LaunchDarkly](https://launchdarkly.com/docs/home/getting-started/feature-flags) is one well-known real example of this role, though an equivalent capability is also commonly built in-house) rather than through the deployment orchestrator — turns it on for a specific cohort.
* This is a deliberately different control axis from the canary rollout machinery above: rollout risk is about "is this code safe to run at all," gated by infrastructure-level traffic shifting (blast radius, in the code-execution sense); a flagged feature's risk is usually about "is this product behavior good for users," gated by an application-level runtime check that doesn't require touching how instances are deployed or routed at all. The two mechanisms compose rather than compete: a risky code change can be deployed through the full gradual canary rollout (verifying the *code itself* doesn't crash, error, or slow things down) while the *feature* it enables stays behind a flag defaulted off, letting a team separate "we trust this code is stable in production" from "we're ready for users to see this behavior" as two independent decisions.

## Step 4: Scale the design

![Zero-Downtime Deployment System scaled architecture](/img/case-studies/deployment-system-scaled.svg)

* **The deployment orchestrator itself needs to run multiple independent, concurrent rollouts — one `CanaryDeployment` per service being deployed — without one service's rollout affecting another's**, given Step 1's assumption of ~20 deployments/day spread across many independently-owned services. Each rollout is a largely self-contained state machine scoped to one service's deployment, a natural [Sharding](/docs/patterns/storage/sharding)-like partitioning by `service_id` — a stuck or slow rollout for one service should never block or slow another's, since they share no state beyond the orchestrator infrastructure itself.
* **Health checks need to stay cheap and bounded even as the number of instances and services grows, because they're the input every other decision in this design depends on.** As [Health Check](/docs/patterns/observability/health-check) itself cautions, a check that calls slow or expensive downstream dependencies becomes a new source of cascading load and false signals exactly when the system is under the most scrutiny (mid-rollout); this design's health checks are kept intentionally cheap and fast, with deeper dependency-health questions handled by the broader metrics feed `observe_and_advance` reads from, not folded into the health check's own response time.
* **The metrics feed `observe_and_advance` reads from needs to distinguish a genuinely new stage's traffic from the stable baseline reliably enough to make an automated promote/abort call**, which means metrics need to be tagged by instance version, not just aggregated service-wide — an orchestrator that can only see "the service's overall error rate went up slightly" can't tell whether that's the new version or unrelated noise, undermining the entire automated-rollback mechanism above. This tagging and comparison is a real engineering cost of doing canary-style rollouts well, not a detail that can be bolted on after the fact.
* **Load-balancer traffic shifting needs fine-grained, percentage-level control, not just binary instance in/out-of-rotation toggling**, since a stage's traffic exposure during soak needs to correspond to roughly the fraction (5%, 25%, 100%) `set_new_version_traffic_pct` requests — see [Load Balancing](/docs/patterns/api-edge/load-balancing) for the general routing mechanics this design leans on for both the gradual traffic shift during rollout and the instant full reversion during rollback.
* **Multi-region deployments extend this design by sequencing rollouts region by region rather than deploying to every region simultaneously**, so a bad release is caught and halted in one region's blast radius before it ever reaches the others — a natural extension of the same stage-and-soak principle at a coarser granularity (region instead of instance batch), briefly mentioned here as an extension rather than designed in full, per Step 1's scope.

## Additional talking points

* **Database schema changes are the sharpest edge case this design has to respect, and they're why "backward-compatible" is stated as a constraint rather than an implementation detail.** During a gradual rollout, old-version and new-version instances run simultaneously against the same underlying data for the full rollout duration (Step 1's math puts this at roughly 20 minutes) — a schema change that isn't compatible with *both* versions at once breaks whichever version doesn't understand it, independent of how carefully the rollout itself is staged. The standard mitigation is splitting a breaking schema change into multiple, individually backward-compatible deployments (add the new column without removing the old one; deploy code that writes both; only later, in a separate deployment, remove the old column) rather than trying to solve this at the deployment-orchestration layer at all — it's a data-modeling discipline problem the rollout mechanism can't paper over.
* **Why not just always deploy instantly (pure blue-green) and rely purely on fast rollback instead of gradual canary staging?** It's a real, simpler alternative, and the table above names its trade honestly: a bad release is at 100% blast radius for however long detection takes, even if that's only a minute or two. Canary's gradual exposure exists specifically to shrink blast radius during that detection window, which matters more the more slowly a subtle bug's symptoms surface (a memory leak or a rare edge case might not show up in the first ten seconds of exposure but will show up eventually in a 25%-traffic stage before it would have at 100%).
* **Stateful services and long-lived connections complicate the clean "just shift traffic" story this design otherwise relies on.** A service holding long-lived client connections (comparable to the connection-holding gateway layer in this course's WhatsApp case study) can't simply have its old-version instances yanked out of rotation the instant new-version instances are healthy — existing connections need to drain gracefully rather than being dropped, which extends how long old-version instances need to be kept alive during a rollout beyond what a purely stateless service requires.
* **Deployment frequency and stage granularity are in tension, and the right sizing is workload-specific.** Finer-grained stages (more of them, each a smaller traffic-percentage jump) mean tighter blast-radius control but more soak periods and a slower total rollout; a service with 20 deployments/day organization-wide but only one or two of its own per day can afford a more cautious, finer-grained rollout than a hypothetical service deploying dozens of times per day itself would tolerate — worth naming as a real per-service tuning decision rather than a single fixed constant like the `5 -> 25 -> 100` staging `CanaryDeployment` uses above.

## Source(s) and further reading

* [Canary release — Wikipedia](https://en.wikipedia.org/wiki/Canary_release) — the general strategy this design's `CanaryDeployment` state machine implements
* [Blue/Green Deployment — Martin Fowler](https://martinfowler.com/bliki/BlueGreenDeployment.html) — the atomic-cutover strategy this design borrows its "never tear down the known-good environment" discipline from
* [Rolling deployments — AWS Prescriptive Guidance](https://docs.aws.amazon.com/whitepapers/latest/overview-deployment-options/rolling-deployments.html) — a real vendor treatment of the third strategy this design's comparison table names, including its blast-radius and rollback-speed trade-offs
* [Kubernetes: Performing a Rolling Update](https://kubernetes.io/docs/tutorials/kubernetes-basics/update/update-intro/) — a real, widely-used implementation of rolling deployment mechanics
* [LaunchDarkly: What are feature flags?](https://launchdarkly.com/docs/home/getting-started/feature-flags) — a real, production feature-flag service matching the role this design's flag service plays
* [Health Check](/docs/patterns/observability/health-check) — the readiness-check mechanism gating every stage transition in this design
