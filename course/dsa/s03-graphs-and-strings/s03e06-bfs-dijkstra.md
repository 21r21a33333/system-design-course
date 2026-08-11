---
title: "S03E06 · BFS & Dijkstra's Algorithm"
sidebar_position: 6
description: Shortest paths from one source — BFS for unit weights, 0-1 BFS with a deque, and Dijkstra for non-negative weights with the greedy correctness proof, plus bidirectional search and A star.
---

# S03E06 · BFS & Dijkstra's Algorithm

> **Source:** Pavel Mavrin, [_A&DS S03E06_](https://youtu.be/hrQJBe5lN8w) · 1h49m lecture → ~16 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- The **single-source shortest path** problem: given a start $s$, compute $d(v) = \operatorname{dist}(s, v)$ for every $v$. Almost all algorithms find distances to *all* nodes, because every prefix of a shortest path is itself shortest.
- **When all edge weights equal 1**, shortest = fewest edges → **BFS**. Visit nodes in layers of increasing distance using a **queue**; runs in $O(V + E)$.
- **When weights are in $\{0, 1\}$**, use **0-1 BFS**: a **deque** where a weight-0 edge pushes to the *front* and a weight-1 edge pushes to the *back*. Still $O(V + E)$.
- **When weights are non-negative**, use **Dijkstra**. Grow a set $A$ of finalized nodes; repeatedly pull the unfinalized node of minimum tentative distance from a **priority queue** and relax its edges. Correctness rests on weights being $\ge 0$.
- With a **binary heap** Dijkstra is $O(E \log V)$; with a plain array $O(V^2)$; with a Fibonacci heap $O(E + V \log V)$.
- **Bidirectional search** (grow from both $s$ and $t$) and **A star** (add a heuristic $h(v)$ to the priority key) prune the explored region — A star is exactly Dijkstra on reweighted edges $w'(u,v) = w(u,v) - h(u) + h(v)$, which stay non-negative when $h$ obeys the triangle inequality.

---

## The shortest-path problem

- Input: a graph with two distinguished nodes $s$ (start) and $t$ (target); output: the shortest $s \to t$ path.
- Ubiquitous: road networks, but also **state-space search** — nodes are states of some system (a puzzle, a Rubik's cube) and edges are legal moves, so "shortest path" means "fewest actions".
- **Directed vs undirected** barely matters: replace each undirected edge with two directed edges and every algorithm here works unchanged. The lecture draws undirected graphs for convenience but the code is written for directed adjacency lists.
- **Weight variants** drive the algorithm choice:
  - all weights $= 1$ → BFS,
  - weights in $\{0, 1\}$ → 0-1 BFS,
  - weights $\ge 0$ → Dijkstra,
  - (negative weights → Bellman-Ford / Floyd, a later lecture).
- **Key structural fact:** if $s \to \dots \to t$ is a shortest path, then every sub-path is also shortest. So to know $d(t)$ you essentially must know $d(\cdot)$ for the intermediate nodes too — which is why these algorithms are *single-source*, computing all distances at once.

[watch from 0:30](https://youtu.be/hrQJBe5lN8w?t=30)

---

## BFS: shortest paths with unit weights

- **Idea:** enumerate nodes in increasing order of distance from $s$. Distance-0 set is just $\{s\}$. The distance-$(k{+}1)$ set is every *undiscovered* neighbor of a distance-$k$ node.
- **Why it is correct:** a node $u$ has $d(u) = k+1$ iff it is unvisited and has a neighbor at distance $k$. It is not at distance $0, 1, \dots, k$ (else already visited), and a length-$(k{+}1)$ path exists (go to that neighbor, then one edge), so $k+1$ is exactly minimal.

The first board version keeps an explicit array of level-lists:

![BFS by explicit levels: level 0 is s, level k+1 is undiscovered neighbors of level k, with the worked layer table 0 1 2 3 4](/img/dsa/hrQJBe5lN8w/frame-00068.png)

```cpp
#include <bits/stdc++.h>
using namespace std;

// Level-list BFS: level[k] holds every node at distance k from s.
vector<int> bfs_levels(int n, int s, const vector<vector<int>>& adj) {
    vector<int> d(n, -1);                  // -1 marks "not visited yet"
    vector<vector<int>> level(n);          // at most n-1 nonempty levels
    d[s] = 0;
    level[0] = {s};
    for (int k = 0; k <= n - 2; k++) {
        for (int v : level[k]) {           // every vertex at distance k
            for (int u : adj[v]) {         // every outgoing edge v -> u
                if (d[u] == -1) {          // first time we reach u
                    d[u] = k + 1;
                    level[k + 1].push_back(u);
                }
            }
        }
    }
    return d;                              // d[t] == -1 means t unreachable
}
```

- The maximum finite distance is $\le n - 1$ (a simple path visits at most $n$ nodes), so iterating $k$ from $0$ to $n-2$ is enough.

[watch from 13:05](https://youtu.be/hrQJBe5lN8w?t=785)

### Collapse the levels into one queue

- Watching the level version, at any moment you hold a **suffix of level $k$** (nodes not yet expanded) and a **prefix of level $k{+}1$** (nodes just discovered). Concatenate all levels into a single list and that is exactly a **FIFO queue**: pop from the front (level $k$), push to the back (level $k{+}1$).
- By the time you have removed the last level-$k$ node, you have enqueued the whole of level $k{+}1$ — so nodes still leave the queue in nondecreasing distance order.

![Queue BFS: enqueue s, then repeatedly dequeue v and enqueue every undiscovered neighbor with distance d[v]+1](/img/dsa/hrQJBe5lN8w/frame-00110.png)

```cpp
// Canonical BFS with a single queue. adj is a directed adjacency list.
vector<int> bfs(int n, int s, const vector<vector<int>>& adj, vector<int>& par) {
    vector<int> d(n, -1);
    par.assign(n, -1);                     // parent[u] = node we reached u from
    queue<int> q;
    d[s] = 0;
    q.push(s);
    while (!q.empty()) {
        int v = q.front(); q.pop();        // leftmost (nearest) node
        for (int u : adj[v]) {
            if (d[u] == -1) {              // u not calculated yet
                d[u] = d[v] + 1;
                par[u] = v;
                q.push(u);
            }
        }
    }
    return d;
}
```

- **Complexity:** each node is dequeued exactly once, and each edge is scanned once when its tail is expanded, so BFS is $O(V + E)$ (the lecture writes $O(m + n)$).
- **Early exit:** if you only need $d(t)$, break the moment $t$ is dequeued.

[watch from 24:25](https://youtu.be/hrQJBe5lN8w?t=1465)

### Reconstructing the path

- Distances alone are unsatisfying — "you can get there in 4 steps" is useless without the steps. Store a **parent** pointer $par(u) = v$ whenever you first set $d(u) = d(v) + 1$, then walk backward from $t$.

![Queue BFS annotated with parent links p[u]=v and O(m+n); the backward walk v=t, path.add(v), v=p[v]](/img/dsa/hrQJBe5lN8w/frame-00174.png)

```cpp
// Walk parent links backward from t to s; empty if t is unreachable.
vector<int> reconstruct(int s, int t, const vector<int>& par, const vector<int>& d) {
    if (d[t] == -1) return {};
    vector<int> path;
    for (int v = t; v != -1; v = par[v]) {
        path.push_back(v);
        if (v == s) break;
    }
    reverse(path.begin(), path.end());     // now s ... t
    return path;
}
```

[watch from 28:41](https://youtu.be/hrQJBe5lN8w?t=1721)

---

## Bidirectional BFS: search from both ends

- For **huge implicit graphs** (puzzle state spaces where the number of states grows like $\alpha^d$ with depth $d$), a full BFS from $s$ touches about $\alpha^{\operatorname{dist}(s,t)}$ states.
- **Trick:** run BFS from $s$ and from $t$ simultaneously, expanding one layer of each in turn. Stop when the two frontiers **meet** at a node $v$; the shortest distance is then $d_s(v) + d_t(v)$.
- **Parity care:** if $\operatorname{dist}(s,t)$ is even the frontiers meet at a node both sides reach at depth $d/2$; if odd, one side must take one extra step. Handle it by checking, when meeting, both $d_s(v) + d_t(v)$ candidates as you build alternating layers.
- **Payoff:** each side only reaches depth $\approx d/2$, so you explore about $\alpha^{d/2} + \alpha^{d/2}$ states — roughly the **square root** of the one-directional count. Worst case it is still $O(V + E)$ (every node hit at most twice), so it never hurts asymptotically.

[watch from 33:47](https://youtu.be/hrQJBe5lN8w?t=2027)

---

## 0-1 BFS: weights zero or one with a deque

- The lecture develops weighted shortest paths as "BFS with small changes". The cleanest special case, standard for this material, is when every edge weight is $0$ or $1$.
- **Idea:** keep the frontier in a **double-ended queue** that stays sorted by distance. Relaxing a **weight-0** edge keeps the same distance layer → push to the **front**; relaxing a **weight-1** edge advances one layer → push to the **back**. The deque therefore always holds at most two adjacent distance values, so pops come out in nondecreasing order exactly like BFS.

```cpp
struct E01 { int to, w; };                 // w is 0 or 1

vector<int> bfs01(int n, int s, const vector<vector<E01>>& adj) {
    const int INF = INT_MAX;
    vector<int> d(n, INF);
    deque<int> dq;
    d[s] = 0;
    dq.push_front(s);
    while (!dq.empty()) {
        int v = dq.front(); dq.pop_front();
        for (auto [u, w] : adj[v]) {
            if (d[v] + w < d[u]) {         // relaxation
                d[u] = d[v] + w;
                if (w == 0) dq.push_front(u);   // same layer
                else        dq.push_back(u);    // next layer
            }
        }
    }
    return d;
}
```

- **Complexity:** $O(V + E)$ — each edge triggers at most one push, and a node may be popped more than once but only does useful work when it improves $d$.

---

## Dijkstra: non-negative weights

- Setup: a weighted graph, all weights $w_{uv} \ge 0$, and we want $d(v) = \operatorname{dist}(s, v)$ for all $v$.

![Dijkstra setup: a 7-node weighted graph, d(v) = dist(s, v), and the non-negativity assumption w_e is at least 0](/img/dsa/hrQJBe5lN8w/frame-00185.png)

- **Greedy skeleton.** Maintain a set $A$ of nodes whose distance is *finalized*. Start with $A = \{s\}$, $d(s) = 0$. Repeatedly pick the crossing edge that minimizes

$$
d(v) \;=\; \min_{\substack{u \in A,\ v \notin A}} \big( d(u) + w_{uv} \big),
$$

finalize that $v$ (add it to $A$), and repeat $n - 1$ times.

### Why the greedy choice is correct

The crux, and the reason Dijkstra needs **non-negative** weights:

![Dijkstra correctness: any alternate s-to-v path must cross from A to its complement at some edge x-y; that prefix already exceeds the chosen minimum, and the non-negative tail only adds more](/img/dsa/hrQJBe5lN8w/frame-00211.png)

- Let $v \notin A$ be the node achieving the minimum $\min_{u \in A} \big( d(u) + w_{uv} \big)$. Claim: this value equals $\operatorname{dist}(s, v)$.
- **Upper bound:** there is a concrete path of that length — go along the shortest path to $u \in A$, then take edge $u \to v$.
- **No shorter path exists.** Take any other $s \to v$ path $P$. Since $s \in A$ and $v \notin A$, $P$ must cross the boundary of $A$ at some edge $x \to y$ with $x \in A$, $y \notin A$. The prefix $s \to \dots \to x \to y$ already has length $\ge d(x) + w_{xy} \ge$ our chosen minimum (we picked the smallest such crossing value). The **remaining** part $y \to \dots \to v$ has length $\ge 0$ because all weights are non-negative. So $P$ is at least as long as the chosen value.
- **Where non-negativity is essential:** if a later edge could be negative, the "remaining tail $\ge 0$" step fails — a cheap crossing could be undercut by a negative detour, and finalizing $v$ early would be wrong. That is exactly why Dijkstra breaks on negative edges and Bellman-Ford is needed instead.

$$
\underbrace{d(x) + w_{xy}}_{\ge\ \min\ =\ d(v)} \;+\; \underbrace{\operatorname{len}(y \to \dots \to v)}_{\ge\ 0} \;\ge\; d(v).
$$

[watch from 49:19](https://youtu.be/hrQJBe5lN8w?t=2959)

### From skeleton to a heap implementation

- The naive rule scans all crossing edges each step. Improve it the same way Prim's MST does: for each node $v \notin A$ keep only the **single best** tentative distance
  $d(v) = \min_{u \in A} \big( d(u) + w_{uv} \big)$,
  and store those in a priority queue keyed by $d$. Finalizing a node = extract-min; relaxing edges = update keys.

![Dijkstra pseudocode: A starts as the set with only s, d(s)=0, repeat n-1 times extract v of minimum d over v not in A, set d(v), add v to A, then for each edge v to w update d(w) to the min of d(w) and d(v)+w and fix the priority queue](/img/dsa/hrQJBe5lN8w/frame-00280.png)

```cpp
#include <bits/stdc++.h>
using namespace std;

struct Edge { int to; long long w; };      // w >= 0
const long long INF = LLONG_MAX / 4;

// Binary-heap Dijkstra. Returns d[v] = dist(s, v); INF if unreachable.
// par (optional) lets you reconstruct paths exactly like BFS.
vector<long long> dijkstra(int n, int s,
                           const vector<vector<Edge>>& adj,
                           vector<int>& par) {
    vector<long long> d(n, INF);
    par.assign(n, -1);
    // min-heap of (tentative distance, node)
    priority_queue<pair<long long,int>,
                   vector<pair<long long,int>>,
                   greater<pair<long long,int>>> pq;
    d[s] = 0;
    pq.push({0, s});
    while (!pq.empty()) {
        auto [dv, v] = pq.top(); pq.pop();
        if (dv > d[v]) continue;           // stale entry: v already finalized
        for (auto [u, w] : adj[v]) {       // relax every edge v -> u
            if (d[v] + w < d[u]) {
                d[u] = d[v] + w;
                par[u] = v;
                pq.push({d[u], u});         // "lazy" decrease-key
            }
        }
    }
    return d;
}
```

- **Lazy vs true decrease-key.** A binary heap has no cheap `decrease-key`, so the idiomatic trick is to push a fresh $(d[u], u)$ and skip any popped entry whose stored key is stale (`dv > d[v]`). A node is *finalized* the first time it leaves the heap — and by non-negativity its distance can never improve afterward.
- **Correctness restated:** when you extract the heap minimum, no future relaxation can lower it (all weights $\ge 0$), so that distance is final — precisely the greedy argument above.

[watch from 1:07:29](https://youtu.be/hrQJBe5lN8w?t=4049)

### Worked example

Running Dijkstra on the 7-node graph: start $d(s)=0$, tentatively $d = [0, 6, \infty, \infty, 5, \infty, \infty]$; extract $5$ (min), relax; extract $6$; extract $7$; and so on, each extraction finalizing one node and relaxing its out-edges. The final distances read off the last row.

![Dijkstra run: the distance array 0 6 ? 7 5 ? ? updated as nodes are extracted in order 5, 6, 7, 10, 11, with edges relaxed by d(u)+w each step](/img/dsa/hrQJBe5lN8w/frame-00318.png)

[watch from 1:15:23](https://youtu.be/hrQJBe5lN8w?t=4523)

### Choosing the priority queue

![Dijkstra complexity: n extract-min operations and m updates; binary heap gives O(m log n), a plain array O(n^2), a Fibonacci heap O(m + n log n)](/img/dsa/hrQJBe5lN8w/frame-00294.png)

- The loop does $n$ extract-min operations and up to $m$ key updates. The total cost depends only on how fast the priority queue supports those two operations:

| Priority queue | extract-min | decrease-key / update | Total |
| --- | --- | --- | --- |
| Binary heap | $O(\log V)$ | $O(\log V)$ | $O(E \log V)$ |
| Plain array | $O(V)$ | $O(1)$ | $O(V^2)$ |
| Fibonacci heap | $O(\log V)$ amortized | $O(1)$ amortized | $O(E + V \log V)$ |

- **Rules of thumb.** Dense graphs ($m \approx n^2$): the array's $O(V^2)$ wins and uses no extra structure. Sparse graphs: the binary heap's $O(E \log V)$ wins. The Fibonacci heap is asymptotically best but has large constants, so it is mostly of theoretical interest. Any structure supporting min + update works — a balanced BST, a segment tree with "set to infinity", etc.

[watch from 1:11:38](https://youtu.be/hrQJBe5lN8w?t=4298)

### Bidirectional Dijkstra

- The same both-ends idea helps on huge graphs, but the stopping rule is subtler than BFS. When the two searches first share a settled node $v$, the sum $d_s(v) + d_t(v)$ is **not** necessarily the answer — because of weights, a cheaper path may cross via a *different* meeting edge.
- **Correct rule:** once a node is settled by both sides, stop growing and minimize over all boundary edges

$$
\operatorname{dist}(s, t) \;=\; \min_{x, y} \Big( d_s(x) + w_{xy} + d_t(y) \Big),
$$

taking $x$ from the forward tree and $y$ from the backward tree. Useful when the graph is too big to explore fully, especially in higher dimensions where the frontier grows fast.

[watch from 1:22:29](https://youtu.be/hrQJBe5lN8w?t=4949)

---

## A star: Dijkstra with a heuristic

- **Motivation.** Plain Dijkstra explores an ever-growing *circle* around $s$, treating a node behind you and a node toward $t$ as equally worthy. On a road map you *know* one direction is more promising.

![A star intuition: Dijkstra explores a circle around s, but with a heuristic h(v) that estimates the remaining distance to t the explored region stretches toward the target](/img/dsa/hrQJBe5lN8w/frame-00364.png)

- **Heuristic.** Suppose you have an estimate $h(v) \approx \operatorname{dist}(v, t)$ (for a road map: straight-line Euclidean distance). Require it to be **consistent** — satisfy the triangle inequality on every edge:

$$
h(u) \;\le\; w_{uv} + h(v) \quad\text{for every edge } (u, v).
$$

- **Algorithm.** Run Dijkstra unchanged but order the priority queue by the key $d(v) + h(v)$ instead of $d(v)$. Nodes pointing toward $t$ get better priority, so the explored region is pulled toward the target and far fewer nodes are settled.

![A star worked example on a road-map grid: each node labeled with heuristic h to the target, priority key d + h, and the minimal path value 14 found without exploring unpromising nodes](/img/dsa/hrQJBe5lN8w/frame-00407.png)

- **Why it is exactly Dijkstra in disguise.** Reweight every edge as

$$
w'(u, v) \;=\; w(u, v) - h(u) + h(v).
$$

For any $s \to v$ path the intermediate $h$ terms telescope, leaving

$$
\operatorname{dist}'(s, v) \;=\; \operatorname{dist}(s, v) - h(s) + h(v).
$$

Since $-h(s)$ is a constant, minimizing the new distance minimizes the old one, and the priority key $d(v) + h(v)$ is exactly the reweighted distance (up to the constant). The consistency inequality $h(u) \le w_{uv} + h(v)$ is precisely $w'(u, v) \ge 0$, so the reweighted graph has non-negative edges and ordinary Dijkstra is provably correct on it.

- **Special case:** $h \equiv 0$ trivially satisfies the inequality (all weights $\ge 0$) and reduces A star back to Dijkstra. A smarter $h$ only ever helps.

[watch from 1:28:02](https://youtu.be/hrQJBe5lN8w?t=5282)

---

## Complexity recap

| Algorithm | Weights | Data structure | Time | Space |
| --- | --- | --- | --- | --- |
| BFS | all $= 1$ | queue | $O(V + E)$ | $O(V)$ |
| Bidirectional BFS | all $= 1$ | two queues | $O(V + E)$ worst; $\approx \sqrt{}$ fewer nodes typical | $O(V)$ |
| 0-1 BFS | in $\{0, 1\}$ | deque | $O(V + E)$ | $O(V)$ |
| Dijkstra (binary heap) | $\ge 0$ | min-heap | $O(E \log V)$ | $O(V + E)$ |
| Dijkstra (array) | $\ge 0$ | array | $O(V^2)$ | $O(V)$ |
| Dijkstra (Fibonacci heap) | $\ge 0$ | Fibonacci heap | $O(E + V \log V)$ | $O(V + E)$ |
| A star | $\ge 0$, consistent $h$ | min-heap | $O(E \log V)$ worst; far fewer settled with good $h$ | $O(V + E)$ |

---

## Practice problems

**🎯 Interview (MAANG-style)**

- [Network Delay Time — LeetCode 743](https://leetcode.com/problems/network-delay-time/) — Med — textbook single-source Dijkstra; answer is the max finalized distance.
- [Cheapest Flights Within K Stops — LeetCode 787](https://leetcode.com/problems/cheapest-flights-within-k-stops/) — Med — shortest path with a hop bound; BFS-by-layers or Bellman-Ford relaxations beat plain Dijkstra here.
- [Path With Minimum Effort — LeetCode 1631](https://leetcode.com/problems/path-with-minimum-effort/) — Med — Dijkstra where path cost is the max edge, not the sum (min-max relaxation).
- [Shortest Path in Binary Matrix — LeetCode 1091](https://leetcode.com/problems/shortest-path-in-binary-matrix/) — Med — unit-weight grid BFS with 8-directional moves.
- [Word Ladder — LeetCode 127](https://leetcode.com/problems/word-ladder/) — Hard — implicit-graph BFS; edges are one-letter transforms, ideal for bidirectional BFS.
- [Bus Routes — LeetCode 815](https://leetcode.com/problems/bus-routes/) — Hard — model routes as nodes and BFS over route-adjacency.
- [Number of Ways to Arrive at Destination — LeetCode 1976](https://leetcode.com/problems/number-of-ways-to-arrive-at-destination/) — Med — Dijkstra augmented to count shortest paths modulo a prime.
- [Dijkstra's shortest path — GeeksforGeeks](https://www.geeksforgeeks.org/dijkstras-shortest-path-algorithm-greedy-algo-7/) — Med — the canonical heap implementation with worked steps.

**🏆 Competitive**

- [Shortest Routes I — CSES 1671](https://cses.fi/problemset/task/1671) — Med — pure Dijkstra with a min-heap; watch for 64-bit distances.
- [Message Route — CSES 1667](https://cses.fi/problemset/task/1667) — Easy — unit-weight BFS plus parent-pointer path reconstruction.
- [Flight Discount — CSES 1195](https://cses.fi/problemset/task/1195) — Med — Dijkstra on a two-layer state graph (discount used or not).

> This lecture had no official Codeforces home-task post in its description; the problems above are curated interview-core and CSES classics that exercise exactly BFS, 0-1 BFS, and Dijkstra.

---

## Further reading

- [Breadth-first search — cp-algorithms](https://cp-algorithms.com/graph/breadth-first-search.html) — layers, queue, path reconstruction.
- [0-1 BFS — cp-algorithms](https://cp-algorithms.com/graph/01_bfs.html) — the deque technique in full.
- [Dijkstra's algorithm — cp-algorithms](https://cp-algorithms.com/graph/dijkstra.html) — array and heap variants with complexity analysis.
- [Dijkstra's algorithm — Wikipedia](https://en.wikipedia.org/wiki/Dijkstra%27s_algorithm) and [Breadth-first search — Wikipedia](https://en.wikipedia.org/wiki/Breadth-first_search).
- [BFS for a graph — GeeksforGeeks](https://www.geeksforgeeks.org/breadth-first-search-or-bfs-for-a-graph/).

---

## Key takeaways

- Match the algorithm to the weights: unit → BFS, $\{0,1\}$ → 0-1 BFS, non-negative → Dijkstra.
- BFS is a queue that pops nodes in distance order; store parent pointers to recover the path, not just its length.
- Dijkstra is greedy: finalize the closest unfinalized node, and that choice is safe **only because weights are non-negative** — the boundary-crossing proof breaks the instant an edge can go negative.
- The priority queue is the whole cost story: array $O(V^2)$ for dense graphs, binary heap $O(E \log V)$ for sparse, Fibonacci heap $O(E + V \log V)$ in theory.
- Bidirectional search and A star do not change what "shortest" means — they shrink the region you explore. A star is literally Dijkstra on edges reweighted by a consistent heuristic.

## Glossary

- **Relaxation** — the update `if d[v] + w < d[u] then d[u] = d[v] + w`, tightening a tentative distance.
- **Finalize / settle** — mark a node's distance as provably minimal (added to $A$ / popped from the heap for the first time).
- **Layer (BFS level)** — the set of nodes at a fixed distance $k$ from $s$.
- **Consistent heuristic** — an estimate $h$ with $h(u) \le w_{uv} + h(v)$ on every edge; guarantees A star is correct.
- **Decrease-key** — lowering a key already in the priority queue; $O(\log V)$ in a binary heap, $O(1)$ amortized in a Fibonacci heap, or simulated lazily by pushing a fresh entry.
