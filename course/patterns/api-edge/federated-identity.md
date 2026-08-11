---
title: "Federated Identity"
sidebar_position: 10
supplementary: true
---

Federated Identity delegates authentication to an external identity
provider — via OAuth2, OIDC, or SAML — instead of an application
managing its own store of user credentials.

![Federated Identity diagram](/img/patterns/federated-identity.svg)

## Problem it solves

An application that manages its own usernames and passwords takes on
the full weight of doing so safely: hashing and storing credentials
correctly, handling password resets, defending against credential
stuffing and brute-force attacks, and keeping up with evolving best
practices as attacks evolve. Every one of those is a place a mistake
directly compromises user accounts, and it's work that has nothing to
do with the application's actual purpose. It's also friction for
users, who end up with yet another username and password to create and
remember, and friction for enterprises, who want a new employee's
access to every internal tool provisioned and revoked centrally rather
than account-by-account.

## Technical architecture & implementation

**The trust flow.** Instead of prompting for a password itself, the
application (the *relying party*, or RP) redirects the user to an
external identity provider (IdP) to authenticate. The user logs in with
the IdP directly — the application never sees the password. The IdP
then returns a **signed token** to the application, attesting to who
the user is and, optionally, what claims (email, group membership,
roles) apply. The application verifies the token and, from then on,
treats the user as authenticated based on it, without ever having
stored or checked a credential. The security of the whole scheme
collapses onto one step: **verifying that token correctly**. Everything
below is what "correctly" means.

**Token types — ID vs. access vs. refresh.** OIDC distinguishes three,
and confusing them is a classic bug. An **ID token** answers *who the
user is* — it's for the application, proving the authentication
happened, and should never be sent to an API as a credential. An
**access token** answers *what the bearer may do* — it's an opaque or
JWT bearer credential the client presents to resource servers, scoped
by OAuth2 *scopes*. A **refresh token** is a long-lived secret used
only to mint fresh access tokens when they expire, so the user isn't
redirected to log in again every few minutes. Using an ID token where
an access token belongs (or vice versa) is a real vulnerability, not a
style nit.

**JWT structure and signature verification.** Most OIDC tokens are
JWTs: three base64url segments — `header`, `payload`, `signature` —
joined by dots. The header names the signing algorithm and a **key id**
(`kid`); the payload holds the claims; the signature covers
`header.payload`. To verify, the RP fetches the IdP's public keys from
its **JWKS** endpoint (a well-known URL publishing a set of keys, each
tagged with a `kid`), selects the key matching the token's `kid`, and
checks the signature. Two footguns live here: never trust the token's
own `alg` header to pick the algorithm (the `alg: none` and
RS256→HS256 confusion attacks), and always select the key by `kid`
against a *trusted* JWKS you fetched yourself, not one the token points
at.

**Claim validation — issuer, audience, expiry.** A valid signature only
proves the token wasn't tampered with; it says nothing about whether
*this* token was meant for *this* application. The RP must also check:
**issuer** (`iss` matches the IdP you trust), **audience** (`aud`
matches your own client id — this is what stops a token minted for a
different app at the same IdP from being replayed against yours),
**expiry** (`exp` is in the future, `nbf`/`iat` are sane), and often a
**nonce** binding the token to the login request that started the flow.
Skipping the audience check is one of the most common and most
dangerous federated-identity mistakes: it accepts any validly-signed
token from the IdP, regardless of who it was for.

**Key rotation and revocation.** IdPs rotate signing keys; the JWKS
endpoint publishes the current set, so the RP caches it (respecting
cache headers) and refetches when it sees an unknown `kid` rather than
hardcoding a key. Revocation is the hard part: a signed, unexpired
token is valid until it expires whether or not the user's access was
revoked, so tokens are kept **short-lived** (minutes) and access is
refreshed against the still-authoritative IdP, trading a little chatter
for the ability to cut someone off promptly.

**Failure modes.** *Accepting the wrong audience or issuer* turns the
IdP's whole tenant into a skeleton key. *Trusting the token's `alg`*
enables signature-bypass attacks. *No nonce* allows a captured token to
be replayed into a different session. *Clock skew* makes valid tokens
look expired (allow a small tolerance). *Hard-dependency on the IdP*
means login stops entirely when the IdP is down — federation moves the
availability risk, it doesn't remove it.

## SAML vs. OAuth2 vs. OpenID Connect

These three are named together constantly but answer different
questions. **OAuth2** is an *authorization* framework — it issues access
tokens that delegate permission ("this app may read your calendar"); it
is deliberately *not* an authentication protocol. **OpenID Connect**
(OIDC) is a thin identity layer *on top of* OAuth2 that adds the ID
token and standard user claims, turning it into a proper
*authentication* protocol. **SAML 2.0** is the older, XML-based
enterprise standard that predates both and covers authentication and
attribute exchange in one assertion.

| Aspect | SAML 2.0 | OAuth 2.0 | OpenID Connect |
| --- | --- | --- | --- |
| Primary purpose | Authentication + SSO | Authorization (delegated access) | Authentication (on top of OAuth2) |
| Token format | XML assertion | Opaque or JWT access token | JWT ID token (+ OAuth2 tokens) |
| Signature | XML DSig (X.509 cert) | (issuer-specific) | JWS via JWKS |
| Typical use | Enterprise B2B SSO, legacy | API authorization, mobile | Consumer + modern SSO login |
| Transport | Browser POST / redirect (XML) | HTTP + bearer tokens | HTTP + bearer tokens (JSON) |

Rough guidance: reach for **OIDC** for new web/mobile login and
consumer "Sign in with…"; use **OAuth2 access tokens** when the goal is
delegated API access rather than login; keep **SAML** when integrating
with enterprise IdPs and legacy relying parties that already speak it.

## Federated identity vs. a plain login vs. gateway auth offloading

A **plain login** has the application own the password: it stores a
hash, checks it, and issues its own session. Federated identity removes
that store entirely — the application only *verifies* a token an
external IdP signed. That is the defining difference: who holds the
credential.

It's also distinct from an [API gateway](/docs/patterns/api-edge/api-gateway)
performing [auth offloading](/docs/patterns/api-edge/gateway-offloading).
Offloading is about *where* token verification runs — centralizing it at
the edge so every backend doesn't reimplement it. Federated identity is
about *who authenticated the user in the first place* — an external IdP
rather than the app. They compose cleanly: the IdP issues the token
(federation), and the gateway verifies it once at the edge
(offloading), so a real system usually does both.

## Code example

The snippet below shows the core of the trust decision: given a token
from an identity provider, select the right signing key by `kid`, verify
the signature, and validate issuer, audience, and expiry — rejecting a
wrong-audience token, an expired one, and a tampered one. A production
verifier swaps the placeholder digest for real JWS verification (RS256
against the IdP's JWKS); the *validation structure* around it is the
lesson.

```rust
use std::collections::HashMap;

/// A verified set of trusted signing keys, keyed by `kid`, as an RP would
/// build by fetching and caching the IdP's JWKS endpoint.
struct Jwks {
    keys: HashMap<String, u64>, // kid -> key material (a u64 stand-in)
}

struct IdToken {
    kid: String,
    issuer: String,
    audience: String,
    subject: String,
    email: String,
    expires_at: u64,
    signature: u64, // stand-in for the JWS signature over header.payload
}

struct AuthenticatedUser {
    subject: String,
    email: String,
}

/// NON-CRYPTOGRAPHIC stand-in for JWS verification. Real code verifies an
/// RS256/ES256 signature against the public key selected by `kid`. Here we
/// model "the signature is what this key would produce over these claims" so
/// that any tampering with the claims or use of the wrong key is detected.
fn expected_signature(key: u64, issuer: &str, audience: &str, subject: &str, expires_at: u64) -> u64 {
    let mut h: u64 = key;
    for field in [issuer, audience, subject] {
        for b in field.bytes() {
            h = h.wrapping_mul(0x100000001b3).wrapping_add(b as u64);
        }
    }
    h ^ expires_at
}

fn authenticate(
    jwks: &Jwks,
    trusted_issuer: &str,
    expected_audience: &str,
    token: &IdToken,
    now: u64,
) -> Result<AuthenticatedUser, &'static str> {
    // 1. Select the signing key by `kid` from our trusted JWKS — never trust
    //    a key or algorithm named by the token itself.
    let key = match jwks.keys.get(&token.kid) {
        Some(k) => *k,
        None => return Err("unknown signing key (kid)"),
    };

    // 2. Verify the signature covers exactly these claims with that key.
    let expected = expected_signature(
        key,
        &token.issuer,
        &token.audience,
        &token.subject,
        token.expires_at,
    );
    if token.signature != expected {
        return Err("invalid signature (tampered or wrong key)");
    }

    // 3. Validate claims: issuer, audience, expiry. A valid signature alone
    //    does NOT mean the token was minted for us.
    if token.issuer != trusted_issuer {
        return Err("untrusted issuer");
    }
    if token.audience != expected_audience {
        return Err("wrong audience — token was not issued for this app");
    }
    if token.expires_at <= now {
        return Err("token expired");
    }

    Ok(AuthenticatedUser {
        subject: token.subject.clone(),
        email: token.email.clone(),
    })
}
```

The application's entire authentication logic reduces to key selection
plus signature and claim checks on a token it received — it never
receives, hashes, or stores a password. Exercised directly, a token
with the correct `kid`, signature, issuer, audience, and a future
expiry authenticates, while a token carrying another app's `aud` is
rejected as wrong-audience, a past `exp` is rejected as expired, and any
byte flipped in the claims makes the recomputed signature disagree — the
three failure modes verification exists to catch.

## When to use it

- Users already have accounts with a common identity provider (Google,
  Microsoft, an enterprise SSO system) and shouldn't need to create yet
  another set of credentials.
- Enterprise customers want centralized control over who can access
  the application — provisioning and revoking access through their own
  identity provider rather than a separate account system.
- The application wants to avoid taking on the security and compliance
  burden of storing and protecting user credentials directly.

## When not to use it

- The application must keep working when the identity provider is
  unreachable — federated identity makes the identity provider a hard
  dependency for login, and there's no local credential store to fall
  back to. See [Circuit
  Breaker](/docs/patterns/reliability/circuit-breaker) for how a caller
  generally handles a dependency that's become slow or unavailable;
  for login itself there is usually no graceful degradation available.
- There's no identity provider the target users already trust or use,
  and standing one up (or integrating with one) is more overhead than
  the application's own simple credential store would be.
- The application has strict requirements to fully own and control
  identity data in-house, for regulatory or architectural reasons that
  rule out depending on an external party for authentication.

## Use-case scenarios

**Consumer social login.** A SaaS product offers "Sign in with Google"
and "Sign in with Microsoft." The user authenticates at the provider,
which returns an OIDC ID token; the app verifies the signature against
Google's JWKS, checks that `iss` is Google, that `aud` is the app's own
client id, and that the token hasn't expired, then creates a local
session. The app never stores a password and inherits the provider's
MFA and anomaly detection for free.

**Enterprise B2B single sign-on.** A vendor sells to enterprises whose
IT teams run Okta or Azure AD. Each customer configures SAML (or OIDC)
so their employees reach the vendor's app through corporate SSO. When
someone leaves the company, IT disables them once in the central
directory and access to the vendor's app — and every other federated
tool — is cut off, without the vendor touching anything. Group claims in
the assertion drive role mapping inside the app.

**Cross-service token propagation behind a gateway.** A microservices
platform puts an [API gateway](/docs/patterns/api-edge/api-gateway) at
the edge that verifies the IdP-issued access token once (audience,
issuer, signature, expiry) and forwards the trusted identity downstream.
Backends don't each re-verify against the IdP; the gateway offloads that
work, while the IdP remains the single authority that authenticated the
user — federation and
[gateway offloading](/docs/patterns/api-edge/gateway-offloading)
working together.

## Production libraries & getting started

Federated identity is adopted at two layers: an identity provider (IdP)
that authenticates users and issues tokens, and a client-side OIDC/OAuth2
library that runs the flow and — critically — verifies tokens correctly.
Both are listed below; the client libraries are what implement the
signature, issuer, audience, and expiry checks the pattern hinges on.

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| Keycloak | Java (self-hosted IdP) | Open-source OIDC/SAML IdP with SSO, federation, and user management | [Getting started](https://www.keycloak.org/getting-started/getting-started-docker) |
| Auth0 | Managed service | Hosted IdP with social login, enterprise SSO, and rules | [Getting started](https://auth0.com/docs/get-started) |
| Okta | Managed service | Enterprise IdP for workforce and customer SSO | [Getting started](https://developer.okta.com/docs/guides/) |
| AWS Cognito | Managed service | AWS-native user pools and identity federation | [Getting started](https://docs.aws.amazon.com/cognito/latest/developerguide/what-is-amazon-cognito.html) |
| Ory (Hydra / Kratos) | Go (self-hosted) | Composable OAuth2/OIDC server (Hydra) and identity management (Kratos) | [Getting started](https://www.ory.sh/docs/welcome) |
| Authentik | Python (self-hosted IdP) | Open-source IdP supporting OIDC, SAML, and SCIM | [Getting started](https://docs.goauthentik.io/docs/) |
| passport.js | JS/TS | Pluggable auth middleware with OIDC/OAuth2 strategies | [Getting started](https://www.passportjs.org/) |
| openid-client | JS/TS | Certified OIDC relying-party client with correct token validation | [Getting started](https://github.com/panva/openid-client) |
| golang.org/x/oauth2 | Go | Standard OAuth2 client for Go token flows | [Getting started](https://pkg.go.dev/golang.org/x/oauth2) |
| Authlib | Python | OAuth2/OIDC client and provider building blocks | [Getting started](https://docs.authlib.org/en/latest/) |
| openidconnect | Rust | Strongly-typed OIDC relying-party library with JWKS verification | [Getting started](https://docs.rs/openidconnect/latest/openidconnect/) |

**Example / reference:** [OpenID Connect Core 1.0 — OpenID Foundation](https://openid.net/specs/openid-connect-core-1_0.html)

## Related patterns

- [API Gateway](/docs/patterns/api-edge/api-gateway) — a common place
  to enforce federated authentication centrally, validating the
  identity provider's token once at the edge rather than in every
  backend service individually.
- [Gateway Offloading](/docs/patterns/api-edge/gateway-offloading) —
  the pattern for centralizing token verification (and other
  cross-cutting concerns) at the edge; complementary to federation,
  which decides *who* issued the token in the first place.
- [Valet Key](/docs/patterns/api-edge/valet-key) — the sibling that
  grants scoped access to a *resource* rather than establishing
  *identity*; both hand a client a signed, expiring token, but for
  different jobs.
- [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) — the
  general pattern for handling a dependency, like an identity provider,
  that becomes slow or unavailable; relevant context for why federated
  identity's dependency on an external IdP is a real availability
  tradeoff, not just a security one.

## Further reading

- [OpenID Connect Core 1.0 — OpenID Foundation](https://openid.net/specs/openid-connect-core-1_0.html)
- [The OAuth 2.0 Authorization Framework — RFC 6749](https://datatracker.ietf.org/doc/html/rfc6749)
- [JSON Web Token (JWT) — RFC 7519](https://datatracker.ietf.org/doc/html/rfc7519)
- [JSON Web Key (JWK) — RFC 7517](https://datatracker.ietf.org/doc/html/rfc7517)
- [Federated Identity pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/federated-identity)
- [Federated identity — Wikipedia](https://en.wikipedia.org/wiki/Federated_identity)
