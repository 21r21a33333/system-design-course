---
title: "Design an AI Code Assistant"
sidebar_position: 24
---

An AI code assistant looks like the same shape as any other LLM-backed product — send a prompt, get a response — but its actual hard problem is different from a conversational or support system's: the "document" it has to understand is a large, structured, interdependent codebase, not prose, and its output has to be syntactically and semantically valid in a specific programming language, often requiring the assistant to take real actions (run a command, read a file, execute a test) rather than just generate text. This is fundamentally a structured-context-plus-tool-use problem, not a retrieval-over-documents problem or an inference-scaling problem.

*Educative's Grokking Modern System Design Interview course covers this same system in its "AI-Powered Code Assistant System Design" module.*

## Step 1: Outline use cases and constraints

### Use cases

#### We'll scope the problem to handle the following use cases

* **Developer** receives an inline code completion suggestion as they type, based on the surrounding code in the current file (the category of product this design targets — GitHub Copilot and Cursor are two well-known real examples)
* **Developer** asks a natural-language question about their codebase ("where is the rate limiter configured") and receives an answer grounded in the actual code, not a generic guess
* **Developer** asks the assistant to make a multi-step change (add a parameter to a function and update every call site) and the assistant identifies the relevant files and proposes concrete edits across them
* **Assistant** uses tools — reading a file, searching the codebase, running a test — as part of answering a request, rather than answering from text alone
* **Developer** reviews and explicitly approves any proposed edit before it's applied to their actual files — the assistant never silently modifies code without a human confirming the change
* **Service** keeps its understanding of a codebase reasonably current as the developer (or their teammates) continue committing changes to it

#### Out of scope

* The code-editor UI itself (syntax highlighting, the text-editing surface) — this design covers the assistant backend an editor integrates with, not the editor
* Fully autonomous, unsupervised multi-file refactoring applied without any human review step (a natural extension, but this design's core use cases all keep a human in the loop before a change lands)
* Training or fine-tuning a code-specialized model — treated as a given input, the same scoping this course's other two LLM-backed case studies use
* Team-wide, multi-repository organizational code search beyond a brief mention (this design is scoped to one developer working within one codebase at a time)

### Constraints and assumptions

#### State assumptions

* 2,000,000 daily active developers across the platform's customer base, working across a large number of independent codebases, not one shared one
* Inline completions are requested far more frequently than anything else the assistant does, and have the tightest latency budget by a wide margin — a completion suggestion needs to start appearing within roughly 200ms of the developer pausing, or it interrupts typing flow rather than assisting it
* A codebase's context can't be treated as unstructured prose the way a documentation article can — code has an explicit dependency structure (a function calls another function, a type is defined once and used in many places), and understanding "what's relevant to this request" often means following those structural relationships, not just finding textually similar snippets
* Any response involving a proposed code edit must be syntactically valid and consistent with the target file's existing language, imports, and style — a proposed edit that doesn't compile or doesn't match the surrounding code's conventions is a materially worse outcome than a slower response
* A codebase changes continuously as its developers commit — the assistant's understanding of a given repository needs to reflect recent commits within a short window, not be built once and left stale indefinitely
* Multi-step requests (find every call site of a function and update each one) require the assistant to take real actions — searching the codebase, reading specific files, sometimes running a build or test — not just generate a single block of text in one pass
* No code from one customer's private repository is ever used as context for, or leaked into, a response generated for a different customer — this isolation boundary is as strict as the tenant isolation this course's LLM Support Bot case study requires for account data

#### Calculate usage

* Inline completion volume: 2,000,000 developers × an average of 400 completion requests/day (completions fire frequently and are cheap to request, unlike a full chat query) = **800,000,000 completions/day** → 800,000,000 / 86,400 ≈ **~9,300 completions/sec average**, with usage concentrated in working hours across time zones — design for **~3x average at peak**, so **~28,000 completions/sec at peak** — a very high request rate, but each individual completion is a small, narrowly-scoped generation (a few lines, tightly bounded by Step 1's 200ms budget), structurally different from a full conversational turn
* Chat/agentic query volume: 2,000,000 developers × an average of 15 codebase questions or multi-step requests/day = **30,000,000 queries/day** → ~347 queries/sec average — two orders of magnitude lower than completion volume, and each one is far more expensive per request (larger assembled context, possible tool calls, longer generation), which is why this design treats completions and chat/agentic queries as two structurally different workloads rather than one undifferentiated request type
* Codebase index size: assuming an average indexed repository has 5,000 files at ~3,000 bytes/file (~15 MB of raw source per repository) and is chunked at roughly 4 chunks/file (structurally, closer to one chunk per function or class than an arbitrary text split) → 5,000 × 4 = 20,000 chunks/repository; at a 768-dimension embedding (3,072 bytes/vector) → 20,000 × 3,072 bytes ≈ **~61 MB of vector index per repository**
* Total index footprint: across an estimated 3,000,000 actively indexed repositories (a mix of many developers sharing some repositories and many working in distinct ones) → 3,000,000 × 61 MB ≈ **~184 TB** of total vector index storage — this confirms indexing is fundamentally a per-repository, sharded problem rather than one global index, since no single query is ever meant to search across unrelated repositories in the first place
* Re-indexing load: assuming an actively-developed repository sees roughly 20 commits/day touching an average of 8 files each, that's 160 file changes/day/repository needing re-chunking and re-embedding — small enough per repository to keep incremental and comfortably real-time, but multiplied across 3,000,000 repositories, aggregate re-indexing load (up to ~480,000,000 file changes/day system-wide) is a meaningfully large background workload in its own right, sized closer to this course's Data Infrastructure Platform case study's ingestion volume than to a single-tenant system's

## Step 2: Create a high-level design

![AI Code Assistant high-level architecture](/img/case-studies/code-assistant-overview.svg)

An editor integration sends requests to a **request router** that first splits traffic by shape: **inline completion requests**, which are latency-critical and handled by a lightweight path that assembles just the immediately surrounding code (the current file, recently edited files) and calls a fast, tightly-bounded generation step; and **chat/agentic requests**, which are handled by a heavier path capable of multi-step reasoning. The chat/agentic path is backed by a **codebase index** — a per-repository structural and semantic index built by a **codebase indexing pipeline** that parses source files (a real, widely-used parsing library like tree-sitter is a common concrete choice for this step, since it builds a syntax tree across many languages with a single consistent interface), extracts their dependency structure (which functions call which, which files import which), and embeds chunks for similarity search — and by a **tool-execution layer** that can search the index, read specific files, and run sandboxed commands like a test suite. An orchestration step decides, per request, whether the request can be answered from retrieved context alone or requires one or more tool calls before a final response is generated; either way, any response that proposes an actual code edit is returned as a **proposed diff**, never applied directly — the developer explicitly reviews and accepts it in their editor before anything touches their real files.

The structural bet this design makes, differently from both this course's Conversational AI System and LLM Support Bot case studies, is that **understanding structured code and safely taking actions against a live environment matter more than either raw serving scale or prose-document grounding**. The codebase index isn't a bag of similarly-chunked text the way a documentation knowledge base is — it explicitly models code's dependency graph, because "what's relevant to this change" in code is frequently determined by call and import relationships a pure text-similarity search would miss entirely, and the tool-execution layer (running a search, reading a file, executing a test) is a first-class part of the architecture, not an optional add-on, because many real developer requests genuinely can't be answered from static retrieved context alone.

## Step 3: Design core components

### Use case: Developer receives an inline code completion as they type

Step 1's ~200ms latency budget is far tighter than this design's other use cases, and it shapes this path end to end: rather than running the full codebase-retrieval and tool-orchestration flow described below, an inline completion request assembles a narrow, cheap context — the current file's content around the cursor, plus a small number of recently touched files — and calls a generation step tuned for short, fast completions rather than long, reasoned responses.

**Data structures:** `completion_request` — `file_path`, `cursor_position`, `surrounding_lines` (a small fixed window, not the whole file), `recent_files` (bounded list).

**Trade-offs:**
* This is deliberately a different, lighter-weight request path from the chat/agentic one, not the same pipeline running with a shorter timeout — Step 1's volume math shows completions arrive roughly 27x more often than chat/agentic queries, so routing every keystroke through the heavier retrieval-and-tool pipeline would both blow the latency budget and waste enormous capacity on a workload that structurally doesn't need it.
* [Model Serving](/docs/patterns/ai-infra/model-serving)'s micro-batching still applies here, but tuned toward a much shorter batching window than a chat workload would tolerate, since Step 1's 200ms budget leaves far less room to trade queuing delay for throughput than a multi-second chat response does.

### Use case: Developer asks a natural-language question about their codebase

Answering "where is the rate limiter configured" needs the same retrieval shape [RAG Pipeline](/docs/patterns/ai-infra/rag-pipeline) describes — embed the query, search for relevant chunks, re-rank, inject into the model's prompt — but code's explicit dependency structure (a function calls another function, a type is defined once and used in many places) means "what's relevant" is frequently determined by graph structure a pure text-similarity search would miss.

**Core spec: three competing retrieval architectures**

Real systems in this space converge on three genuinely different architectures for solving this, worth comparing explicitly rather than silently picking one:

| Architecture | How it works | Strength | Weakness |
|---|---|---|---|
| **Index-first / persistent embeddings** | Precompute and store embeddings for the whole codebase ahead of time; a request queries the already-built index | Fast per-request lookup (no on-the-fly scanning); predictable latency and cost per query | Index can go stale between commits; large upfront and ongoing re-indexing cost (Step 1's aggregate re-indexing load); purely text/embedding-based unless paired with a separate graph |
| **Agentic / on-demand search** | No precomputed index — the model itself decides what to grep/read on the fly, tool-call by tool-call, during the request | Always sees the current state of the repository, zero staleness; no indexing infrastructure to maintain | Slower per request (multiple sequential tool-call round trips); cost scales with how many exploratory steps the model needs, which is less predictable |
| **Hybrid graph+vector** | Combine a dependency/call graph (built via static analysis) with vector search — retrieval can traverse "what calls this" as well as "what reads similarly to this" | Structurally aware in a way pure text similarity can't be — finds relevant call sites regardless of wording; better precision on code-specific questions | Most complex to build and keep in sync; graph extraction is itself a heavier, more language-specific indexing step |

This design uses the **hybrid graph+vector** approach for the general codebase-question use case (Step 2's indexing pipeline already extracts both embeddings and call/import relationships), while leaning on **agentic on-demand search** for the multi-step-change use case below, where the exact scope of what needs inspecting genuinely isn't known until the codebase is searched. A question about a rate limiter is best answered not just by the chunk that textually mentions "rate limit," but also by the handful of call sites that actually invoke it — a relationship pure text similarity has no way to know matters, since a call site's own text rarely resembles the query at all.

**Data structures:**
* `chunk_index` — `chunk_id -> embedding`, per repository (vector side)
* `call_graph` — `symbol_id -> {calls: [symbol_id], called_by: [symbol_id], imports: [module_id]}` (graph side)
* A retrieval result blends both: text-similar chunks unioned with the call/import neighbors of the top text-similar hits

**Trade-offs:**
* Index-first is the cheapest to query but the one most exposed to staleness — a request answered from an index that hasn't caught up with the last few commits can confidently reference code that no longer exists in that form.
* Agentic on-demand search is the freshest but the slowest and least predictable in cost — a question that needs many exploratory reads pays for every one of them synchronously, on the request's own critical path.
* This is the concrete way "structured context" differs from the prose-retrieval problem this course's LLM Support Bot case study solves: there, a documentation chunk's relevance is well-approximated by text similarity alone; here, a code chunk's relevance is frequently determined by graph structure that text similarity alone can't see.

### Use case: Developer asks for a multi-step change across several files

A request like "add a parameter to this function and update every call site" cannot be answered from a single retrieval-and-generate pass, because the full scope of what needs to change (every call site) isn't knowable until the codebase is actually searched for them.

**Core spec: fixed sequential pipeline — search, then read, then propose**

```
search_index(function_name)      -> [definition_location, call_site_1, call_site_2, ...]
    │
    ▼
read_file(each affected file)    -> full file contents (a chunk alone rarely has
    │                                enough surrounding context for a correct edit)
    ▼
propose_edit(each affected file) -> one diff per file, none applied yet
```

**Data structures:** `change_plan` — `target_symbol`, `affected_files` (list), `proposed_diffs` (`file_path -> diff`, populated only after read).

**Trade-offs:**
* This has the same fixed-stage-pipeline shape [Sequential Orchestration](/docs/patterns/ai-agent-orchestration/sequential-orchestration) describes — search, then read, then propose, each stage's output feeding the next — chosen deliberately over a more open-ended agentic loop because this task genuinely decomposes into an ordered sequence of dependent steps: you can't propose a correct call-site edit before you've found and read the call site.
* A simpler single-file question skips straight to retrieval and generation without needing the multi-stage sequence at all — this fixed pipeline is reserved for requests whose scope isn't knowable up front, not applied universally.

### Use case: Assistant uses tools as part of answering a request

Searching the index, reading a file, and applying an edit are each modeled as an explicit, typed tool call the model can invoke — the assistant proposes a call, an executor runs it, the result is observed and fed back, and the loop continues until a stopping condition. **File-mutating tool calls are a hard stop**: the loop pauses and will not execute the call until a human explicitly approves it — this is a real gate in the control flow, not a policy mentioned in prose.

**Core spec: read → act → observe → repeat, with a human-approval gate**

```python
MUTATING_TOOLS = {"apply_edit", "run_build"}
READ_ONLY_TOOLS = {"search_index", "read_file", "run_tests"}


class ToolCall:
    def __init__(self, tool_name, arguments):
        self.tool_name = tool_name
        self.arguments = arguments


class ToolResult:
    def __init__(self, tool_name, output, mutates_files=False):
        self.tool_name = tool_name
        self.output = output
        self.mutates_files = mutates_files


class AgentLoop:
    """read -> act -> observe -> repeat, with a hard human-approval gate
    before any file-mutating tool call actually executes. A mutating call
    is proposed and the loop pauses — it never silently runs. The loop
    only proceeds past it once approve_pending() is called explicitly.
    """

    def __init__(self, policy, executor):
        self.policy = policy          # decides the next tool call given observations
        self.executor = executor      # runs a tool call in the sandbox, returns a ToolResult
        self.observations = []
        self.pending_approval = None  # ToolCall awaiting human confirmation
        self.history = []             # (tool_call, result_or_None) trace

    def run_until_done_or_blocked(self):
        while True:
            if self.pending_approval is not None:
                return "blocked_on_approval"
            action = self.policy.next_action(self.observations)
            if action is None:
                return "done"
            if action.tool_name in MUTATING_TOOLS:
                # Hard stop: propose the call, do NOT execute it yet.
                self.pending_approval = action
                self.history.append((action, None))
                return "blocked_on_approval"
            result = self.executor.execute(action)
            self.observations.append(result)
            self.history.append((action, result))

    def approve_pending(self):
        """The only code path through which a mutating call is actually
        executed — requires an explicit human confirmation call.
        """
        if self.pending_approval is None:
            raise ValueError("no pending approval to confirm")
        action = self.pending_approval
        result = self.executor.execute(action)
        self.observations.append(result)
        self.history[-1] = (action, result)
        self.pending_approval = None
        return result

    def reject_pending(self):
        """Explicit rejection: the proposed call is discarded, never executed."""
        if self.pending_approval is None:
            raise ValueError("no pending approval to reject")
        self.history[-1] = (self.pending_approval, "REJECTED_NOT_EXECUTED")
        self.pending_approval = None
```

A sandboxed executor backs this loop — search and file-read tools are read-only and safe to run autonomously; `run_build`/`apply_edit` are the highest-risk tools since they mutate state or execute arbitrary project code, which is exactly why they're the ones gated:

```python
class SandboxedExecutor:
    """Runs a tool call in an isolated, disposable environment scoped to
    the current repository — no access beyond it, no network access by
    default (a lightweight container runtime, of the kind Docker
    popularized, is a common real building block for this). Read-only
    tools run freely; mutating tools still only reach here via
    AgentLoop.approve_pending, never via the unblocked step path.
    """

    def __init__(self, index, file_store):
        self.index = index            # symbol_name -> [file:line, ...]
        self.file_store = file_store  # file_path -> content

    def execute(self, tool_call):
        if tool_call.tool_name == "search_index":
            hits = self.index.get(tool_call.arguments["query"], [])
            return ToolResult("search_index", hits, mutates_files=False)
        if tool_call.tool_name == "read_file":
            content = self.file_store.get(tool_call.arguments["path"], "")
            return ToolResult("read_file", content, mutates_files=False)
        if tool_call.tool_name == "apply_edit":
            path = tool_call.arguments["path"]
            self.file_store[path] = tool_call.arguments["new_content"]
            return ToolResult("apply_edit", f"wrote {path}", mutates_files=True)
        raise ValueError(f"unknown tool: {tool_call.tool_name}")
```

**Data structures:**
* `ToolCall` — `tool_name`, `arguments`
* `ToolResult` — `tool_name`, `output`, `mutates_files`
* `AgentLoop.pending_approval` — the single outstanding `ToolCall` blocking further progress, or `None`
* `AgentLoop.history` — ordered `(tool_call, result)` trace, with `result = None` for a call still awaiting approval

**Trade-offs:**
* **The gotcha:** it's not enough to describe "the assistant asks before mutating files" in prose — the loop above makes it structurally impossible to reach `SandboxedExecutor.execute` for a mutating tool through any path except `approve_pending()`. `run_until_done_or_blocked` returns immediately once it encounters a mutating call, before executing it; only a separate, explicit call resumes execution. A design that instead ran every tool call through the same unconditional `execute()` and only *displayed* a confirmation dialog around it has a real risk of that dialog being bypassable (a race, a default-approve config flag, a retry path that skips the UI) — the gate has to be in the control flow the loop itself enforces, not layered on as a UI-only convention.
* This tool-use loop is also why the chat/agentic path is meaningfully more expensive and slower per request than a pure-retrieval design: a multi-step request might involve several sequential tool calls, each a round trip the final response has to wait on, before a complete answer — let alone an approved edit — is even possible.
* Read-only tools (`search_index`, `read_file`, `run_tests`) run autonomously inside the sandbox with no gate, since their blast radius is bounded to producing an observation, never a mutation — collapsing that distinction and gating every tool call equally would make the loop safer at the cost of asking a developer to approve searches and reads that were never risky in the first place.

## Step 4: Scale the design

![AI Code Assistant scaled architecture](/img/case-studies/code-assistant-scaled.svg)

* **Completions and chat/agentic requests scale as two entirely separate tiers, sized for very different workloads, which is the single biggest scaling decision in this design.** Given Step 1's roughly 27:1 volume ratio between the two, provisioning them as one undifferentiated serving pool would force the tight-latency, high-volume completion workload to compete for the same capacity as the far larger and slower per-request chat/agentic workload — the same "separate the hot, narrow path from the heavier, general one" instinct this course's Typeahead case study applies to prefix lookups versus this course's Newsfeed case study's full ranking pipeline, applied here to code completion versus codebase-aware chat.
* **The codebase index is sharded per repository, both for isolation and because that's how every real query is actually scoped.** See [Vector Database Sharding](/docs/patterns/ai-infra/vector-database-sharding). No developer request ever needs to search across unrelated repositories, and per Step 1's isolation requirement, one customer's private repository must never be reachable from another customer's query — sharding by repository satisfies both the scaling need and the isolation requirement with the same partitioning key, the same way this course's LLM Support Bot case study's per-tenant sharding does for documentation.
* **Incremental re-indexing is the aggregate background workload that most resembles a data-pipeline problem rather than a serving problem.** Step 1's math shows a single repository's re-indexing load is small and comfortably real-time, but aggregated across 3,000,000 actively indexed repositories, the platform-wide file-change volume is large enough that it's built and scaled the same way this course's Data Infrastructure Platform case study's ingestion tier is — a durable queue of pending file changes absorbing bursts (a large commit touching hundreds of files at once) without ever blocking a developer's next completion request, decoupled entirely from the low-latency serving paths above it.
* **A [Semantic Caching](/docs/patterns/ai-infra/semantic-caching) layer helps the chat/agentic path but is deliberately not applied to inline completions or to any tool-execution result.** Two developers on the same team asking a similarly-phrased codebase question can plausibly share a cached answer, scoped strictly per repository the same way this design's retrieval is. But a completion's relevance is so tightly coupled to the exact surrounding code at the exact cursor position that a "similar enough" cached completion is more likely to be subtly wrong than helpful, and a tool's result (a test run's pass/fail outcome) reflects the codebase's state at the moment it ran, not a cacheable, stable fact — caching either would violate this design's correctness requirements for the sake of savings that don't actually apply to either workload's shape.
* **Codebase-structure extraction (parsing, building the call/import graph) is the most computationally expensive part of indexing, and it scales independently from embedding generation.** Parsing a large repository's full dependency graph is a heavier, more language-specific operation than chunking and embedding text, so this stage runs as its own pool, sized and scaled separately — a burst of large repositories being newly onboarded shouldn't compete for the same capacity that keeps already-indexed repositories' incremental updates flowing in near-real time.
* **The three-architecture comparison from Step 3 has its own scaling shape: index-first's cost is dominated by re-indexing throughput, agentic on-demand's cost is dominated by per-request tool-call round trips, and hybrid graph+vector's cost is split across both.** Provisioning for this design's hybrid approach means budgeting for both the re-indexing queue above and the retrieval-time cost of a graph-neighbor expansion on top of a vector search — a real, if secondary, cost this design accepts in exchange for the structural-awareness advantage over pure index-first retrieval.

## Additional talking points

* **Why this design's hard problem is structured-context-plus-tool-use, not retrieval or serving scale.** Compared to this course's LLM Support Bot case study, this design's retrieval problem is harder in a specific way — relevance frequently depends on code's explicit structural relationships, not just text similarity — and compared to this course's Conversational AI System case study, the generation step alone is rarely sufficient, since many real requests need the assistant to take actions (search, read, execute) before a correct answer is even possible. Neither of the other two designs needs a sandboxed tool-execution layer or a dependency-graph-aware index; both are close to load-bearing requirements here.
* **Why a strict human-approval boundary is a design decision, not a limitation to eventually remove.** It's tempting to frame "the assistant can't apply its own edits" as a maturity gap a more capable system would eventually close, but Step 1 scopes this deliberately: a proposed edit that's subtly wrong but syntactically plausible is a much more dangerous failure mode in source code than a wrong answer in a chat response, since it can be committed, merged, and shipped before anyone notices something's off. The review boundary is what makes it safe for this design to be aggressive and fast about proposing changes in the first place.
* **The sandbox around tool execution is this design's most safety-critical component.** Search and file-read tools are low-risk because they're read-only and scoped to one repository, but a run-tests-or-build tool is executing arbitrary project code, and the sandbox's isolation (no access beyond the current repository, no network access by default, bounded execution time) is what makes that safe to run autonomously at all — a gap in that isolation would be a materially more serious failure than a bad text response ever could be, since it's a code-execution boundary, not just a content-quality one.
* **Why sequential, tool-using orchestration was chosen over a more open-ended agentic loop for multi-file changes.** A less structured design might let the model freely decide, turn by turn, whether to search, read, or generate next, but the multi-file-edit use case in Step 3 has a genuinely fixed logical order — you can't propose a correct call-site edit before you've found and read the call site — which is exactly the condition [Sequential Orchestration](/docs/patterns/ai-agent-orchestration/sequential-orchestration)'s own guidance names as the right fit for a fixed pipeline; a more open-ended orchestration pattern would add flexibility this specific task doesn't need at the cost of the predictability a fixed search-then-read-then-propose sequence gives for free.
* **Why no single one of the three retrieval architectures dominates the other two.** Index-first wins on latency and cost predictability whenever staleness is tolerable; agentic on-demand wins on freshness whenever a query's scope can't be predicted ahead of time; hybrid graph+vector wins on precision for structurally-driven questions at the cost of the most indexing complexity of the three. A production system serving many different request shapes (fast completions, broad questions, scoped multi-file edits) is a reasonable candidate for using more than one of these architectures for different request types within the same product, rather than treating the choice as a single global decision.

## Source(s) and further reading

* [tree-sitter](https://tree-sitter.github.io/tree-sitter/) — a real, widely-used incremental parsing library that builds a syntax tree across many languages with one consistent interface, a common building block for the structure-extraction stage of this design's indexing pipeline
* [Anthropic: Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents) — practical guidance on designing the explicit, typed tool-call contracts this design's agent loop relies on
* [GitHub Copilot documentation](https://docs.github.com/en/copilot) — a real, production code-completion and chat assistant in this design's product category
* [Sequential Orchestration](/docs/patterns/ai-agent-orchestration/sequential-orchestration) — the fixed-pipeline shape this design's multi-file-change use case reuses
* [Vector Database Sharding](/docs/patterns/ai-infra/vector-database-sharding) — the per-repository partitioning shape this design's codebase index scales with
* [RAG Pipeline](/docs/patterns/ai-infra/rag-pipeline) — the chunk/embed/retrieve/re-rank shape this design's codebase-question retrieval extends with graph structure
