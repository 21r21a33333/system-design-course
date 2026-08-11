---
title: "Scheduler Agent Supervisor"
sidebar_position: 14
supplementary: true
---

Scheduler Agent Supervisor coordinates a set of distributed actions
across multiple services or resources as a single logical operation: a
Scheduler sequences the steps, an Agent carries out each individual
step by invoking the actual remote action, and a Supervisor watches the
state of every step and drives recovery — retry or compensation — when
one fails.

![Scheduler Agent Supervisor diagram](/img/patterns/scheduler-agent-supervisor.svg)

## Problem it solves

A single logical operation — "book this trip," "provision this
account" — often has to touch several independent services, each of
which can succeed, fail, or simply not respond in time, and none of
which know about each other. If the calling code just calls each
service in a row with no structure around it, a mid-sequence failure
leaves the operation in an undefined state: some steps committed, some
didn't, and nothing is tracking which is which or what to do about it.
Retrying blindly can duplicate already-completed steps; giving up
silently can leave the system in a half-done state indefinitely.
Scheduler Agent Supervisor solves this by separating the concerns that
get tangled together in ad hoc code: something has to decide the order
of steps, something has to actually perform each remote call, and
something has to track outcomes and decide what happens when a step
doesn't succeed — as three distinct, independently reasoned-about
responsibilities instead of one large procedural blob.

## How it works

The three roles divide the work cleanly:

- **Scheduler.** Arranges the steps of the business operation into a
  sequence (or a graph, when steps can run in parallel) and initiates
  each step in turn, tracking overall progress through the operation.
- **Agent.** A proxy in front of each remote resource or service that
  actually invokes the real action, encapsulating that resource's
  particular API, retries, and error semantics behind a uniform
  interface the Scheduler and Supervisor can both reason about the same
  way regardless of which underlying service is involved.
- **Supervisor.** Observes the state of each step — often via durable
  state persisted as the operation progresses, so state survives a
  process restart — and reacts when a step fails or times out: retrying
  the step through its Agent, or triggering compensating actions that
  undo the effects of steps that already succeeded, to bring the whole
  operation back to a consistent state rather than leaving it half
  done.

This is deliberately close in spirit to
[orchestration](/docs/patterns/consistency/saga): the Scheduler and
Supervisor together act as a central coordinator directing each
step and reacting to failure, the same role an orchestrator plays in a
[Saga](/docs/patterns/consistency/saga). The distinction from Distributed
Task Scheduler is about *what* is being coordinated, not *how well*.
[Distributed Task
Scheduler](/docs/patterns/building-blocks/distributed-task-scheduler) is
about reliably running and scheduling jobs — recurring or one-off,
generally independent of each other — across a fleet of workers, with
its core problem being exactly-once dispatch and worker-failure
recovery for each individual job. Scheduler Agent Supervisor is about
supervising the *steps of one multi-step distributed operation* that
spans several different services — its core problem is tracking partial
progress through a sequence and recovering the overall operation
coherently, not dispatching independent jobs to a worker pool.

## Code example

The snippet below models the three roles directly: a Scheduler drives a
step sequence, Agents perform the remote calls, and a Supervisor
inspects each outcome and decides whether to retry or compensate.

```rust
enum StepResult {
    Success,
    Failed,
}

// Agent: a proxy that performs one remote action.
struct Agent {
    name: String,
}

impl Agent {
    fn invoke(&self, should_fail: bool) -> StepResult {
        if should_fail {
            StepResult::Failed
        } else {
            StepResult::Success
        }
    }

    fn compensate(&self) {
        println!("compensating step: {}", self.name);
    }
}

// Supervisor: watches outcomes and decides retry vs. compensate.
struct Supervisor {
    max_retries: u32,
}

impl Supervisor {
    fn handle(&self, agent: &Agent, should_fail: bool) -> StepResult {
        for attempt in 0..self.max_retries {
            match agent.invoke(should_fail && attempt < self.max_retries - 1) {
                StepResult::Success => return StepResult::Success,
                StepResult::Failed => continue,
            }
        }
        agent.compensate();
        StepResult::Failed
    }
}

// Scheduler: sequences the steps of one logical operation.
fn run_operation(steps: &[Agent], supervisor: &Supervisor) -> bool {
    for (i, step) in steps.iter().enumerate() {
        // Simulate the second step failing until the final retry attempt.
        let should_fail = i == 1;
        if let StepResult::Failed = supervisor.handle(step, should_fail) {
            return false;
        }
    }
    true
}
```

`run_operation` plays the Scheduler's role, sequencing steps; each
`Agent::invoke` call is the proxy performing the actual remote action;
and `Supervisor::handle` is where retry-vs-compensate is decided per
step, independent of what any other step is doing.

## When to use it

- A single business operation spans multiple independent services or
  resources, and needs coordinated tracking of which steps have
  completed.
- Steps can fail or time out individually, and failures need a
  deliberate recovery response — retry or compensating action — rather
  than leaving the operation in a partially completed state.
- The set of remote actions benefits from a uniform interface (via
  Agents) so the coordination logic doesn't need to special-case each
  underlying service's API.

## When not to use it

- The operation is a single call to a single service — there's no
  multi-step sequence to coordinate, and the pattern's roles add
  structure with nothing to structure.
- Steps are truly independent scheduled jobs with no shared operation
  tying them together — that's the shape [Distributed Task
  Scheduler](/docs/patterns/building-blocks/distributed-task-scheduler)
  addresses directly.
- A workflow engine or saga orchestration framework already provides
  this coordination out of the box, making a hand-built
  Scheduler/Agent/Supervisor redundant.

## Real-world example

A trip-booking system reserving a flight, a hotel, and a rental car as
one logical booking uses a Scheduler to sequence the three reservation
steps, an Agent per provider to encapsulate each one's booking API, and
a Supervisor that — if the hotel reservation fails after the flight
succeeded — retries the hotel booking a bounded number of times, and
falls back to cancelling (compensating) the already-booked flight if
the hotel step can't ultimately succeed.

## Related patterns

- [Distributed Task
  Scheduler](/docs/patterns/building-blocks/distributed-task-scheduler) —
  addresses reliably running recurring or scheduled jobs across a
  worker fleet, a related but distinct coordination problem from
  supervising the steps of one multi-step operation.
- [Saga](/docs/patterns/consistency/saga) — the orchestrated variant of
  a saga plays a near-identical coordinating role to the Scheduler and
  Supervisor here, sequencing steps and triggering compensations on
  failure.

## Further reading

- [Scheduler Agent Supervisor pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/scheduler-agent-supervisor)
- [Orchestration (computing) — Wikipedia](https://en.wikipedia.org/wiki/Orchestration_(computing))
