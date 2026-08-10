# Design Patterns Library — Design Spec

Date: 2026-08-10
Status: Approved (design phase) — pending implementation plan

## 1. Problem

The site currently replicates 100% of donnemartin/system-design-primer, but a comparison against three paid system-design courses (Educative's *Grokking Modern System Design Interview*, DesignGurus' *Grokking Modern API Design Interview*, and DesignGurus' *System Design Patterns*) surfaced a large set of standard system-design patterns and building blocks that the primer never covers at all (Circuit Breaker, CQRS, Saga, Consistent Hashing, Service Mesh, etc.). The user wants the site to become a complete system-design learning resource, not just a primer mirror — while clearly distinguishing primer-sourced content from newly-authored content.

Research method and constraint: only the public curriculum/table-of-contents pages of the three paid courses were fetched — never any paywalled lesson content. Everything written under this spec is original explanation of well-established, publicly-documented CS concepts (each of these patterns has extensive free coverage: Martin Fowler's site, AWS/Azure/GCP architecture centers, Wikipedia, engineering blogs), not a reproduction or paraphrase of any paid course's text.

## 2. Goal (this spec — Phase 1 of 3)

Add a "Design Patterns" section to the site: 60 new pages covering patterns and building blocks absent from the primer, each progress-trackable and clearly marked as supplementary (not from the original primer) so the user can tell the two content sources apart at a glance.

Phase 2 (API Design section, from the DesignGurus API course topic list) and Phase 3 (new case studies: YouTube, Uber, Instagram, etc.) are explicitly out of scope for this spec — each gets its own spec once this phase ships.

## 3. Content inventory — 60 pages across 10 groups

Each page lives at `course/patterns/<group-slug>/<page-slug>.md`. Doc id (Docusaurus auto-derived, path relative to `course/`, no extension) is therefore `patterns/<group-slug>/<page-slug>`.

| Group (slug, sidebar position) | Pages (slug — title) |
|---|---|
| `communication` (1) | `pub-sub` — Publish-Subscribe · `event-driven-architecture` — Event-Driven Architecture · `webhooks` — Webhooks · `server-sent-events` — Server-Sent Events · `websockets` — WebSockets / Bidirectional Streaming |
| `storage` (2) | `sharding` — Sharding · `consistent-hashing` — Consistent Hashing · `write-ahead-log` — Write-Ahead Log · `event-sourcing` — Event Sourcing · `cqrs` — CQRS |
| `reliability` (3) | `timeout` — Timeout · `retry-with-backoff` — Retry with Exponential Backoff · `idempotency` — Idempotency · `circuit-breaker` — Circuit Breaker · `bulkhead` — Bulkhead · `dead-letter-queue` — Dead Letter Queue · `graceful-degradation` — Graceful Degradation |
| `scaling` (4) | `vertical-scaling` — Vertical Scaling · `horizontal-scaling` — Horizontal Scaling · `auto-scaling` — Auto-Scaling · `connection-pooling` — Database Connection Pooling |
| `consistency` (5) | `two-phase-commit` — Two-Phase Commit · `saga` — Saga · `quorum` — Quorum · `vector-clocks` — Vector Clocks |
| `api-edge` (6) | `api-gateway` — API Gateway · `backend-for-frontend` — Backend for Frontend · `sidecar` — Sidecar · `service-mesh` — Service Mesh · `cursor-pagination` — Cursor-Based Pagination |
| `observability` (7) | `health-check` — Health Check Endpoint · `distributed-tracing` — Distributed Tracing · `blue-green-deployment` — Blue-Green Deployment · `canary-deployment` — Canary Deployment · `feature-flags` — Feature Flags |
| `batch-streaming` (8) | `mapreduce` — MapReduce · `stream-processing` — Stream Processing · `lambda-kappa-architecture` — Lambda and Kappa Architecture · `change-data-capture` — Change Data Capture · `exactly-once-semantics` — Exactly-Once Semantics · `backpressure` — Backpressure (expanded dedicated treatment; primer's `asynchronism.md` mentions it in one paragraph — cross-link both ways, do not duplicate that paragraph) · `partitioned-consumption` — Partitioned Consumption |
| `ai-infra` (9) | `feature-store` — Feature Store · `model-serving` — Model Serving · `gpu-auto-scaling` — GPU Auto-Scaling · `llm-gateway` — LLM Gateway · `semantic-caching` — Semantic Caching · `vector-database-sharding` — Vector Database Sharding · `rag-pipeline` — RAG Pipeline |
| `building-blocks` (10) | `key-value-store` — Key-Value Store · `sequencer` — Sequencer / Unique ID Generation · `distributed-monitoring` — Distributed Monitoring & Error Tracking · `distributed-cache` — Distributed Cache (cross-link primer's `cache.md`, which covers caching *strategies*; this covers the *distributed* aspect — cluster topology, coherence, hot-key handling) · `distributed-message-queue` — Distributed Message Queue (cross-link primer's `asynchronism.md`; this covers partitioned-log semantics, ordering, delivery guarantees) · `rate-limiter` — Rate Limiter · `blob-store` — Blob Store / Object Storage · `distributed-search` — Distributed Search · `distributed-logging` — Distributed Logging · `distributed-task-scheduler` — Distributed Task Scheduler · `sharded-counters` — Sharded Counters |

Total: 5+5+7+4+4+5+5+7+7+11 = 60 pages.

## 4. Per-page content template

Every page follows the same structure (~400–700 words):

1. One-paragraph definition.
2. **Problem it solves** — what goes wrong without this pattern.
3. **How it works** — the mechanism, described precisely enough to reason about (text/ASCII diagram where it clarifies more than prose).
4. **When to use it / when not to** — genuine tradeoffs, not just upsides.
5. **Real-world example** — a well-known, publicly-documented real usage (e.g. "Netflix's Hystrix library popularized this pattern"). Conservative and factual — no fabricated specifics; if a precise example isn't confidently known, describe the pattern's typical usage generically instead of guessing.
6. **Related patterns** — cross-links to other pages in this library or the primer.
7. **Further reading** — 1–3 real links to stable, free public resources only (martinfowler.com, AWS/Azure/GCP architecture centers, Wikipedia, or the primer itself for a related primer concept). Never a link to Educative or DesignGurus.

## 5. Decisions

| Decision | Choice | Why |
|---|---|---|
| Content origin | Original writing from general public CS knowledge | Never fetched or referenced paywalled lesson text — only public course TOC pages |
| Where it lives | New `course/patterns/<group>/*.md` tree, new "Design Patterns" sidebar category (position 4) | Autogenerated sidebar (`dirName: '.'`) already picks up any new folder with `_category_.json` — no `sidebars.ts` changes needed |
| How it's indexed | `run.ts` scans `course/patterns/**/*.md` after building the primer manifest and appends entries tagged `source: 'supplementary'` | Keeps ingestion (primer content generation) and authoring (this content) cleanly separate, while keeping ONE manifest as the dashboard/mark-complete single source of truth |
| Distinguishing mark | `source: 'primer' \| 'supplementary'` field on `ManifestEntry` (optional, defaults to primer semantics when absent) + `supplementary: true` frontmatter flag read by the swizzled `DocItem/Layout` | Optional field means Task 5's existing `buildManifest` tests need zero changes; frontmatter flag is the per-page signal the badge component reads directly, no manifest lookup needed at render time |
| Badge UI | One reusable `<SupplementaryBadge />` — full banner at top of the doc page (in `DocItem/Layout`), same component reused as an inline pill next to entries in the dashboard list | Single component, two contexts, no variant props needed — CSS handles both |

## 6. Architecture

```
course/patterns/<group>/*.md  (60 hand-authored pages, supplementary: true frontmatter)
        │
        ▼  scripts/authored/scanAuthoredDocs.ts (scans, does not transform)
        │
run.ts (existing ingestion orchestrator) ──┬── buildManifest(...) [primer content, unchanged]
                                            └── + scanned pattern entries, tagged source: 'supplementary'
        │
        ▼
src/data/courseManifest.ts (regenerated, now includes both primer + supplementary entries)
        │
        ▼
DocItem/Layout swizzle (existing) → reads frontMatter.supplementary → renders <SupplementaryBadge/>
progress.tsx dashboard (existing) → new 'design-patterns' category + inline badge on supplementary entries
```

## 7. Components

- **`scripts/authored/frontmatter.ts`** — `buildAuthoredFrontmatter(title: string, position: number): string`, emits `title`, `sidebar_position`, and `supplementary: true`. Separate from `scripts/ingest/frontmatter.ts` since this isn't part of the ingestion pipeline.
- **`scripts/authored/scanAuthoredDocs.ts`** — `scanAuthoredMarkdown(courseDir: string, subDir: string): { id: string; title: string }[]`. Recursively walks `subDir` under `courseDir`, reads each `.md` file's frontmatter `title`, derives `id` as the path relative to `courseDir` with the extension stripped (mirrors Docusaurus's real doc-id derivation exactly — same correctness property as Task 5's `buildManifest`).
- **`scripts/ingest/manifest.ts`** (modified, additively) — `ManifestCategory` gains `'design-patterns'`; `ManifestEntry` gains optional `source?: 'primer' | 'supplementary'`. `buildManifest`'s own signature, logic, and tests are untouched.
- **`scripts/ingest/run.ts`** (modified) — after the existing `buildManifest(...)` call: tag every returned entry `source: 'primer'`, scan `course/patterns/` via the new scanner, push one `design-patterns`/`source: 'supplementary'` entry per pattern page, then write the manifest as before.
- **`src/components/SupplementaryBadge/index.tsx`** — presentational, no props, renders a small styled pill: "Supplementary — not from the original primer."
- **`src/theme/DocItem/Layout/index.tsx`** (modified) — reads `useDoc().metadata.frontMatter.supplementary === true`, conditionally renders `<SupplementaryBadge />` alongside the existing `<MarkComplete />`.
- **`src/pages/progress.tsx`** (modified) — `CATEGORY_LABELS`/`CATEGORY_ORDER` gain `'design-patterns': 'Design Patterns'`; list items render `<SupplementaryBadge />` inline when `entry.source === 'supplementary'`.
- **`course/patterns/_category_.json`** (position 4, label "Design Patterns") + one `_category_.json` per group subfolder (positions 1–10 per §3's table).

## 8. Error handling

- `scanAuthoredMarkdown` throws if a `.md` file under the scanned directory has no `title` in its frontmatter — same fail-loud discipline as the rest of the ingestion pipeline.
- `npm run ingest` gains a count check: exactly 60 entries with `source: 'supplementary'` in the final manifest, and every file under `course/patterns/**/*.md` has `supplementary: true` in its frontmatter — catches a forgotten or mis-tagged page.
- `onBrokenLinks`/`onBrokenAnchors: 'throw'` (already global) catches any bad cross-link in the new content automatically — no new mechanism needed.

## 9. Testing

- Unit tests for `buildAuthoredFrontmatter` (exact output string) and `scanAuthoredMarkdown` (given a temp dir with sample `.md` files, returns correct `id`/`title`; throws on missing title).
- `npm run build` must succeed with the new content present (covers broken links/anchors, MDX syntax).
- Manual/static spot-check: a sample of pattern pages read side-by-side against the template in §4 to confirm structure and that no factual claim is unverifiably specific.
- Content-writing subagents are explicitly instructed: never fetch or reference Educative/DesignGurus lesson content (inaccessible anyway), write from general public CS knowledge only, and only link to the stable public resources listed in §4 item 7.

## 10. Out of scope (this spec)

- Phase 2: API Design section (~40 topics from the DesignGurus API course TOC).
- Phase 3: new case studies (~20, from Educative + both DesignGurus courses).
- Any content sourced from or paraphrasing paywalled lesson text.
- Scored quizzes/assessments (matches the existing site's out-of-scope decision for flashcards).
