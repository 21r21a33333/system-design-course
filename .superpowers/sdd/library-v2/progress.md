# Library v2 Expansion — Progress Ledger

Branch: `library-v2-expansion` (worktree: `.worktrees/library-v2`)
Base: `main` @ aac1e7a (91 patterns, merged and deployed)

## Scope (5 phases, user-approved 2026-08-11)

Source audit against DesignGurus System Design Patterns course, Azure
Architecture Center patterns + antipatterns catalogs, Educative Grokking
Modern System Design Interview, and roadmap.sh/system-design identified
gaps. User approved all 5 phases below, explicitly declined "copy paste
content" from any source (paywalled or free) — all content is original
writing informed by research, never verbatim, regardless of repo
visibility (repo is public and deployed, confirmed via API).

### Template v3 (applies to all new + retrofitted pattern pages)
Definition -> Diagram -> Problem it solves -> **Technical Architecture &
Implementation** (expanded from "How it works": protocol-level detail,
data flow, failure modes) -> Code example (Rust) -> When to use it ->
When not to use it -> **Use-Case Scenarios** (2-3 concrete vignettes,
expanded from single "Real-world example") -> Related patterns ->
Further reading.

### Phase 1 — Gap-fill (15 pages, built directly at v3)
12 missing patterns + 3 concept-to-pattern promotions:
- Caching group (NEW `course/patterns/caching/`): Cache-Aside,
  Read-Through, Write-Through, Write-Behind, Cache Stampede Prevention
- Consistency/Storage/Reliability gaps: Leader Election, Primary-Replica
  Replication, Failover, Federation, Pipes and Filters
- API-edge + concept promotions: API Versioning, Service Discovery,
  Load Balancing, Reverse Proxy, CDN

### Phase 2 — New catalogs (15 pages, built directly at v3)
- AI Agent Orchestration (NEW group): Sequential, Concurrent, Group Chat
  (+ Maker-Checker), Handoff, Magentic orchestration
- Azure Antipatterns (NEW group, "what not to do"): Busy Database, Busy
  Front End, Chatty I/O, Extraneous Fetching, Improper Instantiation,
  Monolithic Persistence, No Caching, Noisy Neighbor, Retry Storm,
  Synchronous I/O

### Phase 3 — Deep-rewrite pass (91 existing pages -> v3)
Original 60: full build-out (diagram + code + v3 sections, currently
have none of this). The 31 pages from the just-merged phase: add the
v3 Technical Architecture + Use-Case Scenarios sections (already have
diagram + code).

### Phase 4 — Design-X case studies (~17 new, original content)
Educative-inspired full system walkthroughs missing from
`course/case-studies/system-design/`: Uber, WhatsApp, Instagram,
YouTube, Google Maps, Yelp/Proximity Service, Newsfeed, TinyURL,
Typeahead, Google Docs, ChatGPT, Payment System, Deployment System,
Data Infrastructure, LLM Support Bot, Code Assistant, etc.

### Phase 5 — Source cross-linking pass (full library)
Add the matching topic link from each of the 4 sources (where it
exists, DesignGurus/Educative only if the specific lesson is free) to
Further Reading across the full final inventory. Runs last — needs the
final page set settled.

## Task log

### Phase 1 Task A — Caching group (5 pages) — COMPLETE
Commit `317e1f4`. Cache-Aside, Read-Through, Write-Through, Write-Behind,
Cache Stampede Prevention under new `course/patterns/caching/` (position
12). Built directly at v3 (Technical Architecture & Implementation +
Use-Case Scenarios). Manifest bumped 91->96. Review: clean, no fixes,
explicitly flagged as a template reference for remaining tasks —
write-through/write-behind comparison treated with real rigor on both
sides, use-case vignettes concrete and non-generic, zero disallowed
citations, all Rust compiles, build clean.

### Phase 1 Task B — Consistency/Storage/Reliability gaps (5 pages) — COMPLETE
Commit `483033e`. Leader Election (consistency), Primary-Replica
Replication + Federation (storage), Failover (reliability), Pipes and
Filters (building-blocks). Manifest bumped 96->101. Review: clean, no
fixes. All 4 required sibling-differentiations (Leader Election vs.
Raft/Paxos, Failover vs. Bulkhead/Circuit Breaker/Graceful Degradation,
Primary-Replica vs. Sharding, Federation vs. Federated Identity) verified
correct and quotably explicit — Federation/Federated-Identity confusion
resolved with an explicit "Not to be confused with" callout. Zero
disallowed citations, all Rust compiles, build clean, no dead links.

### Phase 1 Task C — API-edge gaps + concept promotions (5 pages) — COMPLETE
Commit `147a77a`, fix round `36605a2`. API Versioning, Service Discovery
(new); Load Balancing, Reverse Proxy (api-edge), CDN (building-blocks)
promoted from old concept-prose pages to full v3 pattern pages — old
concept pages kept in place as background links. Manifest bumped
101->106. Review: 2 Important findings, both fixed directly — (1) 6
existing sibling pages (api-gateway, static-content-hosting, blob-store,
health-check, blue-green-deployment, horizontal-scaling) still linked to
the old concept pages instead of the newly-promoted pattern pages,
repointed all 6; (2) load-balancing.md's L4/L7 example echoed the old
concept page's video/billing framing too closely, reworded to a
multi-tenant SaaS routing example. Originality vs. old concept pages
verified clean via sentence-overlap check — new pages use different
structure/framing, not paraphrase. All 4 sibling differentiations
(Service Discovery vs Mesh/Sidecar, Load Balancing vs Rate Limiter,
Reverse Proxy vs API Gateway, CDN vs Static Content Hosting) verified
correct and explicit.

## PHASE 1 COMPLETE — 15 pages added, manifest at 106 (was 91).

## Phase 2 — starting next (AI Agent Orchestration + Antipatterns)

### Phase 2 Task A — AI Agent Orchestration group (5 pages, new group) — COMPLETE
New pattern group at position 13 (`ai-agent-orchestration/_category_.json`):
Sequential, Concurrent, Group Chat (with maker-checker sub-case), Handoff,
Magentic orchestration — distinct from the existing `ai-infra` group, which
covers ML/LLM infrastructure, not multi-agent coordination. Each page's
"Technical architecture & implementation" section explicitly differentiates
its control-flow shape from the other 4 (fixed linear chain vs. fixed
parallel roster vs. dynamic shared-thread turn-taking vs. reactive one-at-
a-time control transfer vs. persistent central re-planning orchestrator).
5 original SVG diagrams, one distinct control-flow shape each (straight
chain / fan-out-fan-in / shared hub / baton-pass / central orchestrator
with dashed dynamic delegation lines). All 5 Rust snippets compile clean
via rustc. Zero disallowed citations — only en.wikipedia.org and
learn.microsoft.com used, all verified live via curl. Sentence- and
n-gram-overlap check across all 5 files found zero duplicated
explanatory prose — shared 6/8-grams are limited to the required
"Related patterns" link boilerplate and Further Reading URLs. Manifest
bumped 106->111, ingest run confirmed 111 design-patterns entries.
Typecheck and build both clean, zero broken links.
Review: 1 Critical (handoff-orchestration.md's Rust snippet didn't
compile — unused/unimplemented `Agent::name()` trait method, dropped
it) + 1 Important (group-chat-orchestration.md's architecture section
ran 754 words, 26% over budget — trimmed to ~660 without losing the
maker-checker sub-case or cross-differentiation). Both fixed directly,
commit `a6edf07`. Cross-pattern differentiation verified to actually
hold up mechanically on close reading (not just self-report) — the two
hardest pairs (Handoff vs Group Chat, Sequential vs Magentic) both
correctly and explicitly cross-referenced in both directions.

## PHASE 2 TASK A COMPLETE.

## PHASE 2 TASK B — Antipatterns catalog (10 pages, new group).
New "Antipatterns — What Not To Do" group at position 14 (no collision,
audited every existing _category_.json first). 10 pages built to the
antipattern-variant template (How it manifests / Why it happens / Code
example (the antipattern) / The fix / How to detect it / When it's
actually fine / Related patterns / Further reading) — verified all 10
files' `## ` headings match exactly. 10 original SVGs, red/amber "bad"
flow with a green/teal "fix" inset panel where a clear corrective
pattern exists, matching failover.svg's style baseline. All 20 Rust
snippets (2 per page, antipattern + fix) extracted to individual temp
files and compiled one at a time via `rustc --edition 2021 --crate-type
lib` — zero errors, only expected dead-code warnings, none spot-checked.
Zero disallowed-domain citations (grep clean); all Further Reading URLs
verified live via curl before use, including discovering the Azure
antipatterns catalog pages need a trailing slash (the bare-suffix form
in the task prompt 404s). Paragraph- and n-gram-level duplication check
across all 10 files found zero duplicated explanatory prose — overlap
is limited to the Further Reading URL/link boilerplate. "Related
patterns" mapped to the genuine corrective pattern per antipattern:
busy-database->CQRS, busy-front-end->Queue-Based Load Leveling,
chatty-io->Gateway Aggregation, extraneous-fetching->Materialized View,
improper-instantiation->Connection Pooling, monolithic-
persistence->Federation, no-caching->Cache-Aside, noisy-
neighbor->Rate Limiter/Throttling/Bulkhead, retry-storm->Circuit
Breaker + Retry with Backoff (both, as mandated), synchronous-
io->Asynchronous Request-Reply. Manifest bumped 111->121, ingest run
confirmed 121 design-patterns entries. Typecheck and build both clean,
zero broken links.

Review: rustc compiled all 20/20 snippets clean, but caught one that
compiled while being logically wrong — synchronous-io.md's "fix"
started 3 futures then `.await`ed them one at a time, which in Rust
polls each to completion before the next starts (NOT concurrent), while
the prose claimed concurrency. rustc can't catch this class of bug
(no type error, just wrong runtime behavior). Fixed by replacing with
genuine `thread::spawn` + `.join()` concurrency (std-only, no async
runtime dependency needed for a bare-rustc-verified snippet) — verified
both blocks recompile clean, commit `6787865`. All 9 other pages, all
required "Related patterns" mappings (incl. retry-storm's mandated dual
link to Circuit Breaker + Retry with Backoff), citations, and structure
passed with no other findings.

## PHASE 2 COMPLETE — 25 pages added across this phase (Phase 1 + 2),
## manifest at 121 (was 91 at phase start).

## Phase 3 — deep-rewrite pass, 91 pre-existing pages -> v3
Split into 12 sub-tasks: 3.1-3.8 full build-out (60 pages, no
img/code yet), 3.9-3.12 v3-sections-only (31 pages from the prior
"more-patterns" phase, already have img/code, just need Technical
Architecture depth-up + Use-Case Scenarios expansion). No manifest/
count changes in any Phase 3 task — page count stays 121 throughout,
only existing pages edited in place.

### Phase 3.1 — Full build-out: ai-infra (7 pages) — COMPLETE
Commit `2df8a62`. feature-store, gpu-auto-scaling, llm-gateway,
model-serving, rag-pipeline, semantic-caching, vector-database-sharding.
Added diagram+code+v3 sections; preserved existing Problem/When-to/
When-not-to/Related/Further-reading verbatim (confirmed byte-identical
via reviewer diff against pre-edit HEAD). Review: clean, no fixes —
notably the reviewer empirically timing-verified two concurrency claims
(gpu-auto-scaling's dual thread::spawn checks, vector-database-sharding's
thread::scope scatter-gather) by compiling+running the snippets with
timing assertions, not just reading them, after a prior task in this
phase shipped Rust that compiled but wasn't actually concurrent. Zero
disallowed citations, all use-case scenarios distinct, manifest
untouched at 121, build/typecheck clean.

### Phase 3.2 — Full build-out: api-edge + consistency (9 pages) — COMPLETE
api-gateway, backend-for-frontend, cursor-pagination, service-mesh,
sidecar (api-edge); quorum, saga, two-phase-commit, vector-clocks
(consistency). Added diagram+code+v3 sections to each; preserved
existing Problem/When-to/When-not-to/Related/Further-reading verbatim,
confirmed via a section-by-section diff against pre-edit HEAD (all 9
byte-identical, not just eyeballed). Caught and self-corrected a
placement bug mid-task: the diagram image was initially inserted after
the "Problem it solves" paragraph instead of before the `## Problem it
solves` heading (per feature-store.md/gpu-auto-scaling.md's actual
layout) on 8 of 9 files — fixed before the preserve-section diff, which
is what originally surfaced it.

Cross-page consistency checks done deliberately per the task brief:
api-gateway.md's "vs. Reverse Proxy" framing was written to mutually
match reverse-proxy.md's pre-existing "vs. API Gateway" text (both
describe the same mechanical-superset relationship, no contradiction).
saga.md's "Sequencing: choreography or orchestration" section was
written to match, not duplicate, choreography.md's and
compensating-transaction.md's existing "Relationship to saga.md" notes
— saga.md links out to both pages for depth rather than re-explaining
their content, and the reverse-order-compensation / two-sequencing-
options framing is identical across all three pages.

### Phase 4.1 — Case studies: Uber, WhatsApp, Instagram, YouTube — COMPLETE
Added 4 brand-new, original full system-design case studies to
`course/case-studies/system-design/`, continuing sidebar numbering after
the 8 existing primer-derived pages: uber.md (9), whatsapp.md (10),
instagram.md (11), youtube.md (12). Each follows the pastebin.md/
twitter.md template shape (Step 1-4 + Additional talking points) but is
100% original prose against systems the primer never covered — no
donnemartin/imgur references anywhere, confirmed via grep. Two original
SVG diagrams per case study (8 total) at `static/img/case-studies/`,
matching the site's established pattern-diagram style (viewBox ~820x400
landscape, Helvetica, teal/blue/slate/amber/green color coding), created
fresh since this directory didn't exist before this task.

Back-of-envelope math computed fresh per system, not reused from any
canonical source, and verified arithmetically consistent (e.g. Uber:
2M drivers / 4s ping interval = 500K location writes/sec; WhatsApp:
300M DAU x 40 msg/day / 86400 = ~140K msg/sec average; Instagram: 150M
DAU x 6 opens/day / 86400 = ~10.4K reads/sec against 150M x 0.2 posts/
day = 30M posts/day, yielding the 30:1 read:write ratio the design
leans on; YouTube: 50M/2000 = 25K uploads/day = ~0.3/sec average against
50M x 5 views/day / 86400 = ~2.9K plays/sec, with bandwidth not request
count flagged as the real scaling driver). Caught and fixed one garbled
arithmetic line in youtube.md's storage-multiplier bullet during
self-review before verification.

Deliberately differentiated Instagram's and YouTube's fan-out/feed
problems rather than letting them collapse into the same generic
"fan-out at scale" discussion, since both genuinely touch it: Instagram
is framed as a true fan-out/write-amplification problem (push-on-write
below a follower-count threshold, pull-and-merge above it, CQRS-shaped,
because the content itself — a post_id reference — is already cheap and
servable); YouTube is framed as a pre-fan-out pipeline problem (a video
is not servable at all until an async, compute-bound, parallelizable
transcoding pipeline finishes with it — Pipes and Filters + Competing
Consumers over a task queue — and once ready, delivery is dominated by
raw CDN bandwidth economics, not by fan-out-to-followers). Both pages
cross-reference the other's framing explicitly rather than silently
diverging. WhatsApp's group-chat fan-out (small, per-recipient,
N-independent-deliveries) is also explicitly distinguished from both as
a third, smaller-scale case. Confirmed via 8-gram overlap check across
all 4 files that the only shared phrasing is template boilerplate
("Step 1: Outline use cases...") and shared internal-link anchor text
— zero copy-pasted substantive prose between any pair.

Internal links point exclusively to this site's own `/docs/patterns/...`
pages (sharding, consistent-hashing, quorum-adjacent leader-election,
distributed-message-queue, cdn, blob-store, sharded-counters, cqrs,
cursor-pagination, write-ahead-log, competing-consumers, pipes-and-
filters, auto-scaling, primary-replica-replication, event-driven-
architecture, queue-based-load-leveling, websockets, server-sent-events,
key-value-store, geode, idempotency, exactly-once-semantics, timeout,
circuit-breaker, deployment-stamps, cache-aside, distributed-search,
backpressure, load-balancing) — all confirmed to exist on disk before
linking and confirmed resolvable by the zero-broken-link production
build. Zero disallowed vendor/domain names (grep clean for Kafka,
Redis, Cassandra, DynamoDB, S3, CDN vendor names, etc. — all
infrastructure described generically per the site's vendor-neutral
convention; only the 4 real companies being designed are named, which
is the expected/allowed exception).

Manifest: bumped `expectedSupplementaryCaseStudyCount` from 0 to 4 in
`scripts/ingest/run.ts`, ran `npm run ingest -- /tmp/system-design-
primer-src`, got "All counts match expected inventory." All 4 new
pages confirmed present in `src/data/courseManifest.ts` under
`system-design-case-studies` / `supplementary`. `npm run typecheck` and
`npm run build` both clean (zero broken links/anchors, onBrokenLinks/
onBrokenAnchors both set to `throw`). Committed as a single
`feat(case-studies):` commit.

Concurrency claims were made in three pages (quorum, two-phase-commit)
and empirically verified, not just read — a prior phase's bug (sequential
`.await` masquerading as concurrent) was the specific failure mode this
guards against:
- two-phase-commit's `prepare_phase` (thread::spawn per participant):
  3 participants at 200ms simulated prepare each measured ~205ms
  concurrent vs. ~612ms run sequentially (2.98x), confirming prepare
  really does cost "slowest participant" not "sum of participants."
- quorum's `quorum_write` (thread::spawn per replica, stop at W acks):
  5 replicas with staggered 50/60/70/500/600ms delays and W=3 returned
  in ~71ms, proving it doesn't block on the two 500ms+ stragglers.
Non-concurrent logic (cursor-pagination's stability under inserts,
saga's reverse-order-compensation-only-of-completed-steps, vector-
clocks' happened-before/concurrent/equal detection) was also run against
targeted test harnesses beyond bare rustc compilation, not just read.
All 9/9 Rust snippets compile clean under `rustc --edition 2021
--crate-type lib` (only expected dead-code warnings) and were logic-
verified this way. Zero disallowed-domain citations (grep clean across
all 9 files); Istio/Kong prose mentions from the pre-existing "Real-world
example" sections were dropped when those sections were replaced with
original use-case scenarios, rather than carried forward. 8-gram
duplication check across all 9 files found zero copy-pasted prose —
the only n-gram overlaps are short, intentional mutual-differentiation
phrasings (api-gateway.md<->backend-for-frontend.md, service-
mesh.md<->sidecar.md) restating the same relationship consistently from
each side. Manifest untouched at 121, `npm run typecheck` and `npm run
build` both clean with zero broken links.

### Phase 4.1 review — Uber/WhatsApp/Instagram/YouTube — COMPLETE, no fixes
Independent review of commit `0b687b9`: all 4 critical checks passed —
8 SVGs real/valid/pure-vector (no repeat of the old pages' broken imgur
links), zero primer-anchor-link pattern, all 29 internal pattern/concept
links verified real and contextually relevant, back-of-envelope math
independently recomputed and internally consistent across all 4 files
(not just the 2 the implementer quoted), Instagram-vs-YouTube
differentiation verified accurate with genuine mutual cross-references.
Manifest confirmed 125 supplementary entries (121 patterns + 4 case
studies). Zero vendor name-drops, zero disallowed citations, fresh
build/typecheck clean. Ready to proceed, no fix round needed.

### Phase 4.2 — Google Maps, Yelp, Newsfeed, TinyURL — COMPLETE
Added 4 more system-design case studies (sidebar_position 13-16),
following the uber.md/instagram.md template exactly: Step 1
(use cases + honest out-of-scope + state assumptions + calculate
usage), Step 2 (high-level design + SVG), Step 3 (3-5 "Use case:"
subsections matching Step 1's scoped list 1:1, verified by direct
grep-diff, not eyeballing), Step 4 (scaled design + SVG, bottlenecks
genuinely specific to each system rather than generic "add a cache"
filler), Additional talking points.

Google Maps and Yelp were the two highest collision-risk pages (both
"nearby location" systems) and were deliberately differentiated at
the mechanism level, not just the prose level: Google Maps is framed
as a graph/shortest-path problem (bidirectional search + precomputed
hierarchical shortcuts over a road graph, live traffic as a
continuously-overwritten per-edge aggregate feeding edge weights) —
the hard problem is traversal. Yelp is framed as a static-point
spatial-indexing problem (geo-cell index mapping cell_id -> business
ids, index-table-shaped, rebuilt only on rare listing changes since
businesses don't move) — the hard problem is fast radius/candidate-set
retrieval, not traversal. Each page's high-level design section states
the mirror-image relationship explicitly. An 8-gram overlap check
confirmed the two files share zero substantive prose — only heading/
link boilerplate ("Step 1: Outline...", shared `/docs/patterns/...`
anchor text).

TinyURL vs. the pre-existing pastebin.md (untouched primer-era page)
was the other flagged risk. TinyURL is framed around ID-generation-
at-scale under concurrent writes (hash-and-truncate vs. pre-allocated
unique-ID-range-encoded-to-base62, chosen specifically because it
makes collision-freedom a construction guarantee rather than a
runtime check) and redirect latency (mapping immutability is exploited
for maximal, invalidation-free caching; 301-vs-302 tradeoff against
the click-counting requirement is discussed explicitly). Pastebin's
own (pre-existing, unmodified) hard problem is the hash-table-plus-
large-object-storage split for variable-sized paste bodies. TinyURL's
"Additional talking points" section names this distinction directly
(mapping value is always a trivially small, uniform-size URL string,
never the bottleneck, vs. Pastebin's variable-and-sometimes-large
content body). 6-gram check against pastebin.md found zero shared
substantive prose.

Newsfeed vs. Instagram initially showed real (not just boilerplate)
duplication on first pass — an 8-gram check caught 64 shared grams,
concentrated in the social-graph-sharding paragraph (near-verbatim
"who does this user follow / who follows this user... keyed off a
single user... aggressively caching graph reads on top of a sharded
durable store") and two shorter phrases (a cache-aside paragraph, a
"feed service answers what should this user see" phrasing, an
"ends at durably recorded" phrasing). All four were rewritten with
genuinely different angles/phrasing (the social-graph paragraph now
argues from "multiple subsystems depend on the same graph answer"
rather than restating Instagram's read/write-ratio framing) and
re-checked down to 31 shared grams, all of which are pure heading/
link-anchor boilerplate shared by every case study on the site (a
manual read-through of the remaining list confirmed this). Newsfeed's
own differentiator from Instagram's single-content-type fan-out is
explicit in Step 3: fan-out here is fan-out of *heterogeneous,
multi-producer* activity through a shared normalized envelope, and the
push/pull threshold split is motivated partly by a different problem
(a high-volume source drowning out other sources by sheer count in a
merged feed, not just push cost) than Instagram's follower-count-only
framing.

All back-of-envelope numbers independently recomputed in Python against
each file's stated assumptions (route computations/sec, concurrent
navigators, ping rates, storage GB/TB, read:write ratios, code-space
exhaustion years) — every derived number matches what's written, no
arithmetic drift.

Manifest: bumped `expectedSupplementaryCaseStudyCount` from 4 to 8 in
`scripts/ingest/run.ts`, ran `npm run ingest -- /tmp/system-design-
primer-src`, got "All counts match expected inventory" (sdCaseStudies:
8). All 4 new pages confirmed present in `src/data/courseManifest.ts`.
`npm run typecheck` and `npm run build` both clean (zero broken links/
anchors) both before and after the newsfeed.md rewrite. Zero disallowed
vendor/domain names (grep clean for Kafka, Redis, Cassandra, DynamoDB,
S3, Elasticsearch, Memcached, ZooKeeper, PostGIS, nginx, HAProxy,
CloudFront, Kubernetes, AWS/GCP/Azure, Postgres, MySQL, MongoDB).
8 original SVGs (2 per case study), all validated as well-formed XML,
matching the established teal/blue/slate/amber/green palette and
viewBox conventions. Committed as a single `feat(case-studies):`
commit.

## Phase 4.3: Case studies — Typeahead, Google Docs, Payment System, Deployment System

Added 4 more original case studies (sidebar_position 17-20), bringing
the supplementary system-design case-study count to 12: `typeahead.md`,
`google-docs.md`, `payment-system.md`, `deployment-system.md`. Read
yelp.md and tinyurl.md fresh first as structure/depth reference, per
the task brief.

Typeahead's hard problem is framed as prefix-matching under a strict
sub-100ms latency budget (trie with precomputed top-K per node, built
offline by a batch aggregation pipeline over a query log, atomically
swapped into a stateless, fully-replicated read fleet — same
build-fresh-then-atomically-promote shape as blue-green deployment,
applied to a data structure). Differentiated explicitly, in its own
"Additional talking points," from Newsfeed/Instagram's ranking
discussions: those solve personalized multi-source merge-and-rank;
typeahead solves non-personalized prefix lookup at extreme request
volume relative to a tiny, largely-static index. 10-gram overlap check
against newsfeed.md and instagram.md found zero non-boilerplate shared
prose (only shared template headings and one recurring site-wide idiom,
"the single number that most shapes this design," also present verbatim
in yelp.md's existing text — confirmed pre-existing, not new).

Google Docs' hard problem is operational-transform/CRDT-based
convergence of concurrent edits to one shared mutable document, not
message delivery — explicitly contrasted against WhatsApp in Step 2
("there is no single recipient... every connected editor is
simultaneously a producer and a consumer of the same mutable shared
state") and again in Additional talking points, including a worked
concrete example (two editors starting from "cat," one inserting "h",
one deleting "t," diverging under naive receipt-order application) to
show *why* transformation is needed, not just assert it. Sharding
rationale is explicitly contrasted with WhatsApp's per-recipient
sharding (WhatsApp shards for read-scoping; Google Docs shards by
doc_id because correctness, not just read efficiency, depends on all
of one document's concurrent edits passing through one transformation
authority). 6-gram check against whatsapp.md found only template
boilerplate (headings, step labels) — zero substantive shared prose.

Payment System genuinely engages idempotency (checked first, before
any gateway call; atomic conditional insert against the idempotency
store is the single most load-bearing mechanism in the design) and
saga (multi-step reserve/charge/mark-paid workflow, explicitly argued
against two-phase commit because the external gateway call is slow
and outside this system's control — 2PC's own "when not to use it"
guidance is cited directly). A dedicated "Additional talking points"
entry spells out why idempotency and sagas are both necessary and
neither substitutes for the other (different granularities: idempotency
within one step, saga around the multi-step workflow). Refunds are
modeled as new linked ledger events, never in-place mutation, explicitly
drawing the parallel to Google Docs' edit-history-log-as-source-of-truth
treatment. No real payment processor named anywhere (grep clean).

Deployment System genuinely engages canary deployment (batch-and-soak
staged rollout with automated promote/abort on metrics comparison
against baseline), blue-green deployment (old-version instances kept
fully intact and live throughout, which is what makes rollback a
traffic re-point rather than a redeploy), health checks (readiness,
not just liveness, gates traffic; health checks kept cheap per the
pattern page's own caution), and feature flags (explicitly framed as
an orthogonal control axis — code-safety risk via canary/blue-green
vs. product-behavior risk via flags — with a paragraph on how the two
compose rather than compete). No real CI/CD tool named anywhere (grep
clean).

All back-of-envelope numbers independently recomputed in Python against
each file's stated assumptions. This caught one real arithmetic bug:
typeahead.md's request-volume calculation wrote "100,000,000 ×
(20/2.5) ≈ 8 billion" when the correct product is 800 million (an
order-of-magnitude slip), which had propagated into the average
(93,000 vs. correct ~9,300 req/sec), peak (280,000 vs. correct ~28,000
req/sec), the Step 4 scaling paragraph's repeated peak figure, and one
number embossed in typeahead-overview.svg's annotation box. All four
locations fixed and re-verified by rerunning the derivation; every
other number across all 4 files (google-docs.md's edit-event volume,
bandwidth, per-document rate, storage; payment-system.md's request
rate, ledger size, idempotency-key volume, refund rate; deployment-
system.md's deploy interval, batch size/count, health-check rate,
rollout duration) matched on first check, no further drift found.

Manifest: bumped `expectedSupplementaryCaseStudyCount` from 8 to 12 in
`scripts/ingest/run.ts`, ran `npm run ingest -- /tmp/system-design-
primer-src`, got "All counts match expected inventory" (sdCaseStudies:
8, primer count unaffected). All 4 new pages confirmed present in
`src/data/courseManifest.ts`. `npm run typecheck` and `npm run build`
both clean (zero broken links/anchors), re-run after the typeahead.md
math fix to confirm nothing regressed. Zero disallowed vendor/domain
names across all 4 files (grep clean for Kafka, RabbitMQ, Cassandra,
DynamoDB, Elasticsearch, Memcached, ZooKeeper, Stripe, PayPal, Square,
nginx, HAProxy, CloudFront, Kubernetes, Jenkins, GitHub Actions,
Spinnaker, ArgoCD, AWS/GCP/Azure, Postgres, MySQL, MongoDB,
LaunchDarkly). All 18 internal pattern links verified to resolve to
real files on disk (in addition to the build's own zero-broken-link
result). 8 original SVGs (2 per case study) in the established teal/
blue/slate/amber/green palette and viewBox conventions, one amended
post-fix to match the corrected peak-throughput number. Committed as
a single `feat(case-studies):` commit, hash `b74fa9e`.
