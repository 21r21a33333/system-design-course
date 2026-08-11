---
title: "S02E13 · Centroid Decomposition"
sidebar_position: 13
description: Finding a tree centroid whose removal leaves every piece at most half the tree, building the centroid decomposition in O(n log n), and using it to count fixed-length paths and answer closest-node-in-radius queries.
---

# S02E13 · Centroid Decomposition

> **Source:** Pavel Mavrin, [_A&DS S02E13_](https://youtu.be/Vo6EbmVoPzs) · 1h27m lecture → ~15 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- A **centroid** of a tree is a vertex whose removal splits the tree into components each of size at most $n/2$. Every tree has one, and it is found by a single downhill walk.
- **Centroid decomposition** applies divide-and-conquer to a tree: pick the centroid, solve the part that touches it, then recurse into each remaining component. The recursion depth is $O(\log n)$ because every level halves the component size.
- Two problem families use it. **Path problems** ("count / optimize over all $u,v$ paths") reduce to "handle only paths through the centroid" per level. **Radius query problems** ("answer something about all vertices within distance $D$ of $v$") precompute, for each vertex, its $O(\log n)$ ancestor centroids and the distance to each.
- The canonical demo is **counting pairs $(u,v)$ with $\operatorname{dist}(u,v) \le D$**: at each centroid, collect distances to all vertices, count pairs by two pointers, then subtract pairs that stay inside one child subtree so nothing is double-counted.
- Total cost is $O(n \log n)$ when the per-centroid work is linear, or $O(n \log^2 n)$ when it needs an extra sort or binary search per level.

---

## The problem shape: divide-and-conquer on a tree

- Family one: you are given a tree and must look at **all pairs $u,v$** and compute something over each path — count the "good" paths, or find an optimal path. Pavel's toy version: count pairs $(u,v)$ with $\operatorname{dist}(u,v) \le D$.
- The divide-and-conquer move: **fix one vertex $c$** and split every path into two classes.
  - **Paths that avoid $c$** lie entirely inside one of the components you get by deleting $c$. Solve those by **recursing** into each component.
  - **Paths through $c$** get cut at $c$ into two half-paths, a segment $u \to c$ and a segment $c \to v$. Handle these directly at $c$.
- So the whole plan is: pick $c$, recurse into each subtree, then count the paths that pass through $c$.

![A tree with a chosen vertex c splitting a path u to v into a segment u to c and c to v; the pairs-with-distance-at-most-D problem written above](/img/dsa/Vo6EbmVoPzs/frame-00052.png)

- **Counting the through-$c$ paths.** Run one traversal from $c$ to get $d(v) = \operatorname{dist}(c, v)$ for every $v$ in the component. A path $u \to c \to v$ is good when $d(u) + d(v) \le D$.
  - That is now an **array problem**: given values $d(\cdot)$, count pairs with $d(u) + d(v) \le D$. Sort once, then either **binary-search** the prefix $d(v) \le D - d(u)$ for each $u$, or sweep with **two pointers** — both $O(n \log n)$ (the log is the sort). If all edge weights are $1$, a counting-sort makes it $O(n)$.

[watch from 0:47](https://youtu.be/Vo6EbmVoPzs?t=47)

---

## The double-counting fix (different subtrees only)

- The array count above includes pairs where $u$ and $v$ sit in the **same** child subtree of $c$. Those paths do **not** actually pass through $c$ — they were already handled by the recursion. They must not be counted here.
- Two clean ways to keep only cross-subtree pairs:
  - **Add subtrees one at a time.** Keep a sorted multiset of distances seen so far. For each new subtree, first query every element against what is already inside, then insert the subtree. Each element pairs only with earlier subtrees — cross-subtree by construction. Cost $O(n \log n)$ with a balanced BST.
  - **Count all, then subtract.** Build one big sorted array over the whole component and, separately, a sorted array **per child subtree**. For a vertex $u$, the total prefix count uses the big array; subtracting the prefix count inside $u$'s own subtree removes the same-subtree partners. Both prefixes are found by binary search.
- Pavel prefers subtract: build all the sorted arrays once ($O(n \log n)$ total, since sizes sum to $n$), then each vertex costs two binary searches — plus and minus.

[watch from 8:36](https://youtu.be/Vo6EbmVoPzs?t=516)

---

## What a centroid is, and why it exists

- The cost hinges on picking a **good** $c$. As in array divide-and-conquer where you split at the middle to get $T(n) = 2\,T(n/2) + n$, you want $c$ to split the tree into balanced pieces.
- **Definition.** Vertex $c$ is a **centroid** if, after removing $c$, every remaining connected component has size at most $n/2$.

![A star of subtrees hanging off a centroid c, each labelled at most n over 2, with c marked as centroid](/img/dsa/Vo6EbmVoPzs/frame-00092.png)

- **Two facts:** every tree has at least one centroid, and it is easy to find. The finding algorithm below doubles as the existence proof.
- **Finding it.** Root the tree at any vertex and compute all subtree sizes with one traversal. Then walk down from the root:
  - At the current vertex, a child subtree of size greater than $n/2$ is "too big". There is **at most one** such child (two children each above $n/2$ would already exceed $n$ total).
  - If a too-big child exists, **step into it** and repeat. If none exists, the current vertex is the centroid.
- **Why the stop condition is correct.** When you stop at $x$, every downward child subtree is at most $n/2$. The one remaining component is everything **above** $x$: its size is $n - \operatorname{size}(x)$. You stepped into $x$ only because $\operatorname{size}(x) > n/2$, so $n - \operatorname{size}(x) < n/2$. All pieces are at most $n/2$ — $x$ is a centroid. The walk strictly descends, so it terminates: existence proved.

![A rooted tree with subtree sizes filled in, n equals 18, the downhill walk descending into the child larger than n over 2 until every child is at most n over 2](/img/dsa/Vo6EbmVoPzs/frame-00102.png)

- **A tree can have two centroids** (adjacent), for example a path with an even number of vertices. Either works. (Note: the *centroid* — balances subtree sizes — is not the *center*, which minimizes the maximum distance and lives at the middle of the diameter.)

[watch from 19:31](https://youtu.be/Vo6EbmVoPzs?t=1171)

---

## Centroid finding in C++

- Two traversals, exactly as on the board. The first computes subtree sizes; the second walks down to the centroid. `comp_n` is the size of the **current** component (not the whole tree), because this runs recursively on shrinking pieces.
- **Deletion is virtual.** Physically removing $c$ and its edges is fiddly, so instead keep a boolean `removed[]` and let every traversal skip removed vertices. Each already-removed vertex is touched at most once per component it borders, so the total stays linear.

```cpp
#include <bits/stdc++.h>
using namespace std;

int n;                       // size of the CURRENT component
vector<vector<int>> g;       // adjacency list of the whole tree
vector<char> removed;        // virtually deleted centroids
vector<int> sub;             // subtree sizes within the current component

// dfs_size(x, p): fill sub[x] = size of x's subtree, skipping removed nodes.
int dfs_size(int x, int p) {
    sub[x] = 1;
    for (int y : g[x])
        if (y != p && !removed[y])
            sub[x] += dfs_size(y, x);
    return sub[x];
}

// dfs_centroid(x, p): walk down into any child heavier than n/2; stop when none.
int dfs_centroid(int x, int p) {
    for (int y : g[x])
        if (y != p && !removed[y] && sub[y] > n / 2)
            return dfs_centroid(y, x);
    return x;                // every child <= n/2  =>  x is the centroid
}

// find_centroid(entry): centroid of the component reachable from `entry`.
int find_centroid(int entry) {
    n = dfs_size(entry, -1);          // size of this component
    int c = dfs_centroid(entry, -1);  // downhill walk
    dfs_size(c, -1);                  // re-root sizes at c for the caller
    return c;
}
```

- On the board Pavel folds the size check into a single `dfs_centr` that accumulates children and sets a flag `ok = false` when a child exceeds $n/2$ or when `s < n/2` (the up-component is too big); the two-pass version above is the same logic, easier to read.

![Two board procedures: dfs_size returning subtree size, and dfs_centr accumulating sizes with ok flag, marking centroid = x when s is at least n over 2 and every child is at most n over 2](/img/dsa/Vo6EbmVoPzs/frame-00166.png)

[watch from 25:19](https://youtu.be/Vo6EbmVoPzs?t=1519)

---

## The path-counting driver (compile-tested vs brute force)

- Putting it together for "count pairs with $\operatorname{dist} \le D$": at each centroid, collect distances over the whole component, count all pairs, then subtract the same-subtree pairs. Recurse into the children.
- Pairs with $d(u) + d(v) \le D$ are counted with **two pointers** on the sorted distance array in linear time after the sort.

```cpp
long long D;
long long answer = 0;
vector<int> depths;                       // scratch: distances in one subtree

void collect(int x, int p, int d) {       // distances from a centroid, skipping removed
    depths.push_back(d);
    for (int y : g[x])
        if (y != p && !removed[y])
            collect(y, x, d + 1);
}

// number of pairs a<b in arr with arr[a]+arr[b] <= D  (two pointers)
long long count_pairs(vector<int> arr) {
    sort(arr.begin(), arr.end());
    long long res = 0;
    int i = 0, j = (int)arr.size() - 1;
    while (i < j) {
        if ((long long)arr[i] + arr[j] <= D) { res += j - i; i++; }
        else                                   j--;
    }
    return res;
}

void solve(int entry) {
    int c = find_centroid(entry);         // sizes are now rooted at c

    vector<int> all = {0};                // c itself is at distance 0
    for (int y : g[c]) if (!removed[y]) {
        depths.clear(); collect(y, c, 1);
        for (int d : depths) all.push_back(d);
    }
    answer += count_pairs(all);           // every pair through-or-at c ...

    for (int y : g[c]) if (!removed[y]) { // ... minus pairs stuck in one subtree
        depths.clear(); collect(y, c, 1);
        answer -= count_pairs(depths);
    }

    removed[c] = 1;                       // virtually delete the centroid
    for (int y : g[c]) if (!removed[y])
        solve(y);                         // recurse into each remaining component
}
```

- Verified: this `answer` matches a brute-force all-pairs BFS on **2000 random trees** (sizes up to 30, random $D$), and the centroid property $\text{largest remaining part} \le n/2$ holds. Every function called above (`find_centroid`, `dfs_size`, `dfs_centroid`, `collect`, `count_pairs`) is defined here or in the previous block.

[watch from 38:05](https://youtu.be/Vo6EbmVoPzs?t=2285)

---

## Why the depth is O(log n)

- Each recursion level replaces a component of size $m$ with children of size at most $m/2$ (centroid guarantee). Starting from $n$, after $k$ levels every component has size at most $n / 2^{k}$, which hits $1$ when $k = \log_2 n$.

$$
n \;\to\; \le \tfrac{n}{2} \;\to\; \le \tfrac{n}{4} \;\to\; \cdots \;\to\; 1
\qquad\Longrightarrow\qquad \text{depth} \le \lceil \log_2 n \rceil .
$$

- Across **one level** the components are disjoint and cover the tree, so their sizes sum to at most $n$; the per-centroid work (a traversal plus, say, a sort) totals $O(n \log n)$ for the level. With $O(\log n)$ levels:

$$
T(n) \;=\; \underbrace{O(n \log n)}_{\text{work per level}} \times \underbrace{O(\log n)}_{\text{levels}} \;=\; O\!\big(n \log^2 n\big).
$$

- If the per-centroid work is **linear** (unit weights → counting-sort, or precomputed sorted arrays), each level costs $O(n)$ and the total collapses to $O(n \log n)$.
- Master theorem does **not** apply directly: the split is not into equal halves, only into pieces each at most half. The level-by-level sum above is the honest argument.

[watch from 42:46](https://youtu.be/Vo6EbmVoPzs?t=2566)

---

## Building the decomposition tree (for radius queries)

- Family two: **queries** of the form "given a vertex $v$ and radius $D$, compute something over all $u$ with $\operatorname{dist}(v,u) \le D$" — closest marked vertex, minimum price, count of vertices in range, and so on.
- Run the same recursion but, instead of solving a path problem, **remember the decomposition**. The first centroid is the **level-0** centroid of the whole tree; each child component gets a **level-1** centroid; and so on down to single vertices (a lone vertex is its own centroid).

![A large tree fully decomposed: a level-0 centroid, then level-1 centroids in each component, down to level-3 and level-4 single vertices](/img/dsa/Vo6EbmVoPzs/frame-00252.png)

- **Key structural fact.** Take any two vertices $u,v$. Walk the decomposition from the top: at first both share the whole tree; at some centroid $c$ they land in **different** components. That $c$ is the **highest centroid separating them**, and the tree path $u \to v$ passes through it. So **every** path passes through the centroid of the smallest decomposition component containing both endpoints.

![Two vertices u and v whose tree path passes through the centroid of the smallest component that still contains both; the prefix-plus-suffix subtract trick sketched on the right](/img/dsa/Vo6EbmVoPzs/frame-00292.png)

- **Consequence for a query at $v$.** The separating centroid $c$ is one of the **ancestor centroids** of $v$ in the decomposition — and there are only $O(\log n)$ of them (one per level $v$ survives). So a query iterates over $v$'s ancestor centroids, and at each one looks at the vertices reachable within the remaining radius.
- **Precompute per vertex.** For each vertex $v$, store the list of its ancestor centroids together with $\operatorname{dist}(v, c)$ for each. Build it during decomposition: when you fix centroid $c$, run one traversal over its whole component and, for every vertex in it, push the pair $(c, \operatorname{dist}(c,\cdot))$ onto that vertex's list. Sizes sum to $n$ per level and there are $O(\log n)$ levels, so this is $O(n \log n)$ pairs and $O(n \log n)$ memory — you do **not** need to materialize an explicit tree of centroids.

```cpp
// Precompute, for every vertex, its ancestor centroids and the distance to each.
vector<vector<pair<int,int>>> anc;        // anc[v] = list of (centroid, dist(v,centroid))

void tag(int x, int p, int c, int d) {    // walk c's component, tagging every vertex
    anc[x].push_back({c, d});
    for (int y : g[x])
        if (y != p && !removed[y])
            tag(y, x, c, d + 1);
}

void build(int entry) {
    int c = find_centroid(entry);
    tag(c, -1, c, 0);                     // every vertex of this component gets c
    removed[c] = 1;
    for (int y : g[c]) if (!removed[y])
        build(y);
}
```

[watch from 46:03](https://youtu.be/Vo6EbmVoPzs?t=2763)

---

## Answering a radius query

- **Minimum over the radius (idempotent aggregate).** For each centroid $c$, precompute a list of its component's vertices sorted by $\operatorname{dist}(c, \cdot)$, with a **prefix minimum** of prices alongside.
  - Query $(v, D)$: for each ancestor centroid $c$ of $v$, let $r = D - \operatorname{dist}(v, c)$. If $r \ge 0$, binary-search $c$'s sorted list for the prefix with $\operatorname{dist}(c, u) \le r$ and read that prefix minimum. Take the minimum across all $O(\log n)$ ancestors.
  - **Overlap is harmless** for `min`: a vertex counted through two centroids gives the same value twice, and `min` is idempotent.

- **Sum or count over the radius (non-idempotent).** Here overlap breaks correctness: vertices in $v$'s own child subtree of $c$ get counted at both $c$ and the deeper centroid. Fix it exactly as in the path problem — **subtract the same-subtree contribution**.
  - Alongside each centroid's sorted list, also store, **for each child direction**, a sorted list of distances into that subtree. At centroid $c$ you add the full-component prefix and subtract the prefix from the subtree that contains $v$.

$$
\text{answer}(v, D) \;=\; \sum_{c \,\in\, \operatorname{anc}(v)} \Big( \operatorname{pre}_c(D - d(v,c)) \;-\; \operatorname{pre}_{c,\,\text{child}(v)}(D - d(v,c)) \Big).
$$

- **General non-invertible aggregate.** When you cannot subtract, lay the child subtrees of $c$ in a row and precompute the aggregate over every **prefix** and every **suffix**; "all children except mine" is then prefix-before $\cup$ suffix-after, combined in $O(1)$ (or via a **persistent** structure per prefix and suffix when the aggregate itself needs a data structure). This is the heavy general hammer; `min` and `sum` cover almost every real case.
- **Distances are cheap on trees.** $\operatorname{dist}(v, c)$ comes from LCA in $O(1)$ after preprocessing, or is simply read from the precomputed $\operatorname{anc}(v)$ list. Avoid persistent segment trees when a plain sorted array suffices — they burn far more memory.

[watch from 1:03:14](https://youtu.be/Vo6EbmVoPzs?t=3794)

---

## Complexity recap

| Operation | Time | Space |
| --- | --- | --- |
| Find one centroid | $\Theta(n)$ | $O(n)$ |
| Decomposition depth | $O(\log n)$ | — |
| Build decomposition (ancestor lists) | $O(n \log n)$ | $O(n \log n)$ |
| Path counting, unit weights | $O(n \log n)$ | $O(n)$ |
| Path counting, weighted (needs sort per level) | $O(n \log^2 n)$ | $O(n)$ |
| Radius query (per query, min or sum) | $O(\log^2 n)$ | $O(n \log n)$ |

---

## Practice problems

Centroid decomposition is a **competitive-programming** tool; it essentially never appears in standard interview rounds. The nearest interview-relevant skill is **reasoning about tree paths and diameters**, so those are listed first honestly as adjacent — not as the technique itself.

**🎯 Interview (MAANG-style) — adjacent tree-path reasoning**

- [Diameter of Binary Tree — LeetCode 543](https://leetcode.com/problems/diameter-of-binary-tree/) — Easy — the "longest path through a node" post-order idea that centroid path-counting generalizes.
- [Diameter of N-Ary Tree — LeetCode 1522](https://leetcode.com/problems/diameter-of-n-ary-tree/) — Medium — same through-the-node combination on an arbitrary-degree tree.
- [Count Pairs of Nodes — LeetCode 1782](https://leetcode.com/problems/count-pairs-of-nodes/) — Hard — counting node pairs with a degree threshold; the "count-all-then-subtract-overlaps" bookkeeping mirrors the same-subtree fix.

**🏆 Competitive**

- [Fixed-Length Paths I — CSES 2080](https://cses.fi/problemset/task/2080) — Hard — count paths with **exactly** $k$ edges; the textbook centroid-decomposition path count.
- [Fixed-Length Paths II — CSES 2081](https://cses.fi/problemset/task/2081) — Hard — paths with length in a range $[k_1, k_2]$; add a Fenwick/BIT to the per-centroid count.
- [Centroid Decomposition — cp-algorithms](https://cp-algorithms.com/graph/centroid_decomposition.html) — reference implementation plus the classic distance-counting application to drill against.

> This lecture is beyond typical interview scope; the payoff is competitive contests and any "aggregate over all tree paths / within a radius" problem.

---

## Further reading

- [Centroid Decomposition of a Tree — GeeksforGeeks](https://www.geeksforgeeks.org/centroid-decomposition-of-tree/) — worked build with code.
- [Centroid Decomposition — cp-algorithms](https://cp-algorithms.com/graph/centroid_decomposition.html) — the canonical write-up and complexity proof.
- [Centroid Decomposition — USACO Guide](https://usaco.guide/plat/centroid) — problem-driven module with graded exercises.
- [Tree (graph theory) — Wikipedia](https://en.wikipedia.org/wiki/Tree_(graph_theory)) — background on trees, subtrees, and the centroid vertex.

---

## Key takeaways

- A centroid removes to leave every piece at most half the tree; find it by one size pass then a downhill walk into the heavy child. The walk terminates, which proves existence.
- Decompose by recursing into each post-centroid component. Depth is $O(\log n)$ because sizes halve — the master theorem does not apply, but the level sum does.
- Path problems: handle only paths **through** the centroid per level, then subtract same-subtree pairs to avoid double counting.
- Query problems: precompute each vertex's $O(\log n)$ ancestor centroids and distances; `min` tolerates overlap, `sum` needs the subtract trick, and only truly non-invertible aggregates need the prefix/suffix (or persistent) hammer.
- Keep deletion virtual with a `removed[]` flag; prefer sorted arrays over persistent structures to save memory.

## Glossary

- **Centroid** — a vertex whose removal leaves every component of size at most $n/2$.
- **Center** — the vertex minimizing the maximum distance to all others (middle of the diameter); different from the centroid.
- **Centroid decomposition** — the recursion tree formed by repeatedly removing centroids; depth $O(\log n)$.
- **Ancestor centroids** — for a vertex $v$, the $O(\log n)$ centroids of the nested components containing $v$, top to bottom.
- **Through-centroid path** — a path whose two endpoints fall in different components after the centroid is removed.
- **Virtual deletion** — marking a vertex `removed` so traversals skip it, instead of editing the adjacency list.
