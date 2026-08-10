---
title: "Model Serving"
sidebar_position: 2
supplementary: true
---

Model serving is the infrastructure layer that loads a trained machine
learning model into memory and exposes it as a low-latency prediction
API, handling concurrent request batching, model versioning, and
gradual rollout of new versions.

## Problem it solves

A trained model artifact by itself is just a file of weights — it
can't answer a request. Turning it into something an application can
call requires solving problems that have nothing to do with the model
itself: loading potentially gigabytes of weights onto the right
hardware, accepting many concurrent requests without serializing them
one at a time, keeping several model versions available simultaneously
during a rollout, and doing all of this with latency low enough for an
interactive request. Building this by hand for every model is
repetitive, error-prone infrastructure work that a dedicated serving
layer exists to standardize.

## How it works

A model server loads one or more model versions and exposes a
prediction endpoint (commonly gRPC or HTTP/REST). Incoming requests are
grouped into micro-batches within a short time window — this is
critical for GPU-backed models, since GPUs achieve far better
throughput running one batch of 32 inputs than 32 sequential single
inputs, and batching amortizes that fixed per-call overhead across many
requests at the cost of a small added queuing delay. The server keeps
model versions in a registry with metadata (framework, input/output
schema, version tag) and can serve multiple versions side by side,
routing a configurable percentage of traffic to each — the mechanism
that underlies canary rollout of a new model version, where a small
slice of production traffic is shifted to the new version and its
prediction quality or error rate is monitored before the rollout
proceeds further.

## When to use it

- A trained model needs to answer live application requests with
  interactive latency (as opposed to a nightly batch scoring job).
- Multiple model versions must coexist, whether for A/B testing,
  canary rollout, or gradual migration.
- Request volume is high enough that request batching materially
  improves GPU or CPU utilization.

## When not to use it

- Predictions are only ever needed in bulk, on a schedule — a batch
  scoring job reading from and writing to a data warehouse is simpler
  and doesn't need to run a standing service.
- The model is tiny and inference is cheap enough to run directly
  inside the calling application process, avoiding a network hop
  entirely.

## Real-world example

TensorFlow Serving and NVIDIA's Triton Inference Server are widely used
open-source model servers that implement request batching, multi-model
hosting, and versioned model repositories along these lines. Managed
equivalents, such as Amazon SageMaker's real-time inference endpoints,
provide the same capabilities — batching, versioning, and traffic-split
rollout — as a hosted service.

## Related patterns

- [Feature Store](/docs/patterns/ai-infra/feature-store) — typically
  supplies the online feature values a serving request needs before it
  can call the model.
- [Canary Deployment](/docs/patterns/observability/canary-deployment) —
  the general rollout technique that model serving applies to shifting
  traffic between model versions.

## Further reading

- [Deploy models for inference — Amazon SageMaker AI](https://docs.aws.amazon.com/sagemaker/latest/dg/deploy-model.html)
- [Feature engineering — Wikipedia](https://en.wikipedia.org/wiki/Feature_engineering)
