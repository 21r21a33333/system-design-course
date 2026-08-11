---
title: "Busy Front End"
sidebar_position: 2
supplementary: true
---

The busy front end antipattern is running resource-intensive work —
image resizing, PDF generation, large-payload transformation, anything
CPU- or I/O-heavy — directly on the thread that's handling an incoming
request, instead of handing it off to a background worker. The request
thread stays occupied for the full duration of the task instead of
being freed to serve the next request the moment the client's actual
need (an acknowledgment, a result reference) is satisfied.

![Busy Front End diagram](/img/patterns/busy-front-end.svg)

## How it manifests

The most visible symptom is response latency that tracks work size
rather than request volume: a request that triggers a 30-second video
transcode takes 30 seconds to return, tying up a request-handling
thread (or an entire worker process, in a threading model without true
concurrency) for that whole window. Under load, this compounds fast —
if the server has a fixed-size thread or worker pool, a handful of
concurrent expensive requests can exhaust the pool entirely, and every
other request, including cheap ones that would normally return in
milliseconds, queues up behind them waiting for a thread to free up.
From the outside this looks like the whole service has gone down, even
though the actual bottleneck is a small number of expensive requests
hogging a shared, finite resource.

A closely related shape is a front-end process that does its own
heavy computation inline — resizing an uploaded image before storing
it, generating a PDF report on request, running a full-text
export — where the work is triggered synchronously by a user action and
the user's browser or client sits there waiting for the entire pipeline
to finish before getting any response at all. Timeouts become a
constant operational headache: load balancers and reverse proxies have
their own request timeout defaults (often 30-60 seconds), and any
front-end task that takes longer than that gets killed mid-flight,
often after having already done most of the expensive work, wasting it
entirely and forcing a retry that repeats the same cost.

Thread pool and worker metrics tell the story clearly once you know to
look: pool utilization spikes correlate with the presence of a handful
of "big" requests in the mix, not with overall request count, and
queue depth for incoming requests grows even though total throughput
(requests per second) is well within what the hardware should handle.
CPU usage on the front-end tier often shows sustained, non-bursty high
utilization from a small number of long-running requests, rather than
the bursty pattern typical of many short requests being served quickly.

## Why it happens

Handling a task inline is simply the first thing that works: the
feature "resize this image on upload" is easiest to build as a function
call in the upload request handler, and in development — one image,
one request, no concurrent load — it's indistinguishable from doing the
work asynchronously; the response is a little slower, nobody notices.
The asynchronous alternative requires real infrastructure a team may
not have set up yet — a job queue, a worker pool, a way for the client
to check on or be notified of task completion — and that's a
meaningfully bigger lift than a function call, so it gets deferred
until the synchronous version visibly breaks under real traffic.

It also tends to arrive incrementally: a feature that used to be
genuinely cheap (thumbnail generation for small images) grows over time
to handle larger inputs, more formats, more post-processing steps,
each increment individually reasonable, until the cumulative cost per
request is no longer something a request thread should be doing at
all. And in a low-traffic period, the antipattern is invisible by
definition — there's no queueing when concurrent expensive requests
never actually overlap — so it isn't caught until traffic grows enough
that they start to.

## Code example (the antipattern)

```rust
// A request handler that does expensive processing inline, holding
// the calling thread for the entire duration. Under concurrent load
// this exhausts whatever fixed thread/worker pool serves requests.
struct UploadRequest {
    file_bytes: Vec<u8>,
}

struct UploadResponse {
    thumbnail_url: String,
}

fn resize_image(bytes: &[u8]) -> Vec<u8> {
    // Stand-in for a CPU-heavy image transform that takes real time —
    // easily hundreds of milliseconds to seconds for large images.
    bytes.to_vec()
}

fn store_thumbnail(_bytes: &[u8]) -> String {
    "https://cdn.example.com/thumb/123.jpg".to_string()
}

// The request-handling thread blocks here until resizing and storage
// both finish, before the caller gets any response at all.
fn handle_upload(req: UploadRequest) -> UploadResponse {
    let resized = resize_image(&req.file_bytes);
    let url = store_thumbnail(&resized);
    UploadResponse { thumbnail_url: url }
}
```

## The fix

```rust
// The request handler now only enqueues the work and returns
// immediately with a reference the client can poll or be notified
// against — the actual resize runs on a separate background worker,
// off the request-handling thread entirely.
struct UploadRequest {
    file_bytes: Vec<u8>,
}

struct AcceptedResponse {
    job_id: u64,
    status_url: String,
}

trait JobQueue {
    fn enqueue_resize(&self, file_bytes: Vec<u8>) -> u64;
}

struct InMemoryQueue {
    next_id: std::cell::Cell<u64>,
}

impl JobQueue for InMemoryQueue {
    fn enqueue_resize(&self, _file_bytes: Vec<u8>) -> u64 {
        let id = self.next_id.get();
        self.next_id.set(id + 1);
        id // handed off to a worker process that isn't the request thread
    }
}

// Returns as soon as the job is enqueued — no image processing has
// happened on this thread, so it's free to serve the next request.
fn handle_upload(queue: &dyn JobQueue, req: UploadRequest) -> AcceptedResponse {
    let job_id = queue.enqueue_resize(req.file_bytes);
    AcceptedResponse {
        job_id,
        status_url: format!("/jobs/{job_id}"),
    }
}
```

The fix separates "accept the work" from "do the work": the handler's
job becomes validating the request and durably enqueuing it, which is
fast and cheap regardless of how expensive the actual processing is,
and a separate pool of background workers — sized and scaled
independently of the request-handling tier — consumes the queue at its
own pace. The client gets an immediate acknowledgment and a way to
check on or be notified of completion, instead of a blocked connection.
This is exactly the shape Ruby on Rails' Active Job and Sidekiq, or
Laravel's queue system, exist to make a first-class convention rather
than something each team wires up ad hoc — "enqueue a job, let a
worker process pull it" is a named, supported path in those
frameworks specifically because inline processing on the request
thread is such a common early mistake.

## How to detect it

Request latency that correlates with payload size or task complexity
rather than staying flat across request types is the clearest
application-level signal. Thread pool or worker utilization metrics
that spike specifically when a handful of "heavy" requests are present
in the mix — rather than tracking overall request volume — point
directly at a shared, finite resource being monopolized by a few
expensive operations. Load balancer and reverse proxy logs showing a
cluster of request timeouts around a fixed duration (matching the
proxy's own timeout setting) rather than a spread of durations often
indicates synchronous work that's regularly getting killed mid-flight.
APM traces that show a single request span dominated by one long,
uninterrupted block of CPU-bound or I/O-bound work — rather than a
sequence of short calls — is the trace-level equivalent of the same
symptom.

## When it's actually fine

Genuinely fast, low-variance work — validating a form field, hashing a
short string, applying a small transform to a small payload — is fine
to do inline; the antipattern is specifically about work whose duration
or resource cost can grow large or unpredictable, not all synchronous
processing categorically. It's also fine, even necessary, when the
client's entire reason for calling is to get the fully computed result
back in that same response and there's no meaningful "acknowledge now,
deliver later" alternative the product actually wants — a real-time
calculation the UI needs before it can render anything useful doesn't
benefit from being made asynchronous, it just adds a polling loop. And
for a low-traffic internal tool where concurrent expensive requests are
rare enough that thread pool exhaustion is not a realistic risk, the
operational simplicity of skipping a job queue can be the right call.

## Related patterns

- [Queue-Based Load Leveling](/docs/patterns/batch-streaming/queue-based-load-leveling) —
  the corrective shape for this antipattern: a queue sits between the
  request-handling tier and the workers that do the actual expensive
  processing, letting each scale and pace independently.
- [Asynchronous Request-Reply](/docs/patterns/communication/asynchronous-request-reply) —
  the client-facing contract that pairs with offloading work to a
  queue: acknowledge immediately, hand back a status-check reference,
  and let the client poll or be notified once the background work
  completes.

## Further reading

- [Busy Front End antipattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/antipatterns/busy-front-end/)
- [Thread pool — Wikipedia](https://en.wikipedia.org/wiki/Thread_pool)
- [Active Job Basics — Ruby on Rails Guides](https://guides.rubyonrails.org/active_job_basics.html) — a mainstream web framework's built-in convention for moving work off the request thread onto a background worker.
- [System Design roadmap — roadmap.sh](https://roadmap.sh/system-design) — includes Busy Front End as a named antipattern topic.
