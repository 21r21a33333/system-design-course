---
title: "Load Balancing"
sidebar_position: 13
supplementary: true
---

Load balancing distributes incoming requests across a pool of healthy
service instances, so that no single instance is overwhelmed while
others sit idle, and so that traffic automatically stops flowing to
any instance that stops being able to handle it.

![Load Balancing diagram](/img/patterns/load-balancing.svg)

## Problem it solves

A single instance of a service can only handle so much concurrent
work before request latency degrades and, eventually, requests start
failing outright. Running many instances behind a single entry point
addresses the raw capacity problem, but only if requests are actually
spread across those instances — if callers pick an instance
arbitrarily, or always the same one, some instances end up
overloaded while others do nothing, and the system gets none of the
capacity benefit its extra instances were supposed to provide. Worse,
if one of those instances crashes or becomes unresponsive, requests
that keep landing on it fail until something notices and stops
sending traffic there. Load balancing solves both problems in one
component: it spreads requests across the pool according to a
consistent policy, and it continuously tracks which instances are
actually healthy so unhealthy ones stop receiving traffic without a
human having to intervene.

## Technical architecture & implementation

**Layer 4 vs. Layer 7 balancing.** Where in the network stack a load
balancer makes its routing decision determines both what information
it can use and how much work it does per request. A transport-layer
(often called Layer 4) balancer looks only at IP addresses and ports —
it forwards packets to a chosen backend without parsing anything above
the transport layer, which makes it fast and protocol-agnostic but
blind to the actual content of a request. An application-layer (Layer
7) balancer terminates the connection, reads the request itself —
path, headers, cookies — and can route on that content: sending
`/video/*` to instances provisioned for media streaming and
`/api/billing/*` to a separate, more tightly secured pool, or reading
a session cookie to keep a given client pinned to the same backend
instance. That visibility costs more compute per request than
Layer 4's blind forwarding, but it's what enables any routing decision
smarter than pure load distribution.

**Distribution algorithms.** The policy that decides which specific
instance gets the next request has several common shapes. **Round
robin** cycles through instances in order, which is simple and works
well when every instance has similar capacity and every request costs
about the same to serve. **Least connections** sends each new request
to whichever instance currently has the fewest in-flight requests,
which adapts automatically to requests of uneven cost — an instance
stuck processing a few slow requests naturally receives fewer new
ones. **Weighted variants** of either bias the distribution toward
instances with more capacity, letting a heterogeneous pool (some
larger instances, some smaller) still be used proportionally instead
of treated as uniform. **Consistent hashing** on some request
attribute (a session ID, a cache key) routes the same input to the
same instance repeatedly, which matters when an instance holds
state — a local cache, an in-memory session — that's only useful if
the same client keeps landing there.

**Health checking and failure handling.** A load balancer is only as
good as its view of which instances are actually usable, so it
continuously probes each instance — a lightweight periodic request or
connection check — and stops routing to any instance that fails
enough consecutive checks, using the same threshold-based logic
described on the [Failover](/docs/patterns/reliability/failover) page
to avoid pulling an instance for a single transient blip. An instance
that's removed keeps being checked, and is added back automatically
once it passes health checks again, so recovery from a transient
failure (a restart, a brief network partition) requires no manual
re-registration. The load balancer itself is a concentration point
this whole scheme depends on — deployed singly, it becomes exactly the
kind of single point of failure the pattern exists to eliminate for
everything behind it, which is why production deployments commonly run
multiple load balancer instances themselves, coordinated the same way
any other critical, replicated component would be.

**Load Balancing vs. Rate Limiting.** These are frequently deployed at
the same point in a request path — often the same physical box or
gateway — and it's easy to think of them as the same concern, but they
solve different-shaped problems that compose rather than substitute
for each other. [Rate Limiter](/docs/patterns/building-blocks/rate-limiter)
caps *how much* traffic is allowed through in the first place, per
caller, protecting the system from any one client consuming more than
its fair share or than the system can absorb at all — it makes a
reject-or-allow decision before a request is even dispatched anywhere.
Load balancing operates on the traffic that's already been allowed
through: given a request that's going to be served, it decides *which*
healthy instance actually serves it, so the allowed volume is spread
evenly rather than concentrated. A system commonly needs both — rate
limiting to bound total admitted traffic to what the fleet can handle,
load balancing to spread that admitted traffic evenly across the fleet
that's handling it — and neither one does the other's job.

## Code example

```rust
#[derive(Clone, Debug, PartialEq)]
enum Health {
    Healthy,
    Unhealthy,
}

#[derive(Clone, Debug)]
struct Backend {
    address: String,
    health: Health,
    active_connections: u32,
}

struct LoadBalancer {
    backends: Vec<Backend>,
}

impl LoadBalancer {
    // Least-connections selection: route to whichever healthy backend
    // currently has the fewest in-flight requests, so slow requests on
    // one instance don't keep piling more work onto it.
    fn select(&self) -> Option<&Backend> {
        self.backends
            .iter()
            .filter(|b| b.health == Health::Healthy)
            .min_by_key(|b| b.active_connections)
    }

    fn on_request_start(&mut self, address: &str) {
        if let Some(b) = self.backends.iter_mut().find(|b| b.address == address) {
            b.active_connections += 1;
        }
    }

    fn on_request_end(&mut self, address: &str) {
        if let Some(b) = self.backends.iter_mut().find(|b| b.address == address) {
            b.active_connections = b.active_connections.saturating_sub(1);
        }
    }

    // A failed health check pulls a backend out of rotation without
    // removing it — it becomes eligible again once it passes checks.
    fn mark_unhealthy(&mut self, address: &str) {
        if let Some(b) = self.backends.iter_mut().find(|b| b.address == address) {
            b.health = Health::Unhealthy;
        }
    }
}
```

`select` only ever considers backends currently marked `Healthy`, and
picks among them by lowest `active_connections` rather than a fixed
rotation — `on_request_start`/`on_request_end` are what a real
balancer updates as requests actually begin and finish, keeping the
connection counts the selection depends on accurate.

## When to use it

- More than one instance of a service exists to handle load, and
  requests need to be spread across them rather than concentrated on
  whichever instance a caller happens to reach first.
- Individual instances fail or become temporarily unhealthy in the
  normal course of operation, and traffic needs to stop reaching a
  failed instance automatically rather than after a human notices.
- Instances have uneven capacity or requests have uneven cost, and a
  simple fixed assignment of clients to instances would leave the pool
  unevenly loaded.

## When not to use it

- Exactly one instance of a service exists and there's no near-term
  plan to run more than one — there's nothing to distribute across
  yet, and a load balancer in front of a single backend adds a hop and
  a component to operate for no distribution benefit (though it may
  still be worth it purely for health-check-driven failover, or paired
  with a [Reverse Proxy](/docs/patterns/api-edge/reverse-proxy) for
  its other benefits).
- The system's bottleneck is total capacity, not distribution across
  existing capacity — no balancing algorithm creates capacity that
  isn't there; it only spreads existing capacity more evenly.
- Requests must be strictly ordered or handled by one specific,
  stateful process with no ability to hand off — a scenario better
  served by directing all such requests to a single designated
  owner (see [Leader Election](/docs/patterns/consistency/leader-election))
  than by spreading them across a pool.

## Use-case scenarios

**Public web application behind a Layer 7 balancer.** A retail site
runs many stateless web-server instances behind an application-layer
load balancer that reads each request's path to route API calls to
one backend pool and static-asset requests to another, while
distributing within each pool using least-connections so instances
handling a burst of slower checkout requests don't also get flooded
with new ones.

**Video streaming platform with session affinity.** A streaming
service load-balances viewer connections using consistent hashing on a
session identifier, so a given viewer's connection keeps landing on
the same backend instance for the duration of their session — that
instance holds in-memory playback state that would be expensive to
look up fresh on every request if the viewer bounced between different
backends each time.

**Multi-region API with weighted distribution.** A global API runs a
larger instance pool in its primary region and a smaller standby pool
in a secondary region for regional failover. Weighted load balancing
sends the large majority of traffic to the primary pool during normal
operation, with weights adjusted (and eventually the roles reversed)
only if the primary region's health checks start failing — the same
underlying detect-and-redirect mechanism described in more depth on
the [Failover](/docs/patterns/reliability/failover) page, applied
here at the granularity of an entire region's instance pool.

## Related patterns

- [Rate Limiter](/docs/patterns/building-blocks/rate-limiter) — caps
  how much traffic a caller is allowed to send in the first place;
  load balancing decides which healthy instance handles traffic
  that's already been admitted. The two commonly sit at the same
  entry point but solve different problems and neither substitutes
  for the other.
- [Reverse Proxy](/docs/patterns/api-edge/reverse-proxy) — a load
  balancer is a specialization of the general reverse-proxy role,
  focused specifically on distributing traffic across many
  functionally identical backend instances rather than the broader
  set of concerns (SSL termination, caching, hiding backend topology)
  a reverse proxy can serve even with a single backend.
- [Failover](/docs/patterns/reliability/failover) — shares the same
  health-check-and-redirect mechanics as load balancing's unhealthy-
  instance removal, applied to a standby replacement rather than to
  spreading load across an active pool.
- [Load Balancer — concept overview](/docs/concepts/load-balancer) —
  this site's earlier primer-derived treatment of load balancing, for
  further background.

## Further reading

- [Load balancing (computing) — Wikipedia](https://en.wikipedia.org/wiki/Load_balancing_(computing))
- [What is load balancing? — AWS documentation](https://docs.aws.amazon.com/elasticloadbalancing/latest/userguide/what-is-load-balancing.html)
- [Load Balancer traffic-routing methods — Azure documentation](https://learn.microsoft.com/en-us/azure/traffic-manager/traffic-manager-load-balancing-azure)
