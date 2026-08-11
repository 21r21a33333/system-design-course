---
title: "S02E01 · Segment Tree"
sidebar_position: 1
description: The segment tree from first principles — a full binary tree over an array giving O(log n) point-update and range-query, the recursive query with its two-optimization proof, the 2x+1 / 2x+2 heap layout, min/associative variants, and persistence via path cloning.
---

# S02E01 · Segment Tree

> **Source:** Pavel Mavrin, [_A&DS S02E01_](https://youtu.be/s3bnguhHttM) · 1h27m lecture → ~15 min read.
> Every section deep-links back to the exact moment on the board. This is the opening lecture of Season 2.

## TL;DR

- A **segment tree** solves the *dynamic range query* problem: support `set(i, v)` (change one element) **and** `sum(l, r)` (aggregate a range) both in $O(\log n)$ — something a prefix-sum array cannot do once updates are allowed.
- Build a **full binary tree over the array**: the $n$ leaves are the elements, every internal node stores the aggregate of its two children. Total nodes $= 2n - 1$; height $= \log_2 n$.
- **Point update** walks one leaf-to-root path recomputing $\log n$ nodes. **Range query** is a recursion with two pruning rules (segment fully *outside* → return neutral; fully *inside* → return stored value), which the lecture proves visits only $O(\log n)$ nodes.
- Layout without pointers: number nodes like a **binary heap** — root is `0`, children of `x` are `2x+1` and `2x+2` — and compute each node's covered segment `[lx, rx)` **on the way down** instead of storing it.
- The exact same machine works for **any associative combine** with a **neutral element**: sum/`0`, min/`+∞`, max/`−∞`, gcd/`0`, product, matrix product, bitwise and/or/xor.
- **Persistence** comes almost for free: an update that would touch a root-to-leaf path instead **clones only that path** ($\log n$ new nodes) and shares everything else — giving a *fully persistent* structure where every past version stays queryable.

---

## The problem: dynamic range queries

- Given an array `a[0 .. n-1]`, support two operations:
  - `set(i, v)` — assign `a[i] = v`.
  - `sum(l, r)` — return $\sum_{i=l}^{r-1} a[i]$. The lecture fixes the convention **left-inclusive, right-exclusive** throughout: `l` is included, `r` is not.
- **Warm-up (read-only case).** If the array *never* changes, a **prefix-sum** array answers `sum(l, r)` in $O(1)$: precompute $P[k] = \sum_{i<k} a[i]$, then `sum(l, r) = P[r] - P[l]`.
  - This trick works for any operation with an **inverse** (sum has minus). It **breaks the moment you allow `set`**: one update can invalidate up to $n$ prefix sums, so a rebuild is $O(n)$.
- **Goal:** make *both* `set` and `sum` cost $O(\log n)$ — the segment tree's reason to exist.

![Board header: array a, set(i,v)=O(1) desire vs sum(l,r) over a segment, left-inclusive right-exclusive convention](/img/dsa/s3bnguhHttM/frame-00068.png)

[watch from 3:16](https://youtu.be/s3bnguhHttM?t=196)

---

## What the tree looks like

- Take the array `a = [5, 1, 3, 2, 6, 2, 4, 7]` ($n = 8$). Build a **full binary tree** whose **leaves are the array elements**, and where **each internal node stores the sum of its two children**.
  - Bottom pairs: $5{+}1 = 6$, $3{+}2 = 5$, $6{+}2 = 8$, $4{+}7 = 11$.
  - Next level: $6{+}5 = 11$, $8{+}11 = 19$.
  - Root: $11{+}19 = 30$ — the sum of the whole array.
- **Every node represents a contiguous segment of the array**, and holds the aggregate over that segment:
  - a leaf represents a **length-one** segment (a single element is the sum of itself);
  - the root represents the **whole** array.
- **Total number of nodes** $= n + \tfrac{n}{2} + \tfrac{n}{4} + \cdots + 1 = 2n - 1$. The tree builds bottom-up in $O(n)$.

![Full binary tree over [5,1,3,2,6,2,4,7]: leaves are elements, each parent is the sum of its children, root = 30, annotated 2n-1 nodes](/img/dsa/s3bnguhHttM/frame-00050.png)

- **Height is $\log_2 n$.** Because both operations will only ever walk paths / prunable recursions through this tree, their cost is tied to the height:

$$
\text{height} = \log_2 n \;\Longrightarrow\; \text{set, sum} = O(\log n).
$$

### Why we may assume $n$ is a power of two

- If $n$ is a power of two the tree is **perfectly balanced** — every internal node has exactly two children. That is the only case we implement.
- If $n$ is not a power of two, **pad** the array up to the next power of two $n'$ with neutral elements (0 for sum). Since $n' < 2n$, this at most doubles the size and **does not change the asymptotics**.

![Padding an array of length n up to the next power of two n' = 2^k, with n' ‹ 2n so asymptotics are unaffected](/img/dsa/s3bnguhHttM/frame-00055.png)

[watch from 7:50](https://youtu.be/s3bnguhHttM?t=470)

---

## Point update: `set(i, v)`

- Changing one leaf only affects the nodes **on the path from that leaf to the root** — exactly one node per layer.
- Set the leaf, then walk up recomputing each ancestor as the sum of its two children. That is $\log n$ recomputations.
- Example: set `a[?] = 5` at a leaf, then going up recompute $6{+}5 = 11$, then $11{+}11 = 22$, then $22{+}? = 32$ at the root. Done in $O(\log n)$.

[watch from 16:06](https://youtu.be/s3bnguhHttM?t=966)

---

## Range query: `sum(l, r)` and its two optimizations

- **Idea:** the answer for `[l, r)` is assembled from a handful of **already-stored** node sums whose segments **exactly tile** `[l, r)`.
  - For `[l, r)` covering the middle of the example, the board decomposes it as a single element $5$, plus a stored $11$, plus a stored $4$ → total $5 + 11 + 4 = 20$.
- **Naive traversal** of the whole tree would visit all $2n-1$ nodes → $O(n)$. Two pruning rules fix that. Standing at node `x` covering segment `[lx, rx)`:
  1. **Fully outside** — if `[lx, rx)` does not intersect `[l, r)`, this subtree contributes nothing → **return the neutral element** (0 for sum) immediately.
  2. **Fully inside** — if `[lx, rx)` is entirely within `[l, r)`, the whole subtree's aggregate is already stored at `x` → **return `tree[x]`** without recursing.
  - Otherwise (**partial overlap**) recurse into both children and combine.

![Range query decomposition: the purple segment [l,r) is tiled by stored node sums 5 + 11 + 4 = 20](/img/dsa/s3bnguhHttM/frame-00090.png)

### Why the query visits only $O(\log n)$ nodes

- A node causes a **two-way branch** only when it is *neither* fully inside *nor* fully outside — i.e. when one of the borders `l` or `r` falls **strictly inside** its segment.
- On any single layer, the nodes' segments are **disjoint** and tile the whole range. So each border can be inside **at most one** segment per layer. With two borders and $\log n$ layers, at most $2\log n$ nodes branch.
- Every other visited node hits rule 1 or rule 2 and returns immediately. Counting the branch nodes plus the leaves their branches terminate in, the total visited is $\le 4\log n = O(\log n)$.

![Recursion accounting: at most 2 log n "border" nodes branch (case X), the rest immediately return via optimization 1 or 2 — total O(log n)](/img/dsa/s3bnguhHttM/frame-00120.png)

[watch from 22:33](https://youtu.be/s3bnguhHttM?t=1353)

---

## Implementation: the heap layout

- **Classical option** (mentioned, not used): one `Node` object per node with pointers to left and right children. Universal but heavy — lots of small allocations, extra memory for two pointers each.
- **The lecture's option:** number nodes exactly like a **binary heap**, so the child indices are arithmetic and no pointers are stored.

```cpp
// zero-indexed heap numbering
// root      = 0
// left(x)   = 2*x + 1
// right(x)  = 2*x + 2
```

- We also do **not** store each node's segment `[lx, rx)`. Instead we pass it down the recursion: a node covering `[lx, rx)` splits at `m = (lx + rx) / 2` into a left child `[lx, m)` and a right child `[m, rx)`.

Here is the complete recursive sum segment tree exactly as developed on the board (`build`, `set`, `sum`), wrapped in a small struct:

```cpp
#include <bits/stdc++.h>
using namespace std;

// Recursive array-based segment tree for SUM.
struct SegTreeSum {
    int n;                    // padded size, a power of two
    vector<long long> tree;   // size 2n; nodes numbered heap-style (root = 0)

    SegTreeSum(const vector<long long>& a) {
        n = 1;
        while (n < (int)a.size()) n <<= 1;   // pad up to next power of two
        tree.assign(2 * n, 0);
        build(a, 0, 0, n);
    }

    // Build node x covering [lx, rx) from array a.
    void build(const vector<long long>& a, int x, int lx, int rx) {
        if (rx - lx == 1) {                              // leaf: length-one segment
            tree[x] = (lx < (int)a.size()) ? a[lx] : 0;  // padded slots are neutral (0)
            return;
        }
        int m = (lx + rx) / 2;
        build(a, 2 * x + 1, lx, m);
        build(a, 2 * x + 2, m, rx);
        tree[x] = tree[2 * x + 1] + tree[2 * x + 2];     // combine children
    }

    // ---- public wrappers ----
    void set(int i, long long v)  { set(i, v, 0, 0, n); }
    long long sum(int l, int r)   { return sum(l, r, 0, 0, n); }

    // set a[i] = v, inside subtree x covering [lx, rx)
    void set(int i, long long v, int x, int lx, int rx) {
        if (rx - lx == 1) { tree[x] = v; return; }       // reached the leaf
        int m = (lx + rx) / 2;
        if (i < m) set(i, v, 2 * x + 1, lx, m);          // descend into the half
        else       set(i, v, 2 * x + 2, m, rx);          //   that contains i
        tree[x] = tree[2 * x + 1] + tree[2 * x + 2];     // recompute on the way up
    }

    // sum over [l, r) intersected with node x covering [lx, rx)
    long long sum(int l, int r, int x, int lx, int rx) {
        if (l >= rx || lx >= r) return 0;                // opt 1: fully outside -> neutral
        if (l <= lx && rx <= r) return tree[x];          // opt 2: fully inside  -> stored
        int m = (lx + rx) / 2;                           // partial: split and combine
        long long s1 = sum(l, r, 2 * x + 1, lx, m);
        long long s2 = sum(l, r, 2 * x + 2, m, rx);
        return s1 + s2;
    }
};
```

- **Three parameters carry the geometry:** the node index `x` and its borders `lx`, `rx`. In `set`, the test `i < m` picks the child whose segment contains `i`. In `sum`, the two `if`s are optimizations 1 and 2 above.
- Compile-tested: on `[5,1,3,2,6,2,4,7]`, `sum(2,6)` returns `13`, `sum(0,8)` returns `30`; after `set(4,10)`, `sum(0,8)` returns `34` and `sum(2,5)` returns `15`.

![The full board code: set(i,v,x,lx,rx) recursing on m=(lx+rx)/2 with children 2x+1 / 2x+2, and tree[x] = tree[2x+1] + tree[2x+2]](/img/dsa/s3bnguhHttM/frame-00220.png)

![The full board code for sum(l,r,x,lx,rx): return 0 if disjoint, return tree[x] if inside, else s1+s2 over the two children](/img/dsa/s3bnguhHttM/frame-00240.png)

[watch from 39:53](https://youtu.be/s3bnguhHttM?t=2393)

---

## Beyond sum: min and any associative combine

- Swap the combine function and the neutral element and **everything else stays identical**. For range **minimum**:
  - internal node stores `min` of its children;
  - the neutral element (returned for the "fully outside" empty segment) is $+\infty$, because $\min(x, +\infty) = x$.

```cpp
const long long INF = LLONG_MAX;   // neutral element for min

// Recursive segment tree for MIN — same shape, min instead of +.
struct SegTreeMin {
    int n;
    vector<long long> tree;

    SegTreeMin(const vector<long long>& a) {
        n = 1;
        while (n < (int)a.size()) n <<= 1;
        tree.assign(2 * n, INF);
        build(a, 0, 0, n);
    }
    void build(const vector<long long>& a, int x, int lx, int rx) {
        if (rx - lx == 1) { tree[x] = (lx < (int)a.size()) ? a[lx] : INF; return; }
        int m = (lx + rx) / 2;
        build(a, 2 * x + 1, lx, m);
        build(a, 2 * x + 2, m, rx);
        tree[x] = min(tree[2 * x + 1], tree[2 * x + 2]);   // combine = min
    }
    void set(int i, long long v)   { set(i, v, 0, 0, n); }
    long long query(int l, int r)  { return query(l, r, 0, 0, n); }

    void set(int i, long long v, int x, int lx, int rx) {
        if (rx - lx == 1) { tree[x] = v; return; }
        int m = (lx + rx) / 2;
        if (i < m) set(i, v, 2 * x + 1, lx, m);
        else       set(i, v, 2 * x + 2, m, rx);
        tree[x] = min(tree[2 * x + 1], tree[2 * x + 2]);
    }
    long long query(int l, int r, int x, int lx, int rx) {
        if (l >= rx || lx >= r) return INF;                // neutral = +infinity
        if (l <= lx && rx <= r) return tree[x];
        int m = (lx + rx) / 2;
        return min(query(l, r, 2 * x + 1, lx, m),
                   query(l, r, 2 * x + 2, m, rx));
    }
};
```

- **Exactly three edits** turn the sum tree into the min tree: the `build` combine, the `set` pull-up, and the neutral element on the "outside" branch.
- **The requirement is associativity.** The query reorders the operations — it groups elements by whichever stored nodes tile the range — so the combine $\otimes$ must satisfy

$$
(a \otimes b) \otimes c \;=\; a \otimes (b \otimes c).
$$

  If that holds, the regrouping is safe and the tree returns the correct answer. The neutral element $e$ must satisfy $e \otimes x = x$ so that an empty (outside) segment contributes nothing.

- **Associative combines you can drop in:** min, max, sum, product, gcd, matrix product, modular product, bitwise **and** / **or** / **xor**. (Sometimes each node holds a small tuple combined by a custom rule — you just have to prove *that* rule is associative.)

![min variant: node stores minimum, neutral element is +∞ ("NEUTRAL ELEMENT"), with the associativity law (a⊗b)⊗c = a⊗(b⊗c) that makes any such combine valid](/img/dsa/s3bnguhHttM/frame-00290.png)

[watch from 57:15](https://youtu.be/s3bnguhHttM?t=3435)

---

## Variant: the iterative bottom-up segment tree

- Not from this lecture's board, but the standard companion to the recursive form: pack the tree into an array of size $2n$ where **leaf `i` lives at index `n + i`** and node `i`'s children are `2i` and `2i+1`. Update and query become short loops — smaller constant factor, no recursion.

```cpp
// Iterative bottom-up segment tree for SUM.
struct IterSeg {
    int n;
    vector<long long> t;                  // size 2n; leaf i at t[n + i]

    IterSeg(const vector<long long>& a) {
        n = a.size();
        t.assign(2 * n, 0);
        for (int i = 0; i < n; i++) t[n + i] = a[i];
        for (int i = n - 1; i >= 1; i--) t[i] = t[2 * i] + t[2 * i + 1];
    }
    void update(int i, long long v) {      // a[i] = v
        for (t[i += n] = v; i > 1; i >>= 1)
            t[i >> 1] = t[i] + t[i ^ 1];   // parent = this node + its sibling
    }
    long long query(int l, int r) {        // sum on [l, r)
        long long res = 0;
        for (l += n, r += n; l < r; l >>= 1, r >>= 1) {
            if (l & 1) res += t[l++];       // l is a right child -> take it, move in
            if (r & 1) res += t[--r];       // r is a right child -> take left sibling
        }
        return res;
    }
}; // verified: query(2,6)=13; after update(4,10), query(0,8)=34
```

- Trade-off the lecture flags for the recursive form generally: the iterative version is faster but **less universal** — some problems (lazy propagation, walking down for a k-th element, persistence) need the explicit recursion or explicit nodes.

[watch from 39:53](https://youtu.be/s3bnguhHttM?t=2393)

---

## Persistent segment tree via path cloning

- A **persistent** data structure remembers **all previous versions**: after an update you can still query the state before it.
- **Key observation:** an update only changes the $\log n$ nodes on one **root-to-leaf path**. So instead of overwriting them, **clone just that path** and let the new nodes point at the *old, unchanged* subtrees. Each version is identified by its own **root**.
- Concretely, updating `a[2] = 4` on version `v1`: make a new leaf `4` (old `6` stays), make a new parent `4+5 = 9` pointing to that new leaf and the **shared** old right child, then a new root `13` pointing to the new subtree and the shared left subtree. Old root `15` still describes `v1`; new root `13` describes `v2`.
- Cost: **$\log n$ new nodes per version**, everything else shared. Querying is unchanged — you just start the recursion from the root of the version you want.
- This needs **explicit child pointers** (the `2x+1 / 2x+2` heap trick cannot express sharing, since two versions' nodes would demand the same child index). The persistent update is named `update` here to avoid clashing with `std::set`:

```cpp
#include <bits/stdc++.h>
using namespace std;

// Persistent segment tree for SUM via path cloning.
struct Node {
    long long val;
    Node *left, *right;
    Node(long long v, Node* l, Node* r) : val(v), left(l), right(r) {}
};

int N;                    // padded power-of-two size
vector<long long> base_;  // initial (padded) array

Node* build(int lx, int rx) {
    if (rx - lx == 1)
        return new Node(lx < (int)base_.size() ? base_[lx] : 0, nullptr, nullptr);
    int m = (lx + rx) / 2;
    Node* L = build(lx, m);
    Node* R = build(m, rx);
    return new Node(L->val + R->val, L, R);
}

// Return the root of a NEW version equal to t but with a[i] = v.
Node* update(Node* t, int i, long long v, int lx, int rx) {
    if (rx - lx == 1) return new Node(v, nullptr, nullptr);      // fresh leaf
    int m = (lx + rx) / 2;
    if (i < m) {
        Node* L = update(t->left, i, v, lx, m);                 // clone left path
        return new Node(L->val + t->right->val, L, t->right);   // share right subtree
    } else {
        Node* R = update(t->right, i, v, m, rx);
        return new Node(t->left->val + R->val, t->left, R);     // share left subtree
    }
}

long long sum(Node* t, int l, int r, int lx, int rx) {
    if (l >= rx || lx >= r) return 0;
    if (l <= lx && rx <= r) return t->val;
    int m = (lx + rx) / 2;
    return sum(t->left, l, r, lx, m) + sum(t->right, l, r, m, rx);
}
// v1 = build(0,N); v2 = update(v1, 2, 4, 0, N);
//   sum(v1,...) sees the old array, sum(v2,...) sees the new one — both valid.
```

- **Fully persistent.** You can branch a new version off **any** past version, not just the latest — `update(v1, 0, 10, 0, N)` makes a third version from `v1` while `v2` is untouched. (Verified: `v1` total stays `15`, `v2` = `13`, the `v1`-branch = `22`.)
- **Why pay for it:** some queries need access to historical states; the lecture defers concrete applications to a later week and treats persistence here as "magic that just works."

![Persistence by path cloning: set(2,4) on a=[3,1,6,5] builds a new root 13 sharing subtrees with the old root 15 — only log n new nodes, both versions v1 and v2 live at once](/img/dsa/s3bnguhHttM/frame-00330.png)

![Both versions coexist: query v1 from its root and v2 from its root; each update adds log n new nodes](/img/dsa/s3bnguhHttM/frame-00335.png)

[watch from 1:12:26](https://youtu.be/s3bnguhHttM?t=4346)

---

## Complexity recap

| Operation | Best | Average | Worst | Space |
| --- | --- | --- | --- | --- |
| Build | $\Theta(n)$ | $\Theta(n)$ | $\Theta(n)$ | $\Theta(n)$ |
| `set` / point update | $\Theta(\log n)$ | $\Theta(\log n)$ | $\Theta(\log n)$ | $O(1)$ extra |
| `sum` / range query | $\Theta(1)$ | $\Theta(\log n)$ | $\Theta(\log n)$ | $O(\log n)$ stack |
| Persistent update | $\Theta(\log n)$ | $\Theta(\log n)$ | $\Theta(\log n)$ | $\Theta(\log n)$ new nodes |

- Node array size is $2n$ for the iterative build and up to $4n$ for the recursive/padded build (a common safe allocation when $n$ is not a power of two).

---

## Practice problems

The interview payload here is **"mutable range aggregate"** and the **merge-into-a-tree** counting trick; the competitive payload is raw segment-tree fluency.

**🎯 Interview (MAANG-style)**

- [Range Sum Query - Mutable — LeetCode 307](https://leetcode.com/problems/range-sum-query-mutable/) — Medium — the canonical `set` + `sum(l, r)` this whole lecture builds.
- [Count of Smaller Numbers After Self — LeetCode 315](https://leetcode.com/problems/count-of-smaller-numbers-after-self/) — Hard — a segment/BIT over value-space queried as you scan right-to-left.
- [Reverse Pairs — LeetCode 493](https://leetcode.com/problems/reverse-pairs/) — Hard — count pairs with a segment tree over compressed values (or a merge count).
- [The Skyline Problem — LeetCode 218](https://leetcode.com/problems/the-skyline-problem/) — Hard — range-max updates over an x-coordinate segment tree (or a sweep with a heap).
- [Count Integers in Intervals — LeetCode 2276](https://leetcode.com/problems/count-integers-in-intervals/) — Hard — a segment tree / interval structure maintaining covered length under insertions.
- [Segment Tree — GeeksforGeeks](https://www.geeksforgeeks.org/segment-tree-data-structure/) — Medium — build / update / range-query walkthrough with diagrams.

**🏆 Competitive**

- [Dynamic Range Sum Queries — CSES 1648](https://cses.fi/problemset/task/1648) — Easy/Med — the sum tree, verbatim.
- [Dynamic Range Minimum Queries — CSES 1649](https://cses.fi/problemset/task/1649) — Easy/Med — the min variant, verbatim.
- [Segment tree — cp-algorithms](https://cp-algorithms.com/data_structures/segment_tree.html) — reference implementation plus the standard extensions (lazy propagation, descent, persistence).

---

## Further reading

- [Segment tree — cp-algorithms](https://cp-algorithms.com/data_structures/segment_tree.html) — the definitive competitive-programming treatment.
- [Segment Tree — GeeksforGeeks](https://www.geeksforgeeks.org/segment-tree-data-structure/) — worked build/update/query with pictures.
- [Persistent Segment Tree — GeeksforGeeks](https://www.geeksforgeeks.org/persistent-segment-tree-set-1-introduction/) — the path-cloning construction in detail.
- [Segment tree — Wikipedia](https://en.wikipedia.org/wiki/Segment_tree) — note the naming clash: Wikipedia's "segment tree" is the *computational-geometry* structure (stabbing queries), a different data structure from the competitive-programming one in this lecture.

---

## Key takeaways

- Prefix sums give $O(1)$ range queries but die under updates; the segment tree keeps **both** update and query at $O(\log n)$ by storing partial aggregates in a balanced binary tree.
- **Point update = one root path** ($\log n$ recomputes). **Range query = recursion with two prunes** (outside → neutral, inside → stored value), proven to touch $O(\log n)$ nodes because each of the two range borders lands in at most one node per layer.
- The **heap numbering** (`2x+1`, `2x+2`) plus computing segments on the descent removes all pointers and per-node storage; pad $n$ to a power of two so the tree is perfect.
- The template is **combine-agnostic**: any *associative* operation with a *neutral element* works — you edit three lines.
- **Persistence is path cloning**: share the untouched subtrees, allocate $\log n$ fresh nodes per version, key each version by its root — and you get a fully persistent structure.

## Glossary

- **Segment tree** — full binary tree over an array; each node stores an aggregate of a contiguous segment, giving $O(\log n)$ point update and range query.
- **Neutral element** — the value $e$ with $e \otimes x = x$ returned for an empty/outside segment: `0` for sum, $+\infty$ for min, $-\infty$ for max.
- **Associative operation** — a combine $\otimes$ with $(a \otimes b) \otimes c = a \otimes (b \otimes c)$; the requirement that lets the query regroup elements safely.
- **Heap numbering** — indexing nodes so the root is `0` and node `x`'s children are `2x+1`, `2x+2`, eliminating child pointers.
- **Persistent data structure** — one that preserves all previous versions after each update; **fully persistent** if you can also update *any* past version, not just the latest.
- **Path cloning** — persistence technique that copies only the $O(\log n)$ nodes on the affected root-to-leaf path and shares the rest.
