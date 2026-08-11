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

## Technical architecture & implementation

**Geodes and the "any geode serves any request" property.** Each geode
is a deployment of the application's services in a distinct geographic
region, and — critically — every geode is capable of serving *any*
request, not just requests tied to its own region's data. This is the
property that distinguishes a geode from a stamp or a shard, and it
depends entirely on data replication: the data a geode needs must already
be present locally, replicated in from wherever it originated, rather
than fetched cross-region on demand (which would reintroduce the very
latency the pattern exists to remove). The application tier in each geode
is typically stateless or works only against its local replica, so adding
a region is "stand up the stack, attach it to the replication topology,
add it to the router."

**Geo-routing the client to the nearest geode.** Clients are steered to
their nearest region so the dominant network hop — the client-to-server
leg — stays short. Three mechanisms are common. **Latency/geo DNS**
resolves the service name to the closest region's address based on the
resolver's location or measured latency (simple, but DNS caching slows
failover). **Anycast** advertises one IP from every region and lets
Internet routing deliver each client to the topologically nearest one
(fast reconvergence on a region loss, but less precise control). A
**global load balancer** at the edge makes the routing decision
per-connection with real health data (most control, another hop to
operate). In all three the routing layer holds no application data — it
only decides *which region*.

**Data replication across regions.** Keeping every geode able to answer
locally is the hard part, and the replication topology is the core design
choice. **Active-active multi-primary** lets every region accept writes
and replicates them to the others — lowest write latency, but two regions
can write conflicting values to the same key concurrently, so conflicts
must be *detected and resolved* (last-writer-wins by timestamp,
application-defined merge, or CRDTs for data types that merge
commutatively). **Single-primary with regional read replicas** routes all
writes to one region and replicates outward — no write conflicts, but
writers far from the primary pay cross-region latency. Replication is
asynchronous and off the client's critical path, which means geodes are
**eventually consistent**: a value written in one region is briefly
absent or stale in another until replication catches up. The application
must be designed to tolerate that window — read-your-writes routing,
version vectors, or accepting bounded staleness.

**Regional failover.** Because every geode can serve any request, a
region going down is handled by simply routing its clients elsewhere.
The routing layer health-checks each region and drops an unhealthy one
from the candidate set; its clients fall through to their next-nearest
healthy geode with no data loss, since that geode already holds a
replicated copy. The catch is failover *speed*: with geo-DNS, cached
resolutions can keep sending clients at a dead region until TTLs expire,
which is why short TTLs, anycast, or a health-aware global balancer are
preferred when fast regional failover matters.

**Failure modes.** *Conflicting concurrent writes* in active-active
topologies are the signature hazard — without a deliberate conflict
policy, replication silently diverges regions. *Stale reads* during the
replication lag window surprise clients that expect to read their own
recent write from a different region. *Cross-region calls sneaking onto
the hot path* — a request that "mostly" reads locally but occasionally
reaches back to another region — quietly reintroduce the latency the
pattern was meant to eliminate, so the local-completeness invariant must
be enforced, not assumed. *Replication cost and lag* grow with the number
of regions and write volume, bounding how many geodes are practical.

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

### How this differs from a CDN

A [CDN](/docs/patterns/building-blocks/cdn) also puts copies of
something close to users to cut latency, so the two are easy to conflate
— but they operate at different layers. A CDN caches *content* (static
assets, and increasingly cacheable responses) at edge locations; it is a
read-optimized cache in front of an origin, and a cache miss or any
non-cacheable, write, or dynamic request still falls back to that origin.
A geode replicates the *full application stack and its authoritative
data* into each region, so a geode can serve *dynamic, stateful, write*
requests locally — there is no origin it falls back to for the logic,
because the logic and a live data replica are present in every region.
Put simply: a CDN brings cached bytes close to the user; a geode brings
the whole running service, database included, close to the user. They
compose well — a CDN fronts a geode deployment to absorb static and
cacheable traffic at the very edge, while the geodes behind it handle
the dynamic, data-backed requests the CDN can't.

## Code example

The snippet below models the routing decision that distinguishes a
geode from a stamp *and* folds in regional failover: any healthy geode
is a valid target for any client, so routing filters out unhealthy
regions and picks the nearest survivor rather than looking up a fixed
assignment.

```rust
#[derive(Clone, Copy, PartialEq)]
enum Health {
    Up,
    Down,
}

struct Geode {
    region: String,
    // Latency in arbitrary units from a given client region to this geode.
    distance_from: fn(&str) -> u32,
    health: Health,
}

struct GeodeRouter {
    geodes: Vec<Geode>,
}

impl GeodeRouter {
    // Unlike a stamp lookup, every geode is a *candidate* for every client,
    // because replication keeps their data in sync. Routing skips any
    // unhealthy region and picks the nearest healthy one — that skip is
    // exactly regional failover: a downed region simply drops out of the
    // candidate set and its clients fall through to their next-nearest geode.
    fn nearest_healthy(&self, client_region: &str) -> Option<&Geode> {
        self.geodes
            .iter()
            .filter(|g| g.health == Health::Up)
            .min_by_key(|g| (g.distance_from)(client_region))
    }
}

fn route_request(router: &GeodeRouter, client_region: &str) -> String {
    match router.nearest_healthy(client_region) {
        Some(geode) => format!("routing {client_region} to geode {}", geode.region),
        None => "no healthy geode available".to_string(),
    }
}
```

`nearest_healthy` has no notion of tenant ownership at all — every
healthy geode is equally capable of serving the request, because
replication keeps their data in sync, so the only questions are "is it
up?" and "is it closest?". The `filter` on health is regional failover
expressed directly: when a region goes `Down`, it vanishes from the
candidate set and its clients transparently fall through to their
next-nearest geode.

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

## Use-case scenarios

**Global content platform with active-active regions.** A platform runs
full application stacks in several regions — North America, Europe,
Asia-Pacific — each holding a locally replicated copy of user and content
data, and a latency-based DNS router directs each user to their nearest
geode. A user in Singapore is served entirely by the Asia-Pacific geode
with no round trip to North America; if the European geode goes offline,
health-aware routing drops it and European users fall through to their
next-nearest geode rather than losing service. Concurrent edits to the
same content in two regions are reconciled by a last-writer-wins policy
on a version timestamp.

**Latency-sensitive interactive API.** A collaborative or real-time
product where every extra 100 ms of round trip is felt deploys geodes in
the regions its users cluster in. Writes replicate active-active with
CRDT-based merge for the collaborative document state, so two users
editing from different regions converge without a coordinator on the hot
path, and each user's edits commit against their local geode at
in-region latency. A CDN fronts the geodes to serve the static app shell
from the very edge, leaving the geodes to handle the live document
traffic.

**Multi-region resilience for a stateful service.** An organization
whose priority is surviving a full regional outage (not just latency)
runs geodes in three regions with data replicated across all of them.
Because any region can serve any request from its local replica, losing
an entire region is a routing event, not an outage: traffic reconverges
on the remaining regions, and once the failed region is restored and its
replica has caught up, it rejoins the candidate set and resumes serving
its nearby clients.

## Production libraries & getting started

A geode deployment is assembled from cloud infrastructure, not a single library: a global routing layer that steers each client to the nearest region, plus a multi-region database that replicates authoritative data so any region can answer locally. The building blocks below cover both halves.

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| AWS Global Accelerator | Managed (anycast) | Anycast global routing to the nearest healthy region with fast failover | [docs.aws.amazon.com — Global Accelerator](https://docs.aws.amazon.com/global-accelerator/latest/dg/what-is-global-accelerator.html) |
| Azure Front Door | Managed (edge) | Global HTTP(S) entry point with latency-based routing and health probing | [learn.microsoft.com — Front Door](https://learn.microsoft.com/en-us/azure/frontdoor/front-door-overview) |
| Cloudflare | Managed (anycast edge) | Global anycast network for geo-routing, load balancing, and edge termination | [developers.cloudflare.com](https://developers.cloudflare.com/fundamentals/) |
| CockroachDB | Go (server); SQL | Geo-distributed SQL with per-region data placement and survivability goals | [cockroachlabs.com/docs — multi-region](https://www.cockroachlabs.com/docs/stable/multiregion-overview) |
| YugabyteDB | C++ / Go (server); SQL | Distributed SQL with multi-region deployment topologies and tunable consistency | [docs.yugabyte.com — multi-region](https://docs.yugabyte.com/preview/explore/multi-region-deployments/) |
| Azure Cosmos DB | Managed (any language SDK) | Turnkey global distribution with multi-region writes and tunable consistency | [learn.microsoft.com — Cosmos DB global distribution](https://learn.microsoft.com/en-us/azure/cosmos-db/distribute-data-globally) |

**Example / reference:** [Geode pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/geodes)

## Related patterns

- [Deployment Stamps](/docs/patterns/observability/deployment-stamps) —
  also deploys multiple full copies of a stack, but partitions
  *customers* across isolated stamps rather than replicating the same
  capability for *any* client to reach the nearest copy.
- [CDN](/docs/patterns/building-blocks/cdn) — also puts copies close to
  users, but caches *content* in front of an origin; a geode replicates
  the full stateful service (data included) so it can serve dynamic and
  write requests locally with no origin to fall back to.
- [Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication) —
  the single-primary variant of the cross-region replication a geode
  deployment relies on to keep every region's data current.
- [Failover](/docs/patterns/reliability/failover) — geode routing does
  regional failover implicitly by dropping an unhealthy region from the
  candidate set and steering its clients to the next-nearest survivor.
- [Consistent Hashing](/docs/patterns/storage/consistent-hashing) — a
  related concern for how replicated data is distributed and located
  across nodes within and across a geode deployment.

## Further reading

- [Geode pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/geodes)
- [Amazon DynamoDB global tables — official docs](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GlobalTables.html)
- [AWS Global Accelerator (anycast global routing) — official docs](https://docs.aws.amazon.com/global-accelerator/latest/dg/what-is-global-accelerator.html)
- [Conflict-free replicated data type (CRDT) — Wikipedia](https://en.wikipedia.org/wiki/Conflict-free_replicated_data_type)
- [Multi-master replication — Wikipedia](https://en.wikipedia.org/wiki/Multi-master_replication)
