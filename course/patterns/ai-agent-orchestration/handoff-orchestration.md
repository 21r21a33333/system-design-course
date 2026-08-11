---
title: "Handoff Orchestration"
sidebar_position: 4
supplementary: true
---

Handoff orchestration gives one agent ownership of an interaction and
lets that agent explicitly transfer control to a different, more
specialized agent the moment it recognizes the task has moved outside
its own competence — the same shape as a call-center agent transferring
a caller to a specialist department. Exactly one agent is ever in
control at a time, and the identity of the next agent is decided
reactively, not fixed in advance. Microsoft's AutoGen framework
documents this same transfer-of-control structure as its "Handoffs"
design pattern, and Semantic Kernel ships the equivalent structure as
a named "Handoff" orchestration pattern.

![Handoff Orchestration diagram](/img/patterns/handoff-orchestration.svg)

## Problem it solves

A single general-purpose front-line agent handling every possible
request either has to be broad enough to competently handle all of
them — which dilutes how good it can be at any one of them — or it
handles requests outside its depth anyway and produces a worse answer
than a specialist would have. Pre-routing every request to a fixed
specialist based on its initial classification doesn't fully solve
this either, because the initial classification can be wrong, and a
request can reveal, only partway through the interaction, that it
actually belongs to a different specialty than where it started.
Handoff orchestration solves both problems by keeping a generalist (or
whichever specialist currently holds the conversation) responsible for
noticing when a request exceeds its competence, and giving it a
concrete mechanism — an explicit transfer of control — to move the
interaction to a better-suited agent at exactly the point that
recognition happens, rather than at the very start based on a guess.

## Technical architecture & implementation

**The transfer mechanism.** The agent currently holding control
evaluates, as part of its normal turn, whether the request is within
its own competence. If it decides it isn't, rather than attempting an
answer anyway, it invokes a handoff: it selects (or is constrained to
choose from) a target agent, and control — along with some portion of
context — moves to that target agent, which then continues the
interaction as the new owner. Unlike group chat orchestration, where
every participant remains present in a shared thread and a moderator
merely selects who speaks next, a handoff is a genuine transfer: the
outgoing agent stops being involved (unless a further handoff later
returns control to it), and from the caller's perspective the
interaction continues, now driven by a different agent under the hood.

**What's preserved vs. lost at the boundary.** This is the pattern's
central engineering question, and it's where most real handoff
implementations differ from each other. A handoff can carry forward the
full conversation history, a summarized version of it, a structured
subset (specific extracted fields relevant to the target's specialty),
or — in the worst case — effectively nothing beyond the current
request, forcing the receiving agent to re-derive context the outgoing
agent already had. Carrying too little context is the pattern's
dominant failure mode: it reproduces the frustrating real-world
experience of being transferred to a new call-center representative and
having to re-explain the entire problem from scratch, and in an
automated system it can also cause the receiving agent to make decisions
without information the outgoing agent already possessed. Carrying too
much unfiltered context has its own cost — the receiving agent's prompt
grows, potentially including detail irrelevant or actively confusing to
its specialty. Well-designed handoffs typically pass a deliberately
scoped context object: a summary plus whatever structured fields the
target specifically needs, not the raw, unfiltered transcript by
default.

**Who decides the next agent.** In simpler implementations, the outgoing
agent picks the target directly from a known, enumerable set of
specialists (a small, fixed set of "departments" it can transfer to,
much like a call-center system's transfer menu). In more flexible
implementations, the outgoing agent describes what kind of specialist
is needed and a lightweight routing step matches that description to an
available agent. Either way, the decision of *which* specialist gets
control is made at the moment of transfer, reactively, based on what
the current agent has learned about the task so far — this is the
detail that most sharply separates handoff from a fixed pipeline.

**Differentiation from the other four patterns.** Handoff and
[Sequential Orchestration](/docs/patterns/ai-agent-orchestration/sequential-orchestration)
both move control from one agent to another in a single direction at
each step, but sequential's chain order and length are fixed by the
pipeline's designer before any task runs, while handoff's next agent
(and whether there even is a next agent) is decided reactively by
whichever agent currently holds control, based on what it's learned
about this specific request. Handoff differs from
[Group Chat Orchestration](/docs/patterns/ai-agent-orchestration/group-chat-orchestration)
in that only one agent is ever active and present at a time — there's
no shared thread every participant can see, and the outgoing agent
genuinely steps out rather than remaining available for the next turn.
It differs from [Concurrent Orchestration](/docs/patterns/ai-agent-orchestration/concurrent-orchestration)
in that only one agent ever works the task at once — nothing runs in
parallel, and there's no aggregation step reconciling multiple results.
The closest relative is [Magentic Orchestration](/docs/patterns/ai-agent-orchestration/magentic-orchestration):
both adapt which agent handles the task based on what's discovered
along the way, but magentic keeps a central orchestrator that stays in
charge throughout — delegating sub-tasks out and receiving results back
— whereas handoff has no persistent central authority at all; control
itself moves fully to whichever agent is currently handling the
interaction, with no orchestrator retaining oversight above it.

## Code example

```rust
#[derive(Clone)]
struct HandoffContext {
    summary: String,
    // Deliberately scoped fields carried across the boundary, not the
    // full raw transcript — keeps the receiving agent's input focused.
    structured_fields: Vec<(String, String)>,
}

enum Outcome {
    Resolved(String),
    // The agent recognizes the task is outside its competence and
    // names the specialist that should take over next.
    Transfer { target: &'static str, context: HandoffContext },
}

trait Agent {
    fn handle(&self, request: &str, incoming: Option<&HandoffContext>) -> Outcome;
}

struct GeneralistAgent;
impl Agent for GeneralistAgent {
    fn handle(&self, request: &str, _incoming: Option<&HandoffContext>) -> Outcome {
        if request.contains("billing dispute") {
            Outcome::Transfer {
                target: "billing_specialist",
                context: HandoffContext {
                    summary: format!("Customer request: {request}"),
                    structured_fields: vec![("category".into(), "billing".into())],
                },
            }
        } else {
            Outcome::Resolved(format!("handled directly: {request}"))
        }
    }
}

struct BillingSpecialistAgent;
impl Agent for BillingSpecialistAgent {
    fn handle(&self, _request: &str, incoming: Option<&HandoffContext>) -> Outcome {
        match incoming {
            Some(ctx) => Outcome::Resolved(format!("billing resolution using: {}", ctx.summary)),
            None => Outcome::Resolved("billing specialist invoked with no context".to_string()),
        }
    }
}

// Exactly one agent is in control at a time; a Transfer outcome moves
// control (and a deliberately scoped context) to the named target.
struct HandoffOrchestrator {
    generalist: GeneralistAgent,
    billing_specialist: BillingSpecialistAgent,
}

impl HandoffOrchestrator {
    fn run(&self, request: &str) -> String {
        match self.generalist.handle(request, None) {
            Outcome::Resolved(answer) => answer,
            Outcome::Transfer { target: "billing_specialist", context } => {
                match self.billing_specialist.handle(request, Some(&context)) {
                    Outcome::Resolved(answer) => answer,
                    Outcome::Transfer { .. } => "unhandled further transfer".to_string(),
                }
            }
            Outcome::Transfer { .. } => "unknown transfer target".to_string(),
        }
    }
}
```

`Outcome::Transfer` carries a `HandoffContext` with an explicit
`summary` and `structured_fields` rather than the raw `request` string
alone — `BillingSpecialistAgent::handle` only has access to what the
generalist chose to put in that context, which is what makes the
boundary between "preserved" and "lost" context concrete and visible
in the code rather than implicit.

## When to use it

- A front-line agent can reliably recognize when a request is outside
  its competence, even if it can't handle the request itself — the
  recognition step is what makes a clean handoff possible at all.
- Different parts of the interaction genuinely need different
  specialists, and which specialist is needed isn't reliably knowable
  until partway through the interaction.
- The interaction is naturally owned by one agent at a time from the
  caller's perspective — a single continuous conversation, not
  independent parallel work — the way a phone call has one active
  representative even after being transferred.

## When not to use it

- The right specialist for a request is reliably knowable from the
  start — routing the request directly to that specialist up front is
  simpler than routing through a generalist first just to hand off.
- The task benefits from multiple perspectives working simultaneously
  rather than one specialist at a time — concurrent orchestration fits
  a "need several viewpoints" task better than a strictly one-at-a-time
  handoff chain.
- Losing context at a transfer boundary would be unacceptable and can't
  be reliably prevented — a shared-thread pattern like group chat, where
  nothing is ever fully handed away, avoids the boundary-loss risk
  entirely by keeping every participant present throughout.

## Use-case scenarios

**Customer support triage.** A general support agent handles common
questions directly and, on recognizing a billing dispute, a technical
outage report, or a cancellation request, hands off to the
corresponding specialist agent with a summary of the conversation and
the extracted account details — mirroring a call-center transfer,
including a customer who doesn't have to repeat their whole problem
from the beginning.

**IT helpdesk escalation.** A first-line IT agent resolves routine
password resets and access requests directly; when it identifies a
request as a security-relevant incident (a possible compromised
account, unusual access pattern), it hands off to a
security-response agent with a structured incident summary, at which
point the first-line agent is no longer part of the interaction.

**Sales-to-fulfillment handoff.** A sales-qualification agent handles
initial product questions and pricing; once a prospect commits to a
purchase, it hands off to an order-fulfillment agent with the
negotiated terms and account details captured as structured fields —
the fulfillment agent doesn't need or receive the full back-and-forth
of the sales conversation, only the fields it actually needs to act on.

## Production libraries & getting started

These frameworks give agents an explicit mechanism to transfer full control of an interaction to a more specialized agent chosen reactively at run time.

| Framework / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| **OpenAI Agents SDK** | Python, JS/TS | First-class `handoffs`: an agent exposes other agents as handoff targets and can transfer the conversation to whichever fits. | [Handoffs docs](https://openai.github.io/openai-agents-python/handoffs/) |
| **Semantic Kernel** | C#, Python, Java | A built-in `HandoffOrchestration` primitive that routes control to a specialist agent based on rules the current agent evaluates. | [Handoff orchestration docs](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/handoff) |
| **LangGraph** | Python, JS/TS | A `Command` object that both updates state and names the next agent to hand control to, implementing handoffs as graph transitions. | [Command / handoff how-to](https://langchain-ai.github.io/langgraph/how-tos/command/) |
| **CrewAI** | Python | Task delegation where an agent can pass work to a better-suited crew member instead of answering outside its competence. | [Collaboration & delegation docs](https://docs.crewai.com/en/concepts/collaboration) |

**Example / reference:** [OpenAI Agents SDK — multi-agent handoffs](https://openai.github.io/openai-agents-python/multi_agent/)

## Related patterns

- [Sequential Orchestration](/docs/patterns/ai-agent-orchestration/sequential-orchestration) —
  also passes control forward one agent at a time, but along a fixed
  chain decided before the task runs, unlike handoff's reactive,
  in-the-moment choice of the next agent.
- [Group Chat Orchestration](/docs/patterns/ai-agent-orchestration/group-chat-orchestration) —
  keeps every participant present in a shared thread rather than having
  the outgoing agent step fully out, avoiding the context-boundary loss
  that handoff has to manage explicitly.
- [Magentic Orchestration](/docs/patterns/ai-agent-orchestration/magentic-orchestration) —
  the closest relative: also adapts which specialist handles a task
  based on what's discovered, but keeps a persistent central
  orchestrator in charge rather than transferring control itself away
  to whichever agent currently owns the interaction.
- [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) —
  a non-agentic pattern with a structurally similar trigger condition
  (recognizing a call is outside what the current path can safely
  handle) but a very different response — stopping calls rather than
  routing them to a specialist.

## Further reading

- [AI agent orchestration patterns — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns)
- [Handoff agent orchestration — Semantic Kernel docs (Microsoft)](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/handoff)
- [Orchestrating multiple agents (handoffs) — OpenAI Agents SDK docs](https://openai.github.io/openai-agents-python/multi_agent/)
- [Multi-agent system — Wikipedia](https://en.wikipedia.org/wiki/Multi-agent_system)
- [Handoffs design pattern — AutoGen documentation, Microsoft](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/design-patterns/handoffs.html)
- [Handoff agent orchestration — Semantic Kernel documentation, Microsoft Learn](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/handoff)
