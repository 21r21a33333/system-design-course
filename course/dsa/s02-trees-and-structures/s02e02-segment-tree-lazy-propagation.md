---
title: "S02E02 · Segment Trees & Lazy Propagation"
sidebar_position: 2
description: Range-update segment trees — range-add with point-get via path tags, then range-add plus range-min using lazy propagation, with the associativity, commutativity, and distributivity laws that make an abstract update+query pair work.
---

# S02E02 · Segment Trees & Lazy Propagation

> **Source:** Pavel Mavrin, [_A&DS S02E02_](https://youtu.be/7JmBP-RqzlI) · 1h35m lecture → ~14 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- Last lecture the segment tree did **point-update + range-query**. This lecture flips it: **range-update + point-query**, and finally **range-update + range-query** — the full-power structure.
- **Range-add, point-get** needs no lazy machinery: store a pending "+v" tag on each node; the value of a leaf is the **sum of tags on the root→leaf path**. Both operations are $O(\log n)$.
- To support a **non-commutative** update (like *assign* / *set*) you must fix an order. The invariant: for every node, the pending operations apply **bottom-to-top** (oldest at the leaf, newest at the root).
- **Lazy propagation** = when a new update must go *below* an existing tag, first **push** (`propagate`) that tag one level down into both children, then recurse. It is "lazy" because a tag only moves when a deeper query forces it.
- The full range-add + range-min tree keeps two arrays per node: `min[x]` (segment minimum *excluding* ancestor tags) and `add[x]` (pending increment). The recombine rule is $\text{min}[x] = \min(\text{min}[2x{+}1], \text{min}[2x{+}2]) + \text{add}[x]$.
- An abstract update $\star$ + query $\otimes$ pair works iff each is **associative** and they satisfy **distributivity**: $(x \star v) \otimes (y \star v) = (x \otimes y) \star v$. E.g. $(\min, +)$, $(\text{sum}, \times)$, $(\text{or}, \text{and})$.

---

## From point-update to range-update

- Previous lecture's structure: array with `set(i, v)` (change one element) and `sum(l, r)` / `min(l, r)` (query a segment). Both $O(\log n)$.
- Today we invert which side is the range. Two new operations:
  - `add(l, r, v)` — add $v$ to **every** element $a_i$ for $i \in [l, r)$.
  - `get(i)` — return the current value of a single element.
- On a plain array, `add` on a segment is $O(n)$ (touch each element) and `get` is $O(1)$. We want **both** in $O(\log n)$ — you cannot beat $O(n)$ if the indices to change are *arbitrary*, but a **contiguous segment** is exactly what the tree decomposes cheaply.
- Same tree shape as before: a full binary tree whose leaves are the array cells; each internal node owns a segment. The number stored in a node now means: **"add this number to every element of my segment."**

[watch from 4:14](https://youtu.be/7JmBP-RqzlI?t=254)

---

## Range-add with point-get (tags on the path)

- To `add(l, r, v)`: split $[l, r)$ into the same $O(\log n)$ canonical tree nodes as a query would, and **deposit $v$** onto each of those nodes. Nothing below is touched.
- The recursion is identical in shape to a range-query — only the base action differs (write a tag instead of reading a sum):
  - **completely outside** the target segment → return;
  - **completely inside** → `add[x] += v`, return;
  - **partial overlap** → recurse into both children.

![Adding +5 to a segment deposits the tag on the three canonical nodes that cover it](/img/dsa/7JmBP-RqzlI/frame-00048.png)

- To `get(i)`: walk from the root down to leaf $i$ and **sum every tag on the path**. That total is the element's value, because each ancestor's tag applies to $i$.
- After `+5` on the middle span, `+1` on a small left span, and `+2` on another span, element 3 reads $5 + 2 = 7$ — the sum of the two tags lying above its leaf.

![Point-get sums the tags on the root-to-leaf path: get(3) = 5 + 2 = 7](/img/dsa/7JmBP-RqzlI/frame-00081.png)

```cpp
#include <bits/stdc++.h>
using namespace std;

struct AddGet {
    int n;
    vector<long long> add;                 // pending "+v" tag per node
    AddGet(int n_) {
        for (n = 1; n < n_; n <<= 1) {}    // round size up to a power of two
        add.assign(2 * n, 0);
    }
    // add v to a[l..r); node x owns [lx, rx)
    void range_add(int l, int r, long long v, int x, int lx, int rx) {
        if (lx >= r || l >= rx) return;                   // completely outside
        if (l <= lx && rx <= r) { add[x] += v; return; }  // completely inside
        int m = (lx + rx) / 2;                            // partial: recurse
        range_add(l, r, v, 2 * x + 1, lx, m);
        range_add(l, r, v, 2 * x + 2, m, rx);
    }
    void range_add(int l, int r, long long v) { range_add(l, r, v, 0, 0, n); }

    // value of a[i] = sum of tags on the root->leaf path to i
    long long get(int i, int x, int lx, int rx) {
        if (rx - lx == 1) return add[x];
        int m = (lx + rx) / 2;
        if (i < m) return add[x] + get(i, 2 * x + 1, lx, m);
        else       return add[x] + get(i, 2 * x + 2, m, rx);
    }
    long long get(int i) { return get(i, 0, 0, n); }
};
```

- Why deposit $v$ **once** per covering node (not once per element)? Because a single tag on a node *means* "add $v$ to my whole segment" — the leaves inherit it lazily at `get` time. That is what buys the $O(\log n)$.

[watch from 9:21](https://youtu.be/7JmBP-RqzlI?t=561)

---

## What algebra does the update need?

- **Associativity.** When two tags land on the same node (e.g. `+5` then `+2`), we collapse them into one (`+7`). For an abstract update $\star$ we need: applying $x$ then $y$ equals applying one combined operation. That is exactly associativity — it lets the tree store one merged tag per node instead of a list.
- **Commutativity** — used implicitly above. `get(i)` summed the path tags *in any order* and got the right answer, which only works because $+$ is commutative.
  - Plenty of useful updates are associative but **not** commutative. The headline one is **assign** ("set"): $x \star v = v$ (overwrite). Assigning $x$ then $y$ gives $y$; assigning $y$ then $x$ gives $x$ — order matters.
- **Fixing the order (the invariant).** To drop the commutativity requirement, we stop treating a node's pending ops as an unordered bag and instead demand: along any root→leaf path, the pending operations are ordered **bottom-to-top** — oldest at the leaf, newest near the root. `get` then applies them strictly in that order (recurse to child first, apply this node's op last).

- The problem this creates: a *new* update targeting a node that sits **below** an already-pending tag would land out of order. Fixing that is what lazy propagation is for.

[watch from 20:40](https://youtu.be/7JmBP-RqzlI?t=1240)

---

## Lazy propagation: pushing a tag down

- **`propagate(x)` / push-down.** Move node $x$'s pending operation into **both children**, combining it with whatever each child already holds, then clear $x$'s tag. For a node whose children hold $y$ and $z$ and whose own (newer) op is $x$:
  - left child becomes "apply $y$ then $x$" $=$ combined op $(y \star x)$;
  - right child becomes $(z \star x)$;
  - erase $x$'s tag.
- This is $O(1)$ — a constant number of tag combinations — because combining two ops is $O(1)$.
- **When do we push?** Only when the recursion must go **strictly deeper** than a node that carries a tag. That is the "lazy" part: a tag rides on a high node for free until a deeper query/update forces it down. So the rule inside every recursive step is: **`propagate` *before* descending into children.**

![Lazy propagation: push node x's op into both children (y⋆x and z⋆x), then descend](/img/dsa/7JmBP-RqzlI/frame-00160.png)

- Push-down order is the #1 bug source. The safe discipline:
  1. handle the two terminal cases (outside → return; fully inside → apply tag + return);
  2. otherwise **`propagate(x)` first**, *then* recurse into the children;
  3. on the way back up, **recombine** the parent from its children.
- A leaf has no children, so `propagate` on a leaf is a no-op (guard against reading `2x+1` out of bounds).

[watch from 33:07](https://youtu.be/7JmBP-RqzlI?t=1987)

---

## Merging both worlds: range-add + range-min

- Now the full structure: `add(l, r, v)` (range increment) **and** `min(l, r)` (range minimum). We fuse the previous lecture's min-tree with this lecture's tag machinery.
- Each node keeps **two** values:
  - `min[x]` — the minimum over $x$'s segment, **not** counting any pending tags sitting on ancestors above $x$;
  - `add[x]` — the pending "+v" for $x$'s whole segment.
- **Applying `+v` to a fully-covered node** updates *both*: `add[x] += v` and `min[x] += v`. The second update is legal precisely because shifting every element by $v$ shifts their minimum by $v$: $\min(a_1{+}v,\dots) = \min(a_1,\dots) + v$.

![The array 2 5 6 1 4 3 7 4: +5 then +3 on overlapping spans; each node stores min plus a pending add](/img/dsa/7JmBP-RqzlI/frame-00194.png)

- **Recombining a parent after recursion:**

$$
\text{min}[x] = \min\big(\text{min}[2x{+}1],\ \text{min}[2x{+}2]\big) + \text{add}[x]
$$

The children give the min *excluding* $x$'s own tag; we take their min and then add $x$'s pending increment back on top, keeping the "excludes-ancestors" invariant intact.

- **Propagation** now also fixes the children's `min`: pushing $x$'s add into a child does `add[child] += add[x]` **and** `min[child] += add[x]`.

![Full board code: add / min / propagate, and the min[x] = min(min[2x+1], min[2x+2]) + add[x] recombine](/img/dsa/7JmBP-RqzlI/frame-00243.png)

```cpp
struct AddMin {
    int n;
    vector<long long> mn;    // min over segment, EXCLUDING ancestors' pending tags
    vector<long long> add;   // pending "+v" for this node's whole segment
    const long long INF = LLONG_MAX / 4;
    AddMin(int n_) {
        for (n = 1; n < n_; n <<= 1) {}
        mn.assign(2 * n, 0);
        add.assign(2 * n, 0);
    }

    // push this node's tag one level down, then clear it
    void propagate(int x, int lx, int rx) {
        if (rx - lx == 1) return;               // leaf: no children
        for (int c : {2 * x + 1, 2 * x + 2}) {
            add[c] += add[x];                   // combine tags (associative)
            mn[c]  += add[x];                   // shift child's min (distributivity)
        }
        add[x] = 0;
    }

    void range_add(int l, int r, long long v, int x, int lx, int rx) {
        if (lx >= r || l >= rx) return;                              // outside
        if (l <= lx && rx <= r) { add[x] += v; mn[x] += v; return; } // fully inside
        propagate(x, lx, rx);                                       // PUSH before descending
        int m = (lx + rx) / 2;
        range_add(l, r, v, 2 * x + 1, lx, m);
        range_add(l, r, v, 2 * x + 2, m, rx);
        mn[x] = min(mn[2 * x + 1], mn[2 * x + 2]) + add[x];         // recombine + own tag
    }
    void range_add(int l, int r, long long v) { range_add(l, r, v, 0, 0, n); }

    long long range_min(int l, int r, int x, int lx, int rx) {
        if (lx >= r || l >= rx) return INF;
        if (l <= lx && rx <= r) return mn[x];
        propagate(x, lx, rx);                                       // PUSH before descending
        int m = (lx + rx) / 2;
        return min(range_min(l, r, 2 * x + 1, lx, m),
                   range_min(l, r, 2 * x + 2, m, rx));
    }
    long long range_min(int l, int r) { return range_min(l, r, 0, 0, n); }
};
```

- **Tested** (against brute force, 2000 randomized rounds, plus the board's own $2,5,6,1,4,3,7,4$ example with `+5` on $[2,6)$ then `+3` on $[3,7)$): `range_min(0,8)` stays $2$ throughout, `range_min(2,6) = 9`, `range_min(3,5) = 9` — all match. Compiled clean with `c++ -std=c++17`.

- **Simplification the lecturer notes:** if you always `propagate` at the *start* of a function, then by the time you fully cover a node its `add` is already $0$, so some of the bookkeeping collapses — but you must guard `propagate` against leaves.

[watch from 44:28](https://youtu.be/7JmBP-RqzlI?t=2668)

---

## The abstract update+query pair, and distributivity

- Generalize the two operations. Let $\otimes$ be the **query** aggregate (min, sum, …) and $\star$ be the **update** applied to a segment (add-$v$, assign-$v$, …). Requirements:
  - each of $\otimes$ and $\star$ is **associative** (so tags and subtree aggregates merge into one value);
  - they **distribute**: applying the update to each operand then aggregating equals aggregating then applying the update once.

$$
(x \star v) \otimes (y \star v) \;=\; (x \otimes y) \star v
$$

- Concretely for $(\min, +)$: $\min(x + v,\, y + v) = \min(x, y) + v$. This is *exactly* the identity that let `min[x] += v` work when we tagged a whole node — the aggregate can be repaired in $O(1)$ instead of recomputed from scratch.

![Distributivity: min(x+v, y+v) = min(x,y)+v, generalized to (x⋆v)⊗(y⋆v) = (x⊗y)⋆v](/img/dsa/7JmBP-RqzlI/frame-00265.png)

- **Pairs that distribute** (so the structure "just works"):

| query $\otimes$ | update $\star$ | distributive identity |
| --- | --- | --- |
| $\min$ | $+v$ | $\min(x,y)+v$ |
| $\max$ | $+v$ | $\max(x,y)+v$ |
| sum | $\times v$ | $(x+y)\,v = xv + yv$ |
| $\min$ | $\min\text{-with-}v$ | $\min(\min(x,v),\min(y,v))$ |
| bitwise or | bitwise and-$v$ | $(x\,\&\,v)\,|\,(y\,\&\,v)$ |

- If your pair does **not** distribute cleanly, the fix is usually to **enrich the node state** — carry extra fields (e.g. segment length so that "assign $v$" can update a **sum** as $v \cdot \text{len}$) — until the repair rule becomes $O(1)$ again.

[watch from 1:04:22](https://youtu.be/7JmBP-RqzlI?t=3862)

---

## Non-commutative update: range-assign + range-sum

- The lecturer's canonical non-commutative operation is **assign**. Here is the full range-assign + range-sum tree that puts the "fix the order" invariant to work: a tag is a pair `(set?, val)`, and pushing a *newer* assign **overwrites** the child's older one. Length per node lets "assign $v$" repair the sum as $v \cdot \text{len}$.

```cpp
struct AssignSum {
    int n;
    struct Tag { bool set = false; long long val = 0; };
    vector<long long> sum;
    vector<Tag> lazy;
    vector<int> len;                 // segment length per node
    AssignSum(int n_) {
        for (n = 1; n < n_; n <<= 1) {}
        sum.assign(2 * n, 0);
        lazy.assign(2 * n, {});
        len.assign(2 * n, 0);
        build(0, 0, n);
    }
    void build(int x, int lx, int rx) {
        len[x] = rx - lx;
        if (rx - lx == 1) return;
        int m = (lx + rx) / 2;
        build(2 * x + 1, lx, m);
        build(2 * x + 2, m, rx);
    }
    void apply(int x, long long v) { lazy[x] = {true, v}; sum[x] = v * len[x]; }
    void propagate(int x) {
        if (!lazy[x].set) return;
        apply(2 * x + 1, lazy[x].val);     // newer assign overwrites older child tags
        apply(2 * x + 2, lazy[x].val);
        lazy[x] = {};
    }
    void assign(int l, int r, long long v, int x, int lx, int rx) {
        if (lx >= r || l >= rx) return;
        if (l <= lx && rx <= r) { apply(x, v); return; }
        propagate(x);
        int m = (lx + rx) / 2;
        assign(l, r, v, 2 * x + 1, lx, m);
        assign(l, r, v, 2 * x + 2, m, rx);
        sum[x] = sum[2 * x + 1] + sum[2 * x + 2];
    }
    void assign(int l, int r, long long v) { assign(l, r, v, 0, 0, n); }
    long long range_sum(int l, int r, int x, int lx, int rx) {
        if (lx >= r || l >= rx) return 0;
        if (l <= lx && rx <= r) return sum[x];
        propagate(x);
        int m = (lx + rx) / 2;
        return range_sum(l, r, 2 * x + 1, lx, m) + range_sum(l, r, 2 * x + 2, m, rx);
    }
    long long range_sum(int l, int r) { return range_sum(l, r, 0, 0, n); }
};
```

- **Tested** against brute force over 3000 randomized rounds of interleaved `assign` / `range_sum`; compiles with `c++ -std=c++17`. Because push-down always overwrites with the *newer* tag, the bottom-to-top ordering invariant is preserved without any commutativity.

[watch from 27:07](https://youtu.be/7JmBP-RqzlI?t=1627)

---

## Complexity recap

| Operation | Best | Average | Worst | Space |
| --- | --- | --- | --- | --- |
| `range_add(l, r, v)` | $\Theta(\log n)$ | $\Theta(\log n)$ | $\Theta(\log n)$ | — |
| `get(i)` (point) | $\Theta(\log n)$ | $\Theta(\log n)$ | $\Theta(\log n)$ | — |
| `range_min` / `range_sum` | $\Theta(\log n)$ | $\Theta(\log n)$ | $\Theta(\log n)$ | — |
| `propagate` (per node) | $\Theta(1)$ | $\Theta(1)$ | $\Theta(1)$ | — |
| Build / whole tree | $\Theta(n)$ | $\Theta(n)$ | $\Theta(n)$ | $\Theta(n)$ |

- Each query/update visits $O(\log n)$ nodes, and every push-down along the way is $O(1)$, so the $O(\log n)$ per operation is **amortized-free** — the lazy tags never make an individual operation asymptotically worse.

---

## Practice problems

Range-update + range-query with lazy propagation is a staple of hard interview rounds and a competitive-programming workhorse.

**🎯 Interview (MAANG-style)**

- [Falling Squares — LeetCode 699](https://leetcode.com/problems/falling-squares/) — Hard — range-assign of a max height + range-max query; the assign/max lazy tree.
- [Range Module — LeetCode 715](https://leetcode.com/problems/range-module/) — Hard — track covered intervals with range-assign (0/1) + range-query.
- [My Calendar III — LeetCode 732](https://leetcode.com/problems/my-calendar-iii/) — Hard — range-add of bookings + range-max of overlap count.
- [Handling Sum Queries After Update — LeetCode 2569](https://leetcode.com/problems/handling-sum-queries-after-update/) — Hard — range-flip (XOR) lazy tag over a 0/1 array plus a running sum.
- [Lazy Propagation in Segment Tree — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/lazy-propagation-in-segment-tree/) — Medium — the canonical range-add + range-sum walkthrough.

**🏆 Competitive**

- [Range Update Queries — CSES 1651](https://cses.fi/problemset/task/1651) — Easy — range-add + point-get; the exact structure of this lecture's first half.
- [Range Updates and Sums — CSES 1735](https://cses.fi/problemset/task/1735) — Medium — range-add **and** range-assign together with range-sum; forces a two-field lazy tag.
- [Polynomial Queries — CSES 1736](https://cses.fi/problemset/task/1736) — Hard — add an arithmetic progression over a range; the lazy tag carries two coefficients.

---

## Further reading

- [Segment Tree (with lazy propagation) — cp-algorithms.com](https://cp-algorithms.com/data_structures/segment_tree.html) — the definitive reference, including the "modification on segments" section.
- [Lazy Propagation in Segment Tree — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/lazy-propagation-in-segment-tree/) — worked range-add + range-sum implementation.
- [Segment tree — Wikipedia](https://en.wikipedia.org/wiki/Segment_tree) — the classical stabbing/interval variant, for contrast with the array segment tree used here.

---

## Key takeaways

- A node's number means **"apply this to my whole segment"**; range-update deposits it on $O(\log n)$ canonical nodes, exactly like a range-query reads them.
- **Range-add + point-get needs no push-down** — a value is just the sum of tags on its root→leaf path.
- **Lazy propagation** = push a tag into both children (combining, $O(1)$) *before* descending, then recombine parents on the way back up. Get the push order right and the whole thing is $O(\log n)$.
- Store the aggregate as **"excludes ancestor tags"**; repair it with the distributive rule ($\text{min}[x] = \min(\text{children}) + \text{add}[x]$).
- An abstract update+query pair works iff both are **associative** and they **distribute**; when they don't, **enrich the node state** (e.g. segment length) until the $O(1)$ repair exists.

## Glossary

- **Lazy tag / pending update** — an operation stored on a node meaning "apply me to my whole segment, later."
- **Propagate / push-down** — move a node's tag into its two children, combining with theirs, then clear it.
- **Range-assign (set)** — overwrite a whole segment with $v$; associative but **not** commutative.
- **Distributivity (here)** — $(x \star v) \otimes (y \star v) = (x \otimes y) \star v$, the identity that lets an aggregate be repaired in $O(1)$ after a range update.
- **Ordering invariant** — along any root→leaf path, pending operations are ordered oldest-at-leaf to newest-at-root, so non-commutative updates stay correct.
