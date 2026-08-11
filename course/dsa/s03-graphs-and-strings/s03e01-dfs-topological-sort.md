---
title: "S03E01 · Graphs, DFS & Topological Sort"
sidebar_position: 1
description: Graph representations, depth-first search with tin/tout timestamps and edge classification, cycle detection via white/gray/black colors, and topological sorting by both DFS post-order and Kahn's in-degree BFS, all in O(V+E).
---

# S03E01 · Graphs, DFS & Topological Sort

> **Source:** Pavel Mavrin, [_A&DS S03E01_](https://youtu.be/L2mnGv6ydYA) · 1h26m lecture → ~14 min read.
> Season 3 opener. Every section deep-links back to the exact moment on the board.

## TL;DR

- A **graph** is vertices plus edges; edges are **undirected** (a symmetric relation) or **directed** (a state-transition). Complexity is a function of two sizes, $n$ vertices and $m$ edges.
- We store graphs as an **adjacency list** (one list of out-neighbors per vertex, total size $m$) — not an adjacency matrix ($n^2$ memory) unless the graph is dense.
- **Depth-first search** marks every vertex reachable from a start vertex in $O(n + m)$. Running it from each unmarked vertex finds all **connected components**.
- Recording **enter/exit timestamps** $tin$ and $tout$ during DFS lets you classify every non-tree edge as **tree / back / forward / cross** by comparing time intervals. A **back edge** (to a gray vertex) is exactly a **cycle**.
- **Topological sort** of a DAG can be done two ways, both $O(n + m)$: (1) DFS **post-order reversed**, and (2) **Kahn's algorithm** — repeatedly emit a vertex with in-degree zero. If either fails to emit all $n$ vertices, the graph has a cycle.

---

## What is a graph, and the two size bounds

- A graph is a set of **vertices** (circles) joined by **edges** (segments). Two flavors:
  - **Undirected** — an edge is a symmetric relation between two objects.
  - **Directed** — each edge has a direction; models a **state → state** transition or a dependency.
- Some algorithms work on both; some are specific to one flavor. This lecture's DFS works on both.
- Complexity is written as $T(n, m)$ — a function of **two** variables, unlike earlier lectures that had a single input size $n$.
- Two inequalities the lecturer assumes to simplify formulas:
  - **Lower bound.** A connected graph needs $m \ge n - 1$ edges (fewer and it splits into pieces you would process component-by-component anyway).
  - **Upper bound (simple graph, no parallel edges).** Undirected: $m \le \frac{n(n-1)}{2}$. Directed: $m \le n(n-1)$. Both are $O(n^2)$.
- So $n - 1 \le m \le O(n^2)$, which lets us shorten bounds: $O(n + m) = O(m)$ (since $m \ge n - 1$) and $O(n^2 + m) = O(n^2)$ (since $m \le n^2$).

![Board with the graph size function T(n,m), the bound m at least n minus 1 if connected, and n vertices m edges](/img/dsa/L2mnGv6ydYA/frame-00045.png)

[watch from 3:26](https://youtu.be/L2mnGv6ydYA?t=206)

---

## Storing a graph: matrix versus adjacency list

Two standard representations:

**1. Adjacency matrix** — an $n \times n$ array; put $1$ in cell $(v, u)$ for each edge $v \to u$.

- For an **undirected** edge the matrix is symmetric (a $1$ at both $(u,v)$ and $(v,u)$); for a **directed** edge only $(v,u)$.
- Uses $n^2$ memory regardless of how few edges exist. Handy when you want to apply **linear-algebra** algorithms to the edge set, but wasteful for sparse graphs.

**2. Adjacency list** — for each vertex store the list of edges leaving it.

- Total length across all lists is exactly $m$ (directed) — each edge lives in one list. For an **undirected** edge $u - v$ you store $v$ in $u$'s list and $u$ in $v$'s list, so the total is $2m$, still $O(m)$.
- Preferred whenever $m \ll n^2$ (a **sparse** graph).

```cpp
#include <bits/stdc++.h>
using namespace std;

int n;                          // number of vertices
vector<vector<int>> adj;        // adj[v] = out-neighbors of v (a directed edge v -> u)

void add_directed(int v, int u) { adj[v].push_back(u); }
void add_undirected(int a, int b) {          // each undirected edge stored twice
    adj[a].push_back(b);
    adj[b].push_back(a);
}
```

![Adjacency matrix five by five next to the per-vertex adjacency lists and the connected-components list](/img/dsa/L2mnGv6ydYA/frame-00056.png)

[watch from 9:19](https://youtu.be/L2mnGv6ydYA?t=559)

---

## First algorithm: DFS and connected components

- A **connected component** (undirected graph) is a maximal set of vertices where you can walk from any one to any other. "Is connected to" is an equivalence relation — reflexive, symmetric, transitive — so vertices partition into components.
- **Task:** label every vertex with its component id.
- **Depth-first search** `dfs(v)`: mark `v`, then recurse into every unmarked out-neighbor. When it returns, everything reachable from `v` has been marked.

```cpp
vector<bool> mark;
vector<int> comp;               // component id of each vertex

void dfs(int v, int c) {
    mark[v] = true;
    comp[v] = c;
    for (int u : adj[v])
        if (!mark[u]) dfs(u, c);   // only descend into unvisited neighbors
}

int count_components() {
    mark.assign(n, false);
    comp.assign(n, -1);
    int c = 0;
    for (int v = 0; v < n; v++)      // outer loop: start a new DFS per component
        if (!mark[v]) dfs(v, c++);
    return c;
}
```

- **Trick** to avoid the outer loop: add a virtual **source vertex 0** with an edge to every real vertex, then a single `dfs(0)` reaches everything. In practice the plain outer `for` loop is simpler.

![DFS pseudocode dfs of v marks v and recurses over out of v, beside the adjacency lists and component labels](/img/dsa/L2mnGv6ydYA/frame-00087.png)

**Correctness (both directions).** Let $s$ be the start vertex.

- *Everything marked is connected to $s$.* Invariant: we only ever recurse across a real edge into a new vertex, so every marked vertex has a path back to $s$ (transitivity along the recursion).
- *Everything connected to $s$ gets marked.* Suppose some reachable $u$ stayed unmarked. Walk the $s \to u$ path to the first unmarked vertex $y$; its predecessor $x$ **was** marked, so `dfs(x)` ran and iterated edge $x \to y$ — it would have descended into the unmarked $y$. Contradiction.

**Complexity.** Each vertex is entered **once** (the mark guards it), and inside `dfs(v)` we scan $v$'s list once. Summed over all vertices the lists total $m$ elements, so the whole traversal is $O(n + m)$.

![DFS recursion forest drawn from node 1 branching to 4, 5, 7 and a second tree from node 2](/img/dsa/L2mnGv6ydYA/frame-00140.png)

[watch from 15:41](https://youtu.be/L2mnGv6ydYA?t=941)

> **On recursion.** DFS is naturally recursive, but recursion is not fundamental — any recursive DFS can be rewritten iteratively with an explicit stack. Recursion is just the clearest way to explain the stack behavior.

---

## Directed graphs, DAGs, and why topological order matters

- A **DAG** (directed acyclic graph) is a directed graph with **no cycles**. (For undirected graphs, "acyclic" just means a tree or forest — less interesting, so the term is used for directed graphs.)
- A **topological order** is an ordering of the vertices such that **every edge goes left to right** (from an earlier vertex to a later one).
- Why it matters:
  - **Dependency resolution** — load libraries so that each is loaded after all its dependencies. A cycle means the dependencies are impossible to satisfy (a deadlock).
  - **DP on a DAG** — process vertices in topological order so that when you compute a vertex's value, all vertices it depends on are already computed.
- The order is **not unique**; a DAG can have many valid topological orders (up to an exponential number), so you never try to enumerate them all.

[watch from 37:08](https://youtu.be/L2mnGv6ydYA?t=2228)

---

## Topological sort I — DFS post-order, reversed

- **Idea:** run DFS; when `dfs(v)` **finishes** (after all descendants), append `v` to a list. The list comes out in **reverse** topological order, so reverse it at the end.

```cpp
vector<int> color;              // 0 = white, 1 = gray, 2 = black
vector<int> order_;             // post-order accumulator
bool has_cycle;

void dfs_topo(int v) {
    color[v] = 1;               // gray = on the recursion stack
    for (int u : adj[v]) {
        if (color[u] == 0) dfs_topo(u);       // tree edge
        else if (color[u] == 1) has_cycle = true;   // back edge to a gray vertex
    }
    color[v] = 2;               // black = finished
    order_.push_back(v);        // v finishes AFTER all it can reach
}

vector<int> topo_sort_dfs() {
    color.assign(n, 0);
    order_.clear();
    has_cycle = false;
    for (int v = 0; v < n; v++)
        if (color[v] == 0) dfs_topo(v);
    if (has_cycle) return {};              // no valid order on a cyclic graph
    reverse(order_.begin(), order_.end());
    return order_;
}
```

- **Why it works.** Take any edge $v \to u$. When `dfs(v)` scans this edge, either:
  - $u$ is white → we recurse, finish `dfs(u)` (append $u$), then later finish `dfs(v)` (append $v$). So $u$ is appended **before** $v$.
  - $u$ is already black → `dfs(u)` already finished and $u$ is already in the list, again **before** $v$.
  - $u$ is **gray** (still on the stack) → there is a path $u \rightsquigarrow v$ already, plus this edge $v \to u$, forming a **cycle**. On a DAG this case never happens.
- After reversing, every edge $v \to u$ has $v$ earlier than $u$ — the definition of topological order.
- The three-color state (white / gray / black) is exactly what makes **cycle detection** fall out for free: a back edge is an edge to a **gray** vertex.

![Directed graph plus DFS-postorder topological sort code with topsort add v, and the reversed output order](/img/dsa/L2mnGv6ydYA/frame-00230.png)

[watch from 42:12](https://youtu.be/L2mnGv6ydYA?t=2532)

---

## Topological sort II — Kahn's in-degree BFS

- **Idea:** the first vertex in any topological order must have **no incoming edges** (in-degree $0$). Emit it, delete it (which decrements its neighbors' in-degrees), and repeat.
- **Data structure:** an array `indeg[v]` = number of incoming edges, plus a set $Z$ of vertices whose in-degree is currently $0$. The set needs only "insert" and "remove any element" in $O(1)$, so a **stack or queue** works — no need for a priority queue (that would add a needless $\log$ factor).

```cpp
vector<int> topo_sort_kahn() {
    vector<int> indeg(n, 0);
    for (int v = 0; v < n; v++)
        for (int u : adj[v]) indeg[u]++;      // count incoming edges

    queue<int> z;                             // the "set of zeros"
    for (int v = 0; v < n; v++)
        if (indeg[v] == 0) z.push(v);

    vector<int> ord;
    while (!z.empty()) {
        int v = z.front(); z.pop();
        ord.push_back(v);
        for (int u : adj[v])
            if (--indeg[u] == 0) z.push(u);   // u now has no remaining prerequisites
    }
    if ((int)ord.size() != n) return {};      // stuck early => a cycle exists
    return ord;
}
```

- **Complexity.** Each vertex enters $Z$ exactly once; when removed, we scan its out-list once. Total work is $O(n + m)$.
- **Cycle detection.** If the graph has a cycle, the vertices on it never reach in-degree $0$, so the loop stops after emitting fewer than $n$ vertices. Checking `ord.size() != n` detects the cycle. (Kahn's never loops forever — it simply stops early.)

![Kahn's algorithm code building the in-degree counters cnt of v, the set of zeros Z, and the while loop that pops and decrements, labeled O of n plus m](/img/dsa/L2mnGv6ydYA/frame-00280.png)

**Compile-tested** on the lecture's DAG (nodes shown 1-indexed; internally 0-indexed) plus a version with an injected cycle:

```text
DFS  topo: 5 3 4 2 1
Kahn topo: 5 3 2 4 1
DFS valid : yes            # every edge goes left to right
Kahn valid: yes
tin/tout  : 1(0,1) 2(2,3) 3(4,7) 4(5,6) 5(8,9)
After adding a back edge (cycle):
  DFS  cycle detected: yes
  Kahn cycle detected: yes
```

Both orders differ (topological order is not unique) yet both are valid, and both methods flag the cycle once a back edge is added.

[watch from 55:06](https://youtu.be/L2mnGv6ydYA?t=3306)

---

## Detecting cycles three ways

Summarizing the cycle tests the lecture gives:

- **Via Kahn's** — if the emitted order has fewer than $n$ vertices, a cycle exists.
- **Via a topological order check** — build any candidate order, then scan all edges; if some edge goes **right to left**, the "order" is invalid, meaning a cycle.
- **Via DFS colors** — during DFS, an edge into a **gray** vertex (one still on the recursion stack) is a **back edge**, and a back edge exists **iff** the graph has a cycle. This is the cleanest single-pass test.

```cpp
// Standalone cycle test on a directed graph using colors.
bool find_cycle_dfs() {
    color.assign(n, 0);
    has_cycle = false;
    order_.clear();
    for (int v = 0; v < n; v++)
        if (color[v] == 0) dfs_topo(v);      // sets has_cycle on any gray hit
    return has_cycle;
}
```

[watch from 1:07:20](https://youtu.be/L2mnGv6ydYA?t=4040)

---

## The DFS forest and edge classification

Run DFS on a directed graph and keep only the edges you actually descended through — they form the **DFS tree** (a **forest** if you start several times, or one tree if you add the virtual source $0$). Every other edge of the graph falls into one of three kinds relative to this tree:

- **Tree edges** — the edges DFS descended (parent → child).
- **Forward edges (down)** — from an ancestor to a proper descendant, but not a tree edge. Harmless: those vertices were already connected via the tree path.
- **Back edges (up)** — from a descendant to an ancestor. These exist **iff** the graph has a **cycle** (the tree path down plus the back edge up closes a loop).
- **Cross edges (right to left)** — between two vertices with no ancestor relation, always pointing from a later-finished subtree to an earlier one.

What you can **never** have is an edge pointing "left to right" to an unrelated, not-yet-visited subtree: if `dfs(v)` finished, it already scanned that edge, and an unmarked target would have been descended into as a tree edge. This is another proof that DFS post-order yields a valid topological order — no forbidden left-to-right cross edge means no violation.

![DFS forest with tree edges plus colored back, forward and cross edges illustrating the four edge types](/img/dsa/L2mnGv6ydYA/frame-00314.png)

**Timestamps.** Record two counters per vertex during DFS: $tin[v]$ when you **enter** and $tout[v]$ when you **exit**.

```cpp
vector<int> tin, tout;
int timer_ = 0;

void dfs_time(int v) {
    color[v] = 1;
    tin[v] = timer_++;                 // enter time
    for (int u : adj[v])
        if (color[u] == 0) dfs_time(u);
    color[v] = 2;
    tout[v] = timer_++;                // exit time
}
```

- The interval $[tin[v], tout[v]]$ **nests** exactly like the recursion. For two vertices the intervals are either **disjoint** or one **contains** the other:
  - $[tin[u], tout[u]] \subset [tin[v], tout[v]]$ means $u$ is a **descendant** of $v$ (edge $v \to u$ is a tree or forward edge).
  - $tin[v] \in [tin[u], tout[u]]$ with $v$ deeper means edge $v \to u$ climbs to an ancestor — a **back edge**.
  - Fully disjoint intervals mean a **cross edge**.
- So the type of any edge is decidable in $O(1)$ from the timestamps — the tooling this lecture sets up for later algorithms (bridges, articulation points, strongly connected components).

![DFS with enter and exit timestamps tin of v and tout of v annotated on the recursion, used to classify edges](/img/dsa/L2mnGv6ydYA/frame-00337.png)

[watch from 1:14:22](https://youtu.be/L2mnGv6ydYA?t=4462)

---

## Complexity recap

| Operation | Time | Space | Notes |
| --- | --- | --- | --- |
| Build adjacency list | $\Theta(n + m)$ | $\Theta(n + m)$ | preferred for sparse graphs |
| Build adjacency matrix | $\Theta(n^2)$ | $\Theta(n^2)$ | only for dense graphs / linear algebra |
| DFS traversal / components | $\Theta(n + m)$ | $O(n)$ | recursion stack up to $O(n)$ |
| Cycle detection (colors) | $\Theta(n + m)$ | $O(n)$ | back edge to a gray vertex |
| Topological sort (DFS post-order) | $\Theta(n + m)$ | $O(n)$ | reverse the finish order |
| Topological sort (Kahn's) | $\Theta(n + m)$ | $O(n)$ | in-degree BFS, queue or stack |

Using $m \ge n - 1$, all of these collapse to $O(m)$ on a connected graph.

---

## Practice problems

DFS, cycle detection, and topological sort are **core interview material** — Course Schedule alone shows up constantly.

**🎯 Interview (MAANG-style)**

- [Course Schedule — LeetCode 207](https://leetcode.com/problems/course-schedule/) — Medium — detect whether a dependency DAG has a cycle (topo-feasibility).
- [Course Schedule II — LeetCode 210](https://leetcode.com/problems/course-schedule-ii/) — Medium — output an actual topological order (Kahn's or DFS post-order).
- [Find Eventual Safe States — LeetCode 802](https://leetcode.com/problems/find-eventual-safe-states/) — Medium — color-based DFS; a vertex is safe iff no back edge lies below it.
- [Alien Dictionary — LeetCode 269](https://leetcode.com/problems/alien-dictionary/) — Hard — derive edges from word order, then topological sort the alphabet.
- [Number of Islands — LeetCode 200](https://leetcode.com/problems/number-of-islands/) — Medium — connected components on an implicit grid graph via DFS flood fill.
- [Number of Provinces — LeetCode 547](https://leetcode.com/problems/number-of-provinces/) — Medium — count connected components in an undirected graph.
- [Number of Operations to Make Network Connected — LeetCode 1319](https://leetcode.com/problems/number-of-operations-to-make-network-connected/) — Medium — components minus one gives the cables needed.
- [Topological Sorting — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/topological-sorting/) — Medium — canonical topo-sort implementation and explanation.

**🏆 Competitive**

- [Course Schedule — CSES 1679](https://cses.fi/problemset/task/1679) — Medium — topological order of a task DAG, or report a cycle ("IMPOSSIBLE").
- [Round Trip II — CSES 1678](https://cses.fi/problemset/task/1678) — Medium — recover an actual cycle via DFS parent pointers (directed variant).
- [Building Roads — CSES 1666](https://cses.fi/problemset/task/1666) — Easy — count components with DFS, then connect them with (components minus one) roads.
- [Flight Routes Check — CSES 1682](https://cses.fi/problemset/task/1682) — Medium — a reachability/strong-connectivity check that builds directly on this DFS toolkit.

> No official Codeforces home-task link is attached to this lecture's description, so the competitive set above is curated from CSES, which mirrors the ITMO course's topics.

---

## Further reading

- [Depth First Search — cp-algorithms](https://cp-algorithms.com/graph/depth-first-search.html) — DFS with edge classification and tin/tout, matching this lecture.
- [Topological Sort — cp-algorithms](https://cp-algorithms.com/graph/topological-sort.html) — the DFS post-order method in full.
- [Finding a Cycle — cp-algorithms](https://cp-algorithms.com/graph/finding-cycle.html) — color-based cycle recovery.
- [Depth-first search — Wikipedia](https://en.wikipedia.org/wiki/Depth-first_search) and [Topological sorting — Wikipedia](https://en.wikipedia.org/wiki/Topological_sorting) — Kahn's algorithm and the DFS variant side by side.
- [Directed acyclic graph — Wikipedia](https://en.wikipedia.org/wiki/Directed_acyclic_graph).
- [DFS for a Graph — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/depth-first-search-or-dfs-for-a-graph/) and [Detect Cycle in a Graph — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/detect-cycle-in-a-graph/).

---

## Key takeaways

- Store sparse graphs as **adjacency lists** ($O(m)$ memory); reserve the matrix for dense graphs or linear-algebra tricks.
- **DFS is $O(n + m)$** and is the workhorse: components, cycle detection, and topological order all fall out of it.
- The **white / gray / black** coloring gives cycle detection for free — a back edge is an edge into a gray vertex.
- **Topological sort two ways:** DFS post-order reversed, or Kahn's in-degree BFS. Both are $O(n + m)$; both signal a cycle if they cannot place all $n$ vertices.
- **Timestamps $tin / tout$** classify every edge as tree / back / forward / cross in $O(1)$ — the foundation for the harder DFS-based algorithms coming next season.

## Glossary

- **DAG** — directed acyclic graph; a directed graph with no cycles, the only kind with a topological order.
- **Connected component** — a maximal set of mutually reachable vertices in an undirected graph.
- **Adjacency list** — per-vertex list of out-neighbors; total size $m$ (directed) or $2m$ (undirected).
- **Topological order** — a vertex ordering in which every directed edge points from earlier to later.
- **Back edge** — a DFS edge into a still-open (gray) ancestor; its presence is equivalent to a cycle.
- **tin / tout** — DFS enter and exit timestamps whose nesting reveals ancestor/descendant relationships.
- **Kahn's algorithm** — topological sort by repeatedly removing an in-degree-zero vertex.
