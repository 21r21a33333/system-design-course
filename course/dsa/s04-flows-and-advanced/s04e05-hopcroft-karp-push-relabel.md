---
title: "S04E05 · Hopcroft-Karp & Push-Relabel"
sidebar_position: 5
description: Why unit-capacity flow is fast, Dinic's square-root-of-m and n-to-the-two-thirds phase bounds, Hopcroft-Karp bipartite matching in O(E sqrt V), and the preflow push-relabel max-flow algorithm with heights, excess, push and relabel.
---

# S04E05 · Hopcroft-Karp & Push-Relabel

> **Source:** Pavel Mavrin, [_A&DS S04E05_](https://youtu.be/Y94v3DjJH70) · 1h39m lecture → ~16 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- On a **unit-capacity** network Dinic runs in $O(m\sqrt{m})$; with **no parallel edges** it improves to $O(m\,n^{2/3})$ — the factor comes from bounding how many Dinic *phases* survive after all short augmenting paths are exhausted.
- **Bipartite matching** reduces to unit-capacity max flow (super-source to left, right to super-sink). Running Dinic on *that* network is exactly the **Hopcroft-Karp** algorithm.
- On the matching network every node has effective capacity one, so residual augmenting paths are **vertex-disjoint**; that forces at most $\sqrt{n}$ phases, giving **Hopcroft-Karp** its $O(E\sqrt{V})$ bound.
- **Push-Relabel** is a different paradigm: keep a **preflow** (nodes may hold excess), assign each node a **height/level**, and repeatedly **push** excess downhill or **relabel** (raise) a stuck node. Source is pinned at height $n$, sink at $0$.
- The generic FIFO push-relabel runs in $O(n^2 m)$; picking the **highest-label** active node drops it to $O(n^3)$. Saturated edges at the end form an $s$-$t$ cut equal to the flow, proving maximality.

---

## Unit-capacity flow: revisiting every algorithm

- The lecture reopens the max-flow zoo under one restriction: **every edge has capacity 1**. How fast is each algorithm now?
- Two upper bounds on the flow value $F$ drive everything:
  - With $m$ edges, $F \le m$ (you cannot push more than $m$ total units out of $s$).
  - With **no parallel edges**, $F \le n$ (at most $n-1$ distinct edges leave $s$).
- Per-algorithm complexity, unit capacities:

| Algorithm | General cap. | cap $= 1$ | cap $= 1$, no parallel edges |
| --- | --- | --- | --- |
| Ford-Fulkerson | $O(Fm)$ | $O(m^2)$ | $O(nm)$ |
| Edmonds-Karp | $O(nm^2)$ | $O(m^2)$ | $O(nm)$ |
| Dinic | $O(n^2 m)$ | $O(m\sqrt{m})$ | $O\big(\min(\sqrt{m},\,n^{2/3})\cdot m\big)$ |

- Ford-Fulkerson / Edmonds-Karp: each augmentation pushes $\ge 1$ unit, and $F \le m$ (or $\le n$), so the bound is just $F$ times the cost of one path search.
- Dinic is the interesting case — its phase count collapses far below $n$ under unit capacities.

![Board table of Ford-Fulkerson, Edmonds-Karp and Dinic complexities across general, unit, and unit-no-parallel-edge cases, plus a small bipartite graph](/img/dsa/Y94v3DjJH70/frame-00124.png)

[watch from 0:37](https://youtu.be/Y94v3DjJH70?t=37)

---

## Why Dinic has only $\sqrt{m}$ phases on unit graphs

- Recall Dinic: each **phase** builds a BFS **layered network** and saturates all shortest augmenting paths of the current length. Under unit capacities, pushing one unit through a path **removes every edge on it** from the residual graph, so one whole phase costs $O(m)$ (spend a little per path, then delete its edges).
- The phase *count* is the win. Run the **first $\sqrt{m}$ phases**; afterwards every remaining augmenting path has length $\ge \sqrt{m}$ (all shorter ones are gone).
- Let $\Delta F = F_{\max} - F$ be the residual gap. Decompose $\Delta F$ into augmenting paths in the residual network. Because each edge has capacity 1, these paths are **edge-disjoint** — an edge on two paths would carry 2 units.
- Each such path has $\ge \sqrt{m}$ edges and they share no edges, so there are at most $m / \sqrt{m} = \sqrt{m}$ of them, i.e. $\Delta F \le \sqrt{m}$.
- Every later phase raises the flow by $\ge 1$, so at most $\sqrt{m}$ more phases remain. Total phases $\le 2\sqrt{m}$, hence **$O(m\sqrt{m})$**.

$$
\underbrace{\sqrt{m}}_{\text{short phases}} \;+\; \underbrace{\Delta F \le \sqrt{m}}_{\text{long phases}} \;\le\; 2\sqrt{m}
\quad\Rightarrow\quad
T = O\big(m \cdot \sqrt{m}\big) = O\big(m^{3/2}\big)
$$

![Delta-F decomposed into edge-disjoint augmenting paths each of length at least sqrt(m), bounding the number of long phases](/img/dsa/Y94v3DjJH70/frame-00161.png)

[watch from 10:25](https://youtu.be/Y94v3DjJH70?t=625)

---

## The $n^{2/3}$ bound with no parallel edges

- Same trick, different counting. Run the first $n^{2/3}$ phases; now every remaining path has length $\ge n^{2/3}$. Split the residual graph into **layers** by distance from $s$; let layer $i$ hold $a_i$ nodes.
- With no parallel edges, the number of edges between consecutive layers is at most the product of their sizes, so the smallest inter-layer cut satisfies

$$
C_{\min} \;\le\; \min_i\, \big(a_i \cdot a_{i+1}\big).
$$

- We have $\sum_i a_i = n$ balls dropped into $\approx n^{2/3}$ layers (the path length). This minimum is maximized when the layers are **equal**, giving $a_i \approx n / n^{2/3} = n^{1/3}$, hence a cut of size $\le (n^{1/3})^2 = n^{2/3}$.
- A cut of size $n^{2/3}$ bounds the residual flow: $\Delta F \le n^{2/3}$. So at most $n^{2/3}$ long phases remain, and total phases $\le 2\,n^{2/3}$.
- Combined bound: **$O\big(\min(\sqrt{m},\,n^{2/3})\cdot m\big)$**. Parallel edges are forbidden here precisely because the "edges $\le a_i\,a_{i+1}$" step fails when multi-edges are allowed.

![Layered residual network split by distance, the cut C at most n to the two-thirds from balancing n nodes across the layers](/img/dsa/Y94v3DjJH70/frame-00094.png)

[watch from 16:49](https://youtu.be/Y94v3DjJH70?t=1009)

---

## Bipartite matching = unit-capacity flow

- Bipartite graph: left part $L$, right part $R$, edges only across. Goal: a **maximum matching** (largest edge set with no shared endpoint).
- Reduction to flow: add super-source $s \to$ every left node, every right node $\to$ super-sink $t$, orient the original edges $L \to R$, all capacities $1$.
- Max flow in this network = max matching: a saturated middle edge is a matched pair. Each left node receives $\le 1$ unit (one edge from $s$) and each right node emits $\le 1$ unit, so no vertex is doubly matched.
- The simple augmenting-path method for matching (Kuhn's algorithm) is **literally Ford-Fulkerson** on this network. Hopcroft-Karp replaces that inner search with **Dinic**.

![Bipartite graph modeled as unit-capacity flow with a super-source and super-sink, annotated with the O(sqrt n) phase bound](/img/dsa/Y94v3DjJH70/frame-00139.png)

[watch from 30:33](https://youtu.be/Y94v3DjJH70?t=1833)

---

## Hopcroft-Karp: $O(E\sqrt{V})$

- The matching network has **unit capacities and no parallel edges**, so the $O(m\,n^{2/3})$ bound already applies. But it is even better here: only $O(\sqrt{n})$ phases.
- **Vertex-disjoint paths.** Every left node has exactly one incoming edge (from $s$); every right node has exactly one outgoing edge (to $t$). Pushing flow through a node *reverses* its edges in the residual graph but keeps in-degree and out-degree unchanged, so each node keeps effective capacity 1. Residual augmenting paths are therefore **vertex-disjoint**.
- After the first $\sqrt{n}$ phases, remaining paths have length $\ge \sqrt{n}$; being vertex-disjoint their total size is $\le n$, so there are $\le n/\sqrt{n} = \sqrt{n}$ of them. Thus $\le 2\sqrt{n}$ phases, each costing $O(m)$ to build the BFS layers and augment ⇒ **$O(m\sqrt{n}) = O(E\sqrt{V})$**.
- Link-cut trees do **not** help: a phase already needs $\Omega(m)$ just to run BFS and build the layered network.

**The algorithm** (BFS builds distance layers to free right vertices; DFS augments many vertex-disjoint shortest paths per phase). This is Dinic specialized to the matching network — no explicit $s$/$t$ needed:

```cpp
#include <bits/stdc++.h>
using namespace std;

// Hopcroft-Karp: maximum bipartite matching in O(E * sqrt(V)).
// Left vertices 0..nl-1, right vertices 0..nr-1. adj[u] = right neighbours of u.
struct HopcroftKarp {
    int nl, nr;
    vector<vector<int>> adj;
    vector<int> matchL, matchR, dist;   // matchL[u]=right partner or -1; matchR[v]=left partner
    const int INF = INT_MAX;
    HopcroftKarp(int nl, int nr) : nl(nl), nr(nr), adj(nl),
        matchL(nl, -1), matchR(nr, -1), dist(nl) {}
    void add_edge(int u, int v) { adj[u].push_back(v); }

    // BFS builds layers; returns true if some augmenting path to a free right vertex exists.
    bool bfs() {
        queue<int> q;
        for (int u = 0; u < nl; u++) {
            if (matchL[u] == -1) { dist[u] = 0; q.push(u); }  // free left vertices = layer 0
            else dist[u] = INF;
        }
        bool found = false;
        while (!q.empty()) {
            int u = q.front(); q.pop();
            for (int v : adj[u]) {
                int w = matchR[v];                  // right vertex v is matched to left w
                if (w == -1) found = true;          // reached a free right vertex
                else if (dist[w] == INF) { dist[w] = dist[u] + 1; q.push(w); }
            }
        }
        return found;
    }
    // DFS along BFS layers, augmenting one vertex-disjoint shortest path.
    bool dfs(int u) {
        for (int v : adj[u]) {
            int w = matchR[v];
            if (w == -1 || (dist[w] == dist[u] + 1 && dfs(w))) {
                matchL[u] = v; matchR[v] = u;       // flip this edge into the matching
                return true;
            }
        }
        dist[u] = INF;                              // dead end: prune so we never revisit
        return false;
    }
    int max_matching() {
        int res = 0;
        while (bfs())                               // each phase = one BFS + many DFS
            for (int u = 0; u < nl; u++)
                if (matchL[u] == -1 && dfs(u)) res++;
        return res;
    }
};
```

- **Data structures.** `matchL` / `matchR` store the current matching (the residual state); `dist` holds BFS layer numbers and doubles as the "already explored / dead" marker (`INF`) so each phase's DFS work is $O(m)$ total.
- **Verified:** 3000 random bipartite instances agree with Kuhn's brute-force augmenting-path matcher.

[watch from 33:59](https://youtu.be/Y94v3DjJH70?t=2039)

---

## Push-Relabel: the preflow paradigm

- A completely different idea. Instead of pushing whole $s\to t$ paths, **flood one edge out of $s$ with more flow than needed**, then locally redistribute the excess, sending leftovers back if necessary.
- A **preflow** relaxes conservation: each edge obeys $f_{uv} \le c_{uv}$, but a node may *accumulate* excess. The **balance** (excess) of $v$ is

$$
b_v \;=\; \sum_{u} f_{uv} \;\ge\; 0 \qquad (\text{inflow minus outflow, allowed positive}).
$$

- When every $b_v = 0$ (except $s,t$) the preflow is an ordinary flow.
- **Heights / levels.** Give each node an integer level $\ell(v)$. Fix $\ell(s) = n$, $\ell(t) = 0$; all others start at $0$ and only ever rise. Think of level as *height* and flow as *water running downhill*.
- **Invariant.** For any residual edge $u \to v$, $\ell(v) \ge \ell(u) - 1$. Equivalently: if an edge drops by two or more levels ($\ell(v) < \ell(u) - 1$) it must be **saturated** ($f_{uv} = c_{uv}$). Initialization saturates all edges out of $s$ to establish this.

![Push-relabel setup on a sample network: preflow with f at most c, balance sum of f at least 0, and a small graph illustrating the levels and saturation invariant](/img/dsa/Y94v3DjJH70/frame-00213.png)

[watch from 47:48](https://youtu.be/Y94v3DjJH70?t=2868)

---

## Push and relabel operations

Pick any node $v \ne s,t$ with excess $b_v > 0$ and apply one of:

- **Push** — requires a residual edge $v \to u$ with $c^{res}_{vu} > 0$ and $\ell(u) = \ell(v) - 1$ (strictly one level down). Move

$$
\delta \;=\; \min\big(b_v,\; c^{res}_{vu}\big)
$$

  units along it. If $\delta = c^{res}_{vu}$ the push is **saturating** (edge disappears from residual); otherwise **non-saturating** (empties $v$'s excess).

- **Relabel** — when $v$ has excess but *no* downhill residual edge. Raise it just enough to expose one:

$$
\ell(v) \;\leftarrow\; \min_{\,u:\, c^{res}_{vu} > 0}\, \ell(u) \;+\; 1.
$$

- **Both operations preserve the invariant.** Relabel only *raises* $\ell(v)$; a residual edge $v\to u$ that was unsaturated had $\ell(u) \ge \ell(v)$ before, and after relabel $\ell(v) \le \ell(u)+1$ by the min. Incoming edges $w\to v$ only get *steeper*, and steep edges are required to be saturated — which they already are.
- **Excess can always move.** If $b_v > 0$ the liquid arrived from somewhere, so a residual edge back exists; relabel then push. The one node allowed to keep excess is $t$.

```cpp
#include <bits/stdc++.h>
using namespace std;

// Push-Relabel max flow, FIFO (active-queue) variant. Generic bound O(V^2 * E).
// Nodes 0..n-1; call add_edge then max_flow(s, t).
struct PushRelabel {
    struct Edge { int to; long long cap; };
    int n;
    vector<Edge> edges;                 // even index = forward, odd = its reverse
    vector<vector<int>> g;              // g[v] = indices of edges leaving v
    vector<long long> excess;           // b_v : current balance / excess at v
    vector<int> height;                 // l(v) : level of v
    vector<int> active_in_q;
    queue<int> q;
    PushRelabel(int n) : n(n), g(n), excess(n), height(n) {}

    void add_edge(int u, int v, long long c) {
        g[u].push_back(edges.size()); edges.push_back({v, c});
        g[v].push_back(edges.size()); edges.push_back({u, 0});   // residual reverse
    }
    void enqueue(int v, int s, int t) {
        if (!active_in_q[v] && excess[v] > 0 && v != s && v != t) {
            active_in_q[v] = 1; q.push(v);
        }
    }
    // Push min(excess, residual) along edge eid (only ever called downhill).
    void push(int v, int eid, int s, int t) {
        Edge& e = edges[eid];
        long long d = min(excess[v], e.cap);
        e.cap -= d; edges[eid ^ 1].cap += d;     // update residual: forward down, reverse up
        excess[v] -= d; excess[e.to] += d;
        enqueue(e.to, s, t);
    }
    // Raise v to one above the lowest reachable neighbour in the residual graph.
    void relabel(int v) {
        int mh = INT_MAX;
        for (int id : g[v]) if (edges[id].cap > 0) mh = min(mh, height[edges[id].to]);
        if (mh < INT_MAX) height[v] = mh + 1;
    }
    // Empty v's excess by repeated downhill pushes, relabelling when stuck.
    void discharge(int v, int s, int t) {
        while (excess[v] > 0) {
            bool pushed = false;
            for (int id : g[v]) {
                Edge& e = edges[id];
                if (e.cap > 0 && height[v] == height[e.to] + 1) {
                    push(v, id, s, t); pushed = true;
                    if (excess[v] == 0) break;
                }
            }
            if (!pushed) relabel(v);
        }
    }
    long long max_flow(int s, int t) {
        active_in_q.assign(n, 0);
        fill(height.begin(), height.end(), 0);
        height[s] = n;                           // source pinned at level n
        for (int id : g[s]) {                    // build preflow: saturate every edge out of s
            Edge& e = edges[id];
            long long d = e.cap;
            if (d > 0) {
                e.cap -= d; edges[id ^ 1].cap += d;
                excess[e.to] += d; excess[s] -= d;
                enqueue(e.to, s, t);
            }
        }
        while (!q.empty()) {                     // process active nodes FIFO
            int v = q.front(); q.pop(); active_in_q[v] = 0;
            discharge(v, s, t);
        }
        return excess[t];                        // all excess that reached t = max flow
    }
};
```

- **Data structures.** `edges` is the standard paired forward/reverse residual list; `excess` is the balance $b_v$; `height` is $\ell(v)$; the FIFO `queue` holds nodes with positive excess awaiting discharge.
- **Verified:** 3000 random capacitated digraphs give the same max-flow value as a Dinic reference.

[watch from 60:10](https://youtu.be/Y94v3DjJH70?t=3610)

---

## Correctness and complexity

**Maximality via a cut.** When all balances are zero we have a real flow. The **saturated edges form an $s$-$t$ cut**: on any $s\to t$ path there are $\le n-1$ edges but the level must fall from $\ell(s)=n$ to $\ell(t)=0$, so some edge drops by $\ge 2$ levels and is therefore saturated. A cut whose capacity equals the flow proves the flow is maximum.

**Levels are bounded.** A relabel raises $\ell(v)$, and there is always a residual path $s \to v$, so $\ell(v) \le \ell(s) + (n-1) = 2n - 1$. Hence each node is relabeled $O(n)$ times.

- **Relabels.** One relabel scans $v$'s incident edges, costing $\deg(v)$. Total: $\sum_v n \cdot \deg(v) = O(nm)$; the number of relabels is $O(n^2)$.
- **Saturating pushes.** After a saturating push on $u\to v$, re-saturating it requires flow back, which needs $\ell$ to climb by $\ge 2$ — possible $\le n$ times per edge. So $O(nm)$ saturating pushes.
- **Non-saturating pushes.** Bound them with the potential $\Phi = \sum_{v:\, b_v > 0} \ell(v)$. Each non-saturating push *lowers* $\Phi$ by $\ge 1$ (excess moves one level down). Relabels raise $\Phi$ by $\le n$ each ($O(n^2)$ total across all relabels), and each saturating push raises it by $\le n$ ($O(n^2 m)$ total). Since $\Phi \ge 0$, the number of non-saturating pushes is $O(n^2 m)$.

$$
T_{\text{generic}} \;=\; \underbrace{O(nm)}_{\text{relabels}} + \underbrace{O(nm)}_{\text{sat. push}} + \underbrace{O(n^2 m)}_{\text{non-sat. push}} \;=\; O(n^2 m)
$$

- **The bottleneck is non-saturating pushes.** Discharging *arbitrary* active nodes can ping excess back and forth $\Theta(n^2)$ times along a long chain. Choosing the **highest-level active node** each step avoids this and improves the bound to **$O(n^3)$**.

![Relabel bound l(v) at most 2n, saturated edges forming an s-t cut, and the potential-function argument for the push counts](/img/dsa/Y94v3DjJH70/frame-00340.png)

[watch from 82:26](https://youtu.be/Y94v3DjJH70?t=4946)

---

## Complexity recap

| Algorithm / setting | Phases / iterations | Time | Space |
| --- | --- | --- | --- |
| Dinic, unit capacities | $O(\sqrt{m})$ | $O(m\sqrt{m})$ | $O(n + m)$ |
| Dinic, unit cap. no parallel edges | $O(n^{2/3})$ | $O(m\,n^{2/3})$ | $O(n + m)$ |
| Hopcroft-Karp (bipartite matching) | $O(\sqrt{n})$ | $O(m\sqrt{n}) = O(E\sqrt{V})$ | $O(n + m)$ |
| Push-Relabel, FIFO | $O(n^2)$ relabels | $O(n^2 m)$ | $O(n + m)$ |
| Push-Relabel, highest-label | — | $O(n^3)$ | $O(n + m)$ |

---

## Practice problems

Bipartite matching is a genuine interview topic; **push-relabel itself is beyond standard interview rounds** (it shows up only in advanced competitive / research settings) — the nearest interview-relevant skill is modeling a problem as bipartite matching or max flow, so those are listed first.

**🎯 Interview (MAANG-style)**

- [Maximum Number of Accepted Invitations — LeetCode 1820](https://leetcode.com/problems/maximum-number-of-accepted-invitations/) — Medium — textbook bipartite matching (boys ↔ girls), the direct application of this lecture.
- [Maximum Bipartite Matching — GeeksforGeeks](https://www.geeksforgeeks.org/maximum-bipartite-matching/) — Medium — the canonical augmenting-path matcher Hopcroft-Karp speeds up.
- [Maximum Students Taking Exam — LeetCode 1349](https://leetcode.com/problems/maximum-students-taking-exam/) — Hard — independent set on a grid, solvable as matching / min-vertex-cover (König).
- [Campus Bikes II — LeetCode 1066](https://leetcode.com/problems/campus-bikes-ii/) — Medium — assignment framed as min-cost matching.

**🏆 Competitive**

- [School Dance — CSES 1696](https://cses.fi/problemset/task/1696) — Medium — maximum bipartite matching, exactly the Hopcroft-Karp setting.
- [Distinct Routes — CSES 1711](https://cses.fi/problemset/task/1711) — Hard — edge-disjoint $s$-$t$ paths via unit-capacity max flow, then path decomposition.
- [Kuhn's / bipartite matching — cp-algorithms](https://cp-algorithms.com/graph/kuhn_maximum_bipartite_matching.html) — the augmenting-path baseline plus practice list.
- [Push-Relabel — cp-algorithms](https://cp-algorithms.com/graph/push-relabel.html) and [faster highest-label variant](https://cp-algorithms.com/graph/push-relabel-faster.html) — reference implementations and problems.

---

## Further reading

- [Hopcroft-Karp algorithm — Wikipedia](https://en.wikipedia.org/wiki/Hopcroft%E2%80%93Karp_algorithm) — the $O(E\sqrt{V})$ analysis and history.
- [Push-relabel maximum flow algorithm — Wikipedia](https://en.wikipedia.org/wiki/Push%E2%80%93relabel_maximum_flow_algorithm) — heights, discharge, gap and highest-label heuristics.
- [Dinic's algorithm — Wikipedia](https://en.wikipedia.org/wiki/Dinic%27s_algorithm) — the phase/blocking-flow view underlying the unit-capacity bounds.
- [Hopcroft-Karp for maximum matching — GeeksforGeeks](https://www.geeksforgeeks.org/hopcroft-karp-algorithm-for-maximum-matching-set-1-introduction/).
- [Introduction to push-relabel — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/introduction-to-push-relabel-algorithm/).

---

## Key takeaways

- Unit capacities turn "remove one edge per augmentation" into "remove the whole path", collapsing Dinic's phase count to $\sqrt{m}$ (or $n^{2/3}$ without parallel edges).
- Bipartite matching *is* unit-capacity flow; running Dinic on it and exploiting **vertex-disjoint** residual paths gives Hopcroft-Karp's $O(E\sqrt{V})$.
- Push-Relabel abandons augmenting paths for a **preflow + heights** local rule: push excess downhill, relabel when stuck.
- Its correctness rests on one geometric fact — saturated steep edges form an $s$-$t$ cut equal to the flow — and its speed on a potential-function count of non-saturating pushes.
- Node-selection strategy matters: highest-label active node takes push-relabel from $O(n^2 m)$ to $O(n^3)$.

## Glossary

- **Preflow** — a flow-like assignment obeying capacities but allowing nodes to hold nonnegative excess (balance $b_v \ge 0$).
- **Excess / balance $b_v$** — inflow minus outflow at $v$; a node is *active* when $b_v > 0$.
- **Level / height $\ell(v)$** — nonnegative label used to force flow downhill; $\ell(s)=n$, $\ell(t)=0$, never decreases.
- **Push** — move $\min(b_v, c^{res})$ along a residual edge to a strictly lower neighbour.
- **Relabel** — raise a stuck active node to one above its lowest residual neighbour.
- **Saturating push** — a push that fills the edge to capacity, deleting it from the residual graph.
- **Vertex-disjoint paths** — augmenting paths sharing no vertex; the key structural fact making Hopcroft-Karp $O(\sqrt{n})$ phases.
- **Phase** — one Dinic round: build the layered network, then saturate all current shortest augmenting paths.
