---
title: "Feature Store"
sidebar_position: 1
supplementary: true
---

A feature store is a centralized system for storing, versioning, and
serving the input features used by machine learning models, so that the
exact same feature logic is used at both training time and inference
time.

![Feature Store diagram](/img/patterns/feature-store.svg)

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

## Technical architecture & implementation

**Write path.** A feature store separates feature *definition* from
feature *storage*. Feature transformation logic — the code that turns
raw events into a named, versioned feature — is defined once and
registered centrally, not copied into a training script and a serving
service independently. A single ingestion pipeline runs that
transformation and writes the result to two places as part of the same
operation: an **offline store** (typically a data warehouse or object
store, optimized for large sequential scans) holding the full history
of computed values for training and batch scoring, and an **online
store** (typically a low-latency key-value store, optimized for point
lookups) holding only the current value of each feature per entity. The
offline write is stamped with an `as_of` timestamp; the online write
overwrites the previous value. Because both come from the same
transformation call, the two stores cannot define a feature
differently — the only way skew reappears is if a second, independent
write path bypasses the shared pipeline, which is why feature stores
enforce transformation logic as the single registered entry point
rather than a convention.

**Read path — online.** An inference request supplies an entity ID
(e.g. a user ID) and the serving layer performs a single key-value
lookup per feature, or a batched multi-get across several features for
the same entity, against the online store. This has to complete in low
single-digit milliseconds because it sits on the critical path of a
live prediction request — the online store is deliberately *not* the
place where any aggregation or transformation happens at read time; all
of that work already happened during ingestion, so the read is a pure
lookup.

**Read path — offline, and point-in-time correctness.** Building a
training set is a fundamentally different query: for each historical
label (e.g. "did this user churn in the 30 days after March 1st"), the
training pipeline needs the feature values *as they were* at that past
instant, not the feature's current value. Fetching the current value
for a historical row would leak information from the future into the
label — a model trained that way looks artificially accurate offline
and then underperforms in production, since production inference never
has future information available. Correct feature stores solve this
with **point-in-time joins**: the offline store retains a timestamped
history per entity, and a training-set query joins each label row
against the feature value whose timestamp was the latest one at or
before that label's timestamp, not the latest value overall.

**Failure modes.** Two failure modes dominate in practice. First,
**online/offline store divergence** — if the online store's write
fails after the offline write succeeds (or a downstream cache in front
of the online store isn't invalidated), inference reads a stale value
while the offline history shows the update happened, silently
reintroducing skew despite having a shared pipeline. Second, **online
store staleness from ingestion lag** — if the pipeline batches updates
(e.g. hourly) rather than streaming them, a feature like "orders in the
last 5 minutes" is systematically wrong at serving time by up to the
batch interval, which is a correctness bug specific to features whose
true value changes faster than the ingestion cadence.

**Feature store vs. model serving.** These two AI-infra patterns are
adjacent stages of the same request and are easy to conflate: a feature
store answers "what are this entity's current input values," while
[Model Serving](/docs/patterns/ai-infra/model-serving) answers "given a
complete set of inputs, what does the model predict." An inference
request typically calls the feature store first to assemble its input
vector, then hands that vector to the model-serving layer — the feature
store never runs a model, and the model server never independently
computes a feature's value.

## Code example

```rust
use std::collections::HashMap;

// A single transformation, shared by both the batch (offline) path and
// the online write path — this is the mechanism that prevents
// training/serving skew: there is exactly one place feature logic lives.
fn compute_avg_order_value(orders: &[f64]) -> f64 {
    if orders.is_empty() {
        return 0.0;
    }
    orders.iter().sum::<f64>() / orders.len() as f64
}

#[derive(Clone, Debug, PartialEq)]
struct FeatureValue {
    value: f64,
    // Lets a training job reconstruct exactly what the online store
    // would have returned at any past instant — point-in-time
    // correctness for the offline store.
    as_of: u64,
}

struct FeatureStore {
    offline_history: HashMap<String, Vec<FeatureValue>>,
    online_latest: HashMap<String, FeatureValue>,
}

impl FeatureStore {
    // Single ingestion path: both stores are updated from the same
    // computed value, so they can never define the feature differently.
    fn ingest(&mut self, entity_id: &str, orders: &[f64], as_of: u64) {
        let fv = FeatureValue { value: compute_avg_order_value(orders), as_of };
        self.offline_history.entry(entity_id.to_string()).or_insert_with(Vec::new).push(fv.clone());
        self.online_latest.insert(entity_id.to_string(), fv);
    }

    // Online path: single-key lookup, used on the inference request path.
    fn get_online(&self, entity_id: &str) -> Option<&FeatureValue> {
        self.online_latest.get(entity_id)
    }

    // Offline path: point-in-time lookup — the latest value that existed
    // at or before `as_of`, never a value computed after it.
    fn get_offline_as_of(&self, entity_id: &str, as_of: u64) -> Option<&FeatureValue> {
        self.offline_history.get(entity_id)?.iter().filter(|v| v.as_of <= as_of).max_by_key(|v| v.as_of)
    }
}
```

`get_offline_as_of` filters out any value stamped after the requested
`as_of`, which is what prevents a training row from being joined
against a feature value that didn't exist yet at the time the row's
label was observed.

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

## Use-case scenarios

**Ride-hailing ETA and pricing models.** A ride-hailing platform
predicts trip duration and surge pricing using features like a driver's
recent acceptance rate, a zone's demand over the last 15 minutes, and a
rider's historical trip patterns. Dozens of models across ETA
prediction, pricing, and driver-matching consume overlapping subsets of
these same features; a shared feature store computes each one once and
serves it to every model that needs it, instead of each model team
independently re-deriving "zone demand" with slightly different
windowing logic that would otherwise produce inconsistent predictions
across services shown on the same screen.

**Fraud-detection scoring at a payments processor.** A card-transaction
fraud model needs features like "transaction count for this card in the
last 10 minutes" computed with millisecond latency during checkout,
while the same feature's full history is needed offline to retrain the
model weekly on months of labeled fraud/not-fraud outcomes. The online
store answers the real-time check; the offline store's point-in-time
history lets the retraining pipeline correctly join each historical
transaction against the count that existed *before* that transaction
occurred, avoiding label leakage from including the transaction being
scored in its own feature count.

**Streaming-service recommendation ranking.** A video-streaming
platform ranks catalog items per user using features such as "genre
affinity score" and "average session length this week," recomputed
continuously as viewing behavior changes throughout the day. Because
the ranking model is retrained nightly on the offline history while
live ranking requests hit the online store, a feature store keeps both
in step — without it, the nightly-retrained model's understanding of
"genre affinity" would silently disagree with what the online store
returns for the same user during the following day's live requests.

## Related patterns

- [Model Serving](/docs/patterns/ai-infra/model-serving) — the online
  store's low-latency lookups exist specifically to feed the serving
  layer's prediction requests.

## Further reading

- [Feature engineering — Wikipedia](https://en.wikipedia.org/wiki/Feature_engineering)
- [Create, store, and share features with Amazon SageMaker Feature Store](https://docs.aws.amazon.com/sagemaker/latest/dg/feature-store.html)
- [Feast — feature store concepts (online/offline stores)](https://docs.feast.dev/getting-started/concepts)
- [Tecton — point-in-time correctness and time-travel joins](https://docs.tecton.ai/docs/beta/introduction/framework-concepts)
