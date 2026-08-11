---
title: "Design a Conversational AI System (like ChatGPT)"
sidebar_position: 22
---

A general-purpose conversational AI system's defining challenge isn't any single hard algorithm — it's that an enormous number of people are simultaneously asking a large, expensive model open-ended questions and expecting a response that starts streaming back in a second or two, every time, at a cost per response that has to stay economically sane multiplied across hundreds of millions of daily messages. This is fundamentally an inference-serving-and-scaling problem: managing per-conversation context, routing a huge volume of concurrent generation requests onto a comparatively scarce and expensive pool of model-serving capacity, and keeping latency and cost predictable under load that swings hard over the course of a day.

*Educative's Grokking Modern System Design Interview course covers this same system in its "Design a ChatGPT System" module, including a dedicated "ChatGPT System Design (Mock Interview)" sub-lesson.*

## Step 1: Outline use cases and constraints

### Use cases

#### We'll scope the problem to handle the following use cases

* **User** sends a message and receives a generated response that streams back incrementally, not all at once after a long wait
* **User** carries on a multi-turn conversation, where each new message is answered with awareness of everything said earlier in that same conversation
* **User** starts a new, unrelated conversation, which the system keeps entirely separate from any other conversation, past or concurrent
* **Service** serves an extremely high volume of concurrent generation requests across a huge population of simultaneous users, without degrading response latency as load grows
* **Service** persists conversation history durably so a user can leave and return to a past conversation later
* **Service** applies a content and safety filtering layer to both incoming requests and generated responses before either reaches the model or the user
* **Service** has high availability — a general-purpose assistant used by a huge population is expected to be reliably reachable, not occasionally down for a meaningful fraction of that population

#### Out of scope

* Training or fine-tuning the underlying model — this design treats a trained model as a given input, not something produced here
* Retrieval-augmented grounding against a specific private knowledge base (this course's LLM Support Bot case study covers that problem in depth; this design is intentionally scoped to open-domain conversation)
* Tool use, code execution, or agentic multi-step task completion (this course's AI Code Assistant case study covers a tool-use-heavy design; this one is scoped to pure conversational generation)
* Billing, account management, and multi-tenant plan/quota enforcement beyond a brief mention

### Constraints and assumptions

#### State assumptions

* 50 million daily active users, each sending an average of 8 messages per day
* Conversation context (prior turns in the same conversation) must be included in every generation call within that conversation, since the model is otherwise stateless between calls — the system, not the model, is responsible for assembling and carrying that context forward
* A response should begin streaming back to the user within roughly a second of the request being sent, even though the full response continues generating for several seconds after that — perceived latency is dominated by time-to-first-token, not total generation time
* Model inference is the dominant cost and capacity constraint in this design, far more than storage or the request-routing layer around it — generation capacity, not database throughput, is the resource this design spends most of its scaling effort protecting
* Traffic is highly diurnal, with a pronounced multi-hour peak as usage follows waking hours across the service's user base, not a flat rate around the clock
* Conversation history must survive a user closing and reopening the client, but does not need to support the same real-time multi-editor convergence guarantees this course's Google Docs case study requires — each conversation has exactly one user appending to it, never multiple concurrent writers to the same conversation
* Every generated response is expected to be reviewed against a safety/content policy before being shown to the user, and every incoming request is expected to be checked before being sent to the model at all

#### Calculate usage

* Message volume: 50,000,000 users × 8 messages/day = **400,000,000 messages/day** → 400,000,000 / 86,400 ≈ **~4,600 messages/sec average**, with usage concentrated in waking hours rather than spread evenly across 24 hours — design for **~3x average at peak**, so **~14,000 messages/sec at peak**
* Token volume: assuming an average of 300 input tokens per request (including carried-forward conversation context, which grows the input token count as a conversation gets longer) and 250 output tokens per generated response → 550 tokens per message round-trip → 400,000,000 × 550 ≈ **~220 billion tokens/day**, or roughly 2,550,000 tokens/sec average and **~7,650,000 tokens/sec at peak** — this per-token figure, not the message count alone, is what actually governs model-serving capacity, since a long-context conversation and a short one generate the same "one message" in Step 1's count but very different amounts of actual compute
* Concurrent in-flight generations (Little's Law: concurrency = arrival rate × average time in system): at ~4,600 messages/sec average and an average of 3 seconds for a full response to finish generating, that's 4,600 × 3 ≈ **~13,900 concurrent in-flight generations at average load**, and at peak (14,000/sec × 3s) ≈ **~42,000 concurrent in-flight generations** — this concurrency figure, not the per-second request rate by itself, is what determines how many model-serving replicas need to be running at once
* Serving capacity: assuming a single model-serving replica can sustain roughly 20 concurrent generations through request batching (see [Model Serving](/docs/patterns/ai-infra/model-serving)), peak concurrency of ~42,000 requires roughly 42,000 / 20 ≈ **~2,100 concurrently active serving replicas** at peak — a large, expensive fleet, and the central reason this design treats inference capacity as the dominant cost and scaling constraint rather than any other tier
* Conversation storage: at an average of 800 bytes per message (both the user's message and the generated response, plus metadata) × 400,000,000 messages/day ≈ **~320 GB/day** of conversation history — small relative to the compute cost above, confirming storage is not this design's bottleneck

## Step 2: Create a high-level design

![Conversational AI System high-level architecture](/img/case-studies/chatgpt-overview.svg)

A user's message reaches a **gateway/API layer**, which authenticates the request and forwards it to a **safety filtering** stage before anything else happens — a request never reaches the model until it clears this check. Assuming it passes, a **context assembly** step fetches the relevant prior turns of that specific conversation from a **conversation store** and combines them with the new message into the actual input the model will see. That assembled input is handed to a **model-serving layer**, which batches concurrent requests and runs them against a fleet of loaded model instances, streaming generated tokens back as they're produced rather than waiting for the full response to complete. Generated output passes through the same safety filtering stage in reverse — checked before it reaches the user, not just the input checked on the way in — and the completed exchange (user message plus generated response) is written back to the conversation store so it's available as context for the next turn and persists for the user to return to later.

The structural bet this design makes is that **inference capacity is the scarce, expensive resource everything else is built to protect**, which is a different center of gravity than most of this course's other case studies. A newsfeed or a URL shortener is typically built around protecting an overloaded database or absorbing a fan-out write storm; here, the database-equivalent tier (the conversation store) is comparatively cheap and fast to scale, per Step 1's storage math, while the model-serving tier is both the most expensive component per unit of work and the hardest to scale quickly, since adding serving capacity means provisioning and warming specialized, costly hardware, not just spinning up another stateless web server. Nearly every scaling decision in Step 4 traces back to this asymmetry.

## Step 3: Design core components

### Use case: User sends a message and receives a response that streams back incrementally

**Core spec: two distinct latency metrics, not one**

This design tracks **time-to-first-token (TTFT)** and **inter-token latency** as genuinely different measurements with different causes, not a single "response latency" number:

* **TTFT** — time from request received to the first generated token being sent — is dominated by **prefill**: processing the entire input prompt (including all carried-forward conversation context) through the model in one forward pass before any output token can be produced. A long conversation's assembled context makes prefill, and therefore TTFT, slower even though generation itself hasn't started.
* **Inter-token latency** — time between each subsequent token and the next — is dominated by **decode**: one incremental forward pass per output token, repeated until the response finishes. This is Step 1's per-step generation cost, and it's largely independent of how long the input prompt was.

```
$ curl -N https://chat.example/api/v1/messages \
    -d '{"conversation_id": "c_9f2a", "message": "Summarize the last chapter"}'
```

Response (streamed, one chunk per generated token):

```
data: {"token": "The", "seq": 0}
data: {"token": " chapter", "seq": 1}
data: {"token": " covers", "seq": 2}
...
data: {"done": true, "seq": 47}
```

**Data structures:** no new server-side state; the client tracks `latest_seq` to detect gaps/reordering on the stream.

**Trade-offs:**
* Treating TTFT and inter-token latency as one blended number hides which half of the pipeline needs attention — a slow TTFT points at prefill cost (prompt length, context-assembly overhead), while rising inter-token latency points at decode-step cost (batch contention, KV-cache pressure) — see the two use cases below for the mechanisms that target each.
* [Server-Sent Events](/docs/patterns/communication/server-sent-events) is a common real transport for this kind of one-way, incremental token stream; the response is an open channel the server writes to as tokens are produced, closed once generation completes or the user cancels mid-stream (which stops the serving replica's work for that request rather than letting it run to completion for output nobody will see).

### Use case: User carries on a multi-turn conversation, with context from earlier turns included

The model itself is stateless between calls — every generation call has the relevant prior turns assembled into its input by the system, not recalled by the model. As a conversation grows longer, the amount of context carried forward grows with it, which directly inflates **prefill cost and therefore TTFT** for later turns in a long conversation, even though each turn still counts as "one message" in Step 1's raw request-volume figure. Because a model can only accept a bounded amount of input context, a sufficiently long conversation eventually needs a truncation or summarization strategy (dropping or condensing the oldest turns) to keep the assembled context within that bound — a tradeoff this design makes explicit rather than silently truncating in a way that loses information the user still expects the assistant to remember.

**Data structures:** conversation context assembled as an ordered list of `(role, content, token_count)` turns; a running `total_context_tokens` tracked per conversation to decide when truncation triggers.

### Use case: Service serves an extremely high volume of concurrent generation requests without degrading latency

At peak, roughly 42,000 generations are in flight simultaneously (Step 1). Two named, complementary mechanisms make a fixed-size serving fleet handle that load without the response-time budget slipping.

**Core spec: continuous (iteration-level) batching**

Static batching — wait for a fixed number of requests to arrive, run them together, don't admit anyone new until every member finishes — wastes capacity here: individual requests finish at very different token counts (a short answer vs. a long one), so a static batch runs only as fast as its slowest member while finished members' slots sit idle. **Continuous batching** schedules at the level of a single decode step instead of a whole generation — a request that finishes is evicted immediately, and a waiting request can be admitted into the freed slot on the very next step:

```python
class GenerationRequest:
    """One in-flight generation request tracked by the scheduler."""

    def __init__(self, request_id, prompt_tokens, max_new_tokens):
        self.request_id = request_id
        self.prompt_tokens = prompt_tokens
        self.max_new_tokens = max_new_tokens
        self.generated_tokens = []
        self.finished = False

    def is_finished(self):
        if len(self.generated_tokens) >= self.max_new_tokens:
            return True
        if self.generated_tokens and self.generated_tokens[-1] == EOS_TOKEN:
            return True
        return False


EOS_TOKEN = -1


class ContinuousBatchingScheduler:
    """Iteration-level batching: the in-flight batch is whatever requests
    are unfinished *right now*. A request that finishes mid-batch is
    evicted immediately, and a newly-arrived request can take its slot on
    the very next step — no waiting for the whole batch to drain.
    """

    def __init__(self, model, max_batch_size):
        self.model = model                # exposes decode_step(request_id) -> token
        self.max_batch_size = max_batch_size
        self.waiting_queue = []
        self.in_flight = {}               # request_id -> GenerationRequest
        self.completed = []
        self.step_count = 0

    def submit(self, request):
        self.waiting_queue.append(request)

    def _admit_new_requests(self):
        while self.waiting_queue and len(self.in_flight) < self.max_batch_size:
            req = self.waiting_queue.pop(0)
            self.in_flight[req.request_id] = req

    def step(self):
        """Run one decode step across every in-flight request, evict
        finished ones, then backfill from the waiting queue — admission
        happens every step, which is what makes this 'continuous' rather
        than static.
        """
        self._admit_new_requests()
        for request_id, req in list(self.in_flight.items()):
            token = self.model.decode_step(request_id)
            req.generated_tokens.append(token)
            if req.is_finished():
                req.finished = True
                self.completed.append(req)
                del self.in_flight[request_id]
        self.step_count += 1

    def run_until_idle(self):
        while self.waiting_queue or self.in_flight:
            self.step()
        return self.completed
```

**Core spec: PagedAttention / KV-cache block management**

Each in-flight request holds a growing **KV cache** (the attention key/value tensors for every token generated so far) that has to stay resident in GPU memory for the life of the request. Allocating one contiguous block per request — sized for the maximum possible sequence length up front — wastes memory badly, since most sequences finish well short of the maximum and the unused tail of every allocation is memory no other request can use. **PagedAttention** manages the KV cache in fixed-size blocks, the same way OS virtual memory pages physical RAM: a request's cache is a list of block references rather than one contiguous span, blocks are allocated on demand as generation proceeds, and a finished request's blocks return to a free pool immediately rather than staying reserved for a worst-case length that never happened.

```python
class KVCacheBlockManager:
    """Fixed-size block allocator for attention KV cache, modeled on OS
    virtual-memory paging: a request's cache is a list of block ids, not
    one contiguous allocation, so fragmentation from variable-length
    sequences never wastes a whole reservation on an early-finishing request.
    """

    def __init__(self, total_blocks, block_size_tokens):
        self.block_size_tokens = block_size_tokens
        self.free_blocks = list(range(total_blocks))
        self.request_block_tables = {}  # request_id -> [block_id, ...]

    def tokens_to_blocks(self, num_tokens):
        return (num_tokens + self.block_size_tokens - 1) // self.block_size_tokens

    def allocate_for_growth(self, request_id, new_token_count):
        """Called each decode step: allocate one more block only when the
        request's cache actually crosses into a new block boundary —
        not the full worst-case length up front.
        """
        needed = self.tokens_to_blocks(new_token_count)
        table = self.request_block_tables.setdefault(request_id, [])
        while len(table) < needed:
            if not self.free_blocks:
                raise MemoryError("no free KV-cache blocks available")
            table.append(self.free_blocks.pop())
        return table

    def release(self, request_id):
        """Finished request: its blocks return to the free pool immediately,
        available to the very next step's admissions rather than sitting
        reserved for a length that was never reached.
        """
        table = self.request_block_tables.pop(request_id, [])
        self.free_blocks.extend(table)
```

Real inference-serving engines implement both mechanisms directly: [vLLM](https://docs.vllm.ai/en/latest/) originated PagedAttention and pairs it with continuous batching, and [NVIDIA TensorRT-LLM](https://arxiv.org/abs/2309.06180) implements the same in-flight-batching idea under its own name — both are common concrete building blocks for a serving layer like this one, rather than something a production system hand-rolls from scratch.

**Data structures:**
* `GenerationRequest` — `request_id`, `prompt_tokens`, `max_new_tokens`, `generated_tokens`, `finished`
* `KVCacheBlockManager` — `free_blocks` (pool of block ids), `request_block_tables` (`request_id -> [block_id, ...]`)

**Trade-offs:**
* **The gotcha:** static batching and one-contiguous-allocation-per-request both look like the "obvious" implementation and both quietly cap throughput well below what the hardware can actually sustain — static batching wastes slot-time on early finishers, and contiguous KV allocation wastes memory on the unused tail of every reservation sized for a worst case that rarely happens. Continuous batching fixes the first; PagedAttention fixes the second — they solve different resources (compute-slot utilization vs. memory utilization) and a production serving layer needs both, not either.
* Continuous batching's admission check runs every step, which is cheap relative to a decode step's own cost, but it does mean the scheduler itself has to be fast and correct under concurrent submission — a slow or buggy admission path directly adds to every in-flight request's inter-token latency, not just the newly-admitted one's TTFT.
* Fixed block size in `KVCacheBlockManager` is a tunable trade: a smaller block size reduces the worst-case wasted fragment per request (at most one partially-full block) but adds more per-block bookkeeping overhead; a larger block size does the reverse.

### Use case: Service persists conversation history so a user can return to a past conversation

Unlike this course's Google Docs case study, where many editors concurrently mutate the same shared document and convergence is the hard problem, a conversation here has exactly one user ever appending to it — there's no concurrent-write conflict to resolve. Each conversation is an append-only sequence of turns, keyed by conversation ID, and a read is a straightforward ordered fetch of that sequence, either in full (for context assembly) or as a paginated history (for a user browsing past conversations).

**Data structures:** `conversations` — `conversation_id`, `user_id`, `created_at`; `turns` — `conversation_id`, `seq`, `role`, `content`, `token_count`, `created_at`.

**Trade-offs:**
* Conversation history is written once per turn and read far more often as context for the *next* turn in the same conversation than it's ever browsed by a user going back through old history, so the store is optimized for fast, recent-turn point lookups scoped to one conversation at a time.

### Use case: Service applies content and safety filtering to both requests and responses

A generation request is checked against a safety policy before it's ever sent to the model, and the model's output is checked again before it reaches the user — two separate checkpoints, because a request that looks acceptable on its own can still lead a model to generate output that fails policy.

**Data structures:** no persistent state beyond a policy-check result attached to the request/response log for audit purposes.

**Trade-offs:**
* Both checks sit directly on the critical path (they gate whether generation happens at all, and whether a completed response is ever shown), so their own latency budget has to be small and predictable relative to the TTFT target — a slow safety check on every message directly inflates TTFT, since it runs before prefill even starts.
* This is conceptually the same "centralize a cross-cutting concern at a single choke point every request passes through" shape as an [LLM Gateway](/docs/patterns/ai-infra/llm-gateway), applied here to policy enforcement rather than provider routing and cost metering.

## Step 4: Scale the design

![Conversational AI System scaled architecture](/img/case-studies/chatgpt-scaled.svg)

* **The model-serving tier scales using [GPU Auto-Scaling](/docs/patterns/ai-infra/gpu-auto-scaling), not ordinary CPU-tier auto-scaling, because of the same cost and provisioning-latency asymmetry that pattern is built around.** Given Step 1's diurnal traffic and the multi-minute cost of provisioning a fresh serving replica (allocating hardware, loading model weights), a policy that scales reactively from zero the way a stateless web tier would leaves the first wave of each day's traffic ramp stalled behind a cold start. Instead, a warm minimum pool sized to comfortably absorb off-peak baseline load stays running continuously, and the fleet scales out toward the roughly 2,100-replica peak figure from Step 1 as sustained load actually increases through the day — not on the first uptick, since a brief spike that would resolve on its own doesn't justify paying the provisioning cost of a new replica that finishes booting after the spike has already passed.
* **`max_batch_size` in the continuous-batching scheduler is a direct, tunable lever on the throughput/memory tradeoff this design cares about most, and it's capped by KV-cache block availability, not chosen freely.** A larger `max_batch_size` lets more concurrent requests share the fleet's decode-step throughput — directly reducing how many replicas Step 1's peak concurrency figure actually requires — but each admitted request needs its own growing set of KV-cache blocks from `KVCacheBlockManager`'s finite pool, so the two mechanisms are coupled: raising the batch-size ceiling without also having the memory budget for its worst-case block consumption just trades an admission-queue wait for a `MemoryError` at generation time. This tradeoff is tuned empirically against real traffic and real block-pool sizing rather than fixed at a single "correct" value.
* **Context assembly is a read-heavy, latency-sensitive step that has to stay off the expensive model-serving path's critical timing, which is why it's a separate stage rather than something the model-serving layer does itself.** As conversations grow longer, the amount of context fetched and assembled per request grows too (Step 3), inflating prefill cost and therefore TTFT specifically — so this stage is scaled independently, and more context-assembly capacity is comparatively cheap to add, unlike model-serving capacity, keeping a slow context fetch from ever competing with or blocking the far more expensive decode step for the same resources.
* **Safety filtering is applied at a fixed choke point per request rather than duplicated per calling surface, the same centralization argument [LLM Gateway](/docs/patterns/ai-infra/llm-gateway) makes for provider routing and metering — but it scales as its own independently horizontally-scaled tier, since unlike model-serving, filtering doesn't need specialized, expensive hardware and can scale cheaply and reactively with ordinary auto-scaling as request volume grows.** Keeping filtering decoupled from the model-serving fleet's own scaling policy matters specifically because the two tiers have very different cost profiles and provisioning speeds, and coupling their scaling would force the cheap, fast-to-scale tier to wait on the slow, expensive one's provisioning cadence for no reason.
* **Conversation storage scales by sharding on conversation ID, since essentially every read and write is scoped to a single conversation, never queried across conversations.** See [Sharding](/docs/patterns/storage/sharding). Given Step 1's comparatively small ~320 GB/day storage figure against the multi-thousand-replica model-serving fleet this design otherwise devotes most of its scaling attention to, conversation storage is a genuinely secondary concern here — sharded for clean horizontal growth, but never the tier that determines this system's overall capacity ceiling.

## Additional talking points

* **Why this design's hard problem is inference-serving-and-scaling, specifically, not generation quality or knowledge grounding.** It's tempting to frame a conversational AI system's design challenge around what the model itself does, but from a systems perspective the model's behavior is a given input, and the actual engineering problem this design solves is getting an extremely high volume of concurrent requests onto a comparatively scarce, expensive, slow-to-provision pool of serving capacity with consistent sub-second time-to-first-token — a capacity-and-latency problem structurally closer to this course's Uber or YouTube case studies' scaling challenges than to a database-design problem.
* **Why this design deliberately doesn't include retrieval grounding or tool use.** Both are genuinely valuable additions to a conversational system in practice, but each introduces a different dominant hard problem of its own — grounding responses in an external, current knowledge base (this course's LLM Support Bot case study) or reliably interacting with a structured external environment (this course's AI Code Assistant case study) — and folding either into this design would blur the specific inference-scaling problem this case study is built to isolate and go deep on.
* **The economics of a fixed per-token cost multiplied across hundreds of billions of tokens a day.** Because model inference cost scales with tokens processed, not requests served, small, easy-to-overlook inefficiencies — carrying more conversation history than a response actually needs, an unnecessarily verbose system prompt included on every single call — get multiplied across Step 1's ~220 billion tokens/day figure into a real, material cost difference, which is why context-assembly logic in a production system this size is typically under real cost pressure to be efficient, not just correct.
* **Multi-turn context growth as a slow-building capacity risk, not just a UX consideration.** A single very long-running conversation quietly consumes more input tokens on every subsequent turn than a fresh one does, and at this scale, a shift in typical conversation length across the user base — even a small one — changes the average tokens-per-message figure Step 1's entire capacity plan is built on, which is why context-length distribution is a metric worth actively monitoring in production, not a one-time assumption baked in at design time.
* **Why TTFT and inter-token latency need separate monitoring, not a single blended "response time" metric.** A regression that only shows up in inter-token latency (rising decode-step cost — batch contention, KV-cache pressure near the block pool's limit) is invisible in a metric that averages across the whole response, since a slow middle-of-response stretch can be masked by a fast TTFT on the same request. Production systems built on this shape track both explicitly, alongside tokens/sec throughput per replica, precisely because the two numbers point at different parts of the pipeline (prefill vs. decode) and therefore different fixes.

## Source(s) and further reading

* [vLLM documentation](https://docs.vllm.ai/en/latest/) — the inference-serving engine that originated PagedAttention, paired with continuous batching
* [TensorRT-LLM paper (arXiv)](https://arxiv.org/abs/2309.06180) — NVIDIA's inference-serving engine implementing in-flight (continuous) batching
* [Orca: A Distributed Serving System for Transformer-Based Generative Models — USENIX OSDI '22](https://www.usenix.org/conference/osdi22/presentation/yu) — the original paper naming and evaluating iteration-level (continuous) scheduling for LLM serving
* [Model Serving](/docs/patterns/ai-infra/model-serving) — this course's own pattern page on batched inference serving
* [GPU Auto-Scaling](/docs/patterns/ai-infra/gpu-auto-scaling) — the scaling shape this design's model-serving tier depends on
* [LLM Gateway](/docs/patterns/ai-infra/llm-gateway) — the choke-point shape this design's safety-filtering stage reuses
