---
title: "Model Serving"
sidebar_position: 2
supplementary: true
---

Model serving is the infrastructure layer that loads a trained machine
learning model into memory and exposes it as a low-latency prediction
API, handling concurrent request batching, model versioning, and
gradual rollout of new versions.

![Model Serving diagram](/img/patterns/model-serving.svg)

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

## Technical architecture & implementation

**Request handling and micro-batching.** A model server loads one or
more model versions into memory and exposes a prediction endpoint
(commonly gRPC or HTTP/REST). Rather than running each incoming request
through the model individually, requests are collected into
micro-batches within a short time window — bounded by whichever comes
first, a maximum batch size or a maximum wait time — and the whole
batch is submitted to the model in a single call. This matters because
GPU throughput on a batch of 32 inputs run together is far higher than
32 sequential single-input calls: the fixed per-call overhead of moving
data onto the device and invoking the model is paid once per batch
instead of once per request. The cost is a small added queuing delay —
the first request in a batch waits for the batch to fill or the timer
to expire before it's actually processed — which is the batching
window's central latency/throughput tradeoff: a longer window improves
throughput and wastes more of each early request's latency budget; a
shorter window does the opposite.

**Version registry and traffic splitting.** The server keeps model
versions in a registry with metadata — framework, input/output schema,
version tag — and can hold several versions loaded simultaneously,
routing a configurable percentage of traffic to each. This is the
mechanism that underlies canary rollout of a new model version: a small
slice of production traffic (say 5%) is shifted to the new version
while the rest continues to the previous stable version, and the new
version's prediction quality or error rate is monitored before the
split is shifted further. Because both versions are loaded and serving
concurrently, rolling back a bad version is just shifting the traffic
split back to zero — no redeploy or reload is needed, which is what
makes this materially safer than an all-at-once version swap.

**Failure modes.** The most direct failure mode is a **batch-timeout
mismatch**: if the batching window's maximum wait is set close to or
above the caller's own request timeout, a request can be waiting inside
an unfilled batch when the caller gives up, wasting the eventual
inference work and, worse, the server has no way to know the caller
already stopped waiting unless it separately tracks per-request
deadlines. A second failure mode is a bad or malformed input inside a
batch: naive batch implementations that don't isolate per-request
errors can fail the whole batch — and every request batched with it —
because of one malformed input, which silently punishes unrelated
callers for someone else's bad request. A third is version-registry
staleness: if the registry's traffic-split configuration and the
actually-loaded model versions can drift apart (a version marked
receiving traffic that failed to load, or was evicted for memory
pressure), requests get routed to a version that silently isn't ready,
which needs an explicit readiness check per version rather than trusting
the registry's configuration alone.

**Quantization and GPU utilization.** Batching raises throughput by
amortizing per-call overhead, but it doesn't reduce the per-request work
itself — the other major lever a serving layer pulls is **quantization**,
storing and computing model weights (and often activations) at lower
numeric precision than the FP32/FP16 they were trained in. Serving an
8-bit or 4-bit quantized copy of a model shrinks its memory footprint
roughly in proportion to the bit-width reduction, which lets more of the
model (or a larger KV cache, or a bigger batch) fit in the same VRAM, and
lower-precision arithmetic is faster on hardware with dedicated
low-precision units. The cost is a usually-small accuracy regression that
has to be measured against the specific model and task rather than
assumed negligible. Quantization and batching are complementary: a
smaller quantized model frees VRAM that a serving layer can spend on a
larger micro-batch, pushing GPU utilization higher on both axes at once.
The relevant health signal here is the same one
[GPU Auto-Scaling](/docs/patterns/ai-infra/gpu-auto-scaling) watches —
sustained GPU utilization and VRAM headroom decide whether a batch-plus-
quantization configuration is actually saturating the hardware it's
paying for, or leaving it idle.

**Model serving vs. feature store.** [Feature Store](/docs/patterns/ai-infra/feature-store)
answers a different question in the same request path: what are this
entity's current input values, versus model serving's what does the
model predict given a complete input. A serving request typically calls
the feature store first to assemble the input vector the model needs,
then hands that vector to the model server — the two layers are
sequential stages, not alternatives, and neither one substitutes for
the other's job.

## Code example

```rust
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

struct InferenceRequest {
    id: u32,
    input: f32,
}

struct InferenceResult {
    id: u32,
    output: f32,
}

// Simulates running a full batch through the model in one call — the
// per-call overhead is fixed regardless of batch size, which is exactly
// why batching improves throughput on GPU-backed models.
fn run_batch_on_model(batch: &[InferenceRequest]) -> Vec<InferenceResult> {
    batch.iter().map(|r| InferenceResult { id: r.id, output: r.input * 2.0 }).collect()
}

struct MicroBatcher {
    max_batch_size: usize,
    max_wait: Duration,
}

impl MicroBatcher {
    // Runs on its own thread: drains requests arriving on `incoming`
    // until either `max_batch_size` is reached or `max_wait` elapses
    // with no new arrival, whichever comes first, then dispatches that
    // batch and continues.
    fn spawn(self, incoming: mpsc::Receiver<InferenceRequest>) -> thread::JoinHandle<Vec<InferenceResult>> {
        thread::spawn(move || {
            let mut all_results = Vec::new();
            let mut batch = Vec::new();
            loop {
                match incoming.recv_timeout(self.max_wait) {
                    Ok(request) => {
                        batch.push(request);
                        if batch.len() >= self.max_batch_size {
                            all_results.extend(run_batch_on_model(&batch));
                            batch.clear();
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if !batch.is_empty() {
                            all_results.extend(run_batch_on_model(&batch));
                            batch.clear();
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        if !batch.is_empty() {
                            all_results.extend(run_batch_on_model(&batch));
                        }
                        break;
                    }
                }
            }
            all_results
        })
    }
}
```

The batcher runs on its own thread so it can block on `recv_timeout`
without stalling the caller — a batch is flushed either when it fills
up or when the wait timer expires with the batch non-empty, which is
what bounds the added queuing delay for the first request sitting in a
slow-to-fill batch.

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

## Use-case scenarios

**Credit-risk scoring model behind a loan-application flow.** A bank
serves a credit-risk model that scores loan applications in real time
as part of an interactive application flow. Because a wrong or delayed
score directly blocks a customer-facing decision, the serving layer
runs two versions concurrently during any model update — the current
production version handling the bulk of traffic and a challenger
version scored against a small sample — so a regression in default-rate
prediction accuracy is caught on a small fraction of applications
before it's ever shipped to all of them.

**Product-recommendation ranking at high request volume.** An
e-commerce homepage calls a ranking model on every page load across
millions of daily visitors, where each individual request's compute
cost matters at that volume. The serving layer batches concurrent
ranking requests within a short window (tens of milliseconds) before
running them through the model together, substantially improving GPU
utilization compared to scoring each visitor's request independently,
at a latency cost small enough to be imperceptible on a page load.

**Multi-tenant document-classification API.** A SaaS platform offers
document classification as an API used by many customers with
different volume profiles, all served by the same underlying model
infrastructure. The serving layer hosts a single loaded model version
behind a shared endpoint and relies on batching and concurrent request
handling — rather than per-customer dedicated infrastructure — to serve
all tenants cost-effectively, with the version registry allowing a
model update to be validated on internal traffic before being promoted
to serve every tenant's requests.

## Related patterns

- [Feature Store](/docs/patterns/ai-infra/feature-store) — typically
  supplies the online feature values a serving request needs before it
  can call the model.
- [Canary Deployment](/docs/patterns/observability/canary-deployment) —
  the general rollout technique that model serving applies to shifting
  traffic between model versions.
- [GPU Auto-Scaling](/docs/patterns/ai-infra/gpu-auto-scaling) — sizes the
  GPU fleet the serving layer runs on, watching the same utilization and
  VRAM signals that batching and quantization move.

## Further reading

- [Deploy models for inference — Amazon SageMaker AI](https://docs.aws.amazon.com/sagemaker/latest/dg/deploy-model.html)
- [KServe — model serving on Kubernetes](https://kserve.github.io/website/latest/)
- [Ray Serve — request batching for online inference](https://docs.ray.io/en/latest/serve/advanced-guides/dyn-req-batch.html)
- [NVIDIA Triton Inference Server — dynamic batching](https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/user_guide/model_configuration.html)
- [vLLM — quantization support](https://docs.vllm.ai/en/latest/features/quantization/index.html)
