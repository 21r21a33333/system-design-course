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

**Data structures:** `activity_envelope` — `activity_id`, `author_id`, `activity_type`, `created_at`, `ranking_signals` (small struct, type-specific keys), `payload_ref`.

### Use case: Fan-out — getting an activity into followers' feeds

This design uses the same push/pull split by follower-count threshold that this course's Instagram case study covers in depth for a single content type (see that case study for the full `FanOutService` mechanism and its celebrity-threshold gotcha — not re-derived here). The newsfeed-specific point worth making instead is about **merging across types, not just distributing one type**: when fan-out pushes an envelope into a follower's feed-store entry, that entry is now a heterogeneous, sorted list of envelopes from potentially many different activity types and authors — a status update from a close friend, a share from a page, a status update from someone else — and the feed-store entry's job is to hold them in a form the ranking step (below) can score uniformly, which is exactly why every envelope carries the same small set of common fields regardless of source type.

A high-volume source (a page posting many times a day) uses the same pull-at-read-time treatment this course's Instagram case study applies to high-follower accounts, but for a related, distinct reason: it's not only that push fan-out would be expensive for a large audience, it's that a source publishing frequently would otherwise dominate a follower's feed by sheer count if every one of its activities were pushed and interleaved chronologically with much rarer activity from other sources. Handling high-volume sources at read time, merged in through ranking rather than raw insertion order, is what keeps a feed from being crowded out by whichever source happens to post most often — a concern that's specific to a *merged, multi-source* feed and doesn't really arise in a single-content-type design where every source is, by definition, the same type of thing posting at roughly comparable rates.

**Data structures:** `feed_store`: `user_id -> [activity_envelope, ...]`, heterogeneous by `activity_type`, sorted by `created_at` — same shape as Instagram's `feed_store` generalized to carry mixed envelope types instead of one.

### Use case: User opens their feed — ranking, this design's central problem

This is the use case where a generic multi-source feed diverges most from a single-content-type feed like a photo stream: fan-out mechanics (push/pull by threshold) are the same shape either way, but **deciding what order heterogeneous content should appear in** is a genuinely harder problem once a feed mixes a close friend's status update, a page's promotional post, and an acquaintance's share — reverse-chronological alone treats all three as equivalent, which is rarely what a viewer actually wants.

**Core algorithm: EdgeRank — the canonical reference formula for feed ranking**

Facebook's original, publicly-documented feed-ranking formula, EdgeRank, scores each candidate item ("edge," in the graph sense of an author-viewer-activity relationship) as the product of three factors:

```
score = affinity_score(viewer, author) × edge_weight(activity_type) × time_decay(created_at, now)
```

* **Affinity score** — how connected the viewer is to the author (interaction history: comments, likes, messages exchanged) — a close friend or frequently-interacted-with page scores higher than a rarely-interacted-with connection.
* **Edge weight** — a static or slowly-tuned weight per activity type/interaction type (historically, EdgeRank weighted comments higher than likes, on the reasoning that a comment signals more investment than a tap) — in this generic design, this is the per-`activity_type` weight already carried in `ranking_signals`.
* **Time decay** — score falls off as an activity ages, so a highly-affine, heavily-weighted activity from days ago doesn't permanently outrank everything newer.

```python
import math
import time

class EdgeRankScorer:
    """Simplified EdgeRank: score = affinity x weight x time_decay.
    This is the pluggable ranking step referenced in Step 2 -- it
    consumes the common envelope fields and an affinity lookup, and
    knows nothing about fan-out or storage underneath it.
    """
    TYPE_WEIGHTS = {
        "status_update": 1.0,
        "share": 0.7,
        "page_post": 0.5,
        "comment_activity": 1.3,   # higher-investment interaction types score higher
    }
    DECAY_HALF_LIFE_SECONDS = 6 * 3600  # score halves roughly every 6 hours

    def __init__(self, affinity_store):
        self.affinity_store = affinity_store  # (viewer_id, author_id) -> float in [0, 1]

    def score(self, viewer_id, envelope, now=None):
        now = now or time.time()
        affinity = self.affinity_store.get(viewer_id, envelope.author_id, default=0.1)
        weight = self.TYPE_WEIGHTS.get(envelope.activity_type, 0.5)
        age_seconds = max(now - envelope.created_at, 0)
        decay = math.pow(0.5, age_seconds / self.DECAY_HALF_LIFE_SECONDS)
        return affinity * weight * decay

    def rank(self, viewer_id, envelopes, now=None, limit=30):
        scored = [(e, self.score(viewer_id, e, now)) for e in envelopes]
        scored.sort(key=lambda pair: pair[1], reverse=True)
        return [e for e, _ in scored[:limit]]
```

* The feed service fetches the current user's precomputed feed-store entries (already containing envelopes from pushed sources)
* It merges in a small number of live lookups against any high-volume pull sources the user follows, per the fan-out use case above
* It runs `EdgeRankScorer.rank` over the combined candidate set and returns the top N

**Data structures:**
* `affinity_store`: `(viewer_id, author_id) -> affinity_score` — maintained incrementally from interaction events (a like, a comment, a message), similar in spirit to the incrementally-maintained aggregates this course's Yelp case study uses for ratings, but keyed by a viewer-author pair instead of a single business
* `ranking_signals` within each envelope carries the `activity_type` the weight table keys off, plus any type-specific signals a more sophisticated scorer might use

**Trade-offs:**
* **The gotcha:** treating "ranking" as a vague, unspecified black box — "then we rank by relevance" — is the answer that falls apart under a follow-up question, because it hides the actual design decision: relevance has to be a concrete, computable function of concrete signals, or there's nothing to reason about, tune, or debug. Naming EdgeRank's three-factor shape explicitly (affinity × weight × decay) turns "rank by relevance" into a function with inputs a reviewer can interrogate — where does affinity come from, how is decay tuned, what happens when weights conflict — rather than a hand-wave.
* Multiplying three factors means any one factor collapsing to near-zero (a very old post, a never-interacted-with author) can suppress an otherwise-relevant item entirely — worth knowing as a property of the multiplicative shape, not just an implementation detail; an additive or otherwise-blended formula would behave differently at the extremes.
* This scoring step runs against a small candidate set (a user's precomputed feed-store entries plus a handful of pull-source lookups), not the full activity dataset — the same "rank a small, already-assembled candidate set" shape this course's Yelp case study uses for distance/rating scoring, just with a different formula suited to a social-affinity signal instead of geographic distance.
* Real feed-ranking systems (Facebook's EdgeRank was later superseded internally by machine-learned ranking models) evolve well past a fixed three-factor formula — but the structural point holds regardless of sophistication: ranking is a scoring function over typed signals, evaluated against a bounded candidate set, decoupled from fan-out and storage.

See: [EdgeRank — Wikipedia](https://en.wikipedia.org/wiki/EdgeRank) and [Facebook News Feed — Wikipedia](https://en.wikipedia.org/wiki/Facebook_News_Feed) for the original formula's public documentation and history.

**REST API:**

```
$ curl "https://newsfeed.example/api/v1/feed?user_id=8821&limit=30" \
    -H "Authorization: Bearer <token>"
```

Response:

```json
{
  "activities": [
    {"activity_id": "a_7712", "author_id": "u_204", "activity_type": "status_update", "score": 0.61, "source": "pushed"},
    {"activity_id": "a_9903", "author_id": "u_1", "activity_type": "page_post", "score": 0.44, "source": "pulled"}
  ],
  "next_cursor": "eyJvZmZzZXQiOjMwfQ=="
}
```

### Use case: User hides content or unfollows a source

An unfollow needs two effects: the social graph store stops considering that source for *future* fan-out (a straightforward graph edge removal), and — separately — any already-fanned-out entries from that source in the user's existing feed-store entry ideally stop appearing too, not just future ones. The second part is a smaller-scale version of the same "reverse a prior fan-out" problem this course's Instagram case study raises for deletes: removing or tombstoning matching entries from one user's feed store, scoped to just that one user-source pair, rather than the whole-audience reversal a content deletion requires. A hide action on a single piece of content is narrower still — it only needs a per-user suppression marker checked at read time, since re-deriving "is this specific activity hidden for this specific user" from the feed store directly would require a write per hide action anyway, and a lightweight suppression list read alongside the feed-store fetch accomplishes the same thing with less write amplification.

**Data structures:** `suppressions`: `(user_id, activity_id) -> hidden_at` — checked as a filter at read time, not a write against the feed-store entry itself.

**Trade-offs:**
* Unfollowing also has a ranking-side effect worth naming given this use case's focus above: it's not just a graph edge removal — a source a user just unfollowed should also stop contributing to that user's `affinity_store` going forward, or a later re-follow would resume from a stale affinity score that no longer reflects the relationship.

## Step 4: Scale the design

![Newsfeed scaled architecture](/img/case-studies/newsfeed-scaled.svg)

* **Feed opens are the highest-volume operation this system serves, and the feed store's durable tier isn't sized to take that load directly.** A cache layer sitting in front of the feed store (an in-memory store such as Redis or Memcached is a typical real fit for this per-user list shape) — see [Cache-Aside](/docs/patterns/caching/cache-aside) — absorbs the 16:1 read skew calculated in Step 1, but the sizing question worth calling out specifically for a multi-producer feed is that the *working set* to keep warm isn't "every user," it's "every user who's likely to open the app again soon" — evicting entries for accounts that haven't opened their feed recently keeps the cache proportional to actual daily engagement rather than to total registered users, a distinction that matters more here than it might for a smaller, single-purpose content type, since the feed store is now the aggregation point for every producer's traffic at once.
* **Fan-out is the dominant write-side cost and is handled entirely off the synchronous publish path**, through a pool of workers consuming from a [Distributed Message Queue](/docs/patterns/building-blocks/distributed-message-queue) (Kafka or a comparable cloud-managed log is a common real backbone for this) — see [Queue-Based Load Leveling](/docs/patterns/batch-streaming/queue-based-load-leveling). This matters more here than in a single-content-type feed precisely because fan-out volume in a merged, multi-producer system is the sum of fan-out across every activity type sharing the pipeline; a burst from one content type's producers shouldn't be able to starve fan-out capacity for the others, which argues for [Partitioned Consumption](/docs/patterns/batch-streaming/partitioned-consumption) of the fan-out queue so no single noisy activity type can monopolize workers.
* **The social graph is sharded by `user_id`, and the case for caching it comes specifically from how many different subsystems in this design depend on the same answer.** Fan-out needs it to know where to push; ranking's affinity signals need it; the read-time merge for pull-fan-out sources needs it. Rather than each of those paths querying a sharded durable store independently, the follow relationships that matter most — the accounts a given user follows, and the accounts that follow a given publisher — are worth keeping resident close to whichever service is asking. See [Sharding](/docs/patterns/storage/sharding) for the underlying partitioning and this course's Social Graph case study for a deeper treatment of the graph structure itself.
* **Ranking, as a pluggable step, benefits from being horizontally scaled independently of fan-out and storage.** Because `EdgeRankScorer.rank` is stateless given a candidate set and an affinity lookup, ranking workers can be scaled purely against feed-open volume without needing to coordinate with the fan-out or storage tiers — a clean separation that pays off specifically because ranking logic tends to iterate faster (new signals, new scoring weights) than the storage and fan-out layers underneath it, so decoupling them means ranking changes don't risk destabilizing the higher-volume, more latency-sensitive fan-out and storage paths.
* **The affinity store is a read-heavy dependency of ranking specifically, and benefits from the same caching treatment as the social graph** — every feed open's ranking pass reads an affinity score for every candidate author, so keeping a viewer's most-relevant affinity scores warm avoids a cold lookup per candidate on every single feed render.
* **Activity ingestion, as the single shared entry point for multiple producers, needs isolation so one content type's ingestion problems don't degrade another's.** A surge or outage in one activity-type producer shouldn't be able to back up the shared ingestion queue for every other type — see [Bulkhead](/docs/patterns/reliability/bulkhead) for partitioning capacity so failure in one part of a shared resource doesn't cascade into the rest.

## Additional talking points

* **Cross-type ranking fairness is a genuinely hard problem this design only gestures at.** Comparing a status update's engagement signals against a page-post's engagement signals on a single unified score is not obviously well-defined — different activity types may need type-specific normalization before they're comparable at all, which is a real modeling problem beyond this design's scope but worth naming explicitly rather than waving away. EdgeRank's fixed per-type weight table is a simple version of handling this; a more sophisticated system would learn type-specific normalization rather than hand-tune it.
* **Schema evolution of the activity envelope is an ongoing cost of the generic-feed approach**, not a one-time design decision — adding a genuinely new kind of ranking signal that only some activity types can populate means every consumer of the envelope (ranking, storage, fan-out) needs to handle its absence gracefully for older or unrelated types, which is the recurring tax paid for having one merged pipeline instead of one pipeline per content type.
* **Why not just run a separate feed pipeline per content type and merge only at render time on the client?** It's a legitimate alternative architecture, and it avoids the shared-envelope schema-evolution cost above — but it pushes the merge-and-rank problem to the client or to a thin aggregation layer that then has to fetch from every pipeline on every feed open, trading a shared backend concern for a fan-out-of-reads concern at request time. Worth raising as a real tradeoff, not a strictly worse option.
* **Backfilling a new user's feed on first follow.** A user who just followed someone with years of history has an empty feed-store entry for that relationship until new activity arrives — a reasonable design either leaves it empty (their feed simply starts reflecting new activity going forward) or does a bounded one-time backfill of that source's recent activity, which is extra write work worth calling out as a deliberate product decision, not a free operation.
* **EdgeRank's real history is a useful caveat to raise if pressed:** it was Facebook's original, publicly-documented formula, but production ranking at that scale moved on to machine-learned models with many more signals years ago — naming EdgeRank here is about having a concrete, nameable reference formula to reason about the *shape* of feed ranking (score = f(relationship, content, recency)), not a claim that any modern large-scale feed still runs literally this formula.

## Source(s) and further reading

* [EdgeRank — Wikipedia](https://en.wikipedia.org/wiki/EdgeRank) — the publicly-documented original Facebook feed-ranking formula this design's `EdgeRankScorer` implements a simplified version of
* [Facebook News Feed — Wikipedia](https://en.wikipedia.org/wiki/Facebook_News_Feed) — background and history of the product this ranking approach was built for
* [News Feed — Wikipedia](https://en.wikipedia.org/wiki/News_Feed) — the general social-feed product concept
* [Materialized View](/docs/patterns/storage/materialized-view) — the pattern behind this design's incrementally-maintained affinity scores
* [Queue-Based Load Leveling](/docs/patterns/batch-streaming/queue-based-load-leveling) — the pattern behind decoupling fan-out from the synchronous publish path
