---
title: "S01 · Eval–Link–Update"
sidebar_position: 17
description: Tarjan's Link-Eval (Eval-Link-Update) structure — a disjoint-set forest that carries labels and answers path-to-root aggregates via path compression, with balanced virtual trees for the invertible and total-order cases and an inverse-Ackermann amortized bound.
---

# S01 · Eval–Link–Update

> **Source:** Pavel Mavrin, [_A&DS S01 (Bonus 1)_](https://youtu.be/7nPZulZq_oY) · 1h41m lecture → ~15 min read.
> A bonus lecture on R. E. Tarjan's paper _Applications of Path Compression on Balanced Trees_. Every section deep-links back to the exact moment on the board.

## TL;DR

- **Eval–Link–Update** (a.k.a. **Link-Eval**) is a labelled cousin of disjoint-set-union: a forest of rooted trees where each node carries a **label**, and we support three operations.
- **`link(v, w)`** makes root `v` the parent of root `w` (direction is fixed — you cannot swap the arguments). **`eval(v)`** returns the aggregate of labels along the path from `v` up to its tree root under an **associative** binary operator $\otimes$. **`update(r, x)`** folds `x` into the label of a root `r`.
- The **simple version** — just apply **path compression** on every `eval`, relabelling visited nodes so the aggregate is preserved — is about 10 lines and runs in roughly $O(\log n)$ per operation on unbalanced trees.
- To reach the **inverse-Ackermann** bound $O(\alpha(m, n))$ you maintain a **balanced virtual tree** that gives identical `eval` answers. Two settings make this possible: $\otimes$ has **inverses** (e.g. sum), or the values have a **total order** and $\otimes = \max$.
- For the total-order case the virtual tree becomes a **sorted chain of balanced trees**; `eval` stops at the **local root**, and the balance proof rests on **good** and **mediocre** edges, each roughly doubling subtree size.
- This is an **advanced competitive-programming / research** structure — its real-world home is **offline LCA** (Tarjan), **minimum spanning trees**, and **dominator trees**. You will essentially never implement it in an interview; the nearest interview-relevant cousin is plain LCA.

---

## What the structure computes

- We keep a **forest of rooted, directed trees**. Each element belongs to exactly one tree; each tree has one **root**. Edges point child → parent.
- Every node stores a **label** (Tarjan's term). `eval` aggregates labels along a root-ward path; `label` is the per-node partial value.
- The three operations, exactly as written on the board:
  - **`link(v, w)`** — `v` and `w` are both roots; make `v` the **parent** of `w`, merging the two trees. The direction is part of the contract: unlike DSU's `union`, you may **not** reverse the arguments.
  - **`eval(v)`** — walk the path $v = v_0, v_1, v_2, \dots, v_k = \text{root}$ and return
    $$a_0 \otimes a_1 \otimes a_2 \otimes \cdots \otimes a_k,$$
    where $a_i$ is the label of $v_i$ and $\otimes$ is an **associative** binary operator: $x \otimes (y \otimes z) = (x \otimes y) \otimes z$. Any associative op works — sum, min, max, gcd — the same requirement as a segment tree.
  - **`update(r, x)`** — `r` must be a **root**; set $\text{label}(r) \leftarrow \text{label}(r) \otimes x$. We only ever mutate labels at roots, which is what keeps the structure cheap.

![Board defining Link(v,w), Eval(v)=a0⊗a1⊗…⊗ak with associativity, and Update(r,x)=label(r)⊗x](/img/dsa/7nPZulZq_oY/frame-00034.png)

- Why not just use a link-cut tree? A link-cut tree does all this in $O(\log n)$, but it also supports **cuts**. Here we only ever **link** (never split), so we can push below $\log n$ into inverse-Ackermann territory.

[watch from 2:48](https://youtu.be/7nPZulZq_oY?t=168)

---

## The simple version: path compression

- Call `eval(v)`. Walk the path to the root `r`, accumulate the aggregate, then **reattach every node on the path directly to `r`** — exactly the path compression from the [disjoint-sets](s01e08-disjoint-sets) lecture — while **rewriting labels so `eval` is unchanged**.
- Concretely, suppose the path carries labels $a_0, a_1, a_2, a_3, a_4$ (root last, label $a_4$). After compression each node hangs off `r`, and we relabel so its stored value equals the sum of the **original** labels strictly between it and the root:
  - the node that held $a_3$ keeps $a_3$ (its aggregate to root is $a_3 \otimes a_4$),
  - the node that held $a_2$ now stores $a_2 \otimes a_3$,
  - the node that held $a_1$ now stores $a_1 \otimes a_2 \otimes a_3$, and so on.
- Computing these is a single **right-to-left scan** of the path — linear in the path length.
- **`update`** stays trivial: only the root's label changes, and compression never moves the root, so shifting the root's label shifts every path aggregate by the same amount.

![Path compression: the v→root chain is flattened onto r, each node relabelled to preserve its eval; with the O(log n) vs O(α(m,n)) complexity split](/img/dsa/7nPZulZq_oY/frame-00087.png)

Here is the whole simple structure in C++ for the **additive** monoid (labels are numbers, $\otimes = +$). `compress` flattens the path and folds partial sums so `eval` is preserved:

```cpp
#include <bits/stdc++.h>
using namespace std;

// Eval-Link-Update (Link-Eval) via path compression, additive monoid.
// label[v] holds a partial value; eval(v) = sum of labels from v up to the
// root of its tree (inclusive). Path compression relabels every visited node
// so eval stays correct while the node is reattached directly to the root.
struct LinkEval {
    vector<int> parent;        // parent[v] == v  iff  v is a tree root
    vector<long long> label;

    explicit LinkEval(int n) : parent(n), label(n, 0) {
        iota(parent.begin(), parent.end(), 0);
    }

    // Compress v -> root. Afterwards every node on the old path points straight
    // at the root, and its label equals the summed labels strictly between it
    // and the root.
    int compress(int v) {
        if (parent[v] == v) return v;
        int r = compress(parent[v]);       // r = root of v's tree
        if (parent[v] != r) {
            label[v] += label[parent[v]];  // fold parent's partial sum into v
            parent[v] = r;
        }
        return r;
    }

    // eval(v) = label[v0] + label[v1] + ... + label[root]  (path aggregate).
    long long eval(int v) {
        int r = compress(v);
        return (v == r) ? label[v] : label[v] + label[r];
    }

    // link(v, w): make root v the parent of root w.
    void link(int v, int w) { parent[w] = v; }

    // update(r, x): fold x into the label of root r (r must be a root).
    void update(int r, long long x) { label[r] += x; }
};

int main() {
    // Path 0 <- 1 <- 2 <- 3 (0 is root); labels a0..a3 on each node.
    LinkEval le(4);
    long long a[4] = {10, 3, 5, 2};
    le.update(0, a[0]);
    le.link(0, 1); le.label[1] = a[1];
    le.link(1, 2); le.label[2] = a[2];
    le.link(2, 3); le.label[3] = a[3];

    cout << le.eval(3) << "\n";   // 20 = 2+5+3+10
    cout << le.eval(2) << "\n";   // 18 = 5+3+10
    le.update(0, 100);            // shift the root
    cout << le.eval(3) << "\n";   // 120
    return 0;
}
```

- **Complexity of the simple version.** If the tree is **not balanced**, path compression alone gives
  $$T = O\!\left(\log_{2 + m/n} n\right) \approx \log n$$
  (this is the bound proved in the disjoint-sets lecture — small $m$ behaves like $\log n$, large $m$ tends to a constant). If the tree **is** balanced, you instead get $T = O(\alpha(m, n))$, inverse-Ackermann. Nobody promised our links produce balanced trees, so on its own the simple version sits at about $\log n$ — already good enough for many uses, and only ~10 lines.

[watch from 10:06](https://youtu.be/7nPZulZq_oY?t=606)

---

## Reaching inverse-Ackermann: the balanced virtual tree

- The idea: keep the **real tree** implicit and instead maintain a **virtual tree** on the same node set that (a) yields **identical `eval` answers** and (b) is **balanced**, so path compression on it hits $O(\alpha(m, n))$.
- "Balanced" is achieved with the same **weighted-union heuristic** as DSU: always attach the **smaller** tree under the **bigger** one. That is only possible in two special settings.

### Case A — the operator has inverses (e.g. sum)

- **Requirement.** For every value $x$ there is an inverse $x^{-1}$ with $x \otimes x^{-1} = 0$, where $0$ is the identity ($x \otimes 0 = x$ for all $x$). For $\otimes = +$ this is simply $x^{-1} = -x$, since $x + (-x) = 0$.
- The virtual tree may point edges in **either** direction; we fix labels so `eval` still matches the real tree. Below, the real tree (labels $5, 3, 1$ on a chain) is mirrored by a balanced virtual tree whose labels differ but whose path aggregates agree.

![Inverse-element case: ∀x ∃x⁻¹ with x⊗x⁻¹=0 (for sum, x⁻¹=−x); real tree vs a balanced virtual tree giving the same eval, with link relabelling E'(y)=E(y)⊗v](/img/dsa/7nPZulZq_oY/frame-00131.png)

- **How `link(v, w)` stays balanced.** We want to hang `w`'s tree under `v`. Look at how `eval` changes:
  - for every node $x$ already in **`v`**'s tree, the aggregate is unchanged: $E'(x) = E(x)$;
  - for every node $y$ in **`w`**'s tree, the new aggregate is the old one composed with `v`'s label: $E'(y) = E(y) \otimes v$.
- If `w`'s tree is **larger** than `v`'s, we would rather **reverse** the physical edge (attach `v` under `w`) to keep things balanced. Reversing changes the aggregates, so we repair with **inverses**:
  - fold `v`'s label into `w`'s root: $\text{label}(w) \leftarrow \text{label}(w) \otimes v$, so every node in `w`'s old tree gets $E'(\cdot) = E(\cdot) \otimes v$ as required;
  - along the reattached path we insert the inverse corrections $\dots \otimes v \otimes v^{-1} \otimes w^{-1}$ (applied in the correct order — to undo "apply $w$ then $v$" you apply $v^{-1}$ then $w^{-1}$), so those nodes' aggregates come out unchanged.

![Worked link with sum: two trees (labels 3,2 and 4,5,1) merged by reversing the edge into the larger tree and folding v's label so every eval is preserved](/img/dsa/7nPZulZq_oY/frame-00163.png)

- **`update(r, x)`** in this case: `r` was a real-tree root but may sit **inside** the virtual tree. Applying $x$ at the root shifts every node's aggregate by $x$, i.e. $E'(v) = E(v) \otimes x$ for all $v$ — so we find the virtual root (via compression) and apply the update there; the answer is identical.
- **We never need the real tree.** All algorithms maintain only the virtual tree plus the invariant that its `eval` answers equal the real tree's.

[watch from 20:12](https://youtu.be/7nPZulZq_oY?t=1212)

### Case B — total order with $\otimes = \max$

- `max` has **no inverse**, so Case A's trick fails: if you reverse an edge you cannot force a child's `max` to drop below an ancestor it now sits above. Instead we exploit two order facts (values are totally ordered).
- **Observation 1.** On the path from `x` to the root, if every ancestor is $\le x$, those ancestors are **irrelevant** to any `eval` that passes through `x` — the running maximum is already $\ge x$.
- **Observation 2.** If some ancestor `y` on that path has $y \ge x$, then `x` is **never** the maximum for any node below it — so we may safely **overwrite** `x`'s label with `y` (or drop it) without changing any `eval`.
- **The virtual structure.** A single real tree becomes a **sorted chain of balanced trees**. Each small tree is balanced; the **root labels are sorted along the chain** ($r \le r_1 \le r_2 \le \dots \le r_k$, comparing only the roots). The chain holds the same node set and gives the same `eval` answers.

![max case: one real tree (R.T.) becomes a virtual tree (V.T.) that is a sorted chain of balanced sub-trees, each balanced, root labels increasing along the chain](/img/dsa/7nPZulZq_oY/frame-00224.png)

- **`eval(v)`** now follows the path **only up to the local root** $r_k$ of `v`'s small tree — everything above is $\le r_k$ and cannot beat it. Since each small tree is balanced, path compression **inside it** is $O(\alpha(m, n))$.

[watch from 46:04](https://youtu.be/7nPZulZq_oY?t=2764)

---

## The max case: update and link

- **`update(r, x)`.** We keep the root fixed and set $\text{label}(r) \leftarrow \text{label}(r) \otimes x = \max(\text{label}(r), x)$. Raising the root's label may violate the sorted-chain invariant, so:
  1. find every small-tree root $\le x$ (overwriting them with `x` is legal by Observation 2),
  2. **merge** all those trees into one big balanced tree, attaching small under big.
- Merging is not just tidy — it is what makes the bound **amortized**. Treat the potential $\Phi$ as the **number of trees**. A long update that touches $k$ roots costs $T = k$ time but drops the tree count by $k - 1$, so $\Delta\Phi = -(k-1)$ pays for the work. Amortized `update` is **$O(1)$**.

![Update in the max case: set the root label, collect local roots ≤ x, merge them into one balanced tree; potential Φ = number of trees, ΔΦ = −(k−1) pays the k work](/img/dsa/7nPZulZq_oY/frame-00307.png)

- **`link(v, w)`.** Compare the **total** node counts of the two chains (`size` = all nodes across a chain's small trees) and attach small chain under big:
  - if $\text{size}(w) < \text{size}(v)$: connect all of `w`'s trees directly under `v`;
  - if $\text{size}(w) > \text{size}(v)$: connect `v`'s small trees under `v`, then hang the whole `w`-chain under `v`.
  In both cases you re-run the "find local roots $\le$ threshold and merge" repair so the sorted-chain invariant holds. Amortized `link` is also **$O(1)$** (the traversal again decreases the tree count).
- **A node's life cycle** (like DSU, transitions are one-way): a node starts as a **tree root**, at some link becomes a **local root** of a small tree, and finally becomes an **internal** node — and once it stops being a root it never becomes one again.

[watch from 60:26](https://youtu.be/7nPZulZq_oY?t=3626)

---

## Why the virtual trees stay balanced

- Classify the edges created by merges:
  - **Good edge** $x \to y$: created when attaching a strictly smaller subtree, so $\text{subsize}(y) \ge 2\,\text{subsize}(x)$. Size at least doubles across one good edge.
  - **Mediocre edge**: not individually doubling, but **two consecutive** mediocre edges $x \to y \to z$ guarantee $\text{subsize}(z) \ge 2\,\text{subsize}(x)$. (Here `subsize` is the size of the small tree, distinct from `size`, the whole chain's node count.)
- The key distinction: `size` = total nodes in the whole set of trees for a vertex; `subsize` = nodes in a single small tree. The mediocre bound follows because two successive links funnel all the intervening small trees into one subtree, at least doubling it.
- **Consequence.** Every edge is good or mediocre, so along any path the subtree size grows by at least a factor of $\sqrt{2}$ per edge. The number of nodes at rank $k$ is bounded by
  $$n_k \le \frac{n}{(\sqrt{2})^{\,k-1}} \le \frac{n}{2^{k/2}},$$
  which is the same shape as the disjoint-sets rank bound (only the constant $\sqrt{2}$ replaces $2$). Feeding this into the **identical** amortized argument from the DSU lecture yields the final result.

![Balance proof: good edge subsize(y)≥2·subsize(x), mediocre edge subsize(z)≥2·subsize(x); number of rank-k nodes ≤ n/(√2)^(k−1)](/img/dsa/7nPZulZq_oY/frame-00400.png)

- **Bottom line:** all three operations run in **amortized $O(\alpha(m, n))$**, inverse-Ackermann — effectively constant.

[watch from 80:08](https://youtu.be/7nPZulZq_oY?t=4808)

---

## The canonical application: offline LCA

- The structure's real payoff is **Tarjan's offline LCA**: given a rooted tree and a batch of $(u, v)$ queries known in advance, answer all lowest-common-ancestor queries in near-linear total time. This is exactly `link` (attach a finished child subtree to its parent) plus `eval` (find the representative carrying the current ancestor).
- DFS the tree; on entering a node it forms its own set; after fully processing a child, `link` its set under the parent and stamp the set's **ancestor** to the parent. When both endpoints of a query have been visited, `eval` (a `find`) yields their LCA.

```cpp
#include <bits/stdc++.h>
using namespace std;

// Tarjan offline LCA — the classic Link-Eval application. DSU here is the
// "link + eval" skeleton: union attaches a finished subtree under its parent,
// eval finds the representative that carries the ancestor label.
int n;
vector<vector<int>> tree;                 // rooted tree, children lists
vector<vector<pair<int,int>>> queries;    // queries[u] = {(other, query_id)}
vector<int> parent, ancestor;             // DSU parent + node's LCA-representative
vector<char> visited;
vector<int> answer;

int find(int v) {                         // path-compression "eval"
    return parent[v] == v ? v : parent[v] = find(parent[v]);
}

void dfs(int u) {
    parent[u] = u;
    ancestor[u] = u;
    for (int c : tree[u]) {
        dfs(c);
        parent[c] = u;             // "link": attach child's set under u
        ancestor[find(u)] = u;     // the set containing u has ancestor u
    }
    visited[u] = 1;
    for (auto [v, id] : queries[u])
        if (visited[v]) answer[id] = ancestor[find(v)];  // "eval": LCA(u, v)
}

int main() {
    //        0
    //      /   \
    //     1     2
    //    / \
    //   3   4
    n = 5;
    tree.assign(n, {});
    tree[0] = {1, 2}; tree[1] = {3, 4};
    parent.assign(n, 0); ancestor.assign(n, 0); visited.assign(n, 0);

    vector<array<int,2>> qs = {{3,4},{3,2},{4,0},{3,3}};
    queries.assign(n, {});
    answer.assign(qs.size(), -1);
    for (int i = 0; i < (int)qs.size(); i++) {
        queries[qs[i][0]].push_back({qs[i][1], i});
        queries[qs[i][1]].push_back({qs[i][0], i});
    }

    dfs(0);
    for (int i = 0; i < (int)qs.size(); i++)
        cout << "LCA(" << qs[i][0] << "," << qs[i][1] << ")=" << answer[i] << "\n";
    // prints 1, 0, 0, 3
    return 0;
}
```

[watch from 21:38](https://youtu.be/7nPZulZq_oY?t=1298)

---

## Complexity recap

| Operation | Simple (path compression only) | Balanced virtual tree | Space |
| --- | --- | --- | --- |
| `link(v, w)` | $O(1)$ | $O(\alpha(m,n))$ amortized | $O(n)$ |
| `eval(v)` | $O(\log_{2+m/n} n) \approx O(\log n)$ | $O(\alpha(m,n))$ amortized | — |
| `update(r, x)` | $O(1)$ | $O(\alpha(m,n))$ amortized | — |
| **All $m$ ops total** | $O(m \log n)$ | $O(m\,\alpha(m,n))$ | $O(n)$ |

- $\alpha(m, n)$ is the inverse-Ackermann function — at most 4 or 5 for any conceivable input, so effectively constant.

---

## Practice problems

> **Honest note:** Eval–Link–Update / Link-Eval is an **advanced competitive-programming and research** structure. It does **not** appear in interview rounds. The nearest interview-relevant skill is plain **LCA**; the genuine home of this structure is **offline LCA**, **MST**, and **dominator trees** in competitive and systems settings.

**🎯 Interview (MAANG-style)** — nearest adjacent skill is LCA, not the structure itself.

- [Lowest Common Ancestor of a Binary Tree — LeetCode 236](https://leetcode.com/problems/lowest-common-ancestor-of-a-binary-tree/) — Medium — the online LCA this lecture's offline variant generalizes; know this before touching Link-Eval.
- [Lowest Common Ancestor of a BST — LeetCode 235](https://leetcode.com/problems/lowest-common-ancestor-of-a-binary-search-tree/) — Easy — LCA warm-up using the BST order property.
- [Lowest Common Ancestor in a Binary Tree — GeeksforGeeks](https://www.geeksforgeeks.org/lowest-common-ancestor-binary-tree-set-1/) — Medium — the canonical single-query LCA walkthrough.

**🏆 Competitive** — where the structure actually earns its keep.

- [Company Queries II — CSES 1688](https://cses.fi/problemset/task/1688) — Medium — batched LCA queries on a rooted tree; the offline-LCA payload of this lecture (binary lifting also solves it).
- [Distance Queries — CSES 1135](https://cses.fi/problemset/task/1135) — Medium — path distances reduce to LCA, a natural offline batch for Link-Eval.

---

## Further reading

- [Lowest Common Ancestor — Tarjan's off-line algorithm (cp-algorithms)](https://cp-algorithms.com/graph/lca.html) — the DSU-based offline LCA this structure powers.
- [Disjoint Set Union (cp-algorithms)](https://cp-algorithms.com/data_structures/disjoint_set_union.html) — path compression and the inverse-Ackermann analysis reused here.
- [Disjoint-set data structure — Wikipedia](https://en.wikipedia.org/wiki/Disjoint-set_data_structure) and [Lowest common ancestor — Wikipedia](https://en.wikipedia.org/wiki/Lowest_common_ancestor).
- [Dominator (graph theory) — Wikipedia](https://en.wikipedia.org/wiki/Dominator_(graph_theory)) — one of the algorithms that consumes a Link-Eval structure.
- Original paper: R. E. Tarjan, _Applications of Path Compression on Balanced Trees_ (linked in the video description).

---

## Key takeaways

- Link-Eval is DSU **with labels**: `link` merges (direction fixed), `eval` aggregates labels to the root under an associative $\otimes$, `update` mutates a root label.
- The **10-line** path-compression version — relabel visited nodes so aggregates survive flattening — already gives about $O(\log n)$ and is worth knowing on its own.
- Inverse-Ackermann needs a **balanced virtual tree** giving identical `eval` answers, reachable only when $\otimes$ has **inverses** (sum) or the values are **totally ordered** with $\otimes = \max$.
- The `max` case represents each real tree as a **sorted chain of balanced trees**; `eval` stops at the local root, and `link`/`update` merge trees to keep the amortized bound.
- Balance follows from **good** and **mediocre** edges (each pair at least doubles subtree size), giving the DSU-style rank bound with $\sqrt{2}$ in place of $2$.

## Glossary

- **Label** — the per-node value; `eval` aggregates labels along a root-ward path.
- **`eval` / `link` / `update`** — path aggregate to root / merge two rooted trees (fixed direction) / fold a value into a root's label.
- **Path compression** — flatten a traversed path onto the root, relabelling nodes to preserve `eval`.
- **Virtual tree** — a balanced stand-in tree with the same `eval` answers as the real tree; the real tree is never materialized.
- **Good / mediocre edge** — merge edges that (singly, or in consecutive pairs) at least double subtree size, underpinning the balance bound.
- **$\alpha(m, n)$** — inverse-Ackermann function; effectively a small constant.
