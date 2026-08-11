---
title: "Service Discovery"
sidebar_position: 12
supplementary: true
---

Service discovery is the mechanism by which a caller finds the
current network location of a live, healthy instance of a service it
wants to talk to, without that location being hardcoded or manually
configured in advance.

![Service Discovery diagram](/img/patterns/service-discovery.svg)

## Problem it solves

In any system where services run as multiple, changing instances —
scaled up and down with load, replaced on deploys, restarted after
crashes, rescheduled by an orchestrator onto different hosts — the
network address of "the orders service" isn't a fixed thing. A
particular instance might live at one IP address this minute and a
different one five minutes from now, and the total count of instances
might change between requests too. If a caller has to know these
addresses in advance — hardcoded in configuration, baked into a
deploy — every scaling event, restart, or rescheduling becomes a
configuration update that has to reach every caller before it's safe,
which doesn't scale past a small, static handful of services and
defeats the purpose of dynamic infrastructure in the first place.
Service discovery solves this by giving callers a way to ask "who is
currently a healthy instance of service X" at call time, so the
answer can change freely underneath them without any caller-side
reconfiguration.

## Technical architecture & implementation

**Registration.** Something has to know which instances currently
exist and where they are. In a **self-registration** model, each
service instance announces itself to a registry directly on startup
and de-registers (or lets a lease expire) on shutdown — simple, but it
puts the registration logic inside every service. In **third-party
registration**, an external agent — the platform or orchestrator
managing deployments — registers and deregisters instances on the
service's behalf as it starts and stops them, keeping that logic out
of application code entirely and centralizing it in the platform
layer instead. Either way, the registry only stays accurate if
instances that die ungracefully (crash without a clean shutdown) are
also removed — which is why registration is paired with...

**Health checking.** A registry entry that's never validated after
creation goes stale the moment an instance quietly dies without
deregistering, and callers routed to it get connection failures
instead of a working service. Discovery systems address this with
periodic health checks — the registry (or the platform managing it)
probes each registered instance and removes or marks unhealthy any
instance that stops responding, on essentially the same detect-and-
threshold logic used by [Failover](/docs/patterns/reliability/failover):
a single missed check is treated as a possible transient blip, and an
instance is only pulled from the pool of discoverable addresses after
sustained, repeated failure.

**Lookup — client-side vs. server-side.** Once a registry exists,
callers need a way to consult it, and there are two shapes this
commonly takes. In **client-side discovery**, the calling service
queries the registry directly, gets back a list of currently healthy
instance addresses, and picks one itself (applying its own
load-balancing choice among them) before making the call — this keeps
the registry out of the request's data path but means every client
needs registry-aware logic. In **server-side discovery**, the caller
sends its request to a stable intermediary (a load balancer or
routing layer) that itself queries the registry and forwards the
request to a chosen instance — the caller only ever needs to know the
one stable address of that intermediary, never the registry, at the
cost of that intermediary being an extra hop and a component that has
to stay available.

HashiCorp Consul and etcd are two widely deployed examples of the
registry itself: Consul combines a service registry with built-in
health checking and a DNS/HTTP lookup interface, while etcd is a
distributed key-value store (Kubernetes uses it internally) that
services can watch for changes, making it a common building block for
teams that implement discovery on top of a general-purpose consistent
store rather than a purpose-built registry.

**Propagation delay as a failure mode.** Every discovery mechanism has
some lag between an instance's real status changing and every
caller's view of the registry reflecting that change — a new instance
might not be discoverable for a moment after starting, and a dying
instance might still be handed out for a moment after it stops
responding. Systems that assume the registry is instantaneously
accurate will occasionally route to an instance that's just gone away,
which is why callers built on top of service discovery still need
ordinary connection-level retry logic — discovery reduces how often a
caller reaches a dead instance, it doesn't reduce it to zero.

**Service Discovery vs. Service Mesh vs. Sidecar.** These three are
frequently mentioned together and it's easy to conflate them, but they
sit at different levels of the same problem. Service discovery is the
general *problem statement*: given a service name, find a live
instance's address. [Sidecar](/docs/patterns/api-edge/sidecar) is a
*deployment mechanism* — a helper process running alongside an
application instance — that happens to be one common place to
implement client-side discovery logic (the sidecar queries the
registry and picks an instance on the application's behalf, so the
application itself only ever talks to its local sidecar).
[Service Mesh](/docs/patterns/api-edge/service-mesh) is a specific,
much broader *infrastructure layer* built from a fleet of exactly
those sidecars plus a control plane, and service discovery is only one
of several things it provides alongside mTLS, retries, and traffic
shaping — a service mesh subsumes service discovery as one of its
capabilities, but plenty of systems solve service discovery on its own
(a DNS-based registry, a dedicated discovery service) with no mesh,
and no sidecars, involved at all.

## Code example

```rust
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq)]
enum InstanceHealth {
    Healthy,
    Unhealthy,
}

#[derive(Clone, Debug)]
struct Instance {
    address: String,
    health: InstanceHealth,
}

// The registry maps a service name to every instance that has
// registered for it, healthy or not.
struct Registry {
    entries: HashMap<String, Vec<Instance>>,
}

impl Registry {
    fn register(&mut self, service: &str, address: &str) {
        self.entries.entry(service.to_string()).or_default().push(Instance {
            address: address.to_string(),
            health: InstanceHealth::Healthy,
        });
    }

    // A health check flips an instance's status without removing its
    // registration outright — a transient failure shouldn't require
    // re-registering from scratch once the instance recovers.
    fn mark(&mut self, service: &str, address: &str, health: InstanceHealth) {
        if let Some(instances) = self.entries.get_mut(service) {
            for instance in instances.iter_mut() {
                if instance.address == address {
                    instance.health = health.clone();
                }
            }
        }
    }

    // Client-side discovery: return every healthy instance and let
    // the caller pick one, rather than picking on the caller's behalf.
    fn discover(&self, service: &str) -> Vec<&str> {
        self.entries
            .get(service)
            .map(|instances| {
                instances
                    .iter()
                    .filter(|i| i.health == InstanceHealth::Healthy)
                    .map(|i| i.address.as_str())
                    .collect()
            })
            .unwrap_or_default()
    }
}
```

`discover` only ever returns instances currently marked healthy —
`mark` is what a periodic health-check loop would call in a real
system, pulling a dead instance out of the discoverable set without
erasing the fact that it's a known member of the service.

## When to use it

- Service instances are dynamic — autoscaled, rescheduled by an
  orchestrator, or frequently redeployed — so hardcoded addresses
  would go stale faster than they could reasonably be updated by
  hand.
- The system has enough independently deployed services that manually
  maintaining an up-to-date address list per caller has become
  error-prone or simply doesn't scale.
- New service instances need to become reachable automatically, without
  a manual configuration step, as part of normal scaling or deploys.

## When not to use it

- A small, static set of services with addresses that essentially
  never change — a hardcoded address or simple DNS A record is simpler
  and has nothing meaningful to gain from a dynamic registry.
- The deployment platform already provides equivalent functionality
  transparently — Kubernetes, for instance, gives every Service a
  stable internal DNS name backed by its own endpoint tracking, which
  is server-side discovery provided by the platform itself — building a
  separate, custom discovery layer on top would be redundant.
- The added lookup hop or registry dependency isn't acceptable for an
  extremely latency-sensitive call path, and a simpler static topology
  is an acceptable trade for that path specifically.

## Use-case scenarios

**Autoscaled microservices platform.** An e-commerce backend runs
dozens of services, each autoscaling independently between a handful
and a few hundred instances depending on load. Every instance
self-registers on startup and is health-checked continuously; other
services discover current healthy instances by service name rather
than any team maintaining a manually updated address list, which would
be obsolete within minutes of any scaling event.

**Blue-green deployment with instant cutover.** A team runs a new
"green" version of a service alongside the currently live "blue"
version during a deployment. Because callers discover instances by
service name rather than by a specific address baked into
configuration, cutting traffic from blue to green is a registry
update — deregistering blue instances and registering green ones —
with no caller-side redeploy needed to pick up the new instances.

**IoT fleet with intermittently connected devices.** A fleet-management
backend for field devices needs to route commands to whichever backend
worker currently holds a live connection to a given device, and that
mapping changes constantly as devices connect, disconnect, and
reconnect to different workers. Each worker registers the specific
device IDs it currently holds a connection for for as long as that
connection stays open, and the routing layer discovers the correct
worker per command at call time rather than assuming any static
device-to-worker assignment.

## Related patterns

- [Service Mesh](/docs/patterns/api-edge/service-mesh) — a broader
  infrastructure layer that includes service discovery as one of
  several capabilities (alongside mTLS, retries, traffic shaping),
  built from a fleet of sidecars plus a control plane; not a
  replacement term for discovery itself.
- [Sidecar](/docs/patterns/api-edge/sidecar) — a deployment mechanism
  that's one common place to implement client-side discovery logic,
  but the sidecar pattern is general-purpose and not specific to
  discovery.
- [Load Balancing](/docs/patterns/api-edge/load-balancing) — often
  paired with server-side discovery, where the load balancer is the
  stable address callers use and it queries the registry internally
  to pick which discovered instance actually receives each request.
- [Load Balancer — concept overview](/docs/concepts/load-balancer) —
  this site's earlier primer-derived treatment of a related routing
  mechanism, for further background.

## Further reading

- [Service discovery — Wikipedia](https://en.wikipedia.org/wiki/Service_discovery)
- [Service Fabric naming service (service discovery concepts) — Microsoft Learn](https://learn.microsoft.com/en-us/azure/service-fabric/service-fabric-connect-and-communicate-with-services)
- [System Design roadmap — roadmap.sh](https://roadmap.sh/system-design) — includes Service Discovery as a named topic.
