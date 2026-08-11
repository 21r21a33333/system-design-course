---
title: "API Versioning"
sidebar_position: 11
supplementary: true
---

API versioning is the practice of labeling breaking changes to an
API's contract with an explicit version identifier, so existing
clients keep working against the behavior they were built for while
new clients can opt into the changed behavior on their own schedule.

![API Versioning diagram](/img/patterns/api-versioning.svg)

## Problem it solves

An API is a contract: callers write code against a specific set of
endpoints, request shapes, and response fields, and that code keeps
working only as long as the server honors what it promised. Software
evolves, though — a field needs to be renamed, a response needs to
carry a new required attribute, a whole endpoint needs to change shape
to support a feature that wasn't anticipated at launch. If a team
edits the live API in place with no versioning, every one of those
changes is a live, unannounced, and unopt-in-able break for every
caller currently depending on the old shape — mobile apps that can't
be force-upgraded instantly, partner integrations run by other
companies, internal services owned by other teams, all fail
simultaneously and without warning the moment the change ships.
Versioning turns that into a coordinated, opt-in transition: old and
new contracts are both served side by side for a period, existing
callers keep working exactly as before, and each caller migrates to
the new contract on a timeline the API owner and the caller agree on
rather than one forced by a deploy.

## Technical architecture & implementation

**Where the version lives.** There are three common places to encode
a version, and they trade discoverability against cacheability and
routing simplicity. A **URI path version** (`/v2/orders`) is the most
visible and the easiest to route on — a gateway or reverse proxy can
dispatch purely on path prefix with no need to inspect headers or
body — and it's trivially cacheable by any HTTP cache since the URL
itself is the cache key, but it means the resource technically has a
different identity per version, which purists object to. A **header
version** (a custom `Api-Version: 2` header, or a versioned `Accept`
header like `Accept: application/vnd.example.v2+json`) keeps the URL
stable across versions, which fits REST's idea that a resource's
identity shouldn't change just because its representation does, but
it requires every layer in the path — gateways, CDNs, caches — to be
configured to route and cache on that header rather than the URL
alone, which is easy to misconfigure. A **query-parameter version**
(`/orders?version=2`) is easy to add retroactively without changing
path structure, but it's the easiest to omit by accident since it's
just another optional parameter, silently defaulting callers to
whatever version the server treats as default.

| Placement | Example | URL stable across versions? | Cache-key friendly? | Easiest to omit by accident? |
| --- | --- | --- | --- | --- |
| URI path | `/v2/orders` | No — each version is a distinct URL | Yes — URL is the cache key | No — the prefix is mandatory |
| Header / media type | `Api-Version: 2` or `Accept: …vnd.example.v2+json` | Yes | Only if caches vary on the header | Somewhat — a missing header silently defaults |
| Query parameter | `/orders?version=2` | Mostly (path unchanged) | Yes, but the param must be in the key | Yes — just another optional param |

Real public APIs split across these approaches in ways that illustrate
the trade-offs concretely. X's (formerly Twitter's) API puts the
version directly in the path (`/2/tweets`), the URI-path approach's
canonical form. Stripe and GitHub both take the header route instead,
but with a twist on the usual major-version-number scheme: each uses a
dated version string (Stripe's `Stripe-Version` header, GitHub's
`X-GitHub-Api-Version` header, both carrying values like `2024-06-20`)
rather than an incrementing integer, so a "version" is really a
specific release date's contract, and an account or request that omits
the header falls back to a configured default rather than the latest
version — the same "easy to omit, silently defaults" risk header-based
versioning carries in general, just with a date string standing in for
a version number.

**Backward compatibility inside a version.** Not every change needs a
new version at all — the discipline that makes versioning tractable
is distinguishing additive, backward-compatible changes (a new
optional field, a new endpoint) from breaking ones (removing or
renaming a field, changing a field's type, changing required
parameters). Well-behaved clients ignore fields they don't recognize,
so additive changes can ship into an existing version with no
migration required; only genuinely breaking changes justify the cost
of a new version, a deprecation window, and a coordinated client
migration. Teams that version too eagerly — bumping the major version
for every additive change — end up running far more parallel
versions than necessary, each with its own maintenance burden.

**Deprecation and sunset.** A new version being available doesn't
retire the old one by itself; the old version has to keep being
served, monitored for remaining traffic, and eventually shut off on a
schedule communicated well in advance — commonly signaled with a
`Deprecation` or `Sunset` HTTP response header so automated tooling
and not just documentation can detect the coming cutoff. Running N
versions simultaneously multiplies the surface a team has to keep
correct, secure, and monitored, which is why the sunset step, not just
the launch of the new version, is the part of versioning that
actually reduces long-term cost — a version that's introduced but
never retired is pure ongoing overhead with none of the benefit.

**API Versioning vs. Gateway Routing.** These are adjacent but
distinct: [Gateway Routing](/docs/patterns/api-edge/gateway-routing)
is about directing a request to the correct *backend service* based
on path, header, or other request attributes — it's a general request-
dispatch mechanism that has nothing to do with a contract having
multiple compatible shapes over time. API versioning is routinely
*implemented* using the same mechanism (a gateway routing `/v1/*` to
one backend and `/v2/*` to another is gateway routing in service of
versioning), but the concept itself is about contract evolution and
client compatibility, not about how a request happens to get
dispatched — a system could version its API using a single backend
that branches internally on a header, with no gateway-level routing
involved at all.

## Code example

```rust
#[derive(Clone, Copy, PartialEq, Debug)]
enum ApiVersion {
    V1,
    V2,
}

#[derive(Debug)]
enum VersionError {
    Unsupported(String),
    Sunset(ApiVersion),
}

// Parses a version out of a URI path prefix — one of the three common
// places a version can be encoded, alongside a header or query param.
fn parse_version(path: &str) -> Result<ApiVersion, VersionError> {
    match path.split('/').nth(1) {
        Some("v1") => Ok(ApiVersion::V1),
        Some("v2") => Ok(ApiVersion::V2),
        Some(other) => Err(VersionError::Unsupported(other.to_string())),
        None => Err(VersionError::Unsupported(String::new())),
    }
}

// V1 has passed its announced sunset date: it's still routable, but
// requests are rejected rather than served, forcing remaining
// stragglers to finish migrating.
fn dispatch(path: &str, sunset: &[ApiVersion]) -> Result<&'static str, VersionError> {
    let version = parse_version(path)?;
    if sunset.contains(&version) {
        return Err(VersionError::Sunset(version));
    }
    match version {
        ApiVersion::V1 => Ok("handled by legacy order handler"),
        ApiVersion::V2 => Ok("handled by current order handler"),
    }
}
```

`parse_version` isolates where the version identifier is read from —
here a path prefix — from `dispatch`'s routing decision, and the
`sunset` check models the fact that a version being parseable doesn't
mean it's still being served; a version can be recognized and still
rejected once its deprecation window has closed.

## When to use it

- The API has external callers — mobile clients, partners, third-party
  integrators — that can't be force-upgraded the instant a breaking
  change ships, so old and new behavior genuinely need to coexist.
- Breaking changes to request or response shape are anticipated as the
  product evolves, and callers need a predictable, opt-in way to adopt
  them rather than being broken without notice.
- Multiple client generations (an old mobile app version still in use
  by some fraction of users, alongside the current one) must be
  supported simultaneously against the same backend.

## When not to use it

- The API is purely internal, deployed and consumed by the same team
  in lockstep with no independent release cycles — coordinating a
  single simultaneous deploy is simpler than standing up parallel
  versions.
- Changes so far have all been additive (new optional fields, new
  endpoints) with no client-visible breakage — introducing version
  numbers preemptively adds overhead without a breaking change to
  justify it yet.
- The team can't commit to actually deprecating and sunsetting old
  versions — versioning without a retirement discipline just
  accumulates permanent parallel maintenance burden instead of
  providing a real migration path.

## Use-case scenarios

**Public payments API serving external merchants.** A payments
provider ships a v2 API that changes how refund objects are shaped.
Existing merchant integrations keep calling `/v1/refunds` unaffected
while new integrations build against `/v2/refunds`; the provider
publishes a `Sunset` header and a fixed retirement date on v1,
giving merchants a concrete deadline to migrate before it's shut off.

**Mobile app with staggered client upgrades.** A consumer app's
backend has to support the currently shipping app version and at
least the previous two, since app-store review delays and users who
don't auto-update mean multiple client versions are in the wild at
once. The backend keeps parallel versioned endpoints active for as
long as meaningful traffic from older app versions persists, tracked
via request telemetry per version rather than a guess.

**Internal platform team serving many downstream teams.** A platform
team owns a shared internal service consumed by a dozen other teams'
services. Even though every caller is internal, the teams don't
deploy in lockstep, so the platform team still versions breaking
changes and gives consuming teams a migration window — treating
internal callers with the same compatibility discipline as external
ones because the coordination cost of a surprise break is just as
real inside the organization.

## Production libraries & getting started

Versioning is mostly convention plus routing: you carry a version in
the path, header, or query param and dispatch on it. Web frameworks
don't offer a dedicated "versioning" primitive so much as route
grouping/nesting you mount a version prefix onto, so these are the
framework routing tools you'd build versioned APIs with, plus the REST
guidance that governs how to place and sunset a version.

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| Express Router | JS/TS | Mountable routers to isolate `/v1` and `/v2` route trees | [Getting started](https://expressjs.com/en/guide/routing.html) |
| FastAPI `APIRouter` | Python | Sub-routers with a version prefix for splitting versioned endpoints | [Getting started](https://fastapi.tiangolo.com/tutorial/bigger-applications/) |
| chi | Go | Composable route groups and sub-routers to mount per-version | [Getting started](https://go-chi.io/#/pages/routing) |
| gin `RouterGroup` | Go | Route grouping to nest a version prefix over a set of handlers | [Getting started](https://pkg.go.dev/github.com/gin-gonic/gin#RouterGroup) |
| axum `Router::nest` | Rust | Nested routers to compose a versioned sub-API under a path | [Getting started](https://docs.rs/axum/latest/axum/struct.Router.html#method.nest) |

**Example / reference:** [Versioning a RESTful web API — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/best-practices/api-design)

## Related patterns

- [Gateway Routing](/docs/patterns/api-edge/gateway-routing) — the
  request-dispatch mechanism commonly used to implement versioning
  (routing `/v1/*` and `/v2/*` to different backends), but a distinct
  concept from versioning itself, which is about contract evolution
  and client compatibility rather than how a request gets dispatched.
- [Backend for Frontend](/docs/patterns/api-edge/backend-for-frontend) —
  addresses different client *types* needing different response
  shapes at the same point in time; versioning addresses the same
  client type needing a stable shape across *time* as the API evolves.
- [API Gateway](/docs/patterns/api-edge/api-gateway) — the layer that
  typically enforces versioning consistently in one place, alongside
  auth and rate limiting, rather than each backend service
  implementing its own version-parsing logic.

## Further reading

- [Software versioning — Wikipedia](https://en.wikipedia.org/wiki/Software_versioning)
- [Web API design best practices — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/best-practices/api-design#versioning-a-restful-web-api)
- DesignGurus' System Design Patterns course covers this as "API Versioning" in its The Entry Point (API and Edge) module.
- [System Design roadmap — roadmap.sh](https://roadmap.sh/system-design) — includes API Versioning as a named topic.
- [RFC 8594: The Sunset HTTP Header Field — IETF](https://www.rfc-editor.org/rfc/rfc8594)
- [RFC 9745: The Deprecation HTTP Response Header Field — IETF](https://www.rfc-editor.org/rfc/rfc9745)
