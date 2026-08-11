---
title: "S03E05 · Minimum Spanning Tree"
sidebar_position: 5
description: The cut and cycle properties with full proofs, Kruskal with DSU, Prim with a priority queue, Boruvka's contraction algorithm, and Edmonds' minimum arborescence for directed graphs.
---

# S03E05 · Minimum Spanning Tree

> **Source:** Pavel Mavrin, [_A&DS S03E05_](https://youtu.be/CxJZ_ikDHPc) · 1h37m lecture → ~16 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- A **spanning tree** picks $n-1$ edges that keep all $n$ nodes connected; the **minimum spanning tree (MST)** minimizes the total edge weight. Any tree that connects everything is spanning; the cheapest one is what we want.
- One **cut property** drives every algorithm: for any split of the nodes into sets $A$ and $B$, the **lightest edge crossing the cut** belongs to some MST. All three algorithms are just this lemma applied to different cuts.
- **Kruskal:** sort edges, add each if it joins two different components (check with a DSU). Cost is dominated by the sort → $O(E \log E) = O(E \log V)$.
- **Prim:** grow one component from a start node, always pulling the lightest crossing edge from a priority queue. Binary heap gives $O(E \log V)$; a plain array gives $O(V^2 + E)$, which wins on dense graphs.
- **Boruvka:** every node grabs its own lightest edge in parallel, then contract each component to a single node and repeat. Node count halves each round → $O(E \log V)$.
- The directed cousin, the **minimum arborescence** (Edmonds' algorithm), needs a different idea entirely — reduce weights per node, build a tree of zero edges, and contract zero-cycles — because the cut lemma fails on directed edges.

---

## The problem: spanning trees and their weight

- Take a connected **undirected** graph. A **spanning tree** is any tree (acyclic, connected) that includes *all* the nodes. A DFS tree is one example — but any acyclic connected subset of $n-1$ edges qualifies.
- Give every edge a **weight** (call it cost or weight — there is only one value, so the name does not matter). The **weight of a tree** is the sum of its edge weights.
- On the board example the drawn tree sums to $5+8+1+3+5+6=29$; the task is to find the spanning tree with the **minimum** total.
- **Why it matters:** if you just want to connect all nodes as cheaply as possible, the answer is always a spanning tree. Any cycle lets you delete an edge and lower (or not raise) the total, so the minimal connected structure is a tree.
- **Non-negativity is not required.** The algorithms only use the *linear order* of weights. Negative weights work; for a **maximum** spanning tree, negate all weights and run MST.

![Weighted graph with a spanning tree highlighted and total weight sum equals 29](/img/dsa/CxJZ_ikDHPc/frame-00014.png)

[watch from 2:30](https://youtu.be/CxJZ_ikDHPc?t=150)

---

## The cut property (the one lemma behind everything)

- **Setup.** Split all nodes into two non-empty, non-overlapping sets $A$ and $B$. Look at every edge with one endpoint in each set — this collection is a **cut**. Let $(u,v)$ be the **minimum-weight** edge of the cut, with $u \in A$ and $v \in B$.

$$
(u,v) = \arg\min\; \{\, w_{uv} : u \in A,\; v \in B \,\}
$$

- **Claim.** This edge $(u,v)$ belongs to **some** MST. (If all weights are distinct the MST is unique and $(u,v)$ is in *the* MST; with ties there may be several MSTs, and $(u,v)$ is in at least one of them.)

**Proof (exchange argument).**

- Take any MST $T$. In $T$ the nodes $u$ and $v$ are connected by a unique path.
- Since $u \in A$ and $v \in B$, that path must **cross** the cut somewhere: there is an edge $(x,y)$ on it with $x \in A$, $y \in B$.
- Because $(u,v)$ is the lightest edge of the cut, $w_{uv} \le w_{xy}$.
- Swap: remove $(x,y)$ from $T$ and add $(u,v)$. The result $T'$ is still a spanning tree, and $w(T') = w(T) - w_{xy} + w_{uv} \le w(T)$.
- $T$ was an MST, so $T'$ is an MST too — one that contains $(u,v)$. Done.

**Why $T'$ is still a tree (two ways).**

- *Connectivity:* it has the same number of edges $n-1$; any pair of old-neighbors that used $(x,y)$ can now route through the added path containing $(u,v)$, so everything stays connected — a connected graph with $n-1$ edges is a tree.
- *Cycle view:* adding $(u,v)$ to $T$ creates exactly one cycle, and that cycle contains $(x,y)$; deleting $(x,y)$ from the cycle leaves a tree again.

![Cut proof: minimum spanning tree path from u to v crosses the cut at edge x-y, and w_uv is at most w_xy](/img/dsa/CxJZ_ikDHPc/frame-00046.png)

- **Cycle property (the dual).** For any cycle, the **heaviest** edge on that cycle is **not** needed — some MST avoids it. This is exactly what lets Kruskal *skip* an edge whose endpoints are already connected: closing a cycle would force in the current (heaviest-so-far) edge, which no MST wants.

[watch from 6:18](https://youtu.be/CxJZ_ikDHPc?t=378)

---

## Kruskal's algorithm (sort edges + DSU)

- **Idea.** Process edges from lightest to heaviest. Add an edge if and only if its two endpoints are in **different** components; otherwise it would close a cycle, so skip it.
- **Why each added edge is safe.** When you add the lightest not-yet-connecting edge, look at the cut separating the component of $u$ from everything else — this edge is the minimum crossing that cut, so by the cut property it belongs to some MST.
- **Why a skipped edge is safe.** If $u$ and $v$ are already connected, there is a path between them made of edges you already accepted, all lighter than the current edge — so this edge is the heaviest on the resulting cycle and no MST needs it (cycle property).
- **Data structure — DSU (disjoint set union).** Maintains the invariant "which nodes are currently in the same component," with two operations: `find(x)` (component id) and `unite(a,b)` (merge). With union-by-rank **and** path compression each op is $O(\alpha(V))$ amortized — effectively constant.

Board pseudocode:

```text
sort(E)                       # by weight, ascending
for (u, v) in E:              # lightest first
    if find(u) != find(v):    # different components → no cycle
        union(u, v)           # add edge (u,v) to the MST
```

Full C++ (DSU + Kruskal, both compile-tested):

```cpp
#include <bits/stdc++.h>
using namespace std;

// DSU with union-by-rank + path compression → O(alpha(n)) per op
struct DSU {
    vector<int> parent, rnk;
    DSU(int n) : parent(n), rnk(n, 0) { iota(parent.begin(), parent.end(), 0); }
    int find(int x) {
        while (parent[x] != x) { parent[x] = parent[parent[x]]; x = parent[x]; }
        return x;
    }
    bool unite(int a, int b) {
        a = find(a); b = find(b);
        if (a == b) return false;                 // already same component
        if (rnk[a] < rnk[b]) swap(a, b);
        parent[b] = a;
        if (rnk[a] == rnk[b]) rnk[a]++;
        return true;
    }
};

struct Edge { int u, v; long long w; };

long long kruskal(int n, vector<Edge> edges) {
    sort(edges.begin(), edges.end(),
         [](const Edge& a, const Edge& b) { return a.w < b.w; });
    DSU dsu(n);
    long long total = 0; int used = 0;
    for (const Edge& e : edges)
        if (dsu.unite(e.u, e.v)) { total += e.w; used++; }   // find + union in one call
    return used == n - 1 ? total : -1;                       // -1 if graph is disconnected
}
```

**Complexity.** The `union`/`find` work over all $E$ edges is $O(E \cdot \alpha(V))$ — nearly linear. The **sort dominates** at $O(E \log E)$. Since $E \le V^2$, $\log E \le 2 \log V$, so $O(E \log E) = O(E \log V)$; the two are the same up to a constant.

![Kruskal pseudocode: sort E, then for each edge if find(u) not equal find(v) do union, total O(m log m)](/img/dsa/CxJZ_ikDHPc/frame-00082.png)

[watch from 12:34](https://youtu.be/CxJZ_ikDHPc?t=754)

---

## Prim's algorithm (grow one component with a priority queue)

- **Idea.** Pick a start node $s$; let $A = \{s\}$. Repeat $n-1$ times: find the lightest edge crossing the cut $(A, \text{rest})$, add it to the MST, and move its far endpoint into $A$.
- **Correctness.** Every step applies the cut property to the current cut $(A, B)$ — the minimum crossing edge is always MST-safe.
- If the graph is disconnected, run Prim once per component (build a **forest**).

### Version 1 — put every crossing edge in the queue

- Keep a priority queue of all edges from $A$ to the rest. Pop the minimum; when a node enters $A$, push its edges to outside nodes and drop edges that now go inside $A$.

```text
PQ = { edges out of s }
A  = { s }
repeat (n - 1) times:
    (u, v) = PQ.remove_min()      # lightest crossing edge
    add v to A
    for each edge (v, u):
        if u not in A: PQ.add((v, u))      # new crossing edge
        else:          PQ.remove((v, u))   # no longer crosses
```

- Each of the $n$ node-additions scans that node's edges once, so the inner loop runs $O(E)$ times total; the pop runs $n$ times. With a binary heap every PQ op is $O(\log V)$, giving $O(E \log V)$.

![Prim version 1: PQ of crossing edges, remove_min then add v to A and update the queue over v's edges](/img/dsa/CxJZ_ikDHPc/frame-00141.png)

### Version 2 — one entry per node: `d[v]` = lightest edge into A

- The queue above holds too many edges. For each node $v \notin A$ you only ever need its **single** lightest edge to $A$ — call it $d(v)$. A heavier edge to $v$ can never be the global minimum.

$$
d(v) = \min\; \{\, w_{uv} : u \in A \,\}
$$

- Popping the minimum $d$ over all nodes gives the global minimum crossing edge (minimum of per-node minimums). When $v$ enters $A$, relax its neighbors: $d(u) \leftarrow \min\big(d(u),\, w_{vu}\big)$, and update the queue key.

```text
d[v] = min edge weight from v into A   (INF at start, except d[s] = 0)
A = { s }
for each v: PQ.add(v)                  # keyed by d[v]
repeat (n - 1) times:
    v = PQ.remove_min()                # node with smallest d[v]
    add v to A
    for each edge (v, u):
        if d[u] > w[v][u]:
            d[u] = w[v][u]             # d only ever decreases
            PQ.update(u)               # sift up / decrease-key
```

Full C++ (Prim, binary heap, lazy-deletion variant — compile-tested against Kruskal):

```cpp
#include <bits/stdc++.h>
using namespace std;

struct Edge { int u, v; long long w; };

// Prim from node 0 using a binary-heap priority queue.
// "Lazy" version: push duplicates and skip stale ones — same O(E log V) bound.
long long prim(int n, const vector<Edge>& edges) {
    vector<vector<pair<int, long long>>> adj(n);
    for (const Edge& e : edges) {
        adj[e.u].push_back({e.v, e.w});
        adj[e.v].push_back({e.u, e.w});
    }
    vector<char> inA(n, 0);
    priority_queue<pair<long long, int>,
                   vector<pair<long long, int>>, greater<>> pq;
    pq.push({0, 0});                                   // start node 0, cost 0
    long long total = 0; int cnt = 0;
    while (!pq.empty()) {
        auto [w, v] = pq.top(); pq.pop();
        if (inA[v]) continue;                          // stale entry — already in A
        inA[v] = 1; total += w; cnt++;
        for (auto [to, ww] : adj[v])
            if (!inA[to]) pq.push({ww, to});           // candidate crossing edge
    }
    return cnt == n ? total : -1;                      // -1 if disconnected
}
```

**Choosing the data structure.**

| Priority queue | remove-min ($\times n$) | update / decrease-key ($\times m$) | Total | Best when |
| --- | --- | --- | --- | --- |
| Binary heap | $O(\log V)$ | $O(\log V)$ | $O(E \log V)$ | sparse ($E \approx V$) |
| Plain array | $O(V)$ | $O(1)$ | $O(V^2 + E)$ | dense ($E \approx V^2$) |
| Fibonacci heap | $O(\log V)$ amort. | $O(1)$ amort. | $O(E + V \log V)$ | theory only |

- On a **sparse** graph the binary heap's $O(E \log V)$ beats $O(V^2)$; on a **dense** graph the array's $O(V^2 + E)$ wins because updates are free. You can even branch on $E$ vs $V$ to pick the better one.
- **Fibonacci heaps** give the best asymptotic bound (decrease-key in $O(1)$ amortized, since $d$ only decreases), but their constant factors are so bad that in practice a binary heap or array is faster.

![Prim complexity: binary heap gives O(m log n), array gives O(n squared plus m)](/img/dsa/CxJZ_ikDHPc/frame-00181.png)

[watch from 21:16](https://youtu.be/CxJZ_ikDHPc?t=1276)

---

## Boruvka's algorithm (parallel contraction)

- A very old algorithm (early 1900s, predating computers — invented to lay out an electrical network). Elegant and highly parallel.
- **One round:** for **every** node independently, find its cheapest incident edge and mark it for the MST. This is the cut property applied to *all* single-node cuts at once.
- These marked edges connect the graph into several **components**. **Contract** each component into a single super-node (like a DSU merge), keeping the inter-component edges. Then repeat on the smaller graph.
- Finally **uncompress** and add all the marked edges back — the union of all rounds' picks is the MST.

![Boruvka round: each node's minimum edge highlighted, forming components, cost O(m) per iteration](/img/dsa/CxJZ_ikDHPc/frame-00234.png)

**Handling ties (avoiding accidental cycles).**

- With **distinct** weights it is provably impossible to form a cycle in one round.
- With **equal** weights two nodes might pick the same edge from opposite ends, or a group could close a cycle. Fix it by breaking ties with a fixed rule — for example order equal-weight edges by node index — so the choice is consistent.

**Complexity.**

- Each round scans all edges to find per-node minimums: $O(E)$.
- Contraction merges components; since every component has $\ge 2$ nodes, the node count **at least halves** each round. So there are at most $\lceil \log_2 V \rceil$ rounds.
- Total: $O(E \log V)$. In practice components are much larger than pairs, so it converges even faster and is very efficient.

![Boruvka on a 10-node graph before contraction, with per-node minimum edges to be selected](/img/dsa/CxJZ_ikDHPc/frame-00224.png)

[watch from 51:04](https://youtu.be/CxJZ_ikDHPc?t=3064)

---

## How fast can MST go? (the theory frontier)

- **Chazelle:** an MST can be found in $O(E \, \alpha(E, V))$ deterministic time — nearly linear — using soft heaps rather than DSU. Complicated, but it exists.
- **Karger–Klein–Tarjan:** a **randomized** algorithm runs in $O(E)$ **expected** time (the runtime is a random variable whose expectation is linear, like quicksort's $O(n \log n)$ expected).
- **Open problem:** whether a **deterministic linear-time** MST algorithm exists is *unknown*. There is a known "optimal" comparison-based algorithm whose exact complexity equals the minimum height of the MST decision tree — but nobody knows what that height is.

[watch from 47:04](https://youtu.be/CxJZ_ikDHPc?t=2824)

---

## Bonus: minimum arborescence (directed MST, Edmonds' algorithm)

- **Problem.** Given a **directed** weighted graph and a root $s$, find the cheapest set of edges forming a tree **rooted at $s$** with a directed path from $s$ to every node (an *arborescence*).
- **Why the cut lemma fails.** In a directed tree, taking $u \in A$ and $v \in B$ does **not** guarantee a directed path $u \to v$ — only $s \to$ everything. So the undirected exchange argument breaks, and this problem is genuinely harder (though still polynomial).

**Key reduction.** Every non-root node has **exactly one** incoming edge in the final tree. So you may subtract the same constant $\Delta$ from *all* incoming edges of a node without changing which tree is optimal — the total just drops by $\Delta$.

- **Step 1 — reduce.** For each node $v \ne s$, let $\Delta = \min$ over its incoming edges; subtract $\Delta$ from each, creating a **zero edge** into every node.

```text
for each node v != s:
    delta   = min weight over incoming edges of v
    w[u->v] = w[u->v] - delta     # for every incoming edge; makes >= 1 zero edge
```

- **Step 2 — try to build from zeros.** Keep only the zero-weight edges. If every node is **reachable from $s$** using zero edges, build a tree of zeros: its cost is $0$, and since all weights are now $\ge 0$, that is optimal. Done.
- **Step 3 — a stuck node means a zero-cycle.** If some node is unreachable, follow zero edges backward (every non-root node has a zero in-edge) until you revisit a node — that closes a **cycle of zero edges**. Inside such a cycle every node reaches every other.
- **Step 4 — contract and recurse.** Compress each zero-cycle into a single super-node, recompute reduced weights, and repeat from Step 1. Node count strictly drops, so it terminates.
- **Step 5 — expand.** Uncompress each super-node. The one incoming edge into the super-node lands on one cycle node; that node now has two in-edges, so **delete the cycle edge it duplicates** to restore a tree.

![Minimum arborescence setup: directed graph rooted at s, adding delta to all incoming edges of a node](/img/dsa/CxJZ_ikDHPc/frame-00286.png)

**Complexity.** Naive rebuild-and-contract is $O(V \cdot E)$ (linear work per round, $\le V$ contractions). With **mergeable heaps** to store each node's incoming edges (find-min and subtract-a-constant, merge on contraction) it drops to $O(E \log V)$. A careful Fibonacci-heap variant reaches $O(E + V \log V)$, but is intricate.

[watch from 1:01:04](https://youtu.be/CxJZ_ikDHPc?t=3654)

---

## Complexity recap

| Algorithm | Data structure | Time | Space | Note |
| --- | --- | --- | --- | --- |
| Kruskal | sort + DSU | $O(E \log E) = O(E \log V)$ | $O(V + E)$ | sort dominates; DSU is $O(E\,\alpha)$ |
| Prim (binary heap) | priority queue | $O(E \log V)$ | $O(V + E)$ | best on sparse graphs |
| Prim (array) | array of $d[\cdot]$ | $O(V^2 + E)$ | $O(V)$ | best on dense graphs |
| Prim (Fibonacci) | Fibonacci heap | $O(E + V \log V)$ | $O(V)$ | theory only; poor constants |
| Boruvka | contraction | $O(E \log V)$ | $O(V + E)$ | parallel-friendly |
| Best known (deterministic) | soft heaps | $O(E\,\alpha(E,V))$ | — | Chazelle; near-linear |
| Best known (randomized) | — | $O(E)$ expected | — | Karger–Klein–Tarjan |
| Min arborescence (Edmonds) | mergeable heaps | $O(E \log V)$ | $O(V + E)$ | directed rooted tree |

---

## Practice problems

MST is a staple of both interviews and competitive programming — the "connect everything cheaply" shape shows up constantly.

**🎯 Interview (MAANG-style)**

- [Min Cost to Connect All Points — LeetCode 1584](https://leetcode.com/problems/min-cost-to-connect-all-points/) — Medium — MST on a complete graph with Manhattan-distance weights (dense → Prim-array shines).
- [Connecting Cities With Minimum Cost — LeetCode 1135](https://leetcode.com/problems/connecting-cities-with-minimum-cost/) — Medium — textbook Kruskal with DSU; detect disconnected graphs.
- [Find Critical and Pseudo-Critical Edges in MST — LeetCode 1489](https://leetcode.com/problems/find-critical-and-pseudo-critical-edges-in-minimum-spanning-tree/) — Hard — repeatedly build MSTs forcing/banning each edge; deep use of the cut and cycle properties.
- [Optimize Water Distribution in a Village — LeetCode 1168](https://leetcode.com/problems/optimize-water-distribution-in-a-village/) — Hard — model wells as edges to a virtual node, then run MST.
- [Kruskal's Minimum Spanning Tree — GeeksforGeeks](https://www.geeksforgeeks.org/kruskals-minimum-spanning-tree-algorithm-greedy-algo-2/) — Medium — sort + DSU implementation drill.
- [Prim's Minimum Spanning Tree — GeeksforGeeks](https://www.geeksforgeeks.org/prims-minimum-spanning-tree-mst-greedy-algo-5/) — Medium — priority-queue Prim implementation drill.

**🏆 Competitive**

- [Road Reparation — CSES 1675](https://cses.fi/problemset/task/1675) — Easy — MST total cost; print "IMPOSSIBLE" if disconnected.
- [Road Construction — CSES 1676](https://cses.fi/problemset/task/1676) — Medium — DSU-driven component tracking (the incremental cousin of Kruskal's union step).

---

## Further reading

- [Minimum spanning tree — Wikipedia](https://en.wikipedia.org/wiki/Minimum_spanning_tree) — cut and cycle properties, history, complexity frontier.
- [Kruskal's algorithm — Wikipedia](https://en.wikipedia.org/wiki/Kruskal%27s_algorithm) and [Prim's algorithm — Wikipedia](https://en.wikipedia.org/wiki/Prim%27s_algorithm).
- [Boruvka's algorithm — Wikipedia](https://en.wikipedia.org/wiki/Bor%C5%AFvka%27s_algorithm) — the contraction algorithm and its parallel variants.
- [Edmonds' algorithm — Wikipedia](https://en.wikipedia.org/wiki/Edmonds%27_algorithm) — minimum arborescence for directed graphs.
- [MST — Kruskal with DSU — cp-algorithms](https://cp-algorithms.com/graph/mst_kruskal_with_dsu.html), [Kruskal](https://cp-algorithms.com/graph/mst_kruskal.html), and [Prim](https://cp-algorithms.com/graph/mst_prim.html).
- [Boruvka's algorithm — GeeksforGeeks](https://www.geeksforgeeks.org/boruvkas-algorithm-greedy-algo-9/).

---

## Key takeaways

- Learn the **cut property** cold: the lightest edge across any cut is MST-safe. Kruskal, Prim, and Boruvka are all this one lemma applied to different cuts.
- **Kruskal** = sort + DSU ($O(E \log V)$); **Prim** = grow-one-set + priority queue (heap $O(E \log V)$, array $O(V^2+E)$); pick by density.
- **Boruvka** contracts components and halves the node count each round → $O(E \log V)$, and parallelizes naturally.
- Negativity never mattered — only the **order** of weights. Negate to get a **maximum** spanning tree.
- **Directed MST** (minimum arborescence) is a different beast: the cut lemma fails, so Edmonds reduces weights per node and contracts zero-cycles instead.

## Glossary

- **Spanning tree** — an acyclic connected subgraph touching all $n$ nodes, using $n-1$ edges.
- **Cut** — a partition of nodes into $A$ and $B$; its *crossing edges* have one endpoint in each set.
- **Cut property** — the minimum crossing edge of any cut lies in some MST.
- **Cycle property** — the maximum-weight edge on any cycle lies in no MST (unless tied).
- **DSU (disjoint set union)** — structure tracking components with `find`/`unite`, $O(\alpha(V))$ per op with rank + path compression.
- **Contraction** — collapsing a connected component into one super-node, keeping inter-component edges.
- **Arborescence** — a directed rooted tree with a path from the root to every node.
