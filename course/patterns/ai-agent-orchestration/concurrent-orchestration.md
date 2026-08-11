---
title: "Concurrent Orchestration"
sidebar_position: 2
supplementary: true
---

Concurrent orchestration dispatches the same task to a fixed set of
agents that run independently and in parallel, then combines their
individual results into a single output through an aggregation step —
a vote, a merge, or a selection. Where sequential orchestration is a
pipeline, concurrent orchestration is a fan-out to several independent
attempts followed by a fan-in that reconciles them.

![Concurrent Orchestration diagram](/img/patterns/concurrent-orchestration.svg)

## Problem it solves

A single agent's answer to an ambiguous, open-ended, or high-stakes
question is one sample from a distribution of plausible answers, and
that one sample can be wrong or narrow in ways that are hard to detect
from the answer alone — there's nothing to compare it against. Running
several agents against the identical task independently, especially
agents with different prompts, different tool access, or different
underlying models, produces multiple independent samples from that
distribution: where they agree is a much stronger signal of a correct
or well-supported answer than any single agent's output on its own, and
where they disagree is itself useful information, surfacing exactly
the ambiguity or difficulty a single agent's confident-sounding answer
would have hidden. Concurrent orchestration trades the cost of running
several agents for that redundancy-driven confidence signal.

## Technical architecture & implementation

**Fan-out and fan-in.** The orchestrator dispatches the same input (or
close variants of it — different framings, different tool subsets) to
every agent in a fixed roster at the same time, with no communication
between the agents while they're running — each agent reasons entirely
within its own isolated context, seeing none of the others' intermediate
work. The orchestrator waits for all (or, in a timeout-bounded variant,
enough) of them to finish, then runs an aggregation step over the
completed set of results. Because the agents never talk to each other
during execution, there is no possibility of one agent's reasoning
contaminating another's the way sequential's output-into-input chaining
allows — each result is a genuinely independent sample.

**Aggregation strategies.** How results get combined is the core design
decision, and different strategies suit different tasks. A **voting**
aggregator picks the majority answer among agents that converged on the
same discrete result (useful for classification-shaped tasks with a
finite answer space). A **merge** aggregator combines complementary
partial results into one output (useful when agents were given
different angles on the same task — one researching cost, one
researching risk, one researching timeline — and none of them alone has
the complete picture). A **judge** or **selection** aggregator uses a
separate agent (or the orchestrator itself, via a scoring rubric) to
review all candidate outputs and pick or synthesize the best one, which
generalizes to open-ended, free-text outputs that voting can't handle
since there may be no two outputs that are exactly identical to vote on.

**The disagreement failure mode.** The central design question this
pattern has to answer is what happens when the agents don't converge —
a 2-2 vote split with no majority, or a judge unable to confidently
prefer one candidate over another. A naive implementation that always
mechanically picks *something* (an arbitrary tie-break, the
first-returned result) silently discards the very disagreement signal
that concurrent orchestration was set up to surface, papering over
exactly the ambiguity the pattern exists to detect. A more robust
implementation treats a failure to converge as a distinct outcome in its
own right — escalate to a human, ask a follow-up question, or return the
disagreement itself as part of the output — rather than forcing a
false consensus.

**Differentiation from the other four patterns.** Concurrent's roster is
fixed in advance and every agent runs against the same task
simultaneously — no agent's execution depends on another's output, which
is the opposite of [Sequential Orchestration](/docs/patterns/ai-agent-orchestration/sequential-orchestration)'s
strict output-to-input chaining. It also differs from
[Group Chat Orchestration](/docs/patterns/ai-agent-orchestration/group-chat-orchestration)
in a way that's easy to blur: group chat agents share one thread and see
each other's messages turn by turn as the conversation unfolds, actively
reacting to and building on each other's contributions, whereas
concurrent agents run in isolated contexts and never see each other's
work until the separate aggregation step after everyone is done — the
independence of the samples is the entire point, and letting agents see
each other mid-run would undermine it by letting one agent anchor on
another's answer instead of reasoning independently. Unlike
[Handoff Orchestration](/docs/patterns/ai-agent-orchestration/handoff-orchestration)
and [Magentic Orchestration](/docs/patterns/ai-agent-orchestration/magentic-orchestration),
no single agent or orchestrator is ever "in control" of the others
during execution — control is symmetric and parallel, only converging
at the aggregation step.

## Code example

```rust
// Every agent in the roster runs against the same input independently.
trait Agent {
    fn run(&self, task: &str) -> String;
}

struct AgentA;
impl Agent for AgentA {
    fn run(&self, task: &str) -> String {
        format!("answer-X for {task}")
    }
}

struct AgentB;
impl Agent for AgentB {
    fn run(&self, task: &str) -> String {
        format!("answer-X for {task}")
    }
}

struct AgentC;
impl Agent for AgentC {
    fn run(&self, task: &str) -> String {
        format!("answer-Y for {task}")
    }
}

#[derive(Debug, PartialEq)]
enum Verdict {
    Consensus(String),
    // No result crossed the agreement threshold — the disagreement
    // itself is surfaced rather than an arbitrary tie-break being made.
    NoConsensus(Vec<String>),
}

struct ConcurrentOrchestrator {
    agents: Vec<Box<dyn Agent>>,
}

impl ConcurrentOrchestrator {
    // Fan-out: every agent runs against the identical task, with no
    // visibility into each other's results.
    fn dispatch(&self, task: &str) -> Vec<String> {
        self.agents.iter().map(|agent| agent.run(task)).collect()
    }

    // Fan-in: a simple majority-vote aggregator. A tie or an even
    // split is reported as NoConsensus rather than resolved silently.
    fn vote(&self, task: &str) -> Verdict {
        let results = self.dispatch(task);
        let mut counts: Vec<(String, usize)> = Vec::new();
        for result in &results {
            match counts.iter_mut().find(|(value, _)| value == result) {
                Some((_, count)) => *count += 1,
                None => counts.push((result.clone(), 1)),
            }
        }
        let majority = results.len() / 2 + 1;
        match counts.into_iter().find(|(_, count)| *count >= majority) {
            Some((value, _)) => Verdict::Consensus(value),
            None => Verdict::NoConsensus(results),
        }
    }
}
```

`dispatch` runs every agent against the same `task` with no cross-agent
visibility, and `vote` only returns `Verdict::Consensus` once one answer
crosses a strict majority of `results.len()` — anything short of that,
including an even split, falls through to `Verdict::NoConsensus`
carrying every distinct answer rather than picking one arbitrarily.

## When to use it

- The task benefits from redundancy — a wrong or narrow single-agent
  answer is costly enough that paying for multiple independent
  attempts and comparing them is worth the extra cost and latency.
- Sub-tasks are genuinely independent of each other and don't require
  one agent's output as another's input — if they did, the parallelism
  concurrent orchestration offers wouldn't actually be available.
- Disagreement between agents is itself a useful signal (ambiguity
  worth surfacing to a human, or a sign a task needs escalation) rather
  than pure noise to be discarded.

## When not to use it

- The task has a single well-defined correct procedure, and multiple
  agents would just reproduce the same reasoning redundantly — paying
  for parallel runs adds cost with no diversity-of-perspective benefit.
- Latency or cost is tightly constrained, and the workload can't absorb
  running several agents (and, often, an additional judge or voting
  step) for every task instance.
- The task is inherently sequential — later work genuinely depends on
  earlier work's output — in which case there's nothing meaningful for
  agents to do "concurrently" against the same starting input.

## Use-case scenarios

**Code-review triage from multiple angles.** A pull request is reviewed
concurrently by a security-focused agent, a performance-focused agent,
and a style-focused agent, each examining the same diff independently
through its own lens; a merge aggregator combines all three sets of
comments into one review rather than forcing them to agree on a single
verdict, since their findings are complementary rather than competing.

**High-stakes classification with a voting aggregator.** A content
moderation system runs three independently prompted agents against the
same flagged post and takes the majority label (allow, remove, escalate
to human); a 2-1 split still resolves to a decision, but a case where
all three genuinely disagree is routed to a human reviewer instead of
being resolved by an arbitrary tie-break.

**Investment research memo synthesis.** An analysis system dispatches
the same company to a fundamentals-focused agent, a market-sentiment
agent, and a competitive-landscape agent, all working from the same
input filings simultaneously; a synthesis agent then merges the three
independent analyses into a single memo, explicitly flagging any point
where the three agents reached conflicting conclusions about the
company's outlook rather than smoothing the disagreement away.

## Production libraries & getting started

These frameworks let a fixed roster of agents run in parallel against the same input, then reconcile their results at a fan-in step.

| Framework / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| **LangGraph** | Python, JS/TS | Parallel branches (fan-out edges) whose results merge back into shared state, with reducers acting as the aggregation step. | [Graph API — parallel execution](https://langchain-ai.github.io/langgraph/how-tos/graph-api/) |
| **Microsoft AutoGen** | Python, .NET | An async, event-driven runtime where multiple agents run concurrently and results are collected for downstream aggregation. | [AutoGen docs](https://microsoft.github.io/autogen/stable/) |
| **Semantic Kernel** | C#, Python, Java | A built-in `ConcurrentOrchestration` primitive that dispatches one task to many agents in parallel and gathers their outputs. | [Concurrent orchestration docs](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/concurrent) |
| **OpenAI Agents SDK** | Python, JS/TS | `asyncio`-based parallel agent runs whose independent outputs a final judge or merge agent reconciles into one answer. | [Agents SDK docs](https://openai.github.io/openai-agents-python/) |

**Example / reference:** [Semantic Kernel concurrent orchestration](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/concurrent)

## Related patterns

- [Sequential Orchestration](/docs/patterns/ai-agent-orchestration/sequential-orchestration) —
  also uses a fixed, predetermined roster, but chains agents so each
  one's output feeds the next, the opposite of concurrent's
  simultaneous, independent execution against the same input.
- [Group Chat Orchestration](/docs/patterns/ai-agent-orchestration/group-chat-orchestration) —
  agents share one visible thread and react to each other turn by turn,
  unlike concurrent orchestration's isolated, non-communicating runs
  that only converge at a separate aggregation step.
- [Magentic Orchestration](/docs/patterns/ai-agent-orchestration/magentic-orchestration) —
  uses a central orchestrator to dynamically choose which specialists
  to involve, rather than concurrent's fixed roster dispatched
  identically every time.
- [Cache Stampede Prevention](/docs/patterns/caching/cache-stampede-prevention) —
  a non-agentic pattern that deals with a related but inverted problem:
  many identical concurrent requests converging on one resource, versus
  concurrent orchestration's one task deliberately fanned out to many
  independent workers.

## Further reading

- [AI agent orchestration patterns — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns)
- [Concurrent agent orchestration — Semantic Kernel docs (Microsoft)](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/concurrent)
- [Building effective agents — Anthropic (parallelization workflow)](https://www.anthropic.com/engineering/building-effective-agents)
- [Multi-agent system — Wikipedia](https://en.wikipedia.org/wiki/Multi-agent_system)
- [Ensemble learning — Wikipedia](https://en.wikipedia.org/wiki/Ensemble_learning)
