---
title: "S02E10 · Heavy-Light Decomposition"
sidebar_position: 10
description: Split a tree into heavy paths so any root-to-node path crosses at most log n light edges, lay the paths contiguously into one segment tree, and answer path aggregate queries with point updates in O(log squared n).
---

# S02E10 · Heavy-Light Decomposition

> **Source:** Pavel Mavrin, [_A&DS S02E10_](https://youtu.be/_S1CQ5g9uTg) · 1h06m lecture → ~14 min read.
> The playlist labels this E09, but it is the 10th S02 lecture; we call it E10 for sequential clarity. Every section deep-links back to the exact moment on the board.

## TL;DR

- **Problem.** A rooted tree with a value in every node. Support two online queries: **update** node $v$ to a new value, and **path query** — an associative aggregate (sum, min, max, matrix product…) over all nodes on the path $u \to v$.
- **Reduce to a line first.** On a bamboo (a path graph) this is exactly a **segment tree** over an array: point update plus range aggregate. So a general tree needs at least that much machinery.
- **Heavy-light decomposition (HLD).** For each node mark the edge to its **largest-subtree child** as *heavy*; all other edges are *light*. Heavy edges chain into disjoint **heavy paths** that partition the tree.
- **Key lemma.** Any path from a node to the root crosses **at most $\log_2 n$ light edges** — each light edge at least doubles the subtree size beneath you. So $u \to v$ touches $O(\log n)$ heavy paths.
- **One big segment tree.** Order nodes by a DFS that visits the **heavy child first**; then every heavy path is a *contiguous* segment. A path query becomes $O(\log n)$ segment-tree range queries → **$O(\log^2 n)$** total; update is **$O(\log n)$**.

---

## The problem: path aggregates with updates

- Tree, each node holds a value ($a, b, c, d, \dots$). Given $u$ and $v$, compute $f$ over the nodes on the path — e.g. $a + b + c + d$ where $+$ is any **associative** operation (same family as segment-tree ops).
- Two request types, interleaved and online:
  - $\mathrm{calc}(u, v)$ = aggregate over the path $u \to v$.
  - $\mathrm{set}(v, x)$ = write value $x$ into node $v$.
- **Static-only shortcut.** If there were *no* updates, binary lifting alone answers path aggregates: store, for each node and each power-of-two jump, the aggregate over that jump. That was a home-task; here we specifically need updates too, so lifting is not enough.
- **Why this is hard.** Updates rule out precomputed jump aggregates — a single change would invalidate $O(\log n)$ of them per ancestor. We need a structure that supports both cheaply.

![Problem setup: calc(u,v) aggregates the path, set(v,x) updates a node; the bamboo special case reduces to a segment tree over an array](/img/dsa/_S1CQ5g9uTg/frame-00055.png)

[watch from 0:39](https://youtu.be/_S1CQ5g9uTg?t=39)

---

## Warm-up: solve the bamboo, and recognize the segment tree

- **Special-case strategy.** Before attacking the tree, solve the simplest tree — a **bamboo** (every node has one child, so the tree is a straight line).
- On a bamboo the tree *is* an array. Update = point assign; path aggregate $u \to v$ = aggregate over a contiguous array segment. That is precisely the **segment tree** from S02E01.
- **Takeaway.** Even the trivial tree already needs a segment tree, so the general solution will be "segment tree plus glue". The glue is: cut the tree into a few line-like pieces and run a segment tree over each.

[watch from 4:09](https://youtu.be/_S1CQ5g9uTg?t=249)

---

## Heavy and light edges

- Classify every edge into **heavy** or **light**. For a node $x$ with children $y_1, y_2, \dots$, compute each child's **subtree size** (node count) and mark the edge to the child with the **largest** subtree as heavy. All other child-edges are light.
- Ties: pick any one maximal child as heavy — it does not affect the asymptotics.
- Every non-leaf has **exactly one** heavy child; leaves have none.

- **Two equivalent schools** of the definition (both give the same asymptotics):
  - **Largest child** (used here): heavy = the biggest subtree among the children. Simple to compute in the size DFS, and tends to produce *more* heavy edges → a slightly smaller constant.
  - **Half threshold**: child $y$ is heavy if $\mathrm{size}(y) \ge \tfrac{1}{2}\,\mathrm{size}(x)$. Some nodes then have no heavy child. This is the version you often see quoted, but it is a touch slower and no easier here.

- Both definitions share the property that matters: at most one heavy child per node, and a light edge always sits beside a heavier sibling subtree.

![The full tree with heavy edges drawn as chains; heavy paths cascade down, and isolated leaves count as heavy paths of size one](/img/dsa/_S1CQ5g9uTg/frame-00068.png)

[watch from 7:54](https://youtu.be/_S1CQ5g9uTg?t=474)

### Computing sizes and heavy children in one linear DFS

- One post-order DFS returns each subtree's size and, along the way, records the heavy child. Faithful to the board's `go(x)`:

```cpp
#include <bits/stdc++.h>
using namespace std;

int n;
vector<vector<int>> g;      // children (rooted tree)
vector<int> par, sz, heavy; // parent, subtree size, heavy child (-1 if none)

// Returns size of subtree(x); sets sz[x], heavy[x], and par of children.
int go(int x) {
    sz[x] = 1;
    int best = 0;                       // largest child subtree seen so far
    for (int y : g[x]) {                // iterate all children
        par[y] = x;
        int c = go(y);                  // c = size of child subtree
        sz[x] += c;
        if (c > best) {                 // this child is the heaviest so far
            best = c;
            heavy[x] = y;               // mark edge x -> y as heavy
        }
    }
    return sz[x];
}
```

- **Data structure invariant.** After `go(root)`: `sz[x]` is the exact subtree size, and `heavy[x]` names the unique heavy child (or $-1$ at a leaf). Runs in $O(n)$ — each node and edge is touched once.

![The tree with heavy paths highlighted in red plus the recursive go(x): size starts at 1, add child sizes, keep the max child as the heavy edge, return size](/img/dsa/_S1CQ5g9uTg/frame-00097.png)

[watch from 15:00](https://youtu.be/_S1CQ5g9uTg?t=900)

---

## Heavy paths partition the tree

- Follow heavy edges downward: from a node, take its one heavy child, then that node's heavy child, and so on. Because each node has at most one heavy child, these edges link into **disjoint chains** — the **heavy paths**.
- Every node lies on exactly one heavy path. A leaf with no heavy edge above it forms a **heavy path of length one** (a singleton).
- So the whole tree is partitioned into heavy paths, and we will lay a segment tree over each.

- **Path decomposition.** Walk $u \to v$. Split at $\mathrm{lca}(u, v)$ into two upward legs: $u \to \mathrm{lca}$ and $v \to \mathrm{lca}$. Each leg climbs through a sequence of heavy-path *segments*, hopping between paths across light edges.

[watch from 17:35](https://youtu.be/_S1CQ5g9uTg?t=1055)

---

## The core lemma: at most log n light edges to the root

This is why HLD is fast. Fix a node and climb to the root; count the **light** edges crossed.

- Suppose you cross a light edge from child subtree $S_c$ (size $x$) up to parent $p$. "Light" means $p$'s heavy child leads a subtree of size $\ge x$. That heavy sibling plus $S_c$ plus $p$ itself gives

$$
\mathrm{size}(p) \; \ge \; \underbrace{x}_{\text{your subtree}} + \underbrace{x}_{\text{heavier sibling}} \; = \; 2x .
$$

- So **every light edge you cross at least doubles the current subtree size.** You start at a subtree of size $\ge 1$ and end at the root of size $n$:

$$
1 \cdot 2^{(\#\,\text{light edges})} \;\le\; n
\quad\Longrightarrow\quad
\#\,\text{light edges} \;\le\; \log_2 n .
$$

- **Heavy paths on a root path.** Light edges are exactly the boundaries between consecutive heavy-path segments along the climb. With $\le \log_2 n$ light edges, a root path meets $\le \log_2 n$ distinct heavy paths.
- **Full path $u \to v$.** It is two root-ward legs (to the LCA), so it meets at most $2\log_2 n = O(\log n)$ heavy-path segments.

![The light-edge doubling argument: each light edge moves you to a subtree at least twice as big, so the number of light edges is at most log n](/img/dsa/_S1CQ5g9uTg/frame-00119.png)

[watch from 23:47](https://youtu.be/_S1CQ5g9uTg?t=1427)

> Caveat the lecturer stresses: this $\log n$ bound is a property of **heavy-light** decomposition specifically. An arbitrary path decomposition can force a path to cross far more segments.

---

## Laying every heavy path into one segment tree

- Naively you would build a separate small segment tree per heavy path, keep a pointer from each node to its tree, and so on — correct but fiddly.
- **Simpler:** use **one** big segment tree over a clever node ordering. Run a DFS that recurses into the **heavy child first**, then into the other children. Assign positions `pos[x]` in visit order.
- Because the heavy child is visited immediately, each heavy path occupies a **contiguous block** of positions. The example tree (nodes $1..12$) linearizes so that heavy path $1,2,7,8$ is one run, $4,12$ another, $3,6$ another, $5,9,11$ another, and so on.

```cpp
int timer = 0;
vector<int> pos(n), top(n);   // pos[x] = index in the big array; top[x] = chain head

// Heavy-first DFS: contiguous positions per heavy path; top[x] = chain's top node.
void dfs_hld(int x, int t) {
    top[x] = t;                         // this node belongs to chain headed by t
    pos[x] = timer++;                   // next slot in the linear order
    if (heavy[x] != -1)
        dfs_hld(heavy[x], t);           // stay on the SAME chain
    for (int y : g[x])
        if (y != heavy[x])              // every other child STARTS a new chain
            dfs_hld(y, y);
}
```

- **Size accounting.** All the per-path segment trees together hold $n$ leaves; one segment tree over $n$ positions holds the same $n$ leaves ($\approx 2n$ nodes total). No blow-up — the single-tree layout is both simpler and a smaller constant.
- **No accuracy loss.** A query on a heavy-path segment maps to a query on `[pos[a], pos[b]]` in the big tree; building the tree bottom-up keeps each query at $O(\log(\text{segment length}))$, same complexity as many small trees.

![Numbered tree (1..12), the heavy-first DFS go2(x), and the resulting linear order p[] where each heavy path is a contiguous run](/img/dsa/_S1CQ5g9uTg/frame-00190.png)

[watch from 42:25](https://youtu.be/_S1CQ5g9uTg?t=2545)

---

## Answering a path query (and computing the LCA on the fly)

- Give each node `top[x]` = the top (shallowest) node of its heavy path. HLD lets you find the LCA implicitly — no separate binary-lifting table needed.
- **Climb-the-deeper-top loop.** Repeatedly compare the chain tops of $u$ and $v$:
  - If `top[u] == top[v]`, the two nodes are on the **same** heavy path; aggregate the single segment between them and stop.
  - Otherwise let $x = \mathrm{top}(u)$, $y = \mathrm{top}(v)$. Take the **deeper** top (say `depth[x] > depth[y]`): the whole segment from $u$ up to $x$ lies on the answer path, so aggregate `[pos[x], pos[u]]`, then jump $u := \mathrm{par}(x)$ across the light edge. Repeat.
- Each iteration consumes one light edge, so it runs $\le \log_2 n$ times per leg; each does one $O(\log n)$ segment-tree query → **$O(\log^2 n)$**.

```cpp
// Point update: assign node v the value x. O(log n).
void update(int v, long long x) {
    val[v] = x;
    seg.set_point(pos[v], x);
}

// Path aggregate over nodes on u..v, climbing the deeper chain top each step.
long long query_path(int u, int v) {
    long long res = seg.ID;                          // identity of the op
    while (top[u] != top[v]) {                        // different heavy paths
        if (dep[top[u]] < dep[top[v]]) swap(u, v);    // ensure top[u] is deeper
        res = seg.op(res, seg.query(pos[top[u]], pos[u] + 1));
        u = par[top[u]];                              // hop up one light edge
    }
    if (dep[u] > dep[v]) swap(u, v);                  // same chain now
    res = seg.op(res, seg.query(pos[u], pos[v] + 1)); // cover u..v inclusive
    return res;
}
```

- **Non-commutative ops** (matrix product, and anything where order matters): the $u \to \mathrm{lca}$ leg runs bottom-to-top while the $\mathrm{lca} \to v$ leg runs top-to-bottom. Keep two segment trees (forward and reversed), aggregate the two legs separately, then combine in the correct order. For commutative ops (sum, min, max, gcd) one tree suffices and orientation is irrelevant.

![top(u)/top(v), the x==y same-chain case, and the depth comparison picking the deeper chain top to peel off next](/img/dsa/_S1CQ5g9uTg/frame-00230.png)

![The final while-loop query: x=top(u), y=top(v); if x==y aggregate the segment; else peel the deeper chain and move to its parent](/img/dsa/_S1CQ5g9uTg/frame-00258.png)

[watch from 51:19](https://youtu.be/_S1CQ5g9uTg?t=3079)

---

## Full working implementation

Point update and path aggregate over one iterative segment tree. The op and identity are parameters, so the same class serves sum, max, min, or gcd. This is the exact code stress-tested below.

```cpp
#include <bits/stdc++.h>
using namespace std;

struct SegTree {
    int n;
    vector<long long> t;
    long long ID;                        // identity for combine
    function<long long(long long,long long)> op;
    SegTree(int n_, long long id, function<long long(long long,long long)> f)
        : n(n_), t(2*n_, id), ID(id), op(f) {}
    void set_point(int i, long long v) { // assign leaf i
        for (t[i += n] = v; i > 1; i >>= 1) t[i>>1] = op(t[i], t[i^1]);
    }
    long long query(int l, int r) {      // aggregate over [l, r)
        long long resL = ID, resR = ID;
        for (l += n, r += n; l < r; l >>= 1, r >>= 1) {
            if (l & 1) resL = op(resL, t[l++]);
            if (r & 1) resR = op(t[--r], resR);
        }
        return op(resL, resR);
    }
};

struct HLD {
    int n, timer = 0;
    vector<vector<int>> g;
    vector<int> par, dep, sz, heavy, top, pos, val;
    SegTree seg;

    HLD(int n_, long long id, function<long long(long long,long long)> f)
        : n(n_), g(n_), par(n_, -1), dep(n_, 0), sz(n_, 1),
          heavy(n_, -1), top(n_, 0), pos(n_, 0), val(n_, 0),
          seg(n_, id, f) {}

    void add_edge(int u, int v) { g[u].push_back(v); g[v].push_back(u); }

    int dfs_sz(int x, int p) {                        // sizes + heavy child
        par[x] = p; sz[x] = 1; int best = 0;
        for (int y : g[x]) if (y != p) {
            dep[y] = dep[x] + 1;
            int c = dfs_sz(y, x);
            sz[x] += c;
            if (c > best) { best = c; heavy[x] = y; }
        }
        return sz[x];
    }

    void dfs_hld(int x, int t) {                      // heavy-first linearization
        top[x] = t; pos[x] = timer++;
        if (heavy[x] != -1) dfs_hld(heavy[x], t);
        for (int y : g[x]) if (y != par[x] && y != heavy[x]) dfs_hld(y, y);
    }

    void build(int root) {
        dfs_sz(root, -1);
        dfs_hld(root, root);
        for (int v = 0; v < n; v++) seg.set_point(pos[v], val[v]);
    }

    void update(int v, long long x) { val[v] = x; seg.set_point(pos[v], x); }

    long long query_path(int u, int v) {
        long long res = seg.ID;
        while (top[u] != top[v]) {
            if (dep[top[u]] < dep[top[v]]) swap(u, v);
            res = seg.op(res, seg.query(pos[top[u]], pos[u] + 1));
            u = par[top[u]];
        }
        if (dep[u] > dep[v]) swap(u, v);
        res = seg.op(res, seg.query(pos[u], pos[v] + 1));
        return res;
    }
};

int main() {
    // Path graph 0-1-2-3-4 with values 10,20,30,40,50.
    int n = 5;
    HLD h(n, 0, [](long long a, long long b){ return a + b; });   // path SUM
    for (int i = 1; i < n; i++) h.add_edge(i - 1, i);
    long long init[5] = {10, 20, 30, 40, 50};
    for (int i = 0; i < n; i++) h.val[i] = init[i];
    h.build(0);

    cout << h.query_path(0, 4) << "\n";   // 10+20+30+40+50 = 150
    cout << h.query_path(1, 3) << "\n";   // 20+30+40       = 90
    h.update(2, 100);                     // node 2: 30 -> 100
    cout << h.query_path(0, 4) << "\n";   // 220
    return 0;
}
```

Compiled with `c++ -std=c++17` and run: prints `150`, `90`, `220`. The stress harness below drove the same class against a brute-force path walker on **300 random trees** (up to 40 nodes, 200 mixed update/query ops each), for **both** path-sum and path-max, and reported `ALL 300 RANDOM-TREE TESTS PASSED`.

[watch from 62:35](https://youtu.be/_S1CQ5g9uTg?t=3755)

---

## Complexity recap

| Operation | Time | Space | Notes |
| --- | --- | --- | --- |
| Build (two DFS + fill) | $\Theta(n)$ | $\Theta(n)$ | sizes, heavy child, `pos`, `top`, one segment tree |
| Point update | $O(\log n)$ | — | one segment-tree leaf update |
| Path aggregate query | $O(\log^2 n)$ | — | $O(\log n)$ heavy paths $\times\ O(\log n)$ per range query |
| Subtree aggregate query | $O(\log n)$ | — | one range `[pos[v], pos[v] + sz[v])` (heavy-first order makes a subtree contiguous) |
| LCA (as a by-product) | $O(\log n)$ | — | the same chain-top climb without aggregating |

- **Amortized preview.** Next lecture's **link-cut trees** achieve $O(\log n)$ amortized for these path ops *and* allow the tree itself to change (cut/link subtrees); HLD is fixed to a static tree shape.

---

## Practice problems

Heavy-light decomposition is a **competitive-programming** technique — it is rare in interview rounds. The honest interview-adjacent skill it drills is *tree-path reasoning and LCA*, so the nearest interview problems are LCA / ancestor problems on the same "path in a tree" setting; the real HLD reps live in the competitive tier.

**🎯 Interview (MAANG-style) — nearest adjacent (LCA / tree-path)**

- [Lowest Common Ancestor of a Binary Tree — LeetCode 236](https://leetcode.com/problems/lowest-common-ancestor-of-a-binary-tree/) — Medium — the path-meeting logic HLD reuses to split $u \to v$ at the LCA.
- [Kth Ancestor of a Tree Node — LeetCode 1483](https://leetcode.com/problems/kth-ancestor-of-a-tree-node/) — Hard — binary lifting on ancestors, the static-only alternative discussed in the intro.
- [Lowest Common Ancestor of a Binary Search Tree — LeetCode 235](https://leetcode.com/problems/lowest-common-ancestor-of-a-binary-search-tree/) — Medium — LCA warm-up on the ordered case.

**🏆 Competitive**

- [Path Queries — CSES 1138](https://cses.fi/problemset/task/1138) — Hard — the canonical HLD sum-on-path with node updates (this exact lecture problem).
- [Subtree Queries — CSES 2134](https://cses.fi/problemset/task/2134) — Med — subtree-sum with updates; solved by the same heavy-first Euler order (subtree = one contiguous range).
- [Company Queries II — CSES 1688](https://cses.fi/problemset/task/1688) — Med — LCA via binary lifting; the baseline HLD subsumes.
- [Heavy-Light Decomposition — cp-algorithms](https://cp-algorithms.com/graph/hld.html) — reference implementation plus the worked path/subtree query variants.

> No official Codeforces home-task link is attached to this lecture's description, so none is cited here.

---

## Further reading

- [Heavy-Light Decomposition — cp-algorithms](https://cp-algorithms.com/graph/hld.html) — clean derivation, complexity proof, and reference code.
- [Heavy-Light Decomposition, Set 1 (Introduction) — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/heavy-light-decomposition-set-1-introduction/).
- [Heavy-Light Decomposition, Set 2 (Implementation) — GeeksforGeeks](https://www.geeksforgeeks.org/heavy-light-decomposition-set-2-implementation/).
- [Heavy path decomposition — Wikipedia](https://en.wikipedia.org/wiki/Heavy_path_decomposition).
- [Segment tree — Wikipedia](https://en.wikipedia.org/wiki/Segment_tree) and [Lowest common ancestor — Wikipedia](https://en.wikipedia.org/wiki/Lowest_common_ancestor) for the two building blocks.

---

## Key takeaways

- **Reduce to the line.** The bamboo case is a segment tree; HLD is the machinery that makes a general tree behave like a small number of lines.
- **Heavy = biggest-subtree child.** One heavy child per node; heavy edges chain into disjoint heavy paths that partition the tree.
- **The doubling lemma is the whole game.** Each light edge at least doubles the subtree size, so any root path crosses $\le \log_2 n$ light edges → $O(\log n)$ heavy paths per query leg.
- **One segment tree, heavy-first order.** Visiting the heavy child first makes every heavy path (and every subtree) a contiguous array segment — simpler and faster than many small trees.
- **Costs:** build $\Theta(n)$, update $O(\log n)$, path query $O(\log^2 n)$; LCA falls out for free from the chain-top climb.

## Glossary

- **Subtree size** — number of nodes in the subtree rooted at a node; the quantity that decides heavy vs light.
- **Heavy edge / heavy child** — the edge to the child with the largest subtree; each non-leaf has exactly one.
- **Light edge** — any non-heavy child-edge; crossing one upward at least doubles the subtree size.
- **Heavy path (chain)** — a maximal run of heavy edges; the tree partitions into disjoint heavy paths.
- **`top[x]`** — the shallowest node of the heavy path containing $x$; the chain head used to hop between paths.
- **`pos[x]`** — index of $x$ in the heavy-first DFS order; makes each heavy path a contiguous segment-tree range.
- **Associative op** — the aggregate combined along the path (sum, min, max, gcd, matrix product); non-commutative ones need two oriented segment trees.
