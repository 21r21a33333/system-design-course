---
title: "Geode"
sidebar_position: 8
supplementary: true
---

The Geode pattern deploys backend services across multiple
geographically distributed regions — "geodes" — where each geode can
independently handle requests from clients anywhere, not just its own
region, using data replication to keep every geode able to serve any
request.

![Geode diagram](/img/patterns/geode.svg)

## Problem it solves

A single-region deployment forces every client, worldwide, to cross
whatever network distance separates them from that one region, adding
latency that grows with physical distance and that no amount of
application-level optimization can remove — a request from the other
side of the planet pays for the round trip no matter how fast the
backend itself responds. It's also a single geographic failure domain:
a regional outage takes down the only place able to serve any request,
everywhere. The Geode pattern solves both problems at once by deploying
full serving capability into multiple regions and replicating data
across them, so a client's request can be served by whichever geode is
geographically closest, and any single region going down still leaves
every other geode fully able to serve every client.

## How it works

Each geode is a deployment of the application's services in a distinct
geographic region, and — critically — every geode is capable of serving
*any* request, not just requests related to its own region's data. That
capability depends entirely on data replication: the data a geode needs
to answer a request has to already be present locally, replicated in
from wherever it originated, rather than fetched cross-region on demand
(which would reintroduce the latency the whole pattern exists to avoid).
Clients are routed to their nearest geode, typically via geographic DNS
routing or a global load balancer, so the network hop that dominates
latency — the client-to-server leg — is kept short, while the
replication work of keeping every geode's data current happens
asynchronously in the background, between geodes, off the client's
critical path. This replication is exactly the kind of distribution
problem [Consistent Hashing](/docs/patterns/storage/consistent-hashing)
addresses in a different context — assigning and locating data across a
set of nodes predictably — and geode deployments face a related
question of how data gets distributed and kept current across regions
so any geode can answer locally.

### How this differs from Deployment Stamps

[Deployment Stamps](/docs/patterns/observability/deployment-stamps) and
Geode look similar on the surface — both deploy multiple full copies of
a stack — but they solve different problems and make an opposite
tradeoff. Stamps **partition customers**: each tenant is assigned to
exactly one stamp, and a stamp only ever serves the tenants assigned to
it — the point is isolation, so one tenant's problems can never reach
another tenant's stamp, and no single request could ever be served by
more than one specific stamp. Geodes **replicate capability**: the same
full service and (via replication) the same data exist in every geode,
so *any* geode can serve *any* client's request — the point is
proximity, routing each client to whichever region is physically
closest to minimize latency, not keeping different customers apart.
Where a stamp answers "which dedicated copy does this tenant belong
to?", a geode answers "which nearby copy can answer this request fastest,
given that every copy can technically answer it?" Stamps optimize for
tenant isolation at the cost of infrastructure duplicated per tenant
group; geodes optimize for latency-to-nearest-region at the cost of the
replication machinery needed to keep every geode's data current enough
to answer correctly.

## Code example

The snippet below models the routing decision that distinguishes a
geode from a stamp: any geode is a valid target for any client, so
routing picks the nearest one rather than looking up a fixed
assignment.

```rust
struct Geode {
    region: String,
    // distance in arbitrary latency units from a given client region
    distance_from: fn(&str) -> u32,
}

struct GeodeRouter {
    geodes: Vec<Geode>,
}

impl GeodeRouter {
    // Unlike a stamp lookup, every geode is a *candidate* for every
    // client — the router just picks the nearest one.
    fn nearest_for(&self, client_region: &str) -> Option<&Geode> {
        self.geodes
            .iter()
            .min_by_key(|g| (g.distance_from)(client_region))
    }
}

fn route_request(router: &GeodeRouter, client_region: &str) -> String {
    match router.nearest_for(client_region) {
        Some(geode) => format!("routing {client_region} to geode {}", geode.region),
        None => "no geode available".to_string(),
    }
}
```

`nearest_for` has no notion of tenant ownership at all — every geode in
the list is equally capable of serving the request, because replication
keeps their data in sync; the only question is which one is closest.

## When to use it

- Clients are geographically distributed worldwide and latency to a
  single-region deployment is a real, measurable problem for a
  meaningful share of them.
- The application's data can be replicated across regions such that any
  geode can serve any request without cross-region calls on the
  critical path.
- Regional failure isolation is valuable — a full region going down
  should leave the rest of the system fully functional for every
  client, not just clients outside that region.

## When not to use it

- Users are concentrated in one geographic area, and the latency and
  operational cost of running (and replicating data across) multiple
  regions isn't justified.
- The data can't be replicated cheaply or consistently enough across
  regions for every geode to answer correctly — strict, low-latency
  cross-region consistency requirements can make this pattern
  impractical.
- The actual requirement is tenant isolation rather than latency — that
  need is better served by [Deployment
  Stamps](/docs/patterns/observability/deployment-stamps), which
  partitions customers instead of replicating capability everywhere.

## Real-world example

A global content platform runs full application stacks in several
regions — North America, Europe, Asia-Pacific — each with a locally
replicated copy of user and content data, and a global DNS-based router
directs each user to their nearest geode. A user in Singapore is served
entirely by the Asia-Pacific geode with no round trip to North America,
and if the European geode goes offline, European users are simply
routed to their next-nearest geode rather than losing service entirely.

## Related patterns

- [Deployment Stamps](/docs/patterns/observability/deployment-stamps) —
  also deploys multiple full copies of a stack, but partitions
  *customers* across isolated stamps rather than replicating the same
  capability for *any* client to reach the nearest copy.
- [Consistent Hashing](/docs/patterns/storage/consistent-hashing) — a
  related concern for how data is distributed and located across nodes,
  relevant to how a geode deployment organizes its replicated data.

## Further reading

- [Geode pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/geodes)
- [Multi-master replication — Wikipedia](https://en.wikipedia.org/wiki/Multi-master_replication)
