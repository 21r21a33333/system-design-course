---
title: "Auto-Scaling"
sidebar_position: 3
supplementary: true
---

Auto-scaling automatically adjusts a service's capacity — usually the
number of running instances — to match its current load, driven by a
measured signal (CPU utilization, request rate, queue depth) compared
against a target, instead of an operator resizing the fleet by hand. It is
the control loop that makes a
[horizontally-scaled](/docs/patterns/scaling/horizontal-scaling) fleet
*elastic*.

![Auto-Scaling diagram](/img/patterns/auto-scaling.svg)

## Problem it solves

A fleet sized for peak load wastes money running idle capacity most of the
time; a fleet sized for average load falls over during spikes. Manually
watching dashboards and adding or removing instances by hand doesn't scale
— it's too slow to react to sudden surges and too labor-intensive to do
continuously and correctly at 3 a.m. Auto-scaling closes that loop: the
system observes its own load and adjusts capacity itself, within bounds an
operator sets once, keeping capacity a little above demand as demand moves.

## Technical architecture & implementation

**The control loop.** A controller periodically evaluates a chosen metric
against a target — "keep average CPU near 60%," "keep queue depth under
1,000." From the observed value it computes a *desired* instance count,
then drives the fleet toward it by launching or terminating instances,
always clamped to a configured **minimum and maximum**. The min guarantees
a floor of capacity (and absorbs the first bit of any spike before scaling
even reacts); the max is a spend-and-blast-radius guardrail so a runaway
metric or a bug can't launch thousands of instances.

**Reactive, scheduled, and predictive.** There are three complementary
triggers. **Reactive** (metric-driven) scaling responds to what's
happening right now; it needs no forecasting but, by definition, can't add
capacity until load has *already* risen, so there's a lag. **Scheduled**
scaling pre-provisions for *known* patterns — scale up at 8 a.m. before
the workday, up before a planned sale — sidestepping the lag when the
pattern is predictable. **Predictive** scaling forecasts load from
historical trends and provisions ahead of the curve, trading forecasting
complexity and the risk of a bad prediction for capacity that's ready
*before* the spike arrives. Mature setups combine all three: scheduled and
predictive for the known shape, reactive to catch the surprises.

**Policy shapes: target-tracking, step, and simple.** Reactive policies
come in flavors. **Target-tracking** is the workhorse — you name a target
value and the controller does the math to hold the metric there,
computing the instance count as roughly `ceil(load / per_instance_target)`.
**Step scaling** adds or removes different amounts depending on how far the
metric has breached (a small breach adds one instance, a large breach adds
ten). **Simple scaling** is the crude original — a fixed change on any
breach, with a hard cooldown between actions.

**Scale out fast, scale in slow.** The asymmetry is deliberate and
important. Under-provisioning during a spike *drops requests* — expensive
and user-visible — so scale-out should be aggressive: jump straight to the
needed count. Over-provisioning after a spike merely *costs a little
money*, and scaling in prematurely risks having to immediately scale back
out. So scale-in is cautious: remove a few instances at a time, only after
load has stayed low for a while. The `## Code example` implements exactly
this asymmetry.

**Cooldowns, warm-up, and boot time.** After any scaling action a
**cooldown** (or stabilization window) suppresses further changes for a
period, so the controller doesn't keep reacting to a metric that hasn't
settled yet. Separately, new instances take real time to become useful —
boot, warm caches, pass health checks, load data into memory — and their
metrics are noisy or misleadingly high during warm-up. A controller that
ignores warm-up double-counts the not-yet-helping instances and
over-shoots. Long boot times are the chief risk of purely reactive
scaling: an instance that takes minutes to warm may come online only after
the spike that summoned it has passed — which is why slow-warming
workloads lean on predictive or scheduled scaling.

**Choosing the right metric.** CPU is the default but is often wrong. For
a worker pool draining a queue, the honest signal is **queue depth** (or
per-instance backlog / oldest-message age), not CPU — this is the natural
pairing with
[queue-based load leveling](/docs/patterns/batch-streaming/queue-based-load-leveling),
where the queue absorbs the burst and the queue length tells the
autoscaler exactly how much worker capacity the backlog demands. For
request services, requests-per-second per instance or p99 latency often
track user experience better than CPU. Scaling the wrong metric produces a
fleet that's the wrong size for the actual bottleneck.

**Auto-scaling vs. manual, and vs. its siblings.** Against **manual**
scaling, auto-scaling wins on reaction speed and on not needing a human in
the loop, at the cost of tuning (thresholds, cooldowns, warm-up) and the
risk of misconfiguration causing flapping.
[Horizontal scaling](/docs/patterns/scaling/horizontal-scaling) is the
*mechanism* — a fleet of interchangeable instances — that auto-scaling
*automates*; auto-scaling presupposes it, since you can only freely add
and remove instances that hold no irreplaceable local state.
[Vertical scaling](/docs/patterns/scaling/vertical-scaling) is largely
orthogonal: you can autoscale *count* over a fleet of already
right-sized machines. And auto-scaling is not
[rate limiting](/docs/patterns/building-blocks/rate-limiter) — the former
adds capacity to *serve* more load, the latter *rejects* load to protect a
fixed capacity; the two are complementary defenses against a surge.

## Avoiding flapping

**Flapping** (or thrashing) is the failure mode where the controller
oscillates — scale out, scale in, scale out again — churning instances,
paying repeated boot costs, and destabilizing load without ever settling.
It happens when the scaling logic reacts faster than the system (and its
metrics) can stabilize. The standard dampers:

- **Cooldown / stabilization window.** After any action, ignore the metric
  for a fixed period so a single noisy reading can't trigger a reversal
  before the last change has taken effect.
- **Asymmetric steps (hysteresis).** Scale out on a high threshold but
  scale in only below a distinctly *lower* one, with a dead-band between
  them where nothing happens — so a metric hovering near one threshold
  doesn't ping-pong.
- **Cautious scale-in.** Remove few instances per decision, and only after
  sustained low load, so a brief dip doesn't strip capacity you'll need
  back moments later.
- **Warm-up awareness.** Don't count a just-launched instance's warm-up
  metrics as "load," which would otherwise trigger a phantom second
  scale-out.

## Code example

This is a **target-tracking controller** with the production-critical
behaviors: a min/max clamp, a cooldown, and asymmetric scale-out
(fast) vs. scale-in (gradual). The `fn main` runs a synthetic load curve —
calm, a sharp spike, a decay — and prints measurable properties.

```rust
#[derive(Clone, Copy, Debug)]
struct Policy {
    per_instance_target: f64, // load each instance should carry
    min: u32,
    max: u32,
    cooldown_ticks: u32, // ticks to wait after a change before changing again
    scale_in_step: u32,  // max instances removed per scale-in decision
}

struct Autoscaler {
    policy: Policy,
    current: u32,
    cooldown_left: u32,
    scale_events: u32, // times capacity actually changed
}

impl Autoscaler {
    fn new(policy: Policy, start: u32) -> Self {
        Autoscaler {
            policy,
            current: start.clamp(policy.min, policy.max),
            cooldown_left: 0,
            scale_events: 0,
        }
    }

    // desired = ceil(load / per_instance_target), clamped to [min, max].
    fn desired_for(&self, load: f64) -> u32 {
        let raw = (load / self.policy.per_instance_target).ceil().max(1.0);
        (raw as u32).clamp(self.policy.min, self.policy.max)
    }

    // One control tick. Returns the (possibly unchanged) instance count.
    fn step(&mut self, load: f64) -> u32 {
        if self.cooldown_left > 0 {
            self.cooldown_left -= 1;
            return self.current; // cooldown damps flapping
        }
        let target = self.desired_for(load);
        match target.cmp(&self.current) {
            std::cmp::Ordering::Equal => self.current,
            std::cmp::Ordering::Greater => {
                self.current = target; // scale out fast: jump to what's needed
                self.cooldown_left = self.policy.cooldown_ticks;
                self.scale_events += 1;
                self.current
            }
            std::cmp::Ordering::Less => {
                // scale in cautiously: remove at most scale_in_step at a time
                let removable = (self.current - target).min(self.policy.scale_in_step);
                self.current -= removable;
                self.cooldown_left = self.policy.cooldown_ticks;
                self.scale_events += 1;
                self.current
            }
        }
    }
}

fn main() {
    let policy = Policy {
        per_instance_target: 100.0,
        min: 2,
        max: 40,
        cooldown_ticks: 1,
        scale_in_step: 3,
    };
    let mut scaler = Autoscaler::new(policy, 2);

    // Load curve: calm, a sharp spike to 3000 rps, then a long decay.
    let mut curve = vec![180.0; 4];
    curve.extend(std::iter::repeat(3000.0).take(8));
    for i in 0..40 {
        curve.push((3000.0 - (i as f64) * 100.0).max(150.0));
    }

    let mut peak = 0u32;
    let mut breaches = 0u32; // ticks a settled instance carried > 1.5x target
    for &load in &curve {
        let acted = scaler.cooldown_left == 0;
        let n = scaler.step(load);
        peak = peak.max(n);
        if acted && load / n as f64 > policy.per_instance_target * 1.5 {
            breaches += 1;
        }
    }

    println!("peak={} scale_events={} final={} breaches={}",
        peak, scaler.scale_events, scaler.current, breaches);
}
```

Running this prints `peak=30 scale_events=16 final=2 breaches=0`. The
controller scales out to exactly 30 instances to meet the 3,000-rps spike
(`3000 / 100`), never exceeds the max of 40, and after the decay settles
back to the min of 2 — with zero sustained overload breaches and only 16
capacity changes across 52 ticks, the cooldown and gradual scale-in
keeping it from flapping. That measured trio — tracks the spike, respects
the bounds, doesn't thrash — is the whole job of an autoscaler in one run.

## When to use it

- Load is variable — daily/weekly cycles, unpredictable spikes, bursty
  queue depth — so a fixed fleet size means either wasted spend or
  under-provisioning.
- The workload is
  [horizontally scalable](/docs/patterns/scaling/horizontal-scaling)
  (stateless, or backed by a partitioned store), so adding and removing
  instances is safe.
- Cost efficiency matters and there's tolerance for a short ramp-up while
  new capacity warms — or the load is predictable enough to pre-provision
  with scheduled/predictive policies.

## When not to use it

- Instances take many minutes to boot and warm (large in-memory datasets,
  heavy model loads), so reactive scaling finishes only after the spike
  has passed — unless paired with predictive/scheduled scaling and enough
  min-capacity headroom.
- Load is flat and predictable — a fixed, right-sized fleet is simpler and
  has one fewer moving part to misconfigure.
- The service isn't horizontally scalable at all (a single stateful
  primary) — autoscaling the instance count doesn't apply;
  [vertical scaling](/docs/patterns/scaling/vertical-scaling) or a
  different architecture is needed.

## Use-case scenarios

**Web tier on a daily cycle.** A consumer app's traffic triples between
morning and evening and drops overnight. An EC2 Auto Scaling Group (or a
Kubernetes Horizontal Pod Autoscaler) tracks CPU or requests-per-instance
against a target, growing the fleet through the day and shrinking it at
night. A scheduled policy pre-warms capacity 15 minutes before the known
morning ramp so reactive lag never shows as slow responses.

**Queue-backed worker pool.** An image-processing pipeline reads jobs from
a queue that
[levels the load](/docs/patterns/batch-streaming/queue-based-load-leveling).
The autoscaler scales on **queue depth per worker**, not CPU: a backlog of
50,000 messages with a target of 500 per worker asks for 100 workers,
which drain the backlog and then scale back toward the floor. This is the
metric-choice lesson in practice — CPU would badly misjudge a pool whose
bottleneck is backlog, not compute.

**Predictive scaling for a known event.** A streaming service expects a
10x surge at a scheduled premiere. Purely reactive scaling would lag the
instant-on spike. A predictive/scheduled policy provisions most of the
needed capacity minutes ahead, with a reactive policy layered on top to
absorb whatever the forecast missed — capacity ready *before* the wave,
not chasing it.

## Related patterns

- [Horizontal Scaling](/docs/patterns/scaling/horizontal-scaling) — the
  mechanism auto-scaling automates: a fleet of interchangeable, stateless
  (or partitioned) instances that can be added and removed safely.
- [Vertical Scaling](/docs/patterns/scaling/vertical-scaling) — the
  scale-up alternative; largely orthogonal, and the fallback when a
  workload can't be horizontally scaled to autoscale at all.
- [Load Balancing](/docs/patterns/api-edge/load-balancing) — distributes
  traffic across the instances an autoscaler adds and removes, and must be
  told promptly when the set changes.
- [Health Check](/docs/patterns/observability/health-check) — how the
  system knows a newly launched instance is actually ready to receive
  traffic before the autoscaler counts it as capacity.
- [Queue-Based Load Leveling](/docs/patterns/batch-streaming/queue-based-load-leveling) —
  pairs naturally with worker autoscaling: the queue absorbs the burst and
  its depth is the metric the autoscaler should scale on.

## Further reading

- [What is Amazon EC2 Auto Scaling? — AWS documentation](https://docs.aws.amazon.com/autoscaling/ec2/userguide/what-is-amazon-ec2-auto-scaling.html)
- [Autoscaling guidance — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/best-practices/auto-scaling)
- [Horizontal Pod Autoscaling — Kubernetes documentation](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)
- [Autoscaling groups of instances — Google Cloud documentation](https://cloud.google.com/compute/docs/autoscaler)
- [Handling Overload — Google SRE Book](https://sre.google/sre-book/handling-overload/)
