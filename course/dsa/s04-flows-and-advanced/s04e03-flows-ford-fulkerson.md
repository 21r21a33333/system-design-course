---
title: "S04E03 · Flows, Cuts & Ford-Fulkerson"
sidebar_position: 3
description: The maximum-flow problem, the symmetric residual model with reverse edges, Ford-Fulkerson augmenting paths, Edmonds-Karp with its O(VE squared) proof, and the max-flow min-cut theorem proved through the residual graph.
---

# S04E03 · Flows, Cuts & Ford-Fulkerson

> **Source:** Pavel Mavrin, [_A&DS S04E03_](https://youtu.be/upMO57J2q58) · 1h39m lecture → ~15 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- A **flow network** is a directed graph with a **source** $s$, a **sink** $t$, and a **capacity** $c_{uv} \ge 0$ on every edge. A **flow** picks $f_{uv}$ per edge obeying $0 \le f_{uv} \le c_{uv}$ and **conservation** (in = out) at every node but $s$ and $t$. The **value** $F$ is the net outflow of $s$.
- The lecture uses a **symmetric model**: for every edge add a **reverse edge** with capacity $0$ and enforce $f_{uv} = -f_{vu}$. This collapses "in-edges" and "out-edges" into one set and makes conservation the single equation $\sum_u f_{vu} = 0$.
- **Residual capacity** is $c'_{uv} = c_{uv} - f_{uv}$; the **residual network** keeps only edges with $c'_{uv} > 0$. An **augmenting path** is any $s \to t$ path in it.
- **Ford-Fulkerson**: while an augmenting path exists, push $\delta = \min c'$ along it. **Edmonds-Karp** picks the *shortest* augmenting path (BFS) and runs in $O(VE^2)$; plain FF is only $O(F \cdot E)$ (pseudo-polynomial).
- **Max-flow min-cut theorem**: the maximum flow value equals the minimum cut capacity. Proof falls out of the residual graph — when no augmenting path remains, the reachable set defines a **saturated cut** whose capacity equals the current flow.

---

## The network-flow problem

- Picture liquid flowing through a directed graph from **source** $s$ to **sink** $t$. Each edge has a **capacity** — how many units per second may pass.
- A **flow** assigns each edge a number $f_{uv}$ (drawn in red on the board) with two rules:
  - **Capacity:** $0 \le f_{uv} \le c_{uv}$.
  - **Conservation:** at every node except $s$ and $t$, liquid in equals liquid out.
- The **value of the flow** $F$ is measured two equivalent ways: total leaving $s$, or total entering $t$ — they match because nothing is created or destroyed in between. On the board example both give $F = 13$.
- **Goal:** maximize $F$. That is the maximum-flow problem.

![Flow network with capacities and a red flow of value F = 13, measured at both source and sink](/img/dsa/upMO57J2q58/frame-00020.png)

- Formally, with $c_{uv}$ the capacity and $f_{uv}$ the flow:

$$
0 \le f_{uv} \le c_{uv}, \qquad
\sum_{u} f_{uv} \;=\; \sum_{w} f_{vw} \quad (\forall\, v \ne s, t)
$$

$$
F \;=\; \sum_{u} f_{su} \;-\; \sum_{u} f_{us}
$$

- The value subtracts liquid flowing *back into* $s$, so edges pointing at the source are handled honestly.

[watch from 0:14](https://youtu.be/upMO57J2q58?t=14)

---

## The symmetric model: reverse edges

- The raw model is awkward: conservation mixes a sum over **incoming** edges with a sum over **outgoing** edges. Every later algorithm would have to look both ways at once.
- **Fix:** for every edge $u \to v$ add a **reverse edge** $v \to u$ and declare

$$
f_{uv} = -f_{vu}, \qquad c_{vu} = 0 \quad (\text{for the added reverse edge})
$$

- Now there is no distinction between "real" and "reverse" edges; every edge is treated identically. Two simplifications follow:
  - **Capacity constraint collapses to one inequality.** The reverse edge has $c_{vu} = 0$ and $f_{vu} = -f_{uv} \le c_{vu} = 0$, which rearranges to $f_{uv} \ge 0$. So the single rule $f_{uv} \le c_{uv}$ already implies non-negativity of the forward flow — no separate lower bound needed.
  - **Conservation collapses to one sum.** Outgoing minus incoming becomes one signed sum:

$$
\sum_{u} f_{vu} = 0 \quad (\forall\, v \ne s, t), \qquad F = \sum_{u} f_{su}
$$

- **Multi-edges are fine.** If two parallel edges join the same pair, attach the flow to the *edge object*, not to an index pair. In code you keep a **list of edge objects** each carrying its own capacity and flow, so parallel edges never collide.

![The symmetric model — reverse edge with f_uv = minus f_vu, c_uv = 0, and the single constraint f_uv at most c_uv, plus the balance and value equations](/img/dsa/upMO57J2q58/frame-00075.png)

[watch from 7:26](https://youtu.be/upMO57J2q58?t=446)

---

## Flow decomposition (paths and cycles)

- **Flows add.** If $f^1$ and $f^2$ are flows, so is $f = f^1 + f^2$ (edge-wise sum). This makes flows behave like vectors.
- **Decomposition theorem.** Every flow can be written as a sum of at most $m$ simpler flows

$$
f = f_1 + f_2 + \dots + f_k, \qquad k \le m
$$

where each $f_i$ is either a **path** $s \to t$ or a **cycle**, carrying one constant amount.

- **Constructive proof.** Repeat: start at $s$, walk out along any edge with positive flow. By conservation, whenever you enter a node on a positive edge there must be a positive edge leaving it — so you cannot get stuck; you either reach $t$ (a path) or revisit a node (a cycle). Take the **minimum** flow along that path or cycle and subtract it everywhere on it.
- **Why it terminates.** Each subtraction drives **at least one edge to zero** (the one achieving the minimum). With $m$ edges, the process stops after at most $m$ steps — hence $k \le m$. (Just decreasing the total flow is not enough for real-valued capacities; "an edge hits zero each step" is the strong argument.)

![Flow decomposed into three s-to-t path flows F1, F2, F3, each subtracted until an edge zeroes out](/img/dsa/upMO57J2q58/frame-00095.png)

- **Why care:** thinking of a flow as a bundle of paths is exactly how you turn "find $k$ edge-disjoint paths" into "find a flow of value $k$, then decompose".

[watch from 15:13](https://youtu.be/upMO57J2q58?t=913)

---

## The residual network

- Given a flow, ask of each edge: **how much more can I push?** That headroom is the **residual capacity**

$$
c'_{uv} = c_{uv} - f_{uv}
$$

- The **residual network** has the same nodes and keeps every edge with $c'_{uv} > 0$; edges with $c'_{uv} = 0$ (called **saturated**) are dropped.
- The reverse edges matter here. A forward edge carrying $f_{uv} = 9$ out of capacity $10$ contributes:
  - a forward residual edge of capacity $c'_{uv} = 10 - 9 = 1$ (room to push more), and
  - a **backward** residual edge of capacity $c'_{vu} = c_{vu} - f_{vu} = 0 - (-9) = 9$ (room to *cancel* flow already sent).
- So a residual backward edge of capacity $9$ says: "you may retract up to $9$ units of the flow currently on $u \to v$." That retraction ability is what lets the algorithm fix earlier greedy mistakes.

![Residual capacity c'_uv = c_uv minus f_uv with c'_uv greater than zero, forward headroom and backward cancel edges](/img/dsa/upMO57J2q58/frame-00135.png)

[watch from 26:25](https://youtu.be/upMO57J2q58?t=1585)

---

## The Ford-Fulkerson scheme

- **Start** from the zero flow — it is valid (all balances are $0$, and $0 \le c_{uv}$).
- **Repeat:** find an **augmenting path** = any $s \to t$ path in the residual network (all edges have $c' > 0$). Let

$$
\delta = \min_{\text{edges on path}} c'_{uv}
$$

and push $+\delta$ along the whole path. Because $\delta$ is the minimum residual, no capacity is violated afterward.

- **Stop** when no augmenting path exists — the claim (proved below via cuts) is that the flow is then **maximum**.

$$
\text{no augmenting path} \iff F = F_{\max}
$$

- An augmenting path may run **backward** on some edges (using a residual reverse edge). Backward means "decrease the flow here"; forward means "increase it". The symmetric model makes both the same operation — just push $+\delta$ on a residual edge.

![Ford-Fulkerson scheme — augmenting path, delta = min c' on the path, and no augmenting path implies F is maximum](/img/dsa/upMO57J2q58/frame-00165.png)

[watch from 31:22](https://youtu.be/upMO57J2q58?t=1882)

---

## The DFS: find, minimize, and push in one pass

- The board writes one recursive DFS that does all three steps at once. It **carries the running minimum $\delta$ down** the path and, on the way back out of the recursion, **pushes that $\delta$** onto each edge it used.
- The function returns the amount of flow it managed to push (0 if it hit a dead end):

```text
int dfs(v, δ):
    if mark[v]: return 0
    mark[v] = true
    if v == t: return δ                 # reached sink: δ is the min residual so far
    for each edge (v → u):
        if c[v][u] - f[v][u] == 0: continue     # saturated in residual → skip
        Δ = dfs(u, min(δ, c[v][u] - f[v][u]))   # recurse with tightened headroom
        if Δ > 0:                        # a path was found through u
            f[v][u] += Δ                 # push forward
            f[u][v] -= Δ                 # symmetric: reverse edge decreases
            return Δ
    return 0
```

- The full, compiling C++ — a board-faithful recursive Ford-Fulkerson over a residual edge list, with parallel edges stored as objects (edge `id` and `id ^ 1` are reverses):

```cpp
#include <bits/stdc++.h>
using namespace std;

struct FordFulkerson {
    struct Edge { int to; long long cap, flow; };
    vector<Edge> e;                 // edges 2k and 2k+1 are reverses of each other
    vector<vector<int>> g;          // g[v] = edge ids leaving v
    vector<char> mark;
    int n, t;

    FordFulkerson(int n) : g(n), n(n) {}

    void add_edge(int u, int v, long long c) {
        g[u].push_back(e.size()); e.push_back({v, c, 0});
        g[v].push_back(e.size()); e.push_back({u, 0, 0});   // reverse, capacity 0
    }

    // push flow from v to t given headroom delta; return amount pushed (0 if none)
    long long dfs(int v, long long delta) {
        if (mark[v]) return 0;
        mark[v] = 1;
        if (v == t) return delta;                 // reached sink
        for (int id : g[v]) {
            long long resid = e[id].cap - e[id].flow;   // residual c' = c - f
            if (resid == 0) continue;                   // saturated: skip
            long long d = dfs(e[id].to, min(delta, resid));
            if (d > 0) {
                e[id].flow     += d;               // f[v][u] += d
                e[id ^ 1].flow -= d;               // f[u][v] -= d  (symmetric)
                return d;
            }
        }
        return 0;
    }

    long long maxflow(int s, int sink) {
        t = sink;
        long long flow = 0, pushed;
        do {
            mark.assign(n, 0);                     // fresh visited set per augmenting DFS
            pushed = dfs(s, LLONG_MAX);
            flow += pushed;
        } while (pushed > 0);                       // stop when no augmenting path
        return flow;
    }
};
```

- **Data structure:** an **edge list**, not an adjacency matrix — so multi-edges each keep their own `flow`. The reverse-edge trick lives entirely in the `id ^ 1` pairing.
- **Complexity of plain FF:** each DFS is $O(m)$. The number of augmenting phases is bounded only by the **flow value** $F$, giving $O(F \cdot m)$ — **pseudo-polynomial**, since $F$ depends on the *magnitude* of the numbers, not the size of the input.

![Board DFS — mark, return delta at t, iterate edges with c - f greater than zero, recurse, push on the way back, O(F m)](/img/dsa/upMO57J2q58/frame-00230.png)

[watch from 39:15](https://youtu.be/upMO57J2q58?t=2355)

---

## Why plain Ford-Fulkerson can be slow

- Bad path choices make FF crawl. Take the classic diamond: $s \to a$ and $s \to b$ with capacity $100$, $a \to b$ with capacity $1$, and $a \to t$, $b \to t$ with capacity $100$.
- If DFS keeps routing through the tiny middle edge $a \to b$, each augmenting path carries only $\delta = 1$. It then bounces back and forth using the residual reverse edge, taking $\sim 200$ phases to reach the true max flow of $200$.
- Replace the capacity $100$ with a **billion** and FF does a billion phases. The cost is proportional to $F$, which is **not polynomial in the input size** — you can encode $F$ in a handful of digits.
- **When it is still fine:** if you *know* the flow is small (e.g. you only need $2$ edge-disjoint paths, so $F = 2$), plain FF is perfectly good.

![Diamond worst case — capacities 100, middle edge 1, augmenting through the middle forces one unit per phase](/img/dsa/upMO57J2q58/frame-00285.png)

[watch from 48:36](https://youtu.be/upMO57J2q58?t=2916)

---

## The minimum-cut problem and duality

- An **$s$-$t$ cut** removes a set of edges so that **no path from $s$ to $t$ survives**. Its **value** is the total capacity of the removed edges. The **min-cut** problem: make that value as small as possible.
- Equivalently, split the nodes into set $S$ (containing $s$) and set $T$ (containing $t$). The cut is exactly the edges going **from $S$ to $T$**, and its capacity is $\sum_{u \in S,\, v \in T} c_{uv}$.
- **Weak duality — every flow is at most every cut.** All the liquid must cross from $S$ to $T$, and only the $S \to T$ edges carry it, so

$$
F \;=\; \sum_{u \in S,\, v \in T} f_{uv} \;\le\; \sum_{u \in S,\, v \in T} c_{uv} \;=\; C
$$

$$
F \le C \quad \text{for every flow } F \text{ and every cut } C
$$

- So max-flow and min-cut squeeze toward each other from opposite sides. If we ever exhibit a flow and a cut with **equal value**, both must be optimal simultaneously. This is the same primal-dual pattern as maximum matching versus minimum vertex cover.

![Weak duality F at most C — the S-T partition, cut edges carry all the flow, so flow value cannot exceed cut capacity](/img/dsa/upMO57J2q58/frame-00250.png)

[watch from 55:07](https://youtu.be/upMO57J2q58?t=3307)

---

## Max-flow min-cut theorem

- **Theorem.** The maximum flow value equals the minimum cut capacity.
- **Proof (via the residual graph).** Run FF to a flow with **no augmenting path**. From $s$, run one more DFS over residual edges (those with $c' > 0$) and mark everything reachable — call it $S$; the rest is $T$. Since $t$ is unreachable, $t \in T$, so this is a genuine $s$-$t$ cut.
- Look at any edge $u \to v$ with $u \in S,\ v \in T$. If its residual capacity were positive we could have crossed it and put $v$ in $S$ — contradiction. So every such edge has $c'_{uv} = 0$, i.e. it is **saturated**: $f_{uv} = c_{uv}$.
- Summing over the cut edges:

$$
F = \sum_{u \in S,\, v \in T} f_{uv} = \sum_{u \in S,\, v \in T} c_{uv} = C
$$

- We produced a cut whose capacity equals the current flow. By weak duality that flow is maximum and that cut is minimum. This simultaneously proves the "no augmenting path $\iff$ maximum flow" claim left open earlier, **and** shows how to *recover* the min cut: the reachable set $S$ in the final residual graph.

![Min cut recovered from the final residual graph — reachable set S, all S-to-T edges saturated, so F equals C](/img/dsa/upMO57J2q58/frame-00243.png)

[watch from 62:44](https://youtu.be/upMO57J2q58?t=3764)

---

## Edmonds-Karp: shortest augmenting path is polynomial

- **Idea:** replace DFS with **BFS**, always augmenting along a **shortest** (fewest-edges) path. On the diamond worst case, BFS ignores the tiny middle edge and finishes in two phases.
- Let $d(v)$ = distance $s \to v$ in the *current* residual network (edges unweighted). The residual graph changes as we augment, so $d$ changes too.

**Key lemma — distances never decrease.** $d(v)$ is non-decreasing across phases.

- On a shortest augmenting path, distances step up by exactly one: $d(s) = 0, d(\text{next}) = 1, \dots$
- Augmenting **removes** the saturated edges of the path (at least one becomes saturated) and **adds** their reverse edges. A newly added reverse edge $v \to u$ runs from a farther node to a nearer one along a shortest path, so it can never shortcut anything — adding it cannot lower any $d$. Removing edges also cannot lower any $d$. Hence $d$ only grows.

**Counting — each edge is removed at most $O(V)$ times.** Follow one edge $u \to v$ through its life:

- When it is **removed** (saturated on a shortest path), $d(u) = d(v) + 1$.
- To be removed again it must first be **re-inserted**, which happens only when its reverse is on a shortest path, giving (new) $d(v) = d(u) + 1$.
- Chaining with "distances never decrease":

$$
d_{\text{new}}(v) = d_{\text{new}}(u) + 1 \ge d_{\text{old}}(u) + 1 = \big(d_{\text{old}}(v) + 1\big) + 1 = d_{\text{old}}(v) + 2
$$

- So each remove-then-reinsert cycle raises $d(v)$ by at least $2$. Since $d(v) \le V - 1$, an edge is removed at most $O(V)$ times.

**Total.** There are $m$ edges, each removed $O(V)$ times, so at most $O(VE)$ augmenting phases. Each phase is one BFS in $O(E)$:

$$
T = O(V \cdot E) \cdot O(E) = O(V E^2)
$$

- This is **strongly polynomial** — it depends only on the graph size, never on the capacity magnitudes.

![Edmonds-Karp analysis — d(v) never decreases, remove and re-insert raise d(v) by at least two, giving O(n m squared)](/img/dsa/upMO57J2q58/frame-00335.png)

- The BFS-augmenting version (the one to actually submit) with residual min-cut recovery:

```cpp
#include <bits/stdc++.h>
using namespace std;

struct EdmondsKarp {
    struct Edge { int to; long long cap; };
    vector<Edge> e;                 // e[2k], e[2k+1] are reverse of each other
    vector<vector<int>> g;
    int n;

    EdmondsKarp(int n) : g(n), n(n) {}

    void add_edge(int u, int v, long long c) {
        g[u].push_back(e.size()); e.push_back({v, c});
        g[v].push_back(e.size()); e.push_back({u, 0});   // reverse, capacity 0
    }

    long long maxflow(int s, int t) {
        long long flow = 0;
        while (true) {
            vector<int> par(n, -1);
            par[s] = -2;
            queue<int> q; q.push(s);
            while (!q.empty() && par[t] == -1) {
                int v = q.front(); q.pop();
                for (int id : g[v])
                    if (par[e[id].to] == -1 && e[id].cap > 0) {  // residual edge
                        par[e[id].to] = id;
                        q.push(e[id].to);
                    }
            }
            if (par[t] == -1) break;                    // no augmenting path: done

            long long delta = LLONG_MAX;                // min residual on the path
            for (int v = t; v != s; ) { int id = par[v]; delta = min(delta, e[id].cap); v = e[id ^ 1].to; }
            for (int v = t; v != s; ) { int id = par[v]; e[id].cap -= delta; e[id ^ 1].cap += delta; v = e[id ^ 1].to; }
            flow += delta;
        }
        return flow;
    }

    // min-cut side: nodes reachable from s in the FINAL residual graph
    vector<char> reachable(int s) {
        vector<char> vis(n, 0);
        queue<int> q; q.push(s); vis[s] = 1;
        while (!q.empty()) {
            int v = q.front(); q.pop();
            for (int id : g[v])
                if (!vis[e[id].to] && e[id].cap > 0) { vis[e[id].to] = 1; q.push(e[id].to); }
        }
        return vis;                                     // vis[v] == 1  ⟺  v in S
    }
};
```

- **Verified.** Both implementations were compile-tested with `c++ -std=c++17` and checked against a brute-force min-cut (all $2^V$ node partitions) on thousands of random tiny networks — max flow equals min cut every time, confirming the theorem operationally.

![Edmonds-Karp improves O(F m) to O(n m squared) by always augmenting along the shortest residual path](/img/dsa/upMO57J2q58/frame-00360.png)

[watch from 66:35](https://youtu.be/upMO57J2q58?t=3995)

---

## Capacity scaling (bonus improvement)

- Another way to avoid tiny augmentations: only accept an augmenting path whose **every** residual edge is at least $2^k$, and sweep $k$ downward from $\lfloor \log C \rfloor$ to $0$.
- In code, change one line of the search: instead of `residual > 0`, require `residual >= (1 << k)`.
- **Why it is fast.** When phase $k$ starts, phase $k+1$ found no path of value $\ge 2^{k+1}$ — so there is a cut whose every edge has residual $< 2^{k+1}$. The gap between current and max flow is at most $2^{k+1} \cdot m$, and each phase-$k$ augmentation adds $\ge 2^k$, so phase $k$ needs $\le 2m$ augmentations.
- With $O(\log C)$ values of $k$, each doing $O(m)$ augmenting paths found by an $O(m)$ search:

$$
T = O(\log C \cdot m^2)
$$

- **Edmonds-Karp $O(VE^2)$ vs scaling $O(m^2 \log C)$:** the first depends only on graph size (strongly polynomial); the second carries a $\log C$ factor (weakly polynomial). Both are useful, and the next lecture combines these ideas into faster algorithms.

[watch from 87:36](https://youtu.be/upMO57J2q58?t=5256)

---

## Complexity recap

| Algorithm | Augmenting rule | Phases | Per phase | Total | Polynomial? |
| --- | --- | --- | --- | --- | --- |
| Ford-Fulkerson (DFS) | any path | $O(F)$ | $O(E)$ | $O(F \cdot E)$ | pseudo-poly (depends on $F$) |
| Edmonds-Karp (BFS) | shortest path | $O(VE)$ | $O(E)$ | $O(VE^2)$ | strongly polynomial |
| Capacity scaling | residual $\ge 2^k$ | $O(m \log C)$ | $O(E)$ | $O(E^2 \log C)$ | weakly polynomial |
| Min cut (from max flow) | — | — | one BFS/DFS | $+\,O(E)$ | recovers $S$ = reachable set |

- Space for all: $O(V + E)$ for the residual edge list.

---

## Practice problems

Max-flow / min-cut is a **core competitive-programming topic** and shows up in interviews mostly disguised as **assignment / bipartite-matching** problems (each such problem reduces to a unit-capacity flow). It is heavier than a typical interview round, so the interview list below is the matching-flavored subset you are realistically asked; the competitive list is where flow lives natively.

**🎯 Interview (MAANG-style, matching/assignment that reduces to flow)**

- [Maximum Students Taking Exam — LeetCode 1349](https://leetcode.com/problems/maximum-students-taking-exam/) — Hard — independent-set on a grid; a classic max-matching / min-vertex-cover (König) that flow solves.
- [Campus Bikes II — LeetCode 1066](https://leetcode.com/problems/campus-bikes-ii/) — Medium — assignment problem; min-cost perfect matching, the weighted cousin of flow (bitmask DP in practice, flow in theory).
- [Maximum Number of Achievable Transfer Requests — LeetCode 1601](https://leetcode.com/problems/maximum-number-of-achievable-transfer-requests/) — Hard — building-balance requests, a conservation constraint identical to flow balance.
- [Minimum Cost to Connect Two Groups of Points — LeetCode 1595](https://leetcode.com/problems/minimum-cost-to-connect-two-groups-of-points/) — Hard — min-cost assignment across two groups; the weighted bipartite-matching / min-cost-flow model.

**🏆 Competitive (flow is the intended solution)**

- [Download Speed — CSES 1694](https://cses.fi/problemset/task/1694) — Medium — plain maximum flow from source to sink; the "hello world" of flow.
- [Police Chase — CSES 1695](https://cses.fi/problemset/task/1695) — Medium — **minimum cut**: max-flow then recover the saturated cut edges.
- [School Dance — CSES 1696](https://cses.fi/problemset/task/1696) — Medium — **bipartite matching** modeled as unit-capacity flow.
- [Distinct Routes — CSES 1711](https://cses.fi/problemset/task/1711) — Medium — max flow of value $k$, then **decompose into $k$ edge-disjoint paths** (the decomposition theorem in action).

---

## Further reading

- [Maximum flow — Ford-Fulkerson and Edmonds-Karp — cp-algorithms](https://cp-algorithms.com/graph/edmonds_karp.html) — implementation and the $O(VE^2)$ proof.
- [Maximum flow — Dinic's algorithm — cp-algorithms](https://cp-algorithms.com/graph/dinic.html) — the faster $O(V^2 E)$ successor teased for next lecture.
- [Max-flow min-cut theorem — Wikipedia](https://en.wikipedia.org/wiki/Max-flow_min-cut_theorem) — the duality statement and its LP view.
- [Ford-Fulkerson algorithm — Wikipedia](https://en.wikipedia.org/wiki/Ford%E2%80%93Fulkerson_algorithm) and [Edmonds-Karp algorithm — Wikipedia](https://en.wikipedia.org/wiki/Edmonds%E2%80%93Karp_algorithm).
- [Ford-Fulkerson for maximum flow — GeeksforGeeks](https://www.geeksforgeeks.org/ford-fulkerson-algorithm-for-maximum-flow-problem/) and [Minimum cut in a directed graph — GeeksforGeeks](https://www.geeksforgeeks.org/minimum-cut-in-a-directed-graph/).

---

## Key takeaways

- Model flow with **reverse edges** ($f_{uv} = -f_{vu}$, reverse capacity $0$): capacity and conservation each collapse to a single equation, and "increase" and "decrease" become the same push.
- **Residual capacity** $c'_{uv} = c_{uv} - f_{uv}$; an **augmenting path** is any $s \to t$ path with all $c' > 0$. Push $\delta = \min c'$ along it.
- **No augmenting path $\iff$ maximum flow** — because the reachable set in the final residual graph is a **saturated cut** with capacity equal to the flow.
- **Max-flow = min-cut.** Same theorem gives you both the optimum value *and* an algorithm to extract the cut (reachable set $S$).
- Plain FF is $O(F \cdot E)$ (pseudo-polynomial); **Edmonds-Karp** (shortest augmenting path via BFS) is $O(VE^2)$ and strongly polynomial; **scaling** gives $O(E^2 \log C)$.

## Glossary

- **Capacity $c_{uv}$** — maximum flow an edge may carry.
- **Flow $f_{uv}$** — actual amount sent; obeys $0 \le f_{uv} \le c_{uv}$ and conservation.
- **Flow value $F$** — net outflow of the source (= net inflow of the sink).
- **Residual capacity $c'_{uv} = c_{uv} - f_{uv}$** — remaining headroom on an edge.
- **Residual network** — graph of edges with $c' > 0$; where augmenting paths are searched.
- **Augmenting path** — an $s \to t$ path in the residual network; may run backward on real edges.
- **Saturated edge** — one with $f_{uv} = c_{uv}$, i.e. $c'_{uv} = 0$.
- **$s$-$t$ cut** — a node partition $S \ni s,\ T \ni t$; its capacity is the total capacity of $S \to T$ edges.
- **Flow decomposition** — writing a flow as at most $m$ path-flows and cycle-flows.
