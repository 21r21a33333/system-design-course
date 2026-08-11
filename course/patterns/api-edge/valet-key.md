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

## How it works

Instead of proxying the data itself, the application authorizes the
operation and hands the client a "valet key" — a token, scoped to one
resource and one operation (read or write), that's valid for a short
window of time — like a valet parking attendant getting a key that only
starts the car, not one that opens the trunk or is usable after the
evening's out. The client uses that key to talk directly to the storage
service (or queue, or other resource) named in the token. The storage
service itself validates the token's scope and expiry, independent of
the application, so the app server is only involved in the brief
request that issues the key — not in the transfer that follows.

## Code example

The snippet below shows the shape of key issuance: given a resource and
an operation, produce a scoped, time-limited token the client can use
directly against storage.

```rust
use std::time::{SystemTime, Duration};

struct ValetKey {
    resource: String,
    operation: Operation,
    expires_at: SystemTime,
    signature: String,
}

#[derive(Clone, Copy)]
enum Operation {
    Read,
    Write,
}

// Stand-in for HMAC-signing the key's fields with a server-side secret,
// so the storage service can verify it wasn't tampered with.
fn sign(resource: &str, operation: Operation, expires_at: SystemTime) -> String {
    format!("sig-for-{resource}-{}", matches!(operation, Operation::Write))
        .to_string()
        + &format!("{:?}", expires_at)
}

fn issue_valet_key(resource: &str, operation: Operation, ttl: Duration) -> ValetKey {
    let expires_at = SystemTime::now() + ttl;
    let signature = sign(resource, operation, expires_at);

    ValetKey {
        resource: resource.to_string(),
        operation,
        expires_at,
        signature,
    }
}

fn is_valid(key: &ValetKey, now: SystemTime) -> bool {
    now < key.expires_at
}
```

The application only runs `issue_valet_key` once per upload/download
request; everything after that — the actual bytes moving — happens
directly between the client and storage, validated by `is_valid`
against the signature and expiry the storage service checks itself.

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
- Transfers are small and infrequent enough that proxying through the
  app server was never actually a bottleneck — the added complexity of
  issuing and validating scoped tokens isn't worth it.
- The storage service doesn't support scoped, expiring access tokens,
  which would leave the application to build and secure that
  mechanism itself.

## Real-world example

Amazon S3 presigned URLs and Azure Blob Storage shared access
signatures (SAS) are direct implementations of the Valet Key pattern:
an application generates a URL scoped to one object and one operation
(GET or PUT), valid for a short window, and hands it to the client,
which then uploads or downloads directly against S3 or Blob Storage —
the request never touches the application's own servers.

## Related patterns

- [Blob Store](/docs/patterns/building-blocks/blob-store) — the
  resource a valet key most commonly grants scoped access to; the
  valet key is the access-control mechanism layered on top of the blob
  store's own API.

## Further reading

- [Valet Key pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/valet-key)
- [Authenticating Requests: Using Query Parameters — Amazon S3 docs](https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html)
