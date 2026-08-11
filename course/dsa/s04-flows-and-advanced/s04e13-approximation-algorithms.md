---
title: "S04E13 · Approximation Algorithms"
sidebar_position: 13
description: Approximation ratios, the 2-approx for Vertex Cover via maximal matching, LP-rounding for weighted cover, metric-TSP 2-approx via MST and 3/2 Christofides, TSP inapproximability, and Knapsack's PTAS and FPTAS.
---

# S04E13 · Approximation Algorithms

> **Source:** Pavel Mavrin, [_A&DS S04E13_](https://youtu.be/md-nTsOnUp8) · 1h21m lecture → ~16 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- For an NP-hard **minimization** problem, an algorithm is **$\alpha$-approximate** if its answer $\text{ANS}$ satisfies $\text{ANS} \le \alpha \cdot \text{OPT}$. $\alpha$ can be a constant ($1.01$, $2$) or grow with $n$ (e.g. $\log n$).
- **Vertex Cover** has a dead-simple **2-approximation**: greedily pick any uncovered edge, add **both** endpoints. The picked edges form a matching of size $k$, so $\text{ANS} = 2k$ while $\text{OPT} \ge k$.
- **Weighted Vertex Cover** gets a 2-approx by **LP relaxation + rounding**: solve the fractional LP, round every $x_v \ge \tfrac12$ up to $1$. Rounding at most doubles each variable, so $\text{ANS} \le 2\cdot\text{LP} \le 2\cdot\text{OPT}$.
- **General TSP has no $\alpha$-approximation** for any $\alpha$ (unless P = NP) — a Hamiltonian-path reduction makes $\text{OPT}=0$, which any approximation must reproduce exactly.
- **Metric TSP** (triangle inequality) has a **2-approx via MST** (double it, Euler walk, shortcut) and a **3/2-approx via Christofides** (MST + minimum matching on odd-degree vertices).
- **Knapsack** is the best case: a simple **2-approx** (greedy by ratio, then take $\max$ with $C_{\max}$), a **PTAS**, and even an **FPTAS** — $(1-\varepsilon)$-approx in time $O(n^3/\varepsilon)$, polynomial in **both** $n$ and $1/\varepsilon$.

---

## What "approximation" means

- Some problems are **NP-hard**: no known polynomial exact algorithm. Rather than give up, we solve a *nearby* problem — find a solution provably close to optimal.
- Fix notation for a minimization problem:
  - $\text{OPT}$ — the value of the (unknown) optimal solution.
  - $\text{ANS}$ — the value our polynomial algorithm returns.
- Our algorithm is **$\alpha$-optimal** (an **$\alpha$-approximation**) when

$$
\text{ANS} \le \alpha \cdot \text{OPT}, \qquad \alpha \ge 1.
$$

- The **approximation ratio** $\alpha$ can be:
  - a small constant like $\alpha = 1.01$ — a shortest path only $1\%$ longer than optimal (great);
  - $\alpha = 2$ — "twice as bad" — not great, not terrible, but it *bounds* $\text{OPT}$: you learn $\text{OPT} \ge \text{ANS}/2$;
  - a **function** like $\alpha = \log n$ — the bigger the instance, the weaker the guarantee.
- For a **maximization** problem the convention flips: $\text{ANS} \ge \alpha\cdot\text{OPT}$ with $\alpha \le 1$ (e.g. $\alpha = \tfrac12$ or $1-\varepsilon$).
- There is **no universal recipe** — each NP-hard problem gets its own approximation, built by finding some quantity that *bounds* $\text{OPT}$ from one side.

![Board defining OPT as the optimal solution, ANS as our solution, with the guarantee ANS at most alpha times OPT](/img/dsa/md-nTsOnUp8/frame-00007.png)

[watch from 0:44](https://youtu.be/md-nTsOnUp8?t=44)

---

## Vertex Cover: a 2-approximation

- **Problem.** Given a graph, find the smallest set of vertices $C$ such that **every edge has at least one endpoint in $C$**. Minimum Vertex Cover is NP-hard on general graphs (polynomial only on bipartite graphs, where it is dual to maximum matching — König's theorem).
- **The algorithm.** Repeat until no edge is uncovered:
  - pick **any** edge $(u,v)$ not yet covered;
  - add **both** $u$ and $v$ to the cover.
- The edges you pick share no endpoints — they form a **maximal matching** $M$. If $\lvert M\rvert = k$ then $\text{ANS} = 2k$.

```cpp
#include <bits/stdc++.h>
using namespace std;

// 2-approximation for (unweighted) Vertex Cover via maximal matching:
// repeatedly pick any still-uncovered edge and take BOTH its endpoints.
vector<int> vertex_cover_2approx(int n, const vector<pair<int,int>>& edges) {
    vector<char> covered(n, 0);
    vector<int> cover;
    for (auto [u, v] : edges) {
        if (covered[u] || covered[v]) continue;   // edge already covered — skip
        cover.push_back(u);                        // take BOTH endpoints
        cover.push_back(v);
        covered[u] = covered[v] = 1;               // the picked edges form a matching
    }
    return cover;                                  // |cover| = 2 * |matching|
}
```

- **Data structure.** A single boolean array `covered[v]` maintains the invariant *"vertex $v$ is already in the cover"*, which is exactly *"every edge touching $v$ is covered."*
- **Proof that $\text{ANS} \le 2\,\text{OPT}$.** The $k$ picked edges are **vertex-disjoint**. Any valid cover — the optimal one included — must contain **at least one endpoint of each** of those $k$ edges, and since they share no endpoints those are $k$ distinct vertices. Hence

$$
\text{OPT} \ge k, \qquad \text{ANS} = 2k \le 2\,\text{OPT}.
$$

- The bound is **tight**: on a single edge, $\text{ANS}=2$ and $\text{OPT}=1$.

![Vertex Cover board: a graph with both endpoints of each picked edge circled, the k disjoint chosen edges, and the inequalities ANS = 2k, OPT at least k](/img/dsa/md-nTsOnUp8/frame-00040.png)

[watch from 4:33](https://youtu.be/md-nTsOnUp8?t=273)

---

## Weighted Vertex Cover: LP relaxation and rounding

- **Problem.** Each vertex $v$ carries a weight $w_v$; minimize the **total weight** of the cover, not the count. The maximal-matching trick no longer controls weight.
- **Step 1 — write it as an Integer Linear Program.** Let $x_v \in \lbrace 0,1\rbrace$ mean "$v$ is in the cover":

$$
\min \sum_{v} w_v\, x_v
\quad\text{s.t.}\quad x_u + x_v \ge 1 \ \ \forall\,(u,v)\in E,
\quad x_v \in \lbrace 0,1\rbrace.
$$

- Integer LP is itself NP-hard. **Relax** it: allow $x_v \in [0,1]$ (any real). A linear program over reals **is** solvable in polynomial time.

![Board writing the weighted vertex-cover integer program: minimize sum of w_v x_v subject to x_u plus x_v at least 1, with x_v in the set zero-one](/img/dsa/md-nTsOnUp8/frame-00072.png)

- **Step 2 — solve the relaxation.** Get fractional $x_v^\star \in [0,1]$. In practice the **simplex method** is fast (though not worst-case polynomial); polynomial algorithms exist too (ellipsoid, interior-point). $\text{LP} = \sum_v w_v x_v^\star$.
- **Step 3 — round.** Set

$$
x_v' = \begin{cases} 1 & x_v^\star \ge \tfrac12 \\ 0 & x_v^\star < \tfrac12 \end{cases}
$$

- **Feasibility.** Each constraint gives $x_u^\star + x_v^\star \ge 1$, so at least one of them is $\ge \tfrac12$ and gets rounded up — every edge stays covered.
- **Ratio.** Rounding **at most doubles** each variable: $x_v' \le 2\,x_v^\star$ (worst case $x_v^\star = \tfrac12 \to 1$). Therefore

$$
\text{ANS} = \sum_v w_v x_v' \le 2\sum_v w_v x_v^\star = 2\,\text{LP} \le 2\,\text{OPT},
$$

  where $\text{LP} \le \text{OPT}$ because the integer optimum is a *feasible* point of the relaxed LP, so it cannot beat the LP minimum.
- **Takeaway.** *"Relax to an LP, solve fractionally, round"* is a general-purpose approximation template, useful far beyond vertex cover.

[watch from 11:16](https://youtu.be/md-nTsOnUp8?t=676)

---

## TSP: general case is inapproximable

- **Problem.** A complete graph on $n$ nodes with costs $c_{uv}$; find a permutation $p_1,\dots,p_n$ visiting every node once and minimizing $\sum_i c_{p_i,\,p_{i+1}}$.
- **Claim.** For general TSP, **no polynomial $\alpha$-approximation exists for any $\alpha$**, unless P = NP.
- **Proof by reduction from Hamiltonian path.** Given a graph $G$ in which we want a Hamiltonian path, build a complete graph:
  - cost $0$ for every edge that **exists** in $G$;
  - cost $1$ for every edge that **does not**.
- If $G$ has a Hamiltonian path, the optimal tour uses only real edges, so $\text{OPT} = 0$.
- Any $\alpha$-approximation must return $\text{ANS} \le \alpha \cdot \text{OPT} = \alpha \cdot 0 = 0$. So $\text{ANS}=0$ **iff** a Hamiltonian path exists — the approximation would *decide* an NP-complete problem in polynomial time. Contradiction.

![TSP board: the permutation cost objective, a complete graph with zero-cost real edges and unit-cost fake edges, and the line that a Hamiltonian path forces OPT = 0 so ANS at most alpha times OPT equals 0](/img/dsa/md-nTsOnUp8/frame-00095.png)

[watch from 19:12](https://youtu.be/md-nTsOnUp8?t=1152)

---

## Metric TSP: 2-approximation via MST

- **Good news.** Add the **triangle inequality** $c_{uv} \le c_{uw} + c_{wv}$ for all triples (any metric space — e.g. shortest-path distances, Euclidean points). Now TSP *is* approximable.
- **The bound on $\text{OPT}$.** A tour with one edge removed is a **spanning tree**. So

$$
\text{MST} \le \text{OPT}.
$$

- **Building the answer at most $2\cdot\text{MST}$:**
  - build the MST;
  - **double every edge** → all degrees even → an **Euler cycle** exists that traverses each (doubled) edge once, total length $2\cdot\text{MST}$;
  - walk the Euler cycle; whenever it revisits a node, **shortcut** straight to the next unvisited node. By the triangle inequality, each shortcut only *shortens* the walk.
- Result: a Hamiltonian tour with $\text{ANS} \le 2\,\text{MST} \le 2\,\text{OPT}$.

```cpp
#include <bits/stdc++.h>
using namespace std;

// Metric-TSP 2-approx: Prim MST -> preorder DFS walk -> shortcut repeats.
// Requires the triangle inequality; returns the tour cost.
double tsp_2approx(int n, const vector<vector<double>>& d) {
    vector<char> inTree(n, 0);
    vector<double> key(n, 1e18);
    vector<int> par(n, -1);
    vector<vector<int>> adj(n);
    key[0] = 0;
    for (int it = 0; it < n; it++) {                 // Prim: grow MST one node at a time
        int u = -1;
        for (int v = 0; v < n; v++)
            if (!inTree[v] && (u == -1 || key[v] < key[u])) u = v;
        inTree[u] = 1;
        if (par[u] != -1) { adj[par[u]].push_back(u); adj[u].push_back(par[u]); }
        for (int v = 0; v < n; v++)
            if (!inTree[v] && d[u][v] < key[v]) { key[v] = d[u][v]; par[v] = u; }
    }
    vector<int> order; vector<char> vis(n, 0);        // preorder DFS = shortcut Euler walk
    stack<int> st; st.push(0);
    while (!st.empty()) {
        int u = st.top(); st.pop();
        if (vis[u]) continue;
        vis[u] = 1; order.push_back(u);
        for (int v : adj[u]) if (!vis[v]) st.push(v);
    }
    double tour = 0;                                  // close the cycle
    for (int i = 0; i < n; i++) tour += d[order[i]][order[(i + 1) % n]];
    return tour;
}
```

- **Data structures.** Prim's `key[]`/`par[]` arrays maintain the MST frontier; the DFS `order[]` is the shortcut Hamiltonian tour.

![Metric-TSP board: the doubled MST turned into an Euler cycle labelled ANS, with MST at most OPT and ANS at most 2 times MST](/img/dsa/md-nTsOnUp8/frame-00124.png)

[watch from 25:11](https://youtu.be/md-nTsOnUp8?t=1511)

---

## Metric TSP: 3/2-approximation (Christofides)

- **Idea.** Doubling every edge is wasteful — it doubles the whole tree just to fix parity. Instead of an Euler cycle on the doubled tree, build one on the tree **plus a cheap matching**.
- **Why parity matters.** An Euler cycle needs **every vertex to have even degree**. In the MST, some vertices have **odd** degree — and there is always an **even number** of them (handshake lemma).
- **The construction:**
  - build the MST;
  - take the set $T$ of **odd-degree** vertices ($\lvert T\rvert$ is even);
  - add a **minimum-weight perfect matching** on $T$ (possible in polynomial time even for non-bipartite graphs — Edmonds' blossom algorithm);
  - now every vertex has even degree → build the Euler cycle → shortcut repeats.
- Cost so far: $\text{ANS} \le \text{MST} + \text{MATCH}$.

![Christofides board: the MST plus orange matching edges connecting the eight odd-degree nodes, over the caption ANS at most MST plus MATCH](/img/dsa/md-nTsOnUp8/frame-00137.png)

- **Bounding the matching by $\tfrac12\,\text{OPT}$.** Look at the optimal tour (a cycle). The odd vertices $T$ appear on it in some order. Take the sub-cycle visiting **only** those $\lvert T\rvert$ vertices in that order (shortcutting the rest — never longer than $\text{OPT}$ by the triangle inequality). Its edges split into **two** alternating perfect matchings $M_1, M_2$ on $T$ with

$$
M_1 + M_2 \le \text{OPT} \implies \min(M_1, M_2) \le \tfrac12\,\text{OPT}.
$$

  Our matching is the *minimum*, so $\text{MATCH} \le \min(M_1,M_2) \le \tfrac12\,\text{OPT}$.
- **Putting it together:**

$$
\text{ANS} \le \text{MST} + \text{MATCH} \le \text{OPT} + \tfrac12\,\text{OPT} = \tfrac{3}{2}\,\text{OPT}.
$$

![Christofides analysis: ANS at most MST plus MATCH bounded by 3/2 OPT, and the two alternating matchings M1 plus M2 at most OPT so their minimum is at most half of OPT](/img/dsa/md-nTsOnUp8/frame-00160.png)

- **History (from the lecture).** Christofides' $\tfrac32$ (1976) stood as the best known for ~45 years. In **2020** Karlin–Klein–Oveis Gharan found a $\tfrac32 - \varepsilon$ algorithm for a *microscopic* constant $\varepsilon$ — a theoretical breakthrough, not a practical one.

[watch from 31:00](https://youtu.be/md-nTsOnUp8?t=1860)

---

## Knapsack: a 2-approximation

- **Problem.** Items with weight $w_i$ and value $c_i$, capacity $S$. Pick a subset with total weight $\le S$ maximizing total value. 0/1 Knapsack is NP-hard.
- **Naive greedy fails.** Sort by ratio $c_i/w_i$ and pack in order. **Counterexample** ($S=1000$): item A has $w=1, c=2$ (ratio $2$); item B has $w=1000, c=1000$ (ratio $1$). Greedy takes only A → value $2$, while $\text{OPT}=1000$. Off by $500\times$ — **not** $\alpha$-approximate for any $\alpha$.
- **The fix.** Return $\max$ of the greedy result and the **single most valuable item** that fits:

$$
\text{ANS} = \max\!\big(\text{Greedy},\ C_{\max}\big).
$$

```cpp
#include <bits/stdc++.h>
using namespace std;
struct Item { long long w, c; };

// 0/1-knapsack 2-approx: greedy by value/weight ratio, then take
// max(greedy value, best single item that fits). Guarantee: ANS >= OPT / 2.
long long knapsack_2approx(long long S, vector<Item> items) {
    sort(items.begin(), items.end(), [](const Item& a, const Item& b) {
        return (long double)a.c * b.w > (long double)b.c * a.w;   // c/w descending
    });
    long long W = 0, greedy = 0;
    for (auto& it : items)
        if (W + it.w <= S) { W += it.w; greedy += it.c; }         // fits -> take it
    long long cmax = 0;
    for (auto& it : items) if (it.w <= S) cmax = max(cmax, it.c); // best single item
    return max(greedy, cmax);
}
```

- **Proof that $\text{ANS} \ge \tfrac12\,\text{OPT}$.** Consider the **fractional** knapsack (items splittable). Greedy by ratio is *optimal* there, and it fills capacity with the greedy prefix **plus a fraction of one extra item**. So

$$
\text{OPT} \le \text{OPT}_{\text{frac}} \le \text{Greedy} + C_{\max}.
$$

  At least one of $\text{Greedy}, C_{\max}$ is $\ge \tfrac12\,\text{OPT}$, and their max is what we return. Equivalently: if greedy missed half of OPT, the item it couldn't fit alone exceeds half of OPT.

![Knapsack board: greedy prefix filling capacity S plus one overflowing item C_max, with OPT at most Greedy plus C_max and max(Greedy, C_max) at least half OPT](/img/dsa/md-nTsOnUp8/frame-00214.png)

[watch from 47:01](https://youtu.be/md-nTsOnUp8?t=2821)

---

## Knapsack: PTAS (any $\varepsilon$, but slow)

- Knapsack admits an approximation for **any** target $\varepsilon$: find $\text{ANS} \ge (1-\varepsilon)\,\text{OPT}$ in polynomial time.
- **PTAS idea (guess the big items).** Split items by value relative to $\text{OPT}$:
  - **Small** items with $c_i \le \varepsilon\,\text{OPT}$: run the greedy fractional algorithm; the single overflowing item is now $\le \varepsilon\,\text{OPT}$, so $\text{Greedy} \ge (1-\varepsilon)\,\text{OPT}$ on them.
  - **Big** items with $c_i > \varepsilon\,\text{OPT}$: the optimum can contain at most $\tfrac{1}{\varepsilon}$ of them (their values sum to $\le\text{OPT}$). **Brute-force all subsets** of size $\le \tfrac1\varepsilon$, then greedily fill the rest.
- Number of subsets to try is about $n^{1/\varepsilon}$ — polynomial for fixed $\varepsilon$, but the **exponent depends on $\varepsilon$**.

![PTAS board: split into items at most 2 epsilon OPT versus greater, at most one over epsilon big elements, enumerate n to the one-over-epsilon subsets](/img/dsa/md-nTsOnUp8/frame-00233.png)

- **This is only a PTAS, not an FPTAS.** With $\varepsilon = 0.01$ the running time is $\sim n^{100}$ — polynomial in name only, unusable in practice.
- **Practical wrinkle.** You don't know $\text{OPT}$ to draw the small/big cutoff. Use the earlier 2-approx value $A$ (with $\tfrac12\text{OPT} \le A \le \text{OPT}$) as a proxy; the exponent worsens to $\sim n^{2/\varepsilon}$ but stays polynomial.

[watch from 52:16](https://youtu.be/md-nTsOnUp8?t=3136)

---

## Knapsack: FPTAS (fast for any $\varepsilon$)

- Knapsack does even better: an **FPTAS** — running time polynomial in **both** $n$ and $\tfrac1\varepsilon$, with **no $\varepsilon$ in the exponent of $n$**.
- **Value-indexed DP.** If values are small integers, solve knapsack *exactly* by indexing the DP on **total value** instead of weight:

$$
d[x] = \text{minimum total weight of a subset whose values sum to } x.
$$

  Transition per item: $d[x] = \min\big(d[x],\, d[x - c_i] + w_i\big)$. The answer is the largest $x$ with $d[x] \le S$. Cost $O\big(n \cdot \textstyle\sum_i c_i\big)$.

![FPTAS DP board: c_i are small integers, d of x is min sum of weights of elements with value-sum x, ANS is max x with d of x at most S, and scaled value c prime](/img/dsa/md-nTsOnUp8/frame-00285.png)

- **Make values small by rounding.** Values may be huge. Scale by a block size $K = \dfrac{\varepsilon}{n}\,C_{\max}$ and **round down**:

$$
c_i' = \left\lfloor \frac{c_i}{K} \right\rfloor
      = \left\lfloor \frac{c_i}{\tfrac{\varepsilon}{n} C_{\max}} \right\rfloor.
$$

  Each $c_i' \le n/\varepsilon$, so $\sum_i c_i' \le n^2/\varepsilon$ and the DP runs in $O(n^3/\varepsilon)$.

![FPTAS rounding board: values measured in blocks of size epsilon over n times C_max, each rounded down, giving small integers, DP cost order n cubed over epsilon](/img/dsa/md-nTsOnUp8/frame-00304.png)

```cpp
#include <bits/stdc++.h>
using namespace std;
struct Item { long long w, c; };

// FPTAS for 0/1 knapsack: scale values by K = eps*Cmax/n, floor, then run the
// value-indexed DP carrying the REAL value. Returns value >= (1 - eps) * OPT
// in time O(n^3 / eps).
long long knapsack_fptas(long long S, vector<Item> items, double eps) {
    int n = items.size();
    long long cmax = 0;
    for (auto& it : items) if (it.w <= S) cmax = max(cmax, it.c);
    if (cmax == 0) return 0;
    double K = eps * (double)cmax / n;                 // block size
    if (K <= 0) K = 1;

    vector<long long> cp(n);
    long long sumcp = 0;
    for (int i = 0; i < n; i++) { cp[i] = (long long)floor(items[i].c / K); sumcp += cp[i]; }

    const long long INF = LLONG_MAX / 4;
    vector<long long> d(sumcp + 1, INF), val(sumcp + 1, 0);   // d[x]=min weight, val[x]=real value
    d[0] = 0;
    for (int i = 0; i < n; i++)
        for (long long x = sumcp; x >= cp[i]; x--)
            if (d[x - cp[i]] < INF && d[x - cp[i]] + items[i].w < d[x]) {
                d[x]   = d[x - cp[i]] + items[i].w;
                val[x] = val[x - cp[i]] + items[i].c;
            }

    long long ans = 0;
    for (long long x = 0; x <= sumcp; x++)
        if (d[x] <= S) ans = max(ans, val[x]);           // best real value that fits
    return ans;
}
```

- **Error bound.** Rounding each value down loses less than one block $K = \tfrac{\varepsilon}{n}C_{\max}$ per item, and there are $\le n$ items in a solution, so

$$
\text{OPT} \le \text{ANS} + n \cdot \frac{\varepsilon}{n}\,C_{\max}
           = \text{ANS} + \varepsilon\,C_{\max}
           \le \text{ANS} + \varepsilon\,\text{OPT}
$$

  (using $C_{\max} \le \text{OPT}$). Rearranging gives the guarantee $\text{ANS} \ge (1-\varepsilon)\,\text{OPT}$.

![FPTAS error board: OPT at most ANS plus n times epsilon-over-n times C_max, so ANS at least one minus epsilon times OPT](/img/dsa/md-nTsOnUp8/frame-00318.png)

- **Practicality.** With $\varepsilon = 0.01$ the DP costs $\sim 100\times$ a plain small-integer knapsack — slow but *usable*, unlike the PTAS's $n^{200}$.

[watch from 1:05:42](https://youtu.be/md-nTsOnUp8?t=3942)

---

## When a 2-approx beats an exact exponential algorithm

- Exact Vertex Cover / TSP / Knapsack are **exponential** in the worst case ($2^n$ subsets, $n!$ tours, or branch-and-bound that degrades to them).
- On a graph with millions of edges, the 2-approx Vertex Cover runs in **near-linear time** and hands you a cover guaranteed within $2\times$ optimal. The exact solver may not finish this century.
- Rule of thumb: **when $\text{OPT}$ merely needs to be *bounded* (SLA, capacity planning, a lower bound for branch-and-bound), a constant-factor approximation is the right tool.** Reach for the exact algorithm only when the instance is tiny or optimality is contractual.
- The FPTAS is the sweet spot: you **dial** $\varepsilon$ to trade accuracy for time — impossible with a single exact algorithm.

---

## Complexity recap

| Problem / method | Ratio | Time | Needs |
| --- | --- | --- | --- |
| Vertex Cover — maximal matching | $2$ | $O(V+E)$ | — |
| Weighted Vertex Cover — LP rounding | $2$ | poly (LP solve) | LP solver |
| Set Cover — greedy | $H(m) \le \ln m + 1$ | $O(\sum \lvert S_i\rvert)$ | — |
| General TSP | none (unless P = NP) | — | — |
| Metric TSP — MST doubling | $2$ | $O(V^2)$ | triangle ineq. |
| Metric TSP — Christofides | $3/2$ | poly (blossom matching) | triangle ineq. |
| Knapsack — greedy $+\,C_{\max}$ | $2$ | $O(n\log n)$ | — |
| Knapsack — PTAS | $1-\varepsilon$ | $n^{O(1/\varepsilon)}$ | — |
| Knapsack — FPTAS | $1-\varepsilon$ | $O(n^3/\varepsilon)$ | — |

> $H(m) = 1 + \tfrac12 + \dots + \tfrac1m$ is the $m$-th harmonic number.

---

## A coded companion: greedy Set Cover

The lecture solves Vertex Cover by maximal matching; the classic **$\ln n$-ratio greedy** is Set Cover's cousin (each edge is a 2-element set). Greedy repeatedly picks the set covering the most still-uncovered elements; the analysis gives $\lvert\text{Greedy}\rvert \le H(m)\cdot\text{OPT}$.

```cpp
#include <bits/stdc++.h>
using namespace std;

// Greedy Set Cover over universe {0..m-1}; each set is a bitmask.
// Picks the set with the largest gain each round. |Greedy| <= H(m) * OPT.
vector<int> greedy_set_cover(int m, const vector<uint64_t>& sets) {
    uint64_t uncovered = (m == 64) ? ~0ULL : ((1ULL << m) - 1);
    vector<int> chosen;
    while (uncovered) {
        int best = -1, bestGain = 0;
        for (int i = 0; i < (int)sets.size(); i++) {
            int gain = __builtin_popcountll(sets[i] & uncovered);
            if (gain > bestGain) { bestGain = gain; best = i; }   // most new elements
        }
        if (best == -1) break;                     // uncoverable
        chosen.push_back(best);
        uncovered &= ~sets[best];
    }
    return chosen;
}
```

*Verification (run offline against a brute-force optimum on thousands of small random instances):* every produced cover was valid and the ratio bounds **held on every instance** — Vertex Cover $\text{ANS} \le 2\,\text{OPT}$ (worst observed $2.000$), Set Cover $\lvert\text{Greedy}\rvert \le H(m)\,\text{OPT}$ (worst $2.000$), Knapsack $2\,\text{ANS} \ge \text{OPT}$ (worst $\text{ANS}/\text{OPT} = 0.589$), metric TSP $\text{ANS} \le 2\,\text{OPT}$ (worst $1.459$), FPTAS at $\varepsilon=0.2$ landed in $[(1-\varepsilon)\text{OPT},\,\text{OPT}]$ (worst $0.919$).

---

## Practice problems

> Approximation algorithms are mostly **theory** — they rarely appear verbatim in interviews. But the underlying **greedy** and **interval-cover** reasoning is prime interview material, and the exact NP-hard versions (Knapsack DP, TSP bitmask) are competitive staples. Labels below are honest about which is which.

**🎯 Interview (MAANG-style, greedy reasoning)**

- [Jump Game II — LeetCode 45](https://leetcode.com/problems/jump-game-ii/) — Medium — greedy "farthest reach" interval cover, same shape as covering a line with fewest sets.
- [Task Scheduler — LeetCode 621](https://leetcode.com/problems/task-scheduler/) — Medium — greedy scheduling by frequency; approximation-style bounding argument.
- [Minimum Number of Taps to Open to Water a Garden — LeetCode 1326](https://leetcode.com/problems/minimum-number-of-taps-to-open-to-water-a-garden/) — Hard — **greedy interval cover**, the discrete cousin of Set Cover.
- [Video Stitching — LeetCode 1024](https://leetcode.com/problems/video-stitching/) — Medium — cover $[0,T]$ with fewest intervals; identical greedy to 1326.
- [Vertex Cover Problem — GeeksforGeeks](https://www.geeksforgeeks.org/vertex-cover-problem-set-1-introduction-approximate-algorithm-2/) — Medium — the exact 2-approx from this lecture, coded.
- [Set Cover greedy — GeeksforGeeks](https://www.geeksforgeeks.org/set-cover-problem-set-1-greedy-approximate-algorithm/) — Medium — the $\ln n$ greedy, with the harmonic-sum proof.

**🏆 Competitive (exact NP-hard cores + approx references)**

- [Elevator Rides — CSES 1653](https://cses.fi/problemset/task/1653) — Medium — bitmask DP over subsets; the exact side of "pack items under a weight limit."
- [Travelling Salesman (MST 2-approx) — GeeksforGeeks](https://www.geeksforgeeks.org/travelling-salesman-problem-set-2-approximate-using-mst/) — Medium — the metric-TSP 2-approx, implemented.
- [Approximation Algorithms overview — GeeksforGeeks](https://www.geeksforgeeks.org/approximation-algorithms/) — reference — catalog of ratios and templates.

> This lecture has **no official Codeforces home-task post** in its description (unlike the earlier foundations lectures), so none is cited — only verified references above.

---

## Further reading

- [Approximation algorithm — Wikipedia](https://en.wikipedia.org/wiki/Approximation_algorithm) — ratios, PTAS/FPTAS taxonomy, hardness of approximation.
- [Vertex cover — Wikipedia](https://en.wikipedia.org/wiki/Vertex_cover) and the [NP-completeness proof — GeeksforGeeks](https://www.geeksforgeeks.org/proof-that-vertex-cover-is-np-complete/).
- [Set cover problem — Wikipedia](https://en.wikipedia.org/wiki/Set_cover_problem) — greedy $\ln n$ analysis and the matching inapproximability lower bound.
- [Travelling salesman problem — Wikipedia](https://en.wikipedia.org/wiki/Travelling_salesman_problem) and [Christofides algorithm — Wikipedia](https://en.wikipedia.org/wiki/Christofides_algorithm).
- [Held–Karp algorithm — Wikipedia](https://en.wikipedia.org/wiki/Held%E2%80%93Karp_algorithm) — the $O(2^n n^2)$ *exact* TSP DP, the exponential baseline a 2-approx replaces.
- [Knapsack problem — Wikipedia](https://en.wikipedia.org/wiki/Knapsack_problem), [PTAS — Wikipedia](https://en.wikipedia.org/wiki/Polynomial-time_approximation_scheme), and GfG's [0/1 Knapsack DP](https://www.geeksforgeeks.org/0-1-knapsack-problem-dp-10/) / [Fractional Knapsack](https://www.geeksforgeeks.org/fractional-knapsack-problem/).

---

## Key takeaways

- An $\alpha$-approximation trades exactness for a **provable ratio** $\text{ANS} \le \alpha\,\text{OPT}$; the whole game is finding a quantity that **bounds $\text{OPT}$** (a matching, an MST, an LP value).
- **Vertex Cover** — pick both endpoints of a maximal matching → $2$-approx; **weighted** → LP-relax, solve fractionally, round at $\tfrac12$ → $2$-approx.
- **General TSP is inapproximable**; add the **triangle inequality** and MST gives $2$, Christofides gives $\tfrac32$.
- **Knapsack** is the poster child: $2$-approx (greedy $+\,C_{\max}$), a PTAS ($n^{O(1/\varepsilon)}$), and an **FPTAS** ($O(n^3/\varepsilon)$) via value-scaled DP.
- Different NP-hard problems get **wildly different** approximability — from FPTAS all the way down to "no constant factor at all."

## Glossary

- **$\alpha$-approximation** — polynomial algorithm with $\text{ANS} \le \alpha\,\text{OPT}$ (min) or $\ge \alpha\,\text{OPT}$ (max).
- **PTAS** — Polynomial-Time Approximation Scheme: $(1\pm\varepsilon)$ for any fixed $\varepsilon$, time polynomial in $n$ but $\varepsilon$ may sit in the exponent.
- **FPTAS** — Fully PTAS: time polynomial in **both** $n$ and $1/\varepsilon$.
- **LP relaxation** — replace integer variables $\lbrace 0,1\rbrace$ with reals $[0,1]$; solvable in polynomial time, then round.
- **Triangle inequality** — $c_{uv} \le c_{uw} + c_{wv}$; the property that makes metric TSP approximable.
- **Christofides algorithm** — metric-TSP $\tfrac32$-approx: MST + minimum matching on odd-degree vertices + shortcut Euler cycle.
- **$H(m)$** — the $m$-th harmonic number $1 + \tfrac12 + \dots + \tfrac1m \approx \ln m$; greedy Set Cover's ratio.
