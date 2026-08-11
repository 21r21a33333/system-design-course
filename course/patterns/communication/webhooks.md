---
title: "Webhooks"
sidebar_position: 3
supplementary: true
---

A webhook is a server-to-server HTTP callback — a "reverse API": instead
of a consumer repeatedly calling a provider's API to check for changes,
the consumer registers a URL ahead of time and the provider sends it an
HTTP POST the moment a relevant event occurs.

![Webhooks diagram](/img/patterns/webhooks.svg)

## Problem it solves

Without webhooks, a consumer that wants to know about a change in another
system has to poll it — "has anything happened yet?" — which wastes a
request every interval when nothing has, adds latency equal to the poll
interval when something has, and scales badly when many consumers poll the
same provider. Webhooks invert the direction of the call: the provider
pushes the event the instant it happens, so the consumer does work only
when there is actually something to do, and learns of it immediately. This
is the same push-versus-pull win that
[Server-Sent Events](/docs/patterns/communication/server-sent-events)
give a browser — but between two *servers*, often across organizational
and network boundaries, over ordinary HTTP.

## Technical architecture & implementation

**Registration and subscription.** The consumer registers a callback URL
with the provider — through a dashboard or an API — usually selecting
which event types it cares about and receiving a shared signing secret in
return. From then on the provider maintains that subscription and delivers
matching events to the URL. This registration step is what lets webhooks
cross a boundary a message broker can't easily span: the two parties may
be different companies with no shared infrastructure, connected only by
the public internet and HTTP.

**Delivery is at-least-once — so consumers must be idempotent.** The
callback is a plain HTTP POST over a network that drops, times out, and
duplicates. A provider that doesn't get a timely success response *retries*,
typically with exponential backoff over a bounded window (see
[Retry with Backoff](/docs/patterns/reliability/retry-with-backoff)),
which means the same event can arrive more than once — a `200 OK` that got
lost on the way back triggers a redelivery even though the consumer
already processed it. The consumer must therefore treat delivery as
**at-least-once** and dedupe on the provider's event id, applying each
event's effect only once. This is the [Idempotency](/docs/patterns/reliability/idempotency)
pattern applied at the webhook boundary, and skipping it is the classic
webhook bug: a payment credited twice, an email sent twice.

**Ordering is not guaranteed.** Retries and parallel delivery mean events
can arrive out of the order they occurred — a `subscription.updated` may
land before the `subscription.created` it logically follows. Consumers
that care about order must reconcile using timestamps or sequence fields
in the payload, or re-fetch current state from the provider's API rather
than trusting arrival order.

**Respond fast, process async.** The provider is waiting on the POST and
will consider a slow response a failure and retry it. The consumer should
therefore do the minimum synchronously — verify the signature, enqueue the
event, return `200` — and do the real work asynchronously off a queue.
Trying to fully process an event inside the request handler couples the
provider's retry behavior to the consumer's processing time and invites
duplicate deliveries under load; a
[Queue-Based Load Leveling](/docs/patterns/batch-streaming/queue-based-load-leveling)
buffer in front of processing is the standard shape.

**Failed deliveries and dead-lettering.** After a provider exhausts its
retry window, the event is dropped or parked; mature providers expose a
delivery log the consumer can inspect and replay from. On the consumer
side, events that repeatedly fail processing belong in a
[Dead Letter Queue](/docs/patterns/reliability/dead-letter-queue) rather
than blocking the pipeline. Because delivery can silently fail,
critical flows often pair webhooks with a periodic reconciliation poll as
a backstop — belt and suspenders.

**Verifying authenticity.** The callback URL is reachable by anyone who
learns it, so a naked webhook endpoint will accept forged events. Providers
sign each delivery: they compute an HMAC over the raw request body
concatenated with a timestamp, using the shared secret, and send it in a
header (Stripe's `Stripe-Signature`, for example). The consumer recomputes
the HMAC over the *exact bytes received* and compares. Two disciplines make
this sound. First, the comparison must be **constant-time**, so an attacker
can't recover the correct signature byte-by-byte by measuring how long a
rejection takes. Second, the signature must cover a **timestamp**, and the
consumer must reject deliveries whose timestamp is outside a tolerance
window — otherwise a captured valid request could be *replayed* verbatim
later. Signing the body alone stops forgery but not replay; signing the
timestamp with it stops both.

**How webhooks differ from polling and pub-sub.** Against **polling an
API**, webhooks eliminate the wasted checks and the poll-interval latency —
the provider tells you the instant something changes. Against internal
**[pub-sub](/docs/patterns/communication/pub-sub)**, webhooks are the
mechanism that extends the same publish/deliver idea *across* a network or
organizational boundary over HTTP: pub-sub assumes both sides share a
broker, whereas a webhook needs nothing but a URL and the public internet,
at the cost of the reliability and security concerns above that a broker
would otherwise handle for you.

## Code example

The security-critical core of a webhook receiver is signature
verification with a constant-time compare and a freshness check. This
signs a payload the way a provider would and verifies it the way a
consumer must — binding the timestamp into the signed message so replays
are refused. (A production signer swaps the placeholder digest for a real
HMAC-SHA256; the verification *structure* around it is the lesson.)

```rust
use std::time::{SystemTime, UNIX_EPOCH};

/// A minimal HMAC-SHA-ish signer would use a real crypto library in production.
/// To keep this std-only and focused on the *protocol* mechanics — timestamped
/// signing, constant-time comparison, freshness — we model the MAC as an opaque
/// keyed digest. Swap `keyed_digest` for HMAC-SHA256 in real code; the
/// surrounding verification logic is what matters and is unchanged.
fn keyed_digest(secret: &[u8], message: &[u8]) -> [u8; 32] {
    // FNV-1a-based keyed mixing over (secret || message), folded into 32 bytes.
    // NOT cryptographic — a placeholder for HMAC-SHA256 so the example is
    // self-contained. The verification structure around it is the real lesson.
    let mut out = [0u8; 32];
    for (i, slot) in out.iter_mut().enumerate() {
        let mut h: u64 = 0xcbf29ce484222325 ^ (i as u64).wrapping_mul(0x100000001b3);
        for b in secret.iter().chain(message.iter()) {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        *slot = (h >> ((i % 8) * 8)) as u8;
    }
    out
}

/// The signed message binds the timestamp to the body so a captured request
/// can't be replayed later with a fresh timestamp — the timestamp is inside
/// what the MAC covers.
fn signed_payload(timestamp: u64, body: &[u8]) -> Vec<u8> {
    let mut m = timestamp.to_string().into_bytes();
    m.push(b'.');
    m.extend_from_slice(body);
    m
}

/// Producer side: sign the body at the current time and emit the header value
/// a consumer will verify, e.g. `t=1699999999,v1=<hex>`.
pub fn sign(secret: &[u8], body: &[u8], timestamp: u64) -> String {
    let mac = keyed_digest(secret, &signed_payload(timestamp, body));
    let hex: String = mac.iter().map(|b| format!("{:02x}", b)).collect();
    format!("t={},v1={}", timestamp, hex)
}

/// Compare two byte slices in time independent of how many leading bytes match,
/// so an attacker can't learn the correct signature byte-by-byte via timing.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn parse_header(header: &str) -> Option<(u64, String)> {
    let mut ts = None;
    let mut sig = None;
    for part in header.split(',') {
        match part.split_once('=') {
            Some(("t", v)) => ts = v.parse::<u64>().ok(),
            Some(("v1", v)) => sig = Some(v.to_string()),
            _ => {}
        }
    }
    Some((ts?, sig?))
}

/// Consumer side: recompute the signature over the *raw* received body, compare
/// in constant time, and reject anything older than the tolerance window so a
/// replayed capture is refused even if its signature is otherwise valid.
pub fn verify(secret: &[u8], body: &[u8], header: &str, now: u64, tolerance_secs: u64) -> bool {
    let (timestamp, provided) = match parse_header(header) {
        Some(v) => v,
        None => return false,
    };
    if now.saturating_sub(timestamp) > tolerance_secs {
        return false; // stale — outside the replay window
    }
    let expected = keyed_digest(secret, &signed_payload(timestamp, body));
    let expected_hex: String = expected.iter().map(|b| format!("{:02x}", b)).collect();
    constant_time_eq(expected_hex.as_bytes(), provided.as_bytes())
}

pub fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}
```

Exercised directly, a signature produced by `sign` verifies within the
tolerance window, but the same signature is rejected once `now` moves past
the window (replay), when a single byte of the body is altered (forgery),
and when a different secret is used — the three failure modes signature
verification exists to catch.

## When to use it

- The consumer wants near-real-time notification of events in a
  third-party or otherwise external system it doesn't control.
- The event volume and consumer count don't justify standing up a shared
  message broker between two organizations.
- The consumer can expose a public, reachable HTTPS endpoint and is
  willing to verify signatures and dedupe deliveries.

## When not to use it

- The consumer is behind a firewall or NAT with no reachable public
  endpoint — polling, or a broker with a client-initiated subscription,
  is more practical.
- Strict ordering or exactly-once delivery is required and the consumer
  can't be made idempotent — webhook delivery is at-least-once and
  unordered by nature.
- Event volume to a single consumer is very high and bursty, where a
  persistent stream or a queue the consumer drains at its own pace scales
  more predictably than inbound HTTP bursts it can't backpressure.

## Use-case scenarios

**Payment events.** A payment processor POSTs a signed `payment.succeeded`
event to a merchant's registered URL. The merchant verifies the signature,
enqueues the event, returns `200` immediately, and fulfills the order off
the queue — deduping on the event id so a retried delivery doesn't ship
the product twice.

**CI/CD triggers.** A source-control host fires a webhook on every push or
pull request; a CI system receives it, verifies it came from the host, and
kicks off a build. Because delivery is at-least-once, the CI system keys
builds on the commit SHA so a duplicate delivery doesn't launch two
identical pipelines.

**SaaS integrations and automation.** A CRM or helpdesk emits webhooks on
record changes so downstream tools stay in sync without polling; an
automation platform exposes generic webhook URLs that let any provider
trigger a workflow. Both lean on signature verification to trust the
sender and on idempotency keys to survive retries.

## Production libraries & getting started

Rather than hand-rolling signing, retries, and a delivery log, most teams adopt a webhook toolkit or the Standard Webhooks spec; on the consumer side, use the provider's own signature-verification helpers.

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| Svix | JS/TS, Rust, Go, Python | Webhooks-as-a-service: signing, retries with backoff, delivery logs, and verification SDKs in every language | [Svix docs](https://docs.svix.com/) |
| svix-webhooks (SDKs) | JS/TS, Rust, Go, Python | Open-source signature verification and sending libraries backing Svix | [svix-webhooks on GitHub](https://github.com/svix/svix-webhooks) |
| Standard Webhooks | Spec | An open specification for consistent, secure webhook payloads and signatures across providers | [standardwebhooks.com](https://www.standardwebhooks.com/) |

**Reference — verifying signatures:** [Svix payload verification](https://docs.svix.com/receiving/verifying-payloads/how) · [Stripe webhook signatures](https://docs.stripe.com/webhooks/signatures) · [GitHub webhook delivery validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)

## Related patterns

- [Publish-Subscribe](/docs/patterns/communication/pub-sub) — the internal
  analogue; a webhook is pub-sub's delivery extended across an
  organizational boundary over HTTP, without a shared broker.
- [Server-Sent Events](/docs/patterns/communication/server-sent-events) —
  the browser-facing cousin: SSE streams events to a connected client,
  webhooks POST them to another server's callback URL.
- [Idempotency](/docs/patterns/reliability/idempotency) — required on the
  consumer because webhook delivery is at-least-once and can duplicate.
- [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff) —
  how a provider handles a consumer endpoint that's temporarily
  unreachable without hammering it.
- [Dead Letter Queue](/docs/patterns/reliability/dead-letter-queue) —
  where a consumer parks events that repeatedly fail processing instead of
  blocking the pipeline.

## Further reading

- [Receive Stripe events in your webhook endpoint — Stripe Docs](https://docs.stripe.com/webhooks)
- [Verifying webhook signatures — Stripe Docs](https://docs.stripe.com/webhooks/signatures)
- [Webhook events and payloads — GitHub Docs](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
- [HMAC — Wikipedia](https://en.wikipedia.org/wiki/HMAC)
