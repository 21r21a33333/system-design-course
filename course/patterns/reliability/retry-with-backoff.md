---
title: "Retry with Backoff"
sidebar_position: 2
supplementary: true
---

Retry with backoff re-attempts a failed call after a delay that grows
exponentially with each subsequent failure — typically with random
jitter added — instead of retrying immediately or at a fixed interval.

![Retry with Backoff diagram](/img/patterns/retry-with-backoff.svg)

## Problem it solves

Transient failures — a dropped packet, a momentary network blip, a
dependency briefly overloaded — are often gone a moment later, so simply
giving up on the first failure wastes a good chance of success. But naive
immediate retry is dangerous: if a dependency is struggling because it's
overloaded, every caller retrying instantly adds more load on top of the
load that caused the failure. And if many callers fail at once — for
example, right after a dependency recovers and everyone reconnects
simultaneously — they also all retry at once, hitting it with a
synchronized burst (a "retry storm") that can re-trigger the very overload
the retries were meant to recover from, turning a brief blip into an
extended outage. Backoff and jitter exist to keep retries *helpful*
(recovering from transient failures) without letting them become an
*amplifier* of an overload.

## Technical architecture & implementation

**Transient vs. permanent failures.** The first decision a retry policy
makes is whether an error is even *retryable*. A **transient** failure —
a timeout, a connection reset, an HTTP 429 (too many requests) or 503
(service unavailable) — is plausibly gone on the next attempt and is worth
retrying. A **permanent** failure — a 400 (bad request), 401
(unauthorized), or 404 (not found) — will fail identically no matter how
many times it's retried; retrying it only burns the budget and adds load
for zero chance of success. A correct policy retries *only* on an
explicit allowlist of retryable errors and gives up immediately on
everything else.

**Exponential backoff.** After each failure the wait grows geometrically,
commonly doubling: 100 ms, 200 ms, 400 ms, 800 ms, and so on, up to a
**capped maximum** so the delay can't grow unboundedly. Exponential growth
means a dependency under sustained stress sees rapidly *thinning* retry
traffic from each client, giving it room to recover, instead of a constant
drumbeat.

**Jitter — why randomization is not optional.** Exponential backoff alone
does not solve the synchronized-burst problem: if a thousand clients all
fail at the same instant, they *all* wait exactly 100 ms, then all retry
at exactly the same moment, then all wait exactly 200 ms — the herd stays
in lockstep. **Jitter** randomizes each client's delay so the herd
disperses across the retry window. The common strategies:

| Strategy | Delay formula (attempt *n*, base *b*, cap *c*) | Notes |
| --- | --- | --- |
| **No jitter** | `min(c, b · 2ⁿ)` | Deterministic; keeps herds synchronized. Avoid. |
| **Full jitter** | `random(0, min(c, b · 2ⁿ))` | Delay uniform in the whole window. Best spread; AWS's default recommendation. |
| **Equal jitter** | `½·d + random(0, ½·d)` where `d = min(c, b · 2ⁿ)` | Guarantees a minimum wait plus randomness; slightly less spread than full. |
| **Decorrelated jitter** | `min(c, random(b, prev·3))` | Each delay derived from the previous one; smooths bursts well for long-running retries. |

Full jitter is the usual default: it gives the widest spread and is
trivial to reason about. The code example below computes a full-jitter
schedule.

**Retry budgets and caps.** Two independent limits bound the damage.
A **max-attempts** cap (e.g. 3–5 tries) stops any single call from
retrying forever. A **retry budget** — a system-wide cap, often expressed
as "retries may be at most X% of total requests" — stops a broad outage
from turning every client into a retrying amplifier; when the budget is
exhausted, further retries are suppressed even though individual calls
would otherwise be eligible. Budgets are what keep retries from converting
a partial failure into total collapse.

**Idempotency is a hard prerequisite.** Only
[idempotent](/docs/patterns/reliability/idempotency) operations are safe
to retry automatically. If a request already succeeded on the server but
the response was lost in transit, retrying a non-idempotent operation like
"charge \$50" or "increment inventory by 1" *duplicates* the effect. Reads
and operations designed to be idempotent (via an idempotency key, a
conditional write, or natural idempotence) are safe to retry blindly;
anything else needs a deduplication mechanism or a decision not to
auto-retry. Retrying without idempotency doesn't fail loudly — it silently
double-applies side effects, which is far worse.

**Failure mode: the retry storm.** The dominant way retries go wrong is
the [retry storm](/docs/patterns/antipatterns/retry-storm): synchronized,
budget-less retries pile onto a struggling dependency and keep it down.
The full set of defenses — retryable-only classification, exponential
backoff, jitter, max-attempts, and a retry budget — all exist to prevent
this single failure mode.

**Where it sits among siblings.** Retry and [Circuit
Breaker](/docs/patterns/reliability/circuit-breaker) are complementary
opposites that compose: a retry *repeats* a call hoping the failure was
transient, while a breaker *stops* calls once a dependency is clearly down
so nobody keeps paying the cost. The standard composition is **retry
inside a breaker** — retry the transient blips, but once failures cross
the breaker's threshold, the breaker trips and short-circuits the retries
entirely, so a genuinely-down dependency isn't hammered by every client's
retry loop. A retry also depends on
[Timeout](/docs/patterns/reliability/timeout): you can only retry a call
that failed *quickly*, so the timeout is what makes the failure actionable.
Unlike [Failover](/docs/patterns/reliability/failover), a retry keeps
calling the *same* dependency rather than redirecting to a replacement.

## Code example

A full-jitter exponential backoff driver. The delay for retry *n* is
picked uniformly in `[0, min(cap, base·2ⁿ)]`; the RNG is injected as a
`rand01()` closure so the schedule is deterministic under test. The
`run` loop retries only transient failures, stops immediately on
permanent ones, and gives up when the attempt budget is exhausted.

```rust
use std::time::Duration;

// Only transient errors are worth retrying. A permanent error (bad
// request, auth failure, 404) will never succeed on retry, so retrying it
// only wastes the budget and adds load.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Outcome {
    Ok,
    Transient, // timeout, 429, 503, connection reset
    Permanent, // 400, 401, 404 — do not retry
}

pub struct BackoffPolicy {
    base: Duration,    // delay for the first retry
    cap: Duration,     // maximum any single wait may reach
    max_attempts: u32, // total tries, including the initial one
    factor: u32,       // exponential multiplier per attempt (usually 2)
}

impl BackoffPolicy {
    pub fn new(base: Duration, cap: Duration, max_attempts: u32) -> Self {
        BackoffPolicy { base, cap, max_attempts, factor: 2 }
    }

    // Full-jitter delay for a (zero-based) retry number: uniform in
    // [0, exp_backoff]. `rand01` is an injectable uniform sample in [0,1)
    // so the schedule is deterministic under test. Full jitter is what
    // breaks the lockstep that causes synchronized retry storms.
    pub fn delay(&self, retry: u32, rand01: f64) -> Duration {
        let exp = self.base.saturating_mul(self.factor.saturating_pow(retry));
        let ceil = exp.min(self.cap);
        ceil.mul_f64(rand01.clamp(0.0, 1.0))
    }

    // Drive a retryable operation. `op` returns an Outcome; `sleep`
    // receives the computed jittered delay (injected so tests don't wait).
    // Returns Ok(attempts) on success, Err(attempts) on give-up.
    pub fn run<F, S, R>(&self, mut op: F, mut sleep: S, mut rand01: R) -> Result<u32, u32>
    where
        F: FnMut() -> Outcome,
        S: FnMut(Duration),
        R: FnMut() -> f64,
    {
        let mut attempts = 0;
        loop {
            attempts += 1;
            match op() {
                Outcome::Ok => return Ok(attempts),
                Outcome::Permanent => return Err(attempts), // never retried
                Outcome::Transient => {
                    if attempts >= self.max_attempts {
                        return Err(attempts); // budget exhausted
                    }
                    let d = self.delay(attempts - 1, rand01());
                    sleep(d);
                }
            }
        }
    }
}
```

Tracing the logic: delays double until the cap, full jitter can
collapse a delay to zero, permanent errors never retry, and transient
errors retry until success or budget exhaustion.

## When to use it

- The failure is plausibly transient — network errors, timeouts, HTTP
  429/503 — rather than a permanent rejection like a validation error or
  404.
- The operation is idempotent, or is made safe to retry via an idempotency
  key or conditional write.
- The caller can afford the added latency of retry attempts within its own
  timeout budget, and backoff plus jitter are in place to avoid storms.

## When not to use it

- The operation isn't idempotent and has no deduplication mechanism —
  retrying risks duplicating side effects (double charges, duplicate
  emails, double-shipped orders).
- The failure is deterministic (bad request, auth failure) — retrying an
  error that will never succeed just adds latency and load.
- The caller is already near its own timeout or SLA budget — retries
  consume time that might be better spent failing fast and letting the
  caller's caller decide what to do.
- Retries without backoff, jitter, and a cap: unbounded or synchronized
  retry is a cause of outages, not a cure.

## Use-case scenarios

**Cloud SDK calling a throttled API.** A batch job writes thousands of
records to a managed data store that returns HTTP 429 under burst load.
The SDK's built-in exponential backoff with full jitter spreads the
retries so the herd of writers naturally paces itself to the store's
capacity — the job completes a little slower but without the synchronized
hammering that a fixed-interval retry would cause. Because writes are
keyed idempotently, a retried write that actually succeeded server-side
doesn't create a duplicate.

**Payment capture with an idempotency key.** A checkout service captures a
payment through a gateway. Network timeouts mean the service sometimes
can't tell whether a capture succeeded. Every capture carries a client-
generated idempotency key, so the service retries transient failures
safely: if the original capture already went through, the gateway
recognizes the key and returns the *existing* result instead of charging
the customer twice.

**Message consumer with bounded retries and a dead-letter queue.** A
worker consumes events from a queue; processing occasionally fails on a
transient downstream error. It retries with exponential backoff up to a
small cap, and if the event still won't process, it routes to a
[dead-letter queue](/docs/patterns/reliability/dead-letter-queue) for
later inspection rather than retrying forever and blocking the partition —
retry handles the transient case, the DLQ handles the poison-message case.

## Production libraries & getting started

Reach for a library rather than hand-rolling the delay math — these implement exponential backoff, jitter, retryable-error classification, and attempt caps for you.

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| p-retry | JS/TS | Promise-based retry over exponential backoff with an abort signal | [github.com/sindresorhus/p-retry](https://github.com/sindresorhus/p-retry) ([npm](https://www.npmjs.com/package/p-retry)) |
| cockatiel | JS/TS | Retry, backoff, and jitter as composable resilience policies | [github.com/connor4312/cockatiel](https://github.com/connor4312/cockatiel) ([npm](https://www.npmjs.com/package/cockatiel)) |
| backon | Rust | Backoff schedules (exponential, constant) for sync and async retries | [docs.rs/backon](https://docs.rs/backon/latest/backon/) |
| tokio-retry | Rust | Retry futures on a tokio runtime with pluggable backoff strategies | [docs.rs/tokio-retry](https://docs.rs/tokio-retry/latest/tokio_retry/) |
| cenkalti/backoff | Go | Exponential backoff with full jitter and context support | [pkg.go.dev/cenkalti/backoff](https://pkg.go.dev/github.com/cenkalti/backoff/v4) |
| avast/retry-go | Go | Ergonomic retry wrapper with configurable delay and retry-if predicates | [pkg.go.dev/avast/retry-go](https://pkg.go.dev/github.com/avast/retry-go) |
| tenacity | Python | Declarative retry decorators with wait/stop/retry policies | [tenacity.readthedocs.io](https://tenacity.readthedocs.io/en/latest/) |
| backoff | Python | Decorator-based exponential/fibonacci backoff with jitter | [pypi.org/project/backoff](https://pypi.org/project/backoff/) |
| resilience4j Retry | Java | Canonical retry module with backoff and result/exception predicates | [resilience4j.readme.io — Retry](https://resilience4j.readme.io/docs/retry) |

**Example / reference:** [Timeouts, retries, and backoff with jitter — Amazon Builders' Library](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)

## Related patterns

- [Timeout](/docs/patterns/reliability/timeout) — a retry only makes sense
  after a *bounded* failure, which the timeout provides; the two are
  always used together.
- [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) — the
  complement to retry: retry *repeats* calls, a breaker *stops* them once a
  dependency is clearly down; the standard composition is retry inside a
  breaker.
- [Idempotency](/docs/patterns/reliability/idempotency) — what makes an
  operation safe to retry without duplicating side effects; a hard
  prerequisite for automatic retry.
- [Dead-Letter Queue](/docs/patterns/reliability/dead-letter-queue) —
  where a message goes once bounded retries are exhausted, so a poison
  message doesn't retry forever.
- [Failover](/docs/patterns/reliability/failover) — redirects to a standby
  *replacement*, whereas retry keeps calling the same dependency.
- [Retry Storm](/docs/patterns/antipatterns/retry-storm) — the antipattern
  that backoff, jitter, and retry budgets exist to prevent.
- [Cascading Failures](/docs/patterns/reliability/cascading-failures) —
  the broader failure mode this pattern is one defense against; covers why
  retries multiply across layers and how backoff, load shedding, and
  deadline propagation combine to stop an overload from spreading.

## Further reading

- [Exponential backoff — Wikipedia](https://en.wikipedia.org/wiki/Exponential_backoff)
- [Timeouts, retries, and backoff with jitter — Amazon Builders' Library](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)
- [Exponential Backoff And Jitter — AWS Architecture Blog](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
- [Retry behavior — AWS SDKs and Tools Reference Guide](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html)
- [Addressing cascading failures — Google SRE Book](https://sre.google/sre-book/addressing-cascading-failures/)
