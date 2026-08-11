---
title: "Valet Key"
sidebar_position: 9
supplementary: true
---

The Valet Key pattern issues a client a time-limited, scope-restricted
token — like a presigned URL — granting direct access to a specific
resource, so the client can read or write it without every byte
flowing through the application's own servers.

![Valet Key diagram](/img/patterns/valet-key.svg)

## Problem it solves

Routing large file uploads and downloads through the application's own
servers means every byte transferred consumes the app server's
bandwidth, connection slots, and CPU (for buffering, and often for TLS
termination twice — once to the client, once to storage), even though
the app itself has no real work to do beyond deciding whether the
transfer should be allowed. At any real scale, that turns simple file
storage into a capacity bottleneck: the app tier has to be sized for
peak transfer volume, not for its actual business logic, and a single
large upload can tie up a server thread or connection for as long as
the transfer takes.

## Technical architecture & implementation

**The key is signed data, not a lookup.** A valet key isn't a random
handle the storage service looks up in a table — that would just move
the bottleneck. It's a set of **fields carried in the request itself**
(the resource path, the permitted operation, an expiry timestamp) plus
a **signature** computed over those fields with a secret the app and
the storage service share. The storage service re-derives the signature
from the fields it received and compares; if they match, the request is
authorized, with no per-key state stored anywhere. That statelessness is
the whole point: the app issues the key in one cheap request and is then
completely out of the data path.

![Valet Key signed-URL flow](/img/patterns/valet-key-signed-url.svg)

**Signing and verification.** The signature is a MAC (an HMAC in real
systems — S3's SigV4 and Azure SAS both derive an HMAC-SHA256 over the
canonicalized fields). The app signs; the storage service verifies. This
is the same signed-message discipline used for
[webhook authenticity](/docs/patterns/communication/webhooks) — a keyed
digest over a canonical set of fields, compared exactly — turned around:
there the receiver verifies a sender's signature; here the *storage
service* verifies the *app's* signature on a token it minted for a
client to carry. Because verification is a pure function of the fields
and the shared secret, any storage node can validate a key without
coordinating.

**Scope minimization.** A valet key should grant the *least* access that
does the job: one **specific object** (not a prefix or bucket), one
**operation** (read *or* write, not both), and the **shortest expiry**
that lets the transfer finish. Every axis you widen is blast radius if
the key leaks. A presigned upload URL scoped to `PUT /uploads/9f3.jpg`
for 300 seconds is a very different risk than one scoped to `PUT` on the
whole bucket for a day. The signature *binds* these fields: because the
operation and resource are inside what the MAC covers, a client can't
edit the URL to widen its own access — the signature would no longer
match.

**Expiry and the revocation problem.** The hardest limitation is that a
signed key **can't be easily revoked before it expires**. There's no
per-key record to delete — validity is a mathematical property of the
fields and the secret, checked offline by the storage service. So the
primary control is a **short TTL**: keep the window small enough that
"wait for it to expire" is an acceptable worst case. The nuclear option
is **rotating the signing secret**, which invalidates *every*
outstanding key at once — usable in an incident but far too blunt for
routine revocation. This is the defining tradeoff of the pattern: you
trade revocability for statelessness and scale.

**Leakage risk.** Because the URL *is* the credential, anyone who
obtains it has exactly the access it encodes until it expires — it can
end up in browser history, server logs, a `Referer` header, or a shared
link. Mitigations stack: short TTLs, scoping to a single object and
operation, serving only over HTTPS so it isn't sniffed, and (where the
storage service supports it) binding the key to the client's IP or
requiring specific headers.

**Failure modes.** *Over-broad scope* (bucket instead of object,
read+write, long TTL) turns a leaked URL into a serious breach.
*Assuming revocability* — building a flow that needs to yank access
instantly — fights the pattern's nature. *Clock skew* between issuer and
verifier can reject fresh keys or honor stale ones, so tolerances and
synchronized clocks matter. *Bypassed inspection*: because bytes never
touch the app, any validation the app used to do (virus scanning,
content moderation, size limits beyond what storage enforces) must move
elsewhere or be given up.

## Scoping and expiry

The two levers that make a valet key safe are *what* it grants and *how
long*. Tighten both as far as the workflow allows.

| Dimension | Loose (risky) | Tight (preferred) |
| --- | --- | --- |
| Resource | Whole bucket / prefix | One exact object key |
| Operation | Read + write | Read *or* write only |
| TTL | Hours or days | Seconds to minutes |
| Transport | Any | HTTPS only |
| Binding | Fields only | Fields + client IP / required headers |

A useful rule of thumb: the TTL should be just longer than the slowest
realistic transfer of that object, and no more. If a workflow seems to
need a long-lived key, that's usually a signal to re-issue short-lived
keys on demand instead — the app issuing a key is cheap.

## Valet key vs. claim check vs. federated identity

These three all pass around a small token instead of the real thing, but
they solve different problems. The distinction is worth pinning down
because they're easy to conflate.

- **Valet key** grants a *client* **direct, scoped access to a
  resource** it will read or write itself. The token is a capability:
  possessing it *is* the authorization.
- **[Claim check](/docs/patterns/communication/claim-check)** keeps a
  large payload off a *message bus*: the producer stores the payload and
  puts only a *reference* on the bus, and the consumer fetches it later.
  It's about message size on an internal channel, not about granting an
  external client scoped access — the reference is a pointer, not a
  self-authorizing capability.
- **[Federated identity](/docs/patterns/api-edge/federated-identity)**
  establishes *who a user is* via a token an identity provider signed.
  That's **identity**, not **resource access** — a valet key says
  nothing about who you are, only that whoever holds it may perform one
  operation on one object until it expires.

Valet key and claim check often appear together: a claim-check reference
can *be* a valet key, so the consumer's fetch is a direct, scoped,
expiring read from storage rather than an unscoped one.

## Code example

The snippet below shows the full mechanism: an issuer that signs a key
binding resource, operation, and expiry, and a storage-side verifier
that recomputes the signature and enforces the scope. It rejects a
tampered scope (a client trying to widen `Read` to `Write` or point at
another object), an expired key, and a request for an operation the key
doesn't grant. A production signer swaps the placeholder digest for
HMAC-SHA256 over the canonical fields (as S3 SigV4 does); the binding
and verification *structure* is the lesson.

```rust
use std::time::{SystemTime, Duration, UNIX_EPOCH};

#[derive(Clone, Copy, PartialEq, Debug)]
enum Operation {
    Read,
    Write,
}

/// The fields a storage service receives, plus the signature that binds them.
/// There is no server-side record of this key — validity is derived from the
/// fields and the shared secret alone.
struct ValetKey {
    resource: String,
    operation: Operation,
    expires_at: u64, // unix seconds
    signature: u64,
}

/// NON-CRYPTOGRAPHIC stand-in for HMAC-SHA256 over the canonical fields.
/// Real code signs (resource | operation | expiry) with a shared secret using
/// a real MAC. Here we model it so that changing ANY signed field — resource,
/// operation, or expiry — changes the signature, which is the property that
/// stops a client from editing the URL to widen its own access.
fn sign(secret: u64, resource: &str, operation: Operation, expires_at: u64) -> u64 {
    let mut h: u64 = secret;
    for b in resource.bytes() {
        h = h.wrapping_mul(0x100000001b3).wrapping_add(b as u64);
    }
    h = h.wrapping_add(match operation {
        Operation::Read => 1,
        Operation::Write => 2,
    });
    h ^ expires_at
}

/// Issuer side (the application): mint a scoped, time-limited key.
fn issue(secret: u64, resource: &str, operation: Operation, ttl: Duration, now: u64) -> ValetKey {
    let expires_at = now + ttl.as_secs();
    ValetKey {
        resource: resource.to_string(),
        operation,
        expires_at,
        signature: sign(secret, resource, operation, expires_at),
    }
}

/// Verifier side (the storage service): authorize a specific request against a
/// key, with no lookup — recompute the signature, then enforce scope + expiry.
fn authorize(
    secret: u64,
    key: &ValetKey,
    requested_resource: &str,
    requested_op: Operation,
    now: u64,
) -> Result<(), &'static str> {
    // 1. Signature must match — catches any tampering with the signed fields.
    let expected = sign(secret, &key.resource, key.operation, key.expires_at);
    if key.signature != expected {
        return Err("invalid signature (tampered key)");
    }
    // 2. Expiry — a signed key is valid until it expires and cannot be revoked
    //    early, so TTLs are kept short.
    if now >= key.expires_at {
        return Err("key expired");
    }
    // 3. Scope — the request must fall within exactly what the key grants.
    if requested_resource != key.resource {
        return Err("resource out of scope");
    }
    if requested_op != key.operation {
        return Err("operation out of scope");
    }
    Ok(())
}

fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}
```

The application only runs `issue` once per upload/download request;
everything after that — the actual bytes moving — happens directly
between the client and storage, gated by `authorize`, which the storage
service runs itself with no reference back to the app. Exercised
directly, a key authorizes the exact resource and operation it was
issued for within its window, but is rejected when the requested
resource or operation differs from the key's scope, when `now` has
passed `expires_at`, and when any signed field is altered so the
recomputed signature disagrees.

## When to use it

- Large or frequent file transfers (uploads, downloads, media
  streaming) where proxying through app servers would be a real
  bandwidth or connection-capacity bottleneck.
- The storage service (or queue, or other resource) natively supports
  scoped, time-limited access tokens, so the application doesn't have
  to reimplement that validation itself.
- Reducing app-server load and transfer latency matters more than
  having the app inspect every byte in transit.

## When not to use it

- The application needs to inspect, transform, or validate the content
  of every transfer (e.g. virus scanning, content moderation) before
  it's considered accepted — direct client-to-storage access bypasses
  that inspection entirely, which is exactly the tradeoff this pattern
  makes.
- Access must be revocable on demand, before a token would naturally
  expire — a signed valet key can't be individually revoked, so a flow
  that depends on instant cutoff fights the pattern's nature.
- Transfers are small and infrequent enough that proxying through the
  app server was never actually a bottleneck — the added complexity of
  issuing and validating scoped tokens isn't worth it.
- The storage service doesn't support scoped, expiring access tokens,
  which would leave the application to build and secure that
  mechanism itself.

## Use-case scenarios

**Direct browser upload of user files.** A web app lets users upload
profile pictures and documents. Rather than streaming multi-megabyte
files through its API servers, the app issues a presigned `PUT` URL
scoped to a single object key with a 5-minute TTL; the browser uploads
straight to [blob storage](/docs/patterns/building-blocks/blob-store).
The app tier is sized for its business logic, not for aggregate upload
bandwidth, and a burst of large uploads can't exhaust its connection
pool.

**Time-limited download links for private media.** A content platform
serves paid or private videos and images. On each request it checks
entitlement, then hands the client a short-lived presigned `GET` URL
scoped to that one object, so the file streams directly from storage or
a CDN origin — the same building block behind
[static content hosting](/docs/patterns/building-blocks/static-content-hosting),
but access-controlled per request. The short TTL bounds how long a
leaked link stays useful, and the per-object scope means a leaked link
exposes only that one asset.

**Claim check with a scoped fetch.** An event-driven pipeline uses the
[claim check](/docs/patterns/communication/claim-check) pattern: a
producer stores a large payload in blob storage and puts a reference on
the message bus. Making that reference a valet key means the consumer's
fetch is a direct, read-only, expiring pull of exactly that one object —
so an intercepted message grants a bounded, single-object read rather
than broad storage access.

## Production libraries & getting started

You almost never implement valet-key signing yourself — the major
object stores provide presigned/SAS URL generation directly in their
SDKs, and you call one method to mint a scoped, expiring URL. These are
the canonical implementations across the three big clouds.

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| AWS S3 presigned URLs | Multi-language (SDKs) | Time-limited signed URLs for direct `GET`/`PUT` on one object | [Getting started](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html) |
| AWS SDK for Python (boto3) | Python | `generate_presigned_url` to mint scoped S3 URLs in Python | [Getting started](https://boto3.amazonaws.com/v1/documentation/api/latest/guide/s3-presigned-urls.html) |
| Google Cloud Storage signed URLs | Multi-language (SDKs) | V4 signed URLs granting direct, expiring access to a GCS object | [Getting started](https://cloud.google.com/storage/docs/access-control/signed-urls) |
| Azure Storage SAS tokens | Multi-language (SDKs) | Shared Access Signatures scoping operation, resource, and expiry | [Getting started](https://learn.microsoft.com/en-us/azure/storage/common/storage-sas-overview) |

**Example / reference:** [Generate a V4 signed URL — Google Cloud Storage sample](https://cloud.google.com/storage/docs/samples/storage-generate-signed-url-v4)

## Related patterns

- [Blob Store](/docs/patterns/building-blocks/blob-store) — the
  resource a valet key most commonly grants scoped access to; the
  valet key is the access-control mechanism layered on top of the blob
  store's own API.
- [Static Content Hosting](/docs/patterns/building-blocks/static-content-hosting) —
  serves files directly from storage/CDN; valet keys are how that direct
  serving is made access-controlled per request instead of fully public.
- [Claim Check](/docs/patterns/communication/claim-check) — passes a
  *reference* to a large payload on a message bus; that reference can be
  a valet key so the consumer's fetch is a scoped, expiring direct read.
- [Federated Identity](/docs/patterns/api-edge/federated-identity) — the
  sibling concerned with *identity* (who a user is) rather than *scoped
  resource access* (what one token may do to one object); both issue
  signed, expiring tokens for different jobs.
- [Webhooks](/docs/patterns/communication/webhooks) — uses the same
  signed-message discipline (a keyed MAC over canonical fields, verified
  exactly) that underpins a valet key's signature.

## Further reading

- [Valet Key pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/valet-key)
- [Authenticating Requests: Using Query Parameters (SigV4) — Amazon S3 docs](https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html)
- [Using presigned URLs — Amazon S3 User Guide](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
- [Grant limited access with shared access signatures (SAS) — Azure Storage docs](https://learn.microsoft.com/en-us/azure/storage/common/storage-sas-overview)
- [HMAC — Wikipedia](https://en.wikipedia.org/wiki/HMAC)
