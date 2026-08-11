---
title: "Feature Flags"
sidebar_position: 5
supplementary: true
---

Feature flags (feature toggles) decouple *deploying* code from *releasing* a
feature: new code ships behind a runtime-evaluated flag, "dark," and is later
enabled — for everyone, for a percentage of traffic, or for a targeted segment
of users — by flipping a config value at runtime, with no new deployment, and
disabled just as instantly as a kill switch if it misbehaves.

![Feature Flags diagram](/img/patterns/feature-flags.svg)

## Problem it solves

Without flags, a deploy and a release are the same event: merging code and
exposing it to every user happen together. That forces a bad choice —
long-lived feature branches that drift from main and become painful to merge,
or accepting that every merge to main is immediately live for all users. Both
create risk: a half-finished feature either cannot be merged yet, or leaks to
production before it is ready. And when something *does* go wrong, "roll back"
means running the deployment pipeline in reverse. Feature flags separate the
two decisions. Code merges to main and deploys continuously while *who sees a
feature, and when* is decided independently at runtime — so incomplete work
ships dark, finished work is released on its own schedule, and a
misbehaving feature is switched off in seconds without a deploy.

## Technical architecture & implementation

**Runtime evaluation.** New code is wrapped in a check —
`if flags.is_enabled("new-checkout", user)` — evaluated at request time
against the flag's current configuration. Because the check is at runtime, one
deployed binary serves *different* behavior to different users at once, and
changing behavior means changing config, not code.

**Flag types.** Flags are not one thing; their lifetime and ownership differ by
kind. **Release flags** gate in-progress features for trunk-based development
and are meant to be short-lived. **Ops / kill-switch flags** let operators
disable an expensive or fragile code path under load — long-lived by design.
**Experiment (A/B) flags** split users into variants to measure impact.
**Permission flags** expose features to a class of users (paid tier, internal
staff) and may live indefinitely. Conflating these — leaving a release flag in
forever, or treating a permission flag as disposable — is a common source of
mess.

**Targeting and segmentation.** Beyond on/off, a flag carries **targeting
rules** evaluated against user or request attributes: on for `tier = beta`, for
`region = EU`, for an internal allow-list, or for a hashed percentage of
everyone else. This attribute-based targeting is the defining difference from
[canary](/docs/patterns/observability/canary-deployment), which targets by raw
traffic percentage: a flag can release a feature to *exactly the beta cohort*
regardless of how much traffic they are, something a traffic-weight split
cannot express.

**Evaluation service, SDK, and caching.** In practice a **flag-management
service** holds the config and an in-process **SDK** evaluates it. Two rules
matter for correctness and latency: evaluation runs **locally** in each process
(the SDK streams config updates and caches them, so an evaluation is a
local, sub-millisecond decision, not a network round trip per check), and it
must **fail safe** — if config is momentarily unavailable, the SDK falls back
to the last known value or a hard-coded default rather than erroring. **Sticky
bucketing** by hashed user id keeps a user's percentage-rollout assignment
stable across requests and across the fleet, so a 10% rollout means the *same*
10% everywhere, not a fresh coin-flip each call.

**What flags unlock.** Because release is now a runtime decision, teams can
practice **trunk-based development** (merge small increments to main behind
flags instead of maintaining divergent branches) and **dark launches** (deploy
and even exercise a code path in production with real traffic before exposing
its results to users). A flag also gives an **instant kill switch** — the
fastest rollback there is, since it requires no pipeline at all.

**The debt.** Flags are a liability as well as a lever, covered in
[managing flag debt](#managing-flag-debt): stale flags never removed, a
combinatorial explosion of untested code paths, and the ongoing cleanup cost.
A flag without an owner and a removal plan is a permanent, silent branch in the
code.

**Where it sits among siblings.** Feature flags gate a *feature* inside an
already-deployed binary and target by user **attribute**; they are the only
member of this family that decouples deploy from release.
[Canary](/docs/patterns/observability/canary-deployment) rolls out a *whole
version* by **traffic percentage** while watching metrics, and
[blue-green](/docs/patterns/observability/blue-green-deployment) switches a
whole environment at once. They compose: deploy the version via canary or
blue-green, then release the features within it via flags. A three-way
comparison table lives on the
[canary page](/docs/patterns/observability/canary-deployment#blue-green-vs-canary-vs-feature-flags).

## Managing flag debt

Every active flag is a branch point that must be reasoned about and, ideally,
tested in both states — so N flags imply up to 2^N behavioral combinations,
most never exercised together. Keeping this from rotting into unmaintainable
sprawl takes discipline:

- **Give every flag an owner and an expiry.** A release flag should have a
  planned removal date the moment it is created; a dashboard of stale flags
  past their expiry keeps the debt visible.
- **Remove the flag *and* the dead branch.** Once a feature is fully shipped,
  delete both the flag config and the losing code path — a flag stuck at 100%
  forever is still testable surface area and reader confusion.
- **Distinguish permanent from temporary.** Kill switches and permission flags
  are meant to persist; release and experiment flags are not. Labeling them
  prevents "should this still be here?" ambiguity.
- **Bound concurrency.** Limit how many temporary flags touch one subsystem at
  once so the untested-combination space stays tractable.

## Code example

The mechanism is a flag evaluator with strict **precedence**: a kill switch
overrides everything, then explicit attribute targeting, then a deterministic
percentage rollout salted per flag so different flags at the same percentage
do not enable the same users.

```rust
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};

pub struct User {
    pub id: u64,
    pub attributes: HashMap<String, String>,
}

pub struct Flag {
    pub key: String,
    pub killed: bool,
    // (attribute, value) pairs that force the flag ON regardless of rollout.
    pub target_rules: Vec<(String, String)>,
    pub rollout_percent: u8,
}

impl Flag {
    pub fn is_enabled(&self, user: &User) -> bool {
        // 1. Kill switch wins over everything — the instant-off lever.
        if self.killed {
            return false;
        }
        // 2. Explicit targeting: any matching attribute rule turns it on.
        for (attr, want) in &self.target_rules {
            if user.attributes.get(attr).map(String::as_str) == Some(want.as_str()) {
                return true;
            }
        }
        // 3. Percentage rollout, bucketed per flag so different flags at the
        // same percent don't enable the same users (salt with the flag key).
        let mut h = DefaultHasher::new();
        self.key.hash(&mut h);
        user.id.hash(&mut h);
        let bucket = (h.finish() % 100) as u8;
        bucket < self.rollout_percent
    }
}

fn user(id: u64, tier: &str) -> User {
    let mut attributes = HashMap::new();
    attributes.insert("tier".to_string(), tier.to_string());
    User { id, attributes }
}

fn main() {
    let mut flag = Flag {
        key: "new-checkout".to_string(),
        killed: false,
        target_rules: vec![("tier".to_string(), "beta".to_string())],
        rollout_percent: 10,
    };

    // Targeting: every beta user is on, independent of the 10% rollout.
    let all_beta_on = (0..10_000u64).all(|id| flag.is_enabled(&user(id, "beta")));
    println!("all beta users enabled by targeting: {}", all_beta_on);

    // Percentage: non-beta users approximate the configured rollout.
    let n = 100_000u64;
    let on = (0..n).filter(|&id| flag.is_enabled(&user(id, "standard"))).count();
    println!("standard-tier enabled share at 10%: {:.2}%", on as f64 / n as f64 * 100.0);

    // Kill switch overrides targeting and rollout alike.
    flag.killed = true;
    let any_on = (0..10_000u64).any(|id| flag.is_enabled(&user(id, "beta")));
    println!("any user enabled after kill switch: {}", any_on);
}
```

Running this confirms all three tiers of precedence: every `tier = beta` user
is enabled by targeting regardless of the rollout, standard-tier users land at
10.23% (≈ the configured 10% rollout), and once the kill switch is flipped
`is_enabled` returns `false` for everyone — even the beta cohort that targeting
had turned on.

## When to use it

- Trunk-based development is the goal: merge incomplete features to main
  continuously without exposing them to users yet.
- A feature must be released gradually or to a specific segment (beta cohort,
  internal dogfooding, a paid tier, a region) independent of infrastructure
  traffic splitting.
- An instant kill switch for a risky feature — disable it without a deploy or
  pipeline rollback — is valuable.
- You want to run A/B experiments and measure variant impact on live users.

## When not to use it

- The rollout is of an *entire service version* rather than a feature within
  it — [canary](/docs/patterns/observability/canary-deployment) or
  [blue-green](/docs/patterns/observability/blue-green-deployment) fits better.
- The team has no process to retire flags — without ownership and cleanup,
  flags accumulate into permanent, untested branch points and net-negative
  complexity.
- The number of simultaneously active flags in one area is already large enough
  that the combinatorial code paths cannot realistically be tested together.

## Use-case scenarios

**Dark launch of a checkout rewrite.** A team merges a rewritten checkout to
main behind a release flag, deploys it dark, and exercises the new path with
shadow traffic. They then enable it for `tier = internal`, then for a hashed
1% → 10% → 100% of customers, watching metrics between steps. A payment
anomaly at 10% is neutralized by flipping the kill switch — instant, no
deploy — while the fix is prepared.

**Segmented beta program.** A SaaS product exposes a new dashboard only to
customers who opted into beta, via a targeting rule on an account attribute.
The exact cohort is enabled regardless of its traffic share — something a
percentage-based canary could not express — and the flag stays until the
feature graduates to general availability, at which point it is removed along
with the old dashboard.

**Operational kill switch for an expensive path.** A search feature that hits
an external service under load sits behind a long-lived ops flag. When that
dependency degrades, on-call disables the feature instantly, shedding the
expensive path and keeping the core product responsive — a runtime lever that
would otherwise require an emergency deploy.

## Related patterns

- [Canary Deployment](/docs/patterns/observability/canary-deployment) —
  infrastructure-level, traffic-percentage rollout of a whole version; feature
  flags are the application-level, attribute-targeted equivalent and compose
  with it.
- [Blue-Green Deployment](/docs/patterns/observability/blue-green-deployment) —
  a deployment-time, environment-level rollback mechanism; flags provide the
  runtime, feature-level one.
- [External Configuration Store](/docs/patterns/observability/external-configuration-store) —
  the config-management substrate a flag service is a specialized form of.
- [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) — an
  *automatic* runtime cutoff of a failing dependency, complementary to a flag's
  *manual* kill switch.

## Further reading

- [FeatureToggle — Martin Fowler](https://martinfowler.com/articles/feature-toggles.html)
- [What are feature flags? — LaunchDarkly](https://launchdarkly.com/blog/what-are-feature-flags/)
- [Canarying releases — Google SRE Workbook](https://sre.google/workbook/canarying-releases/)
- [Feature toggle — Wikipedia](https://en.wikipedia.org/wiki/Feature_toggle)
