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

## How it works

Instead of prompting for and storing a password itself, the
application redirects the user to an external identity provider (an
OAuth2/OIDC provider like Google or Okta, or a SAML identity provider)
to authenticate. The user logs in with the identity provider directly
— the application never sees their password. The identity provider
then returns a signed token (an OIDC ID token, a SAML assertion) back
to the application, attesting to who the user is and, optionally, what
claims (email, group membership, roles) apply to them. The application
verifies the token's signature and expiry, and from then on treats the
user as authenticated based on that token, without ever having stored
or checked a credential itself.

## Code example

The snippet below shows the core of the trust decision: given a token
from an identity provider, verify it and extract the authenticated
identity, without the application ever handling a password.

```rust
struct IdentityToken {
    issuer: String,
    subject: String,
    email: String,
    signature: String,
    expires_at: u64,
}

struct AuthenticatedUser {
    subject: String,
    email: String,
}

const TRUSTED_ISSUERS: &[&str] = &["https://idp.example.com"];

fn verify_signature(token: &IdentityToken) -> bool {
    // Stand-in for real signature verification against the issuer's
    // published public key (JWKS for OIDC, X.509 cert for SAML).
    !token.signature.is_empty()
}

fn authenticate(token: IdentityToken, now: u64) -> Result<AuthenticatedUser, &'static str> {
    if !TRUSTED_ISSUERS.contains(&token.issuer.as_str()) {
        return Err("untrusted issuer");
    }
    if token.expires_at <= now {
        return Err("token expired");
    }
    if !verify_signature(&token) {
        return Err("invalid signature");
    }

    Ok(AuthenticatedUser { subject: token.subject, email: token.email })
}
```

The application's entire authentication logic reduces to checking
issuer, expiry, and signature on a token it received — it never
receives, hashes, or stores a password for any user.

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

## Real-world example

"Sign in with Google," "Sign in with Microsoft," and similar
OAuth2/OIDC login buttons are federated identity in its most visible
consumer form. In enterprise settings, SAML-based single sign-on
through providers like Okta or Azure AD lets an organization's IT team
manage employee access to many third-party applications from one
central identity source, without each application maintaining its own
password database.

## Related patterns

- [API Gateway](/docs/patterns/api-edge/api-gateway) — a common place
  to enforce federated authentication centrally, validating the
  identity provider's token once at the edge rather than in every
  backend service individually.
- [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) — the
  general pattern for handling a dependency, like an identity provider,
  that becomes slow or unavailable; relevant context for why federated
  identity's dependency on an external IdP is a real availability
  tradeoff, not just a security one.

## Further reading

- [Federated identity — Wikipedia](https://en.wikipedia.org/wiki/Federated_identity)
- [Federated Identity pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/federated-identity)
