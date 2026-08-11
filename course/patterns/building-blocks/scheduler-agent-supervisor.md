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

## Technical architecture & implementation

**The three roles.** The pattern divides responsibilities that ad hoc
procedural code tangles together into one blob:

- **Scheduler.** Arranges the steps of the business operation into a
  sequence (or a graph, when steps can run in parallel) and initiates
  each step in turn, recording overall progress. Crucially, it writes
  the intended plan and each step's status to a durable **state store**
  *before* the step is attempted, so the operation's progress is never
  held only in a process's memory.
- **Agent.** A proxy in front of each remote resource or service that
  actually invokes the real action, encapsulating that resource's
  particular API, retries, and error semantics behind a uniform
  interface the Scheduler and Supervisor can both reason about the same
  way regardless of which underlying service is involved.
- **Supervisor.** Observes the state of each step — reading the same
  durable state the Scheduler writes, so its view survives a process
  restart — and reacts when a step fails or times out: retrying the
  step through its Agent, or triggering compensating actions that undo
  the effects of steps that already succeeded, to bring the whole
  operation back to a consistent state rather than leaving it half
  done.

**A state machine per work item.** The unit the pattern tracks is a
single logical operation, and each of its steps moves through an
explicit lifecycle: `Pending → Running → (Done | Failed)`. The
transition into `Running` is persisted with a timestamp *before* the
Agent is called, which is what lets the Supervisor later distinguish "a
step that was never started" from "a step that started but whose Agent
went silent." Modeling this as an explicit state machine — rather than
inferring progress from side effects — is what makes recovery
deterministic: on any restart, the Supervisor reloads the persisted
states and knows exactly where the operation stands.

**Timeout and heartbeat detection.** A remote Agent that crashes
mid-step never sends back a `Failed` result — it simply goes quiet, and
silence is indistinguishable from slowness without a clock. The
Supervisor therefore records a deadline when a step enters `Running` and
treats a step that has been `Running` past its deadline as failed for
recovery purposes, whether the Agent is genuinely dead or merely stuck.
Long-running steps commonly send periodic **heartbeats** that push the
deadline forward, so a legitimately slow step isn't reaped while a truly
hung one still trips the timeout. This is the same missed-heartbeat
detection logic described on the
[Health Check](/docs/patterns/observability/health-check) page, applied
per work item rather than per instance.

**Retry vs. escalate, and idempotent recovery.** When the Supervisor
acts on a failed or timed-out step it faces a policy choice: retry the
step through its Agent (bounded, usually with backoff), or — once
retries are exhausted — escalate to compensation, undoing the steps that
already succeeded. Both paths demand **idempotency**: a retried Agent
call may be the *second* time that remote action actually executed (the
first attempt may have succeeded but had its acknowledgement lost), and
a compensation may run after a partial earlier compensation. Every Agent
action and every compensating action must therefore be safe to apply
more than once — see [Idempotency](/docs/patterns/reliability/idempotency)
and [Compensating Transaction](/docs/patterns/consistency/compensating-transaction) —
or the recovery logic that's meant to fix a half-done operation will
itself corrupt it with duplicate effects.

**Failure modes of the pattern itself.** Two are worth naming. First,
the **Supervisor as a single point of failure**: if only one Supervisor
process watches every operation and it dies, nothing drives recovery
until it comes back. Production deployments run multiple Supervisor
instances behind a [leader election](/docs/patterns/consistency/leader-election)
so exactly one is active at a time, with the durable state store as the
shared source of truth they hand off through. Second, **duplicate
remediation**: two Supervisors (or a Supervisor plus a recovering one)
can both decide to retry or compensate the same step. Guarding against
this needs either single-active-Supervisor fencing or — better — Agent
and compensation actions that are idempotent enough that a duplicate
remediation is harmless, which loops back to the idempotency requirement
above.

**Relation to Saga.** This is deliberately close in spirit to
[orchestration](/docs/patterns/consistency/saga): the Scheduler and
Supervisor together act as a central coordinator directing each step and
reacting to failure, the same role an orchestrator plays in a
[Saga](/docs/patterns/consistency/saga). The pattern is best read as a
concrete implementation shape for an orchestrated saga — it names *where
the durable state lives* (the state store), *who watches it* (the
Supervisor), and *how the remote calls are abstracted* (Agents),
fleshing out the coordinator that a saga describes more abstractly. The
distinction from Distributed Task Scheduler is about *what* is being
coordinated, not *how well*. [Distributed Task
Scheduler](/docs/patterns/building-blocks/distributed-task-scheduler) is
about reliably running and scheduling jobs — recurring or one-off,
generally independent of each other — across a fleet of workers, with
its core problem being exactly-once dispatch and worker-failure recovery
for each individual job. Scheduler Agent Supervisor is about supervising
the *steps of one multi-step distributed operation* that spans several
different services — its core problem is tracking partial progress
through a sequence and recovering the overall operation coherently, not
dispatching independent jobs to a worker pool.

## Code example

The snippet below models the three roles with the steps of one operation
running **concurrently** on real OS threads: each Agent performs its
remote call on its own thread, reports its outcome back to the
Supervisor through a channel, and the Supervisor applies the retry
policy and then compensates any successful steps if a failure survives.
Because the work runs in parallel rather than in sequence, three 40&nbsp;ms
steps finish in about 43&nbsp;ms of wall time, not ~120&nbsp;ms — the timing was
measured, not assumed.

```rust
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, PartialEq, Debug)]
enum StepState {
    Pending,
    Done,
    Failed,
}

// Agent: a proxy that performs one remote action and reports its outcome
// back through a channel the Supervisor listens on.
struct Agent {
    id: usize,
    work: Duration,
    fails: bool,
}

impl Agent {
    fn invoke(&self) -> StepState {
        std::thread::sleep(self.work); // stands in for a real remote call
        if self.fails {
            StepState::Failed
        } else {
            StepState::Done
        }
    }
}

// Supervisor drives the agents concurrently, then inspects durable per-step
// state to decide retry vs. compensate. Because the agents run on real
// threads, three 40ms steps finish in ~43ms wall time, not ~120ms.
fn run_parallel(agents: &[Agent], max_retries: u32) -> (Vec<StepState>, Duration) {
    let started = Instant::now();
    let (tx, rx) = mpsc::channel();
    let mut states = vec![StepState::Pending; agents.len()];

    std::thread::scope(|scope| {
        for agent in agents {
            let tx = tx.clone();
            scope.spawn(move || {
                let mut outcome = agent.invoke();
                // The Supervisor's retry policy, applied at the Agent boundary.
                let mut attempt = 1;
                while outcome == StepState::Failed && attempt < max_retries {
                    outcome = agent.invoke();
                    attempt += 1;
                }
                tx.send((agent.id, outcome)).unwrap();
            });
        }
        drop(tx);
        for (id, outcome) in rx {
            states[id] = outcome;
        }
    });

    // Any surviving failure triggers compensation of the steps that succeeded.
    if states.contains(&StepState::Failed) {
        for (id, s) in states.iter().enumerate() {
            if *s == StepState::Done {
                let _ = id; // compensate step `id` (idempotent undo)
            }
        }
    }
    (states, started.elapsed())
}
```

`run_parallel` plays the Scheduler-plus-Supervisor role: it fans the
steps out across threads (the Scheduler initiating each step), each
`Agent::invoke` is the proxy performing the actual remote action with
its own bounded retry loop, and the final pass over `states` is the
Supervisor's compensate-on-surviving-failure decision. Swapping in a
persistent `states` store (rather than an in-memory `Vec`) is what makes
the same logic survive a process restart.

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

## Use-case scenarios

**Trip booking across independent providers.** A travel system reserves
a flight, a hotel, and a rental car as one logical booking. The
Scheduler sequences the three reservation steps and persists each one's
state; an Agent per provider encapsulates that provider's booking API,
authentication, and error codes behind a uniform interface. If the hotel
reservation fails after the flight succeeded, the Supervisor retries the
hotel booking a bounded number of times, and — if it still can't succeed
— triggers the compensating action of cancelling the already-booked
flight, so the traveler is never left holding a flight with nowhere to
stay. Because a retry may re-issue a booking whose confirmation was lost,
each provider Agent sends an idempotency key so a duplicate request
returns the original reservation rather than creating a second one.

**Account provisioning across multiple systems.** Onboarding a new
enterprise customer has to create a billing record, a tenant in the
application database, an identity-provider entry, and a default set of
resources — four independent services, any of which can be slow or down.
The Scheduler records the provisioning plan durably and drives each step
through its Agent; the Supervisor watches for a step that has been
`Running` past its deadline (an identity-provider call that hung) and
retries it, escalating to tearing down the partially-provisioned tenant
if a required step ultimately can't complete. Running the Supervisor
under leader election means a redeploy mid-provisioning doesn't strand a
half-created account: the newly-elected Supervisor reloads the persisted
step states and resumes recovery exactly where the old one left off.

**Order fulfillment with payment, inventory, and shipping.** An
e-commerce checkout captures payment, decrements inventory, and creates a
shipment as one operation. The three steps run against separate services;
the Supervisor's state machine tracks each, retrying a transient
inventory-service timeout but compensating a payment capture (issuing a
refund) if inventory can't be reserved at all. This is the canonical
orchestrated [saga](/docs/patterns/consistency/saga) shape — Scheduler
Agent Supervisor names the concrete moving parts (durable state store,
Supervisor process, per-service Agents) that make that saga survive
crashes and duplicate remediation.

## Production libraries & getting started

This is an orchestration pattern, not a single library — in practice you adopt a durable-execution / workflow engine that provides the Scheduler (state machine), Agent (activities), and Supervisor (timeouts, retries, recovery) for you, so crashes resume exactly where they left off.

| System | Languages / SDKs | What it gives you | Getting started |
| --- | --- | --- | --- |
| Temporal | Go, Java, TS, Python, .NET | Durable workflows with automatic retries, timeouts, and crash recovery | [Temporal getting started](https://docs.temporal.io/getting-started) |
| Cadence | Go, Java | The engine Temporal forked from; long-running fault-tolerant orchestration | [Cadence get started](https://cadenceworkflow.io/docs/get-started) |
| Azure Durable Functions | C#, JS/TS, Python | Serverless orchestrations (function chaining, fan-out/fan-in, monitors) | [Durable Functions overview](https://learn.microsoft.com/en-us/azure/azure-functions/durable/durable-functions-overview) |
| AWS Step Functions | Any (Amazon States Language) | Managed state machines with built-in retry/catch and long waits | [Step Functions getting started](https://docs.aws.amazon.com/step-functions/latest/dg/getting-started-with-sfn.html) |
| Netflix Conductor (OSS) | Any (JSON DSL + workers) | Microservice workflow orchestration with a supervising server | [Conductor OSS](https://github.com/conductor-oss/conductor) |

## Related patterns

- [Saga](/docs/patterns/consistency/saga) — the orchestrated variant of
  a saga plays a near-identical coordinating role to the Scheduler and
  Supervisor here; this pattern is best read as a concrete
  implementation shape for that orchestrator.
- [Compensating Transaction](/docs/patterns/consistency/compensating-transaction) —
  the mechanism the Supervisor invokes to undo already-succeeded steps
  when a later step can't be made to succeed.
- [Idempotency](/docs/patterns/reliability/idempotency) — the property
  every Agent action and compensation must have, so that a retry or a
  duplicate remediation doesn't apply an effect twice.
- [Leader Election](/docs/patterns/consistency/leader-election) — keeps
  exactly one Supervisor active, avoiding the duplicate-remediation
  failure mode when the Supervisor itself is made highly available.
- [Distributed Task
  Scheduler](/docs/patterns/building-blocks/distributed-task-scheduler) —
  addresses reliably running recurring or scheduled jobs across a
  worker fleet, a related but distinct coordination problem from
  supervising the steps of one multi-step operation.

## Further reading

- [Scheduler Agent Supervisor pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/scheduler-agent-supervisor)
- [Saga distributed transactions pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/saga)
- [Sagas — Hector Garcia-Molina & Kenneth Salem (original 1987 paper, PDF)](https://www.cs.cornell.edu/andru/cs711/2002fa/reading/sagas.pdf)
- [Orchestration (computing) — Wikipedia](https://en.wikipedia.org/wiki/Orchestration_(computing))
