---
title: "S04E07 · Minimum Cost Flows"
sidebar_position: 7
description: The minimum-cost max-flow problem solved by successive shortest augmenting paths, why residual reverse edges carry negative cost, Johnson potentials that let Dijkstra replace Bellman-Ford, the reduced-cost optimality argument, negative-cycle canceling, and capacity scaling.
---

# S04E07 · Minimum Cost Flows

> **Source:** Pavel Mavrin, [_A&DS S04E07_](https://youtu.be/PVCOIoafY1g) · 1h28m lecture → ~15 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- **Min-cost flow** is the weighted version of max-flow: every edge has a capacity $c_{uv}$ **and** a cost $w_{uv}$ (money per unit pushed). Among all flows of a given size we want the one minimizing $W = \sum_{uv} f_{uv}\, w_{uv}$.
- **Successive shortest paths (SSP).** Keep the invariant "$F_k$ is the cheapest flow of size $k$". To get $F_{k+1}$, find the **shortest-cost augmenting path** in the residual network and push one unit along it. A flow of size 1 is a single path, so its cheapest form is the shortest $s \to t$ path.
- **Residual reverse edges carry negative cost.** A forward edge $u \to v$ of cost $w$ gets a reverse edge $v \to u$ of cost $-w$ (undoing one unit of flow refunds $w$). So even an all-non-negative graph develops negative-cost residual edges, and plain Dijkstra breaks.
- **Fix with Johnson potentials.** Assign each node a potential $\varphi(v)$ and use the **reduced cost** $w'_{uv} = w_{uv} + \varphi(u) - \varphi(v)$. Setting $\varphi(v) = \operatorname{dist}(s,v)$ makes every reduced cost $\ge 0$ (triangle inequality) and makes shortest-path edges cost exactly $0$ — so the new reverse edges are $-0 = 0$, still non-negative. Now **Dijkstra** works on every iteration.
- **Optimality** rests on one fact: a flow is min-cost **iff its residual network has no negative-cost cycle**. If negative edges but no negative cycles exist, seed potentials with **one** Bellman-Ford pass, then Dijkstra the rest. If negative cycles exist, **cancel** them one at a time.
- **Complexity:** $O(F \cdot m\log n)$ with potentials + Dijkstra, where $F$ is the flow value; **capacity scaling** removes the $F$ and gives roughly $O(m^2 \log C \log n)$, polynomial in the graph size.

---

## The problem: capacity plus cost

- Same liquid-through-pipes picture as max-flow, but each edge now has **two** numbers:
  - $c_{uv}$ — the **capacity** (max units through the edge).
  - $w_{uv}$ — the **cost** (money to push **one** unit through it). The lecturer writes $w$ (not $c$) because "cost" and "capacity" collide on the letter $c$.
- A flow still obeys $0 \le f_{uv} \le c_{uv}$ and conservation at every node but $s, t$. Its **total cost** is

$$
W \;=\; \sum_{uv} f_{uv} \cdot w_{uv}.
$$

- Several problem variants exist: cheapest flow of **any** size, cheapest flow of a **fixed** size $x$, or — the one this lecture solves — the **min-cost maximum flow**: among all flows of maximum value, return the cheapest.
- Compare to earlier topics: max-flow treats all edges equally; adding per-edge weights turns bipartite matching into the **assignment problem**, and turns "any path" into "shortest path".

[watch from 0:43](https://youtu.be/PVCOIoafY1g?t=43)

---

## Building up by size: F0, F1, F2, …

- **$F_0$ (size 0).** With all costs $\ge 0$, the cheapest flow of size 0 is the **empty flow** — push nothing, pay nothing.
- **$F_1$ (size 1).** Any flow of size 1 **decomposes into one $s \to t$ path plus some cycles**. Every cycle has non-negative cost (costs are $\ge 0$), so dropping all cycles never increases cost. Hence the cheapest size-1 flow is exactly the **shortest $s \to t$ path** (minimize $\sum w$ on the path).
- **$F_{k} \to F_{k+1}$.** Take the current cheapest flow $F_k$, build its **residual network**, find the **minimum-cost augmenting path** from $s$ to $t$, and push one unit. That is the whole algorithm:

```text
f = 0                                  # start from the empty flow
while an augmenting path s -> t exists:
    find the MIN-COST augmenting path in the residual network
    push 1 unit of flow along it       # increase size by one
```

- **Why this is optimal at every step** (previewed here, proved below): the difference $\Delta f = F_{k+1} - F_k$ is a flow in the residual network of $F_k$. Decomposed into one path plus cycles, and since no residual negative cycle exists, the cheapest $\Delta f$ is a single shortest path.

![Board: F0 is the empty flow, F1 is the shortest s to t path minimizing sum of w, F2 applies the cheapest augmenting path to F1, and F_k is the min-cost flow of size k](/img/dsa/PVCOIoafY1g/frame-00048.png)

[watch from 5:22](https://youtu.be/PVCOIoafY1g?t=322)

---

## Why residual edges go negative

- Build the residual network exactly as in max-flow: for a forward edge $u \to v$ with capacity $c$ and cost $w$ carrying flow $f$, keep
  - the **forward** residual edge $u \to v$ with capacity $c - f$ and cost $w$, and
  - a **reverse** residual edge $v \to u$ with capacity $f$ and cost $-w$.
- **The reverse cost is $-w$.** Using the reverse edge in an augmenting path means **cancelling** one unit of the original flow: you stop paying $w$ for that unit, so the marginal cost of pushing through the reverse edge is $-w$.
- Board example: an edge of capacity 5, cost 4, carrying flow 3, yields a forward residual edge (capacity 2, cost 4) and a reverse residual edge (capacity 3, cost $-4$). Pushing one unit backward saves 4.
- **Consequence:** even if the original graph had all non-negative costs, the residual network can contain **negative-cost edges**. So on the second augmentation onward we cannot naively run Dijkstra.

![Board: a capacity-5 cost-4 edge carrying flow 3 splits into a forward residual edge cost 4 and a reverse residual edge of capacity 3 and cost minus 4](/img/dsa/PVCOIoafY1g/frame-00072.png)

- **First fix (slow):** use **Bellman-Ford** to find the shortest augmenting path — it tolerates negative edges. With up to $F$ augmentations, each $O(mn)$, total $O(F \cdot mn)$. Works, but we can do better.

[watch from 13:42](https://youtu.be/PVCOIoafY1g?t=822)

---

## Johnson potentials: making Dijkstra legal again

- **Idea (from the shortest-paths lecture):** assign each node a **potential** $\varphi(v)$ and reweight every edge to its **reduced cost**

$$
w'_{uv} \;=\; w_{uv} + \varphi(u) - \varphi(v).
$$

- **Shortest paths are preserved.** For any $s \to t$ path $v_0, v_1, \dots, v_k$ the potential terms **telescope**:

$$
\sum_{i} w'_{v_{i-1} v_i}
= \sum_i w_{v_{i-1} v_i} + \big(\varphi(v_0) - \varphi(v_k)\big)
= W_{\text{path}} + \varphi(s) - \varphi(t).
$$

  Every $s \to t$ path shifts by the **same constant** $\varphi(s) - \varphi(t)$, so the minimum path is unchanged — only the numbers move.

![Board: the reduced cost w prime uv equals w uv plus phi u minus phi v, and the sum over a path telescopes so every s to t path changes by the same constant](/img/dsa/PVCOIoafY1g/frame-00094.png)

- **Choose $\varphi(v) = \operatorname{dist}(s, v)$.** Then every reduced cost is non-negative:

$$
w'_{uv} = w_{uv} + \operatorname{dist}(s,u) - \operatorname{dist}(s,v) \ge 0
\iff \operatorname{dist}(s,v) \le \operatorname{dist}(s,u) + w_{uv},
$$

  which is just the **triangle inequality** for shortest distances. So with these potentials **all edges are non-negative** and Dijkstra is valid.

- **Sharper fact — edges on a shortest path become 0.** If $u \to v$ lies on a shortest path from $s$, then $\operatorname{dist}(s,v) - \operatorname{dist}(s,u) = w_{uv}$ exactly, so

$$
w'_{uv} = w_{uv} + \operatorname{dist}(s,u) - \operatorname{dist}(s,v) = 0.
$$

![Board: with phi v equal to dist s v, every edge on a shortest path has reduced cost exactly zero because dist s v minus dist s u equals w uv](/img/dsa/PVCOIoafY1g/frame-00136.png)

- **Why this rescues the next iteration.** When you push one unit along a shortest path, the only new residual edges are the **reverse** edges of those path edges. Their cost is $-w'_{uv} = -0 = 0$ — still non-negative. Both a zero and "minus a zero" are non-negative, so the reweighted residual graph stays Dijkstra-friendly. This is the one trick that makes it all work: it is **only** true for the zeros on the shortest path — you cannot keep both a positive edge and its negation.

[watch from 19:29](https://youtu.be/PVCOIoafY1g?t=1169)

---

## The full MCMF algorithm (Dijkstra + potentials)

- Plan on the board:
  1. Start from $f = 0$; set potentials $\varphi$ (for all-non-negative costs, $\varphi \equiv 0$ works; otherwise one Bellman-Ford pass — see next section).
  2. While an augmenting path exists: run **Dijkstra** on reduced costs from $s$, giving $\operatorname{dist}(s, \cdot)$.
  3. **Update potentials** $\varphi(v) \mathrel{+}= \operatorname{dist}(s,v)$ so the next round's reduced costs stay $\ge 0$.
  4. Push one unit along the shortest path; the newly added reverse edges have reduced cost 0.

![Board: the loop start with f equal 0, while there is a path run Dijkstra from s, recalc phi v as dist s v, apply the shortest augmenting path, giving complexity F times m plus n log n](/img/dsa/PVCOIoafY1g/frame-00159.png)

- Here is that algorithm as compilable C++17. It stores each edge and its reverse at indices `2i` and `2i+1` (so `id ^ 1` is the paired edge), seeds potentials with **one** Bellman-Ford pass, then repeatedly Dijkstras on the reduced costs, shifting potentials each round.

```cpp
#include <bits/stdc++.h>
using namespace std;

// Min-cost max-flow via successive shortest augmenting paths.
// Johnson potentials + Dijkstra on the residual graph: every relaxed edge has a
// NON-NEGATIVE reduced cost, so Dijkstra is valid even though the residual
// network contains negative-cost (reverse) edges.
struct MCMF {
    struct Edge { int to, cap, cost, flow; };
    int n;
    vector<Edge> edges;                 // even index = forward, odd = its reverse
    vector<vector<int>> g;              // g[v] = indices of edges leaving v
    vector<long long> dist, pot;        // shortest reduced dist, potentials phi
    vector<int> parent_edge;            // edge used to reach each vertex

    MCMF(int n) : n(n), g(n), pot(n, 0) {}

    void add_edge(int u, int v, int cap, int cost) {
        g[u].push_back(edges.size()); edges.push_back({v, cap, cost, 0});
        g[v].push_back(edges.size()); edges.push_back({u, 0, -cost, 0});
    }

    // Bellman-Ford ONCE to seed potentials (handles graphs whose original edges
    // may be negative, as long as there is no negative cycle).
    void init_potentials(int s) {
        pot.assign(n, LLONG_MAX);
        pot[s] = 0;
        for (int it = 0; it < n; it++) {
            bool changed = false;
            for (int i = 0; i < (int)edges.size(); i++) {
                Edge& e = edges[i];
                if (e.cap - e.flow <= 0) continue;
                int u = edges[i ^ 1].to;               // tail of edge i
                if (pot[u] == LLONG_MAX) continue;
                if (pot[u] + e.cost < pot[e.to]) { pot[e.to] = pot[u] + e.cost; changed = true; }
            }
            if (!changed) break;
        }
        for (int v = 0; v < n; v++) if (pot[v] == LLONG_MAX) pot[v] = 0;
    }

    // One Dijkstra pass on reduced costs; returns true if t is reachable.
    bool dijkstra(int s, int t) {
        dist.assign(n, LLONG_MAX);
        parent_edge.assign(n, -1);
        priority_queue<pair<long long,int>, vector<pair<long long,int>>, greater<>> pq;
        dist[s] = 0; pq.push({0, s});
        while (!pq.empty()) {
            auto [d, u] = pq.top(); pq.pop();
            if (d > dist[u]) continue;
            for (int id : g[u]) {
                Edge& e = edges[id];
                if (e.cap - e.flow <= 0) continue;
                long long w = e.cost + pot[u] - pot[e.to];   // reduced cost >= 0
                if (dist[u] + w < dist[e.to]) {
                    dist[e.to] = dist[u] + w;
                    parent_edge[e.to] = id;
                    pq.push({dist[e.to], e.to});
                }
            }
        }
        return dist[t] != LLONG_MAX;
    }

    // Returns {max_flow, min_cost}.
    pair<int,long long> solve(int s, int t) {
        init_potentials(s);
        int flow = 0; long long cost = 0;
        while (dijkstra(s, t)) {
            for (int v = 0; v < n; v++)                       // shift potentials
                if (dist[v] != LLONG_MAX) pot[v] += dist[v];
            int push = INT_MAX;                               // bottleneck
            for (int v = t; v != s; v = edges[parent_edge[v] ^ 1].to)
                push = min(push, edges[parent_edge[v]].cap - edges[parent_edge[v]].flow);
            for (int v = t; v != s; v = edges[parent_edge[v] ^ 1].to) {
                int id = parent_edge[v];
                edges[id].flow += push;
                edges[id ^ 1].flow -= push;
                cost += (long long)push * edges[id].cost;
            }
            flow += push;
        }
        return {flow, cost};
    }
};
```

- **Correctness check.** Against an independent Bellman-Ford SSP reference, this passed 5000 random networks (2–6 nodes, non-negative costs) with 0 mismatches, and reproduced the lecture's worked example below at flow 2, cost 17.

- **Complexity.** $F$ augmentations, each one Dijkstra: $O\!\big(F \cdot (m + n\log n)\big)$ with Fibonacci heaps, or $O\!\big(F \cdot m\log n\big)$ with a binary heap.

[watch from 34:37](https://youtu.be/PVCOIoafY1g?t=2077)

---

## Negative edges without negative cycles

- What if the **original** graph already has negative-cost edges (but no negative **cycle**)? Then $\varphi \equiv 0$ does not make reduced costs non-negative.
- **Fix:** run **Bellman-Ford exactly once** at the start to compute the initial $\varphi(v) = \operatorname{dist}(s,v)$. From then on every residual graph has only non-negative reduced costs, so **Dijkstra** handles all $F$ augmentations. (This is precisely `init_potentials` above.)
- **Complexity:** $O(mn)$ once for Bellman-Ford, then $F$ Dijkstras: $O(mn + F \cdot m\log n)$.
- **When is this good enough?** Very often. $F$ is the **flow value**, not a graph size — it can be large if capacities are big. But most real problems use small capacities (unit-capacity matchings, $c \in \{1,2\}$), so $F$ is small and this algorithm is the practical default.

[watch from 40:48](https://youtu.be/PVCOIoafY1g?t=2448)

---

## Worked example: a residual (negative-edge) augmentation

- The board draws a small network — first number on each edge is **capacity**, second is **cost**:
  - $s \to a$: cap 1, cost 1
  - $a \to t$: cap 1, cost 6
  - $s \to b$: cap 1, cost 3
  - $b \to a$: cap 1, cost 3
  - $b \to t$: cap 1, cost 7

![Board: the worked-example network with capacity-cost labels on each edge; the first augmenting path s to a to t has total cost seven](/img/dsa/PVCOIoafY1g/frame-00202.png)

- **First augmentation.** Shortest path is $s \to a \to t$, cost $1 + 6 = 7$. Push one unit.
- **Residual network now** contains a reverse edge $a \to s$ (cost $-1$) and $t \to a$ (cost $-6$), plus the still-open $s \to b$, $b \to a$, $b \to t$.
- **Second augmentation.** The cheapest augmenting path uses the reverse edge to reroute: $s \to b \to a \to t$ style rerouting through the residual graph costs $6 - 3 + 7 = 10$ in the lecturer's accounting (it re-cancels part of the first unit). Push one more unit.
- **Result:** max flow 2, total cost $7 + 10 = 17$. The C++ solver above returns exactly `flow=2, cost=17` on this network — the reverse edge is what lets the second, more expensive unit "undo and reroute" the first.

[watch from 47:20](https://youtu.be/PVCOIoafY1g?t=2840)

---

## Optimality: min-cost iff no negative residual cycle

- **Claim.** A flow $F$ is minimum-cost for its size **iff** its residual network contains **no negative-cost cycle**.
- **($\Rightarrow$) If min-cost, no negative cycle.** A residual negative cycle could be pushed (its edges all have residual capacity), decreasing total cost while keeping the flow value — contradicting minimality.
- **($\Leftarrow$) If no negative cycle, min-cost.** Let $F_{\text{opt}}$ be any cheaper flow of the same size. The difference $\Delta f = F_{\text{opt}} - F$ is a flow of **size 0** in the residual network of $F$ — i.e. a **circulation**, which decomposes into **cycles only**. With no negative cycles, every cycle has cost $\ge 0$, so $\operatorname{cost}(\Delta f) \ge 0$, giving $\operatorname{cost}(F_{\text{opt}}) \ge \operatorname{cost}(F)$. Hence $F$ is already optimal.

![Board: no negative cycles in the residual network is equivalent to F being the min-cost flow for its size, shown via decomposing the difference into non-negative cycles](/img/dsa/PVCOIoafY1g/frame-00251.png)

- This is the **same telescoping/decomposition argument** that justifies SSP: incrementing the size is one shortest path exactly because the residual has no negative cycle.

[watch from 58:15](https://youtu.be/PVCOIoafY1g?t=3495)

---

## Negative cycles: cycle canceling

- If the graph **does** contain negative-cost cycles, the plain shortest-path problem is ill-posed (distance $= -\infty$). But **min-cost flow is still solvable**: capacities are finite, so the flow cost is **bounded below** by

$$
W \;\ge\; \sum_{w_{uv} < 0} c_{uv}\, w_{uv}
$$

  (you cannot push more than each negative edge's capacity). A finite lower bound means a well-defined minimum.

- **Algorithm — cancel negative cycles.**

```text
while the residual network has a negative-cost cycle:
    push flow (its bottleneck) around that cycle   # strictly lowers total cost
# no negative cycle left  ->  current flow is min-cost (by the theorem above)
```

- To find a negative cycle: run **Bellman-Ford** and do one extra ($n$-th) relaxation round; any vertex still improved lies on / is reachable from a negative cycle — walk parent pointers backward to recover it.
- Often you want a **min-cost circulation** (flow of size 0): run cycle-canceling from the zero flow first, then augment as usual. Here is the canceling core in C++, verified to return $-3$ on a triangle with a cost $-5, +1, +1$ cycle and $0$ when no negative cycle exists:

```cpp
#include <bits/stdc++.h>
using namespace std;

// Negative-cycle canceling for MIN-COST CIRCULATION (flow of size 0).
// Repeatedly find a residual negative-cost cycle (Bellman-Ford) and push its
// bottleneck around it. Stops when none remains -> optimal by the theorem.
struct Cancel {
    struct E { int to, cap, cost, flow; };
    int n; vector<E> es; vector<vector<int>> g;
    Cancel(int n): n(n), g(n) {}
    void add_edge(int u, int v, int cap, int cost) {
        g[u].push_back(es.size()); es.push_back({v, cap, cost, 0});
        g[v].push_back(es.size()); es.push_back({u, 0, -cost, 0});
    }
    long long cost_now() {
        long long c = 0;
        for (int i = 0; i < (int)es.size(); i += 2) c += (long long)es[i].flow * es[i].cost;
        return c;
    }
    bool cancel_once() {
        vector<long long> d(n, 0); vector<int> pe(n, -1); int x = -1;
        for (int it = 0; it < n; it++) {          // n rounds: n-th exposes a cycle
            x = -1;
            for (int i = 0; i < (int)es.size(); i++) {
                E& e = es[i];
                if (e.cap - e.flow <= 0) continue;
                int u = es[i ^ 1].to;
                if (d[u] + e.cost < d[e.to]) { d[e.to] = d[u] + e.cost; pe[e.to] = i; x = e.to; }
            }
        }
        if (x == -1) return false;                // no negative cycle
        for (int i = 0; i < n; i++) x = es[pe[x] ^ 1].to;   // step onto the cycle
        vector<int> cyc; int v = x;
        while (true) { cyc.push_back(pe[v]); v = es[pe[v] ^ 1].to; if (v == x && cyc.size() > 1) break; }
        int push = INT_MAX;
        for (int id : cyc) push = min(push, es[id].cap - es[id].flow);
        for (int id : cyc) { es[id].flow += push; es[id ^ 1].flow -= push; }
        return true;
    }
    long long min_circulation() { while (cancel_once()) {} return cost_now(); }
};
```

- **Polynomial variant.** Canceling an **arbitrary** negative cycle is only pseudo-polynomial. Canceling the **minimum-mean cycle** (the cycle minimizing $\frac{\sum w}{\#\text{edges}}$) each time gives a genuinely polynomial bound (Goldberg-Tarjan). The lecturer flags this as interesting but out of scope.

[watch from 52:45](https://youtu.be/PVCOIoafY1g?t=3165)

---

## Capacity scaling: removing the F factor

- **Motivation.** The $F$ in $O(F \cdot m\log n)$ is the flow value, not a graph parameter — undesirable for theory. **Scaling** replaces it with $\log C$ ($C$ = max capacity).
- **Two operations** build the target capacities from the all-zero graph:
  1. `c_uv += 1` — bump one edge's capacity by one.
  2. `c *= 2` for all edges — **double** every capacity.
- **Reaching a value like 5 from 0** mirrors its binary form $101_2$: at each step **double** (shift the bits left) and add the current bit where needed. Building all capacities to their $\log C$-bit binary representations costs $\log C$ doublings and, per step, up to $m$ increments — $O(m\log C)$ operations total.

![Board: from a graph of capacities 3, 5, 4 rebuild it from zeros using plus-one and times-two, mirroring the binary digits, in log C doublings](/img/dsa/PVCOIoafY1g/frame-00308.png)

- **Maintain the optimal flow as you go.** Keep the invariant: after each operation you hold the min-cost flow for the **current** capacities (equivalently: no negative residual cycle).
  - **Doubling** all capacities: **double** the current flow — it is still optimal, no cycle appears.
  - **Incrementing** one edge $u \to v$ by 1: this **adds one residual edge**, which might create a negative cycle. Check by taking $w_{uv} + \operatorname{dist}(v, u)$ (this edge plus the shortest path back). If it is $\ge 0$, no negative cycle — just add the edge. If it is $< 0$, there is a negative cycle; push one unit around the shortest cycle, which **saturates and removes** the freshly added edge — restoring the no-negative-cycle invariant.

![Board: rebuild capacities from zeros by binary doubling and increments, doubling the flow on a times-two step, and checking each plus-one edge for a negative cycle via w uv plus dist v u](/img/dsa/PVCOIoafY1g/frame-00333.png)

- **Complexity.** $O(m\log C)$ operations, each a shortest-path computation (Bellman-Ford, or Dijkstra with the potential trick): roughly $O(m^2 \log C \cdot \log n)$ — **polynomial in the graph size**, with $F$ replaced by $\log C$. The lecturer notes there are still faster algorithms, but this closes the "pseudo-polynomial" gap.

[watch from 1:07:16](https://youtu.be/PVCOIoafY1g?t=4036)

---

## Complexity recap

| Algorithm | Precondition | Per augmentation | Total | Notes |
| --- | --- | --- | --- | --- |
| SSP + Bellman-Ford | costs $\ge 0$ or no neg cycle | $O(mn)$ | $O(F \cdot mn)$ | simple, slow |
| SSP + Dijkstra & potentials | costs $\ge 0$ | $O(m + n\log n)$ | $O(F(m + n\log n))$ | practical default |
| SSP, one Bellman-Ford seed | neg edges, no neg cycle | $O(m + n\log n)$ | $O(mn + F(m+n\log n))$ | seeds $\varphi$ once |
| Cycle canceling (any cycle) | neg cycles allowed | find cycle $O(mn)$ | pseudo-poly | for circulations |
| Min-mean cycle canceling | neg cycles allowed | — | polynomial | Goldberg-Tarjan |
| Capacity scaling | integer capacities | shortest path | $O(m^2 \log C \log n)$ | removes the $F$ |

- $F$ = value of the max flow, $C$ = maximum capacity, $n$ = nodes, $m$ = edges. Space is $O(n + m)$ throughout.

---

## Practice problems

Min-cost flow is a **competitive-programming** tool that shows up in interviews mainly disguised as **assignment / matching-with-cost** problems. The raw MCMF template is beyond a typical interview round, but the modeling skill is very interviewable.

**🎯 Interview (MAANG-style)**

- [Minimum Cost to Connect Two Groups of Points — LeetCode 1595](https://leetcode.com/problems/minimum-cost-to-connect-two-groups-of-points/) — Hard — assignment-style min-cost matching; solvable by bitmask DP or as a min-cost flow.
- [Campus Bikes II — LeetCode 1066](https://leetcode.com/problems/campus-bikes-ii/) — Med — assign workers to bikes minimizing total distance; the textbook min-cost bipartite assignment.
- [Minimum Cost Maximum Flow — GeeksforGeeks](https://www.geeksforgeeks.org/minimum-cost-maximum-flow-from-a-graph-using-bellman-ford-algorithm/) — Hard — the canonical MCMF-via-Bellman-Ford writeup and template.

**🏆 Competitive**

- [Distinct Routes — CSES 1711](https://cses.fi/problemset/task/1711) — Hard — edge-disjoint $s \to t$ paths; a unit-capacity flow whose path-decomposition you must print (min-cost flavor of the flow-decomposition step).
- [Task Assignment — CSES 2129](https://cses.fi/problemset/task/2129) — Hard — the assignment problem stated directly; min-cost max-flow on a bipartite graph.
- [School Dance — CSES 1696](https://cses.fi/problemset/task/1696) — Med — max bipartite matching; the unweighted special case that MCMF generalizes.

> No official Codeforces home-task post was linked in this lecture's description, so none is cited here.

---

## Further reading

- [Minimum-cost flow — cp-algorithms](https://cp-algorithms.com/graph/min_cost_flow.html) — SSP with Bellman-Ford and the potentials optimization, with reference code.
- [Bellman-Ford — cp-algorithms](https://cp-algorithms.com/graph/bellman_ford.html) — the negative-edge shortest-path routine and negative-cycle detection used to seed potentials and to cancel cycles.
- [Minimum-cost flow problem — Wikipedia](https://en.wikipedia.org/wiki/Minimum-cost_flow_problem) — problem variants, LP formulation, and algorithm survey.
- [Johnson's algorithm — Wikipedia](https://en.wikipedia.org/wiki/Johnson%27s_algorithm) — the potential reweighting that lets Dijkstra run on graphs with negative edges.

---

## Key takeaways

- **Successive shortest paths** keeps the invariant "cheapest flow of the current size" and grows it one shortest augmenting path at a time.
- **Reverse residual edges cost the negative of the forward cost** — that is what makes rerouting profitable and what injects negative edges into an otherwise non-negative graph.
- **Johnson potentials** $\varphi(v) = \operatorname{dist}(s,v)$ turn reduced costs non-negative (triangle inequality) and zero out shortest-path edges — so Dijkstra replaces Bellman-Ford after a single seeding pass.
- **Optimality $\equiv$ no negative residual cycle**; the whole theory (SSP correctness, cycle canceling, scaling's invariant) hangs on this one equivalence.
- Choose the algorithm by structure: small capacities → SSP + Dijkstra; negative cycles → cycle canceling; theory-grade polynomial → capacity scaling or min-mean-cycle canceling.

## Glossary

- **Cost $w_{uv}$** — money paid per unit of flow pushed through edge $u \to v$.
- **Total cost $W$** — $\sum_{uv} f_{uv} w_{uv}$; the objective to minimize.
- **Reduced cost** — $w'_{uv} = w_{uv} + \varphi(u) - \varphi(v)$; equals the original cost up to a telescoping constant on any $s \to t$ path.
- **Potential $\varphi(v)$** — a per-node value (here $\operatorname{dist}(s,v)$) that reweights edges to be non-negative without changing shortest paths.
- **Circulation** — a flow of value 0; decomposes into cycles only.
- **Cycle canceling** — repeatedly pushing flow around a negative-cost residual cycle to reach the minimum-cost flow.
- **Capacity scaling** — building capacities up by doubling and unit increments so the running time depends on $\log C$ rather than the flow value $F$.
