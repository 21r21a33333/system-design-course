---
title: DSA — Algorithms & Data Structures
sidebar_position: 0
description: Complete, notation-clean lecture notes for Pavel Mavrin's Algorithms & Data Structures course, with curated interview + competitive practice problems.
---

# DSA — Algorithms & Data Structures

Complete written notes for **Pavel Mavrin's** [_Algorithms & Data Structures_](https://www.youtube.com/playlist?list=PLrS21S1jm43igE57Ye_edwds_iL7ZOAG4) lecture series (61 lectures across four "seasons"). Each note is built to be **read instead of watched**: every idea the lecturer develops on the board is captured, the math is typeset, and the key board frames are embedded inline.

:::note Source & attribution
These notes are original prose summarizing publicly available lectures by [Pavel Mavrin](https://www.youtube.com/@pavelmavrin). They are a study companion, not a transcript. Watch the originals for the full delivery — every note deep-links back to the exact timestamp.
:::

## How the notes are organized

The course runs from first-principles complexity analysis up to research-level structures, so it is grouped into four seasons:

- **S01 — Foundations:** sorting, heaps, binary search, amortized analysis, disjoint sets, dynamic programming, hashing.
- **S02 — Trees & structures:** segment/Fenwick trees, balanced BSTs, treaps, splay/scapegoat trees, tree decompositions, link-cut trees.
- **S03 — Graphs & strings:** DFS/BFS, SCC, shortest paths, MST, string matching (KMP/Z/Aho-Corasick), suffix structures.
- **S04 — Flows & advanced:** matchings, max-flow/min-cut, min-cost flows, linear programming, number theory, FFT, approximation & parallel algorithms.

## What each lecture note contains

- **TL;DR** and a table of contents.
- **Section-by-section capture** of the lecture — no step skipped — with the board's math typeset (e.g. the merge-sort recurrence
  $$T(n) = 2\,T\!\left(\tfrac{n}{2}\right) + \Theta(n) = \Theta(n \log n)$$
  ), diagrams for every structure, and runnable algorithm sketches with complexity.
- **Complexity recap** table.
- **Practice problems** — curated and difficulty-graded, each with a one-line "what it tests" and a verified link. Problems are labelled by intent:
  - 🎯 **Interview** — LeetCode / GeeksforGeeks / InterviewBit problems that show up in MAANG-style rounds.
  - 🏆 **Competitive** — Codeforces / CSES / CodeChef problems for topics that live mainly in competitive programming.
  - Lectures whose material sits **beyond typical interview rounds** say so explicitly, and point to the nearest interview-relevant adjacent problem.
- **Further reading** — verified links to CP-Algorithms, cp-algorithms, GfG, and primary references.

Start with **S01E01** on time complexity and merge sort, or jump to any lecture from the sidebar.
