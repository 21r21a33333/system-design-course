# Design Patterns Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 60-page "Design Patterns" section covering patterns and building blocks absent from donnemartin/system-design-primer, each progress-trackable and visibly marked as supplementary (not primer content).

**Architecture:** 60 hand-authored markdown pages under `course/patterns/<group>/*.md` (10 thematic groups), each carrying `supplementary: true` frontmatter. A new scanner (`scripts/authored/scanAuthoredDocs.ts`) is wired into the existing ingestion orchestrator (`run.ts`) so the single generated `courseManifest.ts` includes both primer-sourced and authored entries, distinguished by a `source` field. The already-swizzled `DocItem/Layout` and the dashboard both render a `<SupplementaryBadge/>` wherever `source === 'supplementary'`.

**Tech Stack:** Same as the rest of the site — Docusaurus 3 (TypeScript), `tsx` for scripts, `vitest` for tests. No new dependencies.

## Global Constraints

- Content origin: original writing from general public CS knowledge only. Never fetch, read, or reference Educative or DesignGurus lesson content — only their public course table-of-contents pages were ever consulted, and only to build the topic gap-list in the spec. Writing must not paraphrase or reproduce any paywalled text.
- Every page's frontmatter includes `supplementary: true` (in addition to `title` and `sidebar_position`).
- Every page follows the template in "Content Template" below: definition → problem it solves → how it works → when to use / when not to → real-world example (conservative, factual, never fabricated) → related patterns → further reading (only martinfowler.com, AWS/Azure/GCP architecture centers, Wikipedia, or the primer itself — never Educative or DesignGurus).
- Target length ~400–700 words per page.
- `onBrokenLinks: 'throw'` / `onBrokenAnchors: 'throw'` (already set in `docusaurus.config.ts`) apply to this content too — every cross-link must resolve.
- Doc id for each page is its path relative to `course/` with the extension stripped (e.g. `course/patterns/communication/pub-sub.md` → id `patterns/communication/pub-sub`), matching Docusaurus's own derivation — this is load-bearing for the manifest/badge/dashboard wiring.

## Content Template

Every page (frontmatter aside) has exactly these H2 sections, in this order:

```markdown
One-paragraph definition of the pattern.

## Problem it solves

What goes wrong without this pattern — the concrete pain point.

## How it works

The mechanism, precisely enough to reason about. Use a short text/ASCII
walkthrough where it clarifies more than prose.

## When to use it

Genuine conditions where this is the right call.

## When not to use it

Genuine tradeoffs/costs — not a token afterthought.

## Real-world example

One well-known, publicly-documented real usage. If no specific example is
confidently known, describe typical usage generically instead of guessing
— never fabricate a specific company/product claim.

## Related patterns

- [Pattern Name](/docs/patterns/<group>/<slug>) — one clause on the relationship.

## Further reading

- [Resource title](https://real-url) — only martinfowler.com, an AWS/Azure/GCP
  architecture-center page, Wikipedia, or a page on this site itself.
```

---

### Task 1: Authored-content scanning infrastructure

**Files:**
- Create: `scripts/authored/frontmatter.ts`
- Create: `scripts/authored/scanAuthoredDocs.ts`
- Create: `scripts/authored/scanAuthoredDocs.test.ts`

**Interfaces:**
- Produces: `buildAuthoredFrontmatter(title: string, position: number): string`, `scanAuthoredMarkdown(courseDir: string, subDir: string): { id: string; title: string }[]`. Task 2 consumes both by name.

- [ ] **Step 1: Write `frontmatter.ts`**

```ts
// scripts/authored/frontmatter.ts
export function buildAuthoredFrontmatter(title: string, position: number): string {
  const escaped = title.replace(/"/g, '\\"');
  return `---\ntitle: "${escaped}"\nsidebar_position: ${position}\nsupplementary: true\n---\n\n`;
}
```

- [ ] **Step 2: Write the failing test for `scanAuthoredMarkdown`**

```ts
// scripts/authored/scanAuthoredDocs.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanAuthoredMarkdown } from './scanAuthoredDocs';

describe('scanAuthoredMarkdown', () => {
  let courseDir: string;

  beforeEach(() => {
    courseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdp-authored-'));
  });

  afterEach(() => {
    fs.rmSync(courseDir, { recursive: true, force: true });
  });

  it('returns id (path relative to courseDir, no extension) and title per file', () => {
    const groupDir = path.join(courseDir, 'patterns', 'communication');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'pub-sub.md'),
      '---\ntitle: "Publish-Subscribe"\nsidebar_position: 1\nsupplementary: true\n---\n\nBody.\n',
    );
    const entries = scanAuthoredMarkdown(courseDir, 'patterns');
    expect(entries).toEqual([{ id: 'patterns/communication/pub-sub', title: 'Publish-Subscribe' }]);
  });

  it('recurses through nested group subdirectories and sorts by id', () => {
    fs.mkdirSync(path.join(courseDir, 'patterns', 'b-group'), { recursive: true });
    fs.mkdirSync(path.join(courseDir, 'patterns', 'a-group'), { recursive: true });
    fs.writeFileSync(path.join(courseDir, 'patterns', 'b-group', 'z.md'), '---\ntitle: "Z"\n---\n\nBody.\n');
    fs.writeFileSync(path.join(courseDir, 'patterns', 'a-group', 'y.md'), '---\ntitle: "Y"\n---\n\nBody.\n');
    const entries = scanAuthoredMarkdown(courseDir, 'patterns');
    expect(entries).toEqual([
      { id: 'patterns/a-group/y', title: 'Y' },
      { id: 'patterns/b-group/z', title: 'Z' },
    ]);
  });

  it('ignores non-markdown files like _category_.json', () => {
    const groupDir = path.join(courseDir, 'patterns', 'communication');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, '_category_.json'), '{"label":"Communication","position":1}');
    fs.writeFileSync(path.join(groupDir, 'pub-sub.md'), '---\ntitle: "Publish-Subscribe"\n---\n\nBody.\n');
    const entries = scanAuthoredMarkdown(courseDir, 'patterns');
    expect(entries).toEqual([{ id: 'patterns/communication/pub-sub', title: 'Publish-Subscribe' }]);
  });

  it('throws when a markdown file has no title in its frontmatter', () => {
    const groupDir = path.join(courseDir, 'patterns', 'communication');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'broken.md'), '---\nsidebar_position: 1\n---\n\nBody.\n');
    expect(() => scanAuthoredMarkdown(courseDir, 'patterns')).toThrow(/broken\.md/);
  });

  it('returns an empty array when subDir does not exist yet', () => {
    expect(scanAuthoredMarkdown(courseDir, 'patterns')).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run scripts/authored/scanAuthoredDocs.test.ts`
Expected: FAIL — `scanAuthoredDocs.ts` does not exist yet.

- [ ] **Step 4: Implement `scanAuthoredDocs.ts`**

```ts
// scripts/authored/scanAuthoredDocs.ts
import fs from 'node:fs';
import path from 'node:path';

const TITLE_LINE = /^title:\s*"((?:[^"\\]|\\.)*)"\s*$/m;

function readTitle(filePath: string): string {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const match = TITLE_LINE.exec(raw);
  if (!match) {
    throw new Error(`scanAuthoredMarkdown: no frontmatter title found in ${filePath}`);
  }
  return match[1].replace(/\\"/g, '"');
}

function walk(dir: string, courseDir: string, out: { id: string; title: string }[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, courseDir, out);
      continue;
    }
    if (!entry.name.endsWith('.md')) continue;
    const relativeNoExt = path.relative(courseDir, fullPath).replace(/\.md$/, '').split(path.sep).join('/');
    out.push({ id: relativeNoExt, title: readTitle(fullPath) });
  }
}

export function scanAuthoredMarkdown(courseDir: string, subDir: string): { id: string; title: string }[] {
  const target = path.join(courseDir, subDir);
  if (!fs.existsSync(target)) return [];
  const out: { id: string; title: string }[] = [];
  walk(target, courseDir, out);
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run scripts/authored/scanAuthoredDocs.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add scripts/authored/frontmatter.ts scripts/authored/scanAuthoredDocs.ts scripts/authored/scanAuthoredDocs.test.ts
git commit -m "feat(authored): frontmatter builder and doc scanner for supplementary content"
```

---

### Task 2: Manifest wiring for supplementary content

**Files:**
- Modify: `scripts/ingest/manifest.ts`
- Modify: `scripts/ingest/run.ts`

**Interfaces:**
- Consumes: `scanAuthoredMarkdown` from Task 1.
- Produces: `ManifestCategory` now includes `'design-patterns'`; `ManifestEntry` gains optional `source?: 'primer' | 'supplementary'`. Task 3 (badge wiring) and later content tasks rely on `source === 'supplementary'` as the badge trigger, and on the `'design-patterns'` category for dashboard grouping.

- [ ] **Step 1: Extend `ManifestCategory` and `ManifestEntry`**

In `scripts/ingest/manifest.ts`, change:

```ts
export type ManifestCategory = 'concepts' | 'system-design-case-studies' | 'oo-case-studies' | 'flashcards';

export interface ManifestEntry {
  id: string;
  title: string;
  path: string;
  category: ManifestCategory;
}
```

to:

```ts
export type ManifestCategory =
  | 'concepts'
  | 'system-design-case-studies'
  | 'oo-case-studies'
  | 'flashcards'
  | 'design-patterns';

export interface ManifestEntry {
  id: string;
  title: string;
  path: string;
  category: ManifestCategory;
  source?: 'primer' | 'supplementary';
}
```

Do not touch `buildManifest`'s body, signature, or `manifest.test.ts` — this is a pure additive type change; `source` is optional so every existing test's expected object (which has no `source` key) still satisfies the type and `toEqual` comparison.

- [ ] **Step 2: Verify existing manifest tests still pass unmodified**

Run: `npx vitest run scripts/ingest/manifest.test.ts`
Expected: PASS (2 tests, unchanged from before this task)

- [ ] **Step 3: Wire scanning into `run.ts`**

In `scripts/ingest/run.ts`, add the import:

```ts
import { scanAuthoredMarkdown } from '../authored/scanAuthoredDocs';
```

Immediately after the existing block that builds `manifest` and before `manifest.push({ id: 'intro', ... })` (or after — order doesn't matter, both are appends), replace:

```ts
  const manifest = buildManifest(
    CONCEPT_SECTIONS.map((s) => ({ slug: s.slug, title: s.title })),
    SYSTEM_DESIGN_CASE_STUDIES.map((s) => ({ slug: s.slug, title: s.title })),
    OOD_CASE_STUDIES.map((s) => ({ slug: s.slug, title: s.title })),
    FLASHCARD_DECKS.map((d) => ({ deckId: d.deckId, title: d.title })),
  );
```

with:

```ts
  const manifest = buildManifest(
    CONCEPT_SECTIONS.map((s) => ({ slug: s.slug, title: s.title })),
    SYSTEM_DESIGN_CASE_STUDIES.map((s) => ({ slug: s.slug, title: s.title })),
    OOD_CASE_STUDIES.map((s) => ({ slug: s.slug, title: s.title })),
    FLASHCARD_DECKS.map((d) => ({ deckId: d.deckId, title: d.title })),
  ).map((entry) => ({ ...entry, source: 'primer' as const }));

  const patternEntries = scanAuthoredMarkdown(path.join(REPO_ROOT, 'course'), 'patterns').map((p) => ({
    id: p.id,
    title: p.title,
    path: `/docs/${p.id}`,
    category: 'design-patterns' as const,
    source: 'supplementary' as const,
  }));
  manifest.push(...patternEntries);
```

Keep the following `manifest.push({ id: 'intro', ... })` line exactly as-is (it should now also get `source: 'primer'` — update it to `manifest.push({ id: 'intro', title: 'Motivation', path: '/docs/intro', category: 'concepts', source: 'primer' })`).

- [ ] **Step 4: Verify ingestion still runs cleanly with zero pattern content**

Run: `npm run ingest -- /tmp/system-design-primer-src` (re-clone per the README if that path is missing)
Expected: succeeds exactly as before (prints the same `{ concepts: 19, sdCaseStudies: 8, oodCaseStudies: 6, flashcards: 56, images: 36 }` summary) — `course/patterns/` doesn't exist yet, so `scanAuthoredMarkdown` returns `[]` and `patternEntries` is empty. Confirm `src/data/courseManifest.ts` has no `'design-patterns'` entries yet and every existing entry now has `"source": "primer"`.

- [ ] **Step 5: Run full test suite and typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: all tests pass, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add scripts/ingest/manifest.ts scripts/ingest/run.ts src/data/courseManifest.ts
git commit -m "feat(ingest): scan and index supplementary authored content in the manifest"
```

---

### Task 3: Supplementary badge component and wiring

**Files:**
- Create: `src/components/SupplementaryBadge/index.tsx`
- Create: `src/components/SupplementaryBadge/styles.module.css`
- Modify: `src/theme/DocItem/Layout/index.tsx`
- Modify: `src/pages/progress.tsx`

**Interfaces:**
- Produces: `<SupplementaryBadge />` — a no-props presentational component, reusable both as a full-width banner and as an inline pill (CSS handles both via the parent's `display` context).

- [ ] **Step 1: Write `SupplementaryBadge`**

```tsx
// src/components/SupplementaryBadge/index.tsx
import React from 'react';
import styles from './styles.module.css';

export default function SupplementaryBadge(): React.JSX.Element {
  return <span className={styles.badge}>Supplementary — not from the original primer</span>;
}
```

```css
/* src/components/SupplementaryBadge/styles.module.css */
.badge {
  display: inline-block;
  padding: 0.2rem 0.6rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  background: var(--ifm-color-warning-contrast-background);
  color: var(--ifm-color-warning-contrast-foreground);
  border: 1px solid var(--ifm-color-warning);
  margin-bottom: 0.75rem;
}
```

- [ ] **Step 2: Wire into the swizzled `DocItem/Layout`**

Read `src/theme/DocItem/Layout/index.tsx` first (it currently renders `<MarkComplete />` inside a `<BrowserOnly>`, per Task 8 of the original plan). Add the import `import SupplementaryBadge from '@site/src/components/SupplementaryBadge';`, then read `useDoc().metadata.frontMatter.supplementary` inside the existing component (it already imports `useDoc` for `MarkComplete`, but `MarkComplete` reads it internally — `LayoutWrapper` itself does not currently call `useDoc()`; add that call at the top of `LayoutWrapper`, before the returned JSX):

```tsx
import { useDoc } from '@docusaurus/plugin-content-docs/client';
```

(same import path Task 8 already corrected `MarkComplete` to use — reuse it here for consistency, not the plan's original wrong path).

Inside `LayoutWrapper`, before the `return`:

```tsx
const { metadata } = useDoc();
const isSupplementary = metadata.frontMatter.supplementary === true;
```

Update the returned JSX so the badge renders inside the same `<BrowserOnly>` block, above `<MarkComplete />`:

```tsx
return (
  <>
    <BrowserOnly>
      {() => (
        <>
          {isSupplementary && <SupplementaryBadge />}
          <MarkComplete />
        </>
      )}
    </BrowserOnly>
    <Layout {...props} />
  </>
);
```

- [ ] **Step 3: Wire into the dashboard**

In `src/pages/progress.tsx`, add the import `import SupplementaryBadge from '@site/src/components/SupplementaryBadge';` and add `'design-patterns': 'Design Patterns'` to `CATEGORY_LABELS`, plus `'design-patterns'` to `CATEGORY_ORDER` (after `'oo-case-studies'`, before `'flashcards'`).

In the non-flashcard list-item branch, render the badge next to supplementary entries:

```tsx
return (
  <li key={entry.id}>
    <Link to={entry.path}>{entry.title}</Link> {isComplete(entry.id) ? '✅' : ''}{' '}
    {entry.source === 'supplementary' && <SupplementaryBadge />}
  </li>
);
```

- [ ] **Step 4: Verify build**

Run: `npm run typecheck && npx vitest run && npm run build`
Expected: all clean. The "Design Patterns" category will render empty in the sidebar/dashboard until Task 4 adds content — that's expected at this point.

- [ ] **Step 5: Commit**

```bash
git add src/components/SupplementaryBadge src/theme/DocItem/Layout/index.tsx src/pages/progress.tsx
git commit -m "feat(patterns): supplementary badge component, wired into doc pages and dashboard"
```

---

### Task 4: Communication Patterns (5 pages)

**Files:**
- Create: `course/patterns/_category_.json`
- Create: `course/patterns/communication/_category_.json`
- Create: `course/patterns/communication/pub-sub.md`
- Create: `course/patterns/communication/event-driven-architecture.md`
- Create: `course/patterns/communication/webhooks.md`
- Create: `course/patterns/communication/server-sent-events.md`
- Create: `course/patterns/communication/websockets.md`

**Interfaces:** None — pure content. Follows the "Content Template" and Global Constraints at the top of this plan.

- [ ] **Step 1: Category files**

```json
// course/patterns/_category_.json
{ "label": "Design Patterns", "position": 4 }
```

```json
// course/patterns/communication/_category_.json
{ "label": "Communication", "position": 1 }
```

- [ ] **Step 2: Write `pub-sub.md`** — this is the fully worked model page; match its structure exactly for every other page in this plan.

```markdown
---
title: "Publish-Subscribe"
sidebar_position: 1
supplementary: true
---

Publish-Subscribe (pub-sub) decouples senders (publishers) from receivers
(subscribers) through an intermediary — a message broker or topic — so
publishers never know who, or how many, consumers exist.

## Problem it solves

In a direct request-response or point-to-point queue setup, adding a new
consumer of an event means changing the producer's code to notify it. As
a system grows, this couples services that should be independent: the
order-service shouldn't need to know that both the email-service and the
analytics-service care about "order placed" events.

## How it works

Publishers write messages to a named topic. The broker maintains zero or
more subscriptions on that topic; each subscriber receives its own copy
of every message published after it subscribed. Publishers and
subscribers never call each other directly — both only talk to the
broker. Most brokers support either fan-out (every subscriber gets every
message) or filtered delivery (subscribers register interest in a subset
via a filter/pattern).

## When to use it

- Multiple independent consumers need to react to the same event, and the
  set of consumers changes over time.
- Producers and consumers should be deployable independently, without
  coordinated releases.
- You want to add a new consumer without touching the producer at all.

## When not to use it

- The producer needs a response back from the consumer (pub-sub is
  fire-and-forget by design — use request-response instead).
- Strict ordering across all consumers matters and the broker doesn't
  guarantee it (many pub-sub systems only guarantee order per-partition,
  not globally).
- A single, tightly-coupled consumer is the only one that will ever exist
  — a direct call or a simple queue is simpler and has fewer moving parts.

## Real-world example

Google Cloud Pub/Sub and AWS SNS are managed pub-sub services widely used
to fan out a single event (e.g. a file upload) to multiple independent
downstream processors (thumbnailing, virus scanning, indexing) without
those processors knowing about each other.

## Related patterns

- [Event-Driven Architecture](/docs/patterns/communication/event-driven-architecture) — pub-sub is the most common transport for it.
- [Dead Letter Queue](/docs/patterns/reliability/dead-letter-queue) — where undeliverable pub-sub messages typically end up.
- [Asynchronism](/docs/concepts/asynchronism) — the primer's broader treatment of message/task queues.

## Further reading

- [Publish-subscribe pattern — Wikipedia](https://en.wikipedia.org/wiki/Publish%E2%80%93subscribe_pattern)
- [Google Cloud Pub/Sub overview](https://cloud.google.com/pubsub/docs/overview)
```

- [ ] **Step 3: Write the remaining 4 pages to the same template and rigor.** Coverage requirements per page:

**`event-driven-architecture.md`** (position 2): Define event-driven architecture as a style where services react to state-change events rather than being invoked directly; cover event producers/consumers/event bus, choreography vs. orchestration tradeoff, eventual consistency as a consequence. Real-world example: e-commerce order pipelines reacting to an "OrderPlaced" event. Related: link to `pub-sub.md` and `/docs/patterns/consistency/saga`.

**`webhooks.md`** (position 3): Define webhooks as HTTP callbacks — the consumer registers a URL, the producer POSTs to it when an event occurs. Cover retry-on-failure expectations, signature verification for security (HMAC), and the inversion of control vs. polling. Real-world example: Stripe or GitHub webhook delivery. Related: link to `pub-sub.md`, and to `/docs/patterns/reliability/retry-with-backoff`.

**`server-sent-events.md`** (position 4): Define SSE as a one-way, HTTP-native streaming protocol from server to browser client, built on a long-lived connection with automatic client-side reconnect. Contrast with WebSockets (bidirectional) and polling (request overhead). Real-world example: live sports scores or stock ticker updates. Related: link to `websockets.md`.

**`websockets.md`** (position 5): Define WebSockets as a full-duplex, persistent connection upgraded from HTTP. Cover the handshake, when bidirectional push is actually needed vs. SSE, and the operational cost (holding many long-lived connections open, need for sticky sessions or a pub-sub backplane across server instances). Real-world example: chat applications, collaborative editors. Related: link to `server-sent-events.md`, and to the primer's [Online Chat](/docs/case-studies/object-oriented-design/online-chat) case study.

- [ ] **Step 4: Verify the site builds with the new section**

Run: `npm run ingest -- /tmp/system-design-primer-src && npm run build`
Expected: succeeds. `src/data/courseManifest.ts` now has 5 entries with `category: "design-patterns"` and `source: "supplementary"`. Sidebar shows a new "Design Patterns" top-level item containing "Communication" with 5 pages.

- [ ] **Step 5: Manually verify the badge renders**

Run: `npm run build && npm run serve`, open `/docs/patterns/communication/pub-sub`, confirm the "Supplementary — not from the original primer" badge appears above the "Mark as complete" button (or check via the same static-verification approach used in Tasks 8-11 of the original plan if no live browser is available — grep the built HTML/JS bundle for the badge's exact text).

- [ ] **Step 6: Commit**

```bash
git add course/patterns
git commit -m "feat(patterns): add Communication Patterns group (5 pages)"
```

---

### Task 5: Storage & Replication Patterns (5 pages)

**Files:**
- Create: `course/patterns/storage/_category_.json`
- Create: `course/patterns/storage/sharding.md`
- Create: `course/patterns/storage/consistent-hashing.md`
- Create: `course/patterns/storage/write-ahead-log.md`
- Create: `course/patterns/storage/event-sourcing.md`
- Create: `course/patterns/storage/cqrs.md`

**Interfaces:** None — pure content, same template as Task 4.

- [ ] **Step 1: Category file**

```json
// course/patterns/storage/_category_.json
{ "label": "Storage & Replication", "position": 2 }
```

- [ ] **Step 2: Write all 5 pages to the Content Template.** Coverage requirements per page:

**`sharding.md`** (position 1): Define horizontal partitioning of data across multiple database instances by a shard key. Cover shard-key selection (avoiding hot shards), the rebalancing problem when adding/removing shards, and cross-shard query/transaction cost. Real-world example: Instagram's user-id-based Postgres sharding. Related: link to `consistent-hashing.md` and the primer's [Database](/docs/concepts/database) page.

**`consistent-hashing.md`** (position 2): Define the hash-ring technique that minimizes redistributed keys when nodes are added/removed, vs. naive `hash(key) % N`. Cover virtual nodes for load balance. Real-world example: DynamoDB's and Cassandra's partitioning scheme. Related: link to `sharding.md` and `/docs/patterns/building-blocks/distributed-cache`.

**`write-ahead-log.md`** (position 3): Define WAL as appending every mutation to a durable, sequential log before applying it to the actual data structure, enabling crash recovery and replication. Cover the durability/performance tradeoff (sequential writes are fast) and how replicas can replay the log. Real-world example: PostgreSQL's WAL, Kafka's own log-structured storage. Related: link to `event-sourcing.md`.

**`event-sourcing.md`** (position 4): Define storing state as an append-only sequence of events rather than current-state rows, with current state derived by replaying events. Cover the audit-trail benefit, replay/rebuild capability, and the cost (query complexity, snapshotting need for long histories). Real-world example: banking ledger systems. Related: link to `write-ahead-log.md` and `cqrs.md`.

**`cqrs.md`** (position 5): Define Command Query Responsibility Segregation — separate models (and often separate stores) for writes (commands) vs. reads (queries). Cover why this pairs naturally with event sourcing, and the eventual-consistency cost between the write and read models. Real-world example: e-commerce systems with a normalized write store and a denormalized read-optimized search index. Related: link to `event-sourcing.md` and `/docs/patterns/consistency/saga`.

- [ ] **Step 3: Verify build**

Run: `npm run ingest -- /tmp/system-design-primer-src && npm run build`
Expected: succeeds, manifest now has 10 `design-patterns` entries total (5 from Task 4 + 5 from this task).

- [ ] **Step 4: Commit**

```bash
git add course/patterns/storage
git commit -m "feat(patterns): add Storage & Replication Patterns group (5 pages)"
```

---

### Task 6: Reliability Patterns (7 pages)

**Files:**
- Create: `course/patterns/reliability/_category_.json`
- Create: `course/patterns/reliability/timeout.md`
- Create: `course/patterns/reliability/retry-with-backoff.md`
- Create: `course/patterns/reliability/idempotency.md`
- Create: `course/patterns/reliability/circuit-breaker.md`
- Create: `course/patterns/reliability/bulkhead.md`
- Create: `course/patterns/reliability/dead-letter-queue.md`
- Create: `course/patterns/reliability/graceful-degradation.md`

**Interfaces:** None — pure content, same template as Task 4.

- [ ] **Step 1: Category file**

```json
// course/patterns/reliability/_category_.json
{ "label": "Reliability", "position": 3 }
```

- [ ] **Step 2: Write all 7 pages to the Content Template.** Coverage requirements per page:

**`timeout.md`** (position 1): Define bounding how long a caller waits for a dependency before giving up. Cover the cost of no timeout (thread/connection exhaustion cascading upstream) and how to pick a value (based on the dependency's own SLA, not a guess). Real-world example: HTTP client default timeouts. Related: link to `retry-with-backoff.md` and `circuit-breaker.md`.

**`retry-with-backoff.md`** (position 2): Define retrying a failed call with exponentially increasing delay (plus jitter) instead of immediately or at a fixed interval. Cover why naive immediate retry amplifies load on an already-struggling dependency (retry storms), and that only idempotent operations are safe to retry. Real-world example: AWS SDKs' built-in retry policies. Related: link to `timeout.md` and `idempotency.md`.

**`idempotency.md`** (position 3): Define an operation that produces the same result no matter how many times it's applied. Cover idempotency keys (client-generated unique ID the server deduplicates on) as the mechanism for making non-idempotent operations (like "charge card") safely retryable. Real-world example: Stripe's `Idempotency-Key` header. Related: link to `retry-with-backoff.md`.

**`circuit-breaker.md`** (position 4): Define the pattern that stops calling a failing dependency after a failure threshold, failing fast instead, then periodically probing to see if it's recovered (open/half-open/closed states). Cover why this protects the CALLER (not just the callee) from wasting resources on calls likely to fail. Real-world example: Netflix's Hystrix library, which popularized the pattern. Related: link to `timeout.md` and `bulkhead.md`.

**`bulkhead.md`** (position 5): Define isolating resources (thread pools, connection pools) per dependency so one failing dependency can't exhaust resources needed by others — named after ship hull compartments. Real-world example: separate thread pools per downstream service call in Hystrix-style implementations. Related: link to `circuit-breaker.md`.

**`dead-letter-queue.md`** (position 6): Define a separate queue where messages that repeatedly fail processing are routed instead of blocking or being silently dropped, so they can be inspected/replayed later. Cover the "poison message" problem it solves. Real-world example: AWS SQS's built-in DLQ redrive policy. Related: link to `/docs/patterns/communication/pub-sub` and `retry-with-backoff.md`.

**`graceful-degradation.md`** (position 7): Define serving a reduced but still-useful experience when a non-critical dependency fails, instead of failing the whole request. Cover distinguishing critical vs. non-critical dependencies up front. Real-world example: an e-commerce product page still rendering without personalized recommendations if the recommendation service is down. Related: link to `circuit-breaker.md`.

- [ ] **Step 3: Verify build**

Run: `npm run ingest -- /tmp/system-design-primer-src && npm run build`
Expected: succeeds, manifest now has 17 `design-patterns` entries total.

- [ ] **Step 4: Commit**

```bash
git add course/patterns/reliability
git commit -m "feat(patterns): add Reliability Patterns group (7 pages)"
```

---

### Task 7: Scaling Patterns (4 pages)

**Files:**
- Create: `course/patterns/scaling/_category_.json`
- Create: `course/patterns/scaling/vertical-scaling.md`
- Create: `course/patterns/scaling/horizontal-scaling.md`
- Create: `course/patterns/scaling/auto-scaling.md`
- Create: `course/patterns/scaling/connection-pooling.md`

**Interfaces:** None — pure content, same template as Task 4.

- [ ] **Step 1: Category file**

```json
// course/patterns/scaling/_category_.json
{ "label": "Scaling", "position": 4 }
```

- [ ] **Step 2: Write all 4 pages to the Content Template.** Coverage requirements per page:

**`vertical-scaling.md`** (position 1): Define adding more resources (CPU/RAM) to a single existing machine. Cover the hard ceiling (a single machine's max spec) and the single-point-of-failure risk. Real-world example: bumping an RDS instance to a larger instance class. Related: link to `horizontal-scaling.md`.

**`horizontal-scaling.md`** (position 2): Define adding more machines instead of bigger ones, requiring statelessness or partitioning to spread load. Cover why it has no theoretical ceiling but adds coordination complexity. Real-world example: a stateless web-server fleet behind a load balancer. Related: link to `vertical-scaling.md`, primer's [Load Balancer](/docs/concepts/load-balancer), and `/docs/patterns/storage/sharding`.

**`auto-scaling.md`** (position 3): Define automatically adjusting the number of running instances based on a metric (CPU, queue depth, request rate) against defined thresholds. Cover the tradeoff between reactive (metric-threshold) and predictive scaling, and the cold-start latency cost of scaling up too slowly. Real-world example: AWS EC2 Auto Scaling Groups / Kubernetes Horizontal Pod Autoscaler. Related: link to `horizontal-scaling.md`.

**`connection-pooling.md`** (position 4): Define reusing a fixed set of already-open database connections instead of opening a new one per request, since connection setup (TCP handshake, auth) is expensive relative to a query. Cover pool-size sizing (too small starves callers, too large exhausts the database's own connection limit). Real-world example: PgBouncer in front of PostgreSQL. Related: link to primer's [Database](/docs/concepts/database).

- [ ] **Step 3: Verify build**

Run: `npm run ingest -- /tmp/system-design-primer-src && npm run build`
Expected: succeeds, manifest now has 21 `design-patterns` entries total.

- [ ] **Step 4: Commit**

```bash
git add course/patterns/scaling
git commit -m "feat(patterns): add Scaling Patterns group (4 pages)"
```

---

### Task 8: Distributed Consistency Patterns (4 pages)

**Files:**
- Create: `course/patterns/consistency/_category_.json`
- Create: `course/patterns/consistency/two-phase-commit.md`
- Create: `course/patterns/consistency/saga.md`
- Create: `course/patterns/consistency/quorum.md`
- Create: `course/patterns/consistency/vector-clocks.md`

**Interfaces:** None — pure content, same template as Task 4.

- [ ] **Step 1: Category file**

```json
// course/patterns/consistency/_category_.json
{ "label": "Distributed Consistency", "position": 5 }
```

- [ ] **Step 2: Write all 4 pages to the Content Template.** Coverage requirements per page:

**`two-phase-commit.md`** (position 1): Define the coordinator-driven protocol (prepare phase, then commit/abort phase) for atomic commits across multiple independent databases/services. Cover its major weakness: the coordinator is a blocking single point of failure — if it crashes after "prepare" succeeds everywhere, participants hold locks indefinitely. Related: link to `saga.md` as the alternative for long-running distributed transactions.

**`saga.md`** (position 2): Define a sequence of local transactions, each with a defined compensating action to undo it, used instead of a single distributed transaction. Cover choreography (each step reacts to the previous step's event) vs. orchestration (a central coordinator sequences the steps). Real-world example: an order-checkout saga (reserve inventory → charge payment → ship; compensate by releasing inventory and refunding on failure). Related: link to `two-phase-commit.md` and `/docs/patterns/communication/event-driven-architecture`.

**`quorum.md`** (position 3): Define requiring a minimum number of nodes (W for writes, R for reads, with W+R > N) to acknowledge an operation before it's considered successful, so reads and writes always overlap on at least one up-to-date node. Real-world example: DynamoDB's and Cassandra's tunable consistency via quorum reads/writes. Related: link to primer's [Consistency Patterns](/docs/concepts/consistency-patterns).

**`vector-clocks.md`** (position 4): Define a mechanism (a per-node counter vector) for tracking causal ordering of events across distributed nodes without relying on synchronized wall-clock time, and for detecting concurrent (conflicting) updates. Real-world example: used historically in Amazon Dynamo for conflict detection. Related: link to `quorum.md`.

- [ ] **Step 3: Verify build**

Run: `npm run ingest -- /tmp/system-design-primer-src && npm run build`
Expected: succeeds, manifest now has 25 `design-patterns` entries total.

- [ ] **Step 4: Commit**

```bash
git add course/patterns/consistency
git commit -m "feat(patterns): add Distributed Consistency Patterns group (4 pages)"
```

---

### Task 9: API & Edge Patterns (5 pages)

**Files:**
- Create: `course/patterns/api-edge/_category_.json`
- Create: `course/patterns/api-edge/api-gateway.md`
- Create: `course/patterns/api-edge/backend-for-frontend.md`
- Create: `course/patterns/api-edge/sidecar.md`
- Create: `course/patterns/api-edge/service-mesh.md`
- Create: `course/patterns/api-edge/cursor-pagination.md`

**Interfaces:** None — pure content, same template as Task 4.

- [ ] **Step 1: Category file**

```json
// course/patterns/api-edge/_category_.json
{ "label": "API & Edge", "position": 6 }
```

- [ ] **Step 2: Write all 5 pages to the Content Template.** Coverage requirements per page:

**`api-gateway.md`** (position 1): Define a single entry point in front of a set of backend services, handling cross-cutting concerns (auth, rate limiting, routing, request/response transformation) so individual services don't each reimplement them. Cover the risk of it becoming a monolithic bottleneck if too much business logic accretes into it. Real-world example: Amazon API Gateway, Kong. Related: link to primer's [Reverse Proxy](/docs/concepts/reverse-proxy) and to `backend-for-frontend.md`.

**`backend-for-frontend.md`** (position 2): Define a dedicated backend layer per client type (web, mobile, third-party) that shapes/aggregates calls to backend services specifically for that client's needs, instead of one generic API serving all clients. Cover why this avoids over-fetching/under-fetching for different client capabilities. Real-world example: Netflix's BFF pattern for different device types. Related: link to `api-gateway.md`.

**`sidecar.md`** (position 3): Define deploying a helper process alongside a main application process (same host/pod) to handle cross-cutting concerns (networking, logging, config) without the main app needing that logic in-process. Real-world example: Envoy proxy deployed as a sidecar in Istio. Related: link to `service-mesh.md`.

**`service-mesh.md`** (position 4): Define a dedicated infrastructure layer (a fleet of sidecar proxies plus a control plane) handling service-to-service communication concerns — retries, mTLS, traffic shaping, observability — transparently to application code. Cover the operational-complexity cost of adopting one. Real-world example: Istio, Linkerd. Related: link to `sidecar.md`.

**`cursor-pagination.md`** (position 5): Define paginating by an opaque cursor (pointing at "the item after this one") instead of an offset/limit. Cover why offset pagination breaks under concurrent inserts/deletes (skipped or duplicated rows) and performs poorly at high offsets, while cursor pagination avoids both. Real-world example: most modern REST/GraphQL APIs (Stripe, GitHub) use cursor-based pagination for list endpoints. Related: link to primer's [Database](/docs/concepts/database).

- [ ] **Step 3: Verify build**

Run: `npm run ingest -- /tmp/system-design-primer-src && npm run build`
Expected: succeeds, manifest now has 30 `design-patterns` entries total.

- [ ] **Step 4: Commit**

```bash
git add course/patterns/api-edge
git commit -m "feat(patterns): add API & Edge Patterns group (5 pages)"
```

---

### Task 10: Observability & Delivery Patterns (5 pages)

**Files:**
- Create: `course/patterns/observability/_category_.json`
- Create: `course/patterns/observability/health-check.md`
- Create: `course/patterns/observability/distributed-tracing.md`
- Create: `course/patterns/observability/blue-green-deployment.md`
- Create: `course/patterns/observability/canary-deployment.md`
- Create: `course/patterns/observability/feature-flags.md`

**Interfaces:** None — pure content, same template as Task 4.

- [ ] **Step 1: Category file**

```json
// course/patterns/observability/_category_.json
{ "label": "Observability & Delivery", "position": 7 }
```

- [ ] **Step 2: Write all 5 pages to the Content Template.** Coverage requirements per page:

**`health-check.md`** (position 1): Define an endpoint a service exposes (e.g. `/health`) that load balancers/orchestrators poll to decide whether to route traffic to that instance. Cover the distinction between liveness (is the process running) and readiness (is it ready to serve traffic, e.g. has it warmed its cache/finished startup) checks. Real-world example: Kubernetes liveness/readiness probes. Related: link to primer's [Load Balancer](/docs/concepts/load-balancer).

**`distributed-tracing.md`** (position 2): Define propagating a trace ID across every service a single request touches, so the full request path and per-hop latency can be reconstructed. Cover why this matters more as service count grows (a single slow request might span a dozen services). Real-world example: Jaeger, Zipkin, OpenTelemetry. Related: link to `health-check.md`.

**`blue-green-deployment.md`** (position 3): Define running two identical production environments (blue = current, green = new), routing all traffic to blue, deploying to green, then switching traffic atomically once green is verified — enabling instant rollback by switching back. Cover the cost: running double the infrastructure during the switch. Related: link to `canary-deployment.md`.

**`canary-deployment.md`** (position 4): Define rolling out a new version to a small percentage of traffic/instances first, monitoring error rates/latency, then gradually increasing the percentage — vs. blue-green's all-at-once switch. Cover why it catches issues with real production traffic before full rollout, at the cost of running two versions simultaneously for longer. Related: link to `blue-green-deployment.md`.

**`feature-flags.md`** (position 5): Define decoupling code deployment from feature release by gating new code behind a runtime-toggleable flag, so a feature can ship dark and be enabled per-user/percentage/environment without a new deploy. Cover the tech-debt cost of accumulating stale flags if not cleaned up. Related: link to `canary-deployment.md`.

- [ ] **Step 3: Verify build**

Run: `npm run ingest -- /tmp/system-design-primer-src && npm run build`
Expected: succeeds, manifest now has 35 `design-patterns` entries total.

- [ ] **Step 4: Commit**

```bash
git add course/patterns/observability
git commit -m "feat(patterns): add Observability & Delivery Patterns group (5 pages)"
```

---

### Task 11: Batch & Streaming Patterns (7 pages)

**Files:**
- Create: `course/patterns/batch-streaming/_category_.json`
- Create: `course/patterns/batch-streaming/mapreduce.md`
- Create: `course/patterns/batch-streaming/stream-processing.md`
- Create: `course/patterns/batch-streaming/lambda-kappa-architecture.md`
- Create: `course/patterns/batch-streaming/change-data-capture.md`
- Create: `course/patterns/batch-streaming/exactly-once-semantics.md`
- Create: `course/patterns/batch-streaming/backpressure.md`
- Create: `course/patterns/batch-streaming/partitioned-consumption.md`

**Interfaces:** None — pure content, same template as Task 4.

- [ ] **Step 1: Category file**

```json
// course/patterns/batch-streaming/_category_.json
{ "label": "Batch & Streaming", "position": 8 }
```

- [ ] **Step 2: Write all 7 pages to the Content Template.** Coverage requirements per page:

**`mapreduce.md`** (position 1): Define the programming model splitting a large batch job into a map phase (transform records independently, parallelizable) and a reduce phase (aggregate by key). Cover why it fits embarrassingly-parallel batch workloads over huge datasets but has high per-job latency (not suited to real-time). Real-world example: Hadoop MapReduce, the original Google paper's word-count example. Related: link to `stream-processing.md`.

**`stream-processing.md`** (position 2): Define processing records continuously as they arrive rather than in scheduled batches, typically with windowing (tumbling/sliding) for aggregation. Cover the lower latency vs. batch's higher throughput/simplicity tradeoff. Real-world example: Apache Flink, Kafka Streams. Related: link to `mapreduce.md` and `lambda-kappa-architecture.md`.

**`lambda-kappa-architecture.md`** (position 3): Define Lambda architecture (parallel batch layer for accuracy + speed layer for low-latency approximate results, merged at query time) and Kappa architecture (stream-only, treating batch as just re-processing the stream from the start) as two approaches to combining batch and real-time processing. Cover why Kappa emerged to avoid maintaining two separate codebases for the same logic. Related: link to `mapreduce.md` and `stream-processing.md`.

**`change-data-capture.md`** (position 4): Define capturing row-level insert/update/delete events from a database's own transaction/write-ahead log and streaming them out, instead of polling for changes. Cover why this avoids the load and staleness of polling. Real-world example: Debezium reading MySQL/Postgres binlogs into Kafka. Related: link to `/docs/patterns/storage/write-ahead-log` and `stream-processing.md`.

**`exactly-once-semantics.md`** (position 5): Define the guarantee that each message is processed exactly once, distinguishing it from the weaker (and easier to provide) at-least-once and at-most-once. Cover how it's typically achieved in practice — idempotent processing plus deduplication, or transactional writes coupled with offset commits, rather than true magic. Related: link to `/docs/patterns/reliability/idempotency` and `partitioned-consumption.md`.

**`backpressure.md`** (position 6): This expands on the primer's brief mention in [Asynchronism](/docs/concepts/asynchronism) — do not repeat that paragraph verbatim; add depth. Define backpressure as a mechanism for a slow consumer to signal a fast producer to slow down, preventing unbounded queue growth and out-of-memory failures. Cover the three common strategies: buffering with a bound, dropping messages, and blocking the producer. Real-world example: TCP's own flow control window; reactive streams libraries (Project Reactor, RxJava) implementing it explicitly. Related: link back to the primer's [Asynchronism](/docs/concepts/asynchronism) page and to `/docs/patterns/communication/pub-sub`.

**`partitioned-consumption.md`** (position 7): Define splitting a stream/topic into partitions, each consumed by exactly one consumer within a consumer group at a time, enabling horizontal scaling of consumption while preserving per-partition order. Real-world example: Kafka's partition/consumer-group model. Related: link to `exactly-once-semantics.md` and `/docs/patterns/storage/consistent-hashing`.

- [ ] **Step 3: Verify build**

Run: `npm run ingest -- /tmp/system-design-primer-src && npm run build`
Expected: succeeds, manifest now has 42 `design-patterns` entries total.

- [ ] **Step 4: Commit**

```bash
git add course/patterns/batch-streaming
git commit -m "feat(patterns): add Batch & Streaming Patterns group (7 pages)"
```

---

### Task 12: AI-Era Infrastructure Patterns (7 pages)

**Files:**
- Create: `course/patterns/ai-infra/_category_.json`
- Create: `course/patterns/ai-infra/feature-store.md`
- Create: `course/patterns/ai-infra/model-serving.md`
- Create: `course/patterns/ai-infra/gpu-auto-scaling.md`
- Create: `course/patterns/ai-infra/llm-gateway.md`
- Create: `course/patterns/ai-infra/semantic-caching.md`
- Create: `course/patterns/ai-infra/vector-database-sharding.md`
- Create: `course/patterns/ai-infra/rag-pipeline.md`

**Interfaces:** None — pure content, same template as Task 4.

- [ ] **Step 1: Category file**

```json
// course/patterns/ai-infra/_category_.json
{ "label": "AI-Era Infrastructure", "position": 9 }
```

- [ ] **Step 2: Write all 7 pages to the Content Template.** Coverage requirements per page:

**`feature-store.md`** (position 1): Define a centralized system for storing, versioning, and serving ML features consistently between training (batch, historical) and inference (low-latency, online), avoiding training/serving skew from duplicated feature logic. Real-world example: Feast, Uber's Michelangelo Feature Store. Related: link to `model-serving.md`.

**`model-serving.md`** (position 2): Define the infrastructure layer that loads a trained model and exposes it via a low-latency prediction API, handling batching of concurrent requests, model versioning, and canary rollout of new model versions. Real-world example: TensorFlow Serving, Triton Inference Server. Related: link to `feature-store.md` and `/docs/patterns/observability/canary-deployment`.

**`gpu-auto-scaling.md`** (position 3): Define auto-scaling specifically for GPU-backed inference/training workloads. Cover why it differs from CPU auto-scaling: GPU instances are expensive and slower to provision, so scaling decisions weigh cold-start cost and often keep a warm minimum pool rather than scaling to zero. Related: link to `/docs/patterns/scaling/auto-scaling`.

**`llm-gateway.md`** (position 4): Define a proxy layer in front of one or more LLM providers, handling API-key management, provider fallback/routing, cost tracking, prompt/response logging, and rate limiting per caller. Real-world example: LiteLLM, Portkey. Related: link to `/docs/patterns/api-edge/api-gateway` and `semantic-caching.md`.

**`semantic-caching.md`** (position 5): Define caching LLM responses keyed by semantic similarity of the prompt (via embedding similarity) rather than exact-string match, so paraphrased-but-equivalent queries hit the cache. Cover the tradeoff: a similarity threshold that's too loose returns wrong cached answers. Related: link to primer's [Cache](/docs/concepts/cache) and `llm-gateway.md`.

**`vector-database-sharding.md`** (position 6): Define partitioning a vector index (for approximate nearest-neighbor search) across multiple nodes when it's too large for one machine's memory. Cover why this is harder than sharding a normal database — most ANN indexes (HNSW, IVF) don't merge cleanly across shards, so query-time results have to be gathered and re-ranked. Related: link to `/docs/patterns/storage/sharding` and `rag-pipeline.md`.

**`rag-pipeline.md`** (position 7): Define Retrieval-Augmented Generation as retrieving relevant documents (via vector similarity search) and injecting them into an LLM prompt as context, instead of relying solely on the model's trained-in knowledge. Cover the pipeline stages: chunking, embedding, retrieval, re-ranking, prompt assembly. Related: link to `vector-database-sharding.md` and `semantic-caching.md`.

- [ ] **Step 3: Verify build**

Run: `npm run ingest -- /tmp/system-design-primer-src && npm run build`
Expected: succeeds, manifest now has 49 `design-patterns` entries total.

- [ ] **Step 4: Commit**

```bash
git add course/patterns/ai-infra
git commit -m "feat(patterns): add AI-Era Infrastructure Patterns group (7 pages)"
```

---

### Task 13: Core Building Blocks (11 pages)

**Files:**
- Create: `course/patterns/building-blocks/_category_.json`
- Create: `course/patterns/building-blocks/key-value-store.md`
- Create: `course/patterns/building-blocks/sequencer.md`
- Create: `course/patterns/building-blocks/distributed-monitoring.md`
- Create: `course/patterns/building-blocks/distributed-cache.md`
- Create: `course/patterns/building-blocks/distributed-message-queue.md`
- Create: `course/patterns/building-blocks/rate-limiter.md`
- Create: `course/patterns/building-blocks/blob-store.md`
- Create: `course/patterns/building-blocks/distributed-search.md`
- Create: `course/patterns/building-blocks/distributed-logging.md`
- Create: `course/patterns/building-blocks/distributed-task-scheduler.md`
- Create: `course/patterns/building-blocks/sharded-counters.md`

**Interfaces:** None — pure content, same template as Task 4.

- [ ] **Step 1: Category file**

```json
// course/patterns/building-blocks/_category_.json
{ "label": "Building Blocks", "position": 10 }
```

- [ ] **Step 2: Write all 11 pages to the Content Template.** Coverage requirements per page:

**`key-value-store.md`** (position 1): Define a store exposing get/put/delete by key with no query language over the value, trading relational query flexibility for simplicity and horizontal scalability. Real-world example: DynamoDB, Redis, Riak. Related: link to `/docs/patterns/storage/consistent-hashing` and primer's [Database](/docs/concepts/database).

**`sequencer.md`** (position 2): Define generating unique, (ideally) roughly-ordered IDs across distributed nodes without a single bottlenecked counter. Cover approaches: a centralized ID service, UUID (unique but unordered), and structured schemes like Twitter's Snowflake (timestamp + worker-id + sequence bits). Related: link to `/docs/patterns/storage/sharding`.

**`distributed-monitoring.md`** (position 3): Define aggregating metrics, logs, and error reports from many service instances into one place, covering both server-side error tracking and client-side (browser/mobile) error tracking as related-but-distinct concerns (client errors need source-map symbolication, sampling for high-traffic pages). Real-world example: Sentry, Datadog. Related: link to `/docs/patterns/observability/distributed-tracing` and `distributed-logging.md`.

**`distributed-cache.md`** (position 4): This is the *distributed systems* aspect of caching — cross-link the primer's [Cache](/docs/concepts/cache) page, which already fully covers caching *strategies* (cache-aside, write-through, etc.); do not repeat that. Cover cluster topology (client-side hashing vs. proxy-based), cache coherence across nodes, and the hot-key problem (one key getting disproportionate traffic overwhelming the node holding it). Real-world example: Redis Cluster, Memcached with consistent-hash clients. Related: link to primer's [Cache](/docs/concepts/cache) and `/docs/patterns/storage/consistent-hashing`.

**`distributed-message-queue.md`** (position 5): This is the *distributed, partitioned-log* aspect — cross-link the primer's [Asynchronism](/docs/concepts/asynchronism) page, which already covers message/task queues at a conceptual level; do not repeat that. Cover partitioned-log semantics (Kafka-style) vs. traditional point-to-point queues (SQS/RabbitMQ-style), delivery-guarantee levels, and consumer-group scaling. Related: link to primer's [Asynchronism](/docs/concepts/asynchronism) and `/docs/patterns/batch-streaming/partitioned-consumption`.

**`rate-limiter.md`** (position 6): Define limiting how many requests a client can make in a time window, protecting backend resources from overload/abuse. Cover the common algorithms briefly (token bucket, sliding window log/counter, fixed window) and where the limiter lives (per-instance in-memory vs. centralized in Redis for correctness across a fleet). Real-world example: API providers like Stripe returning `429` with `Retry-After`. Related: link to `/docs/patterns/api-edge/api-gateway`.

**`blob-store.md`** (position 7): Define object/blob storage for large, immutable-once-written binary data (images, videos, backups), addressed by key rather than a filesystem path, typically with a separate metadata index for querying. Real-world example: AWS S3, Google Cloud Storage. Related: link to primer's [CDN](/docs/concepts/cdn).

**`distributed-search.md`** (position 8): Define building a search index (typically an inverted index) across a large, sharded document set, supporting full-text and faceted queries that a plain database index can't serve efficiently. Real-world example: Elasticsearch, Apache Solr. Related: link to `/docs/patterns/storage/sharding`.

**`distributed-logging.md`** (position 9): Define collecting, aggregating, and making searchable the logs from many service instances, since SSH-ing into individual boxes doesn't scale. Cover structured logging (JSON, not free text) as a prerequisite for useful aggregation. Real-world example: the ELK stack (Elasticsearch/Logstash/Kibana), Loki. Related: link to `distributed-monitoring.md`.

**`distributed-task-scheduler.md`** (position 10): Define reliably running scheduled or delayed jobs across a fleet, ensuring a job runs on exactly one worker even with multiple scheduler instances (leader election or a distributed lock), and handles worker failure mid-job. Real-world example: Airflow, Kubernetes CronJobs, Quartz in clustered mode. Related: link to `sequencer.md`.

**`sharded-counters.md`** (position 11): Define splitting a single hot counter (e.g. a "likes" count under heavy concurrent writes) into N independent shard counters that are summed on read, avoiding write contention on one row/key. Real-world example: the classic Google App Engine sharded-counter recipe. Related: link to `/docs/patterns/storage/sharding`.

- [ ] **Step 3: Verify build**

Run: `npm run ingest -- /tmp/system-design-primer-src && npm run build`
Expected: succeeds, manifest now has 60 `design-patterns` entries total — this is the complete set.

- [ ] **Step 4: Commit**

```bash
git add course/patterns/building-blocks
git commit -m "feat(patterns): add Core Building Blocks group (11 pages)"
```

---

### Task 14: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Confirm exactly 60 supplementary pages, each correctly tagged**

```bash
find course/patterns -name '*.md' | wc -l
# Expected: 60

grep -L 'supplementary: true' $(find course/patterns -name '*.md')
# Expected: no output (every file has the flag)
```

- [ ] **Step 2: Confirm the manifest matches**

`courseManifest.ts` is generated TypeScript with the entries serialized as JSON — grep it directly:

```bash
grep -c '"category": "design-patterns"' src/data/courseManifest.ts
# Expected: 60
grep -c '"source": "supplementary"' src/data/courseManifest.ts
# Expected: 60 (should exactly match the design-patterns count — no supplementary entries in any other category yet)
```

- [ ] **Step 3: Full clean verification**

```bash
rm -rf build .docusaurus node_modules
npm install
npm run ingest -- /tmp/system-design-primer-src
npm test
npm run typecheck
npm run build
```

Expected: every command succeeds; ingestion summary still matches the primer's `{ concepts: 19, sdCaseStudies: 8, oodCaseStudies: 6, flashcards: 56, images: 36 }` unchanged (this phase adds content, it doesn't touch primer ingestion counts).

- [ ] **Step 4: Spot-check content quality on a sample**

Read 5 pages spanning different groups (e.g. `circuit-breaker.md`, `cqrs.md`, `rag-pipeline.md`, `websockets.md`, `distributed-cache.md`) end to end and confirm: the Content Template's 6 sections are all present in order, no fabricated specific claims in "Real-world example" sections, every "Further reading" link points only to martinfowler.com / an AWS-Azure-GCP architecture-center page / Wikipedia / this site itself, and every "Related patterns" link resolves (already enforced by the build's `onBrokenLinks: 'throw'`, but confirm visually too).

- [ ] **Step 5: Manually verify the dashboard and badge**

Run `npm run serve`, open `/progress`, confirm a "Design Patterns" section appears with 60 entries and the supplementary badge/pill next to each one; open a couple of pattern pages directly and confirm the badge renders above "Mark as complete". If no live browser is available in the environment, do the same static-verification substitute used in the original plan's Tasks 8-11 (grep the built HTML/JS bundle for the badge text and the "Design Patterns" category label) and disclose clearly which parts were/weren't visually confirmed.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "chore: final verification pass for Design Patterns library" --allow-empty
```
