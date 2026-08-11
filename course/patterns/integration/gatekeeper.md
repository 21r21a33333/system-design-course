---
title: "Gatekeeper"
sidebar_position: 4
supplementary: true
---

The Gatekeeper pattern places a dedicated, minimal-attack-surface host
in front of a backend to validate and sanitize every incoming request
before it's forwarded, so the backend never has to trust raw external
input directly.

![Gatekeeper diagram](/img/patterns/gatekeeper.svg)

## Problem it solves

Backend services that accept external input directly are exposed to
whatever that input contains — malformed payloads, injection attempts,
oversized requests, requests that don't match the expected shape at
all. Building robust validation into every backend service means
duplicating security logic across services and hoping every team gets
it right, and any gap becomes a way for an attacker to reach code that
was never designed to defend itself. The Gatekeeper pattern separates
"is this request even legitimate" from the backend's actual business
logic, concentrating the untrusted-input handling into one small,
heavily scrutinized component instead of spreading it across every
service that could be reached from outside.

## How it works

The gatekeeper is deliberately kept small and simple — the less code
it runs, the smaller its own attack surface, and the easier it is to
audit thoroughly. It receives every externally-facing request first.
It checks the request against a strict set of rules: expected fields
present and correctly typed, sizes within bounds, no characters or
patterns associated with injection attacks, valid authentication
where required. Requests that pass are forwarded — often reconstructed
from scratch rather than passed through verbatim, so nothing
unexpected can ride along — to the backend, which now only ever
receives input the gatekeeper has already vetted. Requests that fail
validation are rejected at the gatekeeper and never reach the backend
at all. Because the gatekeeper is the only component directly exposed
to untrusted traffic, it's often deployed on a separate, more
restricted host or network segment than the backend it protects.

## Code example

The snippet below shows the kind of validation a gatekeeper performs
before forwarding a request — rejecting anything that doesn't meet a
strict allow-list of rules.

```rust
struct IncomingRequest {
    username: String,
    amount_cents: i64,
}

#[derive(Debug)]
enum RejectionReason {
    UsernameInvalid,
    AmountOutOfRange,
}

fn validate(req: &IncomingRequest) -> Result<(), RejectionReason> {
    let valid_username = req.username.len() <= 32
        && req
            .username
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_');

    if !valid_username {
        return Err(RejectionReason::UsernameInvalid);
    }

    if req.amount_cents <= 0 || req.amount_cents > 1_000_000_00 {
        return Err(RejectionReason::AmountOutOfRange);
    }

    Ok(())
}

// Only requests that pass validation are ever forwarded to the backend.
fn forward_if_valid(req: IncomingRequest) -> Result<IncomingRequest, RejectionReason> {
    validate(&req)?;
    Ok(req)
}
```

Note that the gatekeeper rejects on anything outside a known-good
shape (an allow-list), rather than trying to block a list of known-bad
patterns — the same principle real gatekeeper hosts apply at a larger
scale.

## When to use it

- Backend services handle sensitive data or operations and shouldn't
  be directly reachable from untrusted networks.
- You want one place to audit and harden against malformed or
  malicious input, instead of relying on every backend service to
  validate correctly.
- Compliance or defense-in-depth requirements call for a clear
  separation between the externally-exposed surface and internal
  systems.

## When not to use it

- Internal-only services where all callers are already trusted and
  network-isolated — the extra hop adds latency and operational
  overhead without a corresponding security benefit.
- The system's primary need is routing, aggregation, or rate limiting
  rather than security validation — an API Gateway is a better fit for
  that job (see below).
- Extremely latency-sensitive paths where even a lightweight
  validation hop is unacceptable.

## How it differs from an API Gateway

An API Gateway's primary job is routing, request aggregation, protocol
translation, and rate limiting across many backend services — security
is often one of several responsibilities it has, not the main one. A
Gatekeeper's *only* job is validating and sanitizing input before
anything reaches the backend; it's intentionally simpler and smaller
so that it can be trusted precisely because there's less of it to get
wrong. In practice, some systems use both: an [API Gateway](/docs/patterns/api-edge/api-gateway)
for routing and cross-cutting concerns, sitting behind (or in front
of) a Gatekeeper whose sole responsibility is the trust boundary.

## Real-world example

Systems handling regulated or sensitive data (financial transactions,
healthcare records) often deploy a minimal, tightly audited
request-validation host as the only component reachable from the
public internet, with the actual processing services placed on a
private network segment the gatekeeper alone can reach.

## Related patterns

- [API Gateway](/docs/patterns/api-edge/api-gateway) — often deployed
  alongside a Gatekeeper; the gateway focuses on routing and
  aggregation, the gatekeeper focuses specifically on validating
  untrusted input at the trust boundary.

## Further reading

- [Gatekeeper pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/gatekeeper)
- [Data validation — Wikipedia](https://en.wikipedia.org/wiki/Data_validation)
