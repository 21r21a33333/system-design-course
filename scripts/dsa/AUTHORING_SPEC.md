# DSA lecture-note authoring spec

You are authoring ONE Docusaurus doc from ONE ingested yt-notes bundle of a
Pavel Mavrin _Algorithms & Data Structures_ lecture. The reader reads the note
**instead of** watching the 90-minute lecture. Match the locked exemplar:
`course/dsa/s01-foundations/s01e01-time-complexity-merge-sort.md`.

## Inputs (in the bundle dir `~/yt-notes-library/bundles/<video-id>/`)

- `meta.json` — `title`, `duration`, `chapters` (use as section anchors), and
  `description` (often contains the **official Codeforces home-tasks link** —
  extract it, it is provenance-verified and belongs in Practice problems).
- `transcript.clean.md` — **de-duplicated** timestamped transcript. USE THIS, not
  `transcript.md` (which is triplicated). If `transcript.clean.md` is missing,
  run `python3 scripts/dsa/clean_transcript.py <bundle-dir>` first.
- `frames/frame-*.png` + `frames.json` — timestamped board frames. **Vision-read a
  sampled subset** (≈12–20 spread across chapters, favoring *settled* boards that
  show finished derivations/code). You must actually look at them to transcribe the
  math and code correctly.

## Output

- Path: `course/dsa/<season-dir>/<slug>.md` where `<slug>` = `sNNeMM-<kebab-topic>`
  (e.g. `s01e05-binary-search`). Season dirs: `s01-foundations`,
  `s02-trees-and-structures`, `s03-graphs-and-strings`, `s04-flows-and-advanced`.
- Frontmatter:
  ```
  ---
  title: "SNNEMM · <Short Topic>"
  sidebar_position: <lecture number within season, integer>
  description: <one sentence, plain text, no colons-then-quotes gotchas>
  ---
  ```
- Frames: copy the ones you embed to `static/img/dsa/<video-id>/frame-XXXXX.png`
  and reference them as `/img/dsa/<video-id>/frame-XXXXX.png`. Only copy frames you
  actually embed (no orphans).

## Document structure (adapt section titles to the lecture's real content)

1. `# SNNEMM · <Topic>` then a blockquote: `> **Source:** Pavel Mavrin, [_A&DS SNNEMM_](https://youtu.be/<id>) · <Hh Mm> lecture → ~N min read.`
2. `## TL;DR` — 4–6 crisp bullets stating the results (not "we will discuss…").
3. One `## <Section>` per chapter / logical segment. In EACH:
   - **Point-wise bullets**, not paragraphs. (The user explicitly wants
     "meaningful point-wise data, not passages of text.")
   - **Faithfully reproduce every piece of code the lecturer writes on the board.**
     If the lecture develops an algorithm in code/pseudocode, the note MUST contain a
     complete, correct implementation of *that* algorithm as shown — do not omit it,
     do not replace it with prose, do not stub it. EVERY function you name/call must be
     defined in the same block or a prior one. (Lectures that are mostly conceptual
     with little board code — like S01E01 — stay light on code; that is expected.)
   - **Language: core algorithm code MUST be C++** (```cpp) — this is a competitive-
     programming course. Write idiomatic, compilable C++17 (use `#include <bits/stdc++.h>`,
     `using namespace std;`, `vector`, `array`, `pair`, etc.). Short *illustrative*
     pseudocode may be in any language or a ```text block, but the real implementations
     are C++. **Compile-test every C++ block** with a tiny driver:
     `c++ -std=c++17 -x c++ <file> -o /tmp/x && /tmp/x` — the algorithm must actually run
     and produce correct output before you ship the note.
   - **Data structures used** stated plainly (what invariant each maintains).
   - Math typeset with KaTeX: inline `$...$`, display `$$...$$`.
   - The most informative board **frame embedded** with a descriptive caption.
   - A trailing `[watch from M:SS](https://youtu.be/<id>?t=<seconds>)` deep-link.
4. `## Complexity recap` — a markdown table (operation | best | avg | worst | space).
5. `## Practice problems` — curated, difficulty-graded, grouped:
   - `**🎯 Interview (MAANG-style)**` — LeetCode / GeeksforGeeks / InterviewBit.
   - `**🏆 Competitive**` — Codeforces / CSES / CodeChef; ALWAYS include the
     lecture's official Codeforces home-tasks post from the description.
   - Each: `- [name](verified-link) — Easy/Med/Hard — one-line "what it tests".`
   - If the topic is **beyond typical interview rounds** (e.g. fusion trees, splay
     trees, push-relabel, FFT, LP), say so in one honest line and still give the
     nearest interview-relevant adjacent problems + real competitive problems.
6. `## Further reading` — verified links (cp-algorithms.com, GfG, Wikipedia,
   primary papers).
7. `## Key takeaways` — bullets.
8. `## Glossary` — term → short definition (omit if nothing new).

## Hard rules (build-breaking or quality-critical)

- **NO explicit `{#heading-id}` anchors** — this site's MDX parses `{…}` as JSX and
  the build throws. Rely on auto-generated heading slugs.
- **No bare `{` or `}` or raw `<` / `>` in prose OR in image alt-text** (MDX/JSX
  hazard — alt text inside `![ ... ]` is parsed too). Use words or put them inside
  `$…$` math or code fences. In prose and alt-text use `≤`, `≥` (unicode), never `<=`/`>=`.
- **Every code block must be self-consistent** — no calling a function you never define.
- **Links:** LeetCode/Codeforces block scripted fetches (403) — only cite canonical,
  well-known LeetCode slugs and Codeforces posts you're certain of (the description's
  home-task URL is always safe). For GfG/CSES/Wikipedia/cp-algorithms, the link must
  return HTTP 200 (verify with `curl -s -o /dev/null -w "%{http_code}" -L -A Mozilla/5.0 <url>`).
  Drop any link you cannot justify. Never invent a URL.
- **Original prose only.** Never copy sentences from any site. Summarize in your own words.
- Math notation: prefer real KaTeX (this site renders it). Keep mermaid fences balanced.

## Verification before you finish

1. `cd system-design-course && npm run build` must succeed (it compiles this doc).
   If it throws, read the error's file:line and fix (usually a stray `{`/`<` or an
   unbalanced `$`/mermaid fence).
2. Confirm every embedded frame file exists under `static/img/dsa/<id>/`.
3. Report the final doc path, the frames embedded, and the problems listed.
