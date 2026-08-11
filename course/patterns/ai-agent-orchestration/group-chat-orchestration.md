---
title: "Group Chat Orchestration"
sidebar_position: 3
supplementary: true
---

Group chat orchestration puts multiple agents — and optionally a human
— into a single shared conversation thread, where every participant can
see every prior message, and a moderator decides, turn by turn, which
participant speaks next. It replaces both sequential's fixed chain and
concurrent's isolated fan-out with one common context that every
participant reads from and writes to.

![Group Chat Orchestration diagram](/img/patterns/group-chat-orchestration.svg)

## Problem it solves

Some tasks aren't cleanly decomposable into a fixed sequence of stages
or a fixed set of independent sub-tasks known in advance — the right
next step only becomes clear once earlier participants have weighed in,
the way a real working group's next useful contribution depends on what
was just said. Forcing such a task into a rigid pipeline means guessing
the right stage order up front and living with it even when it turns
out wrong mid-task; forcing it into independent concurrent runs means
losing the back-and-forth where one agent's partial idea triggers
another agent's refinement of it. Group chat orchestration solves this
by giving every agent the full shared conversation as context and
letting a moderator pick the next speaker dynamically, so the
interaction can follow wherever the discussion actually goes rather
than a path decided before it started.

## Technical architecture & implementation

**Shared context.** Every participant — each agent and, optionally, a
human — reads from and appends to the same message thread. Unlike
sequential orchestration, where each stage sees only its immediate
predecessor's output, or concurrent orchestration, where each agent
sees only the original task, every participant here sees the entire
conversation history: every prior message from every other participant.
This is what makes the pattern's back-and-forth possible — an agent
can refer to, build on, or correct something a different agent said
three turns earlier — but it also means the shared context grows with
every turn, and a long-running group chat can eventually exceed what a
participant's context window can hold, requiring summarization or
truncation strategies the other four patterns in this group don't need
to worry about to the same degree.

**Turn selection.** After each message, a moderator (an LLM-backed
agent or a simpler rule-based component) decides who speaks next.
Strategies range from round-robin (which degrades toward sequential
orchestration's predictability) to a moderator that reads the latest
message and picks whichever participant's expertise seems most
relevant. A bad selection strategy — always picking the same agent, or
matching on surface keywords rather than actual relevance — degrades
the conversation's usefulness without necessarily being visible as an
outright failure.

**What stops an infinite loop.** Because turn selection is dynamic,
group chat orchestration is the one pattern in this group with a real
risk of never terminating on its own — two agents can end up
restating positions without progressing toward a resolution.
Implementations guard against this with an explicit termination
condition independent of the conversation's content: a maximum turn
count, a required "conclusion" signal from a designated participant, or
a convergence check that ends the chat once no new substantive content
has appeared for some number of turns. Without one of these, a group
chat has no natural stopping point the way a sequential pipeline (ends
when the last stage returns) does.

**The maker-checker sub-case.** A specific, named structure within
group chat orchestration constrains the roster to exactly two
functional roles: a **maker** agent proposes an action or artifact, and
a **checker** agent critiques or approves it before it's allowed to
execute or ship. This is a deliberate application of group chat's
shared-context, turn-taking structure to get a built-in
cross-check that sequential orchestration's silent-corruption failure
mode specifically lacks — the checker sees the maker's proposal in full
and is explicitly tasked with finding problems in it rather than
trusting it at face value, and the moderator's turn-taking logic in this
sub-case is simple: alternate maker and checker until the checker
approves or a maximum revision count is hit, at which point the process
either escalates to a human or fails closed rather than shipping an
unapproved action. This is the group chat pattern's answer to a
question none of the other four patterns answer as directly: what
mechanism actually reviews an agent's work before it takes effect.

**Differentiation from the other four patterns.** The defining trait is
the shared, all-visible thread combined with dynamic, non-predetermined
turn order — no other pattern in this group has both. [Sequential Orchestration](/docs/patterns/ai-agent-orchestration/sequential-orchestration)
has a form of turn-taking but it's fixed in advance and each stage sees
only its immediate predecessor, not the full history. [Concurrent Orchestration](/docs/patterns/ai-agent-orchestration/concurrent-orchestration)
has multiple agents but they never share context or take turns at all
— they run in isolation and converge only at the end.
[Handoff Orchestration](/docs/patterns/ai-agent-orchestration/handoff-orchestration)
transfers control between agents the way group chat does, but
permanently and to exactly one agent at a time with the outgoing agent
stepping fully out, rather than group chat's model where every
participant remains present in the thread even while not currently
speaking, and control can return to a prior speaker. [Magentic Orchestration](/docs/patterns/ai-agent-orchestration/magentic-orchestration)
also has a central coordinating role like group chat's moderator, but a
magentic orchestrator is actively building and revising a task plan and
delegating discrete sub-tasks out to specialists, whereas a group chat
moderator's job is narrower — just picking who speaks next in an
ongoing shared conversation, not decomposing or planning the task
itself.

## Code example

```rust
#[derive(Clone)]
struct Message {
    speaker: String,
    content: String,
}

trait Participant {
    fn name(&self) -> &str;
    // Every participant sees the full shared history, not just the
    // last message — this is what distinguishes group chat's context
    // model from sequential's and concurrent's.
    fn respond(&self, history: &[Message]) -> String;
}

struct Maker;
impl Participant for Maker {
    fn name(&self) -> &str {
        "maker"
    }
    fn respond(&self, history: &[Message]) -> String {
        match history.last() {
            Some(last) if last.speaker == "checker" => {
                format!("revised proposal addressing: {}", last.content)
            }
            _ => "initial proposal".to_string(),
        }
    }
}

struct Checker;
impl Participant for Checker {
    fn name(&self) -> &str {
        "checker"
    }
    fn respond(&self, history: &[Message]) -> String {
        match history.last() {
            Some(last) if last.content.contains("revised") => "approved".to_string(),
            _ => "rejected: missing edge-case handling".to_string(),
        }
    }
}

struct GroupChat {
    participants: Vec<Box<dyn Participant>>,
    max_turns: usize,
}

impl GroupChat {
    // Alternates maker and checker (a fixed two-party moderator
    // strategy) until the checker approves or max_turns is exhausted
    // — the explicit termination condition that stops the loop.
    fn run_maker_checker(&self, initial: &str) -> Vec<Message> {
        let mut history = vec![Message {
            speaker: "system".to_string(),
            content: initial.to_string(),
        }];
        for turn in 0..self.max_turns {
            let speaker = &self.participants[turn % self.participants.len()];
            let content = speaker.respond(&history);
            let done = content == "approved";
            history.push(Message {
                speaker: speaker.name().to_string(),
                content,
            });
            if done {
                break;
            }
        }
        history
    }
}
```

`respond` takes the entire `history` slice, not just the previous
message, which is what lets `Checker` react specifically to whether the
`Maker`'s latest proposal was already a revision. `run_maker_checker`'s
`for turn in 0..self.max_turns` loop is the explicit termination bound —
without it, an approval that never arrives would let maker and checker
alternate forever.

## When to use it

- The right next step in the task genuinely depends on what's just been
  said, and can't be decided by a fixed stage order or a fixed
  independent roster known before the interaction starts.
- An action needs to be checked or approved by a distinct reviewing
  agent before it takes effect — the maker-checker sub-case gives that
  cross-check a concrete, structured home.
- A human needs to be able to participate mid-conversation (approve,
  redirect, answer a clarifying question) without the interaction
  having to restart or be re-architected to accommodate them.

## When not to use it

- The task decomposes cleanly into a known, fixed order or a known,
  fixed set of independent sub-tasks — group chat's dynamic turn
  selection and shared-context overhead solve a coordination problem
  that a simpler sequential or concurrent pattern doesn't have.
- A robust termination condition can't be defined for the task — without
  one, this is the pattern in the group most likely to run long,
  circular, or costly conversations with no natural stopping point.
- The conversation would need to run so many turns that the shared
  history exceeds what participants' context windows can hold without
  aggressive summarization, which adds its own complexity and
  information-loss risk.

## Use-case scenarios

**Maker-checker for automated financial transaction approval.** A maker
agent drafts a proposed high-value transaction (amount, recipient,
justification) and a checker agent reviews it against policy rules
and historical patterns before it's allowed to execute; the two
alternate until the checker approves or a fixed revision limit is hit,
at which point an unapproved transaction escalates to a human
approver rather than executing.

**Collaborative incident response.** During a production incident, a
diagnostics agent, a remediation agent, and an on-call human engineer
share one conversation thread; a moderator routes the next turn to
whichever participant's input is most relevant to the latest finding —
the diagnostics agent when new symptoms appear, the remediation agent
once a likely cause is identified, the human when a judgment call about
customer impact is needed — until the incident is marked resolved.

**Multi-perspective design review.** A frontend-focused agent, a
backend-focused agent, and a security-focused agent discuss a proposed
system design in a shared thread, each free to respond to points the
others raise rather than working in isolation; the moderator ends the
session once several consecutive turns pass without any participant
raising a new concern, signaling the discussion has converged.

## Related patterns

- [Sequential Orchestration](/docs/patterns/ai-agent-orchestration/sequential-orchestration) —
  also passes control between agents, but in a fixed order with each
  stage seeing only its predecessor's output, not group chat's full
  shared history and dynamic turn selection.
- [Concurrent Orchestration](/docs/patterns/ai-agent-orchestration/concurrent-orchestration) —
  runs multiple agents on the same task with no shared context or
  turn-taking at all, converging only at a final aggregation step
  rather than through an ongoing conversation.
- [Handoff Orchestration](/docs/patterns/ai-agent-orchestration/handoff-orchestration) —
  transfers control permanently to one specialist at a time, unlike
  group chat's model where every participant stays present and control
  can return to a prior speaker.
- [Magentic Orchestration](/docs/patterns/ai-agent-orchestration/magentic-orchestration) —
  centralizes planning and delegation in an orchestrator role, a
  broader responsibility than group chat's moderator, which only
  selects the next speaker rather than decomposing the task itself.

## Further reading

- [AI agent orchestration patterns — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns)
- [Multi-agent system — Wikipedia](https://en.wikipedia.org/wiki/Multi-agent_system)
- [Four-eyes principle — Wikipedia](https://en.wikipedia.org/wiki/Four-eyes_principle)
