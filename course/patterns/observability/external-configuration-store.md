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

## How it works

Configuration values move out of the application package and into a
dedicated store — a key-value service, a dedicated configuration
management product, or a database table built for exactly this — that
every instance of the application reads from rather than reading from
local files or baked-in environment variables. On startup, an instance
fetches its current configuration from the store; the harder design
question is what happens when a value changes *after* startup. If the
application only reads configuration once, at boot, a config update
still requires restarting every instance to take effect — which is
better than a redeploy but still not a live change. To get an actual
live update, the application needs an explicit mechanism to detect and
reload configuration changes without restarting: polling the store
periodically, or subscribing to a push/watch mechanism the store
provides, and swapping in the new values while running. That
capability has to be built deliberately; it doesn't come for free just
by moving config to an external store.

The tradeoff this pattern introduces is a new critical runtime
dependency: the configuration store itself now has to be available and
fast, because every instance depends on it, at least at startup and
possibly continuously if changes need to be picked up live. If the
store is unreachable, every instance either fails to start or — in a
better-designed system — falls back to its last-known-good configuration
cached locally, but that fallback logic has to be built in, not assumed.

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

The snippet below models the reload behavior a config-store client needs
to actually pick up changes live, rather than only reading configuration
once at startup.

```rust
use std::collections::HashMap;

struct ConfigStore {
    values: HashMap<String, String>,
    version: u32,
}

impl ConfigStore {
    // Simulates fetching the current snapshot from the external store.
    fn fetch(&self) -> (HashMap<String, String>, u32) {
        (self.values.clone(), self.version)
    }
}

struct AppConfig {
    cached: HashMap<String, String>,
    last_seen_version: u32,
}

impl AppConfig {
    fn new() -> Self {
        AppConfig { cached: HashMap::new(), last_seen_version: 0 }
    }

    // Called at boot, and again on each poll — a config store only
    // delivers live updates if the app actually re-reads it like this.
    fn reload_if_changed(&mut self, store: &ConfigStore) -> bool {
        let (values, version) = store.fetch();
        if version == self.last_seen_version {
            return false; // nothing changed since last read
        }
        self.cached = values;
        self.last_seen_version = version;
        true
    }

    fn get(&self, key: &str) -> Option<&String> {
        self.cached.get(key)
    }
}
```

`reload_if_changed` is the mechanism that turns a one-time boot-time
read into a live update: without a poll (or push-based equivalent)
calling it periodically, a config store update wouldn't reach a
running instance until its next restart.

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

## Real-world example

A microservices fleet stores database connection strings, external API
keys, and per-environment tunables in a centralized service like AWS
Systems Manager Parameter Store or HashiCorp Consul's key-value store.
Each service instance reads its configuration from the store at
startup and polls periodically for changes, so an operator can update a
timeout value for every running instance without rebuilding or
redeploying a single container.

## Related patterns

- [Feature Flags](/docs/patterns/observability/feature-flags) — a
  narrower, more targeted sibling pattern focused on per-user or
  gradual-rollout control over a single feature, often built on top of
  a configuration store as its storage layer.

## Further reading

- [External Configuration Store pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/external-configuration-store)
- [Configuration management — Wikipedia](https://en.wikipedia.org/wiki/Configuration_management)
