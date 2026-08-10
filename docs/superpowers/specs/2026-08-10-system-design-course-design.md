# System Design Course — Design Spec

Date: 2026-08-10
Status: Approved (design phase) — pending implementation plan

## 1. Problem

[donnemartin/system-design-primer](https://github.com/donnemartin/system-design-primer) is the best available system design
learning resource, but it's a single 1839-line `README.md` on GitHub with no progress tracking, no chaptering, and no
way to mark topics/flashcards as done. This makes it hard to follow as a structured course.

## 2. Goal

Replicate 100% of the primer's content (English only) into a self-hosted, progress-trackable course site. Every
concept, case study, and flashcard becomes a trackable unit with a "mark complete" toggle and a dashboard showing
overall progress.

## 3. Source content inventory (from upstream repo, commit inspected 2026-08-10)

License: **CC BY 4.0** (Copyright Donne Martin) — replication permitted with attribution.

| Source | Content | Trackable units |
|---|---|---|
| `README.md` | Motivation, Study guide, Interview approach, Index, ~20 core concept sections (Performance vs scalability, Latency vs throughput, CAP theorem, Consistency patterns, Availability patterns, DNS, CDN, Load balancer, Reverse proxy, Application layer, Database, Cache, Asynchronism, Communication, Security, Appendix) | ~20 concept pages |
| `solutions/system_design/*/README.md` | 8 case studies: Pastebin, Twitter timeline/search, Web crawler, Mint.com, Social graph, Query cache (key-value store), Sales rank, Scaling on AWS | 8 case-study pages |
| `solutions/object_oriented_design/*/README.md` | 6 case studies: Deck of cards, Call center, LRU cache, Hash table, Parking lot, Online chat | 6 case-study pages |
| `resources/flash_cards/*.apkg` | 3 Anki decks (System Design: 42 cards, System Design Exercises: 8 cards, OO Design: 6 cards) — 56 cards total | 3 flashcard decks (56 cards) |
| `images/*` | 36 images referenced throughout | copied as static assets |

Excluded: `README-ja.md`, `README-zh-Hans.md`, `README-zh-TW.md` (translations), `CONTRIBUTING.md`, `TRANSLATIONS.md`.

## 4. Decisions

| Decision | Choice | Why |
|---|---|---|
| Project location | New standalone repo at `~/Desktop/system-design-course`, separate from `catalog` | Personal learning content, unrelated to Garden protocol workspace |
| Framework | Docusaurus (TypeScript template) | Mature docs tool, MDX lets us embed custom React components (progress, flashcards) directly in content, built-in search/sidebar/broken-link checking |
| Progress persistence | Browser `localStorage` only | Simplest — zero backend. Accepted tradeoff: progress is per-browser, not synced across devices |
| Flashcards | Extract all 3 `.apkg` decks into an in-page flip-card UI | Closest thing to real Q&A in the source repo; matches the "questions" requirement |
| Case studies | Full chapters, individually progress-trackable | Matches the "100% replicated" goal |
| Deployment | Local dev (`npm start`) + GitHub Pages via GitHub Actions | Usable immediately, also shareable/accessible from anywhere |

## 5. Architecture

```
system-design-primer (upstream clone, CC BY 4.0)
        │
        ▼  scripts/ingest.ts (run once)
        │
   ┌────┴─────────────────────────────┐
   ▼                                   ▼
docs/**/*.mdx                  src/data/flashcards/*.json
(concepts + case studies,      (56 cards, front/back HTML→
 front-matter injected for      sanitized, grouped by deck)
 sidebar order)
   │                                   │
   ▼                                   ▼
Docusaurus build ──────────────────────┘
   │
   ▼
Browser: courseManifest.ts (static) + localStorage (per-browser progress)
   │
   ▼
Sidebar completion badges + Progress Dashboard, computed client-side
```

Ingestion is one-way (upstream → repo, run once, output is hand-reviewed and committed). Progress is one-way
(browser → localStorage). No sync conflicts to design around.

## 6. Components

- **`scripts/ingest.ts`** (one-time migration tool, not part of the running app):
  1. Splits `README.md`'s `##` sections into individual MDX files under `docs/`, preserving all sub-headings, text,
     and footnote-style reference links verbatim, in original table-of-contents order.
  2. Copies the 14 case-study `README.md` files into `docs/case-studies/`.
  3. Copies all 36 images into Docusaurus static assets and rewrites image paths to match.
  4. Unzips the 3 `.apkg` decks (they're SQLite databases), reads the `notes` table, and converts the 56 front/back
     HTML fields into `src/data/flashcards/*.json`.
  5. Injects Docusaurus front-matter (`id`, `sidebar_position`, `title`) into each generated MDX file.

- **`src/data/courseManifest.ts`** — generated single source of truth: `{id, title, path, category}[]` for every
  trackable unit (concept page, case study, flashcard deck). Drives both sidebar structure and the dashboard so they
  can't drift out of sync.

- **`src/lib/progress.ts`** — React context backed by `localStorage` (versioned key `sdp-progress-v1`), exposing
  `isComplete(id)`, `toggleComplete(id)`, `reviewFlashcard(deckId, cardId)`.

- **`<MarkComplete>`** — injected via a Docusaurus theme swizzle of `DocItem` (applies to every doc page
  automatically; not hand-added to 40+ files individually).

- **`<Flashcard>` / `<FlashcardDeck>`** — flip-card component for the 3 decks, with a "Got it" / "Review again"
  toggle feeding the progress store. These are self-review cards (no scoring), matching what Anki decks actually are.

- **`src/pages/progress.tsx`** — dashboard page: overall % complete, per-category breakdown (Core Concepts / System
  Design Case Studies / OO Design Case Studies / Flashcards), and a jump-list of remaining items. Computed live from
  the manifest + localStorage.

## 7. Error handling

- Ingestion script throws (does not silently skip) on any section/image/card it can't parse — a silent gap would
  defeat the 100%-replication goal. It logs a completion summary (sections/images/cards counted) to compare against
  the known inventory in §3.
- Docusaurus config sets `onBrokenLinks: 'throw'` and `onBrokenAnchors: 'throw'` so any mis-rewritten internal link
  (e.g. `#cap-theorem`-style anchors from the original README) fails the build rather than shipping broken.

## 8. Testing / verification

- `npm run build` must succeed (covers broken links/anchors, MDX syntax errors).
- Manual spot-check: diff a sample of generated MDX pages against the corresponding original README sections to
  confirm verbatim replication.
- Flashcard count check: generated JSON must total 56 cards across 3 decks (42 + 8 + 6), matching §3.
- No unit tests needed — this is a content site, not application logic.

## 9. Attribution

Homepage/footer note required by CC BY 4.0: "Content adapted from
[donnemartin/system-design-primer](https://github.com/donnemartin/system-design-primer), licensed CC BY 4.0."

## 10. Out of scope

- Translations (ja/zh-Hans/zh-TW).
- Cross-device progress sync (explicitly deferred — localStorage only, per decision in §4).
- Scored quizzes / correctness grading on flashcards (source data doesn't support this — it's spaced-repetition
  review material, not graded Q&A).
- Automatically re-running ingestion to pull upstream updates (out of scope for v1; the generated docs are treated
  as the committed source of truth going forward).
