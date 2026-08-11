---
title: "S03E11 · Aho-Corasick Algorithm"
sidebar_position: 11
description: Search a whole set of patterns in one linear pass over the text — a trie of patterns, suffix (fail) links built by BFS, the goto automaton, dictionary-suffix links, and O(text + matches) multi-pattern matching.
---

# S03E11 · Aho-Corasick Algorithm

> **Source:** Pavel Mavrin, [_A&DS S03E11_](https://youtu.be/w9-n3jW7q3s) · 1h30m lecture → ~14 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- **Problem.** Given many patterns $s_1, s_2, \ldots$ and one long text $t$, find all of them in **a single pass** over $t$, instead of running one string-search per pattern (which costs length of text times number of patterns).
- **Trie of patterns.** Insert every pattern into a trie. Each node is a **prefix** of some pattern; the root is the empty string. Building the trie costs $O\!\left(\sum |s_i|\right)$.
- **Suffix link (fail link).** For each node $v$, $\mathrm{suf}(v)$ points to the node for the **longest proper suffix** of $v$'s string that is itself a trie node — the direct generalization of the KMP prefix function to a tree.
- **Goto automaton.** Precompute $\delta(v, c)$ = the state after reading character $c$ from $v$. With the full automaton, each text character is an **$O(1)$** transition, so scanning is $O(|t|)$.
- **Dictionary-suffix links** let a non-terminal state know it still *ends* a pattern (a shorter pattern that is a suffix of the current one). Marking these turns "am I at a terminal node" into a correct "did a pattern just finish" test.
- **Two builds.** The *modern* build precomputes the whole $\delta$ table by BFS in $O\!\left(|\Sigma| \sum |s_i|\right)$; the *classical* build stores only suffix links in $O\!\left(\sum |s_i|\right)$ and computes transitions on the fly. Total matching work is $O(|t| + \text{number of matches})$.

---

## The problem: many patterns, one text

- Input: a set of patterns $s_1, s_2, \ldots, s_n$ and a text $t$. We want every place a pattern occurs in $t$.
- **Naive approach.** Run any single-pattern search (KMP, Z, hashing) once per pattern. Each is linear in $|t|$, so the total is $|t|$ times the number of patterns — too slow when the text is long and there are many patterns.
- **Goal.** One left-to-right sweep of $t$ that recognizes *all* patterns at once.
- Three concrete tasks the lecture solves with the same machine:
  1. **Find any** — does $t$ contain at least one pattern? (e.g. a banned-words / censorship filter).
  2. **For each $s_i$** — a boolean: does $s_i$ occur in $t$?
  3. **For each $s_i$** — an integer: how many times does $s_i$ occur in $t$?
- Note on output size: listing *every* position of every pattern can be $\Theta(n \cdot |t|)$ in the worst case, so we usually want the aggregate answers above, not the raw position list.

![Pattern set aabbc, abba, baab, bbb on the left; the three target problems listed; the trie under construction](/img/dsa/w9-n3jW7q3s/frame-00038.png)

[watch from 5:15](https://youtu.be/w9-n3jW7q3s?t=315)

---

## Step 1 — the trie of patterns

- Build a trie (prefix tree) over all patterns, exactly as in the previous lecture. The root is the empty string; each **edge carries one letter**; the path root → node spells a **prefix** of some pattern.
- Key correspondence, used everywhere below: **every node ↔ a distinct prefix** of the pattern set, and every prefix of any pattern is some node.
- A node where a pattern ends is **terminal**; store how many patterns end there (patterns can repeat, and one pattern can be a suffix-node of another).
- Cost: $O\!\left(\sum_i |s_i|\right)$ time and nodes.

```cpp
#include <bits/stdc++.h>
using namespace std;
static const int K = 26;                        // alphabet size (a..z here)

struct AhoCorasick {
    struct Node {
        array<int,K> go;                        // trie edges; after build(): full automaton
        int link = 0;                           // suffix (fail) link
        int dictLink = 0;                       // dictionary-suffix link (0 = none)
        int cnt = 0;                            // #patterns ending exactly here
        long long freq = 0;                     // #times this state is entered while scanning
        Node(){ go.fill(-1); }
    };
    vector<Node> t;
    vector<int> patEnd;                          // trie node where pattern i terminates

    AhoCorasick(){ t.emplace_back(); }           // node 0 = root (empty string)

    void add(const string& s){                   // O(|s|)
        int v = 0;
        for (char ch : s) {
            int c = ch - 'a';
            if (t[v].go[c] == -1) { t[v].go[c] = t.size(); t.emplace_back(); }
            v = t[v].go[c];
        }
        t[v].cnt++;
        patEnd.push_back(v);
    }
    // ... build() and matching added in later sections ...
};
```

- The build cost as KaTeX: $O\!\left(\sum_i |s_i|\right)$.

[watch from 6:40](https://youtu.be/w9-n3jW7q3s?t=400)

---

## Step 2 — transitions and the suffix link

- While scanning $t$, the **only thing we must remember** is the longest current suffix that is still a prefix of some pattern — i.e. our current trie node. That is the automaton's state.
- **Transition** $\delta(v, c)$: from state $v$, on reading $c$, go to the node for the **longest suffix** of $v \cdot c$ that is a trie node.
  - If $v$ has a real child on $c$, that child is the answer (the whole string $v \cdot c$ is in the trie).
  - Otherwise we must drop to a shorter suffix — this is where suffix links come in.
- **Suffix link** $\mathrm{suf}(v)$: the node for the **longest proper suffix** of $v$'s string that is also a trie node. The root has no suffix link (empty string has no proper suffix). This is the KMP prefix function, generalized to a tree: a suffix of one pattern may be a prefix of another, which is fine.

![The trie with the notation delta of v and c for transitions and suf of v for the suffix link, plus the "maximal suffix present in the trie" picture](/img/dsa/w9-n3jW7q3s/frame-00090.png)

- **Following suffix links enumerates all suffixes** of the current string in decreasing length. To compute $\delta(v,c)$ the *slow* way: walk $v \to \mathrm{suf}(v) \to \mathrm{suf}(\mathrm{suf}(v)) \to \cdots$ until some node has a real child on $c$; if you fall off the root, the transition goes to the root. This is correct but can be quadratic, exactly like the naive KMP shift.

[watch from 21:43](https://youtu.be/w9-n3jW7q3s?t=1303)

---

## Step 3 — building fail links + the full automaton by BFS

- The fix mirrors KMP: don't re-walk the whole suffix chain. Compute states **layer by layer (increasing string length)** so every value we read is already final. A **BFS from the root** visits nodes in exactly that order — $\mathrm{suf}(v)$ and $\mathrm{parent}(v)$ are always strictly shorter, hence computed earlier.
- Two one-liners drive the whole construction (`ch(v)` = the letter on the edge from $\mathrm{parent}(v)$ to $v$):

$$
\mathrm{suf}(v) \;=\; \delta\big(\mathrm{suf}(\mathrm{parent}(v)),\; \mathrm{ch}(v)\big)
$$

$$
\delta(v, c) \;=\;
\begin{cases}
\text{real child of } v \text{ on } c, & \text{if it exists}\\[2pt]
\delta\big(\mathrm{suf}(v),\, c\big), & \text{otherwise}
\end{cases}
$$

![Board pseudocode: for v in BFS, suf(v) = delta(suf(parent(v)), ch(v)); for c in alphabet, if delta(v,c) exists continue, else delta(v,c) = delta(suf(v), c)](/img/dsa/w9-n3jW7q3s/frame-00167.png)

- In code we do it in one BFS. A missing root edge is redirected to the root, so `go[]` becomes a **total** transition function with no special cases at scan time. The **dictionary-suffix link** `dictLink` is filled here too (next section).

```cpp
// Add inside struct AhoCorasick.
vector<int> order;                              // BFS order (root first), reused later

void build() {
    queue<int> q;
    for (int c = 0; c < K; c++) {
        int u = t[0].go[c];
        if (u == -1) t[0].go[c] = 0;            // missing root edge loops to root
        else { t[u].link = 0; q.push(u); }
    }
    order.push_back(0);
    while (!q.empty()) {
        int v = q.front(); q.pop();
        order.push_back(v);
        int f = t[v].link;
        // dictionary-suffix link: nearest terminal reachable via fail links (see next section)
        t[v].dictLink = t[f].cnt ? f : t[f].dictLink;
        for (int c = 0; c < K; c++) {
            int u = t[v].go[c];
            if (u == -1) {
                t[v].go[c] = t[f].go[c];         // goto = follow the fail link's transition
            } else {
                t[u].link = t[f].go[c];          // suf(child) = delta(suf(v), c)
                q.push(u);
            }
        }
    }
}
```

- **Build cost:** $O\!\left(|\Sigma| \cdot \sum_i |s_i|\right)$ — every node times every alphabet letter. Small alphabets make this effectively linear.

[watch from 26:46](https://youtu.be/w9-n3jW7q3s?t=1606)

---

## Step 4 — dictionary-suffix links (terminal propagation)

- **Bug in the naive terminal test.** "The current node is terminal" is *not* the same as "a pattern just ended". Reading text can leave you on a longer, non-terminal prefix whose *suffix* is a full pattern. Example from the board: patterns $\{aba, b\}$, reading `abb` lands on node `abb`, which is not terminal — yet `b` (a pattern) just ended.
- **Fix.** A pattern ends at position $i$ iff some pattern is a **suffix** of the current node's string — i.e. some terminal node is reachable by following suffix links up from the current node.
- **Dictionary-suffix link** $\mathrm{dictLink}(v)$ = the nearest terminal node strictly above $v$ in the suffix-link chain (or none). It hops directly over non-terminal links, so occurrence reporting is $O(\text{matches})$, not $O(\text{depth})$.
- The suffix links form their own tree (each node has exactly one parent = its suffix link). "Mark a node terminal if any terminal is above it via suffix links" is then a **subtree / DP problem** on that tree, solvable in linear time by BFS-order propagation or a DFS. In `build()` above, `dictLink` is computed in the same BFS: `dictLink(v) = f` if `f` is terminal, else `dictLink(f)`.

![Small example with patterns aba and b: reading abb lands on a non-terminal node whose suffix b is a pattern, so terminal marks must propagate along suffix links](/img/dsa/w9-n3jW7q3s/frame-00237.png)

- **Problem 1 (find any)** falls right out: sweep the text, and the moment the current state is terminal *or* has a dictionary link, a pattern has occurred.

```cpp
// Add inside struct AhoCorasick.
bool containsAny(const string& text) {          // Problem 1: does t contain any pattern?
    int v = 0;
    for (char ch : text) {
        v = t[v].go[ch - 'a'];                  // O(1) transition, no fail-walking
        if (t[v].cnt || t[v].dictLink) return true;
    }
    return false;
}
```

[watch from 45:00](https://youtu.be/w9-n3jW7q3s?t=2700)

---

## Step 5 — counting occurrences of every pattern

- Sweep $t$ once, following $\delta$. At each step **increment a counter on the current state** — that state is the longest current suffix present in the trie.
- Then the number of times pattern $s_i$ occurs equals the **sum of visit-counters over all states that have $s_i$'s node as a suffix** — i.e. the subtree of $s_i$'s node in the **suffix-link tree**.
- Compute all those subtree sums in linear time by pushing each state's count **up** its suffix link. The BFS `order` lists ancestors before descendants, so iterating it in reverse pushes children into parents correctly.

![The full automaton on patterns aba and b with a text tape being fed through, illustrating that each occurrence is a suffix of the current state](/img/dsa/w9-n3jW7q3s/frame-00277.png)

```cpp
// Add inside struct AhoCorasick.
// Returns, for each pattern index, its number of occurrences in text. O(|text| + nodes).
vector<long long> countOccurrences(const string& text, int nPat) {
    for (auto& nd : t) nd.freq = 0;
    int v = 0;
    for (char ch : text) { v = t[v].go[ch - 'a']; t[v].freq++; }   // O(|text|)
    // Push freq UP the suffix-link tree: freq[state] becomes the subtree sum.
    for (int i = (int)order.size() - 1; i > 0; i--) {              // children before parents
        int v2 = order[i];
        t[t[v2].link].freq += t[v2].freq;
    }
    vector<long long> ans(nPat);
    for (int i = 0; i < nPat; i++) ans[i] = t[patEnd[i]].freq;     // subtree sum at s_i's node
    return ans;
}
```

- **Problem 2 (each $s_i$ present?)** is the same DP with booleans instead of sums (nonzero subtree sum ⇒ present).
- **Matching cost:** $O(|t|)$ for the sweep plus $O(\text{nodes})$ for the up-pass — independent of the alphabet, since the automaton is precomputed. Listing individual matches would add $O(\text{number of matches})$ via the dictionary links.

[watch from 66:49](https://youtu.be/w9-n3jW7q3s?t=4009)

**Compile-tested.** Against a brute-force oracle (each pattern searched independently) over 500 randomized trials — random alphabets, pattern sets, and texts — `countOccurrences` and `containsAny` matched exactly. On patterns $\{aabbc, abba, baab, bbb, bb, b\}$ and text `aabbaabaabbba`, it reports `b` → 6, `bb` → 3, `baab` → 2, `abba` → 1, `bbb` → 1, `aabbc` → 0.

---

## Step 6 — the classical build (suffix links only)

- When the alphabet $\Sigma$ is **large**, materializing the whole $\delta$ table ($|\Sigma|$ entries per node) is wasteful. The *classical* Aho-Corasick stores **only suffix links** and computes transitions on demand.
- Suffix links are built the KMP way: for node $v$ with parent $p$ and edge letter $x$, walk $k = \mathrm{suf}(p)$ up its own suffix chain until $k$ has a real child on $x$; that child is $\mathrm{suf}(v)$. If you run off the root, $\mathrm{suf}(v)$ is the root.

![Board pseudocode for the classical build: for v in BFS, p=parent(v), x=ch(v), k=suf(p); while k not null and no edge on x, k=suf(k); suf(v)=root or child(k,x)](/img/dsa/w9-n3jW7q3s/frame-00340.png)

```cpp
// Alternative build storing ONLY suffix links (no full automaton).
// Uses raw child edges child[v][c] (== -1 if absent) and parent/edge-letter info.
void buildLinksOnly(const vector<array<int,K>>& child,
                    const vector<int>& parent, const vector<int>& edgeChar) {
    // BFS over the trie; root's link is itself (0).
    queue<int> q;
    for (int c = 0; c < K; c++) if (child[0][c] != -1) { t[child[0][c]].link = 0; q.push(child[0][c]); }
    while (!q.empty()) {
        int v = q.front(); q.pop();
        int p = parent[v], x = edgeChar[v];
        int k = t[p].link;                       // start from parent's suffix link
        while (k != 0 && child[k][x] == -1) k = t[k].link;   // walk suffix chain
        t[v].link = (child[k][x] != -1 && child[k][x] != v) ? child[k][x] : 0;
        for (int c = 0; c < K; c++) if (child[v][c] != -1) q.push(child[v][c]);
    }
}

// On-the-fly transition from state v on letter c, given only suffix links + raw child edges.
int step(const vector<array<int,K>>& child, int v, int c) {
    while (v != 0 && child[v][c] == -1) v = t[v].link;   // follow suffix links
    return child[v][c] != -1 ? child[v][c] : 0;          // stay at root if nothing matches
}
```

- **Why it is still linear.** Along any single pattern's path, `k`'s string length rises by one per trie level and only falls when a suffix link is followed; total drops cannot exceed total rises, so the amortized work per pattern is $O(|s_i|)$ and the whole build is $O\!\left(\sum_i |s_i|\right)$.
- **Subtle point.** This bound is linear in the **total pattern length**, which can be *larger* than the number of trie nodes. A star-shaped trie (one center, $n$ long spokes) has $O(n)$ nodes but $\Theta(n^2)$ total length, and the suffix-link build is $\Theta(n^2)$ there — that is expected and correct.

[watch from 74:33](https://youtu.be/w9-n3jW7q3s?t=4473)

---

## Complexity recap

Let $L = \sum_i |s_i|$ (total pattern length), $|\Sigma|$ the alphabet size, $|t|$ the text length, and $M$ the number of reported matches.

| Operation | Time | Space | Notes |
| --- | --- | --- | --- |
| Build trie | $\Theta(L)$ | $\Theta(L)$ | one node per distinct prefix |
| Build fail links only (classical) | $\Theta(L)$ | $\Theta(L)$ | KMP-style amortization |
| Build full automaton (modern) | $\Theta(\vert \Sigma\vert \, L)$ | $\Theta(\vert \Sigma\vert \, L)$ | precomputed $\delta$ table |
| Scan text, full automaton | $\Theta(\vert t\vert )$ | $\Theta(1)$ extra | each step is $O(1)$ |
| Scan text, links only | $\Theta(\vert t\vert )$ amortized | $\Theta(1)$ extra | on-the-fly transitions |
| Count / boolean per pattern | $\Theta(\vert t\vert  + L)$ | $\Theta(L)$ | one suffix-tree up-pass |
| Report all match positions | $\Theta(\vert t\vert  + M)$ | $\Theta(L)$ | via dictionary links |

---

## Practice problems

The canonical use of Aho-Corasick is **matching a dictionary of patterns against a stream or text in one pass**; the trie and its suffix-link DP are the transferable ideas.

**🎯 Interview (MAANG-style)**

- [Stream of Characters — LeetCode 1032](https://leetcode.com/problems/stream-of-characters/) — Hard — the textbook Aho-Corasick: feed characters one at a time and report when any dictionary word ends (build the trie, follow fail links).
- [Add Bold Tag in String — LeetCode 616](https://leetcode.com/problems/add-bold-tag-in-string/) — Medium — mark every position covered by any pattern; a multi-pattern search with interval merging.
- [Bold Words in String — LeetCode 758](https://leetcode.com/problems/bold-words-in-string/) — Medium — same task as 616, a direct Aho-Corasick application.
- [Substring with Concatenation of All Words — LeetCode 30](https://leetcode.com/problems/substring-with-concatenation-of-all-words/) — Hard — fixed-length multi-word matching; a sliding-window cousin of dictionary matching.
- [Aho-Corasick Algorithm — GeeksforGeeks](https://www.geeksforgeeks.org/aho-corasick-algorithm-pattern-searching/) — Medium — worked implementation of the full automaton and match reporting.

**🏆 Competitive**

- [Finding Patterns — CSES 2102](https://cses.fi/problemset/task/2102) — Medium — for each pattern decide if it occurs in the text; the exact Problem 2 of this lecture, canonical Aho-Corasick.
- [String Matching — CSES 1753](https://cses.fi/problemset/task/1753) — Easy — count total pattern occurrences; single-pattern here, the natural warm-up before multi-pattern.
- [Word Combinations — CSES 1731](https://cses.fi/problemset/task/1731) — Medium — count ways to split a string over a dictionary; the pure **trie** half of this lecture, driving a DP.
- [Indie Album — Codeforces 1207G](https://codeforces.com/problemset/problem/1207/G) — Hard — offline queries counting pattern occurrences on strings built incrementally; Aho-Corasick automaton combined with Euler-tour / Fenwick on the suffix-link tree.

> No official Codeforces home-task post is linked from this lecture's description, so the competitive set above is curated rather than the instructor's assigned list.

---

## Further reading

- [Aho-Corasick algorithm — cp-algorithms.com](https://cp-algorithms.com/string/aho_corasick.html) — the standard reference: trie, suffix links, automaton, and applications.
- [Aho-Corasick Algorithm for Pattern Searching — GeeksforGeeks](https://www.geeksforgeeks.org/aho-corasick-algorithm-pattern-searching/) — implementation walkthrough with diagrams.
- [Aho–Corasick algorithm — Wikipedia](https://en.wikipedia.org/wiki/Aho%E2%80%93Corasick_algorithm) — history and the original dictionary-matching formulation.

---

## Key takeaways

- Aho-Corasick = **trie + KMP-on-a-tree**: the suffix link is the prefix function generalized so that a suffix of one pattern can be a prefix of another.
- Precompute the **goto automaton** ($\delta$) once and every text character becomes an $O(1)$ transition, giving an $O(|t|)$ sweep.
- **Dictionary-suffix links** are the correctness fix: a pattern can end even when the current node is not terminal, so terminal-ness must propagate along suffix links.
- The suffix links form a **tree**; almost every query (present? count? mark terminals?) is a subtree DP on that tree, done in one linear up-pass.
- Choose the build to fit the alphabet: **full automaton** ($O(|\Sigma| L)$) for small $\Sigma$, **links-only classical** ($O(L)$) with on-the-fly transitions for large $\Sigma$.

## Glossary

- **Trie** — prefix tree; each node is a distinct prefix of the pattern set, the root is the empty string.
- **Suffix link (fail link)** — from node $v$, points to the node of the longest proper suffix of $v$'s string that is also a trie node.
- **Goto / transition $\delta(v,c)$** — the automaton state entered from $v$ after reading letter $c$; equals the longest suffix of $v \cdot c$ present in the trie.
- **Dictionary-suffix link** — from $v$, the nearest terminal node reachable by following suffix links; makes occurrence reporting output-sensitive.
- **Terminal node** — a node where at least one pattern ends.
- **Suffix-link tree** — the tree whose parent-of relation is the suffix link; the substrate for the counting and marking DPs.
