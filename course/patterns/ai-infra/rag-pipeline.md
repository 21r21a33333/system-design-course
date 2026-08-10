---
title: "RAG Pipeline"
sidebar_position: 7
supplementary: true
---

Retrieval-Augmented Generation (RAG) retrieves relevant documents via
vector similarity search and injects them into an LLM's prompt as
context, so the model answers using retrieved, current information
instead of relying solely on what was baked into it during training.

## Problem it solves

A trained LLM's knowledge is frozen at training time and general
purpose — it has no access to an organization's private documents, and
it can't reflect anything that changed after training finished.
Fine-tuning the model on new or proprietary data is expensive, slow to
iterate on, and still has to be redone every time the underlying data
changes. RAG sidesteps both problems: instead of teaching the model new
facts by retraining it, relevant facts are retrieved at query time from
an external, independently updatable data source and handed to the
model as context in the prompt itself. Updating the data means
updating the retrieval index, not retraining anything.

## How it works

A RAG pipeline has several distinct stages. Source documents are
**chunked** into smaller passages, since embedding and retrieving whole
long documents loses precision and wastes context-window space on
irrelevant sections. Each chunk is converted into a vector via an
**embedding** model and stored in a vector index. At query time, the
user's query is embedded the same way, and a similarity search against
the index performs **retrieval**, returning the chunks most relevant to
the query. Because a fast approximate similarity search over many
chunks may pull in some marginally relevant results, a **re-ranking**
step often follows: a smaller, more precise (and more expensive) model
re-scores the retrieved candidates and keeps only the strongest
matches. Finally, **prompt assembly** combines the original query with
the selected chunks into a single prompt sent to the LLM, which
generates its answer grounded in that injected context rather than
purely from its training data.

## When to use it

- Answers need to reflect information that's private, proprietary, or
  changes more often than retraining a model is practical.
- Reducing hallucination matters, and grounding responses in
  retrieved source text (which can also be cited back to the user) is
  valuable.
- The knowledge base is large enough that it can't fit directly in a
  single prompt's context window, so relevant pieces must be selected
  rather than included wholesale.

## When not to use it

- The required knowledge is small enough to fit directly in the
  prompt every time — retrieval adds pipeline complexity with no
  benefit if there's nothing to filter down from.
- The task depends on general reasoning or creativity rather than
  specific factual recall, where retrieved context adds little.
- Extremely low latency is required and the added retrieval and
  re-ranking round-trips before the LLM call even starts aren't
  acceptable for the use case.

## Real-world example

RAG is a standard architecture for building question-answering and
document-search assistants over an organization's internal knowledge
base or documentation, letting a general-purpose LLM answer questions
about content it was never trained on. Cloud ML platforms document
reference architectures for this pattern combining a managed vector
search service with a hosted LLM endpoint.

## Related patterns

- [Vector Database Sharding](/docs/patterns/ai-infra/vector-database-sharding) —
  the retrieval stage's similarity search is exactly the workload that
  vector database sharding scales past single-node capacity.
- [Semantic Caching](/docs/patterns/ai-infra/semantic-caching) — can sit in
  front of a RAG pipeline's final LLM call to avoid re-running
  retrieval and generation for semantically repeated queries.

## Further reading

- [Retrieval-augmented generation — Wikipedia](https://en.wikipedia.org/wiki/Retrieval-augmented_generation)
- [Vector database — Wikipedia](https://en.wikipedia.org/wiki/Vector_database)
