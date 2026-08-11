---
title: "GPU Auto-Scaling"
sidebar_position: 3
supplementary: true
---

GPU auto-scaling is auto-scaling applied specifically to GPU-backed
inference or training workloads, adjusting the number of provisioned
GPU instances to match demand under constraints that don't apply to
ordinary CPU auto-scaling.

![GPU Auto-Scaling diagram](/img/patterns/gpu-auto-scaling.svg)

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

## Technical architecture & implementation

**Signals.** A GPU autoscaler watches metrics a CPU-tier autoscaler
doesn't need: GPU compute utilization, GPU memory (VRAM) usage, and the
queue depth of inference requests waiting for a free execution slot.
These have to be watched independently because a GPU can be saturated
on either axis without the other showing it — a model with a large KV
cache or large batch size can run out of VRAM while compute utilization
still reads moderate, and a policy that only watches compute percentage
(the CPU-tier default) misses that entirely and lets requests queue or
fail with out-of-memory errors while the dashboard looks healthy.
Queue depth is the most direct proxy for user-facing impact: a rising
queue means requests are waiting longer than the model's own inference
time accounts for, regardless of what the utilization numbers say.

**Warm-pool sizing and the scale-out decision.** Because provisioning a
new GPU instance — allocating the hardware, pulling a multi-gigabyte
container image, loading model weights onto the device — commonly takes
low single-digit minutes, a policy that scales reactively from zero
(the CPU-tier default) leaves the first wave of requests during any
traffic increase stalled for that entire window. GPU autoscaling
instead keeps a **warm minimum pool** sized to absorb baseline traffic
and ordinary short-lived fluctuation without any provisioning delay,
and reserves the slow scale-out path for *sustained* increases —
typically requiring load to stay elevated across several consecutive
evaluation windows before triggering a new instance, which avoids
provisioning (and paying for) capacity for a spike that would have
subsided before the new instance finished booting anyway. This is the
inverse of the CPU-tier default, where scaling to zero and reacting
fast is usually correct because provisioning is nearly free.

**Scale-in and scale-to-zero.** Scaling in is also handled more
cautiously than on the CPU tier: an instance is typically drained
(stopped from accepting new requests, allowed to finish in-flight ones)
before being terminated, rather than killed immediately, since
terminating mid-inference discards a partially completed (and
potentially expensive) generation. True scale-to-zero — no instances
running at all — is reserved for workloads that can absorb a
multi-minute cold start with no user-facing consequence, such as
asynchronous batch scoring or scheduled training jobs; it's generally
avoided for interactive inference, where the warm minimum exists
specifically to prevent that cold-start window from ever being on the
user-facing critical path.

**Failure modes.** The two failure modes mirror the two signals that
matter most. Under-provisioning the warm pool relative to baseline load
causes queue depth to creep up continuously rather than spike — a
subtler failure than an outright outage, since latency degrades
gradually and may not trip a simple threshold alert until it's already
affected many requests. The second is scaling on the wrong signal
entirely: a policy tuned only to compute utilization can leave a
memory-saturated fleet under-scaled, since the metric it's watching
never crosses its threshold even as requests start failing with
out-of-memory errors or getting queued indefinitely.

**GPU auto-scaling vs. ordinary auto-scaling.** The general
[Auto-Scaling](/docs/patterns/scaling/auto-scaling) pattern assumes
provisioning is fast and cheap enough that reactive, scale-to-zero-friendly
policies are the default correct choice. GPU auto-scaling is best
understood as the same mechanism — watch a signal, add or remove
capacity — applied under the opposite cost and latency assumptions,
which is why nearly every specific policy choice (warm minimums instead
of scale-to-zero, sustained-load gating instead of reactive spikes,
memory and queue depth instead of CPU percentage) flips relative to the
general pattern's usual defaults.

## Code example

```rust
use std::sync::mpsc;
use std::thread;

#[derive(Clone, Copy, Debug)]
struct GpuMetrics {
    queue_depth: u32,
    vram_used_pct: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum ScaleDecision {
    HoldAtWarmMinimum,
    ScaleOut(u32),
}

struct AutoscalePolicy {
    warm_minimum: u32,
    queue_per_instance_threshold: u32,
    vram_threshold_pct: f32,
}

impl AutoscalePolicy {
    // A GPU can be saturated on either axis independently: compute-bound
    // (queue climbs) or memory-bound (VRAM climbs while queue looks
    // fine). Checking both axes on separate threads and combining the
    // results is what catches the memory-bound case a single-metric
    // policy would miss.
    fn decide(&self, current_instances: u32, metrics: GpuMetrics) -> ScaleDecision {
        let (tx, rx) = mpsc::channel();

        let queue_threshold = self.queue_per_instance_threshold;
        let queue_tx = tx.clone();
        let queue_check = thread::spawn(move || {
            let saturated = metrics.queue_depth > queue_threshold * current_instances;
            queue_tx.send(("queue", saturated)).expect("channel open");
        });

        let vram_threshold = self.vram_threshold_pct;
        let vram_check = thread::spawn(move || {
            let saturated = metrics.vram_used_pct > vram_threshold;
            tx.send(("vram", saturated)).expect("channel open");
        });

        queue_check.join().expect("queue check thread panicked");
        vram_check.join().expect("vram check thread panicked");

        let saturated = rx.try_iter().take(2).any(|(_, is_saturated)| is_saturated);

        match (saturated, current_instances) {
            (true, n) if n < self.warm_minimum * 4 => ScaleDecision::ScaleOut(1),
            _ => ScaleDecision::HoldAtWarmMinimum,
        }
    }
}
```

`decide` runs the queue-depth check and the VRAM check on separate
threads and joins both before combining results — the two signals are
independent axes of saturation, and either one alone triggering
scale-out is what catches a memory-bound workload that a
compute-utilization-only policy would miss.

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

## Use-case scenarios

**Real-time image-generation service.** A consumer app lets users
generate images from text prompts and expects results within a few
seconds. The service keeps a warm minimum pool sized to daily baseline
traffic, with queue depth as the primary scale-out signal; because
model weights are large and loading them onto a fresh GPU takes real
time, scale-to-zero is avoided entirely for this endpoint even during
overnight low-traffic hours, since the next morning's traffic ramp
would otherwise stall on cold starts.

**Overnight LLM fine-tuning jobs at a data-science team.** An internal
platform runs scheduled fine-tuning jobs across dozens of GPU instances
each night, with no fixed schedule for which teams submit jobs on a
given night. Because these jobs are asynchronous and nobody is waiting
on an interactive response, the pool scales genuinely to zero between
runs and tolerates a multi-minute provisioning delay when a job is
submitted — the cost savings from not running idle GPU capacity all day
outweigh the one-time startup delay on a job that already runs for
hours.

**Speech-to-text transcription API with bursty enterprise traffic.** A
transcription API serves large enterprise customers whose usage spikes
sharply around business hours in their respective time zones, with
predictable multi-hour ramps rather than instant traffic cliffs. The
autoscaler is tuned to trigger scale-out on sustained queue growth over
several consecutive minutes rather than the first uptick, avoiding
provisioning a new instance for a short-lived burst that would resolve
on its own before the new capacity finished booting — while still
comfortably outpacing the multi-hour ramp of an actual regional
business-hours surge.

## Production libraries & getting started

Nobody hand-rolls GPU autoscaling loops in production; the building
blocks are a Kubernetes autoscaler driven by queue or GPU-utilization
metrics, a device plugin that exposes GPUs to the cluster, and a
node-provisioner that adds GPU machines on demand.

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| KEDA | Kubernetes | Event-driven pod autoscaling on external metrics like queue depth or Prometheus GPU signals | [Prometheus scaler](https://keda.sh/docs/latest/scalers/prometheus/) |
| NVIDIA GPU Operator | Kubernetes | Automates driver, device-plugin, and DCGM metric deployment so GPUs are schedulable | [Getting started](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/getting-started.html) |
| Ray autoscaler | Python | Scales a Ray cluster's worker nodes (incl. GPU nodes) to match pending tasks/actors | [Configuring autoscaling](https://docs.ray.io/en/latest/cluster/vms/user-guides/configuring-autoscaling.html) |
| Karpenter | Kubernetes | Just-in-time node provisioning that adds GPU instances when pods are unschedulable | [Getting started](https://karpenter.sh/docs/getting-started/) |
| KServe | Kubernetes | Serverless inference with request-driven autoscaling (incl. scale-to-zero) | [Autoscaling docs](https://kserve.github.io/website/latest/modelserving/autoscaling/autoscaling/) |

**Example / reference:** [KEDA Prometheus scaler](https://keda.sh/docs/latest/scalers/prometheus/)

## Related patterns

- [Auto-Scaling](/docs/patterns/scaling/auto-scaling) — the general CPU-oriented
  pattern that GPU auto-scaling adapts for expensive, slow-to-provision
  hardware.

## Further reading

- [Automatic scaling of Amazon SageMaker AI models](https://docs.aws.amazon.com/sagemaker/latest/dg/endpoint-auto-scaling.html)
- [KEDA — event-driven and queue-depth-based autoscaling for Kubernetes](https://keda.sh/docs/latest/concepts/scaling-deployments/)
- [Kubernetes Horizontal Pod Autoscaler (custom and external metrics)](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)
- [NVIDIA — GPU metrics with DCGM Exporter](https://docs.nvidia.com/datacenter/cloud-native/gpu-telemetry/latest/dcgm-exporter.html)
