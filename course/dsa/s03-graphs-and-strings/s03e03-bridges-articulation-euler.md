---
title: "S03E03 · Bridges, Articulation Points & Euler Cycle"
sidebar_position: 3
description: Edge- and vertex-biconnectivity in undirected graphs, finding all bridges and articulation points in one DFS via tin/low, the block decomposition, and building Euler cycles with Hierholzer in linear time.
---

# S03E03 · Bridges, Articulation Points & Euler Cycle

> **Source:** Pavel Mavrin, [_A&DS S03E03_](https://youtu.be/W8hnuthPhWM) · 1h51m lecture → ~16 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- **Biconnectivity** asks for two edge-disjoint (or vertex-disjoint) paths between nodes. Edge-biconnectivity is an **equivalence relation on vertices**; vertex-biconnectivity is an equivalence relation on **edges**.
- A **bridge** is an edge whose removal increases the number of connected components; an **articulation point** is a vertex whose removal does. Both are the "weak spots" of a graph.
- One DFS computes, for every vertex $v$, the entry time $tin[v]$ and the low-link $low[v] =$ the smallest entry time reachable from $v$'s subtree using at most one back edge. Then edge $(p,v)$ is a **bridge** iff $low[v] > tin[p]$, and $v$ is an **articulation point** iff some child $u$ has $low[u] \ge tin[v]$ (with a child-count special case at the DFS root).
- Contracting each 2-edge-connected component to a node yields the **bridge tree**; the vertex version yields the **block-cut tree**. Both are trees, so every tree algorithm from S02 applies.
- An **Euler cycle** (every edge exactly once, returning to start) exists iff the graph is connected and **every vertex has even degree**. **Hierholzer's algorithm** builds it in $O(V+E)$ by a DFS that marks *edges* and appends each edge to the answer as recursion unwinds.

---

## Biconnectivity: two disjoint paths

- Ordinary connectivity in an undirected graph is trivial: connected components partition the vertices. **Big connectivity** is the richer question of whether two nodes are joined by **two paths that do not overlap**.
- Two flavours, needing slightly different algorithms:
  - **Edge-biconnectivity** (2-edge-connectivity): the two paths may share **vertices** but not **edges**. Treated as a relation on *vertices*.
  - **Vertex-biconnectivity** (2-vertex-connectivity): the two paths share **neither vertices nor edges**. Treated as a relation on *edges*.
- **Edge-biconnectivity is transitive**, hence an equivalence relation. The naive "concatenate the paths" proof is wrong because the $u \to v$ pair and the $v \to w$ pair may cross. The correct proof: from the two $u \to v$ paths build a **cycle**; route both $w \to v$ paths and cut each at the *first* vertex where it hits the cycle. Now nothing crosses, and the two arcs of the cycle give the two disjoint $u \to w$ paths.
- Because it is an equivalence relation, vertices split into **2-edge-connected components** (the lecture calls them *b-connect components*). Every cycle lies inside a single component.

[watch from 4:04](https://youtu.be/W8hnuthPhWM?t=244)

---

## Bridges and the bridge tree

- **Bridge:** an edge $(u,v)$ that joins two different 2-edge-connected components. Removing it disconnects $u$ from $v$ — because if a second path survived, that path plus the edge would be two edge-disjoint paths, forcing $u,v$ into the same component.
- **Contract** each component to a single node and keep only the bridges between them. The result is **acyclic** (any cycle would merge its nodes into one component), so it is a **tree** — the **bridge tree** (condensation). Every S02 tree tool (binary lifting, LCA, link-cut) now applies to the coarse structure of the graph.

![Graph split into 2-edge-connected components A–F, each contracted to a node, forming the bridge tree](/img/dsa/W8hnuthPhWM/frame-00064.png)

[watch from 12:44](https://youtu.be/W8hnuthPhWM?t=764)

---

## Finding bridges with DFS tin/low

**Key observations from the DFS tree.**

- Run one DFS from any start; it produces a DFS/spanning tree. **Every bridge is a tree edge** — a bridge is the only link between its two components, so DFS must traverse it (any spanning tree contains all bridges).
- In an *undirected* DFS tree there are **no cross edges** between different branches. Every non-tree edge is a **back edge** joining a node to one of its **ancestors**.
- Consider a tree edge from $v$ up to its parent $p$. Cutting it separates the subtree of $v$. The edge is **not** a bridge iff some back edge escapes that subtree to an ancestor of $p$ (strictly above $p$).

**The low-link value.** Define

$$
up[v] \;=\; \min\Big(\; tin[w] \;:\; w \text{ reachable from } \mathrm{subtree}(v) \text{ via one non-tree edge}\;\Big)
$$

- Compare "who is higher in the tree" by **entry time** $tin$ (smaller $tin$ = closer to the root); tree depth works equally well. Entry times are used because they are all distinct.
- Recurrence, computed bottom-up in the same DFS. For each non-tree edge $v \to w$ take $tin[w]$; for each child $u$ take $up[u]$:

$$
up[v] \;=\; \min\!\Big(\, tin[v],\; \min_{v \to w \text{ back}} tin[w],\; \min_{u \text{ child of } v} up[u] \,\Big)
$$

- **Bridge test:** the tree edge $(p,v)$ is a bridge iff $up[v] > tin[p]$ — nothing in the subtree of $v$ reaches $p$ or above.

![Bridge DFS on the board: tin, up recurrence over children and back edges, and the test up[v] greater than tin[p]](/img/dsa/W8hnuthPhWM/frame-00183.png)

The lecturer's code, made compilable. The parent edge is skipped exactly **once** (so a single parallel edge back to the parent is *not* skipped — that would be a genuine back edge):

```cpp
#include <bits/stdc++.h>
using namespace std;

int n, timer_;
vector<vector<int>> adj;
vector<int> tin, up;            // entry time, low-link
vector<char> visited;
vector<pair<int,int>> bridges;  // collected bridges (u,v)

void dfs(int v, int p) {
    visited[v] = 1;
    tin[v] = up[v] = timer_++;         // init up[v] = tin[v]
    bool skipped_parent = false;
    for (int u : adj[v]) {
        if (u == p && !skipped_parent) { // skip the tree edge to parent, once
            skipped_parent = true;
            continue;
        }
        if (visited[u]) {
            up[v] = min(up[v], tin[u]);  // back edge to an ancestor
        } else {
            dfs(u, v);                   // tree edge
            up[v] = min(up[v], up[u]);   // pull child's low-link up
            if (up[u] > tin[v])          // nothing in subtree(u) reaches v or above
                bridges.push_back({v, u});
        }
    }
}

void find_bridges() {
    tin.assign(n, 0); up.assign(n, 0);
    visited.assign(n, 0); timer_ = 0; bridges.clear();
    for (int i = 0; i < n; i++)
        if (!visited[i]) dfs(i, -1);     // -1: root has no parent
}
```

- **Data structure:** three arrays keyed by vertex — `tin`, `up`, `visited`. `tin` gives a strict pre-order; `up` maintains the invariant "smallest $tin$ escapable from this subtree".
- **Parallel edges caveat:** the `u == p` skip is wrong for multigraphs. Guard with an *edge id* (skip the specific incoming edge, not every edge to the parent) if double edges exist — a double edge is never a bridge.
- Verified against brute force (remove each edge, recount components) on 3000 random graphs.

[watch from 25:31](https://youtu.be/W8hnuthPhWM?t=1531)

---

## 2-edge-connected components in the same DFS

- Removing the bridges and re-running a DFS labels the components — simple, but a second pass. The lecture instead extracts them **inside the same DFS** using a **stack** of visited vertices ordered by entry time.
- Push $v$ on entry. When the edge above $v$ turns out to be a bridge ($up[v] > tin[p]$), the component of $v$ is exactly $v$ plus everything pushed **after** it — pop the stack down to and including $v$.

![Stack-based extraction: pop the buffer down to v when a bridge is detected to emit one 2-edge-connected component](/img/dsa/W8hnuthPhWM/frame-00146.png)

```cpp
#include <bits/stdc++.h>
using namespace std;

int n, timer_;
vector<vector<int>> adj;
vector<int> tin, up;
vector<char> visited;
vector<int> buffer_;               // vertices, ordered by entry time
vector<vector<int>> components;    // 2-edge-connected components

void dfs(int v, int p) {
    visited[v] = 1;
    tin[v] = up[v] = timer_++;
    buffer_.push_back(v);          // push on entry
    bool skipped_parent = false;
    for (int u : adj[v]) {
        if (u == p && !skipped_parent) { skipped_parent = true; continue; }
        if (visited[u]) {
            up[v] = min(up[v], tin[u]);
        } else {
            dfs(u, v);
            up[v] = min(up[v], up[u]);
            if (up[u] > tin[v]) {              // (v,u) is a bridge → close subtree(u)
                vector<int> comp;
                while (true) {
                    int x = buffer_.back(); buffer_.pop_back();
                    comp.push_back(x);
                    if (x == u) break;          // stop at the child u
                }
                components.push_back(comp);
            }
        }
    }
}
```

- The final component (containing the root's own class) is popped once the top-level call returns; drain any remaining buffer per DFS root.

[watch from 46:42](https://youtu.be/W8hnuthPhWM?t=2802)

---

## Articulation points and the block-cut tree

- **Vertex-biconnectivity is *not* transitive on vertices** — three chained paths through a shared middle vertex break it. Fix: define it on **edges**. Two edges are biconnected if two vertex-disjoint paths join their endpoints; *this* is transitive (same cycle-cutting proof), giving **biconnected components as classes of edges** (blocks).
- **Articulation point (cut vertex):** a vertex touched by edges from **two different** biconnected components. Removing it increases the number of components — it is the sole connector of those blocks.
- The naive condensation "one node per block, connect blocks sharing a cut vertex" can produce **cycles** (a cut vertex may join three or more blocks). Fix: make **two node types** — one per block and one per articulation point — and connect a block-node to each cut-vertex-node it contains. That graph is always a tree: the **block-cut tree**.

![Two vertex types in the block-cut tree: block nodes plus articulation-point nodes keep the condensation acyclic](/img/dsa/W8hnuthPhWM/frame-00276.png)

**Finding articulation points.** Same DFS, same $up$ (low-link). Removing $v$ disconnects a child's subtree iff that subtree cannot escape *above* $v$:

- **Non-root $v$:** articulation iff some child $u$ has $up[u] \ge tin[v]$. (Equality allowed: reaching $v$ itself — not strictly above — still traps the subtree once $v$ is removed. Equivalently $up[u]$ is not strictly less than $tin[v]$.)
- **Root $v$:** it has no parent, so the "escape above" argument fails. The root is an articulation point iff it has **more than one child** in the DFS tree — separate children of the root are only joined through the root.

![Articulation DFS: condition up[u] not less than tin[v] per child, plus the root special case of more than one child](/img/dsa/W8hnuthPhWM/frame-00332.png)

```cpp
#include <bits/stdc++.h>
using namespace std;

int n, timer_;
vector<vector<int>> adj;
vector<int> tin, up;
vector<char> visited, is_articulation;

void dfs(int v, int p) {
    visited[v] = 1;
    tin[v] = up[v] = timer_++;
    int children = 0;
    bool skipped_parent = false;
    for (int u : adj[v]) {
        if (u == p && !skipped_parent) { skipped_parent = true; continue; }
        if (visited[u]) {
            up[v] = min(up[v], tin[u]);
        } else {
            dfs(u, v);
            up[v] = min(up[v], up[u]);
            if (up[u] >= tin[v] && p != -1)  // non-root cut condition
                is_articulation[v] = 1;
            children++;
        }
    }
    if (p == -1 && children > 1)             // root special case
        is_articulation[v] = 1;
}

void find_articulation_points() {
    tin.assign(n, 0); up.assign(n, 0);
    visited.assign(n, 0); is_articulation.assign(n, 0); timer_ = 0;
    for (int i = 0; i < n; i++)
        if (!visited[i]) dfs(i, -1);
}
```

- The biconnected-component (block) extraction mirrors the bridge version but pushes **edges** onto the stack; when $up[u] \ge tin[v]$ fires, pop edges down to the edge $(v,u)$ to emit one block. Here the DFS root needs **no** special case — you simply run the pop after returning from every root child.
- Verified against brute force (remove each vertex, recount components) on 3000 random graphs, matching exactly.

[watch from 66:48](https://youtu.be/W8hnuthPhWM?t=4008)

---

## Euler cycles: existence and Hierholzer

- An **Euler cycle** traverses **every edge exactly once** and returns to the start (an **Euler path** does the same without the return). Defined for both directed and undirected graphs.
- **Existence (undirected):** the graph is connected (ignoring isolated vertices) and **every vertex has even degree** → Euler *cycle*. Exactly **two** odd-degree vertices → Euler *path* between them.
- **Existence (directed):** connected and $\deg_{in}(v) = \deg_{out}(v)$ for every vertex → Euler cycle.
- **Necessity is easy:** each pass through a vertex consumes two of its edges, so an odd-degree vertex cannot be fully covered by a closed walk. Sufficiency is exactly what the algorithm below constructs.

**Hierholzer's algorithm.** A DFS that marks **edges** (not vertices), may revisit a vertex, and appends the current **vertex** to the answer **once its edges are exhausted** — i.e. as each recursive call returns:

![Euler DFS: while an unmarked edge vu exists, mark it and recurse into u; once v has no unmarked edges left, append v to the answer](/img/dsa/W8hnuthPhWM/frame-00386.png)

- **Why it works.** With all even degrees, whenever the walk enters a vertex it can always leave — except the **start** $s$, whose degree became odd the moment the first edge was taken. So a run always stalls back at $s$, producing a closed sub-tour. Unwinding, each newly finished edge attaches to the current end of the answer (again always $s$-like: the only odd endpoint), so the pieces splice into one path covering all edges.

```cpp
#include <bits/stdc++.h>
using namespace std;

int n, m = 0;
vector<vector<pair<int,int>>> adj;   // adj[v] = list of (to, edge_id)
vector<char> used;                   // per-edge used flag (shared by both endpoints)
vector<int> ptr_;                    // scan cursor per vertex (skips used edges)
vector<int> ans;                     // vertices, in Euler order

void add_edge(int u, int v) {
    adj[u].push_back({v, m});
    adj[v].push_back({u, m});         // both directions share edge id m
    used.push_back(0);
    m++;
}

void dfs(int v) {
    while (ptr_[v] < (int)adj[v].size()) {
        auto [u, id] = adj[v][ptr_[v]];
        ptr_[v]++;                    // advance cursor: lazy removal
        if (used[id]) continue;       // edge already taken from the other end
        used[id] = 1;
        dfs(u);
    }
    ans.push_back(v);                 // append vertex once the walk stalls here
}

// returns the Euler-cycle vertex sequence (length m+1) or empty if none exists
vector<int> euler_cycle(int start) {
    for (int v = 0; v < n; v++)
        if (adj[v].size() % 2) return {};   // odd degree → no Euler cycle
    ptr_.assign(n, 0);
    ans.clear();
    dfs(start);                       // pushes m+1 vertices as recursion unwinds
    if ((int)ans.size() != m + 1) return {}; // fewer edges reached → disconnected
    reverse(ans.begin(), ans.end());
    return ans;
}
```

- **Data structure:** for each vertex a list of its incident edges; a global `used[edge_id]` boolean; a per-vertex cursor `ptr_`. Each edge is touched a constant number of times, so the whole run is $O(V + E)$.
- **Undirected subtlety:** an edge appears in **two** adjacency lists. Sharing one `used` flag by edge id (the lecture's "lazy removal") is the clean fix — when the cursor later reaches the already-used copy, it just skips it. Directed graphs need no such care.
- Verified: on two triangles sharing a vertex the code emits `0 1 2 3 4 2 0`, a closed tour using all 6 edges exactly once.

![Hierholzer walking: run out of edges only at the odd-degree end, then splice sub-tours into the final cycle](/img/dsa/W8hnuthPhWM/frame-00422.png)

[watch from 88:55](https://youtu.be/W8hnuthPhWM?t=5335)

---

## Complexity recap

| Operation | Time | Space | Notes |
| --- | --- | --- | --- |
| Find all bridges | $O(V+E)$ | $O(V)$ | one DFS, arrays $tin$/$up$ |
| Find all articulation points | $O(V+E)$ | $O(V)$ | one DFS, root special case |
| 2-edge-connected components | $O(V+E)$ | $O(V)$ | stack of vertices in same DFS |
| Biconnected components (blocks) | $O(V+E)$ | $O(E)$ | stack of edges in same DFS |
| Euler cycle / path (Hierholzer) | $O(V+E)$ | $O(V+E)$ | edge cursors + used flags |

---

## Practice problems

**🎯 Interview (MAANG-style)**

- [Critical Connections in a Network — LeetCode 1192](https://leetcode.com/problems/critical-connections-in-a-network/) — Hard — the canonical **bridges** problem, verbatim $tin$/$low$.
- [Reconstruct Itinerary — LeetCode 332](https://leetcode.com/problems/reconstruct-itinerary/) — Hard — **Euler path** via Hierholzer with lexicographic edge order.
- [Cracking the Safe — LeetCode 753](https://leetcode.com/problems/cracking-the-safe/) — Hard — Euler circuit on the **De Bruijn** graph.
- [Bridges in a Graph — GeeksforGeeks](https://www.geeksforgeeks.org/bridge-in-a-graph/) — Medium — reference walkthrough of the low-link bridge test.
- [Articulation Points (Cut Vertices) — GeeksforGeeks](https://www.geeksforgeeks.org/articulation-points-or-cut-vertices-in-a-graph/) — Medium — the child condition plus root special case.
- [Eulerian Path and Circuit — GeeksforGeeks](https://www.geeksforgeeks.org/eulerian-path-and-circuit/) — Medium — degree-based existence test.

**🏆 Competitive**

- [Mail Delivery — CSES 1691](https://cses.fi/problemset/task/1691) — Medium — undirected **Euler circuit**, print the tour.
- [Teleporters Path — CSES 1693](https://cses.fi/problemset/task/1693) — Medium — directed **Euler path** with fixed endpoints.
- [De Bruijn Sequence — CSES 1692](https://cses.fi/problemset/task/1692) — Medium — Euler circuit on the De Bruijn graph over an alphabet.

> No official Codeforces home-task post ships with this lecture's description, so the set above is curated to match the exact techniques taught.

---

## Further reading

- [Finding bridges — cp-algorithms](https://cp-algorithms.com/graph/bridge-searching.html) — the $tin$/$low$ derivation and implementation.
- [Finding articulation points — cp-algorithms](https://cp-algorithms.com/graph/cutpoints.html) — the cut-vertex conditions and root case.
- [Euler path — cp-algorithms](https://cp-algorithms.com/graph/euler_path.html) — Hierholzer for directed and undirected graphs.
- [Bridge — Wikipedia](https://en.wikipedia.org/wiki/Bridge_(graph_theory)) and [Biconnected component — Wikipedia](https://en.wikipedia.org/wiki/Biconnected_component).
- [Eulerian path — Wikipedia](https://en.wikipedia.org/wiki/Eulerian_path) and [De Bruijn sequence — Wikipedia](https://en.wikipedia.org/wiki/De_Bruijn_sequence).

---

## Key takeaways

- One DFS with $tin$ and $up$ (low-link) answers **both** bridges ($up[v] > tin[p]$) and articulation points (child $up[u] \ge tin[v]$, plus root child-count).
- Undirected DFS trees have **no cross edges** — every non-tree edge is a back edge to an ancestor. That single fact powers every condition here.
- Contracting biconnected pieces gives a **tree** (bridge tree for edges, block-cut tree for vertices), unlocking all tree machinery on graph structure.
- Euler cycle exists iff **connected and all degrees even**; Hierholzer builds it in $O(V+E)$ by marking edges and appending on unwind.
- The recurring trick — emit components **inside** the DFS via a stack of vertices (edge-biconnectivity) or edges (vertex-biconnectivity) — avoids a second pass.

## Glossary

- **Bridge** — edge whose removal increases the number of connected components.
- **Articulation point (cut vertex)** — vertex whose removal increases the number of connected components.
- **$tin[v]$ (entry time)** — DFS pre-order index of $v$; smaller means closer to the root.
- **$up[v]$ / low-link** — smallest $tin$ reachable from $v$'s subtree using at most one back edge.
- **2-edge-connected component** — maximal set of vertices pairwise joined by two edge-disjoint paths.
- **Biconnected component (block)** — maximal set of edges pairwise joined by two vertex-disjoint paths.
- **Bridge tree / block-cut tree** — acyclic condensation of a graph by its 2-edge- / 2-vertex-connected components.
- **Euler cycle / path** — closed / open walk using every edge exactly once.
- **Hierholzer's algorithm** — linear-time Euler-tour construction by edge-marking DFS with append-on-return.
