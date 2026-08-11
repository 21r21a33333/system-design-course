---
title: "Sequential Orchestration"
sidebar_position: 1
supplementary: true
---

Sequential orchestration runs a fixed set of agents one after another in
a predetermined order, where each agent receives the previous agent's
output as its own input and produces the output the next agent will
consume. It is a pipeline: the same shape as a Unix pipe or an
assembly line, applied to LLM-backed agents instead of shell commands
or physical components. Microsoft's Semantic Kernel framework ships
this exact structure as a named "Sequential" orchestration pattern,
one of several built-in multi-agent orchestration patterns alongside
the concurrent, group chat, handoff, and magentic patterns covered on
the following pages.

![Sequential Orchestration diagram](/img/patterns/sequential-orchestration.svg)

## Problem it solves

A single agent asked to do a complex, multi-stage task in one shot —
research a topic, draft a document, fact-check it, and polish the
prose — tends to blur the stages together: the same prompt and the same
pass of reasoning is doing research, writing, and editing at once, and
quality suffers at each sub-task because none of them gets the model's
full, focused attention. Splitting the work into a chain of
specialized agents, each responsible for exactly one stage and each
given a prompt narrowly scoped to that stage, lets every stage be
tuned independently — a research agent's prompt only has to be good at
research, a fact-checking agent's prompt only has to be good at
fact-checking — and lets the pipeline's overall behavior be understood
and modified one stage at a time rather than as one monolithic
instruction.

## Technical architecture & implementation

**Control and context flow.** The orchestrator invokes agent 1 with the
initial task input, waits for it to complete, then invokes agent 2 with
agent 1's output (and, depending on implementation, some or all of the
original task input alongside it), and so on down the chain. Control is
never held by more than one agent at a time, and it moves in exactly one
direction — there is no agent earlier in the chain regaining control
once a later agent has started. Each agent typically sees only what the
orchestrator explicitly threads through to it: the previous stage's
output, and whatever fixed context (the original request, a system
prompt) the orchestrator was configured to forward. An agent has no
visibility into how an earlier agent reasoned its way to that output,
only the output itself — which is precisely the trait that produces
this pattern's dominant failure mode.

**The silent-corruption failure mode.** Because each agent trusts its
input at face value and has no mechanism to independently verify it,
one stage producing subtly wrong output — a misread number, a
misclassified category, a hallucinated fact — does not cause a visible
failure. It gets passed downstream, consumed by the next agent as
ground truth, transformed further, and passed on again, with the error
compounding or mutating at each stage and no stage positioned to catch
it, since no stage has the original source material or the earlier
agent's reasoning to check against. The final output can look entirely
plausible, confident, and well-formed while being built on a corrupted
premise from stage one. Mitigating this requires either a validation
step between stages (a lightweight check that a stage's output is
well-formed and within expected bounds before forwarding it) or
accepting the risk as a deliberate trade-off for the pattern's
simplicity.

**Differentiation from the other four patterns.** Sequential's defining
trait is a *fixed, linear* handoff order decided in advance by whoever
designed the pipeline — this is what separates it from every other
pattern in this group. [Concurrent Orchestration](/docs/patterns/ai-agent-orchestration/concurrent-orchestration)
also uses a fixed, predetermined roster of agents, but runs them all in
parallel against the same input rather than in a chain, so there's no
stage-to-stage data dependency and no single-point-of-failure ordering
to corrupt. [Handoff Orchestration](/docs/patterns/ai-agent-orchestration/handoff-orchestration)
superficially resembles a chain — control does move from one agent to
another — but the receiving agent in a handoff is chosen reactively, at
the moment of transfer, based on what the current agent judges the task
needs, not fixed in advance the way sequential's stage order is.
[Group Chat Orchestration](/docs/patterns/ai-agent-orchestration/group-chat-orchestration)
and [Magentic Orchestration](/docs/patterns/ai-agent-orchestration/magentic-orchestration)
both allow control to return to an agent (or a central planner) more
than once, which sequential's strictly one-directional chain never
does — once a sequential pipeline moves from stage 2 to stage 3, stage
2 never runs again for that task.

## Orchestration patterns compared

The five patterns in this group differ along two axes that determine
everything else about them: whether the set of agents and their order is
**fixed in advance or decided dynamically**, and **who decides what
happens next**. This table places sequential against its four siblings on
those axes so the rest of the group can be read as variations on a shared
theme rather than five unrelated designs.

| Pattern | Agent set & order | Who decides next | Control shape | Reach for it when |
| --- | --- | --- | --- | --- |
| **Sequential** | Fixed, linear, decided up front | The pipeline's designer (baked in) | One direction, no stage runs twice | The task is a clean, ordered chain of stages, each depending on the last |
| **Concurrent** | Fixed roster, no order (parallel) | Nobody at run time; an aggregator reconciles after | Symmetric fan-out, then fan-in | Redundant independent attempts add confidence, or complementary angles must be merged |
| **Group chat** | Fixed roster, dynamic turn order | A moderator, per turn | Shared thread; control can return to a prior speaker | The next useful step depends on what was just said, or an action needs a maker-checker review |
| **Handoff** | Reactive; next agent chosen at transfer time | The agent currently in control | Control transfers fully; one owner at a time | The right specialist only becomes clear partway through a single-owner interaction |
| **Magentic** | Both roster and order chosen dynamically per task | A persistent central orchestrator | Delegate-out / results-back; orchestrator stays in charge | The task is open-ended and its decomposition can't be known until investigation begins |

Sequential sits at the fully-static end of that spectrum: it commits to
both the agent set and their order before any task runs, which is exactly
what makes it the most predictable and auditable member of the group and
the natural baseline the other four relax one constraint at a time.

## Code example

```rust
// A single stage in the pipeline. Every stage has the same shape:
// consume one typed input, produce one typed output.
trait Agent {
    fn run(&self, input: &str) -> Result<String, String>;
}

struct ResearchAgent;
impl Agent for ResearchAgent {
    fn run(&self, input: &str) -> Result<String, String> {
        Ok(format!("[research notes for: {input}]"))
    }
}

struct DraftAgent;
impl Agent for DraftAgent {
    fn run(&self, input: &str) -> Result<String, String> {
        Ok(format!("[draft built from: {input}]"))
    }
}

struct EditAgent;
impl Agent for EditAgent {
    fn run(&self, input: &str) -> Result<String, String> {
        Ok(format!("[polished: {input}]"))
    }
}

// The orchestrator holds a fixed, ordered chain of agents and threads
// each stage's output into the next stage's input — one direction,
// no stage ever runs twice, no stage sees anything but its immediate
// predecessor's output.
struct SequentialOrchestrator {
    stages: Vec<Box<dyn Agent>>,
}

impl SequentialOrchestrator {
    fn run(&self, initial_input: &str) -> Result<String, String> {
        let mut current = initial_input.to_string();
        for stage in &self.stages {
            current = stage.run(&current)?;
        }
        Ok(current)
    }
}

fn build_pipeline() -> SequentialOrchestrator {
    SequentialOrchestrator {
        stages: vec![
            Box::new(ResearchAgent),
            Box::new(DraftAgent),
            Box::new(EditAgent),
        ],
    }
}
```

`run` folds over `stages` in order, replacing `current` with each
stage's output before the next call — there is no path in this loop for
control to jump backward to an earlier stage or sideways to a stage not
in the vector, which is exactly the fixed, one-directional shape that
defines this pattern.

## When to use it

- The task naturally decomposes into ordered stages, where each stage's
  job genuinely depends on the previous stage's completed output, not
  just on the same source input.
- Each stage benefits from a narrowly scoped prompt and role — a stage
  doing one thing well is easier to build, test, and debug in isolation
  than one agent doing everything.
- The pipeline's behavior needs to be predictable and auditable — a
  fixed order makes it straightforward to log, replay, and reason about
  exactly what ran and in what sequence for any given task.

## When not to use it

- Stages don't actually have a hard ordering dependency — if two stages
  could just as well run against the same input independently, forcing
  them into a chain adds latency (each stage waits on the one before
  it) for no correctness benefit; concurrent orchestration fits better.
- The risk of an early stage's undetected bad output silently
  corrupting every later stage is unacceptable for the task, and no
  validation step between stages is feasible — a pattern with some
  built-in cross-checking, like maker-checker under group chat
  orchestration, is safer.
- The task requires deciding, mid-execution, which specialist should
  handle the next step based on what's been discovered so far — a fixed
  chain designed in advance can't adapt to that; magentic or handoff
  orchestration fit better.

## Use-case scenarios

**Document generation pipeline.** A content system takes a topic and
runs it through a research agent (gathers source material), a drafting
agent (writes a first pass from the research notes), and an editing
agent (tightens prose and checks tone) — three narrowly scoped agents
chained in a fixed order, each unaware of anything except the text
handed to it by the stage before.

**Data-processing ETL with LLM stages.** A pipeline ingests unstructured
customer feedback, runs it through an extraction agent (pulls structured
fields — sentiment, product, issue category — from free text), a
normalization agent (maps extracted values onto a fixed taxonomy), and a
summarization agent (produces a per-category digest) — each stage's
output schema is exactly what the next stage's prompt expects as input.

**Multi-step code-review assistant.** A pull-request bot runs a static
analysis-summarizing agent first (turns linter and type-checker output
into plain language), then a style-review agent (checks the diff against
house conventions using that summary as context), then a
comment-drafting agent (turns the style review into individual, postable
PR comments) — a fixed three-stage chain where each stage's entire job
is transforming the previous stage's output into a more actionable form.

## Production libraries & getting started

These frameworks provide first-class support for chaining agents into a fixed, ordered pipeline where each stage's output becomes the next stage's input.

| Framework / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| **LangGraph** | Python, JS/TS | A graph runtime where a linear edge chain models a sequential pipeline; typed shared state threads output from one node to the next. | [LangGraph docs](https://langchain-ai.github.io/langgraph/) |
| **Semantic Kernel** | C#, Python, Java | A built-in `SequentialOrchestration` primitive that runs agents in a fixed order, each consuming the prior agent's result. | [Sequential orchestration docs](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/sequential) |
| **CrewAI** | Python | A `Process.sequential` mode that executes crew tasks one after another, passing each task's output forward as context. | [Sequential process docs](https://docs.crewai.com/en/learn/sequential-process) |
| **OpenAI Agents SDK** | Python, JS/TS | Lightweight agents composable into a deterministic chain by feeding one agent's final output into the next `Runner.run` call. | [Agents SDK docs](https://openai.github.io/openai-agents-python/) |
| **Haystack** | Python | A pipeline framework whose Agent components slot into a directed pipeline, ideal for research-then-draft-then-refine stages. | [Haystack Agents docs](https://docs.haystack.deepset.ai/docs/agents) |

**Example / reference:** [CrewAI sequential process](https://docs.crewai.com/en/learn/sequential-process)

## Related patterns

- [Concurrent Orchestration](/docs/patterns/ai-agent-orchestration/concurrent-orchestration) —
  also uses a fixed, predetermined roster of agents, but runs them in
  parallel against the same input instead of chaining output to input,
  removing the stage-to-stage corruption risk at the cost of losing any
  stage-to-stage dependency.
- [Handoff Orchestration](/docs/patterns/ai-agent-orchestration/handoff-orchestration) —
  also moves control from one agent to the next, but the next agent is
  chosen reactively at transfer time rather than fixed in advance the
  way a sequential pipeline's stage order is.
- [Magentic Orchestration](/docs/patterns/ai-agent-orchestration/magentic-orchestration) —
  replaces sequential's fixed, designed-in-advance stage order with a
  plan an orchestrator builds and revises dynamically as results come
  in.
- [RAG Pipeline](/docs/patterns/ai-infra/rag-pipeline) — a
  non-agentic pipeline with a similarly fixed stage order (chunk,
  embed, retrieve, re-rank, generate); useful contrast for how a fixed
  linear pipeline looks without independently reasoning agents at each
  stage.

## Further reading

- [AI agent orchestration patterns — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns)
- [Sequential agent orchestration — Semantic Kernel docs (Microsoft)](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/sequential)
- [Building effective agents — Anthropic (prompt chaining / workflows)](https://www.anthropic.com/engineering/building-effective-agents)
- [Pipeline (software) — Wikipedia](https://en.wikipedia.org/wiki/Pipeline_(software))
- [Multi-agent system — Wikipedia](https://en.wikipedia.org/wiki/Multi-agent_system)
- [Sequential agent orchestration — Semantic Kernel documentation, Microsoft Learn](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/sequential)
