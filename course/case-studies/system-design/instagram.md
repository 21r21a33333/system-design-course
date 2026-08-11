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

This is the central design decision for a photo feed specifically, and it's worth being explicit about why it's *this* system's central decision rather than a generic scaling afterthought: with a 30:1 read-to-write ratio and highly skewed follower counts, the naive "compute the feed at read time by querying every followed user's recent posts" approach means the far more frequent operation (reads) pays the full cost every single time, while a precomputed approach pays that cost once per post and reads become cheap lookups. Two strategies, and a real design mixes them:

**Fan-out-on-write (push):** when a user posts, the fan-out service looks up their followers in the **social graph store** and inserts a reference to the new post (not the image bytes — just `post_id` and a timestamp) into each follower's precomputed **feed store** entry. A feed read then becomes a single cheap lookup: fetch this user's feed list, already sorted, already assembled. This is a great fit when follower counts are modest (the median case in this design's assumptions) — a few hundred insertions per post is cheap.

**Fan-out-on-read (pull):** for accounts with enormous follower counts, push becomes the wrong trade — a single post from an account with 30 million followers would mean 30 million feed-store writes for one upload, an amount of write amplification that dwarfs the read savings it buys. Instead, these accounts' posts are excluded from push fan-out; a feed read for someone following one or more such accounts merges their precomputed feed-store entries with a small number of live lookups against those specific high-follower accounts' recent posts, at read time.

Splitting by a follower-count threshold — push below it, pull above it — gets the benefit of cheap reads for the common case without paying an enormous write cost for the skewed tail. This is a direct application of the same idea [CQRS](/docs/patterns/storage/cqrs) describes in general: optimize the write path and the read path independently rather than forcing one data shape to serve both well, and here that split is threshold-based rather than a single global strategy. It's worth noting explicitly how this differs from a video platform's fan-out problem (see the YouTube case study in this course): here, fan-out is about *distributing a reference to lightweight content* (a post ID) to potentially millions of feed lists cheaply, whereas a video platform's harder problem is preparing the *content itself* — encoding a large file into multiple renditions — before it's even servable to anyone, which is a pipeline problem, not a fan-out-strategy problem.

### Use case: User views another user's profile grid

Unlike the home feed, a profile grid is just one user's own posts in reverse-chronological order — no fan-out or social-graph merge needed, since it's not aggregating across multiple people. This is a straightforward paginated query against the **post store** by `user_id`, ordered by `created_at`. Because a request for the next page of someone's grid can arrive with posts still being inserted concurrently, this is a natural fit for [Cursor Pagination](/docs/patterns/api-edge/cursor-pagination) rather than offset-based paging, so that pagination stays stable even as new posts land.

### Use case: User likes or comments on a post

Likes are extremely high-frequency, low-value-per-write events concentrated on a small number of popular posts — a single popular post can receive thousands of likes within minutes of being posted, all racing to increment the same counter. Treating `like_count` as a single row that every like directly increments and locks would make popular posts a serialization bottleneck exactly when they're getting the most attention. Instead, the count is maintained as a [Sharded Counter](/docs/patterns/building-blocks/sharded-counters): the true count is the sum across several shards, each like increments one (randomly or hash-selected) shard, and the displayed count is read from a periodically-refreshed aggregate rather than summed fresh on every single feed render, which would itself become expensive at feed-open volume.

The like/comment *event* itself (who liked what, when) is written durably and independently of the counter — the counter is a fast, slightly-lagged aggregate for display; the underlying event log is the source of truth for anything that needs exact correctness (e.g., "did user X like this post," shown as a filled/unfilled icon, which needs an exact per-user answer, not an aggregate).

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
