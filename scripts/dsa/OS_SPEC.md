# Operating Systems topic-page authoring spec

You are authoring ONE Operating Systems topic page for a course section modeled on
OSTEP (Operating Systems: Three Easy Pieces — virtualization, concurrency, persistence).
The reader is preparing for interviews and wants: a clear mental model, the **must-know
algorithms implemented**, **conceptual interview questions**, and **algorithmic/coding
problems** expected in interviews.

## Sourcing (IMPORTANT)

- **Ground everything in authoritative, free sources.** OSTEP is freely available at
  `https://pages.cs.wisc.edu/~remzi/OSTEP/` (per-chapter PDFs like `.../cpu-sched.pdf`) —
  use it as the backbone, plus Linux `man` pages (man7.org), classic papers, and reputable
  references. The Educative course of the same name is PAYWALLED: use ONLY its public module
  **titles** for outline structure; NEVER read or reproduce its lesson content, and never
  link to a paywalled Educative page.
- Original prose only. Explain in your own words; never copy sentences.

## Output

- Doc: `course/os/<group-dir>/<slug>.md` (group + slug + sidebar_position given per assignment).
  Groups: `virtualization-cpu`, `virtualization-memory`, `concurrency`, `persistence`,
  `distribution`, `security`.
- Frontmatter:
  ```
  ---
  title: "<Topic>"
  sidebar_position: <given integer>
  description: <one sentence>
  ---
  ```
- Diagrams: prefer ```mermaid (state machines, address translation, page-table walks, the
  disk/CPU pipeline, RAID layouts). Mermaid labels must use `&#60;`/`&#62;` (HTML entities, with the ampersand) for `<`/`>`.
- **NEVER put a bare `;` inside a `sequenceDiagram` message or `Note` line** (e.g.
  `H->>H: save regs; raise to kernel mode`) — mermaid's sequence parser treats an
  unquoted `;` as a statement terminator, silently glues the rest of the line onto
  the NEXT statement, and throws a confusing "Expecting SOLID_ARROW... got NEWLINE"
  parse error at runtime (this does NOT get caught by `npm run build`, since mermaid
  parses client-side — verify with `node scripts/dsa/verify-mermaid.mjs` instead).
  Use `,`, `—`, or "then"/"and" in place of `;` in any sequence-diagram text.

## Page structure

1. Frontmatter, then a 1-paragraph **intro naming "the crux"** — the exact problem this
   topic solves (OSTEP frames every chapter as a crux; do the same).
2. `## The core idea` — point-wise mental model.
3. `## How it works` — the mechanism, point-wise, with **C code** (see below), mermaid
   diagrams, and KaTeX for any formulas (scheduling metrics like turnaround/response time,
   hit-rate/AMAT, disk seek/rotation math, RAID capacity/throughput).
4. `## Must-know algorithms` — the classic algorithms for THIS topic, each as a complete,
   compile-tested **C** implementation (see the topic hints in your assignment). E.g.
   scheduling: FIFO/SJF/STCF/RR/MLFQ; page replacement: FIFO/LRU/Clock/Optimal/Belady;
   allocators: first/best/worst-fit + buddy; locks: test-and-set/ticket/MCS; disk: FCFS/
   SSTF/SCAN/C-SCAN; classic sync: producer-consumer, readers-writers, dining philosophers.
5. `## Interview questions` — 6–10 REAL conceptual OS interview questions with concise,
   correct model answers (grouped/graded). These are the "explain X" questions asked at
   MAANG-style and systems interviews.
6. `## Coding problems` — algorithmic/coding problems expected in interviews, each with a
   one-line "what it tests" and a **verified link**, plus a C (or clear) reference where it's
   a classic OS problem (LRU cache, thread-safe queue, dining philosophers, producer-consumer,
   readers-writers, rate limiter, etc.). Label 🎯 Interview (LeetCode/GfG) and 🏗 Systems
   (OS-classic). Only canonical LeetCode slugs; verify GfG/Wikipedia/man7/OSTEP links 200.
7. `## Key takeaways` — bullets.
8. `## Source(s) and further reading` — the OSTEP chapter (free PDF), relevant `man` pages,
   papers, and reputable references — all curl-200 verified. Never invent a URL.

## Code rules

- **Core code MUST be C** (```c), compile-tested with `cc -std=c11 -x c <file> -o /tmp/x`
  (add `-pthread` for threads). It must compile AND run correctly (drive it with a tiny
  `main` and check output). Concurrency code must actually be correct under threads.
- Every function called is defined. Prefer clear, self-contained programs.

## Hard rules (build-breaking or quality-critical)

- No `{#heading-id}` anchors; no bare `{`/`}`/`<`/`>` in prose OR in mermaid/image alt-text
  (use words, `≤`/`≥`, or `&#60;`/`&#62;` (HTML entities, with the ampersand) in mermaid). Balanced code fences. No literal `|`
  inside `$…$` in table cells (use `\vert`).
- Internal `/docs/...` links must resolve to real files (build throws otherwise). You MAY
  cross-link real DSA pages (`/docs/dsa/...`) and pattern pages (`/docs/patterns/...`) —
  verify the file exists first (`ls course/...`).
- External links curl-200 (`curl -s -o /dev/null -w "%{http_code}" -L -A Mozilla/5.0 <url>`).

## Verification before finishing

1. Every C block compiles (and runs) under `cc -std=c11` (+`-pthread` where needed).
2. Every external link 200; every internal `/docs/...` link resolves.
3. Report: doc path, the must-know algorithms implemented, the interview Qs, the coding
   problems + verified links, and any claim you could not verify.
