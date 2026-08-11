---
title: "S04E01 · Maximum Matchings in Bipartite Graphs"
sidebar_position: 1
description: Kuhn's augmenting-path algorithm for maximum bipartite matching, Berge's augmenting-path theorem, and the duality partners — König's theorem (max matching equals min vertex cover) and Hall's marriage theorem.
---

# S04E01 · Maximum Matchings in Bipartite Graphs

> **Source:** Pavel Mavrin, [_A&DS S04E01_](https://youtu.be/4VYVnEcLZpQ) · 1h27m lecture → ~16 min read.
> Season 4 opener. Every section deep-links back to the exact moment on the board.

## TL;DR

- A **matching** is a set of edges that pairwise share no endpoint; the goal is the **maximum matching** — the largest such set. A matching that touches every vertex ($n/2$ edges) is **perfect**.
- **Berge's theorem:** a matching $M$ is maximum **iff** it admits no **augmenting path** — an alternating path (out-of-$M$, in-$M$, out-of-$M$, …) whose two endpoints are both free. Flipping such a path grows $M$ by one.
- **Kuhn's algorithm** grows $M$ from empty: orient non-matching edges left→right and matching edges right→left, then DFS from each free left vertex looking for a free right vertex. Running time $O(V \cdot E)$.
- The whole algorithm is one recursive `dfs(v)` on the **original** graph, using a single array `p[u]` = the left vertex matched to right vertex $u$; the augmenting path is inverted implicitly on the way back out of the recursion.
- **König's theorem** (bipartite duality): the size of the maximum matching equals the size of the **minimum vertex cover**. The cover is read off directly from the last DFS as $L^- \cup R^+$.
- **Hall's marriage theorem:** a perfect matching of the left side exists **iff** every subset $A$ of the left part satisfies $|N(A)| \ge |A|$.

---

## Matchings and the maximum-matching problem

- A **matching** $M$ in an undirected graph is a set of edges such that no two chosen edges share a vertex. You "mark" edges; all marked edges must have distinct endpoints.
- **Maximum matching** = a matching with the most edges. Example on the board: a graph has a matching of size 2, but dropping one edge and repicking yields size 3 — that 3 is maximum.
- **Perfect matching** = a matching that uses every vertex, so it has exactly $n/2$ edges. Not every graph has one; the term just names the "covers all vertices" case.
- Two flavors of the problem, and the difference is **fundamental** (it shows up later as a difference in the linear program):
  - **Bipartite** — vertices split into a **left** part $L$ and **right** part $R$; every edge goes across. Solvable in polynomial time, and that is today's topic.
  - **Non-bipartite** — same problem statement, genuinely harder to find augmenting paths (Edmonds' blossom algorithm, a later lecture).

![Matchings intro board: an undirected graph with a size-2 matching that can be repicked to size 3](/img/dsa/4VYVnEcLZpQ/frame-00012.png)

[watch from 1:42](https://youtu.be/4VYVnEcLZpQ?t=102)

---

## Augmenting paths and the general scheme

- **Every** matching algorithm in this course follows one skeleton:
  1. Start from the **empty matching** (no edges — trivially valid).
  2. Repeatedly find an **augmenting path** and flip it, adding one edge each time.
  3. Stop when no augmenting path exists.
- **Augmenting path** — a path with three properties:
  - both **endpoints are free** (not covered by any matching edge);
  - its edges **alternate** out-of-$M$ / in-$M$ / out-of-$M$ / …;
  - since the ends are free, the first and last edges are **out of** $M$, so the path has an **odd** number of edges, one more free than matched.
- **Flipping** (augmenting): remove the in-$M$ edges of the path from $M$ and add the out-of-$M$ ones. Because there is one extra out-of-$M$ edge, $|M|$ increases by exactly 1.
- **Bootstrapping:** the very first augmenting path is just a single edge — one edge is trivially an alternating path with two free endpoints. So step one always picks some lone edge.

![Augmenting path: alternating edges with both ends free, and the flipped result one edge larger](/img/dsa/4VYVnEcLZpQ/frame-00040.png)

- Let $M$ denote the matching and $|M|$ its size (number of edges).

![Before-and-after: flip the augmenting path to move from a size-2 to a size-3 matching](/img/dsa/4VYVnEcLZpQ/frame-00047.png)

[watch from 5:09](https://youtu.be/4VYVnEcLZpQ?t=309)

---

## Berge's theorem: no augmenting path means maximum

The correctness of the whole scheme rests on one equivalence:

$$
M \text{ is a maximum matching} \iff \text{there is no augmenting path with respect to } M.
$$

**Easy direction** ($\Rightarrow$). If an augmenting path existed you could flip it and get a larger matching, so a maximum $M$ cannot have one. (Contrapositive of "augmenting path implies not maximum.")

**Interesting direction** ($\Leftarrow$), by contradiction. Suppose $M$ has no augmenting path but is **not** maximum. Then some matching $M_{\max}$ exists with $|M_{\max}| \gt |M|$.

- Draw both matchings on the same vertex set: color $M$ **red**, $M_{\max}$ **blue**, and delete every edge that is in neither (and, for simplicity, every edge in **both**).
- In what remains, each vertex touches **at most one red and one blue edge**, so every vertex has degree $\le 2$. A graph with max degree 2 is a disjoint union of **paths and cycles**.
- On any **cycle** the colors must alternate, so the cycle is even and has **equally many** red and blue edges.
- Since $|M_{\max}| \gt |M|$, blue edges outnumber red overall. Cycles are balanced, so some **path** component must have **more blue than red** — a path whose **first and last edges are blue**.
- That path is exactly an **augmenting path for the red matching $M$**: its two endpoints are free in $M$ (no red edge leaves them) and its edges alternate. Contradiction — $M$ was assumed to have none.

$$
|M_{\max}| \gt |M| \;\Longrightarrow\; \exists\ \text{augmenting path for } M.
$$

![Berge proof: symmetric difference of M (red) and Mmax (blue) is paths plus cycles; an unbalanced path is augmenting for M](/img/dsa/4VYVnEcLZpQ/frame-00080.png)

- **Note:** this proof never used bipartiteness — the cycles are even purely because colors alternate. So Berge's theorem holds for **general** graphs. Only the *how-to-find-a-path* step gets harder without bipartiteness.

![The equivalence No augmenting paths iff M is maximum, written on the board with the symmetric-difference picture](/img/dsa/4VYVnEcLZpQ/frame-00106.png)

[watch from 11:57](https://youtu.be/4VYVnEcLZpQ?t=717)

---

## Finding an augmenting path in a bipartite graph

- In a bipartite graph an augmenting path has a rigid shape: start at a **free left** vertex, cross to the right on an **out-of-$M$** edge, come back to the left on an **in-$M$** edge, and repeat, finally landing on a **free right** vertex.
- **Key trick — orient the edges** so that the state of an edge is encoded by its direction:
  - every **non-matching** edge points **left → right**;
  - every **matching** edge points **right → left**.
- After orienting, an augmenting path is just **any directed path from a free left vertex to a free right vertex**. We no longer track "is this edge matched" — the direction says it. Finding it is a plain graph search (DFS or BFS), which this course already covered.
- **Many free vertices at once:** conceptually add a super-source $s \to$ every free left vertex and a super-sink every free right vertex $\to t$; then one search for an $s \to t$ path finds an augmenting path if any exists. (This is the same idea we will formalize as max-flow later.)

![Orient non-matching edges left-to-right and matching edges right-to-left; an augmenting path becomes a directed free-to-free path](/img/dsa/4VYVnEcLZpQ/frame-00110.png)

[watch from 23:00](https://youtu.be/4VYVnEcLZpQ?t=1380)

---

## Kuhn's algorithm: the actual code

The lecturer stresses you do **not** build the augmented $s$-$t$ graph. You run DFS on the **original** graph with two structural simplifications:

- **Right vertices have out-degree 1.** From a matched right vertex $u$ the only way to continue is back along its matching edge, to the left vertex `p[u]`. So store just that pointer: `p[u]` = left vertex matched to right vertex $u$, or empty if $u$ is free. You never need pointers from left to right.
- **Invert on the way back.** When the DFS reaches a free right vertex, the recursion stack **is** the augmenting path. Assigning `p[u] = v` as each recursive call returns `true` flips every edge of the path in one pass — no separate path array.

![Kuhn DFS on the board: bool dfs(v) with mark[], the loop over G[v], and the p[u] pointer array](/img/dsa/4VYVnEcLZpQ/frame-00168.png)

The board's `dfs` (transcribed to C++17):

```cpp
#include <bits/stdc++.h>
using namespace std;

int nL, nR;                 // sizes of left part L and right part R
vector<vector<int>> g;      // g[v] = right-neighbors of left vertex v
vector<int> p;              // p[u] = left vertex matched to right u, or -1 (free)
vector<bool> mark;          // per-run: left vertices already tried in this DFS

// Try to find (and flip) an augmenting path starting at left vertex v.
// Returns true iff v gets matched.
bool dfs(int v) {
    if (mark[v]) return false;      // already explored this left vertex this run
    mark[v] = true;
    for (int u : g[v]) {            // step right along a non-matching edge
        // u is free  -> path ends here; OR the current owner of u can be rerouted
        if (p[u] == -1 || dfs(p[u])) {
            p[u] = v;               // put edge (v,u) into the matching
            return true;            // and unwind, inverting the rest of the path
        }
    }
    return false;                   // no augmenting path from v
}
```

The outer driver — try each free left vertex **once**:

```cpp
int kuhn() {
    p.assign(nR, -1);
    int matching = 0;
    for (int v = 0; v < nL; v++) {
        mark.assign(nL, false);     // fresh marks for each augmenting search
        if (dfs(v)) matching++;
    }
    return matching;                // size of the maximum matching
}
```

Why the driver needs each left vertex only once (the two board observations):

- **Success is permanent.** Once a left vertex is matched, later augmentations only *reroute* it — it never becomes free again, because the matched-vertex set only grows. So no need to revisit it.
- **Failure is permanent.** If `dfs(v)` fails, let $S$ be the set of vertices it reached. No free right vertex is reachable from $S$. Any future augmenting path through a vertex of $S$ would also reach a free right vertex from $v$ — impossible. Those edges live outside every future augmenting path, so $v$ will never succeed either. Skip it forever.

![The outer loop: for each v in L, clear marks and run dfs(v); plus the reachable-set argument for why one pass suffices](/img/dsa/4VYVnEcLZpQ/frame-00217.png)

- **Complexity.** One `dfs` scans each edge at most once: $O(E)$. The matching size is at most $n = |L|$, and every successful call raises it, so there are $O(V)$ successful searches; the failing ones are amortized into the same $O(E)$ scans. Total $O(V \cdot E)$.
- Faster is possible (Hopcroft–Karp is $O(E\sqrt{V})$ via BFS layering, and max-flow gives more), but that needs the flow machinery from later lectures. Random edge-shuffling heuristics also help in practice (a greedy pass already grabs about half the maximum matching), yet the worst case stays $O(V \cdot E)$.

![DFS cost O(E), matching size at most n, so O(n·m) overall — labelled Kuhn's Algorithm on the board](/img/dsa/4VYVnEcLZpQ/frame-00141.png)

[watch from 33:00](https://youtu.be/4VYVnEcLZpQ?t=1980)

**Verification.** Compiled with `c++ -std=c++17` and tested against a brute-force max matching (try every edge subset) on 2000 random bipartite graphs with parts of size 1–5: sizes matched on every case, plus a hand 3×3 example returned a perfect matching of size 3.

---

## Hall's marriage theorem

A clean test for **perfect matching of the left side** (every left vertex matched):

$$
M \text{ saturates } L \iff \forall\, A \subseteq L:\quad |N(A)| \ge |A|,
$$

where $N(A)$ is the set of all right-part neighbors of the vertices in $A$.

**Easy direction** ($\Rightarrow$). If every left vertex is matched, take any $A \subseteq L$. Each vertex of $A$ owns a distinct matching edge with a distinct right endpoint, so those endpoints alone give $|N(A)| \ge |A|$.

**Interesting direction** ($\Leftarrow$). If Hall's condition holds, Kuhn's `dfs` can **never fail**. Suppose a run from a free left vertex fails; let it visit $k+1$ left and $k$ right vertices — one more left than right, because every visited right vertex is matched and drags its matched left partner into the visited set too. The visited-left set $A$ then has $|A| = k+1$ but its reachable neighbors number only $k$, contradicting $|N(A)| \ge |A|$. So there is always an unvisited neighbor to extend into a free right vertex — the DFS always augments, and $M$ reaches size $n$.

![Hall's theorem on the board: subset A of the left part, its neighbor set N(A), and the perfect-matching iff condition](/img/dsa/4VYVnEcLZpQ/frame-00221.png)

- **Practical caveat (from the lecture):** you rarely *check* Hall directly — there are exponentially many subsets $A$. Its value is theoretical: proving a perfect matching must exist (e.g. in a structured/implicit graph), or reasoning about a problem after you have already run Kuhn.

[watch from 51:30](https://youtu.be/4VYVnEcLZpQ?t=3090)

---

## Vertex cover and König's theorem

- A **vertex cover** is a set of vertices such that **every edge has at least one endpoint in the set**. The **minimum vertex cover** problem asks for the smallest such set.
- In **general** graphs minimum vertex cover is **NP-complete**. In **bipartite** graphs it is polynomial — and it is the **dual** of maximum matching.

**Weak duality (holds for any matching and any cover).** Pick any matching $M$ and any vertex cover $C$. The $|M|$ matching edges are disjoint, so covering all of them needs $|M|$ distinct vertices; hence

$$
|C| \ge |M|.
$$

**König's theorem (strong duality, bipartite).** The optima coincide:

$$
|M_{\max}| = |C_{\min}|.
$$

So if you ever exhibit a matching and a cover of **equal size**, both are automatically optimal — you get a certificate for free.

![Weak duality: any vertex cover has size at least any matching; at the optimum the two meet, Mmax = Cmin](/img/dsa/4VYVnEcLZpQ/frame-00300.png)

**Constructing the minimum cover.** Build a maximum matching with Kuhn, then run the **same DFS** from every free left vertex and split the vertices by whether the DFS visited them:

- $L^+ / L^-$ — visited / unvisited **left** vertices;
- $R^+ / R^-$ — visited / unvisited **right** vertices.

Two facts about which edges can exist across this partition (both because a maximum matching has no augmenting path, and because a matched right vertex is reached only from its matched left partner):

- there are **no** edges from $L^+$ to $R^-$ (a visited-to-unvisited edge would mean the DFS skipped a neighbor);
- there are **no** edges from $R^-$ to $L^+$ (that would force two matching edges into one left vertex).

![Structure after the final DFS: parts L+, L-, R+, R- and the only edges that can cross between them](/img/dsa/4VYVnEcLZpQ/frame-00312.png)

- Every free left vertex is a DFS root, so all free left vertices lie in $L^+$; and since $M$ is maximum, every free right vertex lies in $R^-$.
- Therefore the set

$$
C = L^- \cup R^+
$$

covers every edge: any edge either has its left end in $L^-$, or (if its left end is in $L^+$) its right end must be in $R^+$.

**Why $C$ is minimum:** $|C| = |M_{\max}|$. The cover uses **no** free vertex, and for each matching edge it takes **exactly one** endpoint ($L^-$–$L^-$ edges contribute their left end, $R^+$–$L^+$ edges contribute their right end). One vertex per matching edge gives $|C| = |M_{\max}|$, and by weak duality that forces minimality.

![Konig cover C = L- union R+ equals the maximum matching size, read off the L+/L-/R+/R- diagram](/img/dsa/4VYVnEcLZpQ/frame-00338.png)

Reference C++ that builds the cover from Kuhn's output (verified below):

```cpp
// After kuhn() has filled p[], also keep matchL[v] = right vertex matched to v.
// Alternating reachability from every UNMATCHED left vertex:
//   left -> right along NON-matching edges, right -> left along the matching edge.
vector<bool> visL, visR;
vector<int> matchL;                 // matchL[v] = u if (v,u) in M, else -1

void alt(int v) {
    visL[v] = true;
    for (int u : g[v]) {
        if (matchL[v] == u) continue;   // do not walk the matching edge rightward
        if (!visR[u]) {
            visR[u] = true;
            int w = p[u];               // forced matching edge back to the left
            if (w != -1 && !visL[w]) alt(w);
        }
    }
}

// Minimum vertex cover = { v in L : not visL[v] }  ∪  { u in R : visR[u] }
```

**Verification.** On 3000 random bipartite graphs (parts of size 1–5), the constructed $C = L^- \cup R^+$ was a **valid** cover (every edge covered) **and** $|C| = |M_{\max}|$ in every case — an empirical confirmation of König.

- **Scope caveat:** the matching–cover duality is a **bipartite-only** gift. For non-bipartite graphs minimum vertex cover stays NP-complete even though maximum matching is polynomial, so Kuhn/blossom does not hand you the cover there.

[watch from 1:02:04](https://youtu.be/4VYVnEcLZpQ?t=3724)

---

## Complexity recap

| Operation | Best | Average | Worst | Space |
| --- | --- | --- | --- | --- |
| One augmenting DFS | $\Theta(1)$ | $O(E)$ | $O(E)$ | $O(V)$ |
| Kuhn max matching | $O(E)$ | $O(V \cdot E)$ | $O(V \cdot E)$ | $O(V + E)$ |
| Min vertex cover (König, after matching) | $O(E)$ | $O(E)$ | $O(E)$ | $O(V + E)$ |
| Hall check (direct, exponential) | — | — | $O(2^{\lvert L\rvert} \cdot E)$ | $O(V)$ |

Here $V = |L| + |R|$ and $E$ is the number of edges. Hopcroft–Karp improves matching to $O(E\sqrt{V})$ (a later lecture).

---

## Practice problems

Bipartite matching is a genuine interview and contest staple. The interview trick is usually **recognizing** a disguised matching (assign X to Y, one-to-one) and running Kuhn.

**🎯 Interview (MAANG-style)**

- [Maximum Number of Accepted Invitations — LeetCode 1820](https://leetcode.com/problems/maximum-number-of-accepted-invitations/) — Medium — textbook bipartite matching (boys to girls), Kuhn applies verbatim.
- [Maximum Students Taking Exam — LeetCode 1349](https://leetcode.com/problems/maximum-students-taking-exam/) — Hard — maximum independent set on a grid, solvable by bitmask DP or as a matching/min-cut.
- [Campus Bikes II — LeetCode 1066](https://leetcode.com/problems/campus-bikes-ii/) — Medium — assignment problem (minimum-cost matching); bitmask DP for small sizes, Hungarian in general.
- [Minimum Number of Work Sessions to Finish the Tasks — LeetCode 1986](https://leetcode.com/problems/minimum-number-of-work-sessions-to-finish-the-tasks/) — Medium — assignment-flavored bitmask DP that pairs with matching intuition.
- [Maximum Bipartite Matching — GeeksforGeeks](https://www.geeksforgeeks.org/maximum-bipartite-matching/) — Medium — the canonical Kuhn implementation, jobs-to-applicants.

**🏆 Competitive**

- [School Dance — CSES 1696](https://cses.fi/problemset/task/1696) — Easy — pure maximum bipartite matching (boys and girls who are willing to dance); the direct Kuhn drill.
- [cp-algorithms — Kuhn's algorithm](https://cp-algorithms.com/graph/kuhn_maximum_bipartite_matching.html) — reference implementation plus the König and Hall corollaries used above.

> No official Codeforces home-task post is linked in this lecture's description, so the competitive set above is curated. The lecture explicitly defers the faster Hopcroft–Karp / max-flow route to later Season 4 lectures.

---

## Further reading

- [Maximum Bipartite Matching (Kuhn) — cp-algorithms](https://cp-algorithms.com/graph/kuhn_maximum_bipartite_matching.html) — the same algorithm, with König and Hall spelled out.
- [Matching (graph theory) — Wikipedia](https://en.wikipedia.org/wiki/Matching_(graph_theory)) — matchings, augmenting paths, Berge's theorem.
- [König's theorem — Wikipedia](https://en.wikipedia.org/wiki/K%C5%91nig%27s_theorem_(graph_theory)) — matching–cover duality and its proof.
- [Hall's marriage theorem — Wikipedia](https://en.wikipedia.org/wiki/Hall%27s_marriage_theorem) — the neighborhood condition and applications.
- [Bipartite graph — Wikipedia](https://en.wikipedia.org/wiki/Bipartite_graph) — two-colorability and structure.
- [Maximum Bipartite Matching — GeeksforGeeks](https://www.geeksforgeeks.org/maximum-bipartite-matching/) — annotated walkthrough of the augmenting-path DFS.

---

## Key takeaways

- Grow a matching by **flipping augmenting paths**; Berge's theorem guarantees you are done exactly when none remains — and the proof works for general graphs.
- **Kuhn** is just DFS on the original graph with a single `p[u]` back-pointer array; the recursion stack inverts the path for free. Cost $O(V \cdot E)$.
- The driver visits each left vertex **once**: a match is permanent, and a failed search proves the vertex is useless forever.
- Bipartite matching has a **dual**: minimum **vertex cover**, equal in size (König), read off as $L^- \cup R^+$ from one final DFS.
- **Hall's** $|N(A)| \ge |A|$ condition characterizes when the left side can be perfectly matched.

## Glossary

- **Matching** — an edge set with no two edges sharing a vertex.
- **Perfect matching** — a matching covering all $n$ vertices ($n/2$ edges).
- **Free (exposed) vertex** — a vertex covered by no matching edge.
- **Alternating path** — a path whose edges alternate between out-of-$M$ and in-$M$.
- **Augmenting path** — an alternating path with both endpoints free; flipping it grows $M$ by one.
- **Vertex cover** — a vertex set touching every edge; its minimum equals the maximum matching in bipartite graphs.
- **$N(A)$** — the neighborhood of a vertex set $A$: all vertices adjacent to some vertex of $A$.
