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

## How it works

Instead of putting the payload itself on the bus, the producer writes
it to a blob store and receives back a key or URL identifying it. The
producer then publishes a small message — the claim check — containing
that reference plus whatever lightweight metadata consumers need to
decide if and when to act. A consumer reads the claim check off the
bus, and only if it needs the full content does it make a separate
call to the blob store, using the reference, to retrieve it. The
message bus is left carrying only small, uniform messages regardless
of how large the underlying payload is, and consumers that don't need
the full payload for a given message never pay the cost of fetching
it.

## Code example

The snippet below shows the shape of producing and consuming a claim
check: the payload never touches the message type that goes on the
bus.

```rust
struct ClaimCheck {
    blob_key: String,
    content_type: String,
    size_bytes: u64,
}

trait BlobStore {
    fn put(&self, bytes: &[u8], content_type: &str) -> String; // returns blob_key
    fn get(&self, blob_key: &str) -> Vec<u8>;
}

trait MessageBus {
    fn publish(&self, claim_check: &ClaimCheck);
}

fn produce(store: &dyn BlobStore, bus: &dyn MessageBus, payload: &[u8], content_type: &str) {
    let blob_key = store.put(payload, content_type);
    let claim_check = ClaimCheck {
        blob_key,
        content_type: content_type.to_string(),
        size_bytes: payload.len() as u64,
    };
    bus.publish(&claim_check); // only the small reference crosses the bus
}

fn consume(store: &dyn BlobStore, claim_check: &ClaimCheck) -> Vec<u8> {
    // Fetched directly from blob storage, on demand — not from the bus.
    store.get(&claim_check.blob_key)
}
```

`produce` never puts `payload` on the bus — only the resulting
`ClaimCheck`, which is small and fixed-size regardless of how large
`payload` was. A consumer that only needs `content_type` or
`size_bytes` can act on the claim check alone and skip `consume`
entirely.

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

## Real-world example

Azure Service Bus and Amazon SQS/S3 combinations are the most common
implementations: a producer uploads a large payload to Blob Storage or
S3, then publishes a message to Service Bus or SQS containing only the
object's key, and consumers fetch the object directly from blob
storage using that key when they need it.

## Related patterns

- [Blob Store](/docs/patterns/building-blocks/blob-store) — where the
  actual payload lives; the claim check is just a reference into it.
- [Publish-Subscribe](/docs/patterns/communication/pub-sub) — the
  message bus the claim check itself travels over.

## Further reading

- [Claim-Check pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/claim-check)
- [Amazon SQS quotas — AWS docs](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html)
