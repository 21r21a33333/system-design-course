---
title: "GPU Auto-Scaling"
sidebar_position: 3
supplementary: true
---

GPU auto-scaling is auto-scaling applied specifically to GPU-backed
inference or training workloads, adjusting the number of provisioned
GPU instances to match demand under constraints that don't apply to
ordinary CPU auto-scaling.

## Problem it solves

Standard auto-scaling assumes compute is cheap, fast to provision, and
safe to scale to zero when idle. GPU capacity breaks all three
assumptions. GPU instances cost substantially more per hour than
equivalent CPU instances, so over-provisioning is expensive in a way
that compounds quickly at fleet scale. They're also slower to
provision: acquiring a GPU instance, pulling a multi-gigabyte container
image, and loading model weights onto the device can take minutes,
versus seconds for a stateless CPU web server. A naive auto-scaling
policy built for CPU workloads — scale to zero when idle, scale up
reactively on the first burst of traffic — leaves GPU-backed requests
stalled for minutes waiting for cold-start capacity.

## How it works

GPU auto-scaling policies weigh the cost of idle GPU capacity against
the cost of cold-start latency, and usually land on a different
tradeoff than CPU auto-scaling: keep a warm minimum pool of GPU
instances always running — sized to absorb baseline traffic and normal
fluctuations — and only trigger slow, predictive scale-out for sustained
load increases, rather than reactively scaling on every short spike.
Scaling to zero is used more sparingly, and typically only for
workloads that can tolerate multi-minute cold starts (asynchronous
batch or training jobs) rather than interactive inference. Scaling
signals also differ: GPU utilization, GPU memory usage, and queue depth
of pending inference requests are more informative triggers than the
CPU-percentage metric a typical web-tier auto-scaler watches, since a
GPU can be memory-saturated while its compute utilization looks
moderate.

## When to use it

- Serving latency-sensitive inference requests where a multi-minute
  cold start is unacceptable, but demand still fluctuates enough that a
  fixed fleet is wasteful.
- Training workloads with bursty, schedulable demand (e.g. nightly
  retraining jobs) where the scale-up latency is tolerable because the
  work isn't interactive.
- Cost pressure justifies actively right-sizing an expensive GPU fleet
  rather than statically over-provisioning for peak.

## When not to use it

- Traffic is steady and predictable enough that a fixed-size GPU pool
  is simpler to operate and the auto-scaling machinery adds complexity
  without real savings.
- Workloads that genuinely can scale to zero with no user-facing
  latency impact (pure batch jobs on a schedule) may not need the warm
  minimum pool tradeoff at all — plain scale-to-zero is fine there.

## Real-world example

Managed ML platforms such as Amazon SageMaker AI support auto-scaling
policies for GPU-backed inference endpoints, including the option to
scale an endpoint down to zero instances for workloads that can absorb
the resulting cold start, alongside standard warm-pool scaling policies
for latency-sensitive endpoints.

## Related patterns

- [Auto-Scaling](/docs/patterns/scaling/auto-scaling) — the general CPU-oriented
  pattern that GPU auto-scaling adapts for expensive, slow-to-provision
  hardware.

## Further reading

- [Automatic scaling of Amazon SageMaker AI models](https://docs.aws.amazon.com/sagemaker/latest/dg/endpoint-auto-scaling.html)
