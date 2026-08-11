---
title: "Design Instagram (or a Photo-Sharing Feed)"
sidebar_position: 11
---

A photo-sharing feed is, at its core, a fan-out problem: a small number of writes (posts) need to reach a large number of reads (followers' feeds), and the feed has to feel instantaneous to open even though the underlying content is scattered across many other users' accounts.

*Educative's Grokking Modern System Design Interview course covers this same system in its "Design Instagram" module.*

## Step 1: Outline use cases and constraints

### Use cases

#### We'll scope the problem to handle the following use cases

* **User** uploads a photo (with an optional caption) to their profile
* **User** follows another user
* **User** views their home feed — recent posts from everyone they follow, most-recent-first
* **User** views another user's profile grid of past posts
* **User** likes and comments on a post
* **Service** has high availability; feed loads should stay fast regardless of how many people a user follows or how many followers a poster has

#### Out of scope

* Stories/ephemeral content (24-hour expiry) — different lifecycle, worth a one-line mention only
* Ranking/relevance-based feed ordering (this design uses reverse-chronological; ranked feed is a valid follow-up discussion, not designed in depth)
* Direct messaging
* Content moderation and abuse detection

### Constraints and assumptions

#### State assumptions

* 150 million daily active users
* Average user posts 0.2 times/day (1 photo roughly every 5 days) but opens their feed 6 times/day — this is a heavily read-skewed system
* Average photo, after server-side compression/resizing into a few standard display sizes, totals ~400 KB across those variants
* Follower counts are extremely skewed: the median user has a few hundred followers, but a small population of accounts has tens of millions
* Feed open should render in well under a second; users notice and complain past ~1-2 seconds
* Reverse-chronological feed only for this design — no personalized ranking model
* Eventual consistency is acceptable for feed contents (a post appearing in a follower's feed a few seconds late is fine); it is not acceptable for the post itself to be lost, or for like/comment counts to diverge wildly from reality for long

#### Calculate usage

* Posts/day: 150,000,000 × 0.2 = **30 million new posts/day** → 30,000,000 / 86,400 ≈ **~350 writes/sec average**, peakier around evenings, say **~1,500 writes/sec at peak**
* Feed reads/day: 150,000,000 × 6 = **900 million feed opens/day** → 900,000,000 / 86,400 ≈ **~10,400 reads/sec average**, **~35,000-40,000 reads/sec at peak** — roughly **30:1 read-to-write ratio**, which is the single number that most shapes this design
* Storage per post: image bytes (~400 KB across resized variants, stored as blobs) + metadata row (`post_id`, `user_id`, `caption`, `created_at`, `like_count`, `comment_count` ≈ 200 bytes) — metadata is cheap, image bytes dominate
    * 30 million posts/day × 400 KB ≈ **~12 TB/day** of new image data, **~4.4 PB/year** — this is squarely blob-storage-and-CDN territory, not something that belongs in a primary database
* Fan-out volume: this is the number that determines the feed architecture. If the average poster has, say, 300 followers, each post triggers up to 300 feed-insertion events: 30 million posts/day × 300 ≈ **9 billion feed-insertion events/day**, or **~100,000/sec average** — notably *larger* than the read volume itself, and the reason fan-out strategy (Step 3) is the central design decision here, not an afterthought
* Like/comment events are higher-frequency but each individually tiny (`post_id`, `user_id`, `type`, `timestamp` ≈ 30 bytes) — even at 10x post volume this is under a GB/day, cheap to store but, at high concurrency on popular posts, a counter-contention problem worth its own design discussion (Step 3)

## Step 2: Create a high-level design

![Instagram high-level architecture](/img/case-studies/instagram-overview.svg)

An upload goes through a **post service**, which writes the image to **blob storage** behind a **CDN** and a small metadata row to a **post store**, then hands off to a **fan-out service** that's responsible for getting that post into the right followers' feeds. A **feed service** answers "what should this user see right now" — either by reading a precomputed **feed store** (the common case) or, for the small population of accounts that make precomputation impractical, by merging results at read time. A **social graph store** tracks the follow relationships that both fan-out and feed reads depend on, and a **counters service** handles like/comment counts separately from the post metadata itself, since counts mutate far more often than anything else about a post.

The feed's read-heavy skew (30:1 in this design's numbers) is the reason the architecture leans so heavily on precomputation and caching rather than computing each feed fresh from the social graph on every open — that would mean the 30x more frequent operation does the most work, exactly backwards from where the effort should go.

## Step 3: Design core components

### Use case: User uploads a photo

* Client uploads the original image, typically over a resumable/chunked upload given mobile network conditions, directly to **blob storage** (a service like Amazon S3 or a comparable cloud object store is a typical real-world fit) or through the post service acting as a thin pass-through — see [Blob Store](/docs/patterns/building-blocks/blob-store)
* An asynchronous processing step generates the standard display sizes (thumbnail, feed-width, full-screen) and writes them alongside the original
* The **post service** writes a metadata row (`post_id`, `user_id`, `image_urls`, `caption`, `created_at`) to the **post store**, and only after that succeeds, publishes a "new post" event
* The **fan-out service** consumes that event and is responsible for making the post appear in followers' feeds (see the fan-out use case below)

Doing image processing asynchronously, off the critical path of "upload finished," matters here: a user shouldn't wait for every resized variant to be generated before their upload is acknowledged as successful. This is the same asynchronous-decoupling idea as [Event-Driven Architecture](/docs/patterns/communication/event-driven-architecture) — the post service's job ends at "durably recorded," and everything downstream (resizing, fan-out, search indexing) reacts to that event independently.

### Use case: User views their home feed — the fan-out decision

This is the central design decision for a photo feed specifically, and it's worth being explicit about why it's *this* system's central decision rather than a generic scaling afterthought: with a 30:1 read-to-write ratio, the naive "compute the feed at read time by querying every followed user's recent posts" approach means the far more frequent operation (reads) pays the full cost every single time, while a precomputed approach pays that cost once per post and reads become cheap lookups.

**Core algorithm: hybrid push/pull fan-out**

```python
CELEBRITY_FOLLOWER_THRESHOLD = 10_000

class FanOutService:
    """Fan-out-on-write (push) for normal accounts, fan-out-on-read
    (pull) for high-follower accounts -- this split is what makes the
    'the gotcha' below tractable rather than a wall the design hits at
    scale.
    """

    def __init__(self, social_graph, feed_store, post_store):
        self.social_graph = social_graph   # follower/following lookups
        self.feed_store = feed_store       # precomputed per-user feed lists
        self.post_store = post_store       # durable post metadata

    def on_new_post(self, post_id, author_id, created_at):
        follower_count = self.social_graph.follower_count(author_id)
        if follower_count < CELEBRITY_FOLLOWER_THRESHOLD:
            self._push_fan_out(post_id, author_id, created_at)
        else:
            # Deliberately skip fan-out entirely -- this post is never
            # written into any follower's feed_store. It's picked up
            # at read time instead. This is "the celebrity problem":
            # a push here would mean millions of feed_store writes for
            # one upload, dwarfing the read-time cost it would save.
            self._mark_as_pull_only(post_id, author_id)

    def _push_fan_out(self, post_id, author_id, created_at):
        for follower_id in self.social_graph.followers(author_id):
            self.feed_store.insert(follower_id, post_id, created_at)

    def _mark_as_pull_only(self, post_id, author_id):
        self.post_store.tag_pull_only(post_id, author_id)

    def get_feed(self, user_id, limit=30):
        """Read-time merge: start from the precomputed (pushed) feed,
        then merge in live posts from any celebrity accounts this user
        follows -- the only place those posts ever get materialized
        for this reader.
        """
        pushed_posts = self.feed_store.get(user_id, limit=limit)
        celebrities_followed = self.social_graph.followed_accounts_above(
            user_id, follower_threshold=CELEBRITY_FOLLOWER_THRESHOLD
        )
        pulled_posts = []
        for celeb_id in celebrities_followed:
            pulled_posts.extend(
                self.post_store.recent_posts(celeb_id, limit=limit)
            )
        merged = sorted(pushed_posts + pulled_posts, key=lambda p: p.created_at, reverse=True)
        return merged[:limit]
```

A feed read for a user following only normal accounts is the cheap, common case: a single `feed_store.get` lookup, already sorted, already assembled. A feed read for a user following one or more celebrity accounts pays a small, bounded extra cost — a handful of live lookups against specifically those accounts' recent posts, not a query against the entire social graph.

**Data structures:**
* `feed_store`: `user_id -> [(post_id, created_at), ...]` — precomputed, pushed entries only; celebrity posts are never in here
* `social_graph`: `followed_accounts_above(user_id, threshold)` — needs an index on follower *count* per account, not just the raw follow-edge list, so this filter doesn't require scanning every followed account's follower count at read time
* `post_store`: adds a `tag_pull_only` marker so `recent_posts(celeb_id)` can be served as a fast, small range query (recent posts by one author, not a full feed computation)

**Trade-offs:**
* **The gotcha — this is "the celebrity problem," and it's the specific trap that separates a junior fan-out answer from a senior one:** naive push-only fan-out looks correct and performs fine right up until an account with millions of followers posts, at which point one upload triggers millions of feed-store writes, an amount of write amplification that can degrade the whole fan-out pipeline for every other user's posts queued behind it, not just the celebrity's own followers. The fix isn't "push, but faster" — it's structural: exclude high-follower accounts from push entirely and merge their posts in at read time instead, accepting a slightly more expensive read for anyone following a celebrity in exchange for never paying an unbounded write cost on that celebrity's post. A commonly cited threshold for "high-follower enough to switch strategies" is in the tens of thousands of followers, though a real system tunes this against actual write-amplification cost rather than treating any single number as fixed.
* This is a direct application of the same idea [CQRS](/docs/patterns/storage/cqrs) describes in general: optimize the write path and the read path independently rather than forcing one data shape to serve both well — here the split is threshold-based (push below it, pull above it) rather than a single global strategy.
* It's worth noting explicitly how this differs from a video platform's fan-out problem (see the YouTube case study in this course): here, fan-out is about *distributing a reference to lightweight content* (a post ID) to potentially millions of feed lists cheaply, whereas a video platform's harder problem is preparing the *content itself* — encoding a large file into multiple renditions — before it's even servable to anyone, which is a pipeline problem, not a fan-out-strategy problem. It's also worth distinguishing from WhatsApp's group-chat fan-out (elsewhere in this course): WhatsApp's per-recipient push is viable specifically because group sizes stay in the dozens — the same push-only approach applied to a follower list of millions is exactly the failure mode the celebrity threshold exists to avoid.

**REST API:**

```
$ curl https://instagram.example/api/v1/feed?user_id=8821&limit=30 \
    -H "Authorization: Bearer <token>"
```

Response:

```json
{
  "posts": [
    {"post_id": "p_991a", "author_id": "u_204", "created_at": "2026-08-11T13:58:02Z", "source": "pushed"},
    {"post_id": "p_88f2", "author_id": "u_1", "created_at": "2026-08-11T13:57:40Z", "source": "pulled"}
  ],
  "next_cursor": "eyJvZmZzZXQiOjMwfQ=="
}
```

### Use case: User views another user's profile grid

Unlike the home feed, a profile grid is just one user's own posts in reverse-chronological order — no fan-out or social-graph merge needed, since it's not aggregating across multiple people. This is a straightforward paginated query against the **post store** by `user_id`, ordered by `created_at`. Because a request for the next page of someone's grid can arrive with posts still being inserted concurrently, this is a natural fit for [Cursor Pagination](/docs/patterns/api-edge/cursor-pagination) rather than offset-based paging, so that pagination stays stable even as new posts land. Same REST shape as the feed endpoint above — `GET /api/v1/users/{user_id}/posts?limit=30&cursor=...` — with no `source` field, since every post here is the same author's own.

### Use case: User likes or comments on a post

The hard problem: absorb bursty, highly-concentrated write volume (thousands of likes on one post within minutes) without that popular post becoming a bottleneck for everyone else's traffic.

**Core spec: sharded counter**

```python
import random

class LikeCounter:
    """Sharded counter: a popular post's like_count is spread across N
    shards so concurrent likes on one post don't all serialize on a
    single row's lock -- same shape as the sharded click counter in
    this course's TinyURL case study, applied to a much higher and
    more bursty write rate.
    """
    SHARDS_PER_POST = 20

    def __init__(self, store):
        self.store = store  # key: (post_id, shard_id) -> count

    def record_like(self, post_id):
        shard_id = random.randint(0, self.SHARDS_PER_POST - 1)
        self.store.increment((post_id, shard_id))

    def total_likes(self, post_id):
        # Read once per cache-refresh interval, not once per feed
        # render -- see Step 4 for how the displayed count is cached.
        return sum(
            self.store.get((post_id, shard_id)) or 0
            for shard_id in range(self.SHARDS_PER_POST)
        )
```

**Data structures:**
* `like_counts`: `(post_id, shard_id) -> count` — wide, sparse table, not one row per post
* `likes` (event log, separate from the counter): `post_id`, `user_id`, `created_at`, composite PK `(post_id, user_id)` — the source of truth for "did user X like this post," which needs an exact per-user answer (the filled/unfilled heart icon), not an aggregate

**Trade-offs:**
* Treating `like_count` as a single row that every like directly increments and locks would make popular posts a serialization bottleneck exactly when they're getting the most attention — the same [Sharded Counter](/docs/patterns/building-blocks/sharded-counters) reasoning as this course's TinyURL and YouTube case studies apply here, just at a higher and more bursty write rate given how concentrated likes are in the minutes right after a popular post goes up.
* The like/comment *event* itself is written durably and independently of the counter — the counter is a fast, slightly-lagged aggregate for display; the event log is what anything needing exact correctness reads from instead.

## Step 4: Scale the design

![Instagram scaled architecture](/img/case-studies/instagram-scaled.svg)

**Image delivery is the highest-volume traffic in the system and shouldn't touch application servers at all.** Once an image is processed into its display variants, it's immutable — nothing about a photo's pixels changes after upload — which makes it about as ideal a caching candidate as exists. A [CDN](/docs/patterns/building-blocks/cdn) in front of blob storage (a CDN such as Cloudflare, Fastly, or a cloud provider's own edge network is the kind of real building block this role maps to) serves the overwhelming majority of image requests without ever reaching the origin, which matters enormously given this design's ~40,000 reads/sec at peak, each of which touches multiple images.

**The feed store's read path is the second-highest-volume path and is served primarily from an in-memory cache, with the durable feed store as the source of truth behind it.** A user's precomputed feed list rarely needs anything more durable-feeling than "recompute from the social graph and recent posts if the cache entry is ever lost" — see [Cache-Aside](/docs/patterns/caching/cache-aside). Because feed reads so heavily outnumber feed writes, keeping only active users' feed entries warm in cache (evicting users who haven't opened the app recently) keeps the cache working set proportional to actual daily activity rather than the full user base.

**The fan-out write path scales by moving fan-out off the synchronous post-upload path entirely.** The post service publishes a "new post" event and returns success immediately; a pool of fan-out workers consuming from a [Distributed Message Queue](/docs/patterns/building-blocks/distributed-message-queue) (Kafka is a common real-world choice for this kind of high-throughput event backbone) does the (potentially large, for a mid-size popular account) work of inserting into follower feed-store entries, so a burst of a popular account's posts landing at the same time doesn't stall uploads for anyone. This is [Queue-Based Load Leveling](/docs/patterns/batch-streaming/queue-based-load-leveling) applied to the fan-out-on-write path specifically.

**The social graph store scales by sharding on `user_id`**, since "who does this user follow" and "who follows this user" are both keyed off a single user — see [Sharding](/docs/patterns/storage/sharding). At this design's scale, followers/following lists are read constantly (every fan-out, every feed merge) and written comparatively rarely (follow/unfollow), which argues for aggressively caching graph reads on top of a sharded durable store, similar to the treatment the Social Graph case study elsewhere in this course goes into in more depth.

**The post store itself scales by sharding, most naturally by `user_id` or `post_id`**, and separating hot recent posts from a much larger cold archive — most feed and profile-grid traffic touches only recent posts, so a tiered storage approach (recent posts on faster storage, older posts moved to cheaper storage) keeps the expensive tier small relative to total data volume, the same pattern this design already applies to image blobs.

## Additional talking points

* **The high-follower-count threshold for switching from push to pull fan-out isn't a fixed universal constant** — it should be tuned against real write-amplification costs, and a stronger design would make it adaptive (per-account, based on actual follower count and posting frequency) rather than a single global cutoff decided once.
* **Feed staleness tolerance is what makes eventual consistency acceptable here**, but it's worth stating the boundary explicitly: the *post itself* (upload succeeded, is retrievable, isn't lost) needs strong durability guarantees; *where it currently appears in fan-out* does not. Conflating those two would either make uploads slower than necessary or make feed correctness weaker than it should be.
* **Deleting a post has to reverse the same fan-out** it went through on write — a delete needs to remove or tombstone the post reference from every feed-store entry it was pushed into, which is real work proportional to follower count, same as the original fan-out, and easy to forget when focused only on the write path.
* **Why reverse-chronological rather than ranked, given this is a real product decision Instagram actually made?** Worth a brief honest note: ranking by predicted engagement is a materially different and harder system (needs a scoring model, feature pipeline, and re-ranking at read time) layered on top of everything described here, not a replacement for it — the fan-out and storage architecture above is largely a prerequisite either way.

## Source(s) and further reading

* [Instagram Engineering — Meta Engineering](https://engineering.fb.com/tag/instagram/) — Meta's real engineering blog coverage of Instagram's infrastructure, including feed and storage systems
* [CQRS](/docs/patterns/storage/cqrs) — the general read/write-path-separation principle this design's push/pull threshold split applies
* [Sharded Counter](/docs/patterns/building-blocks/sharded-counters) — the pattern behind this design's like-count implementation
* [Feed (Facebook) — Wikipedia](https://en.wikipedia.org/wiki/Feed_(Facebook)) — background on the general social-feed product concept this design implements a specific architecture for
* [Cursor Pagination](/docs/patterns/api-edge/cursor-pagination) — the pagination approach used for both the profile grid and feed endpoints above
