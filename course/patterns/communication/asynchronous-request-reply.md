---
title: "Asynchronous Request-Reply"
sidebar_position: 8
supplementary: true
---

Asynchronous Request-Reply decouples a client's request from the
backend work it triggers: instead of the client's connection blocking
until processing finishes, the server immediately acknowledges the
request and hands back a status-check URL, and the client polls (or is
called back) for the actual result once it's ready.

![Asynchronous Request-Reply diagram](/img/patterns/asynchronous-request-reply.svg)

## Problem it solves

HTTP clients, load balancers, and gateways all assume a request gets a
response within some bounded time — often 30 to 60 seconds by default
— and hold a connection or thread open the entire time waiting. Some
backend work genuinely can't finish that fast: generating a large
report, transcoding video, running a batch import, or invoking a slow
downstream system. Holding a synchronous HTTP connection open for
minutes wastes a connection slot and a thread on both ends for no
reason, risks the client or an intermediate proxy timing out and
declaring failure even though the work is still progressing correctly,
and gives the client no way to know how far along the work is. The
client needs *some* response quickly — it just can't be the final
result yet.

## How it works

The client sends its request as usual, but the server does the
minimum work needed to validate and enqueue it, then immediately
returns a `202 Accepted` response containing a status-check URL (and
often an estimated retry-after interval) rather than the result
itself. The actual processing happens out of band — typically handed
off to a background worker via a queue. The client then either polls
the status-check URL periodically until it returns the completed
result (commonly signaled by a `200 OK` with the payload, replacing
the `202`), or, if the server supports it, registers a callback URL
and receives the result pushed to it via a webhook once processing
finishes, avoiding polling entirely. Either way, the client's initial
connection is held open only for the brief accept-and-enqueue step,
not for the full duration of the work.

## Code example

The snippet below shows the shape of the two endpoints involved: one
that accepts work and returns a status URL, and one that reports
progress or the final result.

```rust
enum JobStatus {
    Pending,
    Running,
    Complete { result: String },
    Failed { error: String },
}

struct AcceptedResponse {
    status_url: String,
    retry_after_secs: u32,
}

trait JobQueue {
    fn enqueue(&self, payload: String) -> String; // returns job_id
    fn status(&self, job_id: &str) -> JobStatus;
}

// Client-facing endpoint: enqueue the work and return immediately.
fn submit(queue: &dyn JobQueue, payload: String) -> AcceptedResponse {
    let job_id = queue.enqueue(payload);
    AcceptedResponse {
        status_url: format!("/jobs/{job_id}/status"),
        retry_after_secs: 5,
    }
}

// Client-facing endpoint: report whatever state the job is in right now.
fn check_status(queue: &dyn JobQueue, job_id: &str) -> JobStatus {
    queue.status(job_id) // safe to call repeatedly — read-only
}
```

`submit` returns as soon as the job is enqueued, not when it
completes; `check_status` is designed to be called repeatedly and
cheaply, since the client (or a callback dispatcher) will call it
again on `Pending` or `Running` until it sees `Complete` or `Failed`.

## When to use it

- Backend processing genuinely can't complete within a normal HTTP
  request timeout — the work takes seconds to minutes (or longer), not
  milliseconds.
- The client needs an immediate, reliable acknowledgment that the
  request was accepted, even though the result isn't ready yet.
- The infrastructure between client and server (load balancers,
  gateways, browser timeouts) can't be relied on to hold a single
  connection open for the full processing duration.

## When not to use it

- The work reliably completes within normal request-timeout bounds — a
  plain synchronous response is simpler and gives the client the
  result in one round trip, with nothing to poll.
- The client has no reasonable way to poll or receive a callback (e.g.
  a fire-and-forget script with no persistent identity) — a queue-based
  background job with no client-facing status endpoint may fit better.
- Polling the status-check URL isn't safe to repeat — see
  [Idempotency](/docs/patterns/reliability/idempotency); a status
  check that isn't safely retryable defeats the purpose of a pattern
  built around the client checking back repeatedly.

## Real-world example

Cloud provider APIs that trigger long-running operations — creating a
large database instance, running a big data export, or provisioning
infrastructure — commonly return a `202 Accepted` with an
operation-status URL that the client (or CLI tool) polls until the
operation reports done or failed, exactly matching this pattern.

## Related patterns

- [Webhooks](/docs/patterns/communication/webhooks) — the callback
  alternative to polling the status-check URL: instead of the client
  asking repeatedly, the server pushes the result once it's ready.
- [Idempotency](/docs/patterns/reliability/idempotency) — what makes
  it safe for the client to retry the status check (or the original
  submission) without risk of double-processing.

## Further reading

- [Asynchronous Request-Reply pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/async-request-reply)
- [List of HTTP status codes — Wikipedia](https://en.wikipedia.org/wiki/List_of_HTTP_status_codes)
