---
title: "S02E11 · Link-Cut Tree"
sidebar_position: 11
description: Preferred-path decomposition on splay trees — the access/expose operation, make_root/link/cut/find_root and path aggregates, with the amortized O(log n) bound via heavy-path plus splay potential.
---

# S02E11 · Link-Cut Tree

> **Source:** Pavel Mavrin, [_A&DS S02E11_](https://youtu.be/GifegXMjiiA) · 1h21m lecture → ~16 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- A **Link-Cut Tree (LCT)** maintains a **forest of rooted trees** under three structure-changing requests: `link` (attach one tree under a node of another), `cut` (detach a subtree), and a **path aggregate** to the root — each in **amortized $O(\log n)$**.
- The forest is split into **preferred paths**: each node marks **at most one** child edge, and the marked edges chop the tree into vertex-disjoint paths. Unmarked edges become **path-parent pointers**.
- Each preferred path is stored in a **splay tree keyed by depth** (left-to-right in-order = root-to-deep along the path), so path aggregates live at the splay root, and `split`/`merge` of paths are just splay `split`/`join`.
- The one key operation is **`access(v)`** (the lecturer calls it **`expose`**): walk from $v$ to the tree root, splaying and splicing so the whole root-to-$v$ path becomes **one** splay tree. `link`/`cut`/`find_root`/`path aggregate` are all thin wrappers over it.
- Adding a lazy **reverse** flag gives **`make_root`**, which lets path queries and cuts work between *any* two nodes, not just node-to-root.
- The $O(\log n)$ bound is **amortized**: a heavy-path potential (number of heavy unmarked edges) gives $O(\log^2 n)$; folding in the **splay rank potential** (rank $=\log$ of subtree weight) telescopes it down to $O(\log n)$. The full proof is deep — we state the potentials and the telescoping.

---

## The problem: a dynamic forest with path queries
- Last lecture (heavy-light decomposition) computed a function on a tree path in $O(\log^2 n)$, but the tree was **static**. This lecture adds two operations that **change the tree's shape**.
- Maintain a **forest of rooted trees**. Support:
  - **`link(v, u)`** — $v$ is the **root** of one tree, $u$ is a node of another; make $v$ a child of $u$, joining the two trees into one.
  - **`cut(v, u)`** — the reverse: remove the edge between child $v$ and its parent $u$, splitting one tree into two.
  - **`calc(v)`** — an **associative** aggregate (sum, min, bitwise-and, …) over the path from $v$ to the root of its tree. Each node carries a value.
- For simplicity the lecture fixes `calc` to the **path-to-root**; a general path between two nodes is a small extra step (shown below via `make_root`).

![Link-Cut Tree title board: link(v,u) joins two triangular trees, cut(v,u) splits them, calc(v) sums values on the path from v up to the root r](/img/dsa/GifegXMjiiA/frame-00035.png)

- **Result to remember:** all three run in **amortized $O(\log n)$**. The structure is due to Sleator and Tarjan (the splay-tree authors), and it uses splay trees inside. Any balanced/mergeable BST (treap, etc.) also works but loses the tight $O(\log n)$.

[watch from 0:07](https://youtu.be/GifegXMjiiA?t=7)

---

## Preferred-path decomposition
- For **each node** mark **at most one** of its child edges. Any choice is legal — there are **no constraints** (unlike heavy-light, where the heavy child is forced).
- Looking only at marked edges, the tree falls apart into **vertex-disjoint paths** (some are single nodes). These are the **preferred paths**.
- The picture below marks one path down the left spine ($5\!-\!1\!-\!9\!-\!4\!-\!7$-ish), another short path ($10\!-\!6\!-\!11$), and several singletons ($3$, $8$, $5$).

![A rooted 11-node tree with marked edges highlighted, decomposing it into a few preferred paths and several single-node paths](/img/dsa/GifegXMjiiA/frame-00071.png)

- **Modifying the decomposition:** the only two edits are **unmark** and **mark** one edge.
  - **Unmark** an edge on a path → that path **splits** into the part above and the part below the edge.
  - **Mark** a previously unmarked edge → the two adjacent paths **merge** into one (after un-marking whatever child was marked at that node, since each node keeps at most one marked child).
- So per path we need a structure supporting exactly three operations: **aggregate on the whole path**, **split the path in two**, **merge two paths**. That is any **mergeable BST** — the lecture uses **splay trees**.

[watch from 7:41](https://youtu.be/GifegXMjiiA?t=461)

---

## Each path is a splay tree
- Store every preferred path in a **splay tree keyed by depth**: the **in-order traversal** (left to right) visits the path nodes **from the shallow end (near the root) to the deep end**.
- Example: the spine path with nodes $9, 1, 4, 7$ (root-to-deep order) is one splay tree whose in-order is exactly $9, 1, 4, 7$ — the *shape* of the splay tree is irrelevant, only the in-order matters.
- **Path-parent pointer:** the whole path attaches to the rest of the tree at one node (its shallow end's parent). We store, **from the root of the splay tree**, a single pointer to that node in the *other* path. This is the **unmarked edge** re-expressed.
  - In the board: the $(10,6,11)$ path's splay-tree root points to node $3$; the singleton $5$ points to $3$; and so on.

![The 11-node tree beside its splay-tree representation: the path 9-1-4-7 as one splay tree, path 10-6-11 as another, each splay root carrying a dashed path-parent pointer to the node it hangs off; caption notes 'calc, split, merge' via Splay Trees](/img/dsa/GifegXMjiiA/frame-00085.png)

- **Invariants maintained:**
  - *Per splay node:* subtree aggregate `sum` (so the splay root of a path holds the whole path's aggregate).
  - *Per splay tree:* `par` of the splay root is a **path-parent** pointer (points into another path); `par` of a non-root splay node is an ordinary splay-tree edge. We distinguish them by an `isRoot` test.
- **Two edge kinds, one field.** A node's `par` is either a splay edge or a path-parent pointer. `x` is a splay root exactly when its parent does not claim it as a child:

```cpp
#include <bits/stdc++.h>
using namespace std;

struct LCT {
    struct Node {
        int ch[2] = {0, 0};   // splay children: 0 = left (shallower), 1 = right (deeper)
        int par = 0;          // splay parent OR path-parent pointer (see isRoot)
        long long val = 0;    // this node's value
        long long sum = 0;    // aggregate over this splay subtree (a path segment)
        bool rev = false;     // lazy reverse flag (used by make_root)
    };
    vector<Node> t;
    LCT(int n) : t(n + 1) {}   // node 0 is the null sentinel

    // x is the root of its splay tree iff its parent does not point back at it.
    bool isRoot(int x) {
        int p = t[x].par;
        return t[p].ch[0] != x && t[p].ch[1] != x;
    }
    void pull(int x) {         // recompute aggregate from children
        t[x].sum = t[t[x].ch[0]].sum + t[x].val + t[t[x].ch[1]].sum;
    }
};
```

[watch from 15:08](https://youtu.be/GifegXMjiiA?t=908)

---

## Splay inside the LCT
- We need the ordinary splay-tree machinery — `rotate` and `splay` — but with **two twists**:
  1. `splay` must **stop at the path boundary**: rotations never cross the path-parent pointer (guarded by `isRoot`).
  2. A lazy **reverse** flag (`rev`) is pushed down before touching a node, to support `make_root`.
- `rotate(x)` lifts $x$ one level; `splay(x)` brings $x$ to the **splay root** of its path with the usual zig / zig-zig / zig-zag cases, but only *within* one path.

```cpp
    void applyRev(int x) {
        if (!x) return;
        swap(t[x].ch[0], t[x].ch[1]);   // reversing the path swaps every left/right
        t[x].rev ^= true;
    }
    void push(int x) {                  // propagate lazy reverse to children
        if (t[x].rev) {
            applyRev(t[x].ch[0]);
            applyRev(t[x].ch[1]);
            t[x].rev = false;
        }
    }
    void rotate(int x) {
        int p = t[x].par, g = t[p].par;
        int d = (t[p].ch[1] == x);       // side of x under p
        int w = t[x].ch[d ^ 1];          // inner subtree switches parent
        if (!isRoot(p)) t[g].ch[t[g].ch[1] == p] = x;  // only relink g if p was not a splay root
        t[x].par = g;
        t[p].ch[d] = w; if (w) t[w].par = p;
        t[x].ch[d ^ 1] = p; t[p].par = x;
        pull(p); pull(x);
    }
    void splay(int x) {
        // push lazy flags from the splay root down to x before rotating
        static vector<int> stk; stk.clear();
        int y = x; stk.push_back(y);
        while (!isRoot(y)) { y = t[y].par; stk.push_back(y); }
        for (int i = (int)stk.size() - 1; i >= 0; --i) push(stk[i]);
        while (!isRoot(x)) {
            int p = t[x].par, g = t[p].par;
            if (!isRoot(p)) {
                if ((t[p].ch[1] == x) == (t[g].ch[1] == p)) rotate(p);  // zig-zig
                else rotate(x);                                          // zig-zag
            }
            rotate(x);                                                   // zig
        }
    }
```

- **Why `isRoot` in `rotate`:** when $p$ is itself a splay root, its `par` is a *path-parent* pointer to another path; we must **not** overwrite a child slot in that other node. The `isRoot(p)` guard keeps the path boundary intact.

[watch from 25:26](https://youtu.be/GifegXMjiiA?t=1526)

---

## `access` / `expose`: the one key operation
- **Goal.** `access(v)` (the board's **`expose(v)`**) makes the entire path from the **root down to $v$** into a **single preferred path**, hence a **single splay tree** whose root then holds that path's aggregate.
- **How.** Walk upward from $v$ via path-parent pointers. At each step you are at the shallow end of a path; splay to the top, then **splice** the previously-processed path in as the **deep (right) side**, and detach whatever deep child was there before:

  1. `splay(v)` — $v$ becomes its splay root.
  2. While $v$ has a **path-parent** $u$: `splay(u)`; **split** off $u$'s current deep part (its old right subtree becomes a new path, its splay root's `par` becomes a path-parent back to $u$); then **merge** by attaching $v$'s path as $u$'s new **right** child. Move up: $v \leftarrow u$.
  3. Finally `splay(v)` so $v$ ends at the root.

- The board's exact pseudocode (transcribe it verbatim — split then merge, then climb):

```text
expose(v):
    splay(v)
    while par(v) != null:
        u = par(v)
        splay(u)
        w = right(u); right(u) = null; par(w) = u    # split: detach u's old deep path
        right(u) = v; par(v) = null                  # merge: splice v's path in as deep side
        v = u
```

![The expose(v) pseudocode on the left board — splay(v); while par(v) not null: u=par(v); splay(u); split off right(u) into w; merge v in as right(u); v=u — beside the split/merge steps on the splay trees](/img/dsa/GifegXMjiiA/frame-00195.png)

- **Walked example — `expose(11)`.** Node $11$ sits in path $(10,6,11)$ whose splay root points to $3$. Splay $11$; follow the path-parent to $3$; splay $3$; split $3$'s deep side off; merge $11$'s path in as $3$'s right child. Now $3,10,6,11$ is one path. Repeat upward through $9$ until the whole root-to-$11$ chain is one splay tree.

![Mid-expose(11): the tree with the preferred path being rebuilt, annotations 'expose(11), splay(u), splay(3)' showing the climb, and the growing splay tree on the right](/img/dsa/GifegXMjiiA/frame-00117.png)

- **In real code**, the split/merge collapses to *"set the deep (right) child to the last processed node and recompute"* — the classic tight `access` loop:

```cpp
    // access(v): the whole root-to-v path becomes one splay tree rooted at v.
    int access(int v) {
        int last = 0;
        for (int cur = v; cur; cur = t[cur].par) {
            splay(cur);
            t[cur].ch[1] = last;   // detach old deep child, splice in `last` as new deep side
            pull(cur);
            last = cur;
        }
        splay(v);
        return last;               // topmost node touched (useful for LCA)
    }
```

- **Calc via access.** After `access(v)`, the root-to-$v$ path is one splay tree; its **root's `sum`** is the answer — that is the whole of `calc(v)`.

![After expose(5): a second worked example, the path 9-3-5 collected into one splay tree, values ready for the path aggregate at its root](/img/dsa/GifegXMjiiA/frame-00136.png)

[watch from 33:36](https://youtu.be/GifegXMjiiA?t=2016)

---

## `make_root`, `link`, `cut`, `find_root`, path queries
- **`make_root(v)`** — re-root the represented tree at $v$: `access(v)` gathers the root-to-$v$ path, then **reverse** that path (lazy `rev`) so $v$ becomes the shallowest node. This is what lets path queries and cuts work between *any* two nodes.
- **`link(u, v)`** — make $u$ (a tree root) hang under $v$. `make_root(u)`, then set $u$'s path-parent to $v$. No splay merge needed: the new edge starts **unmarked** (a pure path-parent pointer), so the decomposition barely changes.
- **`cut(u, v)`** — remove edge $(u,v)$: `make_root(u)`, `access(v)`; now $u$ is $v$'s left child with no right child, so drop the link.
- **`find_root(v)`** — `access(v)`, then walk to the **shallowest** node (leftmost in the splay tree) and splay it up.
- **`path_sum(u, v)`** — `make_root(u)`, `access(v)`, read $v$'s splay-root `sum`.

```cpp
    void makeRoot(int v) {
        access(v);
        applyRev(v);               // reverse: v becomes the shallowest node
    }
    int findRoot(int v) {
        access(v);
        while (t[v].ch[0]) { push(v); v = t[v].ch[0]; }  // leftmost = shallowest = root
        splay(v);
        return v;
    }
    void link(int u, int v) {      // u must be the root of its tree
        makeRoot(u);
        t[u].par = v;              // new unmarked edge = path-parent pointer
    }
    void cut(int u, int v) {       // remove edge (u,v) if it exists
        makeRoot(u);
        access(v);
        if (t[v].ch[0] == u && t[u].ch[1] == 0) {  // u is v's immediate shallow neighbor
            t[v].ch[0] = 0; t[u].par = 0;
            pull(v);
        }
    }
    bool connected(int u, int v) {
        if (u == v) return true;
        return findRoot(u) == findRoot(v);
    }
    long long pathSum(int u, int v) {
        makeRoot(u);
        access(v);
        return t[v].sum;           // aggregate over the whole u..v path
    }
    void setVal(int v, long long x) {
        access(v);
        t[v].val = x;
        pull(v);
    }
};
```

- **Stress-tested.** The blocks above form one program; run against brute force on random forests it agrees on **both** connectivity and path-sum across 400 trials:

```cpp
int main() {
    mt19937 rng(12345);
    for (int iter = 0; iter < 400; ++iter) {
        int n = 2 + rng() % 8;
        LCT lct(n);
        vector<long long> value(n + 1);
        vector<set<int>> adj(n + 1);
        for (int i = 1; i <= n; ++i) { value[i] = rng() % 20; lct.setVal(i, value[i]); }
        auto bfsConnected = [&](int u, int v) {
            vector<int> st = {u}; vector<char> seen(n + 1, 0); seen[u] = 1;
            while (!st.empty()) { int x = st.back(); st.pop_back();
                if (x == v) return true;
                for (int w : adj[x]) if (!seen[w]) { seen[w] = 1; st.push_back(w); } }
            return u == v;
        };
        auto bfsPath = [&](int u, int v) -> long long {
            vector<int> par(n + 1, 0); vector<char> seen(n + 1, 0);
            queue<int> q; q.push(u); seen[u] = 1;
            while (!q.empty()) { int x = q.front(); q.pop();
                for (int w : adj[x]) if (!seen[w]) { seen[w] = 1; par[w] = x; q.push(w); } }
            long long s = value[v]; int x = v;
            while (x != u) { x = par[x]; s += value[x]; }
            return s;
        };
        for (int op = 0; op < 60; ++op) {
            int u = 1 + rng() % n, v = 1 + rng() % n, c = rng() % 4;
            if (c == 0) { if (u != v && !bfsConnected(u, v)) { lct.link(u, v); adj[u].insert(v); adj[v].insert(u); } }
            else if (c == 1) { if (adj[u].count(v)) { lct.cut(u, v); adj[u].erase(v); adj[v].erase(u); } }
            else if (c == 2) { assert(lct.connected(u, v) == bfsConnected(u, v)); }
            else { if (bfsConnected(u, v)) assert(lct.pathSum(u, v) == bfsPath(u, v)); }
        }
    }
    printf("all 400 random-forest trials passed\n");
    return 0;
}
```

  Compiling with `c++ -std=c++17` and running prints `all 400 random-forest trials passed`.

[watch from 22:34](https://youtu.be/GifegXMjiiA?t=1354)

---

## Why it is $O(\log n)$ amortized — part 1: the $O(\log^2 n)$ bound
- The cost is **amortized**, proven by the **potential method**: for a series of operations $o_1, o_2, \dots, o_m$, the total is bounded by $\sum \tilde T(o_i) \le c\,m\log n$, where the **amortized** cost is $\tilde T = T + \Delta\Phi$ and $\Phi \ge 0$, so real cost $\le$ amortized cost.
- **First potential.** Imagine (only for the proof — the algorithm never builds it) a fixed **heavy-light decomposition** of the current tree. Define

$$
\Phi \;=\; \#\{\text{heavy edges that are currently unmarked}\}.
$$

![Potential-method board: T̃(expose)=O(log²n); Φ = number of heavy unmarked edges; a tree with heavy edges (red) and marked edges (purple), potential Φ=3](/img/dsa/GifegXMjiiA/frame-00228.png)

- **Real cost of one `access`.** The loop marks the edges along the path; each iteration does one `splay`, costing $O(\log n)$. If the path has $k$ edges to mark, the real cost is $T(\texttt{expose}) = k\log n$.
- **Change in potential when marking those $k$ edges.** Split $k = x + y$ into $x$ **heavy** edges and $y$ **light** edges on the path.
  - Marking a **heavy** edge that was unmarked **decreases** $\Phi$ by $1$ (it leaves the unmarked-heavy set): contributes $-x$.
  - Marking a **light** edge may force un-marking a heavy edge at that node, so $\Phi$ **increases** by at most $1$ each: contributes $\le +y$.
  - So $\Delta\Phi \le -x + y$.
- **Amortized cost.** With $k = x + y$:

$$
\tilde T = T + \Delta\Phi\cdot\log n \le (x+y)\log n + (-x+y)\log n = 2y\log n.
$$

- **Bound $y$.** On any root-to-node path, a heavy-light decomposition has at most $\log n$ **light** edges, so $y \le \log n$ and $\tilde T \le 2\log^2 n$.

![The full first-half derivation: T(expose)=k·log n=(x+y)log n, ΔΦ ≤ (−x+y)log n, telescoping to T̃ = 2y·log n ≤ 2 log²n, with k=x heavy + y light and y ≤ log n](/img/dsa/GifegXMjiiA/frame-00288.png)

- **Intuition.** If an `access` does *lots* of work, it must be marking *lots* of edges, and most of them are **heavy** (only $\log n$ can be light). Marking heavy edges pushes the decomposition toward the heavy-light one and pays for itself via the potential drop.

[watch from 42:51](https://youtu.be/GifegXMjiiA?t=2571)

---

## Why it is $O(\log n)$ amortized — part 2: the splay refinement
- The $\log^2 n$ came from charging **every** splay a flat $\log n$. But a single splay does **not** always cost $\log n$ — its amortized cost is $1 + \Delta(\text{rank})$, the change of the node's **rank**.
- **Splay rank potential.** Give each node a **weight**; define $\operatorname{rank}(v) = \log\big(\text{total weight in } v\text{'s splay subtree}\big)$. A single `splay(v)` costs amortized $O\big(1 + \operatorname{rank}_{\text{after}}(v) - \operatorname{rank}_{\text{before}}(v)\big)$ (proved in the splay-tree lecture).
- **Sum the climb.** `access` splays $u_1, u_2, u_3, \dots$ up the chain. The ranks **telescope**: because $u_{i+1}$ is an ancestor of $u_i$ in the represented tree, $\operatorname{rank}_{\text{new}}(u_i) \le \operatorname{rank}_{\text{old}}(u_{i+1})$, so consecutive terms cancel:

$$
\sum_i \big(1 + \Delta\operatorname{rank}(u_i)\big) \;\le\; k + \big(\operatorname{rank}(\text{last}) - \operatorname{rank}(\text{first})\big) \;=\; O(k + \log n).
$$

- **The right weights.** Set the weight of node $v$ to the **total number of nodes hanging off $v$ via path-parent pointers** (the "virtual subtree" size). Then every rank stays $\le \log n$, and since $u$ is always the parent of $v$, $\operatorname{rank}(u) \ge \operatorname{rank}(v)$ — exactly the inequality the telescoping needs.

![Final board: rank(v)=log(sum of subtree weights w(v)); weight = number of nodes attached via parent links; the rank inequality rank(u) ≥ rank(v) that makes the telescoping work, giving O(log n)](/img/dsa/GifegXMjiiA/frame-00318.png)

- **Combine.** The real per-`access` cost is now $O(k + \log n)$ instead of $k\log n$. Re-running the part-1 bookkeeping with this replaces $k\log n$ by $k$, turning $2y\log n$ into $y\log n + \log n = O(\log n)$ per operation. **This is the headline $O(\log n)$ amortized result.**
- The lecturer is candid: this is *not* the simplest structure in the course — the two potentials interact, and it is worth re-watching. The takeaway is the **shape** of the argument (heavy-path potential for the outer loop, splay-rank potential for the inner splays), not the last constant.

[watch from 68:56](https://youtu.be/GifegXMjiiA?t=4136)

---

## Complexity recap
| Operation | Best | Amortized | Worst (single op) | Space |
| --- | --- | --- | --- | --- |
| `access` / `expose` | $\Theta(1)$ | $O(\log n)$ | $O(n)$ | $O(n)$ |
| `link` | $\Theta(1)$ | $O(\log n)$ | $O(n)$ | — |
| `cut` | $\Theta(1)$ | $O(\log n)$ | $O(n)$ | — |
| `find_root` | $\Theta(1)$ | $O(\log n)$ | $O(n)$ | — |
| `make_root` | $\Theta(1)$ | $O(\log n)$ | $O(n)$ | — |
| path aggregate | $\Theta(1)$ | $O(\log n)$ | $O(n)$ | — |

- Bounds are **amortized** (a single splay can be linear; a sequence of $m$ operations costs $O(m\log n)$). Total space is $O(n)$ — a handful of integer fields per node.

---

## Practice problems

LCT is **advanced competitive-programming** material — it is essentially **never coded in interviews**. The interview-relevant skill is **dynamic connectivity**, for which **union-find** is the expected tool. The honest framing: reach for union-find in interviews; reach for an LCT only when you must also support **cuts** and/or **path aggregates**, which union-find cannot undo.

**🎯 Interview (MAANG-style)** — dynamic connectivity, union-find suffices

- [Number of Islands II — LeetCode 305](https://leetcode.com/problems/number-of-islands-ii/) — Hard — incremental connectivity as cells turn to land; union-find is the intended solution. **Note:** an LCT would also handle *removing* land (cuts), which union-find cannot — that is exactly the extra power LCTs buy.
- [Number of Islands — LeetCode 200](https://leetcode.com/problems/number-of-islands/) — Medium — the static warm-up (flood fill or union-find).
- [Redundant Connection — LeetCode 684](https://leetcode.com/problems/redundant-connection/) — Medium — detect the edge that closes a cycle; union-find, and conceptually the guard `link` needs (only link across different trees).
- [Graph Valid Tree — LeetCode 261](https://leetcode.com/problems/graph-valid-tree/) — Medium — connectivity plus acyclicity, the invariant a link-cut forest maintains.

**🏆 Competitive** — the real home of LCTs

- [Cycle Finding — CSES 1197](https://cses.fi/problemset/task/1197) — Hard — negative cycle / graph structure practice adjacent to dynamic-tree reasoning.
- [Distinct Routes / Tree path tasks — CSES Tree Algorithms](https://cses.fi/problemset/) — Medium/Hard — the CSES tree section is the natural on-ramp to path queries before LCTs.
- [Link Cut Tree — USACO Guide (Advanced)](https://usaco.guide/adv/LCT) — a curated, well-vetted problem list with LCT-specific tasks and editorials.

> No official Codeforces home-task post is linked in this lecture's description, so none is cited here. On Codeforces, dynamic-tree problems appear under the `data structures` / `trees` tags — search those tags for canonical LCT practice.

---

## Further reading
- [Heavy path decomposition — Wikipedia](https://en.wikipedia.org/wiki/Heavy_path_decomposition) — the static cousin whose potential drives the LCT proof.
- [Heavy-light decomposition — cp-algorithms](https://cp-algorithms.com/graph/hld.html) — implementation of the $O(\log^2 n)$ static path-query structure.
- [Link/cut tree — Wikipedia](https://en.wikipedia.org/wiki/Link/cut_tree) — the operations and the original Sleator–Tarjan framing.
- [Splay tree — Wikipedia](https://en.wikipedia.org/wiki/Splay_tree) — the rank-potential amortized analysis reused in part 2.
- [Dynamic connectivity — Wikipedia](https://en.wikipedia.org/wiki/Dynamic_connectivity) — where LCTs sit among fully-dynamic connectivity structures.
- [Deleting from a data structure in O(log n) — cp-algorithms](https://cp-algorithms.com/data_structures/deleting_in_log_n.html) — an offline alternative when the workload allows it.
- [Link Cut Trees — USACO Guide](https://usaco.guide/adv/LCT) — a modern, code-first treatment with problems.

---

## Key takeaways

- An LCT is **preferred-path decomposition** (each node marks $\le 1$ child) with **each path stored in a splay tree keyed by depth**; unmarked edges become **path-parent pointers**.
- **Everything is `access(v)`**: splay-and-splice the root-to-$v$ path into one splay tree. `link`, `cut`, `find_root`, `make_root`, and path aggregates are all thin wrappers.
- A lazy **reverse** flag turns node-to-root queries into **arbitrary path** queries via `make_root`.
- The **$O(\log n)$ is amortized**, from two stacked potentials: a **heavy-path** potential (unmarked heavy edges) gives $O(\log^2 n)$; the **splay rank** potential telescopes the inner splays to shave a $\log$ off, giving $O(\log n)$.
- For interviews use **union-find** for connectivity; LCTs are the tool when you also need **cuts** or **path aggregates** on a changing forest.

## Glossary

- **Preferred path** — a maximal chain of marked child edges; the decomposition's unit, stored as one splay tree.
- **Path-parent pointer** — the `par` of a splay root; points from a path's shallow end into the node it hangs off (an unmarked edge).
- **`access(v)` / `expose(v)`** — make the root-to-$v$ path a single splay tree so its aggregate sits at the root.
- **`make_root(v)`** — re-root the represented tree at $v$ using a lazy path reverse.
- **Rank** — $\log$ of the total weight in a splay subtree; its change bounds a splay's amortized cost.
- **Potential method** — amortized-analysis technique bounding total cost by $\sum (T + \Delta\Phi)$ with $\Phi \ge 0$.
- **Amortized bound** — a per-operation cost guaranteed *on average over a sequence*, though a single operation may be slower.
