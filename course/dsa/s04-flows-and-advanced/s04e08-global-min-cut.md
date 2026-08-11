---
title: "S04E08 · Global Minimum Cuts"
sidebar_position: 8
description: The global min-cut over all vertex pairs on an undirected weighted graph, solved three ways — an n-run max-flow reduction, the deterministic Stoer-Wagner maximum-adjacency algorithm in O(V cubed), and Karger plus Karger-Stein randomized contraction with the full success-probability analysis.
---

# S04E08 · Global Minimum Cuts

> **Source:** Pavel Mavrin, [_A&DS S04E08_](https://youtu.be/wyePqFk7prs) · 1h32m lecture → ~16 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- The **global min cut** asks for the cheapest set of edges whose removal disconnects an **undirected weighted** graph — with **no fixed** $s$ and $t$. That is the difference from the $s$–$t$ min cut of the flows lectures.
- **Naive reduction:** run an $s$–$t$ min cut for every pair — $\Theta(n^2)$ max-flow calls. **Fix one vertex** as $s$ and only vary $t$ to drop it to $n$ calls: any global cut separates vertex $1$ from *something*.
- **Merge trick:** pick any two vertices $s,t$; either they are split by the optimal cut (a single $s$–$t$ min cut finds it), or they are on the same side (**merge** them and recurse). Either way one max-flow call per round, $n$ rounds.
- **Stoer-Wagner** replaces the max-flow inside each round with a **maximum adjacency ordering**: grow a set $A$ by always absorbing the most tightly connected vertex; the **last** vertex $t$ gives a legal $s$–$t$ cut for free (weight = sum of $t$'s edges). Merge the last two, repeat. Fully deterministic, $O(V^3)$, no flow at all.
- **Karger** guesses instead of computing: contract a **random edge** (its endpoints are probably on the same side) until two vertices remain; the surviving multi-edge is a candidate cut. One run is $O(V^2)$ but only succeeds with probability $\ge \tfrac{2}{n(n-1)}$, so run $\Theta(n^2)$ times.
- **Karger-Stein** contracts only down to $n/\sqrt{2}$ vertices (where success is still $\approx \tfrac12$) then recurses **twice**. That lifts success to $\Omega(1/\log n)$ and runs in $O(n^2 \log n)$ per attempt — the fastest of the lot.

---

## The global cut problem

- **Input.** A connected undirected graph with a non-negative **weight** $w_e$ on every edge.
- **Output.** A partition of the vertices into two non-empty sides; the **cost** is the total weight of edges crossing between the sides. Minimize it.
- Equivalently: the cheapest edge set whose removal makes the graph **disconnected**.
- **The running example** (used all lecture): five vertices, weights $6,5,3,7,1,3,\ldots$ on the edges. Removing the two edges of total weight $8$ around one vertex disconnects it.

![Undirected weighted graph with edge weights 3, 6, 5, 3, 7 on five nodes; the global cut problem is to disconnect it as cheaply as possible](/img/dsa/wyePqFk7prs/frame-00007.png)

- **Why it is different from the $s$–$t$ min cut** (the flows version): there you are *given* two vertices and must separate *those two*. Here there are **no fixed endpoints** — you only need the graph to fall apart somewhere.
- You **cannot** fake it by merging all vertices into one $s$ and one $t$. And wiring every vertex to a super-$s$ with infinite-capacity edges backfires: the min cut then just severs $s$'s own infinite edges, telling you nothing.

[watch from 2:26](https://youtu.be/wyePqFk7prs?t=146)

---

## Reduction to s–t min cut

- The problem is polynomial because we already know how to compute an $s$–$t$ min cut (max-flow min-cut, S04E03). A global cut splits the graph into components; **some** pair $(s,t)$ lands on opposite sides.
- **Naive:** try all pairs.

```text
res = +infinity
for s in 1..n:
    for t in s+1..n:
        res = min(res, min_cut(s, t))     # one max-flow call
return res
```

- Cost: $\Theta(n^2)$ max-flow calls $= O(n^2 \cdot \text{flow})$.
- **Key saving — fix one endpoint.** Look at vertex $1$. Whatever the optimal global cut is, vertex $1$ lands on one side; at least one **other** vertex $t$ lands on the far side. So iterating $t = 2 \ldots n$ with $s$ fixed to $1$ already hits the optimum.

```text
res = +infinity
s = 1
for t in 2..n:
    res = min(res, min_cut(s, t))         # only n-1 calls now
return res
```

- Cost drops to $O(n \cdot \text{flow})$ (the board writes it $O(n \cdot nm)$ for an $nm$ flow).

![Board: the s=1, for t in 2..n min-cut loop at O(n · flow), above the while-loop merge formulation](/img/dsa/wyePqFk7prs/frame-00068.png)

[watch from 6:03](https://youtu.be/wyePqFk7prs?t=363)

---

## The merge formulation

- A second angle that will become the skeleton for Stoer-Wagner. Pick **any** two vertices $s,t$ (random is fine). In the unknown optimal cut, either:
  - **they are separated** — then $\text{min\_cut}(s,t)$ *is* a candidate for the global answer, so record it; or
  - **they are on the same side** — then we lose nothing by **merging** $s$ and $t$ into one super-vertex (same name, union of incident edges, parallel edges allowed) and solving the smaller graph.
- **Why merging is safe:** if $s,t$ share a side, no minimum cut passes *between* them, so fusing them cannot change the value of any relevant cut.

```text
while n >= 2:
    (s, t) = some two nodes
    res = min(res, min_cut(s, t))
    merge(s, t)                           # n -> n-1 vertices
return res
```

- **Merge cost.** Concatenate the two edge lists, delete the two old vertices, insert one new vertex — $O(n)$ (at most $n$ incident edges; parallel edges are kept, they do not hurt).
- Each round removes one vertex, so $n$ rounds. The bottleneck is still the max-flow inside, so total is the same $O(n \cdot \text{flow})$ — **but** the merge structure is what lets us throw the flow away next.

![Board: the merge example on five nodes — pick s,t, take min-cut 9 then 4, merge into super-nodes one-three and two-five, tracking cut-of-the-phase down to 11](/img/dsa/wyePqFk7prs/frame-00073.png)

[watch from 11:53](https://youtu.be/wyePqFk7prs?t=713)

---

## Stoer-Wagner: maximum adjacency ordering

The magic step. Instead of asking max-flow for an $s$–$t$ min cut, we let the algorithm **choose** its own $s,t$ — and then the cut between them is free to read off.

**Maximum adjacency ordering.** Grow an ordered set $A$:

- Start $A$ with any one vertex.
- Repeatedly add the vertex $v \notin A$ maximizing its connection weight into $A$:

$$
W(v, A) \;=\; \sum_{u \in A} w_{vu}, \qquad \text{pick } v : W(v,A) = \max, \quad A \leftarrow A \cup \{v\}.
$$

- The **last two** vertices in this order are $s$ (second-to-last) and $t$ (last). On the example the order comes out $1,3,2,5,4$ so $t=4$, $s=5$.

![Board: the rule W(v,A) equals sum of edge weights from v into A, pick the max, add to A. Ordering 1 3 2 5 4 with t and s being the last two](/img/dsa/wyePqFk7prs/frame-00131.png)

**The cut-of-the-phase.** The claim that makes it work:

$$
\text{min\_cut}(s, t) \;=\; \sum_{v} w_{t v} \;=\; W(t, A \setminus \{t\}),
$$

i.e. the $s$–$t$ min cut is exactly the weight of **all edges touching the last vertex** $t$. So each ordering hands you a legal $s$–$t$ cut with zero extra work — just the running sum when $t$ was absorbed.

- Record that cut-of-the-phase, then **merge $s$ and $t$** and repeat the ordering on the shrunk graph. After $n-1$ phases only one vertex remains; the **minimum over all phases** is the global min cut.

```cpp
#include <bits/stdc++.h>
using namespace std;

// Stoer-Wagner global minimum cut on an undirected weighted graph.
// w is an n x n symmetric matrix of non-negative edge weights (0 = no edge).
// Returns the weight of the minimum cut over ALL vertex pairs. O(V^3).
long long stoer_wagner(vector<vector<long long>> w) {
    int n = (int)w.size();
    vector<int> vertices(n);
    iota(vertices.begin(), vertices.end(), 0);   // active "super-nodes"
    long long best = LLONG_MAX;

    while ((int)vertices.size() > 1) {
        int m = (int)vertices.size();
        vector<long long> wsum(m, 0);            // W(v, A): weight from v into set A
        vector<bool> inA(m, false);
        int prev = -1, last = -1;

        // Maximum adjacency ordering: repeatedly absorb the most tightly
        // connected vertex into A. The last vertex absorbed is t, the one
        // before it is s; cut-of-the-phase = W(t, A) = sum of t's edges.
        for (int i = 0; i < m; i++) {
            int sel = -1;
            for (int j = 0; j < m; j++)
                if (!inA[j] && (sel == -1 || wsum[j] > wsum[sel])) sel = j;
            inA[sel] = true;
            prev = last;
            last = sel;
            if (i + 1 == m) best = min(best, wsum[sel]);   // cut-of-the-phase
            for (int j = 0; j < m; j++)
                if (!inA[j]) wsum[j] += w[vertices[sel]][vertices[j]];
        }

        // Merge t (last) into s (prev): fold t's edges onto s, drop t.
        int s = vertices[prev], t = vertices[last];
        for (int j = 0; j < n; j++) { w[s][j] += w[t][j]; w[j][s] += w[j][t]; }
        vertices.erase(vertices.begin() + last);
    }
    return best;
}
```

- **Data structure.** To pick the max $W(v,A)$ and bump neighbours after each absorption, a priority structure over the unmarked vertices. A binary heap gives $O(m \log n)$ per phase; a Fibonacci heap gives $O(m + n \log n)$. The dense adjacency-matrix version above is the simplest and is $O(n^2)$ per phase.
- **Total:** $n$ phases $\times\ O(n^2)$ each $= \boxed{O(V^3)}$ (or $O(nm + n^2 \log n)$ with a Fibonacci heap) — and **no max-flow anywhere**.

![Board: min_cut(s,t) equals the sum of weights on edges incident to s, drawn as the cut C separating the last two nodes](/img/dsa/wyePqFk7prs/frame-00148.png)

[watch from 27:19](https://youtu.be/wyePqFk7prs?t=1639)

---

## Why the last vertex gives an s–t min cut

The one theorem behind Stoer-Wagner. Fix the adjacency order and let $C$ be **any** $s$–$t$ min cut (recall $s,t$ are the last two vertices). Call a vertex $v$ **active** if the vertex just before it in the order sits on the *opposite* side of $C$ — the first vertex of each run of same-side vertices.

- For a vertex $v$, define $A_v$ = the vertices ordered before $v$, and:

$$
W(v, A_v) = \sum_{u \in A_v} w_{vu}, \qquad
C_v = \sum_{\substack{e \in C \\ \text{both ends} \le v}} w_e .
$$

- **Claim (by induction along active vertices):** for every active $v$,

$$
W(v, A_v) \;\le\; C_v .
$$

- **Inductive step.** Let $u$ be the previous active vertex. Split $v$'s back-edges at $u$:

$$
W(v, A_v) = W(v, A_u) + W\big(v,\, \{u, \ldots, v{-}1\}\big).
$$

Because the ordering always took the **max-connected** vertex, $u$ was chosen over $v$, so $W(v, A_u) \le W(u, A_u) \le C_u$ (last step is the induction hypothesis). Every edge counted in the second term crosses into the block ending at $v$ and therefore lies in $C_v$. Adding: $W(v,A_v) \le C_u + (\text{edges in } C_v) \le C_v$. $\;\blacksquare$

- **Punchline.** $s$ is active (its predecessor $t$ is on the other side of $C$), so $W(s, A_s) \le C_s = |C|$. But cutting **all** edges out of the last vertex is itself a valid cut of that exact weight, and no cut can beat the minimum — so it **equals** the min cut. The cut-of-the-phase is genuinely $\text{min\_cut}(s,t)$.

![Board: the induction — W(v, A_v) equals W(v, A_u) plus W(v, u..v-1), each bounded by C_u and by edges of C_v, giving W(v, A_v) at most C_v](/img/dsa/wyePqFk7prs/frame-00210.png)

[watch from 38:17](https://youtu.be/wyePqFk7prs?t=2297)

---

## Karger's randomized contraction

Drop determinism for speed. Take an **unweighted** graph (every edge weight $1$; parallel edges accumulate). We never run max-flow — we **guess**.

- Pick a **uniformly random edge** and look at its two endpoints. A random edge most likely joins two vertices on the **same** side of the optimal cut, so **contract** it (merge the endpoints, keep parallel edges).
- Repeat until only **two** super-vertices remain. The number of edges between them is a **candidate** min cut.

```cpp
#include <bits/stdc++.h>
using namespace std;

// Karger's randomized contraction for the global min cut of an UNWEIGHTED graph
// (each parallel edge counts as weight 1). One run is O(V^2) with an adjacency
// matrix of multiplicities. Returns the edge count between the final two groups.
long long karger_once(vector<vector<long long>> g, mt19937_64& rng) {
    int n = (int)g.size();
    vector<int> alive(n);
    iota(alive.begin(), alive.end(), 0);
    while ((int)alive.size() > 2) {
        // Pick a random edge with probability proportional to its multiplicity.
        long long total = 0;
        for (int i : alive) for (int j : alive) if (i < j) total += g[i][j];
        long long r = (long long)(rng() % (unsigned long long)total);
        int su = -1, sv = -1;
        for (int i : alive) { for (int j : alive) if (i < j) {
            r -= g[i][j]; if (r < 0) { su = i; sv = j; break; } } if (su != -1) break; }
        for (int k : alive) if (k != su && k != sv) {   // contract sv into su
            g[su][k] += g[sv][k]; g[k][su] += g[k][sv];
        }
        g[su][sv] = g[sv][su] = 0;
        alive.erase(find(alive.begin(), alive.end(), sv));
    }
    return g[alive[0]][alive[1]];
}

// Best of many independent runs (each run is one random guess).
long long karger(const vector<vector<long long>>& g, int trials, mt19937_64& rng) {
    long long best = LLONG_MAX;
    for (int t = 0; t < trials; t++) best = min(best, karger_once(g, rng));
    return best;
}
```

- One run contracts $n-2$ times, each $O(n)$, so **one run is $O(n^2)$**.
- It is a **Monte Carlo** algorithm: the *running time* is fixed but the *answer* may be wrong (unlike quicksort or treaps, where randomness affects only time). And you cannot even tell when it is wrong.

![Board: contracting random edges 3-5, then 1-2, until two super-nodes one-two and three-four-five remain, giving min-cut = 3 in O(n squared)](/img/dsa/wyePqFk7prs/frame-00248.png)

[watch from 51:00](https://youtu.be/wyePqFk7prs?t=3060)

---

## Success probability of one run

A run fails exactly when it ever contracts an edge that belongs to the min cut $C$. Bound the chance of that.

- **Bound the cut size.** The min cut is at most the **minimum degree** (severing one vertex's edges is a valid cut), and minimum degree $\le$ average degree:

$$
|C| \;\le\; \min_v \deg(v) \;\le\; \frac{1}{n}\sum_v \deg(v) \;=\; \frac{2m}{n}.
$$

- **First contraction.** With $m$ edges, the chance the random edge lies in $C$ is $\le \tfrac{|C|}{m} \le \tfrac{2}{n}$, so we survive step one with probability $\ge 1 - \tfrac{2}{n} = \tfrac{n-2}{n}$.
- The graph now has $n-1$ vertices; the same bound gives $\tfrac{n-3}{n-1}$ next, and so on. Multiplying the whole chain **telescopes**:

$$
P(\text{success}) \;\ge\; \frac{n-2}{n}\cdot\frac{n-3}{n-1}\cdot\frac{n-4}{n-2}\cdots\frac{2}{4}\cdot\frac{1}{3}
\;=\; \frac{2}{n(n-1)} \;=\; \Theta\!\left(\frac{1}{n^2}\right).
$$

![Board: P(success) equals the telescoping product (n-2)/n · (n-3)/(n-1) ··· = 2/(n(n-1)), with C_min at most min deg at most 2m/n](/img/dsa/wyePqFk7prs/frame-00254.png)

- **Amplify by repetition.** One run wins with probability $p \ge \tfrac{2}{n(n-1)} \approx \tfrac{1}{n^2}$. Run it $k n^2$ independent times and take the best; failure needs *all* of them to fail:

$$
P(\text{fail all}) \;\le\; \left(1 - \frac{1}{n^2}\right)^{k n^2} \;\approx\; e^{-k}.
$$

- So $\Theta(n^2)$ runs give a **constant** success probability, and $k n^2$ runs push failure to $e^{-k}$ — pick $k = \ln\frac{1}{\varepsilon}$ for failure probability $\varepsilon$. **Total:** $O(n^2)$ per run $\times\ O(n^2 \log\frac1\varepsilon)$ runs $= O(n^4 \log\frac1\varepsilon)$.

[watch from 57:50](https://youtu.be/wyePqFk7prs?t=3470)

---

## Karger-Stein: recurse before the odds collapse

The product above only rots near the **end** — while the graph is still large the per-step survival is close to $1$. So stop contracting before it hurts, then branch.

- **Where does success hit $\tfrac12$?** Contracting from $n$ down to $k$ vertices succeeds with probability $\approx \dfrac{k(k-1)}{n(n-1)} \approx \dfrac{k^2}{n^2}$. Setting that to $\tfrac12$:

$$
\frac{k^2}{n^2} = \frac12 \;\Longrightarrow\; k = \frac{n}{\sqrt 2}.
$$

- **The algorithm.** Contract down to $n/\sqrt2$ vertices (still $\approx \tfrac12$ safe), then make **two independent recursive calls** on that smaller graph and keep the smaller result. Each level halves the vertex count over two steps ($n/\sqrt2/\sqrt2 = n/2$), branching like a binary tree of depth $\log n$.

![Board: contract to n/sqrt(2) where P is about 1/2, then split into two recursive branches; k = n/sqrt(2)](/img/dsa/wyePqFk7prs/frame-00292.png)

- **Time.** Contraction to $n/\sqrt2$ is $O(n^2)$, then two calls on $n/\sqrt2$:

$$
T(n) = n^2 + 2\,T\!\left(\frac{n}{\sqrt 2}\right).
$$

By the Master theorem, $\log_{\sqrt2} 2 = 2$, so $n^{\log_b a} = n^2$ matches the $n^2$ term — the **balanced** case — giving $\log n$ equal levels of $n^2$ work:

$$
T(n) = \Theta(n^2 \log n).
$$

![Board: the recurrence T(n) = n^2 + 2 T(n/sqrt 2), each of the log n levels costing n^2, so T(n) = n^2 lg n](/img/dsa/wyePqFk7prs/frame-00309.png)

- **Probability, by induction.** Let $L = \log_{\sqrt2} n$. A level succeeds if the contraction to $n/\sqrt2$ works ($\approx\tfrac12$) **and** at least one of the two recursive calls succeeds:

$$
P(n) = \frac12\left[\,1 - \big(1 - P(n/\sqrt2)\big)^2\,\right].
$$

Plugging the guess $P(n) \ge \dfrac{1}{\log_{\sqrt2} n}$ and simplifying the algebra ($2\log^2 n - 3\log n \ge 2\log^2 n - 4\log n + 2$, i.e. $\log n \ge 2$) closes the induction:

$$
P(\text{success}) \;\ge\; \frac{1}{\log_{\sqrt2} n} \;=\; \Omega\!\left(\frac{1}{\log n}\right).
$$

![Board: the induction P(n) at least 1/log_sqrt2(n), from P(n) = 1/2 · (1 - (1 - P(n/sqrt2))^2)](/img/dsa/wyePqFk7prs/frame-00327.png)

- Now only $O(\log n)$ repetitions reach constant success, so the total is $O(n^2 \log^2 n \cdot \log\frac1\varepsilon)$ — dramatically better than plain Karger's $O(n^4)$, and beating Stoer-Wagner's $O(n^3)$ / $O(nm)$ for dense graphs.

[watch from 1:09:23](https://youtu.be/wyePqFk7prs?t=4163)

---

## Weighted graphs

- Everything above assumed unit weights for the probability bound. To handle **weights**, only the random-edge draw changes: pick an edge with probability **proportional to its weight** (heavy edges more likely). The same $\le \tfrac{2}{n}$ per-step bound then holds, so all the analysis carries over. (The lecture leaves the proof as an exercise.)

[watch from 1:30:40](https://youtu.be/wyePqFk7prs?t=5440)

---

## Complexity recap

| Algorithm | Determinism | Time | Space | Notes |
| --- | --- | --- | --- | --- |
| All-pairs $s$–$t$ min cut | deterministic | $O(n^2 \cdot \text{flow})$ | $O(n^2)$ | naive reduction |
| Fixed-$s$ reduction | deterministic | $O(n \cdot \text{flow})$ | $O(n^2)$ | drop one loop |
| Merge + max-flow | deterministic | $O(n \cdot \text{flow})$ | $O(n^2)$ | skeleton for Stoer-Wagner |
| **Stoer-Wagner** | deterministic | $O(V^3)$ or $O(nm + n^2\log n)$ | $O(n^2)$ | no flow; heap for the ordering |
| Karger (one run) | Monte Carlo | $O(n^2)$ | $O(n^2)$ | success $\ge \tfrac{2}{n(n-1)}$ |
| Karger, amplified | Monte Carlo | $O(n^4 \log\tfrac1\varepsilon)$ | $O(n^2)$ | $\Theta(n^2)$ runs |
| **Karger-Stein** | Monte Carlo | $O(n^2 \log n)$ per attempt | $O(n^2)$ | success $\Omega(1/\log n)$ |

---

## Practice problems

Global min cut is an **advanced competitive / theory** topic — it essentially never appears verbatim in interview rounds. The nearest interview-relevant material is edge-connectivity and bridges; the real practice is on competitive judges.

**🎯 Interview (MAANG-style)**

- [Critical Connections in a Network — LeetCode 1192](https://leetcode.com/problems/critical-connections-in-a-network/) — Hard — find all **bridges** (edges whose removal disconnects the graph); the same "what disconnects a graph" flavor, solved with Tarjan low-link rather than min cut.
- [Number of Provinces — LeetCode 547](https://leetcode.com/problems/number-of-provinces/) — Medium — connected components; the base notion a cut breaks apart.
- [Minimum cut in a directed graph — GeeksforGeeks](https://www.geeksforgeeks.org/minimum-cut-in-a-directed-graph/) — Medium — the $s$–$t$ min cut via max-flow that the reduction sits on top of.

**🏆 Competitive**

- [Global Minimum Cut of Dynamic Star Augmented Graph — Library Checker (yosupo)](https://judge.yosupo.jp/problem/global_minimum_cut_of_dynamic_star_augmented_graph) — Hard — an online judge whose core is a Stoer-Wagner style global-min-cut computation (wrapped in a dynamic star-augmentation).
- [Stoer-Wagner reference implementation — cp-algorithms](https://cp-algorithms.com/graph/stoer_wagner_mincut.html) — a clean $O(V^3)$ template plus a short list of judges (e.g. classic UVa / SPOJ min-cut tasks) that accept it.

> No official Codeforces home-task post is linked from this lecture's description, so none is listed here.

---

## Further reading

- [Stoer-Wagner minimum cut — cp-algorithms](https://cp-algorithms.com/graph/stoer_wagner_mincut.html) — implementation and the maximum-adjacency correctness argument.
- [Stoer-Wagner algorithm — Wikipedia](https://en.wikipedia.org/wiki/Stoer%E2%80%93Wagner_algorithm).
- [Karger's algorithm — Wikipedia](https://en.wikipedia.org/wiki/Karger%27s_algorithm) and [Minimum cut — Wikipedia](https://en.wikipedia.org/wiki/Minimum_cut).
- [Karger's algorithm for minimum cut — GeeksforGeeks](https://www.geeksforgeeks.org/introduction-and-implementation-of-kargers-algorithm-for-minimum-cut/) — the contraction procedure with the probability derivation.

---

## Key takeaways

- The global min cut has **no fixed endpoints**; it reduces to $s$–$t$ min cut but you can fix $s$ and vary only $t$ — $n$ calls, not $n^2$.
- **Stoer-Wagner** removes flow entirely: a maximum-adjacency ordering makes the *last* vertex's total edge weight a free $s$–$t$ min cut; merge the last two, repeat, $O(V^3)$.
- **Karger** trades correctness for speed — contract random edges, one run is $O(n^2)$ but succeeds only $\ge \tfrac{2}{n(n-1)}$; amplify by $\Theta(n^2)$ runs.
- **Karger-Stein** stops contracting at $n/\sqrt2$ (still $\approx\tfrac12$ safe) and recurses twice — $O(n^2\log n)$ with success $\Omega(1/\log n)$, the fastest known.
- Weighted graphs need only one change to Karger: draw edges **proportional to weight**.

## Glossary

- **Global min cut** — cheapest edge set whose removal disconnects an undirected graph, over all vertex pairs.
- **$s$–$t$ min cut** — cheapest cut separating two *given* vertices; computed by max-flow.
- **Maximum adjacency ordering** — vertex order that always appends the vertex most heavily connected to the already-chosen set.
- **Cut-of-the-phase** — the $s$–$t$ min cut exposed at the end of one Stoer-Wagner ordering (weight of the last vertex's edges).
- **Contraction** — merging an edge's endpoints into one super-vertex, keeping parallel edges.
- **Monte Carlo algorithm** — fixed running time, possibly wrong answer, with a bounded failure probability.
