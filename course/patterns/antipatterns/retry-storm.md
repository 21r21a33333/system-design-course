---
title: "Retry Storm"
sidebar_position: 9
supplementary: true
---

A retry storm happens when a large number of callers retry failed
requests against a downstream service so aggressively — immediately, at
fixed intervals, without any circuit-breaking mechanism to stop the
attempts once it's clear the service is unhealthy — that the retries
themselves become the dominant source of load on a service that was
already struggling, turning a brief degradation into an extended
outage.

![Retry Storm diagram](/img/patterns/retry-storm.svg)

## How it manifests

The pattern usually starts with a downstream service becoming slow or
briefly unavailable — a database under momentary load, a dependency
restarting, a network blip — while every caller keeps retrying failed
requests immediately and unconditionally. Each retry is itself a new
request competing for the same limited resources (connections, threads,
CPU) that are already the reason the service is struggling, so the
retries add load precisely where load is least affordable, at exactly
the moment the service needs *less* incoming traffic to recover, not
more. What began as a transient blip that would have resolved itself in
seconds instead compounds into a sustained outage, because the retry
traffic keeps the service pinned at overload long after the original
triggering event has passed.

The most damaging variant is synchronized retries: many callers who
happened to fail at the same moment (because they were all calling the
same now-struggling service) all compute the same fixed retry delay and
therefore all retry at the same moment too, producing a sharp,
synchronized burst rather than smoothly distributed load. If the
service manages to recover just long enough to handle a fraction of
that burst, it can look briefly healthy, encourage even more retries
from callers who were about to give up, and then collapse again under
the renewed burst — an oscillating pattern of brief apparent recovery
followed by renewed collapse that can persist far longer than the
original failure would have on its own. This dynamic is well
documented rather than theoretical — it's specifically why AWS's own
engineering guidance on handling downstream failures spends as much
time on jittered backoff as it does on the retry logic itself: the
jitter (randomizing each caller's delay rather than using the same
fixed schedule for everyone) is the direct countermeasure to
synchronized retry bursts, not an optional refinement on top of retry.

The operational signature is a clear divergence between the downstream
service's actual unique-request load and its *total* request volume:
request rate at the service climbs well past what upstream traffic
volume alone would explain, because a growing fraction of arriving
requests are retries of requests that already failed once (or several
times). Error rates and latency both stay elevated well past the point
where the original triggering issue (the database blip, the brief
network partition) has resolved, because the system is now failing
under the weight of its own retry traffic rather than the original
cause. Distributed tracing, if request IDs are threaded through retries
consistently, shows the same logical request represented many times in
a short window, each attempt failing for the same reason as the last.

## Why it happens

Retrying failed requests is a reasonable, even necessary, default
behavior — most transient failures genuinely do resolve on their own,
and simply giving up on the first failure wastes real recovery
opportunities. The mistake is rarely "retrying is wrong," it's
implementing retry without either backoff or a circuit breaker: a naive
retry loop (try again immediately, or after a short fixed delay, up to
some attempt limit) is the simplest version to write and is
functionally indistinguishable from a correct implementation under
light load or in isolated testing, since a single client retrying a
single failure never produces enough volume to overwhelm anything.

The danger only appears at the scale of *many independent callers*
retrying against the *same* dependency at *around the same time* — a
condition that's specifically hard to reproduce in development or
single-service testing, where there's rarely a realistic simulation of
what hundreds or thousands of production clients do simultaneously when
a shared dependency degrades. It's also easy to add retry logic to a
client library defensively, one dependency at a time, without a
system-wide view of how many other clients are independently retrying
against that same dependency — each individual retry policy can look
locally reasonable while the aggregate behavior across every caller is
what actually causes the storm.

## Code example (the antipattern)

```rust
// Retries immediately, with no delay and no circuit breaker — every
// caller doing this against the same struggling dependency adds load
// at the worst possible moment, with no growing delay to ease off.
struct DownstreamClient;

impl DownstreamClient {
    fn call(&self) -> Result<String, String> {
        Err("service unavailable".to_string()) // simulated failure
    }
}

fn call_with_naive_retry(client: &DownstreamClient, max_attempts: u32) -> Result<String, String> {
    let mut last_err = String::new();
    for _ in 0..max_attempts {
        match client.call() {
            Ok(response) => return Ok(response),
            // No delay between attempts, and no check for whether the
            // dependency has been failing consistently enough that
            // more attempts are actively harmful rather than helpful.
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}
```

## The fix

```rust
use std::time::Duration;

struct DownstreamClient;
impl DownstreamClient {
    fn call(&self) -> Result<String, String> {
        Err("service unavailable".to_string())
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum CircuitState {
    Closed,
    Open,
}

// Combines exponential backoff (growing delay between attempts) with
// a circuit breaker (stop attempting entirely once failures cross a
// threshold) — the two mechanisms retry-storm specifically results
// from missing.
struct ResilientCaller {
    state: CircuitState,
    consecutive_failures: u32,
    failure_threshold: u32,
}

impl ResilientCaller {
    fn call_with_backoff(
        &mut self,
        client: &DownstreamClient,
        max_attempts: u32,
    ) -> Result<String, String> {
        if self.state == CircuitState::Open {
            // The circuit is open: fail fast locally instead of
            // adding one more request to an already-overloaded
            // dependency.
            return Err("circuit open: not calling downstream".to_string());
        }

        let mut delay_ms: u64 = 100;
        for attempt in 0..max_attempts {
            match client.call() {
                Ok(response) => {
                    self.consecutive_failures = 0;
                    return Ok(response);
                }
                Err(e) => {
                    self.consecutive_failures += 1;
                    if self.consecutive_failures >= self.failure_threshold {
                        self.state = CircuitState::Open;
                        return Err(e);
                    }
                    if attempt + 1 < max_attempts {
                        // Exponential backoff: each subsequent attempt
                        // waits longer, easing off load instead of
                        // hammering the dependency at a fixed rate.
                        std::thread::sleep(Duration::from_millis(delay_ms));
                        delay_ms *= 2;
                    }
                }
            }
        }
        Err("max attempts exhausted".to_string())
    }
}
```

The fix layers two mechanisms on top of the naive retry loop: backoff
grows the delay between each individual caller's own attempts, easing
off load instead of hammering at a fixed rate, and the circuit breaker
stops attempts entirely once failures cross a threshold, so a caller
that's already confirmed the dependency is down stops contributing to
its load at all rather than continuing to retry into the void.

## How to detect it

A downstream service's total request rate diverging sharply from
upstream traffic volume — more requests arriving than the known number
of distinct logical operations being performed — is the clearest
structural signal, since the gap is retry volume. Elevated error rate
and latency that persist well past the resolution of the original
triggering incident (visible by comparing the timeline of the root
cause against the timeline of continued degradation) indicates the
system is now suffering from its own retry traffic rather than the
original problem. Distributed tracing that shows the same logical
request (by a consistent request ID threaded through retries) appearing
many times in a short window, each attempt failing, is direct evidence
of retries without effective backoff or circuit breaking. A metric
tracking retry count as a fraction of total request volume, if
instrumented, spiking sharply during an incident is the most direct
possible signal.

## When it's actually fine

Retrying without backoff is reasonable when the caller population is
small and known — a single background job with one worker retrying a
call to a dependency it owns doesn't have the "many independent
callers" dynamic that turns retries into a storm, since there's no
aggregate synchronized burst to create. It's also fine for operations
where a fixed, small number of immediate retries (two or three, not an
unbounded loop) is used specifically to absorb truly momentary
blips (a single dropped packet) with no realistic risk of the
dependency being under sustained load — the risk retry storm describes
is specifically about *many* callers retrying *persistently failing*
calls, not about a bounded handful of retries for genuinely
instantaneous errors.

## Related patterns

- [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff) —
  retry storm is exactly what happens when retries are implemented
  without the growing delay (and jitter) this pattern provides; backoff
  alone is half of the fix.
- [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) — the
  other half of the fix: stops a caller from continuing to retry a
  dependency that's been failing consistently, which backoff alone
  doesn't guarantee if the failure threshold is high or attempts are
  unbounded.

## Further reading

- [Retry Storm antipattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/antipatterns/retry-storm/)
- [Exponential backoff — Wikipedia](https://en.wikipedia.org/wiki/Exponential_backoff)
- [Timeouts, retries, and backoff with jitter — AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/rel_mitigate_interaction_failure_avoid_overload.html)
- [System Design roadmap — roadmap.sh](https://roadmap.sh/system-design) — includes Retry Storm as a named antipattern topic.
