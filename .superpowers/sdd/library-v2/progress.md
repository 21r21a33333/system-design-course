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

### Phase 3 (relaunched, all-121 scope) — Group: Building Blocks (16 pages) — COMPLETE
Commits: 53ad61f (batch A: blob-store, key-value-store, distributed-cache,
distributed-search), 98ca620 (batch B/C/D: distributed-message-queue,
distributed-logging, distributed-monitoring, distributed-task-scheduler,
rate-limiter, sequencer, sharded-counters, throttling, scheduler-agent-
supervisor, static-content-hosting, cdn, pipes-and-filters), 1a509cc
(review fixes).

NEW scope per user (2026-08-11): flexible-baseline (v3 spine + topic-
specific added sections/diagrams/tables where they add value), ALL 121
pages, real-tech naming ALLOWED and cited, external reference links w/
attribution generous, ORIGINAL SVGs only (never embed external images),
no domain denylist. Copyright boundary still hard: no verbatim copy of
text or images from any source.

Process: 1 pilot implementer (batch A) validated the brief, then 3
parallel implementers (B/C/D, disjoint files), git kept single-threaded
in orchestrator. Bare pages got full build-out (diagram+code+deep
architecture+scenarios+extras); img+code pages depth-up; the 2 already-v3
pages (cdn, pipes-and-filters) light-enhanced with existing content
preserved. Added comparison tables (delivery guarantees, rate-limit
algorithms, ID schemes). 11 new original SVGs.

Independent review (fresh skeptical agent): re-ran all 3 concurrency
claims with its own timing harnesses — distributed-search scatter-gather
3.61x, sharded-counters 1.74x + exact-total-no-lost-updates, scheduler-
agent-supervisor 47ms vs 129ms — all genuinely multi-threaded (real OS
threads, not sequential-in-disguise). Verified facts (Snowflake bit
budget, quorum R+W>N, BM25 saturation+length-norm, RS(4,2)=1.5x vs 3x
replication). Originality spot-checks (exact-phrase search) clean. Fixed
1 correctness bug (truncated FNV-1a offset basis 1469598103934665603 ->
14695981039346656037 in distributed-message-queue) + 2 dead external
links (Datastore 404 -> Firestore counters; Twitter blog 403 ->
twitter-archive/snowflake). All 16 Rust snippets compile via rustc
--edition 2021; typecheck + build clean, manifest untouched at 121.

### Phase 3 (relaunched) — Group: Reliability (7 pages) — COMPLETE
Commits: b22934c (all 7). failover.md (v3 exemplar) left untouched.
7 bare pages fully built out: circuit-breaker (+ 2nd state-machine
diagram circuit-breaker-states.svg), retry-with-backoff, timeout,
bulkhead, idempotency, dead-letter-queue, graceful-degradation. 8 new
SVGs. Cross-differentiation deliberately consistent with failover.md
(breaker stops calls / bulkhead isolates resources / failover replaces /
degradation reduces / retry repeats). Added jitter-strategies and
degradation-tier tables, deadline-propagation and idempotency-key
walkthroughs.

PROCESS LEARNINGS this group (fed into all subsequent briefs):
1. Implementers initially embedded `#[cfg(test)] mod tests` in every
   shipped snippet — inconsistent with failover.md/building-blocks
   (mechanism-only). Ran a normalization fixer to strip test modules
   (bulkhead's real-thread test converted to a plain `fn main()` demo to
   preserve the empirical concurrency). RULE NOW IN BRIEFS: code example
   ships the MECHANISM only, no #[test]/#[cfg(test)] on the page.
2. That fixer subagent ACCIDENTALLY LEAKED its own tool-call closing
   tags (`</content>`, `</invoke>`) as trailing lines into 3 files,
   which broke the MDX build ("unexpected closing slash in tag"). Caught
   by the orchestrator's mandatory post-edit `npm run build` (NOT by the
   subagent's self-report). Stripped the 2 junk lines per file; rebuilt
   clean. Reinforces: always full-build after ANY subagent edit; never
   trust "verified" self-reports.

Independent review (fresh agent): all 10 checks pass, zero issues, zero
fixes. Re-ran bulkhead concurrency 5x (peak concurrency == 2 permits
every run, ~224ms wall, genuinely multi-threaded). Re-verified DLQ (dead-
letters at exactly max_attempts=3) and idempotency (total_charged stays
2500 on replay) behaviorally. 16 external URLs curl-checked all 200.
Originality verbatim-search clean. Build/typecheck clean, manifest 121.

### Phase 3 (relaunched) — Group: Batch & Streaming (11 pages) — COMPLETE
Commits: 7bf6b0b (all 11), 1b65d77 (review fix). 7 bare built out
(stream-processing, backpressure, exactly-once-semantics, partitioned-
consumption, change-data-capture, mapreduce, lambda-kappa-architecture)
+ 4 depth-ups (competing-consumers, priority-queue, queue-based-load-
leveling, sequential-convoy). 7 new SVGs. Comparison tables (delivery
guarantees, CDC capture methods, lambda-vs-kappa, window types).
Mechanism-only snippets (new rule enforced from the start — zero test
attrs). Genuine real-thread timing demos: mapreduce parallel-map 55ms
vs 200ms, competing-consumers 4-worker 232ms/~3.4x, sequential-convoy
per-key lanes 70ms, backpressure sync_channel 319ms/3-blocked.

Independent review: re-ran all 5 concurrency claims (all genuinely
multi-threaded, none sequential-in-disguise), verified logic of all 7
lib mechanisms by reading, 26 internal links resolve, SVGs valid+on-
palette, originality verbatim-search clean, curled 19 external URLs —
1 dead (LinkedIn "The Log" engineering.linkedin.com 404 -> migrated
linkedin.com/blog canonical), fixed. Build/typecheck clean, manifest 121.
