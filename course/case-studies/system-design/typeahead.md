---
title: "Design Typeahead Suggestion (Search Autocomplete)"
sidebar_position: 17
---

Typeahead has one requirement that dwarfs everything else about it: a suggestion list has to appear while a user is still mid-keystroke, which means the entire prefix-to-suggestions round trip has to land in well under the time it takes to type the next character — a latency budget far tighter than almost anything else in this course, on a query pattern (prefix matching, not keyword matching) that a general-purpose data store isn't built to answer quickly.

## Step 1: Outline use cases and constraints

### Use cases

#### We'll scope the problem to handle the following use cases

* **User** types into a search box and sees a ranked list of suggested completions after each keystroke
* **Service** ranks suggestions primarily by historical search frequency, so common queries surface above rare ones sharing the same prefix
* **Service** updates suggestion rankings over time as query popularity shifts, without needing a full redeploy to reflect new trends
* **Service** returns a bounded number of suggestions (a handful, not a full list) per keystroke
* **Service** has high availability; a typeahead request that times out should fail silently (no suggestions shown) rather than block or delay the user's typing

#### Out of scope

* Personalized suggestions based on an individual user's own search history (this design ranks by aggregate, global frequency only)
* Spelling correction / fuzzy matching for typos (a real and common extension, but a distinct problem from prefix matching — worth a mention, not a design)
* Semantic or intent-based query suggestion (suggesting related queries that don't share a literal prefix)
* The downstream search engine that actually executes a query once submitted — this design stops at "suggest completions for a partially-typed query"

### Constraints and assumptions

#### State assumptions

* 10 million distinct queries searched per day across the service, with a long-tail distribution — a small number of queries account for a large share of volume, and most distinct queries are searched only a handful of times
* 100 million searches per day total (so the average searched query recurs roughly 10 times, consistent with a long-tail shape where a relatively small "head" of popular queries accounts for most of that repetition)
* A typed query averages 20 characters, meaning a single completed search can generate up to ~20 keystroke events, each of which is a potential typeahead request — though in practice a client debounces rapid keystrokes rather than firing a request per character, discussed in Step 3
* Suggestion latency must stay under roughly 100ms end to end, well below general web-response expectations, because this request fires on every keystroke and any perceptible lag makes the whole search box feel broken rather than just slow
* Suggestion data (which queries are popular) does not need to reflect the last few minutes of search activity — a ranking that's an hour or even a day stale is a perfectly acceptable tradeoff against the alternative of recomputing rankings synchronously on the request path
* The set of distinct historical queries, while large, is bounded and grows slowly relative to search volume — most searches are for a query that's been seen before, not a brand-new string

#### Calculate usage

* Typeahead request volume: assuming a debounced client fires roughly one suggestion request per 2-3 typed characters rather than per keystroke (discussed in Step 3), and each of the 100,000,000 daily searches involves a query averaging 20 characters, that's roughly 100,000,000 × (20/2.5) = **800 million typeahead requests/day** → 800,000,000 / 86,400 ≈ **~9,300 requests/sec average**, with typing activity peakier around waking hours in any given region — design for **~3x average at peak**, so **~28,000 requests/sec** — an order of magnitude higher request volume than the searches themselves, which is the single number that most shapes this design: the typeahead path has to be cheap enough per request to absorb that multiplier
* Query log storage: assume each of the 100,000,000 daily searches is logged as `(query_text, timestamp)` at roughly 30 bytes/entry → 100,000,000 × 30 bytes ≈ **~3 GB/day**, **~1.1 TB/year** of raw log data — small in absolute terms, and it's a write-once, append-only stream rather than something read on the request path, so its volume doesn't pressure the serving path directly
* Suggestion index size: assuming the long tail settles into roughly 50 million distinct historical query strings worth indexing (well above the 10 million searched *today*, since the index accumulates history over time), each averaging 20 bytes of text plus a frequency count and a small amount of structural overhead — a reasonable estimate lands around **~50-100 bytes of effective index data per distinct query** once the prefix structure itself (not just the raw strings) is accounted for, putting total index size in the **tens of GB** range — comfortably small enough to be a candidate for keeping substantially in memory across a modest serving fleet, which is the second fact, alongside request volume, that shapes this design most: this is a problem where the *data* is small but the *request rate against it* is enormous
* Update volume: query-log aggregation to refresh suggestion rankings runs as a periodic batch job, not per-search — even processing the full 100 million searches/day in a single daily pass is a batch workload sized in the tens-of-millions-of-records range, trivial compared to the 800 million/day read-side request volume above, reinforcing that this system's hard problem is overwhelmingly on the read path

## Step 2: Create a high-level design

![Typeahead high-level architecture](/img/case-studies/typeahead-overview.svg)

A client-side component **debounces** keystrokes and sends a partial query string to a **suggestion service**, which looks up matching completions in a **prefix index** built specifically to answer "give me the top-ranked completions for this prefix" without scanning anything proportional to the total number of known queries. That index is queried, not written, on the hot path — it's built and periodically refreshed offline by an **aggregation pipeline** that processes a **query log** of historical searches into ranked frequency counts, which are then used to (re)build the prefix index that the suggestion service serves from. The suggestion service itself holds no state of its own beyond a cached, in-memory copy of the current index, so it scales purely by adding more identical, stateless instances behind a load-balanced fan-out of the request volume calculated above.

The structural decision this design centers on is separating "what are the current popular queries" (a slow-changing, computation-heavy question, answered offline) from "given this prefix, what's ranked highest right now" (a per-keystroke, latency-critical question, answered by a lookup against a precomputed structure) — much like this course's Yelp case study separates slow-changing spatial data from its fast lookup path, but here the axis being separated is update-frequency versus read-latency rather than write-correctness versus read-scale. A design that tried to compute rankings live, per request, against a raw query log would never hit the 100ms budget Step 1 sets; a design that only ever served a static, never-updated index would drift further from actual current query popularity every day it wasn't rebuilt.

## Step 3: Design core components

### Use case: User types into a search box and sees suggestions after each keystroke

* The client waits briefly (a debounce window, typically on the order of 100-200ms) after each keystroke before issuing a request, rather than firing one request per character — since a fast typist produces keystrokes faster than a round trip can usefully return and render results for each one, sending a request per character mostly produces wasted, immediately-superseded requests
* Once the debounce window elapses without another keystroke, the client sends the current partial query string to the **suggestion service**
* The suggestion service looks up that prefix in the **prefix index** and returns a small, bounded list (five to ten) of the highest-ranked completions
* If a new keystroke arrives before a prior request's response does, the client discards the stale response when it eventually arrives rather than rendering out-of-date suggestions over a now-longer typed string — a client-side race the server doesn't need to solve, since the server has no notion of "this request is stale," only the client does

The debounce window is a real latency-versus-freshness tradeoff worth being explicit about: too short, and the system pays for requests whose responses are superseded before they render; too long, and the suggestion list visibly lags behind typing in a way users notice. A value in the low hundreds of milliseconds is a reasonable middle ground, and it directly explains why the request-volume calculation in Step 1 divides typed characters by roughly 2-3 rather than assuming one request per keystroke.

### Use case: Service ranks suggestions by historical search frequency

The prefix index needs to answer "given this prefix, what are the top-K completions by frequency" in time roughly proportional to the prefix length and the number of results requested — not proportional to how many total queries share that prefix, and never proportional to the total size of the index. A **trie** (prefix tree) is the natural structure for this: each node represents one character position, a path from the root spells out a prefix, and each node caches the top-K highest-frequency completions reachable beneath it, precomputed once when the trie is built rather than recomputed by walking the full subtree on every single request. Looking up suggestions for a typed prefix becomes: walk the trie one node per typed character (cost proportional to prefix length, typically well under 20 hops even for a long query), then read the precomputed top-K list already cached at that node — a lookup, not a search.

This precomputed-top-K-per-node detail is what actually delivers the sub-100ms budget: without it, satisfying a request would mean finding the node for the typed prefix and then traversing every completion beneath it to find the highest-ranked ones, which is cheap for a rare prefix with few completions but expensive for a common one-or-two-character prefix with millions of completions underneath it — precisely the prefixes that get typed constantly, at the very start of nearly every query. Caching the answer at each node trades index-build cost and memory for making every single lookup cheap regardless of how many completions exist beneath it, which is the correct trade given the request-volume-to-index-size ratio this design's math establishes: the index is rebuilt relatively rarely, but read an enormous number of times between rebuilds.

Ranking by pure frequency count is the baseline this design uses, per Step 1's scope; a production system would likely blend in recency (so a recently-trending query doesn't have to accumulate the same raw count as an old, steadily-popular one before it ranks competitively), but that's a scoring-function refinement layered on top of the same trie-with-cached-top-K structure, not a change to the structure itself.

### Use case: Service updates suggestion rankings as query popularity shifts

Search popularity isn't static — a query can trend suddenly (breaking news, a new product release) or fade — and Step 1 scopes staleness on the order of an hour or a day as acceptable, which is what makes an offline, batch-oriented update path viable rather than needing the trie to be mutated live under read traffic. The **aggregation pipeline** periodically processes the **query log** — every search that's actually been submitted, not typeahead requests, which vastly outnumber real searches and would badly overweight partial/abandoned typing if counted the same as a completed query — into per-query frequency counts, using the same generic count-and-summarize shape as [MapReduce](/docs/patterns/batch-streaming/mapreduce) for turning a high-volume raw log into an aggregated summary without holding the whole log in memory on one machine.

Rebuilding the entire trie from scratch on every aggregation cycle is a legitimate option given how small the resulting structure is (tens of GB, per Step 1) relative to the daily batch-processing budget, and it sidesteps a harder problem: mutating a live, cached-top-K trie in place while it's being read hundreds of thousands of times a second requires either locking (which risks adding latency exactly where this design can least afford it) or a copy-on-write scheme. This design favors periodic full rebuild plus atomic swap: the aggregation pipeline builds a new trie offline, and once it's ready, suggestion service instances swap their in-memory reference to the new version — each request either sees the fully-old or fully-new index, never a partially-updated one, and the swap itself is a pointer update, not a request-blocking operation. This is the same build-fresh-then-atomically-promote shape [Blue-Green Deployment](/docs/patterns/observability/blue-green-deployment) uses for cutting traffic over between two complete environments, applied here to a data structure instead of a whole service.

### Use case: Service returns a bounded number of suggestions per request

Bounding suggestion count (five to ten, per Step 1) isn't just a product decision, it's part of what keeps individual requests cheap: because each trie node's top-K list is precomputed at a fixed, small K during the aggregation build, a request never pays for computing or transferring more candidates than will actually be shown — there's no "fetch everything matching, then truncate at request time" step to optimize away, because the truncation already happened once, offline, at build time, for every node in the trie.

## Step 4: Scale the design

![Typeahead scaled architecture](/img/case-studies/typeahead-scaled.svg)

**The suggestion service scales almost entirely by horizontal replication of a read-only, in-memory index**, since Step 1's math shows the whole index is small enough (tens of GB) to fit comfortably on a single well-provisioned instance's memory, let alone be replicated across many. See [Horizontal Scaling](/docs/patterns/scaling/horizontal-scaling) and [Load Balancing](/docs/patterns/api-edge/load-balancing) — because every instance holds an identical, complete copy of the trie rather than a shard of it, any instance can answer any request, which keeps routing trivially simple (no need to route a request to "the shard that owns this prefix") and lets capacity scale by adding stateless replicas behind the load balancer, directly against the ~28,000 requests/sec peak this design calculated.

**Sharding the trie itself, rather than replicating it whole, becomes worth considering only if the index outgrows a single instance's practical memory budget** — for instance, if the design were extended to many languages or a much larger accumulated query history than this design's numbers assume. A natural shard key is the first character (or first few characters) of the prefix, since a request always specifies its full prefix and can be routed to the shard owning that prefix range without a scatter-gather across shards — but at this design's actual scale, full replication is simpler and avoids that routing complexity entirely, so sharding is a scale-out option kept in reserve rather than a starting design choice. See [Sharding](/docs/patterns/storage/sharding).

**The query log and aggregation pipeline scale independently of the read path, and don't need to be fast in the way the suggestion service does.** The log is a straightforward high-volume append-only write stream (see [Write-Ahead Log](/docs/patterns/storage/write-ahead-log) for the general durability shape of append-then-process), and the aggregation job's own runtime budget is generous — Step 1 establishes update staleness of an hour or more as acceptable, so the batch job has ample headroom to trade wall-clock time for lower resource cost, unlike the suggestion service, which has no such slack.

**Caching sits in front of the trie lookup for the shortest, most common prefixes specifically** — the completions for a one- or two-character prefix change least often relative to how frequently they're requested (nearly every search starts by typing through the same short common prefixes), making them the best candidates for an additional layer of [Cache-Aside](/docs/patterns/caching/cache-aside) result caching on top of the already-fast trie lookup, squeezing latency down further exactly where request volume concentrates most.

**Geographic distribution matters here for pure latency reasons, not data-locality ones**, since the index is small enough to replicate identically to every region rather than needing to be partitioned by user location — pushing a full copy of the trie to points of presence close to users (conceptually similar to a [CDN](/docs/patterns/building-blocks/cdn) distributing identical static content widely) shaves the network round-trip portion of the 100ms budget, which matters proportionally more here than in most systems in this course because the total budget is so tight to begin with.

## Additional talking points

* **Why this design's hard problem is mechanically distinct from a feed-ranking problem.** This course's Newsfeed and Instagram case studies solve a *personalized merge-and-rank* problem: assembling a per-user ordered stream from many heterogeneous sources, where the interesting cost is fan-out and per-viewer scoring. Typeahead's hard problem is *prefix-matching under an extreme latency ceiling* against a largely global, non-personalized ranking — there's no per-user candidate assembly at all in the design above, and the entire system exists to make one specific lookup shape (prefix in, ranked completions out) as cheap as possible at very high request volume, which is a data-structure and latency-budget problem rather than a ranking-signal or fan-out problem.
* **Handling prefixes with very few or zero historical matches.** A brand-new or rare query has thin or no data in the trie, and simply returning nothing is a reasonable, honest behavior — but a production system might fall back to a broader match (dropping the last typed character and re-querying a shorter, more populated prefix) rather than showing an empty box, which is a product-quality refinement on top of, not a change to, the core trie lookup.
* **Multi-language and tokenization complexity.** This design implicitly assumes prefix matching over Latin-alphabet, space-delimited text; languages without clear word boundaries, or queries that are more naturally matched by substring or token rather than strict character-prefix, need a different indexing structure or a language-aware preprocessing step before the same trie-based approach applies — worth naming as a real limitation rather than assuming the design generalizes for free.
* **Why not just run every keystroke as a query against the same search index that handles full searches?** A general search index is built and tuned for relevance ranking over completed, often multi-word queries — a fundamentally different, heavier operation than a bounded prefix lookup, and running it per keystroke at the request volumes this design calculates would be far more expensive than the trie's precomputed-top-K approach for a problem that's structurally simpler than full-text relevance search.
