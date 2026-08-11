---
title: "Gatekeeper"
sidebar_position: 4
supplementary: true
---

The Gatekeeper pattern places a dedicated, minimal-attack-surface host
in front of a backend to validate and sanitize every incoming request
before it's forwarded, so the backend never has to trust raw external
input directly — and, crucially, the gatekeeper itself holds no
credentials or data, so compromising it grants an attacker nothing
beyond the ability to forward already-validated requests.

![Gatekeeper diagram](/img/patterns/gatekeeper.svg)

## Problem it solves

Backend services that accept external input directly are exposed to
whatever that input contains — malformed payloads, injection attempts,
oversized requests, requests that don't match the expected shape at
all. Building robust validation into every backend service means
duplicating security logic across services and hoping every team gets
it right, and any gap becomes a way for an attacker to reach code that
was never designed to defend itself. Worse, a service that both parses
untrusted input *and* holds the keys to the data it protects couples
two very different risks: a parsing bug in the untrusted-input handling
becomes a direct path to the credentials sitting next to it. The
Gatekeeper pattern separates "is this request even legitimate" from the
backend's actual business logic and secrets, concentrating the
untrusted-input handling into one small, heavily scrutinized component
that deliberately holds nothing worth stealing.

## Technical architecture & implementation

**A brokered trust boundary.** The gatekeeper is the *only* component
directly reachable from the untrusted network; the backend it protects
sits on a separate, more restricted host or network segment that
accepts connections from the gatekeeper alone. Every externally-facing
request hits the gatekeeper first, is vetted, and is then re-issued to
the backend over a secured internal channel. This is *brokered trust*:
clients never talk to the backend, they talk to a broker that vouches
for (a sanitized version of) their request. The backend can therefore
be written as though all its input is already trusted, because by the
time input reaches it, it is.

**Allow-list validation, not deny-list filtering.** The gatekeeper
accepts only what matches a strict, known-good shape — expected fields
present and correctly typed, sizes within bounds, values inside numeric
or format ranges, valid authentication where required — and rejects
everything else. This is the opposite of trying to enumerate known-bad
patterns: a deny-list is only as good as its last update and fails open
against anything novel, whereas an allow-list fails closed. Requests
that pass are frequently **reconstructed from scratch** rather than
proxied verbatim, so no unexpected header, field, or trailing byte can
ride along into the trusted zone — only the specific, vetted fields the
gatekeeper chose to forward cross the boundary.

**The gatekeeper holds no secrets.** This is the property that bounds
the blast radius. The gatekeeper validates the *shape* of an auth
token, enforces size and rate limits, and checks input structure — but
it does not store database credentials, API keys, or the protected
data itself. If an attacker compromises the gatekeeper, they gain a
machine that can forward validated requests and nothing more; they
cannot read the datastore or mint privileged tokens, because those live
only behind the boundary. The backend fetches its own secrets from a
[secret store](/docs/patterns/observability/external-configuration-store)
the gatekeeper cannot reach. Minimizing what the gatekeeper holds is as
important as minimizing what it runs.

**Minimal, auditable surface.** The less code the gatekeeper runs, the
smaller its own attack surface and the more completely it can be
audited. It is deliberately kept small and single-purpose so that its
correctness is tractable to reason about — the entire justification for
trusting it is that there is little enough of it to get right.

**Failure modes.** A gatekeeper that validates with a *deny-list* leaks
whatever the list doesn't yet know about. A gatekeeper that **proxies
requests verbatim** instead of rebuilding them lets unexpected fields
slip through even when the checked fields are valid. A gatekeeper that
**accumulates responsibilities** (routing, aggregation, business logic)
grows its surface until it is no longer small enough to trust — mission
creep is the quiet way this pattern fails. And a gatekeeper that is
made a **single point of failure** without redundancy trades a security
win for an availability loss, since now nothing reaches the backend if
it's down.

**Gatekeeper vs. API Gateway vs. Valet Key.** These sit near each other
at the edge but do different jobs. An
[API Gateway](/docs/patterns/api-edge/api-gateway)'s primary purpose is
*routing, aggregation, protocol translation, and cross-cutting concerns*
across many services; security is one of several responsibilities, and
the gateway is a large, feature-rich component. A **Gatekeeper**'s
*only* job is the security validation and sanitization at the trust
boundary, and it is intentionally small precisely so it can be trusted.
[Gateway Offloading](/docs/patterns/api-edge/gateway-offloading) is the
adjacent idea of moving shared concerns (TLS, auth) *into* a gateway —
a gatekeeper is the security-hardened, minimal-surface end of that
spectrum. The [Valet Key](/docs/patterns/api-edge/valet-key) pattern is
the *inverse* direction of trust: a valet key hands a client a scoped,
signed token to access a resource *directly*, removing the broker from
the path; a gatekeeper brokers *all* access and never hands out direct
access at all. Use a valet key to safely get out of the data path; use
a gatekeeper to make sure nothing untrusted ever enters it.

## What the gatekeeper does and does not hold

![Gatekeeper trust boundary](/img/patterns/gatekeeper-trust-boundary.svg)

The pattern's blast-radius guarantee comes entirely from a strict
division of what lives on which side of the boundary.

| Concern | Gatekeeper (exposed) | Backend (protected) |
| --- | --- | --- |
| Validation / sanitization rules | Yes — its whole job | No |
| Auth token *shape* checks | Yes | — |
| Database / API credentials | **No** | Yes |
| The protected data itself | **No** | Yes |
| Signing keys / secrets | **No** | Yes (via secret store) |
| Business logic | **No** | Yes |

The test for whether a gatekeeper is correctly scoped: *if this host is
fully compromised, what can the attacker reach directly?* The answer
should be "nothing but the ability to send already-validated requests
onward" — no keys, no data, no privileged operations.

## Code example

The snippet below is a validate-then-forward broker. The `Gatekeeper`
owns a private `Backend` that callers can never reference directly; the
only way in is `submit`, which runs a strict allow-list of checks
(token shape, payload size, username format, amount range) and forwards
a freshly-built `SanitizedRequest` only if everything passes. The
gatekeeper holds no secret — it checks the *shape* of a token, not a
cryptographic key. The type system enforces the invariant: the backend
accepts only `SanitizedRequest`, so a raw request cannot reach it, and
`processed_count` proves that malformed, oversized, and unauthenticated
requests are rejected at the boundary and never processed.

```rust
// Gatekeeper: a validate-then-forward broker. It holds no backend secret and
// forwards only requests that pass a strict allow-list of checks. The backend
// handle it forwards to is never exposed to callers.

#[derive(Debug, PartialEq)]
pub enum Rejection {
    Unauthenticated,
    UsernameInvalid,
    AmountOutOfRange,
    PayloadTooLarge,
}

/// What a caller sends. The gatekeeper treats every field as untrusted.
pub struct RawRequest {
    pub token: String,
    pub username: String,
    pub amount_cents: i64,
    pub payload_len: usize,
}

/// A request that has passed every gate. The type itself is the proof: the
/// backend accepts only this, so an unvalidated `RawRequest` cannot reach it.
pub struct SanitizedRequest {
    pub username: String,
    pub amount_cents: i64,
}

/// The protected backend. It is private to this module — callers never hold a
/// reference to it, only the gatekeeper does. It also holds no reference back
/// to the gatekeeper's checks: it trusts that `SanitizedRequest` was vetted.
pub struct Backend {
    processed: Vec<String>,
}

impl Backend {
    fn new() -> Self {
        Backend { processed: Vec::new() }
    }

    fn handle(&mut self, req: SanitizedRequest) {
        self.processed.push(req.username);
    }
}

/// The gatekeeper owns the backend and is the only path to it. It holds no
/// authentication secret of its own — it checks the *shape* of a token, not a
/// cryptographic secret, so compromising the gatekeeper leaks no key material.
pub struct Gatekeeper {
    backend: Backend,
    max_payload: usize,
}

impl Gatekeeper {
    pub fn new(max_payload: usize) -> Self {
        Gatekeeper { backend: Backend::new(), max_payload }
    }

    /// Validate against an allow-list, then forward. Anything malformed,
    /// oversized, or unauthenticated is rejected here and never reaches the
    /// backend.
    pub fn submit(&mut self, req: RawRequest) -> Result<(), Rejection> {
        let sanitized = self.validate(req)?;
        self.backend.handle(sanitized);
        Ok(())
    }

    fn validate(&self, req: RawRequest) -> Result<SanitizedRequest, Rejection> {
        // Auth: token must be well-formed (allow-list on shape, not a secret).
        let token_ok = req.token.len() == 32
            && req.token.chars().all(|c| c.is_ascii_hexdigit());
        if !token_ok {
            return Err(Rejection::Unauthenticated);
        }
        // Size: reject oversized payloads before touching business fields.
        if req.payload_len > self.max_payload {
            return Err(Rejection::PayloadTooLarge);
        }
        // Shape: username is an allow-list of safe characters, bounded length.
        let username_ok = !req.username.is_empty()
            && req.username.len() <= 32
            && req.username.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !username_ok {
            return Err(Rejection::UsernameInvalid);
        }
        // Range: numeric bounds enforced explicitly.
        if req.amount_cents <= 0 || req.amount_cents > 1_000_000_00 {
            return Err(Rejection::AmountOutOfRange);
        }
        // Rebuild from scratch: only vetted fields cross the boundary, so no
        // unexpected data rides along into the trusted zone.
        Ok(SanitizedRequest {
            username: req.username,
            amount_cents: req.amount_cents,
        })
    }

    pub fn processed_count(&self) -> usize {
        self.backend.processed.len()
    }
}
```

The gatekeeper rejects on anything outside a known-good shape (an
allow-list) rather than trying to block a list of known-bad patterns,
and it forwards a *reconstructed* request so nothing unexpected can ride
along — the same principles real gatekeeper hosts apply at a larger
scale. Exercised directly, a well-formed request is processed exactly
once; a request with a malformed token, an oversized payload, an
invalid username, or an out-of-range amount is rejected at the boundary
and leaves `processed_count` unchanged, so nothing unvetted ever reaches
the backend.

## When to use it

- Backend services handle sensitive data or operations and shouldn't
  be directly reachable from untrusted networks.
- You want one place to audit and harden against malformed or
  malicious input, instead of relying on every backend service to
  validate correctly.
- Limiting blast radius matters: if the edge host is compromised, it
  should hold no credentials or data an attacker could exfiltrate.
- Compliance or defense-in-depth requirements call for a clear
  separation between the externally-exposed surface and internal
  systems.

## When not to use it

- Internal-only services where all callers are already trusted and
  network-isolated — the extra hop adds latency and operational
  overhead without a corresponding security benefit.
- The system's primary need is routing, aggregation, or rate limiting
  rather than security validation — an
  [API Gateway](/docs/patterns/api-edge/api-gateway) is a better fit for
  that job.
- Extremely latency-sensitive paths where even a lightweight
  validation hop is unacceptable.
- You actually want the client to access a resource *directly* (e.g. a
  large file transfer) — a [Valet Key](/docs/patterns/api-edge/valet-key)
  brokers a scoped token instead of every request, which is the right
  tool when the goal is to get *out* of the data path rather than guard
  it.

## Use-case scenarios

**Regulated data behind a hardened broker.** A payments processor
exposes a single, minimal request-validation host to the public
internet; the services that actually touch cardholder data and hold the
database credentials sit on a private network segment only that host can
reach. The gatekeeper validates request structure, token shape, and
size, then re-issues a clean request inward. A compromise of the
public-facing host yields no credentials and no data — the attacker
lands on a machine that can only forward already-validated requests,
which is exactly the containment the pattern is designed for.

**IoT ingestion for a fleet of untrusted devices.** A telemetry
platform receives readings from millions of field devices that cannot
be fully trusted (firmware can be tampered with, messages spoofed). A
gatekeeper tier parses and strictly validates every device message
against the expected schema and value ranges, drops anything malformed,
and forwards only well-formed, bounded records to the processing and
storage backend. The backend, which holds the database and downstream
integrations, never parses raw device bytes — the risky parsing lives in
the disposable, secret-less edge.

**Hardened admin gateway for an internal control plane.** A cloud
operator's control plane accepts privileged operations, but the host
that terminates those requests holds no signing keys itself. It
validates the request shape and the caller's token structure, then
forwards vetted commands to an internal service that fetches the actual
signing credentials from a secret store. Even a full compromise of the
admin-facing host cannot sign privileged actions, because the material
needed to do so was deliberately never placed there.

## Related patterns

- [API Gateway](/docs/patterns/api-edge/api-gateway) — often deployed
  alongside a Gatekeeper; the gateway focuses on routing and
  aggregation across many services, the gatekeeper focuses specifically
  on validating untrusted input at a hardened trust boundary.
- [Gateway Offloading](/docs/patterns/api-edge/gateway-offloading) —
  moves shared concerns (TLS, auth) into a gateway layer; a gatekeeper
  is the minimal-surface, security-hardened end of that same spectrum.
- [Valet Key](/docs/patterns/api-edge/valet-key) — the inverse trust
  direction: grants a client scoped *direct* access to a resource,
  whereas a gatekeeper brokers all access and hands out none.
- [Ambassador](/docs/patterns/integration/ambassador) — a sibling
  proxy pattern, but on the *outbound* side (helping a client talk to
  remote services) rather than guarding the inbound trust boundary.
- [Bulkhead](/docs/patterns/reliability/bulkhead) — isolates resources
  so a failure is contained; a gatekeeper isolates *trust* so untrusted
  input is contained, a complementary flavor of compartmentalization.

## Further reading

- [Gatekeeper pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/gatekeeper)
- [Input validation — OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html)
- [Defense in depth — Wikipedia](https://en.wikipedia.org/wiki/Defense_in_depth_(computing))
- [Attack surface — Wikipedia](https://en.wikipedia.org/wiki/Attack_surface)
