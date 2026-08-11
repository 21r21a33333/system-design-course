---
title: "Circuit Breaker"
sidebar_position: 4
supplementary: true
---

A circuit breaker stops a caller from repeatedly invoking a dependency
that has crossed a failure threshold — failing fast instead — and
periodically allows a probe call through to detect recovery, moving
between closed, open, and half-open states.

![Circuit Breaker diagram](/img/patterns/circuit-breaker.svg)

## Problem it solves

A timeout bounds how long a single call can hang, but it doesn't stop the
caller from dutifully retrying the same failing dependency, request after
request, each one still paying the full timeout cost before failing. If a
downstream service is down or overloaded, every caller still attempting
calls is spending threads, connections, and latency budget on requests
very likely to fail anyway. That wasted effort doesn't just fail to help
the callee recover — it actively harms the caller, whose own resources
(thread pool, connection pool) get tied up waiting on doomed calls,
degrading its ability to serve any of its own traffic, including requests
that don't even depend on the failing service. Worse, a stream of
timing-out retries adds load to a dependency that is *already* overloaded,
deepening the outage. The circuit breaker is the mechanism that detects
"this dependency is clearly down" and stops throwing good requests after
bad.

## Technical architecture & implementation

**The three-state machine.** A breaker wraps calls to a dependency and
tracks their recent outcomes across three states. In **Closed** (normal
operation) calls pass through and failures are counted; crossing the
failure threshold trips it to **Open**. In **Open**, calls are rejected
immediately without touching the dependency — this is the "fail fast" that
protects the caller's resources — and a fallback is returned if one
exists. After a **reset timeout** the breaker moves to **Half-Open**,
where a limited number of trial calls are allowed through to test whether
the dependency has recovered; success closes it, failure re-opens it. The
[state transitions](#state-transitions) section walks the full machine.

**What trips the breaker — failure-rate vs. consecutive-count.** Two
tripping policies dominate. **Consecutive-count** trips after N failures in
a row — simple and predictable, but a single interleaved success resets
the counter, so it can miss a dependency that's failing 40% of the time.
**Failure-rate** trips when the failure percentage over a rolling window
(e.g. "50% of the last 20 calls") crosses a threshold — better at catching
partial degradation, but it needs a **minimum-throughput** guard so the
breaker doesn't trip on "1 of 2 calls failed" during a quiet period.
Production breakers (resilience4j, Polly) typically default to rate-based
tripping over a sliding window with a minimum call count.

**What counts as a failure.** The breaker's failure predicate must be
defined deliberately: timeouts, connection refusals, and 5xx responses
count; a 4xx like 404 or 400 is a *client* error and generally should
**not** count, or a stream of bad requests would trip the breaker and deny
service to healthy callers. Getting this predicate wrong is a common
source of spurious trips.

**The reset timeout and half-open trial.** The reset timeout is how long
the breaker stays Open before probing again — long enough to give a
struggling dependency room to recover, short enough to notice recovery
promptly. Half-Open deliberately limits exposure: it lets only a small
number of trial requests through (often just one) so that if the
dependency is *still* broken, it isn't immediately re-flooded with full
traffic. A single failed trial re-opens the breaker and restarts the
cooldown.

**Fallbacks.** Tripping the breaker converts one failure mode (slow
timeouts) into another (fast rejections) unless it's paired with a
**fallback**: cached data, a default value, a queued write, or a degraded
response. Without a fallback, an open breaker just fails faster — useful
for protecting the caller's resources, but it should usually be combined
with [graceful degradation](/docs/patterns/reliability/graceful-degradation)
so the user gets a reduced-but-useful result rather than an error.

**Per-dependency breakers and metrics.** One global breaker is an
antipattern: a failing recommendations service shouldn't be able to trip
the breaker guarding the payments service. Each dependency (and often each
distinct operation) gets its **own** breaker with its own thresholds,
which pairs naturally with the [bulkhead](/docs/patterns/reliability/bulkhead)
pattern's per-dependency resource pools. Breakers must also be
**observable** — trip and reset events are strong operational signals, and
a breaker that opens silently hides an outage.

**Failure modes.** A breaker tuned **too sensitive** trips on normal
transient noise and *flaps* (open → half-open → open), amplifying a minor
blip into denied service. Tuned **too lax**, it barely trips and provides
little protection, letting the caller keep hammering a dead dependency.
Tuning is empirical — set thresholds from observed error rates, not
guesses — and the reset timeout must exceed the dependency's realistic
recovery time or the breaker will half-open into a still-broken dependency
repeatedly.

**Where it sits among siblings.** A breaker and a
[retry](/docs/patterns/reliability/retry-with-backoff) are complementary
opposites: a retry *repeats* a call assuming the failure was transient; a
breaker *stops* calls once a dependency is clearly not transiently failing.
They compose as **retry inside a breaker** — retry the blips, but once the
breaker trips, it short-circuits the retries so a genuinely-down dependency
isn't hammered. A breaker builds on
[timeout](/docs/patterns/reliability/timeout) (a call must fail fast to be
counted) and pairs with [bulkhead](/docs/patterns/reliability/bulkhead)
(which *isolates resources* while the breaker *stops calls*). Unlike
[failover](/docs/patterns/reliability/failover), a breaker does nothing to
*replace* the failing dependency — it only protects the caller from it;
the two are commonly layered, a breaker short-circuiting a failing primary
while a failover promotes a standby.

## State transitions

![Circuit Breaker state machine](/img/patterns/circuit-breaker-states.svg)

- **Closed → Open.** While Closed, calls flow and outcomes are counted.
  When the failure rate or consecutive-failure count crosses the
  threshold, the breaker trips to Open and records the time it opened.
- **Open → Half-Open.** In Open, every call is rejected immediately
  (fallback returned). Once the reset timeout has elapsed since it opened,
  the *next* call attempt transitions the breaker to Half-Open instead of
  being rejected.
- **Half-Open → Closed.** Half-Open admits a limited number of trial
  calls. If they succeed (meeting the trial quota), the breaker closes and
  normal traffic resumes; the failure counter is cleared.
- **Half-Open → Open.** If a trial call fails, the breaker immediately
  re-opens and the cooldown restarts — this is what limits exposure to a
  dependency that has not actually recovered.

The code example implements exactly this machine with an injectable clock.

## Code example

A circuit breaker driven by an injected monotonic clock (a `Duration`), so
its time-based transitions are deterministic under test. `allow` decides
whether a call may proceed — transitioning Open → Half-Open once the reset
window elapses — while `on_success` / `on_failure` record outcomes and
drive the state changes.

```rust
use std::time::Duration;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum State {
    Closed,
    Open,
    HalfOpen,
}

pub enum Call {
    Allowed,
    Rejected,
}

// A monotonic clock is injected so the breaker's time-based transitions
// are deterministic under test rather than depending on wall-clock sleeps.
pub struct Breaker {
    state: State,
    consecutive_failures: u32,
    failure_threshold: u32,   // trip Closed -> Open at this many in a row
    reset_after: Duration,    // Open -> HalfOpen once this elapses
    opened_at: Duration,      // timestamp the breaker last opened
    half_open_successes: u32, // trial successes seen while HalfOpen
    trial_quota: u32,         // successes needed to close from HalfOpen
}

impl Breaker {
    pub fn new(failure_threshold: u32, reset_after: Duration, trial_quota: u32) -> Self {
        Breaker {
            state: State::Closed,
            consecutive_failures: 0,
            failure_threshold,
            reset_after,
            opened_at: Duration::ZERO,
            half_open_successes: 0,
            trial_quota,
        }
    }

    pub fn state(&self) -> State {
        self.state
    }

    // Decide whether a call may proceed. A breaker that has been Open long
    // enough transitions to HalfOpen and lets a trial through; otherwise
    // Open rejects immediately.
    pub fn allow(&mut self, now: Duration) -> Call {
        match self.state {
            State::Closed | State::HalfOpen => Call::Allowed,
            State::Open => match now.saturating_sub(self.opened_at) >= self.reset_after {
                true => {
                    self.state = State::HalfOpen;
                    self.half_open_successes = 0;
                    Call::Allowed
                }
                false => Call::Rejected,
            },
        }
    }

    pub fn on_success(&mut self) {
        match self.state {
            State::HalfOpen => {
                self.half_open_successes += 1;
                if self.half_open_successes >= self.trial_quota {
                    self.state = State::Closed;
                    self.consecutive_failures = 0;
                }
            }
            _ => self.consecutive_failures = 0,
        }
    }

    // A failure is anything the policy counts: a timeout, a 5xx, a refused
    // connection. In HalfOpen a single failure re-opens immediately.
    pub fn on_failure(&mut self, now: Duration) {
        match self.state {
            State::HalfOpen => self.trip(now),
            _ => {
                self.consecutive_failures += 1;
                if self.consecutive_failures >= self.failure_threshold {
                    self.trip(now);
                }
            }
        }
    }

    fn trip(&mut self, now: Duration) {
        self.state = State::Open;
        self.opened_at = now;
        self.consecutive_failures = 0;
    }
}
```

Walking through the lifecycle: the breaker stays Closed below the
threshold, Opens on the Nth consecutive failure, rejects while Open,
Half-Opens exactly when the reset window elapses, closes on a successful
trial, and re-opens on a failed one.

## When to use it

- Calls to a remote dependency that can fail for an extended period (not
  just a single transient blip), where continuing to call it adds no value
  and only consumes caller resources.
- Any dependency whose failure could otherwise cascade upstream through
  resource exhaustion in the caller.
- Paired with a fallback (cached data, a default, a degraded response) so
  tripping the breaker doesn't just convert one failure mode into another.
- Alongside retry: retry the transient blips, but let the breaker
  short-circuit once a dependency is clearly down.

## When not to use it

- Low-volume or non-critical internal calls where the complexity (state
  tracking, threshold tuning, monitoring trip events) isn't worth it.
- As a substitute for fixing a chronically failing dependency — it manages
  the symptom for callers, not the root cause.
- Where failing fast has no better answer than failing slow and there's no
  fallback — an open breaker without a fallback only changes *how* the
  request fails, which may or may not be an improvement.

## Use-case scenarios

**Microservice guarding a flaky downstream.** A product-page service calls
a recommendations service that occasionally degrades under load. A
per-dependency breaker trips when recommendation calls start timing out;
while Open, the page renders instantly with a generic "popular items"
fallback instead of hanging on every request. When the reset timeout
elapses, a single half-open probe tests recovery; on success the breaker
closes and personalized recommendations return — the page never froze, and
the recommendations service got breathing room to recover.

**Payment gateway protection.** A checkout service calls an external
payment gateway. When the gateway starts returning 503s, a breaker trips
and the service immediately shows "payment temporarily unavailable, try
again shortly" rather than making every customer wait through a 10-second
timeout. Crucially the payments breaker is *separate* from the breaker
guarding the shipping-rate service, so a payment outage can't deny service
to unrelated parts of checkout.

**Retry + breaker composition against a database replica.** A read service
retries transient query failures against a replica with exponential
backoff. Those retries run *inside* a breaker: a momentary blip is
absorbed by retry, but if the replica goes fully down, the breaker trips
and short-circuits the retry loop, so the service stops piling retry
traffic onto a dead replica and fails fast to a fallback replica or cache.

## Production libraries & getting started

Most languages have a mature breaker library; resilience4j (Java) and Polly (.NET) are the canonical references the rest tend to mirror.

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| opossum | JS/TS | Breaker with fallback, half-open probing, and per-breaker stats/events | [nodeshift.dev/opossum](https://nodeshift.dev/opossum/) ([npm](https://www.npmjs.com/package/opossum)) |
| failsafe-rs (`failsafe`) | Rust | Composable breaker policies (consecutive-count and failure-rate) | [docs.rs/failsafe](https://docs.rs/failsafe/latest/failsafe/) |
| sony/gobreaker | Go | Small, widely-used breaker with a configurable trip predicate | [pkg.go.dev/sony/gobreaker](https://pkg.go.dev/github.com/sony/gobreaker) |
| pybreaker | Python | Thread-safe breaker with listeners and pluggable storage | [pypi.org/project/pybreaker](https://pypi.org/project/pybreaker/) |
| aiobreaker | Python (async) | asyncio-native breaker for `async`/`await` call sites | [pypi.org/project/aiobreaker](https://pypi.org/project/aiobreaker/) |
| resilience4j CircuitBreaker | Java | Canonical rate-based sliding-window breaker | [resilience4j.readme.io — CircuitBreaker](https://resilience4j.readme.io/docs/circuitbreaker) |
| Polly | .NET | Canonical breaker + fallback strategies for .NET | [pollydocs.org — Circuit breaker](https://www.pollydocs.org/strategies/circuit-breaker) |

**Example / reference:** [Netflix Hystrix — How it Works](https://github.com/Netflix/Hystrix/wiki/How-it-Works)

## Related patterns

- [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff) —
  the complement to a breaker: retry *repeats* calls, a breaker *stops*
  them; the standard composition is retry inside a breaker.
- [Timeout](/docs/patterns/reliability/timeout) — bounds a single call; a
  breaker decides whether to attempt the call at all, and counts timeouts
  as failures.
- [Bulkhead](/docs/patterns/reliability/bulkhead) — *isolates resources*
  per dependency while a breaker *stops calls*; commonly paired, one
  breaker per isolated pool.
- [Graceful Degradation](/docs/patterns/reliability/graceful-degradation) —
  the reduced response an open breaker's fallback typically serves.
- [Failover](/docs/patterns/reliability/failover) — replaces a failed
  dependency with a standby; a breaker only protects the caller from it.
  The two layer together — a breaker short-circuits a failing primary while
  failover promotes a standby.

## Further reading

- [CircuitBreaker — martinfowler.com](https://martinfowler.com/bliki/CircuitBreaker.html)
- [Circuit breaker design pattern — Wikipedia](https://en.wikipedia.org/wiki/Circuit_breaker_design_pattern)
- [Circuit Breaker pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker)
- ["Release It!" by Michael Nygard](https://pragprog.com/titles/mnee2/release-it-second-edition/) — the book that introduced the Circuit Breaker stability pattern.
- [How it Works — Netflix Hystrix wiki](https://github.com/Netflix/Hystrix/wiki/How-it-Works) — the library that popularized breakers for microservices.
