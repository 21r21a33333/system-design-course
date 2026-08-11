---
title: "Design Typeahead Suggestion (Search Autocomplete)"
sidebar_position: 17
---

Typeahead has one requirement that dwarfs everything else about it: a suggestion list has to appear while a user is still mid-keystroke, which means the entire prefix-to-suggestions round trip has to land in well under the time it takes to type the next character — a latency budget far tighter than almost anything else in this course, on a query pattern (prefix matching, not keyword matching) that a general-purpose data store isn't built to answer quickly.

*Educative's Grokking Modern System Design Interview course covers this same system in its "Design Typeahead Suggestion" module.*

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

The hard problem here is mostly client-side pacing: sending a request per keystroke wastes work on responses that are superseded before they render.

**Core spec: debounce + stale-response discard**

* The client waits briefly (a debounce window, typically on the order of 100-200ms) after each keystroke before issuing a request, rather than firing one request per character — since a fast typist produces keystrokes faster than a round trip can usefully return and render results for each one
* Once the debounce window elapses without another keystroke, the client sends the current partial query string to the **suggestion service**
* The suggestion service looks up that prefix in the **prefix index** and returns a small, bounded list (five to ten) of the highest-ranked completions
* If a new keystroke arrives before a prior request's response does, the client discards the stale response when it eventually arrives rather than rendering out-of-date suggestions over a now-longer typed string — a client-side race the server doesn't need to solve, since the server has no notion of "this request is stale," only the client does (tagging each request with a monotonically increasing sequence number and dropping any response whose sequence number isn't the latest one sent is a simple, real implementation of this)

**Data structures:** no server-side state for this use case beyond the prefix index covered below; client holds a single `latest_request_seq` counter.

**Trade-offs:**
* The debounce window is a real latency-versus-freshness tradeoff: too short, and the system pays for requests whose responses are superseded before they render; too long, and the suggestion list visibly lags behind typing in a way users notice. A value in the low hundreds of milliseconds is a reasonable middle ground, and it directly explains why the request-volume calculation in Step 1 divides typed characters by roughly 2-3 rather than assuming one request per keystroke.

### Use case: Service ranks suggestions by historical search frequency

The prefix index needs to answer "given this prefix, what are the top-K completions by frequency" in time roughly proportional to the prefix length — never proportional to how many total queries share that prefix or to the total size of the index.

**Core algorithm: trie with write-time top-K caching at every node**

A [Trie](https://en.wikipedia.org/wiki/Trie) (prefix tree) is the obvious starting structure — each node represents one character position, and a path from the root spells out a prefix. But a trie alone doesn't get this design to its 100ms budget. The naive read path — walk to the prefix's node, then depth-first-search every completion in the subtree beneath it, sort by frequency, take the top K — is cheap for a rare prefix with a handful of completions and disastrously expensive for a one- or two-character prefix with millions of completions underneath it, which is exactly the prefix shape typed constantly, at the very start of nearly every query.

The fix is to move that cost from read time to write time: **every trie node caches its own top-K list**, updated incrementally whenever a query's frequency changes, so a read is a walk-and-return, never a scan-and-sort.

```python
import bisect

class TrieNode:
    __slots__ = ("children", "top_k", "is_end_of_query", "query_text")

    def __init__(self):
        self.children = {}          # char -> TrieNode
        self.top_k = []             # sorted desc by freq: [(freq, query_text), ...]
        self.is_end_of_query = False
        self.query_text = None      # only set on the node where a query ends


class Trie:
    """Prefix tree where every node caches its own top-K completions,
    kept current at write time rather than recomputed at read time.
    """

    def __init__(self, k=5):
        self.root = TrieNode()
        self.k = k

    def _insert_path(self, query_text):
        """Walk/create the path for query_text, return the list of nodes
        from root to the end-of-query node (inclusive), in order.
        """
        node = self.root
        path = [node]
        for ch in query_text:
            if ch not in node.children:
                node.children[ch] = TrieNode()
            node = node.children[ch]
            path.append(node)
        node.is_end_of_query = True
        node.query_text = query_text
        return path

    def _update_node_top_k(self, node, query_text, freq):
        """Insert-or-replace (freq, query_text) into this node's cached
        top-K list, keeping it sorted descending by frequency and
        capped at self.k entries. O(k) per node, not O(subtree size).
        """
        # remove any stale entry for this query_text first (frequency changed)
        node.top_k = [(f, q) for (f, q) in node.top_k if q != query_text]
        # find insertion point that keeps the list sorted descending by freq
        neg_freqs = [-f for (f, _q) in node.top_k]
        idx = bisect.bisect_left(neg_freqs, -freq)
        node.top_k.insert(idx, (freq, query_text))
        if len(node.top_k) > self.k:
            node.top_k.pop()  # drop the lowest-ranked entry past K

    def record_query(self, query_text, freq):
        """Write-time update: called whenever a query's aggregate frequency
        changes (see the aggregation pipeline below). Propagates the new
        (freq, query_text) pair into every node along the prefix path —
        this is the step that makes every future read a cache hit.
        """
        path = self._insert_path(query_text)
        for node in path:
            self._update_node_top_k(node, query_text, freq)

    def suggest(self, prefix, limit=None):
        """Read path: walk one node per character of the typed prefix,
        then return the already-computed top_k at that node. No subtree
        traversal, no sort — the answer was computed at write time.
        """
        node = self.root
        for ch in prefix:
            if ch not in node.children:
                return []  # no completions exist for this prefix at all
            node = node.children[ch]
        limit = limit or self.k
        return [q for (_freq, q) in node.top_k[:limit]]
```

Looking up suggestions for a typed prefix is now: walk the trie one node per typed character (cost proportional to prefix length, typically well under 20 hops even for a long query), then read the precomputed `top_k` list already sitting at that node. [Elasticsearch's completion suggester](https://www.elastic.co/guide/en/elasticsearch/reference/current/search-suggesters.html) is a real, off-the-shelf implementation of essentially this idea — an in-memory, FST-based prefix structure purpose-built for fast autocomplete — and is a reasonable existing system to reach for instead of hand-rolling a trie from scratch.

**Data structures:**
* `TrieNode` — `children` (char → `TrieNode`), `top_k` (list of `(freq, query_text)`, sorted descending, capped at K), `is_end_of_query`, `query_text`
* `Trie` — `root` (`TrieNode`), `k` (fixed cap, five to ten per Step 1)

**Trade-offs:**
* **The gotcha:** "use a trie" is necessary but not sufficient — the design decision that actually delivers the sub-100ms budget is precomputing and caching each node's top-K at write time, not the trie shape itself. A trie without per-node caching still forces a read-time subtree scan for exactly the short, high-fan-out prefixes that get hit hardest, which is the one case a read-time-only design gets slower on precisely when it can least afford to. Caching the answer at each node trades index-build cost and memory (every query's frequency touches every node on its own prefix path, not just its own leaf) for making every single lookup O(K) regardless of how many completions exist beneath it — the correct trade given Step 1's math: the index is rebuilt relatively rarely but read an enormous number of times between rebuilds.
* Ranking by pure frequency count is the baseline this design uses, per Step 1's scope; a production system would likely blend in recency (so a recently-trending query doesn't have to accumulate the same raw count as an old, steadily-popular one before it ranks competitively) by feeding a time-decayed score into `record_query` instead of a raw count — a scoring-function change, not a structural one, since `_update_node_top_k` already treats its input as an opaque, comparable score.

### Use case: Service updates suggestion rankings as query popularity shifts

Search popularity isn't static — a query can trend suddenly (breaking news, a new product release) or fade — and Step 1 scopes staleness on the order of an hour or a day as acceptable, which is what makes an offline, batch-oriented update path viable rather than needing the trie mutated live under read traffic.

**Core spec: batch aggregation → full rebuild → atomic swap**

```python
def rebuild_index(query_log_batch, k=5):
    """Periodic batch job: aggregate raw searches into frequency counts,
    then build a brand-new Trie from scratch and hand it back for an
    atomic swap. Never mutates a trie that's currently serving reads.
    """
    counts = {}
    for entry in query_log_batch:              # entry: (query_text, timestamp)
        counts[entry.query_text] = counts.get(entry.query_text, 0) + 1

    new_trie = Trie(k=k)
    for query_text, freq in counts.items():
        new_trie.record_query(query_text, freq)
    return new_trie
```

The **aggregation pipeline** periodically processes the **query log** — every search that's actually been submitted, not typeahead requests, which vastly outnumber real searches and would badly overweight partial/abandoned typing if counted the same as a completed query — into per-query frequency counts, using the same generic count-and-summarize shape as [MapReduce](/docs/patterns/batch-streaming/mapreduce) (a batch framework like Apache Spark is a common real-world engine for running exactly this kind of aggregation job at the actual data volumes involved, in place of the single-pass loop shown above).

**Data structures:** same `Trie`/`TrieNode` as above; the aggregation step additionally holds a transient `counts` map (`query_text` → frequency) that exists only for the duration of one batch run.

**Trade-offs:**
* Rebuilding the entire trie from scratch on every aggregation cycle is a legitimate option given how small the resulting structure is (tens of GB, per Step 1) relative to the daily batch-processing budget, and it sidesteps a harder problem: mutating a live, cached-top-K trie in place while it's being read hundreds of thousands of times a second requires either locking (which risks adding latency exactly where this design can least afford it) or a copy-on-write scheme.
* This design favors periodic full rebuild plus atomic swap: the aggregation pipeline builds a new trie offline (`rebuild_index` above), and once it's ready, suggestion service instances swap their in-memory reference to the new version — each request either sees the fully-old or fully-new index, never a partially-updated one, and the swap itself is a pointer reassignment, not a request-blocking operation. This is the same build-fresh-then-atomically-promote shape [Blue-Green Deployment](/docs/patterns/observability/blue-green-deployment) uses for cutting traffic over between two complete environments, applied here to a data structure instead of a whole service.

### Use case: Service returns a bounded number of suggestions per request

Bounding suggestion count (five to ten, per Step 1) isn't purely a product decision, it's part of what keeps individual requests cheap: because `top_k` is capped at a fixed, small `k` during every `_update_node_top_k` call, `suggest()` never pays for computing or transferring more candidates than will actually be shown — there's no "fetch everything matching, then truncate at request time" step to optimize away, because the truncation already happened once, offline, at write time, for every node in the trie.

**Data structures:** none beyond the `Trie` above — this use case is a property of the write path, not a separate component.

**Trade-offs:**
* A fixed `k` shared by every node is simple and matches Step 1's scope; a system wanting different K per surface (a homepage search box showing 5 vs. an internal admin tool showing 20) would need either multiple parallel top-K caches per node or a larger per-node cache with per-request truncation on top — a small added cost only worth paying if a real second consumer of the index actually needs it.

## Step 4: Scale the design

![Typeahead scaled architecture](/img/case-studies/typeahead-scaled.svg)

* **The suggestion service scales almost entirely by horizontal replication of a read-only, in-memory index**, since Step 1's math shows the whole index is small enough (tens of GB) to fit comfortably on a single well-provisioned instance's memory, let alone be replicated across many. See [Horizontal Scaling](/docs/patterns/scaling/horizontal-scaling) and [Load Balancing](/docs/patterns/api-edge/load-balancing) — because every instance holds an identical, complete copy of the trie rather than a shard of it, any instance can answer any request, which keeps routing trivially simple and lets capacity scale by adding stateless replicas behind the load balancer, directly against the ~28,000 requests/sec peak this design calculated.
* **Sharding the trie itself, rather than replicating it whole, becomes worth considering only if the index outgrows a single instance's practical memory budget** — for instance, if the design were extended to many languages or a much larger accumulated query history than this design's numbers assume. A natural shard key is the first character (or first few characters) of the prefix, since a request always specifies its full prefix and can be routed to the shard owning that prefix range without a scatter-gather across shards — but at this design's actual scale, full replication is simpler and avoids that routing complexity entirely. See [Sharding](/docs/patterns/storage/sharding).
* **The query log and aggregation pipeline scale independently of the read path, and don't need to be fast in the way the suggestion service does.** The log is a straightforward high-volume append-only write stream (see [Write-Ahead Log](/docs/patterns/storage/write-ahead-log) for the general durability shape of append-then-process), and the aggregation job's own runtime budget is generous — Step 1 establishes update staleness of an hour or more as acceptable, so the batch job has ample headroom to trade wall-clock time for lower resource cost, unlike the suggestion service, which has no such slack.
* **Caching sits in front of the trie lookup for the shortest, most common prefixes specifically** — the completions for a one- or two-character prefix change least often relative to how frequently they're requested (nearly every search starts by typing through the same short common prefixes), making them the best candidates for an additional layer of [Cache-Aside](/docs/patterns/caching/cache-aside) result caching on top of the already-fast trie lookup.
* **Geographic distribution matters here for pure latency reasons, not data-locality ones**, since the index is small enough to replicate identically to every region rather than needing to be partitioned by user location — pushing a full copy of the trie to points of presence close to users (conceptually similar to a [CDN](/docs/patterns/building-blocks/cdn) distributing identical static content widely) shaves the network round-trip portion of the 100ms budget, which matters proportionally more here than in most systems in this course because the total budget is so tight to begin with.

## Additional talking points

* **Why this design's hard problem is mechanically distinct from a feed-ranking problem.** This course's Newsfeed and Instagram case studies solve a *personalized merge-and-rank* problem: assembling a per-user ordered stream from many heterogeneous sources, where the interesting cost is fan-out and per-viewer scoring. Typeahead's hard problem is *prefix-matching under an extreme latency ceiling* against a largely global, non-personalized ranking — there's no per-user candidate assembly at all in the design above, and the entire system exists to make one specific lookup shape (prefix in, ranked completions out) as cheap as possible at very high request volume, which is a data-structure and latency-budget problem rather than a ranking-signal or fan-out problem.
* **Handling prefixes with very few or zero historical matches.** A brand-new or rare query has thin or no data in the trie — `suggest()` above simply returns `[]` if the prefix path doesn't exist, or a short `top_k` if it exists but few queries ever shared it — and that's a reasonable, honest behavior. A production system might fall back to a broader match (dropping the last typed character and re-querying a shorter, more populated prefix) rather than showing an empty box, which is a product-quality refinement on top of, not a change to, the core trie lookup.
* **Multi-language and tokenization complexity.** This design implicitly assumes prefix matching over Latin-alphabet, space-delimited text; languages without clear word boundaries, or queries that are more naturally matched by substring or token rather than strict character-prefix, need a different indexing structure or a language-aware preprocessing step before the same trie-based approach applies — worth naming as a real limitation rather than assuming the design generalizes for free.
* **Why not just run every keystroke as a query against the same search index that handles full searches?** A general search index is built and tuned for relevance ranking over completed, often multi-word queries — a fundamentally different, heavier operation than a bounded prefix lookup, and running it per keystroke at the request volumes this design calculates would be far more expensive than the trie's precomputed-top-K approach for a problem that's structurally simpler than full-text relevance search.

## Source(s) and further reading

* [Trie — Wikipedia](https://en.wikipedia.org/wiki/Trie) — the core prefix-tree data structure this design's index is built on
* [Autocomplete — Wikipedia](https://en.wikipedia.org/wiki/Autocomplete) — general background on the product problem this design solves
* [Elasticsearch Completion Suggester](https://www.elastic.co/guide/en/elasticsearch/reference/current/search-suggesters.html) — a real, off-the-shelf FST-based prefix structure purpose-built for exactly this use case, worth comparing against a hand-rolled trie
* [Blue-Green Deployment](/docs/patterns/observability/blue-green-deployment) — the atomic-swap shape this design's index rebuild reuses
* [MapReduce](/docs/patterns/batch-streaming/mapreduce) — the general batch-aggregation shape behind the query-log-to-frequency-counts pipeline
