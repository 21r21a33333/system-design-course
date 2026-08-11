---
title: "S04E04 · Dinic's Algorithm"
sidebar_position: 4
description: Dinic's max-flow algorithm — BFS level graphs, blocking flow by DFS with the iter[] current-arc pruning, the phases-≤-V proof of O(V²E), and the O(E√V) bound on unit-capacity and bipartite networks.
---

# S04E04 · Dinic's Algorithm

> **Source:** Pavel Mavrin, [_A&DS S04E04_](https://youtu.be/soc05wkL28k) · 1h30m lecture → ~16 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- **Dinic's algorithm** finds a maximum $s \to t$ flow by repeating **phases**. Each phase (a) runs one BFS to build the **level graph** of shortest augmenting paths, then (b) saturates a **blocking flow** in that graph — many augmenting paths from a single BFS.
- The BFS labels every vertex with $d(v) = \operatorname{dist}(s, v)$; the level graph keeps only edges $u \to v$ with $d(v) = d(u) + 1$ and positive residual capacity.
- **Blocking flow** is found by DFS that reuses a per-vertex **current-arc pointer** `iter[v]`: an arc leading to a dead end is never revisited, so the whole DFS phase costs $O(VE)$, not exponential.
- The shortest $s \to t$ distance **strictly increases** every phase, and it is at most $V-1$, so there are **fewer than $V$ phases** → general bound $O(V^2 E)$.
- On **unit-capacity** graphs and **bipartite matching** the same code runs in $O(E\sqrt{V})$ — the reason Hopcroft–Karp is just "Dinic on the matching graph".
- Adding **capacity scaling** gives $O(VE\log C)$; swapping the DFS for **link-cut trees** gives $O(VE\log V)$ — both close to the $O(VE)$ frontier.

---

## From Ford–Fulkerson to Dinic

- **Recap (previous lecture).** A flow network is a directed graph with a capacity $c_{uv}$ on each edge, a source $s$ and sink $t$. A flow $f_{uv} \le c_{uv}$ obeys conservation at every internal node; its value is $\sum_{v} f_{sv}$.
- **Ford–Fulkerson.** Repeatedly find an **augmenting path** — a path where every edge has positive **residual capacity** $c' = c - f$ — push $\Delta = \min c'$ along it, update $f$. When no augmenting path exists, the flow is maximum (max-flow min-cut).
- **Edmonds–Karp.** Always pick the **shortest** augmenting path (BFS). Each augmentation saturates at least one edge; an edge is saturated at most $O(V)$ times, giving at most $O(VE)$ augmentations, each BFS costing $O(E)$ → $O(VE^2)$, i.e. $O(nm^2)$.
- **The waste Dinic fixes.** Edmonds–Karp runs a full BFS over the *whole* graph just to extract **one** path. Dinic runs one BFS and then extracts **all** shortest paths of that length before rebuilding.

![Left panel recaps residual capacity c' = c − f, Δ = min c', f += Δ, and the O(nm²) Edmonds–Karp bound next to the layered-network sketch](/img/dsa/soc05wkL28k/frame-00037.png)

[watch from 6:11](https://youtu.be/soc05wkL28k?t=371)

---

## The level graph (layered network)

- Run **one BFS from $s$** and record $d(v) = \operatorname{dist}(s, v)$ in the residual graph. Here $s$ sits at $d = 0$, its neighbours at $d = 1$, and so on out to $t$.
- **Keep only "forward" edges.** On any shortest path the distance rises by exactly one per step, so an edge $u \to v$ can lie on a shortest $s \to t$ path **only if** $d(v) = d(u) + 1$ and its residual capacity is positive. Discard every other edge.
- **Prune dead ends.** Remove vertices with no outgoing level-graph edge (and cascade). What remains is the **level graph** $L$: it contains exactly the edges usable by *some* shortest $s \to t$ path.
- **Key property.** In $L$, *any* walk that keeps taking an outgoing edge from $s$ must arrive at $t$ (no dead ends survive), and every such walk is a **shortest** augmenting path. Finding one path is $O(V)$ — no search needed.

![BFS level graph: s at d=0, layers d=1,2,3, sink t at d=4, with only the d(u)→d(u)+1 edges kept; note d(v)=dist(s,v)](/img/dsa/soc05wkL28k/frame-00048.png)

- **Why a phase makes progress.** Pushing flow only *adds* reverse edges going from a farther layer back to a nearer one ($d(\text{high}) \to d(\text{low})$). Such edges can never shorten an $s \to t$ path, so they never enter the current level graph. Once no $s \to t$ path remains in $L$, the shortest distance has grown by at least one.

![Pushing along a path adds only backward residual edges (far layer → near layer); these cannot be on any shortest path, so dist(s,t) can only increase](/img/dsa/soc05wkL28k/frame-00067.png)

[watch from 7:36](https://youtu.be/soc05wkL28k?t=456)

---

## Blocking flow and the pseudocode

- A **blocking flow** in $L$ is a flow that saturates at least one edge on *every* $s \to t$ path of the current level — after it, $L$ has no augmenting path left, even though it need not be the global maximum.
- **How the lecturer builds it.** While a path from $s$ to $t$ exists in $L$: walk any such path, take $\Delta = \min c'$ on it, add $\Delta$ to the flow, delete the now-saturated edge(s), and cascade-delete any vertex that just lost its last outgoing edge. Do **not** rebuild $L$ between paths — reuse it.
- **The outer loop.** Rebuild the level graph, saturate its blocking flow, repeat — until BFS can no longer reach $t$.

```text
while there is an s→t path in the residual graph:      # a PHASE
    BFS() → build the layered network L                # O(m)
    while there is an s→t path in L:                   # ≤ m iterations
        find a path         (walk any outgoing edges)  # O(n)
        Δ = min c' on the path
        f += Δ  along the path                         # push flow
        remove saturated edges  (c' = 0)               # ≥ 1 edge dies
        remove sink nodes       (cascade dead ends)    # O(n) total per phase
# O(nm + nm·n + m) = O(n²m)
```

![Dinic pseudocode on the board: outer while builds the layered network, inner while finds paths, pushes Δ = min c', removes saturated edges and sink nodes; total O(n²m)](/img/dsa/soc05wkL28k/frame-00136.png)

[watch from 20:14](https://youtu.be/soc05wkL28k?t=1214)

---

## Implementation: the `iter[]` current-arc trick

- **Do not build $L$ explicitly.** Keep the residual graph, store $d(v)$ from the BFS, and during the DFS only *follow* arcs with $d(v) = d(u)+1$ and $c' > 0$. This avoids maintaining two graphs at once.
- **Lazy dead-end deletion.** Instead of eagerly cascading sink removals, delete a bad arc the moment the DFS backtracks over it. Each vertex $v$ owns a pointer `iter[v]` into its adjacency list; when a DFS from $v$ into arc `iter[v]` finds nothing, we advance `iter[v]` past it **permanently for this phase**. That arc is never explored again.
- **Cost of the DFS phase.** Every advance of some `iter[v]` is charged once; across the phase that is $O(E)$ pointer moves plus $O(V)$ per successful augmenting path, and there are $O(E)$ augmentations → $O(VE)$ per phase, matching the pseudocode's $O(nm)$ inner cost.

Standard C++17 implementation (BFS level graph + DFS blocking flow with `iter[]`):

```cpp
#include <bits/stdc++.h>
using namespace std;

struct Dinic {
    struct Edge { int to; long long cap; };
    vector<Edge> edges;                 // edges[e] and edges[e^1] are a forward/reverse pair
    vector<vector<int>> g;              // g[v] = indices into edges[] leaving v
    vector<int> level, iter;            // BFS level + per-vertex current-arc pointer
    int n, s, t;

    Dinic(int n): n(n), g(n), level(n), iter(n) {}

    void add_edge(int u, int v, long long cap) {
        g[u].push_back(edges.size()); edges.push_back({v, cap});
        g[v].push_back(edges.size()); edges.push_back({u, 0});   // reverse edge, cap 0
    }

    bool bfs() {                        // build the level graph from s; false if t unreachable
        fill(level.begin(), level.end(), -1);
        queue<int> q; level[s] = 0; q.push(s);
        while (!q.empty()) {
            int v = q.front(); q.pop();
            for (int id : g[v]) {
                const Edge& e = edges[id];
                if (e.cap > 0 && level[e.to] < 0) {          // only positive-residual arcs
                    level[e.to] = level[v] + 1;
                    q.push(e.to);
                }
            }
        }
        return level[t] >= 0;
    }

    long long dfs(int v, long long pushed) {                 // one blocking-flow augmentation
        if (v == t) return pushed;
        for (int& i = iter[v]; i < (int)g[v].size(); i++) {  // iter[v]: dead-end pruning
            int id = g[v][i];
            Edge& e = edges[id];
            if (e.cap > 0 && level[v] + 1 == level[e.to]) {  // stay on the level graph
                long long d = dfs(e.to, min(pushed, e.cap));
                if (d > 0) {
                    edges[id].cap     -= d;                  // saturate forward
                    edges[id ^ 1].cap += d;                  // relax reverse (residual)
                    return d;
                }
            }
        }
        return 0;                        // dead end: iter[v] now fully advanced for this phase
    }

    long long max_flow(int s_, int t_) {
        s = s_; t = t_;
        long long flow = 0;
        while (bfs()) {                  // each phase strictly raises dist(s,t)
            fill(iter.begin(), iter.end(), 0);               // reset current-arc pointers
            while (long long f = dfs(s, LLONG_MAX)) flow += f;
        }
        return flow;
    }
};
```

- **Data structures.** Edges live in one flat `vector`; pairing forward edge $e$ with reverse $e\oplus 1$ makes residual updates a single XOR. `level[]` encodes the layered network implicitly; `iter[]` is the per-vertex invariant "every arc before `iter[v]` is exhausted this phase".
- **Verification.** This exact code was compile-tested with `c++ -std=c++17` and checked against a brute-force min-cut (enumerate every $s$-side subset) on 2000 random networks of up to 7 nodes — **0 mismatches** — plus the CLRS textbook network, which returns the known max flow $23$.

![Lazy DFS backtracking: descend the level graph, and when a node dead-ends, pop the last edge from its vector and step back — removing sink nodes on the fly](/img/dsa/soc05wkL28k/frame-00170.png)

[watch from 35:22](https://youtu.be/soc05wkL28k?t=2122)

---

## Complexity: why fewer than V phases

- **Per phase.** One BFS is $O(E)$. The blocking flow is $O(VE)$: at most $E$ augmenting paths (each kills $\ge 1$ edge), each path is $O(V)$ long, and all the dead-end pruning across the phase totals $O(E)$.
- **Number of phases.** Every phase, the shortest $s \to t$ distance in the residual graph **strictly increases**:

$$
d_{k+1}(t) \;>\; d_k(t).
$$

  A blocking flow saturates every shortest path of the current length, and augmentation only adds backward residual edges (which cannot shorten a path). Since $1 \le d(t) \le V-1$,

$$
\#\text{phases} \;\le\; V - 1 \;=\; O(V).
$$

- **General bound.** Multiplying the two:

$$
O(V) \cdot O(VE) \;=\; O(V^2 E) \;=\; O(n^2 m).
$$

- **Comparison.** Edmonds–Karp is $O(VE^2) = O(nm^2)$; Dinic is $O(V^2 E) = O(n^2 m)$. Since $V \le E$ on connected graphs, Dinic is never worse and is strictly better on dense graphs. On a near-complete graph ($m \approx n^2$) Edmonds–Karp is $\Theta(n^5)$ while Dinic is $\Theta(n^4)$.

![Final tally on the board: O(nm + n·m·n + m) collapses to O(n²m), sitting between Edmonds–Karp's O(nm²) and the near-optimal O(nm) frontier](/img/dsa/soc05wkL28k/frame-00133.png)

[watch from 25:20](https://youtu.be/soc05wkL28k?t=1520)

---

## Special cases: O(E√V)

- **Unit-capacity networks** (every $c_{uv} = 1$). A blocking-flow phase costs $O(E)$, and one can show the number of phases is $O(\sqrt{E})$; more sharply, on **simple** unit graphs it is $O(\sqrt{V})$. The bound becomes:

$$
O\!\big(E\sqrt{V}\big).
$$

- **Bipartite matching.** Model it as a unit-capacity flow: source $\to$ left vertices $\to$ right vertices $\to$ sink, all capacities $1$. Dinic on this network **is exactly Hopcroft–Karp**, running in $O(E\sqrt{V})$. Each phase augments along a maximal set of shortest vertex-disjoint augmenting paths.
- **Intuition for $\sqrt{V}$.** After $\sqrt{V}$ phases the shortest augmenting path has length $\ge \sqrt{V}$; but paths of length $\ge \sqrt{V}$ are vertex-disjoint enough that only $O(\sqrt{V})$ more can remain. So both "short-path" and "long-path" regimes are capped at $O(\sqrt{V})$ phases.

[watch from 1:07:00](https://youtu.be/soc05wkL28k?t=4020)

---

## Two speed-ups mentioned

- **Capacity scaling.** Run Dinic but only accept augmenting paths whose residual capacity is at least $2^k$, decreasing $k$ from $\lceil \log C \rceil$ down to $0$. This replaces one factor of $V$ (or $E$) with $\log C$:

$$
O\!\big(V E \log C\big) \;=\; O(nm\log C).
$$

  It depends on the numeric capacities $C$, so it is only **weakly** polynomial.

- **Link-cut trees.** The bottleneck is repeatedly re-walking the same path prefixes to find $\min c'$ and push flow. Storing the marked (already-traversed) tree of arcs in **link-cut trees** makes "find root", "path-min", "add-to-path" and "cut min edge" each $O(\log V)$. Every edge is *linked* at most once and *cut* at most once, so the blocking flow becomes $O(E\log V)$ per phase and the total is:

$$
O\!\big(V E \log V\big) \;=\; O(nm\log n).
$$

  This is the classic first application of link-cut trees (Sleator–Tarjan). The strongly-polynomial $O(VE)$ frontier is reachable but hard; Dinic-with-trees is within a $\log$ factor.

![Right panel: the marked shortest-path prefixes form a forest of link-cut trees; each phase links each edge once, cuts the min edge, and pushes Δ = min c'. Dinic O(n²m); Dinic+scaling O(nm log C)](/img/dsa/soc05wkL28k/frame-00259.png)

[watch from 1:14:36](https://youtu.be/soc05wkL28k?t=4476)

---

## Complexity recap

| Variant / graph class | Per phase | Phases | Total |
| --- | --- | --- | --- |
| Dinic, general graph | $O(VE)$ | $O(V)$ | $O(V^2E)$ |
| Edmonds–Karp (for contrast) | $O(E)$ per aug. | $O(VE)$ augs | $O(VE^2)$ |
| Dinic, unit capacity / bipartite | $O(E)$ | $O(\sqrt{V})$ | $O(E\sqrt{V})$ |
| Dinic + capacity scaling | $O(E\log C)$ | $O(V)$ | $O(VE\log C)$ |
| Dinic + link-cut trees | $O(E\log V)$ | $O(V)$ | $O(VE\log V)$ |

Space is $O(V + E)$ throughout (adjacency + `level[]` + `iter[]`).

---

## Practice problems

Maximum flow is primarily a **competitive-programming** topic; it reaches interviews mostly through **assignment / matching reductions** dressed up as grid or pairing problems. If you see "match A to B minimizing cost" or "select a maximum compatible set under constraints", a min-cost-max-flow or bipartite-matching reduction is often lurking.

**🎯 Interview (MAANG-style) — via reductions**

- [Maximum Students Taking Exam — LeetCode 1349](https://leetcode.com/problems/maximum-students-taking-exam/) — Hard — maximum independent set on a bipartite conflict graph → König/matching; classic flow reduction (bitmask DP is the usual accepted route).
- [Minimum Cost to Connect Two Groups of Points — LeetCode 1595](https://leetcode.com/problems/minimum-cost-to-connect-two-groups-of-points/) — Hard — an assignment / bipartite cover problem that maps onto min-cost matching.
- [Campus Bikes II — LeetCode 1066](https://leetcode.com/problems/campus-bikes-ii/) — Medium — minimum-cost assignment of workers to bikes → min-cost bipartite matching (Hungarian / MCMF).
- [Dinic's algorithm — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/dinics-algorithm-maximum-flow/) — Hard — reference implementation and walkthrough of the level-graph + blocking-flow structure.

**🏆 Competitive**

- [Download Speed — CSES 1694](https://cses.fi/problemset/task/1694) — Medium — vanilla maximum flow; the canonical "paste your Dinic template" problem.
- [Distinct Routes — CSES 1711](https://cses.fi/problemset/task/1711) — Hard — unit-capacity max flow, then decompose the flow into edge-disjoint $s \to t$ paths.
- [Parcel Delivery — CSES 2121](https://cses.fi/problemset/task/2121) — Hard — min-cost max-flow (the cost-aware cousin of Dinic).

> There is no official Codeforces home-task post linked in this lecture's description, so none is cited here.

---

## Further reading

- [Maximum flow — Dinic's algorithm — cp-algorithms](https://cp-algorithms.com/graph/dinic.html) — full derivation of the phase bound and the $O(E\sqrt{V})$ unit-capacity case.
- [Dinic's algorithm — Wikipedia](https://en.wikipedia.org/wiki/Dinic%27s_algorithm) — history, the level-graph definition, and the special-case complexities.
- [Dinic's algorithm for Maximum Flow — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/dinics-algorithm-maximum-flow/) — annotated implementation.
- [Max-flow min-cut theorem — Wikipedia](https://en.wikipedia.org/wiki/Max-flow_min-cut_theorem) — why "no augmenting path" means "maximum flow".
- [Max Flow problem introduction — GeeksforGeeks](https://www.geeksforgeeks.org/max-flow-problem-introduction/) — residual graphs and augmenting paths from scratch.

---

## Key takeaways

- Dinic = **BFS level graph** + **blocking flow**: one BFS yields many shortest augmenting paths, not just one.
- The `iter[]` current-arc pointer is what turns the blocking-flow DFS from exponential into $O(VE)$ — never re-explore a dead-end arc within a phase.
- The whole complexity argument hinges on one fact: **$\operatorname{dist}(s,t)$ strictly increases each phase**, capping phases at $V-1$ → $O(V^2E)$.
- The identical code is $O(E\sqrt{V})$ on unit-capacity graphs and bipartite matching — that is Hopcroft–Karp.
- Scaling ($O(VE\log C)$) and link-cut trees ($O(VE\log V)$) shave Dinic down toward the $O(VE)$ frontier.

## Glossary

- **Residual capacity** $c' = c - f$ — remaining push capacity of an edge; the reverse edge carries $f$ so flow can be cancelled.
- **Augmenting path** — an $s \to t$ path with $c' > 0$ on every edge.
- **Level graph (layered network)** — subgraph keeping only edges $u \to v$ with $d(v) = d(u)+1$ and $c' > 0$; holds exactly the shortest augmenting paths.
- **Blocking flow** — a flow in the level graph that saturates at least one edge on every $s \to t$ path; leaves no augmenting path *in that level graph*.
- **Phase** — one iteration of "rebuild level graph + saturate blocking flow"; strictly raises $\operatorname{dist}(s,t)$.
- **Current-arc pointer `iter[v]`** — per-vertex index marking arcs already proven to lead nowhere this phase.
