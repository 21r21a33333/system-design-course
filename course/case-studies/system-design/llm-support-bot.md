---
title: "Design an LLM-Powered Customer Support Bot"
sidebar_position: 23
---

A customer support bot's hardest problem isn't generating fluent text — a general-purpose model does that easily. It's making sure every answer is actually grounded in a specific company's real, frequently-changing product documentation and account data, and, just as importantly, knowing when *not* to answer at all and hand the conversation to a human instead. Compared to a general-purpose conversational system, this is a narrower problem in scope but a deeper one on trust: a confidently wrong answer about a refund policy or an account balance is a worse outcome than a slow one, and this design is built around grounding and escalation, not raw conversational breadth or request volume.

*Educative's Grokking Modern System Design Interview course covers this same system in its "LLM-Powered Customer Support Bot System Design" module.*

## Step 1: Outline use cases and constraints

### Use cases

#### We'll scope the problem to handle the following use cases

* **Customer** asks a support question in natural language and receives an answer grounded in the company's current product documentation, not the model's general, possibly outdated knowledge
* **Customer** asks a question involving their own account (order status, subscription details) and receives an answer grounded in that customer's actual account data, not a generic response
* **Service** detects when it cannot answer a question confidently or safely and escalates the conversation to a human support agent, along with a summary of what's been discussed so far
* **Support team** updates product documentation, and the bot's answers reflect that update within a short, bounded window — not after a lengthy retraining or redeployment cycle
* **Customer** carries on a multi-turn conversation where follow-up questions are answered with awareness of earlier turns in the same conversation
* **Service** logs every conversation, the sources retrieved to ground each answer, and every escalation, so a support team can audit what the bot told a customer and why

#### Out of scope

* The human support-agent tooling itself (ticketing UI, agent assignment/routing — a platform like Zendesk or Intercom is a typical real system this design would hand off to) beyond the handoff mechanism that hands a conversation to it
* Voice or phone-channel support (this design is scoped to text-based chat)
* Proactive outreach (the bot initiating contact with a customer) — this design only handles customer-initiated conversations
* Training or fine-tuning the underlying model — treated as a given input, the same scoping this course's Conversational AI System case study uses

### Constraints and assumptions

#### State assumptions

* This platform serves many client companies, each with its own product documentation and its own customers — the design is multi-tenant, and one tenant's documentation and account data must never leak into another tenant's answers
* Across all tenants combined, the platform handles 300,000 support conversations/day, each averaging 5 back-and-forth turns
* The combined knowledge base across all tenants totals roughly 50,000 documentation articles, with roughly 2,000 articles updated, added, or removed on a typical day — a knowledge base that changes continuously, not one that's stable for long stretches
* An answer must never be given with unwarranted confidence when the knowledge base genuinely doesn't contain the answer — the system is explicitly required to recognize "I don't have grounded information for this" as a valid, preferred outcome over a fluent but ungrounded guess
* A documentation update must be reflected in the bot's answers within minutes to low single-digit hours, not after a batch cycle measured in days — support content changes (a new known issue, an updated pricing page) are often time-sensitive
* Roughly 12% of conversations are expected to require escalation to a human agent — either because the knowledge base doesn't cover the question, the customer explicitly asks for a human, or the system's own confidence in a grounded answer is too low
* Traffic is spikier than a general conversational assistant's, since support volume follows both business hours and unpredictable events (an outage, a billing incident) that can produce a sudden surge in a single tenant's conversation volume — design for a materially higher peak-to-average ratio than a broad, naturally-smoothed consumer traffic pattern would need

#### Calculate usage

* Conversation volume: 300,000 conversations/day → 300,000 / 86,400 ≈ **~3.5 conversations/sec average**; because support traffic spikes sharply around business hours and incident-driven surges, design for **~6x average at peak**, so **~21 conversations/sec at peak** — a comparatively low absolute request rate next to this course's Conversational AI System case study's tens of thousands of messages/sec, since this design serves a bounded population of paying client companies' customers, not an open consumer population
* Turn volume: 300,000 conversations × 5 turns/conversation = **1,500,000 turns/day** → ~17.4 turns/sec average — this is the more relevant figure than conversation count for capacity planning, since every turn, not just the first one in a conversation, triggers its own retrieval-and-generation cycle
* Knowledge base index size: 50,000 articles × an average of 8 chunks/article (per the chunking approach [RAG Pipeline](/docs/patterns/ai-infra/rag-pipeline) describes) = **400,000 chunks**; at a 768-dimension embedding stored as 4-byte floats, each vector is 768 × 4 = 3,072 bytes → 400,000 × 3,072 bytes ≈ **~1.2 GB** of vector index — small enough to comfortably fit on a single well-provisioned node for most individual tenants, and confirms this design's index doesn't need [Vector Database Sharding](/docs/patterns/ai-infra/vector-database-sharding) purely for capacity at this scale, though a very large enterprise tenant's documentation set could individually approach that threshold
* Re-indexing load: 2,000 updated articles/day × 8 chunks/article = **16,000 chunks re-embedded/day**, or roughly 0.19 chunks/sec average — a small, steady background load compared to the query-time retrieval traffic, confirming that keeping the index fresh is comfortably affordable continuously rather than needing to be batched into an off-peak window
* Escalation volume: 300,000 conversations/day × 12% ≈ **36,000 escalations/day**, or roughly 0.42 escalations/sec average — low enough in absolute terms that the escalation path's own scaling is never this design's bottleneck, though its correctness (never silently failing to escalate when it should) matters far more than its throughput

## Step 2: Create a high-level design

![LLM-Powered Customer Support Bot high-level architecture](/img/case-studies/llm-support-bot-overview.svg)

A customer's message reaches a **conversation service**, which first resolves which tenant's knowledge base and account data the request should be grounded against, then hands the query to a **retrieval stage**: the query is embedded and searched against that tenant's document index (a purpose-built vector database like Pinecone or Weaviate, or a relational store extended with a vector index such as PostgreSQL's pgvector, are all real, common choices for this role) to fetch the most relevant chunks of product documentation, following the [RAG Pipeline](/docs/patterns/ai-infra/rag-pipeline) shape end to end — chunk, embed, retrieve, re-rank. If the query references the customer's own account, a separate **account data lookup** fetches the relevant account fields directly rather than through retrieval, since account state is exact, structured data, not something that benefits from similarity search. Retrieved documentation chunks, any looked-up account fields, and the recent conversation turns are assembled into the model's input, and the model generates a response grounded in that assembled context. Before the response reaches the customer, a **confidence/escalation check** evaluates whether the retrieved context actually supports a confident answer; if it doesn't — or the customer explicitly asks for a human — the conversation is routed to an **escalation queue** with a generated summary instead of returning a generated answer at all.

The structural bet this design makes, differently from a general-purpose conversational assistant, is that **grounding quality and the decision of whether to answer at all matter more than conversational breadth or raw request volume** — this system is deliberately narrow, answering only what a specific, retrievable, frequently-updated knowledge base and a specific customer's account data actually support, and treating "escalate to a human" as a first-class, successful outcome rather than a failure mode to be minimized at all costs. Retrieval freshness (Step 1's minutes-to-hours re-indexing requirement) and the escalation decision are the two places this design spends the most engineering effort, in the same way this course's Conversational AI System case study spends most of its effort on inference-serving capacity.

## Step 3: Design core components

### Use case: Customer asks a question and receives an answer grounded in current product documentation

This is the core RAG loop, per the [RAG Pipeline](/docs/patterns/ai-infra/rag-pipeline) pattern: embed the query, retrieve the top-N most similar chunks, re-rank down to the top-K that genuinely address the question, inject those into the model's prompt. Before any of that runs, though, is a decision that shapes retrieval quality more than almost anything downstream of it: **how the source documentation was chunked in the first place**.

**Core spec: chunking strategy is its own explicit decision, separate from retrieval**

Two named approaches, with a real trade-off between them:

* **Fixed-length chunking** — split every document into windows of a fixed character/token count, optionally with overlap between consecutive windows. Simple, predictable, trivially parallelizable, and every chunk is a uniform size for batch embedding — but a fixed boundary has no idea where one coherent idea ends and the next begins, so it can split a single explanation (a refund policy's condition and its exception) across two separate chunks, and retrieval may then surface only half the idea.
* **Semantic chunking** — split at natural document boundaries (headings, paragraphs, or a model-scored "topic shift" between sentences) so each chunk holds one coherent idea. This respects the document's own structure and avoids the mid-idea split above, but requires real preprocessing (structure detection, or an extra model pass to score boundaries) and produces variable-length chunks, which complicates batch embedding — a batch of wildly different-length chunks doesn't pack efficiently the way uniform fixed-length chunks do, and a chunk that's too long still risks diluting a single embedding vector across multiple unrelated ideas.

A common, practical middle ground is **fixed-length chunking with overlap** — cheap and predictable like pure fixed-length, but the overlap between consecutive windows means an idea sitting near a boundary still appears whole in at least one chunk:

```python
def fixed_length_chunk_with_overlap(text, chunk_size=800, overlap=150):
    """Fixed-length-with-overlap chunking: split text into chunk_size-
    character windows, each overlapping the previous by `overlap`
    characters, so an idea near a boundary still appears whole in at
    least one chunk, without semantic chunking's preprocessing cost.
    """
    if chunk_size <= overlap:
        raise ValueError("chunk_size must exceed overlap, or the window never advances")
    chunks = []
    start = 0
    text_len = len(text)
    while start < text_len:
        end = min(start + chunk_size, text_len)
        chunks.append(text[start:end])
        if end == text_len:
            break
        start = end - overlap  # advance by (chunk_size - overlap), re-covering `overlap` chars
    return chunks
```

Once chunked, the retrieval-and-rerank pipeline itself:

```python
import math


def cosine_similarity(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


class Chunk:
    def __init__(self, chunk_id, text, doc_id, embed_fn):
        self.chunk_id = chunk_id
        self.text = text
        self.doc_id = doc_id
        self.embedding = embed_fn(text)
        self.rerank_score = None  # set by rerank_top_k once a chunk survives reranking


def retrieve_top_n(query, chunks, embed_fn, n=20):
    """Stage 1: cheap, approximate similarity search over the full
    per-tenant chunk index. Casts a wide net (n candidates) because
    embedding-similarity alone is a coarse relevance signal.
    """
    q_emb = embed_fn(query)
    scored = [(cosine_similarity(q_emb, c.embedding), c) for c in chunks]
    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [c for score, c in scored[:n] if score > 0]


def rerank_top_k(query, candidates, rerank_score_fn, k=3):
    """Stage 2: a more expensive, more precise scoring pass (a real
    system uses a cross-encoder reranker scoring the query and each
    candidate chunk jointly) narrowed to just the top-N candidates from
    stage 1 — too expensive to run over the whole index, cheap enough to
    run over a few dozen candidates. The rerank score is stamped onto
    each surviving chunk, since the escalation check below needs it.
    """
    scored = [(rerank_score_fn(query, c), c) for c in candidates]
    scored.sort(key=lambda pair: pair[0], reverse=True)
    top_chunks = []
    for score, chunk in scored[:k]:
        chunk.rerank_score = score
        top_chunks.append(chunk)
    return top_chunks
```

The model is explicitly instructed to answer using only the retrieved context, not its own general training knowledge — the entire value of this design over a general-purpose assistant is that its answers are traceable back to specific, current source documents.

**Data structures:**
* `Chunk` — `chunk_id`, `text`, `doc_id`, `embedding` (fixed-dimension vector)
* Per-tenant vector index — `chunk_id -> embedding`, plus `chunk_id -> (doc_id, text, article_metadata)` for retrieval-time lookup

**Trade-offs:**
* **The gotcha:** retrieval always returns *something* — the top-N most similar chunks exist by construction, even if none of them are actually relevant — and a model handed irrelevant context can still generate a fluent, confident-sounding answer grounded in the wrong material. This is why retrieval quality (not just generation quality) is a first-class, monitored property of this system, and it's the direct motivation for the escalation check below rather than trusting generation to self-report uncertainty.
* Chunk size interacts with this failure mode directly: chunks too large dilute a single embedding across multiple ideas (hurting retrieval precision), chunks too small lose surrounding context a reranker or the model needs to judge relevance — neither fixed-length nor semantic chunking escapes this tuning problem, they just trade off differently against preprocessing cost. See [Pinecone's chunking strategies guide](https://www.pinecone.io/learn/chunking-strategies/) for a practitioner treatment of this trade-off.

### Use case: Customer asks a question involving their own account and receives an answer grounded in their account data

Account data — an order's status, a subscription's renewal date, a specific charge — is exact, structured, and looked up directly by key, not retrieved by similarity search the way documentation is.

**Core spec: two separate, composable lookup steps per turn**

```
handle_turn(query, tenant_id, customer_id):
    needs_docs, needs_account = classify_query(query)
    doc_chunks = retrieve_and_rerank(query, tenant_id) if needs_docs else []
    account_fields = account_lookup(customer_id, query) if needs_account else {}
    return generate(query, doc_chunks, account_fields)
```

**Data structures:** `account_fields` — a small, exact key-value set (`order_status`, `renewal_date`, `last_charge_amount`) fetched by `customer_id`, never embedded or indexed.

**Trade-offs:**
* Treating "what's my order status" as a retrieval problem would be both slower and less precise than the direct lookup it actually is — a single customer turn can need both paths at once ("why hasn't my order shipped, and what's your shipping policy" needs the order record *and* the shipping-policy documentation).
* Account data carries this design's strictest access-control boundary: fields fetched are scoped exactly to the authenticated customer making the request, never cached or reused across different customers' conversations the way a documentation chunk safely can be.

### Use case: Service detects low-confidence answers and escalates to a human agent

Grounding a response in retrieved context reduces hallucination risk but doesn't eliminate the underlying judgment call: retrieval can return chunks that are topically related but don't actually answer the specific question asked.

**Core spec: confidence check on rerank scores, hard-cut on escalation**

```python
HUMAN_REQUEST_PHRASES = (
    "talk to a human", "speak to a person", "real agent",
    "human agent", "customer service rep", "talk to someone",
)


def requests_human(customer_message):
    """Explicit-ask detector: a simple substring check on a fixed phrase
    list. A production system would likely use a small classifier instead,
    but the contract — a boolean signal the escalation check consumes —
    is the same either way.
    """
    lowered = customer_message.lower()
    return any(phrase in lowered for phrase in HUMAN_REQUEST_PHRASES)


def _word_overlap_ratio(a, b):
    """Cheap token-overlap similarity (Jaccard over word sets) — good
    enough to flag near-identical rephrasing without needing an
    embedding call on this hot escalation-check path.
    """
    words_a, words_b = set(a.lower().split()), set(b.lower().split())
    if not words_a or not words_b:
        return 0.0
    return len(words_a & words_b) / len(words_a | words_b)


def is_repeated_question(customer_message, prior_messages, similarity_threshold=0.6):
    """Repetition detector: flags when the customer's current message is
    highly similar to one of their own recent messages in this
    conversation — a signal the bot's last answer didn't actually help.
    """
    for prior in prior_messages[-3:]:
        if _word_overlap_ratio(customer_message, prior) >= similarity_threshold:
            return True
    return False


def should_escalate(reranked_chunks, customer_message, prior_messages, min_rerank_score=0.55):
    """Escalate on any of: no chunk cleared the rerank confidence bar,
    an explicit request for a human, or the customer visibly repeating
    themselves (a signal the bot's prior answer didn't land).
    """
    if not reranked_chunks:
        return True, "no_grounding_found"
    top_score = reranked_chunks[0].rerank_score
    if top_score < min_rerank_score:
        return True, "low_confidence_grounding"
    if requests_human(customer_message):
        return True, "explicit_human_request"
    if is_repeated_question(customer_message, prior_messages):
        return True, "repeated_unanswered_question"
    return False, None
```

**Data structures:** `escalation` record — `conversation_id`, `reason`, `summary`, `retrieved_but_insufficient_chunks`, `account_id`, `escalated_at`.

**Trade-offs:**
* On escalation, the conversation is hard-cut away from generation entirely — the bot does not attempt a best-effort answer alongside the escalation.
* A summary of the conversation, plus relevant structured fields, is handed to the human agent — the same context-preservation problem [Handoff Orchestration](/docs/patterns/ai-agent-orchestration/handoff-orchestration) describes for agent-to-agent transfers, applied to a bot-to-human transfer: too little context forces the customer to re-explain their problem from scratch, which is exactly the frustrating outcome escalation exists to avoid, not reproduce.

### Use case: Support team updates documentation and the bot's answers reflect it within a bounded window

Step 1's freshness requirement (minutes to low single-digit hours) means the document index can't be rebuilt from scratch on a slow periodic schedule — updated, added, or removed articles are re-chunked, re-embedded, and written into the index incrementally as they change, following the same ingestion shape [RAG Pipeline](/docs/patterns/ai-infra/rag-pipeline) describes, applied continuously rather than as a one-time load.

**Data structures:** same per-tenant chunk index as above, updated in place per `chunk_id` rather than rebuilt wholesale.

**Trade-offs:**
* Step 1's math shows this re-indexing load is small relative to query-time retrieval traffic (roughly 0.19 chunks/sec average versus ~17.4 query turns/sec average), so incremental re-indexing is comfortably affordable to run continuously rather than needing a dedicated off-peak window.
* Embedding-model consistency is the failure mode this stage has to actively guard against: every chunk in the index, old and newly added, has to be embedded with the same model version, since mixing embedding-model versions silently degrades retrieval quality without producing an obvious error — only steadily worse answers.

### Use case: Customer carries on a multi-turn conversation with awareness of earlier turns

Follow-up questions frequently depend on what was already established earlier in the same conversation — "what about for the annual plan" only makes sense in light of a preceding question about a specific feature.

**Data structures:** per-conversation `retrieved_context_cache` — chunks and account fields already fetched earlier in the same conversation, so a later turn referencing "that policy you mentioned" is answerable from context already gathered, not a redundant re-retrieval.

**Trade-offs:**
* Each turn's retrieval query is formed from the current message in the context of recent conversation history, not the current message in isolation — otherwise retrieval searches for chunks relevant to an under-specified, ambiguous question. This mirrors this course's Conversational AI System case study's context-assembly step, scoped more narrowly here to conversation turns plus already-retrieved grounding material.

## Step 4: Scale the design

![LLM-Powered Customer Support Bot scaled architecture](/img/case-studies/llm-support-bot-scaled.svg)

* **Multi-tenancy is the design decision that shapes almost every other scaling choice in this system, more than raw request volume does.** Step 1's request rate (single-digit to low tens of conversations/sec at peak) is modest by this course's standards, but the knowledge base and index are partitioned per tenant, not pooled globally — a retrieval query for one tenant's customer must never surface another tenant's documentation, and a similarity search that scattered across a shared, unpartitioned index would risk exactly that. This is the same per-key isolation principle [Vector Database Sharding](/docs/patterns/ai-infra/vector-database-sharding) applies for pure capacity reasons, adopted here primarily for tenant isolation — most individual tenants' indexes are small enough (Step 1's ~1.2 GB combined-index figure, divided across many tenants) that any one tenant rarely needs sharding for size alone, but a large enterprise tenant's documentation set can approach that threshold on its own, at which point that tenant's shard specifically scales the way the general pattern describes.
* **A [Semantic Caching](/docs/patterns/ai-infra/semantic-caching) layer sits in front of the retrieval-and-generation path, tuned deliberately conservatively given this design's grounding requirements.** A large fraction of support questions are genuinely repetitive within a tenant — many customers asking a differently-worded version of "how do I reset my password" — making this a strong candidate for semantic caching's core value. But per-tenant isolation applies here too (a cached answer for one tenant's documentation must never be served to a different tenant's customer, even for a superficially similar question), and any query that triggered an account-data lookup is excluded from caching entirely, mirroring the transactional-query carve-out [Semantic Caching](/docs/patterns/ai-infra/semantic-caching)'s own documentation describes — an account-specific answer is never safe to serve to a different customer asking a similarly-worded question, regardless of how high the similarity score is.
* **Retrieval and generation scale independently, and retrieval is deliberately the cheaper, more horizontally-elastic tier of the two.** Per-tenant index search is comparatively inexpensive and scales with ordinary horizontal capacity the way [Vector Database Sharding](/docs/patterns/ai-infra/vector-database-sharding) describes, while model generation is the more expensive step — though at this design's modest overall request volume (Step 1's ~21 conversations/sec peak, an order of magnitude below this course's Conversational AI System case study's tens of thousands of messages/sec), the generation tier here is sized for steady, predictable capacity rather than the large, continuously-adjusted [GPU Auto-Scaling](/docs/patterns/ai-infra/gpu-auto-scaling) fleet that design needs — a smaller, more stable footprint is one of the direct consequences of this system's narrower scope.
* **Escalation has to fail safe under overload, not fail silent.** If the escalation queue or the human-agent-facing system it feeds is itself degraded or backed up, the correct behavior is never to fall back to generating a best-effort answer instead — that would silently reintroduce exactly the ungrounded-answer risk this design's escalation path exists to prevent. Instead, a customer whose conversation needs escalation during a queue backup sees an explicit "you'll be connected to a human, there's a wait" state rather than a bot-generated answer standing in for a human one; this is a deliberate, and deliberately unusual, choice to let one part of the system degrade to a visibly slower state rather than silently substitute a worse guarantee, similar in spirit to how this course's Payment System case study refuses to let a correctness-critical step degrade gracefully into a faster but weaker one.

## Additional talking points

* **Why this design's hard problem is grounding-plus-escalation, not conversational scale.** Compared to this course's Conversational AI System case study, this design serves a far smaller request volume and a much narrower, bounded set of topics per tenant — the engineering difficulty here isn't absorbing huge concurrent load, it's making sure every answer is actually supported by current, correct source material and reliably recognizing the point past which generating any answer at all is the wrong choice. Those are close to opposite emphases despite both systems sending a prompt to a model and returning a response.
* **Escalation as a design goal, not a fallback to be minimized.** It's tempting to treat a high escalation rate as a system quality failure to engineer away, but Step 1 deliberately expects roughly 12% of conversations to escalate — a support bot that never escalates is far more likely to be one that answers confidently past the edge of what its knowledge base actually supports than one that's genuinely comprehensive, and this design explicitly optimizes for correctly recognizing that boundary rather than for driving the escalation rate toward zero.
* **The tenant-isolation requirement touches nearly every layer, not just storage.** It's not enough to partition the vector index per tenant — the semantic cache, the account-data lookup, and even conversation logging all need the same isolation boundary enforced consistently, since a single layer that pools data across tenants "just this once" (a shared cache being the easiest one to get wrong) reintroduces the exact cross-tenant leakage risk the rest of the design works to prevent.
* **Auditability as a first-class requirement, not an operational nice-to-have.** Because a support team needs to be able to review exactly what the bot told a customer and which documentation grounded that answer, every conversation logs not just the final response but the specific retrieved chunks (and their relevance scores) that were used to generate it — this is what makes it possible to later distinguish a genuinely well-grounded wrong answer (the documentation itself was wrong or outdated) from a retrieval failure (the right documentation existed but wasn't surfaced) from a generation failure (the right context was retrieved but the model didn't use it faithfully), three different root causes that would otherwise be indistinguishable after the fact.
* **Chunking strategy is a decision worth revisiting per document type, not a single global setting.** A structured FAQ article with clear headings is a strong candidate for semantic chunking (its own boundaries are cheap to detect and genuinely meaningful); a long, loosely-structured troubleshooting guide is often better served by fixed-length-with-overlap, since detecting "natural" boundaries in unstructured prose is itself an error-prone preprocessing step. Treating chunking as a single fixed pipeline setting rather than a per-document-type decision is a common, easy-to-miss source of retrieval quality that varies unexplainably across a tenant's knowledge base.

## Source(s) and further reading

* [Retrieval-augmented generation — Wikipedia](https://en.wikipedia.org/wiki/Retrieval-augmented_generation) — background on the RAG shape this design's core loop implements
* [Pinecone: Chunking Strategies for LLM Applications](https://www.pinecone.io/learn/chunking-strategies/) — a practitioner treatment of fixed-length vs. semantic chunking and their trade-offs
* [LangChain: Text splitters](https://python.langchain.com/docs/concepts/text_splitters/) — real, widely-used implementations of fixed-length, overlap, and semantic-boundary chunking
* [RAG Pipeline](/docs/patterns/ai-infra/rag-pipeline) — this course's own pattern page on the chunk/embed/retrieve/re-rank shape
* [Handoff Orchestration](/docs/patterns/ai-agent-orchestration/handoff-orchestration) — the context-preservation shape this design's escalation path reuses for bot-to-human transfer
* [Semantic Caching](/docs/patterns/ai-infra/semantic-caching) — the caching layer this design's Step 4 applies with a per-tenant and account-query carve-out
