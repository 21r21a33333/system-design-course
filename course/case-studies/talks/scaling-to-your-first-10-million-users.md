---
title: "Talk: Scaling Up to Your First 10 Million Users"
sidebar_position: 1
---

Most scaling guidance jumps straight to "the architecture for a million users," which is honest but unhelpful: nobody launches with that architecture, and building it on day one is itself a scaling mistake — over-engineering for load you don't have yet, at the cost of features you do need. This case study instead walks the same territory as AWS re:Invent's "Scaling Up to Your First 10 Million Users" talk: a **staged path**, where each stage adds exactly the piece the previous stage's bottleneck demands, and no more. The value isn't any single diagram — it's the ordering, and the discipline of not skipping ahead.

The talk frames every decision through two lenses worth stating up front, because they explain *why* the path below looks the way it does rather than jumping straight to a "final" architecture. First, most architecture decisions are what the talk (borrowing a framing popularized by Amazon's Jeff Bezos) calls **two-way doors**: reversible. You don't need to get the database choice "right" forever on day one — you pick something reasonable, run it, measure where it actually hurts, and change that one thing. That's a **build → measure → learn → build** loop, not a single up-front design. Second, distinguish **undifferentiated heavy lifting** (patching a database server, keeping a load balancer highly available — necessary, but it doesn't make your product better) from the work that actually differentiates your product. A related trap is **yak-shaving**: starting a small fix and burrowing three problems deep before noticing you've drifted from the original goal. The throughline in every stage below is: offload the undifferentiated work to a managed AWS service the moment it's available, and spend your own effort where it actually matters.

## Step 1: Outline use cases and constraints

### Use cases

This case study covers architecture evolution for a generic web application (any product — the pattern generalizes) as its user count grows through a series of milestones:

* 1 user → a working deployment exists at all
* 100 users → the app survives its first real traffic without hand-holding
* 1,000 users → a single server of anything is no longer enough
* 10,000 users → the origin needs help; static and cacheable content moves off it
* 100,000-500,000 users → capacity needs to track demand automatically, not by hand
* 1,000,000 users → a single deployable monolith stops being the right unit of scaling
* 5-10 million users → the database, not the app tier, becomes the bottleneck

#### Out of scope

* Multi-region active-active architecture and anything beyond ~10 million users (touched on briefly in [Additional talking points](#additional-talking-points), not designed in depth — the talk itself treats this as "a different, much deeper talk")
* A specific product domain (this is deliberately generic; domain-specific case studies live elsewhere in this course, e.g. [Design UPI](/docs/case-studies/fintech/upi-real-time-payments) or [Design TinyURL](/docs/case-studies/system-design/tinyurl))

### Constraints and assumptions

* Built on AWS-native managed services throughout, since that's the surface the talk itself covers and the surface most teams starting fresh on AWS will actually reach for.
* AWS services split into two families, and the split matters for how much undifferentiated work you carry: some services (S3, CloudFront, Route 53, SNS, SQS, load balancers) are highly available and fault-tolerant *by default* — AWS operates that for you. Others (a fleet of EC2 instances) are only as highly available as the architecture you build around them — you own multi-AZ placement, health checks, and failover. Neither family is "wrong"; you just need to know which one you're getting when you pick a service.
* No architecture below is a hard requirement at its stated user count — they're the point at which the *previous* stage's bottleneck typically becomes visible, not a deadline.

## Step 2: Create a high-level design

![Day 1 architecture: a client resolves DNS through Route 53 to a single EC2 web instance, which talks to a single self-managed EC2 database instance; an alternative dashed callout shows Amazon Lightsail bundling compute, storage, and networking for an even faster start](/img/case-studies/talks/scaling-to-your-first-10-million-users-overview.svg)

Day one is deliberately unambitious: **Route 53** for DNS, one **EC2** instance running the web application, and one **EC2** instance running a self-managed database engine. That's the entire system, and that's correct — there is no traffic yet to justify anything more. If the goal is simply to get something running in minutes without thinking about infrastructure at all, **Amazon Lightsail** bundles compute, storage, and networking into one simple deployment; you outgrow it deliberately, at which point you move onto the individually-managed services below.

The one decision worth making thoughtfully even at this stage is the database engine, because it's the piece hardest to change later without real migration work. The talk's advice here is direct and somewhat contrarian: **start with SQL.** A relational database is well-understood, has decades of tooling and operational expertise behind it, and — this is the load-bearing claim — you are very unlikely to outgrow it in your first few million users unless your workload is unusual. The heuristic used in the talk: if you're not projecting more than roughly 5 TB of new data in your first year, and you don't need thousands of writes per second, a relational database will carry you further than intuition suggests. "NoSQL feels easier to model" is explicitly *not* one of the valid reasons to reach for it.

## Step 3: Design core components

### Use case: Move off a self-managed database and hand-rolled auth (~100 users)

The first real upgrade isn't about scale at all — it's about no longer operating undifferentiated infrastructure by hand. Two swaps happen here: the self-managed EC2 database becomes an **Amazon RDS** instance (or, for higher scale headroom later, **Amazon Aurora** — a MySQL/PostgreSQL-compatible engine that separates compute from storage, so compute nodes can be added or removed independently and billed by the second, and that supports up to 15 read replicas and six-way replication across three Availability Zones out of the box). And user sign-up, sign-in, password reset, and multi-factor auth move to **Amazon Cognito**, a managed user directory with a hosted UI and federation to Google, Facebook, or any OpenID Connect/SAML provider, exchanging those credentials for AWS credentials your app can use.

Neither swap changes what the product does. Both remove work that was never going to differentiate the product in the first place — nobody chooses an app because its sign-in form is exceptional, but a broken one will lose users, and hand-patching a database server is pure operational cost with no user-facing upside.

**Core spec: deciding whether a workload has actually outgrown SQL**

```python
from dataclasses import dataclass

@dataclass
class WorkloadProfile:
    projected_annual_data_gb: float
    peak_writes_per_second: float
    needs_multi_row_transactions: bool
    access_pattern_is_relational: bool


def should_consider_nosql(profile: WorkloadProfile) -> tuple[bool, str]:
    """Decide whether a workload has outgrown a single relational database.

    Codifies the talk's own threshold: unless a workload is projected to
    generate more than ~5 TB/year or needs sustained per-second write
    rates in the thousands, a relational database will comfortably carry
    it through the first few million users. A relational store is also
    kept as the default whenever the workload still needs multi-row
    transactions or is genuinely relational -- "the schema feels easier
    to write in NoSQL" is explicitly not a valid reason on its own.
    """
    if profile.needs_multi_row_transactions or profile.access_pattern_is_relational:
        return False, "workload needs relational guarantees; stay on SQL"
    if profile.projected_annual_data_gb > 5_000:
        return True, "projected data volume exceeds the ~5 TB/year threshold"
    if profile.peak_writes_per_second > 1_000:
        return True, "sustained write rate is in NoSQL's sweet spot"
    return False, "SQL will comfortably carry this workload for now"
```

**Trade-offs:**
* **The gotcha:** teams reach for NoSQL the moment modeling a relational schema feels annoying, then rediscover — usually under load, usually painfully — that they still needed multi-row transactions or ad-hoc relational queries the whole time. The check above forces those two questions first, before volume or throughput even enters the decision.
* RDS's managed failover (and Aurora's storage/compute separation) removes an entire category of 2 a.m. pages without changing a single line of application code — this is "undifferentiated heavy lifting" made concrete.

### Use case: Split into a horizontally scaled web tier behind a load balancer (~1,000 users)

At this point a single web instance and a single database instance are both real bottlenecks, and it's time to name the two options precisely: **vertical scaling** (make each node bigger) and **horizontal scaling** (add more nodes) — see [Vertical Scaling](/docs/patterns/scaling/vertical-scaling) and [Horizontal Scaling](/docs/patterns/scaling/horizontal-scaling). Vertical scaling is the simpler lever to pull and lets you pick instance types tuned to CPU, memory, network, or storage — but it has a ceiling (doubling instance size rarely doubles throughput) and a redundancy cost that's easy to underweight: fewer, bigger nodes means each failure takes out a bigger share of your capacity.

**Core spec: quantifying the redundancy trade-off**

```python
def capacity_lost_on_single_node_failure(node_count: int) -> float:
    """Fraction of total capacity lost when exactly one node fails.

    Two large instances lose 50% of capacity if one fails; ten smaller
    instances sized for the same total throughput lose only 10% -- the
    core argument for horizontal over vertical scaling once redundancy,
    not just raw throughput, is the concern.
    """
    if node_count < 1:
        raise ValueError("node_count must be >= 1")
    return 1.0 / node_count
```

The database gets a second RDS instance with managed failover, and the web tier gets a second EC2 instance — which immediately raises the question of how traffic gets split across them. AWS offers three managed load balancer tiers: the legacy Classic Load Balancer, the layer-4 **Network Load Balancer**, and the layer-7 **Application Load Balancer (ALB)**. The talk's default recommendation is to start with the ALB until you find a concrete reason it doesn't fit — see [Load Balancing](/docs/patterns/api-edge/load-balancing). It's fully managed (AWS scales and operates its availability, not you), supports content-based routing on path or header, session affinity, health checks, HTTP/2, and WebSockets.

**Trade-offs:**
* **The gotcha:** vertical scaling is genuinely the right call in some cases — most commonly software licensing tied to a fixed number of servers, where horizontal scaling isn't an option regardless of its technical merits. Don't treat "horizontal is more modern" as a universal rule; pick the fit for the actual constraint.
* A load balancer you configure yourself on EC2 is *your* highly-available system to build and operate. The ALB is AWS's, and you inherit its availability for free — this is the "self-scaling by default" service family from Step 1 in practice.

### Use case: Take load off the origin with a CDN and a cache-aside layer (~10,000 users)

Two independent techniques land here, and both work by keeping requests from ever reaching the origin at all. First, static assets — JavaScript, CSS, images, anything that doesn't need a database lookup to serve — move to **Amazon S3** (an object store with objects up to 5 TB, encryption at rest and in transit) fronted by **Amazon CloudFront**, AWS's CDN with roughly 199 points of presence globally. See [CDN](/docs/patterns/building-blocks/cdn). CloudFront isn't limited to static content, either: it can front *dynamic* content too, with a time-to-live as low as zero seconds — meaning you get CloudFront's accelerated global network path without caching anything, or you cache dynamic responses keyed on a query string (search results being the canonical example).

Second, database reads move through **Amazon ElastiCache** (a managed Memcached or Redis cluster) sitting in front of RDS. A relational query that costs hundreds of milliseconds — sometimes seconds, for a heavy query — collapses to single-digit milliseconds on a cache hit, and every hit is a read the database never has to serve, freeing its capacity for writes and misses. See [Cache-Aside](/docs/patterns/caching/cache-aside) and [Distributed Cache](/docs/patterns/building-blocks/distributed-cache).

**Core spec: cache-aside read path**

```python
class CacheAsideStore:
    """Cache-aside (read-through) lookup over ElastiCache + RDS: check the
    in-memory cache first, fall back to the database on a miss, and
    repopulate the cache before returning.
    """

    def __init__(self, cache, db, ttl_seconds: int = 60):
        self.cache = cache        # dict-like: get/set with TTL
        self.db = db              # callable: db.query_one(key) -> row
        self.ttl_seconds = ttl_seconds

    def get(self, key: str):
        cached = self.cache.get(key)
        if cached is not None:
            return cached
        row = self.db.query_one(key)
        if row is not None:
            self.cache.set(key, row, ttl=self.ttl_seconds)
        return row
```

**Trade-offs:**
* **The gotcha:** cache-aside only helps read-heavy, tolerant-of-staleness data. A `ttl_seconds` that's too long serves stale results after a write; too short and you lose most of the benefit while still paying cache-management overhead. There's no universal right TTL — it has to match how fast the underlying row actually changes.
* CloudFront and ElastiCache attack the same problem — origin load — from two different distances: one keeps requests from leaving the client's network edge, the other keeps requests from leaving the app tier's local network. Both are worth having; neither replaces the other.

### Use case: Split the datastore by access pattern (~10,000-100,000 users)

Not every table belongs in the same database. This is where **DynamoDB** enters — not as an RDS replacement, but alongside it: schema-less data, non-relational data, and metadata-shaped records move to DynamoDB, while genuinely relational data stays on RDS/Aurora. This is polyglot persistence in miniature — picking the right storage engine for each *piece* of the data model, not for the application as a whole. DynamoDB offers provisioned or on-demand throughput, built-in auto-scaling on read/write capacity, native JSON storage, and Streams for triggering downstream processing on changes.

On the RDS/Aurora side, the read path scales further via **read replicas** — read-only queries route to replicas instead of the primary, so the primary keeps more of its capacity for writes. See [Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication). Aurora's ceiling here is generous: up to 15 read replicas per cluster.

**Trade-offs:**
* **The gotcha:** the instinct is to ask "should we move to DynamoDB?" as a single yes/no question for the whole application. The talk's actual advice is per-table, not per-application: keep asking it for each new table as it's designed, and only migrate the ones that are actually schema-less or write-heavy enough to benefit. Most applications end up running RDS and DynamoDB side by side indefinitely, not one replacing the other.

### Use case: Turn on auto scaling and automate the fleet (~100,000-500,000 users)

Everything so far has been scaling the web tier by hand — adding instances when someone notices load climbing. Once the web tier is genuinely lightweight (static content offloaded to CloudFront/S3, hot reads served from ElastiCache, schema-less data diverted to DynamoDB), it becomes worth automating that decision entirely with **Auto Scaling groups**: EC2 instances spread across multiple Availability Zones, sized between a configured minimum and maximum, driven by **Amazon CloudWatch** metrics. See [Auto Scaling](/docs/patterns/scaling/auto-scaling) and [Health Check](/docs/patterns/observability/health-check) (an unhealthy instance in the group gets replaced automatically, not just flagged).

**Core spec: target-tracking desired-capacity calculation**

```python
import math

def desired_capacity(current_capacity: int, current_metric: float,
                      target_metric: float, min_capacity: int,
                      max_capacity: int) -> int:
    """Target-tracking scaling, the same math CloudWatch-driven Auto
    Scaling groups apply: scale capacity proportionally to how far the
    observed metric (e.g. average CPU utilization) sits from the target,
    then clamp to the group's configured [min, max] bounds.
    """
    if current_metric <= 0:
        return min_capacity
    raw = math.ceil(current_capacity * (current_metric / target_metric))
    return max(min_capacity, min(max_capacity, raw))
```

Automation doesn't stop at compute sizing. **AWS Systems Manager** covers the rest of fleet operations: remote access to instances without a bastion host, scheduled patching, spinning dev/test environments down overnight and back up in the morning, fleet-wide compliance scanning (State Manager), and encrypted secrets storage (Parameter Store) for things like database passwords and API keys. Provisioning itself becomes **infrastructure as code** — CloudFormation templates or the AWS CDK (writing infrastructure in a general-purpose language instead of a template DSL) — and deployment becomes a **CodePipeline**: a commit to CodeCommit triggers CodeBuild, which hands off to CodeDeploy, or the whole thing gets bootstrapped quickly with CodeStar.

**Trade-offs:**
* **The gotcha:** auto scaling reacts to a metric with a lag — provisioning a new instance and warming it up takes real time, so a target-tracking policy set too aggressively (a target so close to the danger threshold that there's no runway) will always be scaling up *after* users have already felt the slowdown. The target needs headroom, not just correctness.
* Every one of these automation pieces (Systems Manager, CloudFormation/CDK, CodePipeline) is optional in the sense that you could do it by hand — the case for adopting them is exactly the "undifferentiated heavy lifting" framing from Step 1: none of it is product work, all of it compounds in operational cost if left manual.

### Use case: Break the monolith into independently scaled services (~1,000,000 users)

At a million users, the limiting factor usually isn't any one component's capacity — it's that the whole application is still one deployable unit, so scaling *anything* means scaling *everything*. **Service-oriented architecture (SOA)** splits the monolith into a presentation tier, a business tier (now multiple independent services), and a data-access tier, each scaled, deployed, and monitored on its own.

In practice this means routing a single **ALB** to a mix of compute types based on what each service actually needs: EC2 or **Fargate/ECS** for heavier, always-on services, and **AWS Lambda** for small, event-triggered pieces of logic that don't need a persistent server at all. Services stay decoupled from each other via **Amazon SQS** (queueing) and **Amazon SNS** (pub/sub notification) rather than talking to each other directly — see [Event-Driven Architecture](/docs/patterns/communication/event-driven-architecture), [Pub/Sub](/docs/patterns/communication/pub-sub), and [Distributed Message Queue](/docs/patterns/building-blocks/distributed-message-queue). This is the same **loose coupling** idea behind every message-queue pattern in this course: a service that only knows about a queue, not about which other service reads from it, can be changed, scaled, or replaced without anyone else's code changing. A common concrete shape: a static site on S3/CloudFront, **Cognito** for auth, and **API Gateway + Lambda** writing to DynamoDB on the backend — a fully serverless slice sitting next to the EC2/Fargate slice, both fronted by the same ALB. Tracing a request across that many independent services is exactly what **AWS X-Ray** (distributed tracing) exists for — see [Distributed Tracing](/docs/patterns/observability/distributed-tracing) — so a slow or failing hop is visible instead of invisible.

**Trade-offs:**
* **The gotcha:** SOA trades a simple problem (one deployable, one thing to monitor) for a harder one (many deployables, many failure boundaries, and now a network hop where there used to be a function call). It's a real cost, and the talk is explicit that it only pays off once the monolith itself — not any single database or web-tier component — is the actual bottleneck. Reaching for microservices before that point is optimizing for a scale you don't have yet, which is exactly the over-engineering trap this whole staged approach is built to avoid.
* Don't rebuild what a managed service already offers "because microservices" — the recommendation is still to reach for RDS, DynamoDB, SQS, SNS, API Gateway, and Lambda over self-hosted equivalents; SOA changes how many deployable units you have, not the earlier instinct to prefer managed services within each one.

## Step 4: Scale the design

![5-10 million users: clients through CloudFront and an ALB into two Availability Zones of auto-scaled web and worker groups, ElastiCache and Aurora/RDS with read replicas and DynamoDB for storage, API Gateway with Lambda and Fargate microservices decoupled by SQS/SNS, all traced by X-Ray, with a federated or sharded database tier at the top of this range](/img/case-studies/talks/scaling-to-your-first-10-million-users-scaled.svg)

By 5-10 million users, everything covered so far — multi-AZ placement, auto scaling, SOA — is already in place and working. What breaks next is specifically the **database tier**, and the talk lays out three techniques, roughly in order of how much application-level work each demands:

* **Federation**: split one database into several, by function — a cluster for users, a separate cluster for products, and so on. This is the cheapest option to adopt (it's a deployment change, not an application-logic change) but it only defers the problem: eventually one of those functional clusters outgrows its own hardware just like the original single database did. See [Federation](/docs/patterns/storage/federation).
* **Sharding**: split data with the *same* schema across many clusters by some partition key, with the application itself deciding which cluster to read or write. This scales horizontally without a hard ceiling — add another shard — but it's real application complexity (every query needs to know how to find its shard) and real operational sophistication (rebalancing, hot shards). See [Sharding](/docs/patterns/storage/sharding), which typically uses [Consistent Hashing](/docs/patterns/storage/consistent-hashing) so that adding or removing a shard doesn't reshuffle most of the existing data.
* **Move specific tables to a different database technology** — conceptually similar to federation, but the split is driven by "this table doesn't need to be relational" rather than by functional boundary. The table covered earlier moving from RDS to DynamoDB (Step 3, "Split the datastore by access pattern") is this same technique, just applied earlier and by data shape instead of by scale pressure.

Everything else at this range is a continuation, not a new idea: multi-AZ placement everywhere, auto scaling still driving compute, SOA still isolating one service's failure from another's, CloudFront and ElastiCache still keeping load off the origin. The database is simply the piece that catches up to the traffic last, because it was the hardest piece to make horizontally scalable in the first place.

## Additional talking points

* **The two service families, revisited.** Step 1 drew the line between services AWS operates to be highly available by default (ALB, S3, CloudFront, SNS, SQS) and services you architect for availability yourself (EC2-based systems). By the time you're at 5-10 million users, that distinction has compounded: every "self-scaling by default" service you leaned on early is now carrying enormous load with zero additional operational effort from you, while every self-managed EC2 fleet has needed deliberate multi-AZ and auto-scaling work at each stage to keep up. This is the concrete payoff of the "avoid undifferentiated heavy lifting" principle from the introduction.
* **Monitoring needs both host-level and aggregate metrics.** A single instance's CPU utilization tells you about that instance. What you actually want to know at fleet scale is a statistical threshold across the whole group — the talk's example is P90 CPU utilization: if P90 is 70%, ninety percent of instances are running at or below 70%, and the remaining ten percent are the outliers actually worth investigating. Pair that with customer-facing metrics (page load latency, 404 rate) — the metrics that describe what your users actually experience, not just what your servers are doing.
* **Centralized logging and CloudWatch anomaly detection.** Streaming logs (from a load balancer, from GuardDuty, from application code) into **CloudWatch Logs** gives you one place to query with **CloudWatch Logs Insights**, which lets you write SQL-like queries against log data directly. **CloudWatch anomaly detection** applies machine learning to a chosen metric and alarms on statistically abnormal behavior without you having to hand-tune a static threshold.
* **Beyond 10 million users.** The talk is candid that this is a different, deeper problem: fine-tuning becomes specific to every individual component rather than following a generic playbook, multi-AZ architectures typically become multi-*region* to actually shorten the physical distance to users worldwide, and some teams end up building custom deployment/monitoring tooling suited to their particular workload. The default advice doesn't change, though — reach for native, managed AWS components first, and build custom only where you've confirmed you actually need to.
* **The [AWS Well-Architected Framework](https://aws.amazon.com/architecture/well-architected/)** is the natural next read: it formalizes many of the trade-offs in this case study (five pillars, including reliability and cost) into a structured review process for an existing architecture, rather than a first-build narrative like this one.

## Source(s) and further reading

* [Scaling Up to Your First 10 Million Users — AWS re:Invent 2019 (ARC211-R)](https://www.youtube.com/watch?v=kKjm4ehYiMs) — the original talk this case study condenses, presented by AWS Solutions Architects Brian Fenhagen and Hoa Pham
* [AWS Well-Architected Framework](https://aws.amazon.com/architecture/well-architected/) — the deeper, review-oriented companion to the staged narrative above
* [Horizontal Scaling](/docs/patterns/scaling/horizontal-scaling) and [Vertical Scaling](/docs/patterns/scaling/vertical-scaling) — the two levers introduced at the 1,000-user stage
* [Load Balancing](/docs/patterns/api-edge/load-balancing) — the ALB's role once there's more than one web instance
* [CDN](/docs/patterns/building-blocks/cdn) and [Cache-Aside](/docs/patterns/caching/cache-aside) — CloudFront and ElastiCache, the two techniques that keep load off the origin
* [Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication) — RDS/Aurora read replicas
* [Auto Scaling](/docs/patterns/scaling/auto-scaling) and [Health Check](/docs/patterns/observability/health-check) — automated fleet sizing and unhealthy-instance replacement
* [Event-Driven Architecture](/docs/patterns/communication/event-driven-architecture), [Pub/Sub](/docs/patterns/communication/pub-sub), and [Distributed Message Queue](/docs/patterns/building-blocks/distributed-message-queue) — the loose coupling behind SQS/SNS-connected microservices
* [Distributed Tracing](/docs/patterns/observability/distributed-tracing) — what X-Ray provides across a service-oriented architecture
* [Federation](/docs/patterns/storage/federation), [Sharding](/docs/patterns/storage/sharding), and [Consistent Hashing](/docs/patterns/storage/consistent-hashing) — the three database-scaling techniques for the 5-10 million user stage
