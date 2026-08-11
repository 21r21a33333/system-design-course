---
title: "Claim Check"
sidebar_position: 6
supplementary: true
---

The Claim Check pattern keeps large payloads off the message bus
entirely: the producer stores the payload in blob storage and puts
only a small reference — a "claim check" — on the bus, and the
consumer uses that reference to fetch the full payload when it
actually needs it.

![Claim Check diagram](/img/patterns/claim-check.svg)

## Problem it solves

Message brokers are built and sized around small, frequent messages,
not multi-megabyte payloads. Many impose a hard cap — Amazon SQS
rejects anything over 256KB, and other brokers have their own limits —
so a producer with a large document, image, or dataset to hand off
can't simply put it on the bus. Even where a broker technically allows
larger messages, doing so is a bad idea in practice: it bloats the
broker's storage and replication traffic, slows down every consumer
that has to receive and buffer the full payload even if it only cares
about the metadata, and turns a lightweight coordination layer into a
de facto file transfer system it was never designed to be.

## Technical architecture & implementation

**Write order: blob before claim check.** The producer writes the
payload to a [blob store](/docs/patterns/building-blocks/blob-store)
*first* and receives back a key or URL, then publishes the small claim
check referencing it. This ordering is not incidental — it is what
keeps the two stores consistent. If the blob write succeeds but the
publish fails, the producer simply retries the publish (or the whole
operation), and the worst case is an *orphaned blob* with no claim
check pointing at it, which a cleanup sweep can reclaim. Reverse the
order — publish the claim check first — and a consumer can read a
reference to a payload that doesn't exist yet, a dangling pointer that
is far harder to reason about. The claim check itself carries the blob
key plus lightweight metadata (content type, size, a content hash)
that lets consumers decide *whether* to fetch before paying for the
fetch.

**The dereference on the consumer side.** A consumer reads the claim
check off the bus and, only if it actually needs the content, makes a
separate call to the blob store using the reference. This is the
core saving: the bus carries only small, uniform messages regardless
of payload size, and a consumer that only needs the metadata (routing,
filtering, a size check) never fetches the body at all. Fan-out
amplifies the benefit — with N subscribers on a topic, the large
payload crosses the network once into the blob store and is fetched
only by the subset of consumers that genuinely need it, instead of
being copied into N broker deliveries.

**Payload lifecycle and cleanup.** Because the payload now lives
outside the broker, its lifecycle is no longer managed by the broker's
message retention. Once every consumer has processed a message, its
blob is garbage — but the broker doesn't know that, so someone must.
The two common strategies are a **TTL / lifecycle policy** on the blob
store (objects auto-expire after a window comfortably longer than the
maximum processing + retry time) and an **explicit delete** after the
last consumer acknowledges. TTL is simpler and self-healing against
orphans; explicit delete reclaims space sooner but is brittle in a
fan-out topology where "the last consumer" is hard to identify. Most
production systems lean on a generous TTL as the safety net.

**Security: don't hand out a raw bucket path.** The claim check is a
reference to data the consumer must be authorized to read, so the
reference should not be a naked, guessable blob path that any holder of
the message could dereference. The disciplined form is a **scoped,
time-limited, signed reference** — a pre-signed URL or a
[Valet Key](/docs/patterns/api-edge/valet-key) — that grants read
access to *exactly* that one object for a bounded window, so a leaked
claim check can't be used to enumerate the bucket or replayed
indefinitely. Adding the content hash to the claim check also lets a
consumer verify integrity: the fetched bytes must hash to the value the
producer recorded.

**Failure modes.** The reference can **outlive the blob** (TTL expired
before a slow consumer got to it) — handled by making processing +
retry windows shorter than the TTL, and by treating a missing blob as a
poison message routed to a
[dead-letter queue](/docs/patterns/reliability/dead-letter-queue). The
blob can **outlive all references** (the orphan case) — handled by the
lifecycle sweep. And a **redelivered message** (at-least-once brokers
redeliver) must dereference to the same immutable blob, which is why
claim-check payloads are written once under a content-addressed or
unique key and never mutated in place.

**Claim Check vs. inline vs. streaming.** Sending the payload
*inline* on the bus is simpler and correct when payloads are reliably
small — the claim check's extra round trip and cleanup machinery are
pure overhead there. At the opposite extreme, a continuous *stream* of
data (not discrete messages) belongs on a streaming transport, not a
blob-per-message scheme. Claim Check occupies the middle: discrete,
occasionally-or-always-large payloads handed off through a message
bus whose real job is coordination, not bulk transfer.

## Code example

The snippet below shows the shape of producing and consuming a claim
check: the payload never touches the message type that goes on the
bus.

```rust
struct ClaimCheck {
    blob_key: String,
    content_type: String,
    size_bytes: u64,
    // Content hash lets a consumer verify integrity after fetching, and
    // makes redelivery safe: the same key always names the same bytes.
    content_hash: u64,
}

trait BlobStore {
    fn put(&self, bytes: &[u8], content_type: &str) -> String; // returns blob_key
    fn get(&self, blob_key: &str) -> Option<Vec<u8>>;
}

trait MessageBus {
    fn publish(&self, claim_check: &ClaimCheck);
}

// Cheap stand-in for a real content hash (e.g. SHA-256) so the example
// stays std-only while still showing where integrity verification hooks in.
fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut h: u64 = 1469598103934665603; // FNV-1a offset basis
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    h
}

// Write the blob FIRST, then publish the reference. If the publish fails,
// the worst case is an orphaned blob a lifecycle sweep can reclaim — never
// a claim check pointing at a payload that doesn't exist.
fn produce(store: &dyn BlobStore, bus: &dyn MessageBus, payload: &[u8], content_type: &str) {
    let blob_key = store.put(payload, content_type);
    let claim_check = ClaimCheck {
        blob_key,
        content_type: content_type.to_string(),
        size_bytes: payload.len() as u64,
        content_hash: hash_bytes(payload),
    };
    bus.publish(&claim_check); // only the small reference crosses the bus
}

// Fetch on demand from blob storage — not the bus — and verify integrity.
// Returns None if the blob is gone (TTL expired) so the caller can
// dead-letter rather than trust missing data.
fn consume(store: &dyn BlobStore, claim_check: &ClaimCheck) -> Option<Vec<u8>> {
    let bytes = store.get(&claim_check.blob_key)?;
    match hash_bytes(&bytes) == claim_check.content_hash {
        true => Some(bytes),
        false => None, // corrupted or wrong object — treat as a failure
    }
}
```

`produce` never puts `payload` on the bus — only the resulting
`ClaimCheck`, which is small and fixed-size regardless of how large
`payload` was, and it always writes the blob before publishing.
`consume` fetches lazily and verifies the content hash, returning
`None` when the blob is missing or corrupt so the caller can route the
message to a dead-letter queue rather than proceed on bad data. A
consumer that only needs `content_type` or `size_bytes` can act on the
claim check alone and skip `consume` entirely.

## When to use it

- The payload is, or could be, larger than the message broker's size
  limit (e.g. SQS's 256KB cap) for at least some messages.
- Only some consumers of a given message actually need the full
  payload, so fetching it unconditionally for every consumer would
  waste bandwidth and broker capacity.
- The broker and blob store are both already part of the
  infrastructure, so introducing this indirection doesn't add a new
  operational dependency.

## When not to use it

- Payloads are reliably small and well within the broker's limits —
  the extra blob-store round trip and reference-management code adds
  complexity with no corresponding benefit.
- Every consumer needs the full payload immediately anyway, and the
  broker comfortably supports the message size — splitting it out just
  adds latency (an extra network hop) without reducing real load.
- The blob store and message bus can't be kept consistent (e.g. the
  blob write fails after the claim check was already published),
  which needs its own handling — typically writing the blob before
  publishing the claim check, as in the example above.

## Use-case scenarios

**Large document ingestion pipeline.** A claims-processing system
receives scanned insurance documents, sometimes tens of megabytes
each, well past SQS's 256KB message cap. The intake service uploads
each scan to S3 and publishes a claim check (S3 key, content type,
size, hash) to SQS. Downstream stages — OCR, classification, fraud
scoring — pull the claim check and fetch the scan only if their step
needs the pixels; a routing stage that only reads metadata never
downloads it. An S3 lifecycle rule expires processed scans after the
pipeline's maximum retry window.

**Event fan-out with heavy payloads.** An e-commerce platform
publishes an "order enriched" event to a topic with a dozen
subscribers — inventory, analytics, notifications, recommendations.
The enriched payload (full cart, customer profile, computed pricing)
is large, so putting it inline would copy it into every subscriber's
delivery. Instead the producer stores it once in blob storage and
publishes a claim check to the
[pub-sub](/docs/patterns/communication/pub-sub) topic; only the two
subscribers that actually need the full body dereference it, the rest
act on the summary fields in the message.

**Secure cross-team handoff with signed references.** A media team
hands rendered video assets to a distribution team over a shared bus,
but the distribution consumers must not be able to browse the media
bucket at large. The producer mints a short-lived
[valet-key](/docs/patterns/api-edge/valet-key) style pre-signed URL
scoped to the single object and puts *that* in the claim check, so a
consumer can fetch exactly one asset for a bounded window and a leaked
message grants nothing more.

## Related patterns

- [Blob Store](/docs/patterns/building-blocks/blob-store) — where the
  actual payload lives; the claim check is just a reference into it.
- [Publish-Subscribe](/docs/patterns/communication/pub-sub) — the
  message bus the claim check itself travels over, and where fan-out
  makes the payload-copy savings largest.
- [Valet Key](/docs/patterns/api-edge/valet-key) — the scoped,
  time-limited signed reference that turns a raw blob path into a safe
  claim check nobody can use to enumerate the store.
- [Dead-Letter Queue](/docs/patterns/reliability/dead-letter-queue) —
  where a claim check whose blob has expired or fails integrity
  verification is routed instead of being silently dropped.

## Further reading

- [Claim-Check pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/claim-check)
- [Amazon SQS quotas — AWS docs](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html)
- [Amazon SQS Extended Client Library (S3-backed large messages)](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-s3-messages.html)
- [Amazon S3 Object Lifecycle Management — AWS docs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html)
- [Enterprise Integration Patterns: Store in Library (Claim Check)](https://www.enterpriseintegrationpatterns.com/patterns/messaging/StoreInLibrary.html)
