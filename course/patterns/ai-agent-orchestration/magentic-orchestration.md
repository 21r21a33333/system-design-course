---
title: "Magentic Orchestration"
sidebar_position: 5
supplementary: true
---

Magentic orchestration puts a lead orchestrator agent in charge of an
open-ended task without a predetermined plan: the orchestrator builds a
task plan, delegates individual steps out to specialist agents, and
revises the plan as results come back — rather than following a fixed
pipeline, a fixed roster, or handing control fully away. It is the most
adaptive of the five patterns in this group, trading predictability for
the ability to handle tasks whose right shape can't be known in advance.

![Magentic Orchestration diagram](/img/patterns/magentic-orchestration.svg)

## Problem it solves

Sequential and concurrent orchestration both require someone to decide,
before the task runs, exactly which stages or which agents are involved
and in what arrangement — which works well when the task's shape is
known ahead of time, but fails for genuinely open-ended tasks where the
right decomposition only becomes clear once some investigation has
already happened. A task like "figure out why this metric regressed
last week" can't be pre-planned into a fixed chain, because what to
investigate next depends entirely on what the previous investigation
step found. Magentic orchestration solves this by not committing to a
full plan up front at all: an orchestrator forms an initial plan,
delegates the first step, looks at what comes back, and only then
decides the next step — potentially revising its understanding of the
whole task based on what it's learned, the way a human project lead
adjusts a plan as new information arrives rather than executing a
static checklist regardless of what happens along the way.

## Technical architecture & implementation

**The plan-delegate-observe-replan loop.** The orchestrator maintains an
explicit, inspectable task plan — typically a set of outstanding
sub-tasks and what's been learned so far — rather than a fixed sequence
baked into code. On each iteration, it selects the next sub-task from
the plan, delegates it to whichever specialist agent is suited to that
sub-task (chosen dynamically, from a roster of available specialists,
based on the sub-task's nature rather than a hardcoded assignment), and
receives that specialist's result. The orchestrator then updates its
plan in light of that result: sometimes marking a sub-task complete and
moving to the next one unchanged, sometimes adding new sub-tasks the
result revealed were necessary, sometimes discarding sub-tasks that the
result made irrelevant. This loop continues until the orchestrator
judges the overall task complete or a stopping condition is reached.
Unlike every other pattern in this group, the set of specialists
actually invoked, the order they're invoked in, and even how many steps
the task takes are not knowable in advance — they're a function of what
the intermediate results turn out to be.

**What triggers re-planning.** Re-planning is triggered by the
orchestrator's evaluation of a specialist's result against the current
plan: a result that's unexpected (contradicts an assumption the plan
was built on), incomplete (the specialist couldn't fully complete its
sub-task and reports why), or that surfaces new information the
original plan didn't account for, all can prompt the orchestrator to
revise the plan rather than blindly continuing to the next
pre-identified step. This is the mechanical opposite of sequential
orchestration's fixed chain, where a stage's output is consumed by the
next stage regardless of whether it was actually a good result — a
magentic orchestrator is specifically watching for that case and
adjusting course when it happens, rather than passing a bad result
downstream uninspected.

**What stops runaway re-planning.** Because the loop's length isn't
fixed, an orchestrator that keeps discovering new sub-tasks (or keeps
re-litigating the same uncertainty without resolving it) could in
principle run indefinitely, burning cost and time without converging.
Robust implementations bound this explicitly: a maximum number of
plan revisions or delegation rounds, a budget (time or token cost) the
orchestrator tracks against and must stay within, or a requirement that
each re-plan demonstrably narrows what remains uncertain rather than
just restating it — if a re-plan doesn't reduce the size or ambiguity
of the remaining plan, the orchestrator treats that as a signal to stop
and either return its best-effort result or escalate rather than
looping further.

**Differentiation from the other four patterns.** Magentic is the only
pattern in this group where neither the roster of specialists nor the
sequence of steps is fixed before the task starts — that's the trait
that separates it from all four of the others.
[Sequential Orchestration](/docs/patterns/ai-agent-orchestration/sequential-orchestration)
and [Concurrent Orchestration](/docs/patterns/ai-agent-orchestration/concurrent-orchestration)
both commit to a fixed set of agents and a fixed arrangement (a chain, a
parallel fan-out) decided by whoever designs the pipeline; magentic
decides both dynamically, per task, based on intermediate results.
[Group Chat Orchestration](/docs/patterns/ai-agent-orchestration/group-chat-orchestration)'s
moderator is also making a dynamic per-turn decision, but only about
who speaks next in a shared conversation — it isn't maintaining an
explicit task plan or decomposing the task into sub-tasks the way a
magentic orchestrator is. The closest relative is
[Handoff Orchestration](/docs/patterns/ai-agent-orchestration/handoff-orchestration):
both adapt to what's discovered mid-task, but handoff transfers control
itself away — the outgoing agent stops being involved — while magentic's
orchestrator never relinquishes control; it delegates a sub-task out,
gets a result back, and remains the one deciding what happens next for
the entire duration of the task. That retained, persistent central
authority — plan owner throughout, not just at the start — is magentic
orchestration's defining structural difference from every other pattern
in this group.

## Code example

```rust
#[derive(Debug, Clone)]
struct SubTask {
    description: String,
    specialist: &'static str,
}

#[derive(Debug)]
enum StepResult {
    Complete(String),
    // A result that reveals more work is needed — this is what
    // triggers a re-plan rather than a mechanical advance to a
    // pre-identified next step.
    NeedsFollowUp(String, SubTask),
}

trait Specialist {
    fn handle(&self, task: &SubTask) -> StepResult;
}

struct DiagnosticsSpecialist;
impl Specialist for DiagnosticsSpecialist {
    fn handle(&self, task: &SubTask) -> StepResult {
        if task.description.contains("regression") {
            StepResult::NeedsFollowUp(
                "found a correlated deploy".to_string(),
                SubTask {
                    description: "check deploy diff for regression cause".to_string(),
                    specialist: "code_review",
                },
            )
        } else {
            StepResult::Complete("no further leads".to_string())
        }
    }
}

struct CodeReviewSpecialist;
impl Specialist for CodeReviewSpecialist {
    fn handle(&self, _task: &SubTask) -> StepResult {
        StepResult::Complete("identified offending commit".to_string())
    }
}

// The orchestrator owns the plan for the entire run and never hands
// control away — it delegates one sub-task at a time and decides what
// happens next based on the result, bounded by max_rounds.
struct MagenticOrchestrator {
    max_rounds: usize,
}

impl MagenticOrchestrator {
    fn dispatch(&self, specialist_name: &str, task: &SubTask) -> StepResult {
        match specialist_name {
            "diagnostics" => DiagnosticsSpecialist.handle(task),
            "code_review" => CodeReviewSpecialist.handle(task),
            _ => StepResult::Complete("unknown specialist".to_string()),
        }
    }

    fn run(&self, initial_task: SubTask) -> Vec<String> {
        let mut plan = vec![initial_task];
        let mut findings = Vec::new();
        let mut rounds = 0;

        while let Some(task) = plan.pop() {
            if rounds >= self.max_rounds {
                findings.push("stopped: max_rounds reached".to_string());
                break;
            }
            rounds += 1;
            match self.dispatch(task.specialist, &task) {
                StepResult::Complete(result) => findings.push(result),
                StepResult::NeedsFollowUp(result, next_task) => {
                    findings.push(result);
                    // Re-planning: a new sub-task is added because this
                    // result revealed it was necessary, not because a
                    // fixed pipeline said so.
                    plan.push(next_task);
                }
            }
        }
        findings
    }
}
```

`run`'s `while let Some(task) = plan.pop()` loop is the plan-
delegate-observe-replan cycle: `plan` isn't a fixed sequence decided
before the call, it's mutated in place — `StepResult::NeedsFollowUp`
pushes a brand-new `SubTask` onto it that didn't exist when `run` was
called — and `rounds >= self.max_rounds` is the explicit bound that
stops the loop from growing the plan indefinitely.

## When to use it

- The task is genuinely open-ended, and the right decomposition into
  steps or the right specialists to involve can't be known until
  investigation is already underway.
- Intermediate results routinely change what should happen next, so a
  fixed pipeline or fixed roster would either fail outright or require
  constant manual re-design for each new task instance.
- The cost and latency of a potentially multi-round, dynamically
  lengthening process is acceptable for the value of handling
  genuinely novel task shapes without a human pre-designing a workflow
  for each one.

## When not to use it

- The task's shape is well understood and stable across instances — a
  fixed sequential or concurrent pattern gives the same outcome with
  far more predictable cost, latency, and behavior to test against.
- Runaway cost or unbounded latency is unacceptable and can't be
  tightly bounded — an orchestrator that's allowed to keep re-planning
  is harder to put a hard ceiling on than a pattern whose step count is
  fixed by design.
- Auditability of exactly what will run, in what order, matters more
  than adaptability — a magentic orchestrator's execution path is only
  knowable after the fact, which is a harder property to review or
  certify in advance than a fixed pipeline's.

## Use-case scenarios

**Production incident root-cause investigation.** An orchestrator is
given only "checkout latency spiked at 14:02 UTC" and no fixed
investigation plan; it delegates an initial metrics-correlation
sub-task to a diagnostics specialist, and based on what that turns up —
a correlated deploy, a correlated traffic spike, a correlated dependency
outage — dynamically delegates a follow-up sub-task to whichever
specialist (code-review, capacity-analysis, dependency-health) fits
what was actually found, continuing until it can state a root cause or
exhausts its round budget.

**Open-ended competitive research.** An orchestrator given "assess
whether we should enter the mid-market segment" starts by delegating a
market-sizing sub-task; depending on that result, it may delegate a
follow-up to a competitor-analysis specialist, a follow-up to a
pricing specialist, or both — the specific set of specialists engaged
and the order they're engaged in isn't fixed, because it depends on
what the market-sizing step reveals is actually relevant.

**Automated infrastructure remediation with escalating scope.** An
orchestrator handling a failing health check starts with a narrow
sub-task (restart the affected service) delegated to an operations
specialist; if the result shows the restart didn't resolve the
underlying issue, it re-plans to a broader sub-task (roll back the
last deployment) delegated to a different specialist, and continues
widening scope only as far as each result actually justifies, bounded
by a maximum remediation-round count before it escalates to a human.

## Related patterns

- [Handoff Orchestration](/docs/patterns/ai-agent-orchestration/handoff-orchestration) —
  the closest relative: both adapt to intermediate results rather than
  following a fixed plan, but handoff transfers control itself away to
  the next agent, while magentic's orchestrator retains control and
  authority over the plan for the entire task.
- [Sequential Orchestration](/docs/patterns/ai-agent-orchestration/sequential-orchestration) —
  the fixed, predetermined-order counterpart to magentic's dynamically
  built and revised plan; useful as the baseline case for when a task's
  shape is actually known in advance.
- [Group Chat Orchestration](/docs/patterns/ai-agent-orchestration/group-chat-orchestration) —
  also has a coordinating role making dynamic per-step decisions, but a
  group chat moderator only selects the next speaker in a shared
  conversation rather than maintaining and revising an explicit task
  plan.
- [Concurrent Orchestration](/docs/patterns/ai-agent-orchestration/concurrent-orchestration) —
  uses a fixed roster dispatched identically every time, the opposite
  of magentic's dynamically chosen, per-task specialist selection.

## Further reading

- [AI agent orchestration patterns — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns)
- [Multi-agent system — Wikipedia](https://en.wikipedia.org/wiki/Multi-agent_system)
- [Automated planning and scheduling — Wikipedia](https://en.wikipedia.org/wiki/Automated_planning_and_scheduling)
