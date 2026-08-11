---
title: "Design a Generic Newsfeed System"
sidebar_position: 15
---

A newsfeed aggregates activity across many different producers — posts, shares, status updates, page follows, group activity — into one merged, ranked stream per viewer. The interesting problem isn't any single content type; it's merging heterogeneous activity from many sources into a coherent per-user ordering, cheaply, at open time.

*Educative's Grokking Modern System Design Interview course covers this same system in its "Design Newsfeed System" module, including a "NewsFeed System Design (Mock Interview)" sub-lesson.*

## Step 1: Outline use cases and constraints

### Use cases

#### We'll scope the problem to handle the following use cases

* **User** publishes an activity (a status update, a link share, a generic "event") that's visible to their connections
* **User** follows/connects with other users and pages, and their feed reflects activity from all of them
* **User** opens their feed and sees a merged, ranked stream of recent activity from everyone and everything they follow
* **User** hides a piece of content or unfollows a source, and the feed reflects that going forward
* **Service** supports multiple distinct activity types in the same feed (not just one content type), each potentially with different production and consumption patterns
* **Service** has high availability; a feed should render even in degraded form rather than fail outright

#### Out of scope

* The specific rendering/UI of any one activity type (this design treats "activity" as an opaque, typed payload with an author, a timestamp, and enough metadata to rank and render a summary card)
* Machine-learning ranking model training and feature engineering (ranking is discussed as a pluggable scoring step, not designed as an ML system)
* Comments, reactions, and their own fan-out (each activity type could carry its own; not core to the merge problem this design focuses on)
* Real-time collaborative editing or messaging (a fundamentally different consistency and latency problem, out of scope here)

### Constraints and assumptions

#### State assumptions

* 250 million daily active users, each following/connected to a mix of people and pages, with a heavily skewed distribution — most users follow a modest number of sources, a smaller population follows or is followed by a very large number
* Average user opens their feed 8 times/day and publishes 0.5 activities/day (posts less often than they read, the same read-skew this course's Instagram case study observes for photo feeds, generalized here to arbitrary activity types)
* A feed is a **merge of multiple heterogeneous sources**, not a single content type — this is the defining difference from a single-content-type feed like a photo stream, and it's the reason ranking and storage in this design treat "activity" as a typed envelope rather than assuming a single schema
* Feed open should render in well under a second
* Reverse-chronological is the baseline; this design treats ranking as a scoring function applied on top of a candidate set, without designing a specific ranking model in depth
* Eventual consistency is acceptable for "when exactly does a new activity appear in a follower's feed" (a few seconds of delay is fine); it is not acceptable for an activity to be lost, or for an unfollow/hide action to be ignored indefinitely
* Feed composition needs to tolerate a source publishing at wildly different rates — a quiet personal account posting rarely and a high-volume page posting frequently both need to coexist correctly in the same merged feed without the high-volume source drowning out everything else by sheer count

#### Calculate usage

* Activities/day: 250,000,000 × 0.5 = **125 million new activities/day** → 125,000,000 / 86,400 ≈ **~1,450 writes/sec average**, **~5,000-6,000 writes/sec at peak**
* Feed reads/day: 250,000,000 × 8 = **2 billion feed opens/day** → 2,000,000,000 / 86,400 ≈ **~23,000 reads/sec average**, **~80,000-90,000 reads/sec at peak** — roughly a **16:1 read-to-write ratio**, again read-dominated but somewhat less extreme than a single-content-type feed, since a newsfeed's write volume includes multiple activity types stacking together rather than one
* Activity envelope storage: a generic activity record (`activity_id`, `author_id`, `activity_type`, `created_at`, `ranking_signals` (a small struct of type-specific scoring inputs), `payload_ref` (a reference to the type-specific content, stored elsewhere by whatever service owns that content type)) ≈ 150 bytes → 125,000,000 × 150 bytes ≈ **~19 GB/day** of envelope data, **~6.8 TB/year** — deliberately small, because the envelope never stores the actual content (a photo, a long post body); it's a lightweight, uniformly-shaped pointer that lets the feed system merge and rank without needing to understand every content type's full schema
* Fan-out volume: assuming a representative average of 150 followers/connections per publishing user (this design's population skews toward smaller personal networks more than a public-figure-heavy platform would), 125,000,000 activities/day × 150 ≈ **~19 billion feed-insertion events/day**, or **~215,000/sec average** — again, as in this course's Instagram case study, fan-out volume exceeds read volume in raw event count, which is why the fan-out strategy (Step 3) is a central decision rather than an afterthought, generalized here across multiple activity types instead of one
* Feed-store entry size: a feed entry needs only enough to sort and dedupe — `activity_id`, `author_id`, `activity_type`, `score`, `inserted_at` ≈ 40 bytes; even a generously large per-user feed window (a few thousand recent entries kept precomputed) is on the order of a few hundred KB per active user, comfortably within a per-user cache/store budget at this design's scale

## Step 2: Create a high-level design

![Newsfeed high-level architecture](/img/case-studies/newsfeed-overview.svg)

Multiple **activity producers** — one per content type (status updates, shares, page posts, and so on) — each publish through a common **activity ingestion** layer that normalizes whatever type-specific payload they carry into a uniform, lightweight **activity envelope**: who authored it, when, what type it is, and a small set of ranking-relevant signals, plus a reference back to the full content wherever that content type actually lives. A **fan-out service** takes each envelope and is responsible for getting a reference to it into the right followers' precomputed feed entries in a **feed store**. A **feed service** turns that precomputed feed store into an actual ordered result set on open — pulling the candidate entries and applying a **ranking step**, a scoring function over those candidates, before returning them to the client. A **social graph store**, shared conceptually with this course's Instagram and Uber-adjacent social-graph needs, tracks who follows whom and is the source fan-out consults to know where an activity needs to go.

The reason this design centers on a normalized envelope rather than one schema per content type living directly in the feed pipeline is the "multiple heterogeneous sources merged into one feed" requirement from Step 1: a feed service that had to understand the full schema of every activity type to rank and merge them would need to be modified every time a new activity type was added. An envelope with a small, stable set of common fields (author, timestamp, type, ranking signals) lets fan-out, storage, and ranking all operate generically, while each content type's own service owns the full-fidelity data the envelope merely points to.

## Step 3: Design core components

### Use case: User publishes an activity

* A type-specific producer (whichever service owns that activity type — a status-update service, a page-post service, and so on) durably persists the full content first, in whatever store fits that content type
* That producer then emits a normalized **activity envelope** to activity ingestion: `activity_id`, `author_id`, `activity_type`, `created_at`, a small set of ranking signals (for example, whether the activity is text-only or has media, which a ranking step might weight differently), and `payload_ref` pointing back to the full content
* Ingestion durably records the envelope and publishes a "new activity" event that the fan-out service consumes

This is the same publish-and-move-on shape this course's Instagram case study relies on for post uploads — see [Event-Driven Architecture](/docs/patterns/communication/event-driven-architecture) — but generalized in a way that's specific to a multi-producer feed: because many unrelated services publish through the same ingestion entry point, the envelope schema functions as a shared contract those services all depend on, not something one team owns outright. That's a meaningfully different constraint than a single-content-type pipeline has, where the one producer and the one pipeline can evolve together — here, adding a genuinely new activity type has to slot into an existing, already-depended-upon envelope shape rather than defining its own from scratch.

### Use case: Fan-out — getting an activity into followers' feeds

This design uses the same push/pull split by follower-count threshold that this course's Instagram case study covers in depth for a single content type, and rather than re-deriving that mechanism here, the newsfeed-specific point worth making is about **merging across types, not just distributing one type**. When fan-out pushes an envelope into a follower's feed-store entry, that entry is now a heterogeneous, sorted list of envelopes from potentially many different activity types and authors — a status update from a close friend, a share from a page, a status update from someone else — and the feed-store entry's job is to hold them in a form the ranking step can score uniformly, which is exactly why every envelope carries the same small set of common fields regardless of source type.

A high-volume source (a page posting many times a day) uses the same pull-at-read-time treatment this course's Instagram case study applies to high-follower accounts, but for a related, distinct reason: it's not only that push fan-out would be expensive for a large audience, it's that a source publishing frequently would otherwise dominate a follower's feed by sheer count if every one of its activities were pushed and interleaved chronologically with much rarer activity from other sources. Handling high-volume sources at read time, merged in through ranking rather than raw insertion order, is what keeps a feed from being crowded out by whichever source happens to post most often — a concern that's specific to a *merged, multi-source* feed and doesn't really arise in a single-content-type design where every source is, by definition, the same type of thing posting at roughly comparable rates.

### Use case: User opens their feed — ranking and merge

* The feed service fetches the current user's precomputed feed-store entries (already containing envelopes from pushed sources)
* It merges in a small number of live lookups against any high-volume pull sources the user follows, per the fan-out use case above
* It applies a ranking/scoring step to the combined candidate set and returns the top N, most-recent-first within any tied score band as a reasonable tiebreak

Treating ranking as a distinct step applied to an already-assembled candidate set — rather than baking ranking logic into fan-out or storage — is the generic-feed-specific design decision worth calling out. Because activities carry heterogeneous ranking signals (a share has different relevant signals than a status update), the scoring function needs a stable, typed input shape to work against regardless of what produced the activity, which is exactly what the common envelope fields are for. A simple version of this scoring step might just be recency with a small boost for author affinity; a more sophisticated one might weight engagement signals or content type — the important structural point is that this step is pluggable and swappable without touching fan-out or storage, since ranking logic tends to evolve far more often than the storage and fan-out mechanics underneath it.

### Use case: User hides content or unfollows a source

An unfollow needs two effects: the social graph store stops considering that source for *future* fan-out (a straightforward graph edge removal), and — separately — any already-fanned-out entries from that source in the user's existing feed-store entry ideally stop appearing too, not just future ones. The second part is a smaller-scale version of the same "reverse a prior fan-out" problem this course's Instagram case study raises for deletes: removing or tombstoning matching entries from one user's feed store, scoped to just that one user-source pair, rather than the whole-audience reversal a content deletion requires. A hide action on a single piece of content is narrower still — it only needs a per-user suppression marker checked at read time, since re-deriving "is this specific activity hidden for this specific user" from the feed store directly would require a write per hide action anyway, and a lightweight suppression list read alongside the feed-store fetch accomplishes the same thing with less write amplification.

## Step 4: Scale the design

![Newsfeed scaled architecture](/img/case-studies/newsfeed-scaled.svg)

**Feed opens are the highest-volume operation this system serves, and the feed store's durable tier isn't sized to take that load directly.** A cache layer sitting in front of the feed store (an in-memory store such as Redis or Memcached is a typical real fit for this per-user list shape) — see [Cache-Aside](/docs/patterns/caching/cache-aside) — absorbs the 16:1 read skew calculated in Step 1, but the sizing question worth calling out specifically for a multi-producer feed is that the *working set* to keep warm isn't "every user," it's "every user who's likely to open the app again soon" — evicting entries for accounts that haven't opened their feed recently keeps the cache proportional to actual daily engagement rather than to total registered users, a distinction that matters more here than it might for a smaller, single-purpose content type, since the feed store is now the aggregation point for every producer's traffic at once.

**Fan-out is the dominant write-side cost and is handled entirely off the synchronous publish path**, through a pool of workers consuming from a [Distributed Message Queue](/docs/patterns/building-blocks/distributed-message-queue) (Kafka or a comparable cloud-managed log is a common real backbone for this) — see [Queue-Based Load Leveling](/docs/patterns/batch-streaming/queue-based-load-leveling). This matters more here than in a single-content-type feed precisely because fan-out volume in a merged, multi-producer system is the sum of fan-out across every activity type sharing the pipeline; a burst from one content type's producers shouldn't be able to starve fan-out capacity for the others, which argues for [Partitioned Consumption](/docs/patterns/batch-streaming/partitioned-consumption) of the fan-out queue so no single noisy activity type can monopolize workers.

**The social graph is sharded by `user_id`, and the case for caching it comes specifically from how many different subsystems in this design depend on the same answer.** Fan-out needs it to know where to push; ranking's affinity signals need it; the read-time merge for pull-fan-out sources needs it. Rather than each of those paths querying a sharded durable store independently, the follow relationships that matter most — the accounts a given user follows, and the accounts that follow a given publisher — are worth keeping resident close to whichever service is asking, since a graph lookup that's cheap in isolation becomes a real cost once it's repeated across fan-out, ranking, and read-time merge for the same feed open. See [Sharding](/docs/patterns/storage/sharding) for the underlying partitioning and this course's Social Graph case study for a deeper treatment of the graph structure itself.

**Ranking, as a pluggable step, benefits from being horizontally scaled independently of fan-out and storage.** Because ranking is stateless given a candidate set and a set of signals, ranking workers can be scaled purely against feed-open volume without needing to coordinate with the fan-out or storage tiers — a clean separation that pays off specifically because ranking logic tends to iterate faster (new signals, new scoring weights) than the storage and fan-out layers underneath it, so decoupling them means ranking changes don't risk destabilizing the higher-volume, more latency-sensitive fan-out and storage paths.

**Activity ingestion, as the single shared entry point for multiple producers, needs isolation so one content type's ingestion problems don't degrade another's.** A surge or outage in one activity-type producer shouldn't be able to back up the shared ingestion queue for every other type — see [Bulkhead](/docs/patterns/reliability/bulkhead) for partitioning capacity so failure in one part of a shared resource doesn't cascade into the rest.

## Additional talking points

* **Cross-type ranking fairness is a genuinely hard problem this design only gestures at.** Comparing a status update's engagement signals against a page-post's engagement signals on a single unified score is not obviously well-defined — different activity types may need type-specific normalization before they're comparable at all, which is a real modeling problem beyond this design's scope but worth naming explicitly rather than waving away.
* **Schema evolution of the activity envelope is an ongoing cost of the generic-feed approach**, not a one-time design decision — adding a genuinely new kind of ranking signal that only some activity types can populate means every consumer of the envelope (ranking, storage, fan-out) needs to handle its absence gracefully for older or unrelated types, which is the recurring tax paid for having one merged pipeline instead of one pipeline per content type.
* **Why not just run a separate feed pipeline per content type and merge only at render time on the client?** It's a legitimate alternative architecture, and it avoids the shared-envelope schema-evolution cost above — but it pushes the merge-and-rank problem to the client or to a thin aggregation layer that then has to fetch from every pipeline on every feed open, trading a shared backend concern for a fan-out-of-reads concern at request time. Worth raising as a real tradeoff, not a strictly worse option.
* **Backfilling a new user's feed on first follow.** A user who just followed someone with years of history has an empty feed-store entry for that relationship until new activity arrives — a reasonable design either leaves it empty (their feed simply starts reflecting new activity going forward) or does a bounded one-time backfill of that source's recent activity, which is extra write work worth calling out as a deliberate product decision, not a free operation.
