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

## Technical architecture & implementation

**The accept-and-enqueue handshake.** The client sends its request as
usual, but the server does only the minimum work needed to validate it
and hand it off — persisting the request and pushing a job onto a
[distributed message queue](/docs/patterns/building-blocks/distributed-message-queue)
or task table — then immediately returns `202 Accepted`. Two things
travel back in that response: a **status/monitor URL** (typically in a
`Location` header, e.g. `Location: /operations/abc123`) that the client
will consult to learn the outcome, and usually a **`Retry-After`
header** telling the client roughly how long to wait before the first
poll. The initial connection is held open only for this brief step,
not for the full duration of the work, which is precisely what keeps
the client, load balancers, and gateways from tripping their
request-timeout budgets.

**Out-of-band processing and the status resource.** Behind the queue,
a pool of background workers pulls jobs and processes them,
transitioning a durable job record through states —
`pending → running → complete | failed`. The status URL is a
read-only *resource* projecting that record: while the job is in
flight it returns `200 OK` with a body like `{"status":"running"}`
(or, in some designs, keeps returning `202`), and on completion it
either returns the result inline or redirects (`303 See Other`) to a
separate result URL where the finished artifact lives. Separating the
*status* resource from the *result* resource keeps polling cheap — the
client hits a tiny status endpoint repeatedly and fetches the
(possibly large) result exactly once.

**Correlation and idempotency of the submit.** Every job needs a
stable identifier that ties the original submission to its status
resource and its eventual result — a **correlation ID**, either the
opaque job ID the server mints or a client-supplied idempotency key.
The key protects the *submit* step specifically: because the client
got only a `202` and could have lost the connection before reading it,
it may safely retry the submission, and the server must recognize a
repeated idempotency key and return the *existing* job rather than
enqueuing a duplicate. See
[Idempotency](/docs/patterns/reliability/idempotency) for the
dedupe-on-write mechanics this relies on.

**Failure modes.** The pattern introduces states a synchronous call
never has. A job can **fail** after acceptance — the status resource
must be able to report `failed` with a reason, not just leave the
client polling forever. A client can **abandon** a job (crash, give
up), so completed results need a retention/TTL policy or they
accumulate indefinitely. A status resource can be **polled too
aggressively**, so `Retry-After` and server-side rate limiting matter.
And the result can be **produced but never observed** if the client
dies before its final poll — which is exactly the gap a callback or
push completion (below) closes.

**How it differs from siblings.** Against a plain **synchronous
request-reply**, the difference is that the final result is delivered
on a *later, separate* exchange rather than the same connection —
trading one round trip for resilience to long or unpredictable
processing times. Against **pub-sub**, the difference is that this is
still a *request addressed to one caller expecting one answer*: there
is a specific correlation ID and a specific result the originating
client is waiting for, whereas pub-sub fans an event out to any number
of uninterested-in-replying subscribers. Asynchronous request-reply is
best understood as request-reply with the reply deferred, not as
event broadcasting.

## Completion: polling vs callback vs push

The three ways a client learns its result is ready trade client
simplicity against latency and infrastructure requirements.

| Mechanism | How the result arrives | Best when | Cost |
| --- | --- | --- | --- |
| **Polling** | Client re-requests the status URL on an interval until it flips to complete | Client can't accept inbound connections (CLIs, browsers behind NAT); simplest to build | Wasted requests; result latency bounded by poll interval |
| **Callback (webhook)** | Server `POST`s the result to a client-supplied URL when done | Client is itself a reachable service; near-instant delivery wanted | Client must expose and secure an endpoint; needs retry + [dead-letter](/docs/patterns/reliability/dead-letter-queue) handling |
| **Push (SSE / WebSocket)** | Client holds an open channel and the server streams the completion event | Client is a browser/app already connected and wants live progress | A persistent connection to maintain; reconnection logic |

Polling is the safe default because it needs nothing of the client but
the ability to make outbound HTTP calls. A
[webhook](/docs/patterns/communication/webhooks) callback eliminates
polling entirely but shifts the reliability burden onto the server
(delivery is now the server's job, with its own retries and
dead-lettering) and requires the client to be an addressable,
secured endpoint. A push channel over
[Server-Sent Events](/docs/patterns/communication/server-sent-events)
or [WebSockets](/docs/patterns/communication/websockets) suits a
client that is *already* connected and wants incremental progress, not
just a final ping. Many real systems offer more than one: a webhook
for the happy path plus a status URL to poll as a fallback when a
webhook delivery is missed.

## Code example

The snippet below shows the shape of the two endpoints involved: one
that accepts work and returns a status URL, and one that reports
progress or the final result.

```rust
use std::collections::HashMap;

enum JobStatus {
    Pending,
    Running,
    Complete { result: String },
    Failed { error: String },
}

struct AcceptedResponse {
    job_id: String,
    status_url: String,
    retry_after_secs: u32,
}

trait JobQueue {
    fn enqueue(&self, payload: String) -> String; // returns a fresh job_id
    fn status(&self, job_id: &str) -> JobStatus;
}

// Client-facing endpoint: validate, enqueue, return 202 immediately.
// The idempotency key makes the submit safely retryable: a repeated key
// returns the SAME job instead of enqueuing a duplicate, because the
// client may have retried after losing the 202 it never got to read.
fn submit(
    queue: &dyn JobQueue,
    seen: &mut HashMap<String, String>, // idempotency_key -> job_id
    idempotency_key: String,
    payload: String,
) -> AcceptedResponse {
    let job_id = match seen.get(&idempotency_key) {
        Some(existing) => existing.clone(),
        None => {
            let id = queue.enqueue(payload);
            seen.insert(idempotency_key, id.clone());
            id
        }
    };
    AcceptedResponse {
        status_url: format!("/jobs/{job_id}/status"),
        job_id,
        retry_after_secs: 5,
    }
}

// Client-facing endpoint: report whatever state the job is in right now.
// Read-only and safe to call repeatedly — that is the whole contract.
fn check_status(queue: &dyn JobQueue, job_id: &str) -> JobStatus {
    queue.status(job_id)
}
```

`submit` returns as soon as the job is enqueued, not when it
completes, and deduplicates on the idempotency key so a retried
submission maps to the original job rather than spawning a second one.
`check_status` is designed to be called repeatedly and cheaply, since
the client (or a callback dispatcher) will call it again on `Pending`
or `Running` until it sees `Complete` or `Failed`.

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

## Use-case scenarios

**Cloud control-plane operations.** Provisioning a large managed
database, running a big data export, or spinning up infrastructure
can't finish inside an API request. Cloud provider APIs return
`202 Accepted` with a long-running-operation resource; the CLI or SDK
polls that operation URL (honoring `Retry-After`) until it reports
`done` or `error`, then fetches the created resource. The correlation
ID is the operation name, and the submit is idempotent on a
client-supplied request token so a retried create doesn't provision
two clusters.

**Document and media processing.** A user uploads a video for
transcoding or a PDF for OCR. The API accepts the job, returns a
status URL, and hands the work to a queue backed by a worker pool. A
browser SPA shows a progress bar by polling — or, if the app is
already holding a live channel, by receiving push updates over
[Server-Sent Events](/docs/patterns/communication/server-sent-events).
On completion the status resource redirects to the finished artifact
in a [blob store](/docs/patterns/building-blocks/blob-store).

**Partner-integration report generation.** A B2B API lets partners
request a large analytics report that takes minutes to compile. The
partner is itself a reachable service, so instead of polling it
registers a [webhook](/docs/patterns/communication/webhooks) callback;
when the report is ready the server `POST`s a completion event with a
download link, retrying and dead-lettering failed deliveries. The
status URL remains available as a fallback for partners that miss a
webhook.

## Production libraries & getting started

The accept-and-poll shape is usually backed by a job/queue engine that runs
the out-of-band work and exposes job state to poll, plus HTTP `202`+polling
conventions on the API surface. For long-running, multi-step operations a
durable workflow engine replaces hand-rolled state machines.

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| BullMQ | JS/TS (Redis) | Job queue with durable state, retries, and progress you can expose as a pollable status | [Docs](https://docs.bullmq.io/) |
| Celery | Python | Distributed task queue where each task has an id + result backend to poll for status | [First steps](https://docs.celeryq.dev/en/stable/getting-started/first-steps-with-celery.html) |
| asynq | Go (Redis) | Simple, reliable background job queue with task state inspection | [GitHub](https://github.com/hibiken/asynq) |
| Faktory | Any (language-agnostic worker protocol) | Background-job server your workers pull from, tracking job lifecycle | [GitHub](https://github.com/contribsys/faktory) |
| Temporal | Go, Java, TS, Python, .NET | Durable execution for long-running operations — the workflow itself is the queryable status resource | [Getting started](https://learn.temporal.io/getting_started/) |

**Example / reference:** HTTP `202`+polling conventions —
[Azure async request-reply](https://learn.microsoft.com/en-us/azure/architecture/patterns/async-request-reply)
and [Google AIP-151 long-running operations](https://google.aip.dev/151).

## Related patterns

- [Webhooks](/docs/patterns/communication/webhooks) — the callback
  alternative to polling the status-check URL: instead of the client
  asking repeatedly, the server pushes the result once it's ready.
- [Server-Sent Events](/docs/patterns/communication/server-sent-events)
  and [WebSockets](/docs/patterns/communication/websockets) — push
  channels a client can hold open to receive completion and progress
  events live, rather than polling.
- [Idempotency](/docs/patterns/reliability/idempotency) — what makes
  it safe for the client to retry the status check (or the original
  submission) without risk of double-processing.
- [Distributed Message Queue](/docs/patterns/building-blocks/distributed-message-queue) —
  the durable buffer that carries accepted jobs to the background
  workers processing them out of band.
- [Dead-Letter Queue](/docs/patterns/reliability/dead-letter-queue) —
  where a webhook callback (or the job itself) lands when it repeatedly
  fails, so a stuck result isn't silently lost.

## Further reading

- [Asynchronous Request-Reply pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/async-request-reply)
- [202 Accepted — MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/202)
- [Retry-After header — MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Retry-After)
- [Google AIP-151: Long-running operations](https://google.aip.dev/151)
- [List of HTTP status codes — Wikipedia](https://en.wikipedia.org/wiki/List_of_HTTP_status_codes)
