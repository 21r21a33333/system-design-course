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

## Phase 4.4: Case studies — Data Infrastructure, ChatGPT, LLM Support Bot, Code Assistant

Added the final 4 case studies of Phase 4 (sidebar_position 21-24),
bringing the supplementary system-design case-study count to 16. Read
payment-system.md and google-docs.md fresh first as structure/depth
reference, per the task brief, noting the standard payment-system.md
was corrected to after review: every Step 3 "Use case:" subsection
must have a 1:1 matching Step 1 bullet, with no synthesized topics
introduced in Step 3 that weren't previewed in Step 1. Verified this
correspondence explicitly for all 4 new files by extracting every
Step-1 bullet and every Step-3 "### Use case:" header and diffing them
— all 4 files pass clean (every Step 3 use case matches a Step 1
bullet; a small number of Step 1 bullets are intentionally cross-cutting
concerns covered in Step 4 or Additional talking points rather than a
dedicated Step 3 subsection, the same pattern payment-system.md's own
"high availability" bullet uses).

This was flagged as the highest-overlap-risk task in the phase: 3 of
the 4 subjects (chatgpt.md, llm-support-bot.md, code-assistant.md) are
all mechanically "send a prompt to a model, return a response."
Differentiated by the actual hard problem each one solves, not just
application domain:

- **chatgpt.md** — inference-serving-and-scaling: open-domain
  multi-turn conversation at extreme concurrent volume (~4,600 msg/sec
  avg, ~14,000 peak; ~42,000 concurrent in-flight generations at peak
  via Little's Law), where the central engineering problem is model-
  serving capacity, not conversation quality. Genuinely engages
  Model Serving (micro-batching tradeoff) and GPU Auto-Scaling (warm
  minimum pool vs. reactive scale-to-zero) as the two most load-bearing
  pattern links; LLM Gateway for the safety-filtering choke point.
- **llm-support-bot.md** — grounding-plus-escalation: a narrower,
  multi-tenant RAG problem where the hard question is knowing when
  *not* to answer and escalating to a human instead of hallucinating.
  Genuinely engages RAG Pipeline (full chunk/embed/retrieve/re-rank
  loop, plus the silent-retrieval-failure caution applied directly to
  the escalation-confidence design), Vector Database Sharding (per-
  tenant isolation doubling as the sharding key), Semantic Caching
  (with an explicit account-data carve-out mirroring that pattern's own
  transactional-query caution), and Handoff Orchestration (bot-to-human
  context handoff explicitly compared to that pattern's context-
  preservation tradeoff).
- **code-assistant.md** — structured-context-plus-tool-use: understanding
  a codebase's dependency graph (not prose-chunk similarity alone) and
  taking real, sandboxed actions (search, read, run tests) with a hard
  human-approval boundary before any edit lands. Genuinely engages RAG
  Pipeline (contrasted directly — code relevance depends on call/import
  structure a text-similarity search can't see), Sequential Orchestration
  (search-then-read-then-propose for multi-file changes, argued for
  specifically because that task has a genuine fixed ordering dependency,
  per that pattern's own "when to use it" guidance), Vector Database
  Sharding (per-repository), and Semantic Caching (explicitly withheld
  from both inline completions and tool-execution results, unlike the
  chat/agentic path).
- **data-infrastructure.md** — batch/streaming ingestion, warehousing,
  and analytics query serving; confirmed near-zero overlap risk with
  the other 3, and cross-checked separately.

10-gram overlap check across chatgpt.md / llm-support-bot.md /
code-assistant.md found zero non-boilerplate shared prose — the only
shared 8-12-grams across all pairs were the site-wide "We'll scope the
problem to handle the following use cases" heading template (present
verbatim in all 24 case-study files, confirmed pre-existing) and my
own deliberately parallel "why this design's hard problem is X, not Y"
framing phrase reused across my own 3 files' Additional-talking-points
sections as an intentional differentiation device, not accidental
duplication. Checked all 4 new files against all 20 pre-existing case
studies at 9-grams: only structural/heading-adjacent overlap found
(e.g. WhatsApp's own "User sends a message" bullet colliding with the
"Step 3: Design core components" + "### Use case:" heading template),
plus one recurring legitimate sharding-justification idiom ("since
every/almost every read and write is scoped to a single X") already
used for the same Sharding pattern link in payment-system.md — a
reusable justification pattern, not copied reasoning.

All back-of-envelope numbers independently recomputed in Python against
each file's stated assumptions before finalizing (Little's Law
concurrency-from-arrival-rate math in chatgpt.md checked with particular
care per the task brief's warning about prior arithmetic slips) — every
number in all 4 files matched on first check: data-infrastructure.md's
ingestion volume/storage/compression/query-load figures; chatgpt.md's
message/token volume, concurrency, replica count, storage; llm-support-
bot.md's conversation/turn volume, index size, re-indexing load,
escalation rate; code-assistant.md's completion/chat volume, per-repo
and total index size, re-indexing file-change volume. No arithmetic
errors found or needed fixing this round.

Manifest: bumped `expectedSupplementaryCaseStudyCount` from 12 to 16 in
`scripts/ingest/run.ts`, ran `npm run ingest -- /tmp/system-design-
primer-src`, got "All counts match expected inventory." All 4 new pages
confirmed present in `src/data/courseManifest.ts`. `npm run typecheck`
and `npm run build` both clean (zero broken links). Zero disallowed
vendor/domain names across all 4 files (grep clean for the full AI-
vendor list — OpenAI, Anthropic, GPT, ChatGPT-as-product-claim, Claude,
GitHub Copilot, LangChain, Pinecone/Weaviate, Hugging Face, TensorFlow/
PyTorch, Nvidia, plus the standard non-AI vendor list — and the full
disallowed-citation-domain list); the only "ChatGPT" hit is the title's
allowed real-world-example reference, exactly like Uber/WhatsApp did for
their domains, with the body describing "a large language model"/"the
model" generically throughout. All 17 internal pattern links (spanning
both ai-infra and ai-agent-orchestration groups, plus batch-streaming
and storage) verified to resolve to real files on disk. 8 original SVGs
(2 per case study) in the established teal/blue/slate/amber/green
palette and viewBox conventions, validated as well-formed XML. Committed
as a single `feat(case-studies):` commit, hash `dbf963e`.

**Phase 4 is now complete.** 16 new supplementary case studies total
across 4 tasks (Phase 4.1-4.4), manifest `expectedSupplementaryCaseStudyCount`
at 16, `course/case-studies/system-design/` now holds 8 primer-derived
(sidebar_position 1-8) + 16 original (sidebar_position 9-24) case
studies, 20 sidebar_position 9-24 originals in total covering: Uber,
WhatsApp, Instagram, YouTube, Google Maps, Yelp, Newsfeed, TinyURL,
Typeahead, Google Docs, Payment System, Deployment System, Data
Infrastructure Platform, Conversational AI System, LLM Support Bot, AI
Code Assistant.

## Phase 5.1: Policy retrofit + cross-links — Caching + gap-fill patterns (10 pages)

Retrofitted 10 already-published pages under the relaxed real-vendor-
naming policy: `course/patterns/caching/{cache-aside,read-through,
write-through,write-behind,cache-stampede-prevention}.md`,
`course/patterns/consistency/leader-election.md`,
`course/patterns/storage/{primary-replica-replication,federation}.md`,
`course/patterns/reliability/failover.md`,
`course/patterns/building-blocks/pipes-and-filters.md`.

Real-tech grounding added (1-2 concrete, verified-accurate mentions per
file, additive only): cache-aside — Redis/Memcached as the canonical
plain get/set/del cache; read-through and write-through — DynamoDB
Accelerator (DAX) as a managed read-through/write-through cache in
front of DynamoDB; write-behind — Redis AOF `everysec` fsync as a
real-world instance of the same ack-then-flush-later trade-off;
cache-stampede-prevention — Memcached's `add` command used as a
first-class single-flight/mutex primitive; leader-election — ZooKeeper
ephemeral sequential znodes as the textbook lease+expiry building
block, plus etcd leases and Consul sessions/locks as first-class-API
equivalents; primary-replica-replication — PostgreSQL streaming
replication (WAL-shipping) and MySQL binlog replication as the
canonical open-source write-ahead-log-as-replication-stream examples;
federation — "polyglot persistence" (Elasticsearch for catalog,
PostgreSQL for billing) as the real-world naming of the
different-federates-different-engines outcome; failover — Patroni as a
widely deployed PostgreSQL failover manager implementing the
health-detection/promotion/redirection steps; pipes-and-filters — Kafka
Streams and Apache Flink as stream-processing generalizations of the
Unix-pipe shape at network scale. No false or invented capabilities
stated about any named product — every claim checked against
well-documented, well-known real behavior before inclusion.

Cross-reference links added to each page's Further reading, all URLs
curl-verified live (200) both when first found and again in a final
recheck pass before finishing: cache-aside — DesignGurus "Cache-Aside"
(Serving Data Fast module, text-only) + roadmap.sh/system-design;
read-through — DesignGurus "Read-Through" only (no roadmap.sh node,
no Azure entry for read-through specifically); write-through —
DesignGurus "Write-Through" + roadmap.sh; write-behind — DesignGurus
"Write-Behind" + roadmap.sh; cache-stampede-prevention — DesignGurus
"Cache Stampede Prevention" only (no roadmap.sh node); leader-election —
roadmap.sh only added (Azure Leader Election link was already present
pre-retrofit; no DesignGurus module covers leader election);
primary-replica-replication — DesignGurus "Primary-Replica" (Storing
Data module) only (no roadmap.sh node covers primary-replica
specifically as its own node beyond the general page). Deliberately
skipped, no genuine match found: federation and failover have no
DesignGurus lesson (federation got a roadmap.sh link since it's a real
named node there; failover has neither a DesignGurus lesson nor a
roadmap.sh node, so its Further reading section is unchanged from
before this pass); pipes-and-filters has neither a DesignGurus lesson
nor a roadmap.sh node, so only the real-tech grounding was added there,
Further reading section unchanged (Azure's existing Pipes and Filters
link was reverified live and left in place).

Verified `https://learn.microsoft.com/en-us/azure/architecture/patterns/
cache-aside` (200 — exists in the current catalog, already linked
pre-retrofit) before relying on it. Re-read all 10 files in full after
editing: fixed two placement issues found on this pass (the ZooKeeper/
etcd/Consul insertion in leader-election.md originally split a paired
"the first ingredient... the second ingredient..." sentence — moved to
its own paragraph after both ingredients are stated; the Patroni
insertion in failover.md originally ran on into the split-brain
sentence with no paragraph break — given its own paragraph). Confirmed
via `git diff` that all "deletions" across the 10-file diff are
line-rewrap artifacts from paragraph insertion, not content removal —
76 insertions vs. 7 deletions total, no existing prose, code examples,
headings, or citations removed or weakened. `npm run typecheck` and
`npm run build` both clean, zero broken links. Committed as a single
`feat(patterns):` commit.

## Phase 5.2: Policy retrofit + cross-links — API-edge gaps + AI Agent Orchestration (10 pages)

Retrofitted 10 already-published pages under the relaxed real-vendor-
naming policy: `course/patterns/api-edge/{api-versioning,
service-discovery,load-balancing,reverse-proxy}.md`,
`course/patterns/building-blocks/cdn.md`,
`course/patterns/ai-agent-orchestration/{sequential-orchestration,
concurrent-orchestration,group-chat-orchestration,handoff-
orchestration,magentic-orchestration}.md`.

Real-tech grounding added (additive only, all claims verified live
before inclusion): api-versioning — X's (Twitter's) `/2/tweets`
URI-path versioning as the canonical path example, plus Stripe's
`Stripe-Version` and GitHub's `X-GitHub-Api-Version` dated-string
headers as the header-based approach (corrected from the task's
starting idea, which mischaracterized Stripe as URL-path — verified via
curl against Stripe's and GitHub's own docs that both are actually
header-delivered date-string versions, not path- or Accept-header-
based, and wrote the accurate mechanism instead); service-discovery —
HashiCorp Consul and etcd as concrete registry implementations, plus
Kubernetes Service DNS as the "platform already provides it" example;
load-balancing — HAProxy and NGINX as dual-mode L4/L7 software load
balancers, plus AWS NLB vs. ALB as the managed-product illustration of
the same split; reverse-proxy — NGINX (originally built as an HTTP
server/reverse proxy, grew LB/caching on top) and Envoy (Istio's
sidecar data-plane proxy) as concrete implementations; cdn — Cloudflare
(anycast-routed) and Amazon CloudFront (DNS-routed) as concrete
examples of the two request-routing approaches described in the page;
the 5 AI Agent Orchestration pages — Microsoft's AutoGen and Semantic
Kernel frameworks, which ship named orchestration patterns matching
all 5 pattern names in this group almost exactly ("Sequential",
"Concurrent", "Group Chat", "Handoff" agent orchestration in Semantic
Kernel; "Group Chat" and "Handoffs" design patterns in AutoGen), plus
Microsoft's Magentic-One multi-agent system as the specific, publicly
documented origin of the "Magentic" name and its Orchestrator-plans-
delegates-replans structure — all verified via curl against Microsoft
Learn/AutoGen docs/Microsoft Research before inclusion, high-confidence
match since these are the same team's frameworks the Azure AI agent
design patterns page (already linked on all 5 pages pre-retrofit) was
sourced from. No false or invented capabilities stated about any named
product.

Cross-reference links added to each page's Further reading, all URLs
curl-verified live (200) both when first found and again in a final
recheck pass before finishing: api-versioning — DesignGurus "API
Versioning" (The Entry Point module, text-only) + roadmap.sh (confirmed
"API Versioning" appears as a named node via direct curl grep against
the live page); service-discovery — roadmap.sh only (confirmed "Service
Discovery" is a named node via curl grep; no DesignGurus lesson covers
service discovery, per the task's own note, not forced); load-balancing
— DesignGurus "Load Balancing" (Growing Under Load module) +
roadmap.sh (confirmed "Load Balancing"/"Load Balancers" both appear as
named nodes); reverse-proxy — DesignGurus "Reverse Proxy" (The Entry
Point module) + roadmap.sh (confirmed "Reverse Proxy" as a named node);
cdn — DesignGurus "CDN" (The Entry Point module) + roadmap.sh (confirmed
"CDN" as a named node); the 5 AI Agent Orchestration pages — no
DesignGurus or roadmap.sh links added (neither source covers multi-
agent orchestration, per the task's own note, not forced), instead each
got 1-2 additional Further-reading links to the specific Semantic
Kernel/AutoGen/Magentic-One pages that are the real-tech grounding
source for that page (all 5 already had the Azure AI agent design
patterns link pre-existing from an earlier phase — checked first,
not duplicated).

Verified roadmap.sh/system-design node names by curling the live page
and grepping for each candidate topic string directly (not guessing
from prior research) before citing any of them. Re-read all 10 files in
full after editing: fixed one placement issue found on this pass (the
NGINX/Envoy insertion in reverse-proxy.md originally ran the vendor
sentence directly into the existing "From the client's perspective..."
sentence with no paragraph break — split into its own paragraph after
the core termination/forwarding explanation). Confirmed via `git diff`
that all 10 files' diffs are purely additive (94 insertions, 10
deletions — the 10 deletions are line-rewrap artifacts from a single
sentence reflow in service-discovery.md's "When not to use it" bullet,
same claim restated with a concrete Kubernetes example, not weakened or
removed) — no existing prose, code examples, headings, or citations
removed. Grepped all touched files for "designgurus" (case-insensitive)
and confirmed all 4 occurrences are plain-text bullets, never inside
markdown link syntax. `npm run typecheck` and `npm run build` both
clean, zero broken links. Committed as a single `feat(patterns):`
commit (a875cb5).

## Phase 5.3: Policy retrofit + cross-links — Antipatterns (10 pages)

Retrofitted the 10 Antipatterns pages under the relaxed real-vendor-
naming policy: `course/patterns/antipatterns/{busy-database,
busy-front-end,chatty-io,extraneous-fetching,improper-instantiation,
monolithic-persistence,no-caching,noisy-neighbor,retry-storm,
synchronous-io}.md`.

Real-tech grounding added (one concrete, verified-accurate mention per
file, additive only): busy-database — PostgreSQL and SQL Server's
trigger/stored-procedure dispatch capability as the mechanism that
makes a workflow-engine-in-the-database possible; busy-front-end —
Ruby on Rails' Active Job + Sidekiq and Laravel's queue system as
mainstream frameworks that make background-job offloading a first-
class convention; chatty-io — Hibernate's `JOIN FETCH` and Django's
`select_related`/`prefetch_related` as ORM opt-outs from lazy N+1
loading, plus GraphQL's single-request graph-resolution model as the
network-level antidote; extraneous-fetching — the relational projection
operation and general query-review guidance against unqualified
`SELECT *` (kept intentionally generic after an initial PostgreSQL/
MySQL-specific doc-page claim didn't hold up under direct content
verification — see below); improper-instantiation — .NET's `HttpClient`
socket-exhaustion case, the field's canonical documented example of
this exact antipattern, grounded in Microsoft's own HttpClient
guidelines page; monolithic-persistence — "polyglot persistence" named
directly, with Elasticsearch/OpenSearch + Redis alongside a relational
store as the concrete mixed-store shape; no-caching — Redis and
Memcached named as the products that exist to be the missing layer,
tied to the thundering-herd failure mode it prevents; noisy-neighbor —
AWS's burstable EC2 CPU-credit mechanism and provisioned-IOPS EBS as a
documented, production per-tenant isolation mechanism; retry-storm —
kept to a generic description of the synchronized-retry/oscillating-
recovery dynamic (no specific named historical outage was cited, per
the task's own instruction, since none could be confirmed with
sufficient confidence) but grounded the *mechanism* by pointing at the
already-cited AWS backoff-with-jitter guidance as the documented source
of the jitter countermeasure; synchronous-io — Node.js's own
documentation of its single-threaded, non-blocking event-loop rationale.

One claim was caught and corrected during verification: an initial
extraneous-fetching.md draft asserted that PostgreSQL's "Don't Do This"
wiki and MySQL's optimization docs explicitly call out `SELECT *`
guidance by name — direct content-fetch of both pages showed neither
has a dedicated `SELECT *` section (Postgres's only incidental
mentions are inside unrelated `BETWEEN`/`NOT IN` examples; MySQL's
optimization page doesn't mention it at all). Rewrote to a claim fully
supported by what was actually verified (the relational projection
operation + general practice) rather than attributing specific wording
to specific vendor docs that don't actually say it.

Cross-reference links added to each page's Further reading, all URLs
curl-verified live (200) both when first found and again in a final
recheck pass before finishing: roadmap.sh/system-design added once per
file (confirmed all 10 antipattern names — busy database, busy front
end, chatty I/O, extraneous fetching, improper instantiation,
monolithic persistence, no caching, noisy neighbor, retry storm,
synchronous I/O — appear as named topics on the live page via direct
curl+grep, matching the task's prior research); no DesignGurus or
Educative links added to any of the 10 files, per the task's own
instruction that neither source's public module list covers
antipatterns as a topic — confirmed no genuine match exists rather than
forcing one. Azure Architecture Center antipatterns-catalog links were
already present on all 10 pages pre-retrofit — checked first via grep,
not duplicated, each re-verified live. Additional real-tech doc links
added alongside roadmap.sh where the grounding claim warranted a
citable source: Rails Active Job Guides (busy-front-end), GraphQL
official site (chatty-io), Wikipedia's Projection (relational algebra)
(extraneous-fetching), .NET HttpClient guidelines (improper-
instantiation), Thundering herd problem — Wikipedia (no-caching, in
addition to the pre-existing chatty-io citation), AWS burstable-
performance-instances docs (noisy-neighbor), Node.js blocking-vs-non-
blocking docs (synchronous-io). monolithic-persistence and retry-storm
got roadmap.sh only, since their grounding claims were already
supported by existing citations (Wikipedia's Polyglot persistence page;
the pre-existing AWS backoff-with-jitter link) with nothing further to
add.

Read all 10 files in full before editing and again in full after, to
confirm additions read naturally with no duplication. Confirmed via
`git diff` that all 10 files' diffs are purely additive (102
insertions, 9 deletions — all 9 deletions are line-rewrap artifacts
from paragraphs that were extended with more sentences, same content
preserved, nothing removed or weakened; verified by inspecting every
removed line directly). Grepped all 10 files for "designgurus" and
"educative" (case-insensitive) — zero hits, as required. `npm run
typecheck` and `npm run build` both clean, zero broken links. All 29
external URLs across the 10 files re-verified live via curl in a final
pass (two Wikipedia URLs returned transient 429 rate-limit responses
on the first pass, confirmed 200 on retry with a short delay — not
broken links). Committed as a single `feat(patterns):` commit
(793f319).

## Phase 5.4: Cross-links — 16 Design-X case studies to Educative modules (FINAL TASK — Phase 5 complete)

Retrofitted the 16 Design-X case studies under
`course/case-studies/system-design/{uber,whatsapp,instagram,youtube,
google-maps,yelp,newsfeed,tinyurl,typeahead,google-docs,
payment-system,deployment-system,data-infrastructure,chatgpt,
llm-support-bot,code-assistant}.md` — real-tech grounding retrofit
(Part A) plus one Educative module cross-reference per file (Part B).
Read `improper-instantiation.md` first as the tone reference, then all
16 case studies in full before editing.

Real-tech grounding added (2-3 verified-accurate mentions per file,
additive only, no design advice made vendor-specific): uber — Uber's
own H3 grid / Google's S2 as real hierarchical-geospatial-index
implementations, Kafka for the location-ping ingest queue; whatsapp —
WhatsApp's real Erlang-based connection-layer architecture (web-
verified: ~2M+ connections/server, lightweight-process model), Redis-
style in-memory store for the presence directory, Kafka for the
durability queue; instagram — S3-style blob storage, a real CDN
(Cloudflare/Fastly/cloud-provider-edge), Kafka for the fan-out queue;
youtube — FFmpeg as the real transcoding-worker tool, HLS/MPEG-DASH as
the real adaptive-bitrate packaging protocols, Elasticsearch/OpenSearch
for the search index; google-maps — contraction hierarchies named
directly as the real routing-literature technique (web-verified against
OSRM and GraphHopper, both of which implement it), the OSM-style
slippy-map tile pyramid; yelp — Geohash/S2/H3 as three real grid
implementations, Elasticsearch `geo_distance` + PostgreSQL PostGIS as
real geo-filtering examples; newsfeed — Kafka for fan-out, Redis/
Memcached for the feed-store cache; tinyurl — Twitter's real Snowflake
ID scheme as the distributed-ID-generation precedent, Redis/Memcached
for the redirect cache; typeahead — Elasticsearch's completion
suggester named directly as a real FST-based prefix-index
implementation (web-verified), Spark as a real MapReduce-style
aggregation engine; google-docs — Google Docs' own real, publicly-
documented Jupiter OT lineage (web-verified) named directly as the
mechanism this design uses, Yjs/Automerge as real production CRDT
libraries; payment-system — kept to illustrative-only real-provider
mentions per the task's explicit narrower instruction for this file
(Stripe/Adyen named twice as examples of the generic "payment gateway"
role, design advice left fully generic, no implementation claims);
deployment-system — similarly scoped: Argo Rollouts/Flagger named as
real Kubernetes canary-controller implementations of the batch-and-
soak mechanics already described (web-verified), LaunchDarkly named as
one illustrative real feature-flag-service example alongside "commonly
built in-house"; data-infrastructure — Kafka for the ingestion log,
Spark and Flink/Kafka Streams for the Lambda batch/stream layers,
Snowflake/BigQuery/Redshift as real columnar-warehouse examples;
chatgpt — vLLM and NVIDIA TensorRT-LLM named directly as real
continuous-batching inference engines (web-verified), Server-Sent
Events for the token-streaming transport; llm-support-bot — Pinecone/
Weaviate/pgvector as real vector-index choices, Zendesk/Intercom as
real human-agent-tooling examples for the out-of-scope handoff
boundary; code-assistant — GitHub Copilot/Cursor named as the real
product category this design targets, Docker-style containers for the
tool-execution sandbox, tree-sitter named directly as the real multi-
language incremental parser (web-verified) underlying the codebase-
indexing pipeline's parse step.

Every real-product technical claim was independently web-verified
before being added, not assumed from training knowledge: WhatsApp's
Erlang connection-count claims, OSRM/GraphHopper's use of contraction
hierarchies, Elasticsearch completion-suggester's FST internals,
Google Docs/Jupiter's real OT lineage, vLLM/TensorRT-LLM's continuous-
batching mechanics, Argo Rollouts/Flagger's automated canary-analysis
behavior, and tree-sitter's incremental multi-language parsing were
each confirmed via live web search before the claim was written into
the page. No designgurus.io or educative.io pages were fetched or read
at any point, consistent with the hard, unchanged content-origin rule.

Educative cross-references: added exactly one per file, plain italic
prose (`*Educative's Grokking Modern System Design Interview course
covers this same system in its "..." module...*`), never markdown link
syntax, placed right after the framing paragraph and before Step 1 in
all 16 files. Module titles and mock-interview sub-lesson mentions
(Uber Eats, Facebook Messenger, TikTok, NewsFeed, ChatGPT) match the
exact mapping given in the task. Confirmed via grep that roadmap.sh and
DesignGurus have zero mentions across all 16 files, per the task's
explicit instruction that neither source has case-study-shaped content
to cross-reference for these pages.

Verification: grepped all 16 files for "educative" (case-insensitive)
— exactly 16 total occurrences, one per file, all plain text, none
inside `[...]()` link syntax. Grepped for "designgurus" and
"roadmap.sh" — zero hits. Read all 16 files back in full after editing
and diffed each against the pre-edit version: 16 files changed, 67
insertions, 35 deletions — every deleted line is the pre-edit version
of a sentence extended in place with grounding text (confirmed by
inspecting every removed line directly, same pattern as prior 5.x
sub-phases), nothing removed or weakened. `npm run typecheck` and `npm
run build` both clean, zero broken links. Manifest
(`src/data/courseManifest.ts`) confirmed unchanged and already correct
at 121 `design-patterns` entries and 24 total `system-design-case-
studies` entries (16 `supplementary` + 8 `primer`), matching the task's
required final counts — no re-ingest needed since this was a prose-only
retrofit with no file adds/removes/renames. Committed as a single
`feat(case-studies):` commit (fb05faa).

## Phase 5 complete — 5-phase project summary

This was the final task of the final phase (5.4) of a 5-phase library
expansion project on `library-v2-expansion`, starting from a base of
91 pattern pages (merged and deployed on `main` @ aac1e7a). Total scope
delivered across all 5 phases:

- **Phase 1** (gap-fill, 15 pages at v3 template): new Caching group (5
  pages) + Consistency/Storage/Reliability gap patterns (5 pages) +
  API-edge gaps and concept-to-pattern promotions (5 pages).
- **Phase 2** (new catalogs, 15 pages at v3): new AI Agent Orchestration
  group (5 pages) + new Azure-style Antipatterns catalog (10 pages).
- **Phase 3** (deep-rewrite of the original 91 pages to v3 template):
  full build-out (diagram + code + v3 sections) for pages that had
  none, and v3-sections-only additions for the 31 pages that already
  had diagrams/code from a prior merge. Brought the full pre-existing
  library up to the v3 template standard (Technical Architecture &
  Implementation, Use-Case Scenarios, etc.).
- **Phase 4** (Design-X case studies, ~17 new original pages): full
  Step-1-through-4 system-design walkthroughs for Uber, WhatsApp,
  Instagram, YouTube, Google Maps, Yelp, Newsfeed, TinyURL, Typeahead,
  Google Docs, Payment System, Deployment System, Data Infrastructure,
  ChatGPT, LLM Support Bot, Code Assistant, and others — all original
  writing, never copied from any source.
- **Phase 5** (source cross-linking pass across the full final library,
  5 sub-phases): retrofitted every new-in-this-project page under the
  policy relaxation approved mid-phase (real vendor/technology names
  now allowed where accurate and additive; external citations more
  generous) and added cross-references to DesignGurus/Educative/
  roadmap.sh/Azure Architecture Center where a genuine topical match
  existed — 5.1 Caching + gap-fill patterns (10 pages), 5.2 API-edge
  gaps + AI Agent Orchestration (10 pages), 5.3 Antipatterns (10
  pages), 5.4 the 16 Design-X case studies (this entry).

Final library state: 121 design-patterns entries + 24 system-design
case studies (16 supplementary + 8 primer) per the manifest, `npm run
typecheck` and `npm run build` both clean across the whole site. All
content across all 5 phases is original writing informed by research
citations, never verbatim from any source, with the two hard rules
(no verbatim copying; no reading paywalled DesignGurus/Educative
lesson pages, title-only awareness only) held constant across every
phase even as the vendor-naming and citation-generosity policy relaxed
partway through. This is the last entry in this ledger for the
library-v2-expansion project.

## Deep-dive rewrite A — Uber, WhatsApp, Instagram, YouTube (commit 5d16dae)

Follow-on task after tinyurl.md was rewritten (commit f918629) as the
reference implementation of a new, much deeper case-study template.
Rewrote Step 3, Step 4, and Additional talking points for
uber.md/whatsapp.md/instagram.md/youtube.md to match that template,
replacing long connected prose paragraphs with concrete, checkable
technical content per use case (working Python/SQL, literal schemas,
wire-format examples, REST contracts), plus a new "Source(s) and
further reading" section per file. Step 1 and Step 2 left untouched in
all four files (confirmed via diff hunk boundaries — every change
starts at or after each file's Step 3 heading).

Core spec shape used per use case:
- **Uber**: geohash-based spatial index (`DriverLocationIndex` class)
  with expanding-ring nearest-driver search as the classic-algorithm
  core spec for driver discovery; a second `SurgePricingEngine` class
  for per-cell demand/supply pricing with spatial smoothing across
  neighboring cells (the required non-trivial treatment, not just a
  mention).
- **WhatsApp**: schema + indexing (literal `CREATE TABLE` DDL for
  `messages` partitioned by `conversation_id` with a sortable
  `message_id`, and `pending_delivery` partitioned by `recipient_id`)
  plus a protocol/state-machine core spec for the sent -> delivered ->
  read three-checkmark lifecycle with named failure/rollback branches.
  End-to-end encryption named explicitly as a constraint that rules
  out server-side search/content-routing.
- **Instagram**: hybrid push/pull fan-out algorithm (`FanOutService`
  class) as the classic-algorithm core spec, with an explicit "the
  celebrity problem" gotcha (naive push-only fan-out at millions of
  followers) and a 10,000-follower threshold in code; plus a sharded
  `LikeCounter` for the likes/comments use case.
- **YouTube**: DAG-based parallel chunked transcoding as a
  MapReduce-shaped batch/pipeline core spec (`TranscodingCoordinator`
  with `mapper`/`reducer` methods, keyframe-aware chunk-boundary gotcha
  named explicitly), plus a literal HLS `.m3u8` master/child manifest
  wire-format example for adaptive bitrate playback.

Verification: all 5 Python code blocks parsed via `ast.parse` (0
failures); the 1 SQL block hand-checked; 15 unique external links
curl-verified live (200, one transient 000 on ffmpeg.org resolved to
200 on verbose retry); `npm run typecheck` and `npm run build` both
pass clean with zero broken links; diffs confirmed to only touch each
file from its Step 3 heading onward. Committed as a single
`feat(case-studies):` commit (5d16dae) on `library-v2-expansion`.

Remaining deep-dive rewrite scope (not part of this entry, tracked
separately): Google Maps/Yelp/Newsfeed; Typeahead/Google
Docs/Payment System/Deployment System; Data Infrastructure/ChatGPT/LLM
Support Bot/Code Assistant — 11 more case studies still on the old
template, to be brought up to the tinyurl.md bar in follow-on tasks.

## Deep-dive rewrite B — Google Maps, Yelp, Newsfeed (commit 3661cb3)

Follow-on task after deep-dive rewrite A (commit 5d16dae). Rewrote
Step 3, Step 4, and Additional talking points for
google-maps.md/yelp.md/newsfeed.md to the same template, replacing
prose paragraphs with concrete, checkable technical content per use
case (working Python/SQL, literal schemas, wire-format examples, REST
contracts), plus a new "Source(s) and further reading" section per
file. Step 1 and Step 2 left untouched in all three files (confirmed
via diff hunk boundaries — every change starts at or after each
file's Step 3 heading).

Core spec shape used per use case:
- **Google Maps**: Dijkstra/A* shortest-path search
  (`dijkstra_shortest_path`) as the classic-algorithm core spec, with
  Contraction Hierarchies named explicitly (not left as plain
  Dijkstra) as the offline shortcut-precomputation step that makes
  sub-second routing viable at ~700M edges — code comments mark
  exactly where CH's shortcuts would prune the search; scale claim
  kept qualitative ("dramatic reduction," "small bounded
  neighborhood") rather than an unverified specific number, per
  instructions. Plus an async `TrafficAggregator` for live traffic
  ingestion and a throttled `should_reroute` function for
  bounded-interval re-routing (10% improvement floor to avoid
  rerouting on noise).
- **Yelp**: schema + geohash indexing core spec — literal `CREATE
  TABLE businesses` DDL with a `geohash` column and index,
  index-to-query reasoning explained in prose. "The boundary problem"
  named explicitly as its own labeled gotcha, with real
  neighbor-cell-expansion code (`geohash_neighbors`, 9-cell query in
  `nearby_search`) as the fix. Plus a weighted distance+rating
  `rank_score` function and an incremental `record_review` rating
  aggregate update.
- **Newsfeed**: differentiated from instagram.md by explicitly
  deferring fan-out mechanics ("see that case study... not re-derived
  here") and making ranking the central, distinguishing use case.
  EdgeRank named explicitly as the canonical reference formula and
  implemented as a simplified `EdgeRankScorer` class
  (affinity_score × edge_weight × time_decay), positioned in the
  gotcha as the concrete alternative to a hand-waved "rank by
  relevance."

Verification: all 7 Python code blocks parsed via `ast.parse` (0
failures); the 1 SQL DDL block hand-checked; 13 unique external links
curl-verified live (200) — Contraction Hierarchies/A*/Dijkstra/OSRM/
GraphHopper (Wikipedia + real routing-engine homepages) for Google
Maps, Geohash/S2/H3/PostGIS/Elasticsearch geo_distance for Yelp,
EdgeRank/Facebook News Feed/News Feed (Wikipedia) for Newsfeed;
`npm run typecheck` and `npm run build` both pass clean with zero
broken links; diffs confirmed to only touch each file from its Step 3
heading onward. Committed as a single `feat(case-studies):` commit
(3661cb3) on `library-v2-expansion`.

Remaining deep-dive rewrite scope (not part of this entry, tracked
separately): Typeahead/Google Docs/Payment System/Deployment System;
Data Infrastructure/ChatGPT/LLM Support Bot/Code Assistant — 8 more
case studies still on the old template, to be brought up to the
tinyurl.md bar in follow-on tasks.

### Deep-dive rewrite A review — Uber/WhatsApp/Instagram/YouTube — COMPLETE, no fixes
Independent review of commit `5d16dae`: all 4 required gotchas verified
genuinely implemented in code (not name-dropped) — Uber's expanding-ring
geohash search + spatially-smoothed surge pricing, WhatsApp's delivery
state machine with named failure/rollback branches + E2E-encryption
constraint, Instagram's celebrity-problem threshold branch, YouTube's
DAG chunked transcoding + real HLS manifest. Build/typecheck clean.
Ready, no fix round needed.

### Deep-dive rewrite B fix round — Google Maps/Yelp/Newsfeed — COMPLETE
Fix commit `529a3c8` on top of `3661cb3`. Review caught 1 Critical:
`geohash_neighbors`/`haversine_distance` were referenced and called in
`nearby_search` but never actually implemented — the boundary-problem
gotcha's prose described the fix without showing it. Fixed directly:
real base-32 geohash encode/decode + bounding-box-edge-stepping
neighbor computation, verified correct via a standalone test (nearby
points crossing a cell boundary genuinely land in the computed
8-neighbor set, not just the center cell). Build/typecheck clean after
fix. Task fully closed.

### Deep-dive rewrite C — Typeahead/Google Docs/Payment System/Deployment System — COMPLETE
Commit `01603d3` on `library-v2-expansion`. Rewrote Step 3/Step 4/Additional
talking points + added Source(s) sections for all 4 files; Step 1/2
confirmed byte-identical via diff (untouched). Per-file Core spec shape
and named gotcha, each with real, verified-correct code (not prose-only):
- **Typeahead**: trie Core algorithm — the load-bearing decision named
  explicitly as its own gotcha is write-time top-K caching at every
  `TrieNode`, not the trie shape alone; naive read-time subtree DFS
  called out as the wrong approach. Real `Trie`/`TrieNode` classes with
  `record_query`/`_update_node_top_k` (write path) and `suggest` (read
  path, O(K) cache return only); `rebuild_index` batch aggregation +
  atomic-swap update path. Hand-tested: prefix lookups, frequency-bump
  re-ranking, and batch rebuild all verified correct against expected
  ordered output.
- **Google Docs**: operational transformation (OT) named as Google's
  real, publicly-documented design choice over CRDT for Google Docs,
  with the actual trade-off (per-op overhead vs. per-character CRDT
  metadata, central authority requirement) explained as a gotcha. Real
  `transform(op1, op2)` classic-OT function plus `apply_insert`; a
  worked two-concurrent-inserts example proven to converge to the
  identical string regardless of application order, hand-traced via a
  standalone script including the equal-position tiebreak branch.
- **Payment System**: double-entry ledger given its own named schema
  treatment, separate from idempotency — `accounts`/`ledger_entries`
  DDL with `SUM(debits) = SUM(credits)` as the core invariant, plus a
  real `check_ledger_balanced`/`record_payment` implementation. Saga
  state machine (reserve -> charging -> confirmed/compensating ->
  cancelled) with named rollback branches, kept explicitly distinct
  from idempotency-key protocol (also its own Core spec + REST API).
  Hand-tested: balanced-payment case, multi-payment full-ledger
  reconciliation, and a deliberately broken invariant (missing credit
  row) correctly detected as unbalanced.
- **Deployment System**: rolling/blue-green/canary compared explicitly
  in a mechanics table (not just named) with blast radius as the
  unifying gotcha concept tying all three together. Real
  `CanaryDeployment` state machine (`Stage` enum: 5% -> 25% -> 100%,
  `observe_and_advance` gate, automatic `rollback()` on error-rate
  threshold breach, manual rollback reusing the identical method).
  Hand-tested via 3 scenarios: bad release caught and auto-rolled-back
  at the 25% stage, healthy release promoting through all 3 stages
  then idempotent at FULL_100, and manual rollback reaching 0% traffic.

Verification: all 7 Python code blocks parsed via `ast.parse` (0
failures); 1 SQL DDL block (payment-system) hand-checked; every
function called by name in any block cross-checked against a matching
`def` in the same file via AST call/def-set diff (only Python builtins,
stdlib imports, and injected mock-dependency methods excluded, all
individually named) — zero unimplemented-stub gotcha functions found,
directly addressing the prior task's `geohash_neighbors` defect class.
15 unique external links curl-verified live (200): Trie/Autocomplete/
Operational transformation/CRDT/Double-entry bookkeeping/Canary release
(Wikipedia), Elasticsearch completion suggester, Yjs, Automerge, Google
Drive blog (OT design decision), Stripe idempotency docs, AWS rolling
deployments whitepaper, Kubernetes rolling update docs, LaunchDarkly
feature flags docs, Martin Fowler blue-green deployment. `npm run
typecheck` and `npm run build` both pass clean with zero broken links.
Step 1/2 diffed byte-identical against pre-edit versions for all 4
files. Committed as a single `feat(case-studies):` commit (`01603d3`)
on `library-v2-expansion`.

Remaining deep-dive rewrite scope (not part of this entry, tracked
separately): Data Infrastructure/ChatGPT/LLM Support Bot/Code
Assistant — 4 more case studies still on the old template.

### Deep-dive rewrite D — Data Infrastructure/ChatGPT/LLM Support Bot/Code Assistant — COMPLETE
Commit `6add2cf` on `library-v2-expansion`. Rewrote Step 3/Step 4/Additional
talking points + added Source(s) sections for all 4 files; Step 1/2
confirmed byte-identical via diff (untouched — first changed diff hunk
in every file starts exactly at the line after Step 2's closing
paragraph). Per-file Core spec shape and named gotcha, each with real,
verified-correct code (not prose-only):
- **Data Infrastructure**: Lambda vs. Kappa architecture named
  explicitly, both described structurally (Lambda's batch+speed-layer
  split vs. Kappa's single-stream-plus-replay). The gotcha is Lambda's
  well-known batch/stream codebase divergence risk (a fix landing in
  one path but not the other, silently producing different numbers for
  the same data) — this design defaults to Kappa specifically to
  remove that structural risk. Real `KappaStreamProcessor` +
  `WindowedAggregate` with a genuine `reprocess()` replay-from-offset
  capability sharing the identical `process_one`/`transform_fn` code
  path as `run_live()`. Hand-tested: live consumption and a full
  replay-from-offset-0 run produce byte-identical windowed aggregates
  after a filtering transform, proving the single-codepath claim isn't
  just asserted in prose.
- **ChatGPT**: continuous (iteration-level) batching and
  PagedAttention/KV-cache block management both given full named
  treatment as two distinct, complementary mechanisms (compute-slot
  utilization vs. memory utilization), plus TTFT-vs-inter-token-latency
  established as two genuinely different metrics with different causes
  (prefill vs. decode) threaded through Step 3 and Step 4, not just
  defined once. Real `ContinuousBatchingScheduler`/`GenerationRequest`
  (admits a waiting request into a freed slot the step immediately
  after eviction, not after the whole batch drains) and
  `KVCacheBlockManager` (on-demand fixed-size block allocation +
  immediate release on completion, modeled on OS paging). Hand-tested:
  a 3-then-4-request scheduler trace confirms continuous admission
  timing (the new request is admitted the step right after a slot
  frees, not at batch-fill time), and the block manager correctly
  grows/releases block tables.
- **LLM Support Bot**: fixed-length vs. semantic chunking given its own
  explicit Core spec treatment, separate from the retrieval algorithm,
  with a real trade-off (uniform/predictable/boundary-splitting vs.
  structure-respecting/variable-length/preprocessing-heavy) and
  fixed-length-with-overlap given as the practical middle ground with
  real, working code. Real `retrieve_top_n`/`rerank_top_k` two-stage
  pipeline (rerank stamps a `rerank_score` onto each surviving chunk)
  feeding a real `should_escalate` with 4 named branches (no grounding,
  low confidence, explicit human request via `requests_human`, repeated
  question via `is_repeated_question`/`_word_overlap_ratio`) — both
  `requests_human` and the repetition detector are fully implemented,
  not stubs. Hand-tested: chunking overlap verified exactly 150 chars
  between consecutive windows via position tracking; retrieval+rerank
  surfaces the correct grounding chunk for a password-reset query;
  all 5 escalation branches (no-chunks, low-score, high-confidence
  pass-through, explicit-human-request, repeated-question) verified
  independently.
- **Code Assistant**: three named retrieval architectures (index-first/
  persistent embeddings, agentic/on-demand search, hybrid graph+vector)
  compared explicitly in a table with strengths/weaknesses, not
  silently picked — this design uses hybrid for general questions and
  agentic on-demand for multi-step changes, both named as deliberate
  per-use-case choices. Separately, a real working agent loop
  (`AgentLoop`: read/act/observe/repeat) with a genuine hard
  human-approval gate — `run_until_done_or_blocked` returns immediately
  on encountering a mutating tool call, before executing it, and only
  `approve_pending()` (a separate, explicit call) can resume execution
  through to `SandboxedExecutor.execute`; `reject_pending()` discards
  the call, never executed. The gotcha names the specific risk a
  UI-only confirmation dialog has (bypassable via race/config-flag/
  retry path) that a control-flow-level gate doesn't. Hand-tested:
  full trace confirms a mutating `apply_edit` call blocks before
  touching the file, only mutates after `approve_pending()`, and a
  separate rejection trace confirms `reject_pending()` never executes
  the file write; the two code blocks (`AgentLoop` +
  `SandboxedExecutor`) run concatenated exactly as they appear in the
  doc.

Verification: all 8 Python code blocks parsed via `ast.parse` (0
failures); every function called by name in any block cross-checked
against a matching `def` in the same file via AST call/def-set diff
(unresolved names individually reviewed — all either Python
builtins/stdlib methods or explicitly-commented injected dependencies
like `self.model.decode_step`, `self.policy.next_action`,
`self.executor.execute`, `embed_fn`/`rerank_score_fn` parameters —
zero unimplemented-stub gotcha functions found). Beyond the AST check,
every code block was executed end-to-end by hand (concatenating
split blocks exactly as they appear in the doc where a Core spec spans
two fences) to confirm the logic is genuinely correct, not just
syntactically valid: Kappa live-vs-replay equality, continuous-batching
admission timing, KV-cache block grow/release, chunking-overlap byte
math, retrieval+rerank+escalation composition, and the full agent-loop
approve/reject paths. 12 unique external links curl-verified live
(200): Lambda architecture (Wikipedia), Kappa Architecture (Milinda
Pathirage), Apache Kafka durability semantics, vLLM docs, TensorRT-LLM
paper (arXiv), Orca/USENIX OSDI '22 (continuous batching origin paper),
Retrieval-augmented generation (Wikipedia), Pinecone chunking
strategies, LangChain text splitters, tree-sitter, Anthropic
writing-tools-for-agents, GitHub Copilot docs. `npm run typecheck` and
`npm run build` both pass clean with zero broken links. Step 1/2
diffed byte-identical against pre-edit versions for all 4 files.
Committed as a single `feat(case-studies):` commit (`6add2cf`) on
`library-v2-expansion`.

**This completes the full case-study deep-dive rewrite series — all 16
case studies (Uber/WhatsApp/Instagram/YouTube, Google Maps/Yelp/
Newsfeed/TinyURL, Typeahead/Google Docs/Payment System/Deployment
System, Data Infrastructure/ChatGPT/LLM Support Bot/Code Assistant)
are now on the deep technical template established by tinyurl.md.**

### Deep-dive rewrite D review — Data Infra/ChatGPT/Support Bot/Code Assistant — COMPLETE, no fixes
Independent review of commit `6add2cf`: every falsifiable claim
independently re-executed, not just parsed — Kappa live/reprocess
convergence confirmed bit-identical on out-of-order and partial-replay
test data, continuous batching's mid-batch backfill proven via
instrumented execution, KV-cache block grow/release traced at exact
16-token boundaries, chunking overlap math verified exact, 4-branch
escalation logic independently triggered, and the agent loop's
human-approval gate proven structurally enforced (mutating tool calls
never reach the executor without explicit `approve_pending()`, and
`reject_pending()` leaves the file store untouched). AST cross-check
found zero orphaned function calls across all 4 files. No false
proprietary-architecture claims. All 12 links live, Step 1/2 untouched,
build/typecheck clean. Whole-series sanity check: all 16 deep-dive case
studies confirmed to have the closing Source(s) section; the 8
primer-derived case studies correctly remain on their own template
(out of scope by design, not a gap).

## CASE-STUDY DEEP-DIVE REWRITE SERIES COMPLETE — 16/16 case studies,
## 4 tasks, every task independently reviewed clean (2 fix rounds along
## the way: yelp.md's geohash_neighbors implementation gap, caught and
## fixed). All 24 case studies (16 deep-dive + 8 primer) verified
## present, build/typecheck clean throughout.
