---
title: "External Configuration Store"
sidebar_position: 6
supplementary: true
---

An external configuration store moves an application's configuration —
connection strings, tunable parameters, environment-specific settings —
out of its deployment package and into a centralized store that can be
read, and updated, independently of a redeploy.

![External Configuration Store diagram](/img/patterns/external-configuration-store.svg)

## Problem it solves

Configuration bundled inside a deployment artifact (a config file baked
into a container image, environment variables fixed at deploy time)
means any change to that configuration — a new connection string, a
tuned timeout, a different retry count — requires a full redeploy just
to pick it up, even though no code changed at all. That's slow for
routine tuning, and it's actively dangerous during an incident: an
operator who needs to change one timeout value under pressure shouldn't
have to build and roll out a new deployment to do it. It also fragments
configuration across every service's own package, making it hard to see
or audit what's currently configured across a fleet without inspecting
each deployment individually. An external configuration store fixes
both problems by holding configuration in one centralized place, outside
any single deployment artifact, that can be read at startup or updated
live and inspected independently of what's currently deployed.

## Technical architecture & implementation

**The store and the read path.** Configuration values move out of the
application package into a dedicated store — a purpose-built
configuration service, a key-value/coordination service, or a database
table designed for exactly this — that every instance reads from instead
of from local files or baked-in environment variables. On startup an
instance fetches its current configuration; the values are typically
namespaced by environment and by service so one store can serve an
entire fleet without collisions. A local in-memory cache of the last
successful read is essential: it makes reads O(1) at request time and,
just as importantly, is what the instance falls back to when the store
is unreachable.

**Static read vs. dynamic reload.** The hard design question is what
happens when a value changes *after* startup. If the application reads
configuration only once, at boot, a change still requires restarting
every instance to take effect — better than a redeploy, but not a live
change. To get a genuine live update, the app needs an explicit
mechanism to detect and apply changes without restarting. Two shapes are
common: **polling** (re-read the store on an interval and diff against
the last-seen version) and **watch/push** (subscribe to the store, which
notifies instances the moment a key changes). Polling is simpler and
degrades gracefully; watch is near-instant but couples the app to a
store that supports change notification. Either way the app swaps in the
new values atomically while serving, so an in-flight request never sees a
half-updated config.

**Versioning, rollback, and change consistency.** A production config
store should be *versioned*: every write produces a new immutable
version, so a bad change can be rolled back to a known-good prior
version instantly — the same "undo" safety a redeploy pipeline has, but
in seconds. Versioning also solves a subtle distributed problem:
**consistency of a change across many instances**. Instances poll or get
notified at slightly different moments, so for a short window some run
version N and some run N+1. For an independent scalar (a timeout) that's
harmless; for a set of values that must change *together* (a new
endpoint plus its new credential), a naive key-by-key update can leave an
instance briefly reading a mismatched pair. The fix is to make a related
group of values a single versioned unit — instances read the whole
snapshot atomically and only ever see version N or N+1, never a mix.

**Secrets belong in a separate store.** Connection strings, API keys, and
certificates are configuration too, but they carry a different threat
model — they must be encrypted at rest, tightly access-controlled, and
audited on every read. The standard practice is to keep secrets in a
dedicated **secret store** (a vault) rather than the general config
store, with the config store holding a *reference* to the secret rather
than its plaintext value. This keeps least-privilege boundaries and
rotation policies where they belong and avoids leaking credentials into
config dumps, logs, or diffs.

**Failure modes.** The pattern introduces a new critical runtime
dependency: the store must be available and fast because every instance
depends on it, at startup and continuously if changes are picked up
live. The mitigations are non-negotiable in production. *Last-known-good
fallback*: on a fetch failure, keep serving the cached config rather than
crashing or blanking settings — an outage of the config store should not
become an outage of the application. *Monotonic version guards*: only
apply a strictly newer version, so a stale or partial read can't silently
roll config backward. *A bad-config blast radius*: because one edit
propagates to every instance within seconds, a single fat-fingered value
can take down the whole fleet at once — which is exactly why versioning
with instant rollback, validation on write, and staged propagation
matter. Treat a config change with the same care as a deploy, because
operationally it now *is* one.

### How this differs from Feature Flags

[Feature Flags](/docs/patterns/observability/feature-flags) and an
external configuration store both let a value be changed without a
redeploy, but they're built for different-shaped problems. A feature
flag is specifically about gating a discrete feature on or off, usually
per-user, per-cohort, or as a percentage rollout — its whole value
proposition is *gradual, targeted* control over who sees what. An
external configuration store is broader and flatter: it holds any
tunable value an application needs — a connection string, a timeout, a
cache TTL, a retry count — and those values are typically applied
uniformly, all-or-nothing, per environment (every instance in
production reads the same connection string) rather than varied
per-user or rolled out gradually. Put differently, a feature flag
answers "should *this user* see *this feature*?" while a configuration
store answers "what value should *every instance in this environment*
use for *this setting*?" — a feature-flagging system is frequently
*built on top of* an external configuration store as its underlying
storage layer, but solves a narrower, more targeted problem than the
store itself does.

## Code example

The snippet below models the three behaviors a production config-store
client needs beyond a naive one-time read: **live reload** with a
monotonic version guard, **last-known-good fallback** when the store is
unreachable, and a **layered override** so a specific environment or
tenant can differ from the base without a separate store.

```rust
use std::collections::HashMap;

// A versioned snapshot of configuration as held by the external store.
#[derive(Clone)]
struct Snapshot {
    values: HashMap<String, String>,
    version: u32,
}

// Stand-in for the external store. `fetch` returns None to model the store
// being unreachable — the case a real client must survive.
struct ConfigStore {
    current: Option<Snapshot>,
}

impl ConfigStore {
    fn fetch(&self) -> Option<Snapshot> {
        self.current.clone()
    }
}

struct AppConfig {
    // Base values plus a per-environment/tenant override layer resolved on
    // top of them, so a specific tenant can differ without a separate store.
    base: Snapshot,
    overrides: HashMap<String, String>,
    // Last-known-good: retained so a store outage never blanks live config.
    last_good_version: u32,
}

impl AppConfig {
    fn new(initial: Snapshot, overrides: HashMap<String, String>) -> Self {
        let v = initial.version;
        AppConfig { base: initial, overrides, last_good_version: v }
    }

    // Called at boot and on every poll. On a store outage (None) it keeps
    // serving the last-known-good snapshot rather than failing. Only a
    // strictly newer version is swapped in, so a stale read can't roll back.
    fn reload(&mut self, store: &ConfigStore) -> bool {
        match store.fetch() {
            None => false, // store unreachable: keep last-known-good
            Some(snap) if snap.version > self.last_good_version => {
                self.last_good_version = snap.version;
                self.base = snap;
                true
            }
            Some(_) => false, // same or older version: nothing to apply
        }
    }

    // Override layer wins over the base layer; base wins over nothing.
    fn get(&self, key: &str) -> Option<&String> {
        self.overrides.get(key).or_else(|| self.base.values.get(key))
    }
}
```

`reload` is the mechanism that turns a one-time boot read into a live
update — but note the two guards that make it safe: a `None` from the
store leaves the last-known-good snapshot in place (an unreachable store
doesn't blank the app's config), and the `snap.version > last_good_version`
check means only a strictly newer version is ever applied, so a stale or
out-of-order read can't silently roll configuration backward. `get`
resolves the override layer first, giving per-environment or per-tenant
values without a second store.

## When to use it

- Configuration needs to change (tuning a timeout, rotating a
  connection string, adjusting a retry policy) without requiring a full
  redeploy of the application.
- Many instances or services need a single, consistent, centrally
  auditable source of truth for their configuration, rather than each
  carrying its own copy.
- Fast, live response to a configuration change — during an incident,
  for instance — is more valuable than the operational simplicity of
  configuration bundled with each deploy.

## When not to use it

- Configuration genuinely only changes alongside code changes, and
  bundling it with the deploy is simpler and just as fast to update.
- The application can't tolerate the added runtime dependency and
  failure mode of an external store being unavailable, and has no good
  way to build a safe local fallback.
- What's actually needed is per-user or gradual-rollout control over a
  specific feature — that's the narrower problem [Feature
  Flags](/docs/patterns/observability/feature-flags) is built for.

## Use-case scenarios

**Microservices fleet with centralized tunables.** A fleet of services
stores database connection strings (as references into a secret vault),
external API endpoints, and per-environment tunables in a centralized
service such as AWS Systems Manager Parameter Store, Azure App
Configuration, or HashiCorp Consul's key-value store. Each instance reads
at startup and polls for changes, so an operator can adjust a timeout for
every running instance — during an incident, without rebuilding or
redeploying a single container — and roll it back to the prior version
just as fast if the change misbehaves.

**Live incident mitigation via dynamic reload.** A service under a
traffic spike is shedding load poorly because a retry count and a
concurrency limit are too aggressive. Rather than build and ship a new
release under pressure, an on-call engineer edits those values in the
config store; every instance watching the store picks up the new version
within seconds and re-tunes itself in place. Because the change is
versioned, if it makes things worse it is reverted with a single
rollback to the last-known-good version.

**Per-tenant and per-environment overrides.** A multi-tenant SaaS keeps a
base configuration plus layered overrides — one tenant needs a larger
upload limit, the EU environment needs a different regional endpoint. The
override layer is resolved on top of the base at read time, so the vast
majority of settings stay defined once while the handful that must differ
are expressed as targeted overrides rather than forked config files or
special-case code paths sprinkled through the application.

## Related patterns

- [Feature Flags](/docs/patterns/observability/feature-flags) — a
  narrower, more targeted sibling focused on per-user or gradual-rollout
  control over a single feature, often built *on top of* a configuration
  store as its storage layer.
- [Canary Deployment](/docs/patterns/observability/canary-deployment) —
  a config change propagates to the whole fleet at once, so staging that
  propagation (or gating a risky value behind a flag) borrows the same
  progressive-exposure discipline canary releases use for code.
- [Cache-Aside](/docs/patterns/caching/cache-aside) — the local
  last-known-good cache a config client keeps is a cache of the store's
  contents, with the store as the system of record behind it.
- [Sidecar](/docs/patterns/api-edge/sidecar) — a common deployment shape
  for config/secret retrieval: a co-located sidecar fetches, caches, and
  refreshes configuration on behalf of the application container.

## Further reading

- [External Configuration Store pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/external-configuration-store)
- [AWS Systems Manager Parameter Store — official docs](https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-parameter-store.html)
- [HashiCorp Consul: key/value store — official docs](https://developer.hashicorp.com/consul/docs/dynamic-app-config/kv)
- [Configuration management — Wikipedia](https://en.wikipedia.org/wiki/Configuration_management)
