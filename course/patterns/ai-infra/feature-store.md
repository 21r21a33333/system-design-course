---
title: "Feature Store"
sidebar_position: 1
supplementary: true
---

A feature store is a centralized system for storing, versioning, and
serving the input features used by machine learning models, so that the
exact same feature logic is used at both training time and inference
time.

## Problem it solves

ML teams typically compute features — derived signals like "average
order value over the last 30 days" — twice: once in a batch pipeline
over historical data to produce training sets, and once in an online
service to produce predictions in real time. When those two
implementations are written independently (often in different
languages, by different teams, on different schedules), they drift
apart. This is training/serving skew: the model was trained on a
slightly different definition of a feature than the one it sees in
production, which silently degrades prediction quality in ways that are
hard to detect because nothing crashes — the model just gets quietly
worse.

## How it works

A feature store separates feature *definition* from feature *storage*.
Feature transformation logic is defined once and registered centrally.
The store then maintains two synchronized views of the same features:
an offline store (typically a data warehouse or object store) holding
large historical volumes for training and batch scoring, and an online
store (typically a low-latency key-value store) holding only the
current value of each feature per entity, for real-time inference
lookups. A single ingestion pipeline populates both from the same
transformation code, so training data and serving data are guaranteed
to be computed the same way. Models at inference time fetch the latest
feature values with a single low-latency lookup keyed by entity ID
(e.g. user ID) instead of recomputing features on the request path.

## When to use it

- Multiple models or teams reuse the same underlying features (e.g.
  "user's 7-day click rate" used by several recommendation models).
- Predictions must be served with millisecond latency, but the features
  themselves require expensive aggregation over historical data.
- Training/serving skew has been an observed or suspected source of
  model quality regressions.

## When not to use it

- A single model with a small, stable set of features computed
  identically in one place — the operational overhead of running a
  separate store isn't justified.
- Batch-only scoring with no real-time inference requirement; a
  standard data warehouse table is simpler.
- Early-stage experimentation where feature definitions are still
  changing rapidly — the versioning and synchronization overhead slows
  iteration before it earns its keep.

## Real-world example

Uber's Michelangelo platform introduced one of the earliest
widely-discussed production feature stores to solve exactly this
training/serving consistency problem across hundreds of internal
models. Feast is a widely used open-source feature store that
implements the same offline/online split and is commonly deployed on
top of a cloud data warehouse and a managed key-value store. Managed
equivalents, such as Amazon SageMaker Feature Store, provide the same
online/offline pattern as a hosted service.

## Related patterns

- [Model Serving](/docs/patterns/ai-infra/model-serving) — the online
  store's low-latency lookups exist specifically to feed the serving
  layer's prediction requests.

## Further reading

- [Feature engineering — Wikipedia](https://en.wikipedia.org/wiki/Feature_engineering)
- [Create, store, and share features with Amazon SageMaker Feature Store](https://docs.aws.amazon.com/sagemaker/latest/dg/feature-store.html)
