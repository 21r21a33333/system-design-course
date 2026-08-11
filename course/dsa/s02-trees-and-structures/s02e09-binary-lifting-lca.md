---
title: "S02E09 · Binary Lifting, LCA & Farach-Colton–Bender"
sidebar_position: 9
description: Rooted trees and the lowest-common-ancestor query solved three ways — binary lifting in O(n log n) build with O(log n) queries, the Euler-tour plus RMQ reduction, and the Farach-Colton–Bender O(n) build with O(1) queries on the plus-minus-one array.
---

# S02E09 · Binary Lifting, LCA & Farach-Colton–Bender

> **Source:** Pavel Mavrin, [_A&DS S02E09_](https://youtu.be/X5pp8L_lypw) · 1h32m lecture → ~16 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- A **rooted tree** is any tree with one chosen root and edges oriented away from it; the headline query is the **lowest common ancestor** $\mathrm{LCA}(u,v)$ — the deepest node that is an ancestor of both.
- LCA is the key to **path queries**: every $u\to v$ path climbs to $w = \mathrm{LCA}(u,v)$ then descends, so $\mathrm{dist}(u,v) = d(u) + d(v) - 2\,d(w)$.
- **Binary lifting** precomputes $\text{up}[k][v] =$ the $2^k$-th ancestor of $v$ in $O(n \log n)$, then answers $k$-th-ancestor and LCA in $O(\log n)$ by splitting the climb into powers of two.
- **Euler-tour reduction:** flatten the tree by a DFS walk, record depths — LCA becomes a **range-minimum query** on that plus-minus-one depth array. Plug in a segment tree ($O(n)$ / $O(\log n)$) or a sparse table ($O(n\log n)$ / $O(1)$).
- **Farach-Colton–Bender** upgrades the sparse-table route to $O(n)$ build, $O(1)$ query by exploiting that consecutive depths differ by exactly $\pm 1$: split into blocks of size $\tfrac12 \log n$, sparse-table the block minima, and precompute every one of the $\sqrt n$ distinct block types.

---

## Rooted trees and why LCA matters

- A **tree** is an undirected graph with no cycles. A **rooted tree** additionally fixes one vertex as the root and orients every edge away from it, giving parent/child/leaf structure.
- To **root an unrooted tree**: pick any vertex, declare it the root, and orient all edges outward by a DFS. Each neighbor becomes a child; recurse into each subtree.
- Rooted trees model hierarchies everywhere — file-system directories, version-control history, org charts.
- Unlike a binary tree, a node may have **any number of children**.

![Unrooted tree on the left rooted at vertex one on the right, with LCA of two marked nodes shown below](/img/dsa/X5pp8L_lypw/frame-00034.png)

- The **lowest common ancestor** of $u$ and $v$: list every ancestor of $u$ and every ancestor of $v$; the common ancestors always form a chain, and its **deepest** element is $\mathrm{LCA}(u,v)$.
- **Why it is central — path structure.** Any path from $u$ to $v$ first goes **up** to $w = \mathrm{LCA}(u,v)$, then **down** to $v$. Split any path at $w$ into two root-ward segments and reason about each half.
- **Distance in a tree.** With $d(x)$ the depth (edges from root to $x$):

$$
\mathrm{dist}(u,v) = \big(d(u) - d(w)\big) + \big(d(v) - d(w)\big) = d(u) + d(v) - 2\,d(w),\quad w = \mathrm{LCA}(u,v).
$$

![Path from u to v split at the LCA w, with the distance formula d of u plus d of v minus twice d of w](/img/dsa/X5pp8L_lypw/frame-00047.png)

[watch from 4:11](https://youtu.be/X5pp8L_lypw?t=251)

---

## Binary lifting: precompute the power-of-two ancestors

- **Goal:** move from a node toward the root **faster** than one parent-step at a time.
- **The table.** For each node $v$ and each $k$, store $\text{up}[k][v]$ = the ancestor $2^k$ steps above $v$. There are $n$ nodes and $k$ ranges up to $\log_2 n$, so the table has $O(n \log n)$ entries.
- **Handling the top.** If $v$ is closer to the root than $2^k$, either store a sentinel or — the trick used here — let the root **point to itself**, so over-climbing harmlessly parks you at the root.

![Binary lifting jumps from node v, each arrow doubling the distance two to the k, with the jump recurrence on the board](/img/dsa/X5pp8L_lypw/frame-00091.png)

- **Build, like a sparse table**, by increasing $k$. The base level $k=0$ is just the parent; each higher jump is **two half-jumps** already computed:

$$
\text{up}[k][v] = \text{up}[k-1]\big[\,\text{up}[k-1][v]\,\big].
$$

![Two jumps of size two-to-the-k-minus-one compose into one jump of size two-to-the-k, giving the doubling recurrence](/img/dsa/X5pp8L_lypw/frame-00113.png)

```cpp
#include <bits/stdc++.h>
using namespace std;

int LOG;                       // smallest value with 2^LOG >= n, plus one
vector<vector<int>> up;        // up[k][v] = 2^k-th ancestor of v (root loops to itself)
vector<int> depth;
vector<vector<int>> g;         // adjacency list of the (undirected) tree
int n;

void dfs(int v, int p) {
    up[0][v] = (p == -1 ? v : p);          // parent; root points to itself
    for (int to : g[v]) if (to != p) {
        depth[to] = depth[v] + 1;
        dfs(to, v);
    }
}

void build(int root) {
    depth.assign(n, 0);
    up.assign(LOG, vector<int>(n));
    dfs(root, -1);                          // fills up[0][*] and depths
    for (int k = 1; k < LOG; k++)
        for (int v = 0; v < n; v++)
            up[k][v] = up[k - 1][ up[k - 1][v] ];   // two half-jumps
}
```

- **Complexity:** the double loop is $n \times \log n$, so **precompute is $O(n \log n)$**.

[watch from 12:22](https://youtu.be/X5pp8L_lypw?t=742)

---

## Binary lifting: k-th ancestor and LCA queries

- **k-th ancestor.** Write the distance $d$ in binary; for every set bit $k$, take the jump $\text{up}[k]$. That is at most $\log n$ jumps, one per one-bit.

```cpp
int kth_ancestor(int v, int d) {
    if (d > depth[v]) d = depth[v];        // clamp: never climb past the root
    for (int k = 0; k < LOG; k++)
        if (d & (1 << k)) v = up[k][v];
    return v;
}
```

- **LCA in two phases:**
  1. **Level the two nodes.** Assume $u$ is the deeper one (swap if not). Climb $u$ up by $d(u) - d(v)$ using the same power-of-two decomposition, so both sit at the same depth. If they coincide, that node **is** the LCA (one was an ancestor of the other).
  2. **Binary-search the split.** From equal depth, walk powers of two from high to low: jump both nodes up by $2^k$ **only when the two targets still differ**. The invariant kept is "$u \ne v$"; you stop just below the LCA, so $\text{up}[0][u]$ is the answer.

![LCA query pseudocode — level the deeper node by jumps, then jump both up while ancestors differ; distance uses d of v minus d of u](/img/dsa/X5pp8L_lypw/frame-00152.png)

```cpp
int lca(int u, int v) {
    if (depth[u] < depth[v]) swap(u, v);       // u is deeper
    int d = depth[u] - depth[v];
    for (int k = 0; k < LOG; k++)              // phase 1: level u onto v's depth
        if (d & (1 << k)) u = up[k][u];
    if (u == v) return u;                       // v was an ancestor of u
    for (int k = LOG - 1; k >= 0; k--)          // phase 2: climb while different
        if (up[k][u] != up[k][v]) { u = up[k][u]; v = up[k][v]; }
    return up[0][u];                            // parent of the split = LCA
}
```

- **Driver to size `LOG` and use the table:**

```cpp
int main() {
    // read n and the tree into g, then:
    LOG = 1; while ((1 << LOG) < n) LOG++; LOG++;   // 2^LOG >= n, with slack
    build(0);
    // now lca(u, v) and kth_ancestor(v, d) run in O(log n) each
    return 0;
}
```

- **Verified:** on 2000 random trees (up to 40 nodes, 30 queries each), both `lca` and `kth_ancestor` matched a brute-force ancestor-walk oracle exactly.
- **Complexity:** each query does two $O(\log n)$ loops → **$O(\log n)$ per query**, after $O(n\log n)$ build.
- **Bonus:** because a query literally *traverses* the whole $u \to v$ path in big jumps, you can accumulate path aggregates (max edge, sum, and so on) into the same $\text{up}$ table.

[watch from 22:54](https://youtu.be/X5pp8L_lypw?t=1374)

---

## The Euler-tour reduction: LCA becomes range-minimum

- **Idea:** turn the tree into a linear array so the mountain of array data structures applies.
- **Euler tour.** DFS from the root; **append the current node every time you enter it and every time you return to it** after finishing a child. You traverse each edge exactly twice (down, then up), producing an array of length $2n - 1$.
- **First-occurrence index.** For each node $v$, remember **any** position `first[v]` where it appears in the tour (leftmost is convenient). Inner nodes appear multiple times; any occurrence works.
- **Depth array $h$.** Alongside the tour, record the depth of each visited node. Because every step moves to a parent or a child, **consecutive depths differ by exactly $\pm 1$** — a property Farach-Colton–Bender will exploit.

![Euler tour of the tree written as the node array with its depth array underneath; the LCA of two nodes is the minimum-depth entry between their positions](/img/dsa/X5pp8L_lypw/frame-00216.png)

- **The reduction.** Take the sub-array of the tour between `first[u]` and `first[v]`. It represents *some* walk from $u$ to $v$; that walk must pass through $\mathrm{LCA}(u,v)$, and the LCA is the **shallowest** node on it. So:

$$
\mathrm{LCA}(u,v) = \text{euler}\big[\,\arg\min_{\,\text{first}[u]\le i\le \text{first}[v]}\ h[i]\,\big].
$$

- **Why the shallowest is the LCA.** On the tour you only move up from a node after fully finishing its subtree, so once you climb above the LCA you never come back down between $u$ and $v$; hence the LCA is the unique minimum-depth entry in that window.
- Now any **range-minimum-query** structure over $h$ solves LCA:

```cpp
#include <bits/stdc++.h>
using namespace std;
int n; vector<vector<int>> g;
vector<int> euler, hd, first_;             // hd[i] = depth of euler[i]

void dfs(int v, int p, int d) {
    first_[v] = euler.size();
    euler.push_back(v); hd.push_back(d);
    for (int to : g[v]) if (to != p) {
        dfs(to, v, d + 1);
        euler.push_back(v); hd.push_back(d);   // re-visit v on the way up
    }
}

// --- sparse table over Euler indices, compared by depth hd[] ---
vector<vector<int>> sp; vector<int> lg;
int amin(int i, int j) { return hd[i] <= hd[j] ? i : j; }

void build_sparse() {
    int m = euler.size();
    lg.assign(m + 1, 0);
    for (int i = 2; i <= m; i++) lg[i] = lg[i / 2] + 1;
    int LG = lg[m] + 1;
    sp.assign(LG, vector<int>(m));
    for (int i = 0; i < m; i++) sp[0][i] = i;
    for (int k = 1; k < LG; k++)
        for (int i = 0; i + (1 << k) <= m; i++)
            sp[k][i] = amin(sp[k - 1][i], sp[k - 1][i + (1 << (k - 1))]);
}

int lca(int u, int v) {
    int l = first_[u], r = first_[v];
    if (l > r) swap(l, r);
    int k = lg[r - l + 1];
    return euler[ amin(sp[k][l], sp[k][r - (1 << k) + 1]) ];
}
```

- **Three RMQ choices, three trade-offs:**
  - **Segment tree** → build $O(n)$, query $O(\log n)$.
  - **Sparse table** → build $O(n \log n)$, query $O(1)$ (code above; verified on 1500 random trees).
  - **Farach-Colton–Bender** → build $O(n)$, query $O(1)$ (next section).

![Complexity summary on the board — binary lifting n log n build and log n query, Euler plus segment tree n build and log n query, Euler plus sparse table n log n build and constant query](/img/dsa/X5pp8L_lypw/frame-00265.png)

[watch from 40:58](https://youtu.be/X5pp8L_lypw?t=2458)

---

## Farach-Colton–Bender: O(n) build, O(1) query

The sparse-table route is $O(1)$ per query but pays $O(n\log n)$ to build. FCB removes that last logarithm by **block decomposition** plus a **precomputed table of block types**, using the $\pm 1$ structure of $h$.

**Step 1 — split into blocks of size $b$.** Let $b = \tfrac12 \log_2 n$. There are $n/b$ blocks.

**Step 2 — sparse table over block minima.** Take the minimum of each block into a small array of length $n/b$ and build a sparse table on it. Its size is $\tfrac{n}{b}\log\tfrac{n}{b}$, which is $O(n)$ when $b \approx \log n$. This answers any query made of **whole blocks** in $O(1)$.

![Block decomposition of the depth array — minimum of each block forms a small array, sparse-tabled; the query splits into two partial end blocks plus a middle of whole blocks](/img/dsa/X5pp8L_lypw/frame-00286.png)

**Step 3 — handle the two partial end blocks.** A query's endpoints usually land **inside** blocks, leaving a partial piece at each end. Here the $\pm 1$ property is decisive: two blocks whose depth values differ by a **constant offset** answer *every* in-block RMQ identically — the minimum sits at the same position.

- Encode each block by the **sign pattern** of its $b-1$ consecutive differences ($+1$ or $-1$). That signature is the block's **type**.
- Number of distinct types is at most $2^{\,b-1}$. With $b = \tfrac12 \log_2 n$ that is $2^{(\log_2 n)/2 - 1} = \Theta(\sqrt n)$ — small.

![Block types are strings of plus and minus of length b minus one, so there are at most two-to-the-b-minus-one of them; with b half log n that is square root of n](/img/dsa/X5pp8L_lypw/frame-00336.png)

**Step 4 — brute-force every type, every sub-range.** Build a table `table[type][l][r]` = position of the minimum within a block of that type over offsets $l..r$. Its size is $\Theta(\sqrt n) \cdot b^2 = \Theta(\sqrt n \cdot \log^2 n)$, which is $o(n)$ — sub-linear, so total build stays **linear**.

![The mem-table indexed by block type and by the sub-range l..r inside the block returns where the in-block minimum lies, filled by brute force](/img/dsa/X5pp8L_lypw/frame-00346.png)

- **A query then costs $O(1)$:** two in-block table lookups for the partial ends, plus one sparse-table lookup for the middle whole blocks.

```cpp
#include <bits/stdc++.h>
using namespace std;

struct FCB {                        // O(n) build, O(1) LCA
    int n, m, block, nblocks;
    vector<vector<int>> g;
    vector<int> euler, h, first;    // h[i] = depth of euler[i]  (a +/-1 array)
    vector<int> blockMin, blockType, logtbl;
    vector<vector<int>> sparse;                       // over block minima (h-indices)
    vector<vector<vector<int>>> table;                // table[type][l][r] = offset

    int argmin(int i, int j) { return h[i] <= h[j] ? i : j; }

    void dfs(int v, int p) {
        first[v] = euler.size();
        euler.push_back(v);
        for (int to : g[v]) if (to != p) { dfs(to, v); euler.push_back(v); }
    }

    void build(int root) {
        first.assign(n, -1); euler.clear();
        dfs(root, -1);
        m = euler.size();

        vector<int> depth(n);                          // depths for the h array
        function<void(int,int)> dd = [&](int v, int p) {
            for (int to : g[v]) if (to != p) { depth[to] = depth[v] + 1; dd(to, v); }
        };
        depth[root] = 0; dd(root, -1);
        h.resize(m);
        for (int i = 0; i < m; i++) h[i] = depth[euler[i]];

        block = max(1, (int)(log2(max(2, m)) / 2));
        nblocks = (m + block - 1) / block;

        // Pad h to a whole number of blocks with +1 steps. Without this a short
        // final block has fewer differences, so its type collides with a full
        // block of a different shape and the per-type table returns wrong offsets.
        // The +1 padding keeps the +/-1 property and never becomes a real min.
        for (int i = m; i < nblocks * block; i++) h.push_back(h.back() + 1);

        blockMin.assign(nblocks, -1);
        blockType.assign(nblocks, 0);
        for (int b = 0; b < nblocks; b++) {            // per-block min + signature
            int mn = b * block, type = 0;
            for (int i = b * block; i < (b + 1) * block; i++) {   // h now padded full
                if (h[i] < h[mn]) mn = i;
                if (i > b * block) {                   // +1 -> bit set, -1 -> clear
                    type = (type << 1) | (h[i] - h[i - 1] == 1 ? 1 : 0);
                }
            }
            blockMin[b] = mn;
            blockType[b] = type;
        }

        logtbl.assign(nblocks + 1, 0);                 // sparse table over block minima
        for (int i = 2; i <= nblocks; i++) logtbl[i] = logtbl[i / 2] + 1;
        int LG = logtbl[nblocks] + 1;
        sparse.assign(LG, vector<int>(nblocks));
        for (int b = 0; b < nblocks; b++) sparse[0][b] = blockMin[b];
        for (int k = 1; k < LG; k++)
            for (int b = 0; b + (1 << k) <= nblocks; b++)
                sparse[k][b] = argmin(sparse[k-1][b], sparse[k-1][b + (1 << (k-1))]);

        int types = 1 << (block - 1);                  // precompute per-type in-block RMQ
        table.assign(types, {});
        vector<char> seen(types, 0);
        for (int b = 0; b < nblocks; b++) {
            int t = blockType[b];
            if (seen[t]) continue;
            seen[t] = 1;
            int base = b * block;
            table[t].assign(block, vector<int>(block, 0));
            for (int l = 0; l < block; l++) {
                int best = l;
                for (int r = l; r < block; r++) {
                    if (h[base + r] < h[base + best]) best = r;   // h is padded full
                    table[t][l][r] = best;             // offset of min within the block
                }
            }
        }
    }

    int inBlockMin(int b, int l, int r) {              // l,r offsets 0..block-1
        return b * block + table[blockType[b]][l][r];
    }

    int queryIdx(int i, int j) {                       // index of min of h over [i,j]
        if (i > j) swap(i, j);
        int bi = i / block, bj = j / block;
        if (bi == bj) return inBlockMin(bi, i - bi * block, j - bj * block);
        int res = inBlockMin(bi, i - bi * block, block - 1);
        res = argmin(res, inBlockMin(bj, 0, j - bj * block));
        if (bi + 1 <= bj - 1) {                        // whole blocks via sparse table
            int l = bi + 1, r = bj - 1, k = logtbl[r - l + 1];
            res = argmin(res, argmin(sparse[k][l], sparse[k][r - (1 << k) + 1]));
        }
        return res;
    }

    int lca(int u, int v) { return euler[ queryIdx(first[u], first[v]) ]; }
};
```

- **Verified:** on 1500 random trees (up to 60 nodes, 40 queries each), `FCB::lca` matched the brute-force oracle exactly.
- **The reverse reduction (RMQ from LCA).** FCB assumed a $\pm 1$ array. To do **general** RMQ on an arbitrary array in $O(n)$ / $O(1)$, build a **Cartesian tree** (min at the root, recurse on left and right sub-arrays; linear time) and answer RMQ$(l,r)$ as $\mathrm{LCA}$ of the array positions $l$ and $r$ — whose Euler-depth array is $\pm 1$ by construction. So RMQ and LCA are interreducible.

![A Cartesian tree built from array five three seven two six four eight seven — the minimum is the root, and RMQ becomes an LCA query on this tree](/img/dsa/X5pp8L_lypw/frame-00362.png)

[watch from 62:34](https://youtu.be/X5pp8L_lypw?t=3754)

---

## Complexity recap

| Method | Preprocess | Query | Space | Notes |
| --- | --- | --- | --- | --- |
| Binary lifting | $O(n\log n)$ | $O(\log n)$ | $O(n\log n)$ | Also gives $k$-th ancestor and path aggregates |
| Euler tour + segment tree | $O(n)$ | $O(\log n)$ | $O(n)$ | Simplest linear-build option |
| Euler tour + sparse table | $O(n\log n)$ | $O(1)$ | $O(n\log n)$ | Constant query, heavier build |
| Farach-Colton–Bender | $O(n)$ | $O(1)$ | $O(n)$ | Optimal; big constant, needs the $\pm 1$ array |
| RMQ (general) via Cartesian tree + FCB | $O(n)$ | $O(1)$ | $O(n)$ | Reduces arbitrary-array RMQ to LCA |

---

## Practice problems

Binary lifting and LCA are squarely interview-relevant; Farach-Colton–Bender itself is a competitive-programming specialty, so its interview value is the *ideas* (Euler tour, RMQ reduction, block decomposition) rather than the full construction.

**🎯 Interview (MAANG-style)**

- [Kth Ancestor of a Tree Node — LeetCode 1483](https://leetcode.com/problems/kth-ancestor-of-a-tree-node/) — Hard — the binary-lifting table verbatim.
- [Lowest Common Ancestor of a Binary Tree — LeetCode 236](https://leetcode.com/problems/lowest-common-ancestor-of-a-binary-tree/) — Medium — single-query LCA by recursion (no preprocessing).
- [Lowest Common Ancestor of a Binary Tree III — LeetCode 1650](https://leetcode.com/problems/lowest-common-ancestor-of-a-binary-tree-iii/) — Medium — LCA with parent pointers; the depth-leveling idea.
- [Longest Path With Different Adjacent Characters — LeetCode 2246](https://leetcode.com/problems/longest-path-with-different-adjacent-characters/) — Hard — tree DFS and path reasoning through a common node.
- [LCA in a tree using Binary Lifting — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/lca-in-a-tree-using-binary-lifting-technique/) — Hard — the exact technique of this lecture.
- [Kth ancestor of a node in binary tree — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/kth-ancestor-node-binary-tree-set-2/) — Medium — level-ancestor with lifting.

**🏆 Competitive**

- [Company Queries I — CSES 1687](https://cses.fi/problemset/task/1687) — Easy — the pure $k$-th-ancestor binary-lifting table.
- [Company Queries II — CSES 1688](https://cses.fi/problemset/task/1688) — Medium — LCA by binary lifting, exactly the two-phase query above.
- [Distance Queries — CSES 1135](https://cses.fi/problemset/task/1135) — Medium — $\mathrm{dist}(u,v) = d(u) + d(v) - 2\,d(\mathrm{LCA})$.

> No official Codeforces home-task post is linked in this lecture's description; the CSES tree section above is the canonical drill set for these ideas.

---

## Further reading

- [Lowest Common Ancestor — Binary Lifting (cp-algorithms)](https://cp-algorithms.com/graph/lca_binary_lifting.html) — the lifting table and query.
- [LCA — Farach-Colton and Bender (cp-algorithms)](https://cp-algorithms.com/graph/lca_farachcoltonbender.html) — the full $O(n)$ / $O(1)$ construction.
- [Lowest Common Ancestor — Euler tour + RMQ (cp-algorithms)](https://cp-algorithms.com/graph/lca.html) — the reduction used here.
- [Sparse Table (cp-algorithms)](https://cp-algorithms.com/data_structures/sparse-table.html) — the $O(1)$ idempotent RMQ.
- [Lowest common ancestor — Wikipedia](https://en.wikipedia.org/wiki/Lowest_common_ancestor) · [Range minimum query — Wikipedia](https://en.wikipedia.org/wiki/Range_minimum_query) · [Euler tour technique — Wikipedia](https://en.wikipedia.org/wiki/Euler_tour_technique) · [Cartesian tree — Wikipedia](https://en.wikipedia.org/wiki/Cartesian_tree).

---

## Key takeaways

- **Root first.** Rooting turns a shapeless tree into a hierarchy with depths, parents, and the all-important LCA.
- **LCA linearizes paths.** $\mathrm{dist}(u,v) = d(u) + d(v) - 2\,d(\mathrm{LCA})$; most path queries split at the LCA.
- **Binary lifting = doubling.** $\text{up}[k][v] = \text{up}[k-1][\text{up}[k-1][v]]$; climb by powers of two, one per set bit → $O(\log n)$ queries after $O(n\log n)$ build.
- **Euler tour = reduction.** LCA is a range-minimum on the $\pm 1$ depth array; choose the RMQ structure by which build/query trade-off you want.
- **FCB = removing the last log.** Block into $\tfrac12\log n$ pieces, sparse-table the block minima, and precompute all $\sqrt n$ block types — linear build, constant query. RMQ and LCA are two faces of the same problem.

## Glossary

- **Rooted tree** — a tree with one distinguished root and edges oriented away from it.
- **Lowest common ancestor (LCA)** — the deepest node that is an ancestor of both query nodes.
- **Binary lifting** — precomputing $2^k$-th ancestors so any climb is $O(\log n)$ power-of-two jumps.
- **Euler tour** — the DFS walk recording each node on entry and on every return; length $2n-1$.
- **Range minimum query (RMQ)** — report the position of the smallest element in a sub-array.
- **Plus-minus-one array** — an array where consecutive entries differ by exactly $1$; the Euler depth array is one.
- **Cartesian tree** — a tree whose root is the array minimum with subtrees built recursively; makes RMQ an LCA query.
- **Sparse table** — an idempotent-operation structure with $O(n\log n)$ build and $O(1)$ query.
