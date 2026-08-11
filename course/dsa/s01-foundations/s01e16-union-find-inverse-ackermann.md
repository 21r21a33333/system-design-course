---
title: "S01 · Union–Find Complexity (Inverse Ackermann)"
sidebar_position: 16
description: A rigorous point-wise walkthrough of Tarjan's amortized analysis of Union-Find — the partition-into-classes accounting that proves path compression alone runs in a slowly-growing bound, and rank plus path compression run in O(m·α(n)).
---

# S01 · Union–Find Complexity (Inverse Ackermann)

> **Source:** Pavel Mavrin, [_A&DS Bonus 1_](https://youtu.be/ahz0HvV_QYU) · 2h10m lecture → ~18 min read.
> This is the **amortized-analysis / proof** lecture: it does not teach the DSU algorithm (that is the [prerequisite lecture](https://youtu.be/vq5u09x2Kzo)) — it *proves* how fast it runs, following R. E. Tarjan's classical paper. Every section deep-links to the board.

## TL;DR

- The object analysed is **union-by-rank + path compression** DSU. The code is trivial; the running-time proof is the whole lecture.
- We bound the **total** cost of $m$ find operations over $n$ elements as a single amortized sum, not one operation at a time. The bound **decreases** as $m$ grows — more operations make each one cheaper.
- **Trick:** freeze the final tree, freeze each vertex's rank, then charge every traversed edge to a **class** determined by how far apart the endpoint ranks sit inside a family of fast-growing integer sequences.
- **Path compression only** gives total cost $O\!\left(m \cdot \log_{m/n} n\right)$ — which degrades to $O(\log n)$ per op when $m \approx n$ and to $O(1)$ per op when $m \approx n^2$.
- **Union-by-rank + path compression** replaces the arithmetic sequences with the **Ackermann rows** $A[i,j]=A[i-1,\,A[i,j-1]]$; the number of usable rows is the **inverse Ackermann** $\alpha(m,n)$, giving total cost $O(m\cdot\alpha(m,n))$ — effectively constant per operation.
- The two workhorse facts: rank of a parent strictly exceeds rank of its child, and (with rank heuristic) at most $n/2^{k}$ vertices have rank $k$.

---

## The data structure being analysed

- **Two operations.** `find(x)` returns the representative of the set containing $x$; `union(x,y)` merges the two sets. State = a family of disjoint sets, each stored as a **rooted tree** whose root is the representative.
- **`find`**: walk from $x$ up parent pointers to the root.
- **`union`**: `find` both roots, then link one root under the other.
- **Rank heuristic.** Keep a per-node `rank` (an upper bound on subtree height). On `union`, link the **smaller-rank** root under the larger; equal ranks bump the survivor's rank by one. This keeps trees shallow — rank stays $O(\log n)$.
- **Path compression.** During `find`, re-point every node on the traversed path directly at the root. This flattens the tree for future queries.
- **Key subtlety used all lecture:** ranks are **assigned once** on the tree built by unions *without* compression, and **never updated** afterward. Compression changes real heights but we deliberately keep the frozen ranks — the only property we exploit is that **a parent's rank is strictly greater than a child's rank**.

The complete implementation — this is *all* the code; everything below analyses it:

```cpp
#include <bits/stdc++.h>
using namespace std;

struct DSU {
    vector<int> parent, rank_;
    DSU(int n) : parent(n), rank_(n, 0) {
        iota(parent.begin(), parent.end(), 0);   // each element its own set
    }
    // find with path compression: flatten the path toward the root
    int find(int x) {
        while (parent[x] != x) {
            parent[x] = parent[parent[x]];        // path halving
            x = parent[x];
        }
        return x;
    }
    // union by rank: hang the shorter tree under the taller one
    bool unite(int x, int y) {
        x = find(x); y = find(y);
        if (x == y) return false;                 // already in one set
        if (rank_[x] < rank_[y]) swap(x, y);      // x is the taller root
        parent[y] = x;
        if (rank_[x] == rank_[y]) rank_[x]++;     // tie breaks: root grows
        return true;
    }
};
```

![DSU on the board: rank heuristic linking small rank under large with r(x) ≤ r(y), and path compression re-pointing a whole find-path at the root](/img/dsa/ahz0HvV_QYU/frame-00043.png)

*Rank heuristic (top): link so that $r(x)\le r(y)$. Path compression (bottom): a `find` re-points every node on the path directly at the root.*

[watch from 5:37](https://youtu.be/ahz0HvV_QYU?t=337)

---

## Setup: what exactly are we counting

- **Two size parameters.** $n$ = number of elements; $m$ = number of `find` operations. The count of `union` operations is always exactly $n-1$ (each merge drops the set count by one), and each `union` is two `find`s plus a constant link — so **only the `find` cost matters**.
- **Amortized = total ÷ m.** We compute the *total* length of all `find` paths, then divide by $m$. That average is the amortized time per operation.
- **Working range** (chosen only to kill corner cases; the structure works outside it too):

$$
n \le m \le n^2
$$

  - $m < n$ is uninteresting: some element is never touched, drop it.
  - $m > n^2$ is uninteresting: between two `union`s you'd have $>n$ finds, and a repeated `find` of the same node is $O(1)$ the second time (compression already linked it to the root). So extra finds are free.
- **Why the bound decreases in $m$:** each `find` compresses the tree, making later finds cheaper. The final formula is a function of $n$ and $m$ that **shrinks as $m$ grows**.

![Board setup: n elements, n−1 unions, m finds; amortized = total time / m; the working range n ≤ m ≤ n² with the reasons each end is uninteresting](/img/dsa/ahz0HvV_QYU/frame-00096.png)

*Only `find` cost matters; we bound the total path length over all finds and divide by $m$, within $n \le m \le n^2$.*

[watch from 14:22](https://youtu.be/ahz0HvV_QYU?t=862)

---

## The accounting frame: freeze the tree, freeze the ranks

The single idea that makes the proof tractable — reorder the analysis (not the algorithm):

- **Do all unions first (on paper).** Build the entire final forest by performing the $n-1$ unions with **no** path compression. This yields one fixed tree $T^\star$.
- **Assign ranks on $T^\star$** and never change them. So each vertex has a permanent rank, with the invariant $r(\text{parent}) > r(\text{child})$.
- **Now replay the finds.** A `find` issued at some earlier moment does *not* climb to the root of $T^\star$; it climbs to whatever node was the root **at that time**, then compresses. Model this as: the tree has some **solid** edges (currently present) and **dashed** edges (added by later unions). A `find` climbs solid edges up to the first dashed edge, then re-points every visited node at that top vertex.
- **Reduce "total time" to an edge count.** Total find cost $=$ total length of all find-paths. Rewrite as: for each vertex $x$, count how many times a find-path passes **through the edge above $x$**. Sum those counts.

> This is a **potential / accounting** argument: instead of charging each find its full path, we charge each *edge traversal* once and prove each vertex can only be charged a bounded number of times before its edge "graduates" to a cheaper category.

[watch from 20:37](https://youtu.be/ahz0HvV_QYU?t=1237)

---

## Classes: partition edges by rank gap

Pick two magic constants (their values are chosen at the end to optimize the bound):

$$
b = \left\lceil \frac{m}{n} \right\rceil,
\qquad
z = \left\lceil \frac{\log \frac{n^2}{m}}{\log \frac{m}{n}} \right\rceil
$$

Build a family of **sequences**, one per level $j = 0,1,\dots,z$. Sequence $j$ is the arithmetic progression with step $b^{\,j}$:

$$
S_j:\quad 0,\; b^{\,j},\; 2b^{\,j},\; 3b^{\,j},\; \dots
$$

- $S_0 = 0,1,2,3,\dots$ ; $S_1 = 0,b,2b,3b,\dots$ ; $S_2 = 0,b^2,2b^2,\dots$ ; and so on.
- **Each sequence is a subsequence of the previous one:** $S_j$ keeps every $b$-th element of $S_{j-1}$. So between two consecutive values of $S_j$ there are exactly $b-1$ values of $S_{j-1}$.

**Class of an edge $x \to y$** (with $y$ the parent, so $r(x) < r(y)$): the *smallest* level $j$ such that both ranks fall inside one gap of $S_j$:

$$
\text{class}(x\!\to\!y) = \min\Big\{\, j \in [0,z] \;:\; \exists\, k,\ k\,b^{\,j} \le r(x) \le r(y) \le (k{+}1)\,b^{\,j} \Big\}
$$

- Read the ranks as a **segment** $[r(x), r(y)]$ on the number line. Level $j$ partitions the line at multiples of $b^{\,j}$. The class is the coarsest partition (smallest $j$) that stops cutting the segment.
- **If no level $\le z$ contains the segment** (the ranks are too far apart), assign the special class $z+1$. All such "long" edges live together in class $z+1$.

![Class assignment on the board: sequences S₀,S₁,S₂,… of steps 1,b,b²; an edge x→y gets the minimal j with k·bʲ ≤ r(x) ≤ r(y) ≤ (k+1)·bʲ, else class z+1](/img/dsa/ahz0HvV_QYU/frame-00232.png)

*Sequence $j$ has step $b^{\,j}$; each is a subsequence of the previous. An edge's class is the coarsest gap that contains both endpoint ranks.*

[watch from 33:04](https://youtu.be/ahz0HvV_QYU?t=1984)

---

## The charging argument (path compression only)

We split the total cost into three buckets and bound each. On any single find-path:

**Bucket $T_1$ — the last edge of each class.**

- There are $z+1$ classes, so at most $z+1$ edges on a path are the "last edge of their class."
- Charge these directly: $m$ finds $\times\ (z+1)$ last-edges:

$$
T_1 = m\,(z+1)
$$

**Bucket $T_2$ — non-last edges of a normal class $j \le z$.**

- Take an edge $x\to y$ of class $j$ that is *not* the last of class $j$ on its path — so a further edge $u\to y'$ of the same class sits above it. Compression re-points $x$ from $y$ to $y'$.
- Because $x\to y$ is class $j$ (not $j-1$), some value of $S_{j-1}$ lies strictly between $r(x)$ and $r(y)$. Same for the higher edge. After compression, $[r(x), r(y')]$ now contains **at least one more** element of $S_{j-1}$ than before.
- A gap of $S_j$ holds exactly $b-1$ interior values of $S_{j-1}$. So an edge can be compressed **within its class at most $b$ times** before it must jump to class $j+1$.
- A single vertex's edge climbs classes at most $z$ times. With $n$ vertices:

$$
T_2 = n \cdot b \cdot z
$$

**Bucket $T_3$ — the special class $z+1$.**

- Same compression argument: each pass adds an element of $S_z$ between the endpoints. So the cost is the total number of $S_z$-values that can appear, i.e. the count of $S_z$-elements not exceeding the max rank $n$.
- $S_z$ has step $b^{\,z}$, giving

$$
T_3 = n \cdot \frac{n}{b^{\,z}}
$$

![The three-bucket sum on the board: T₁ = m(z+1), T₂ = n·b·z, T₃ = n·n/bᶻ, summed and simplified with b = m/n and z = log(n²/m)/log(m/n)](/img/dsa/ahz0HvV_QYU/frame-00360.png)

*Total $= T_1 + T_2 + T_3 = m(z{+}1) + n b z + n^2/b^{\,z}$. Substituting $b$ and $z$ collapses the last two terms into $O(m)$-scale contributions.*

**Summing and substituting** $b = m/n,\ z = \dfrac{\log(n^2/m)}{\log(m/n)}$:

- $T_2 = n b z = m z$ (since $nb = m$), matching $T_1$'s scale.
- For $T_3$: with $b^{\,z} = (m/n)^{\,z}$ and $(m/n)^{1/\log(m/n)} = 2$, one gets $b^{\,z} = 2^{\log(n^2/m)} = n^2/m$, so $T_3 = n^2 / (n^2/m) = m$.
- **Total** $= O(m\,z) = O\!\left(m \cdot \dfrac{\log(n^2/m)}{\log(m/n)}\right)$.

$$
\boxed{\;T_{\text{path-comp}} = O\!\left(m \cdot \log_{m/n} n\right)\;}
$$

**Sanity checks:**
- $m \approx n$: $\log_{m/n} n \to \log n$, so $O(m\log n)$ total, i.e. $O(\log n)$ per find — the "usual course" bound.
- $m \approx n^2$: $\log_{m/n} n = \log_n n = 1$, so $O(m)$ total, i.e. $O(1)$ per find. The structure gets *faster* the more you use it.

[watch from 56:11](https://youtu.be/ahz0HvV_QYU?t=3371)

---

## Adding the rank heuristic: the Ackermann rows

The identical machinery runs again, but the arithmetic sequences $S_j$ are replaced by **much** faster-growing rows. This is where the inverse Ackermann appears.

**The extra property rank buys us.** With union-by-rank, a vertex of rank $k$ has a subtree of $\ge 2^{k}$ nodes, hence at most $n/2^{k}$ vertices have rank $k$:

$$
r(x) = k \ \Longrightarrow\ |{\rm subtree}(x)| \ge 2^{k},
\qquad
\#\{\,x : r(x)=k\,\} \le \frac{n}{2^{k}}.
$$

**The Ackermann table.** Rows $i=0,1,2,\dots$, columns $j=0,1,2,\dots$:

$$
A[i,j] = A[i-1,\ A[i,\,j-1]],
\qquad
A[0,j] = 2j,\quad A[i,0]=0,\ A[i,1]=2.
$$

- Row 0: $0,2,4,6,8,10,\dots$ (linear).
- Row 1: $0,2,4,8,16,32,\dots$ (powers of two).
- Row 2: $0,2,4,16,2^{16},2^{2^{16}},\dots$ (towers).
- Each row is a subsequence of the previous, and each grows **incomprehensibly faster** than the one above.

![Ackermann rows on the board with the recurrence A[i,j] = A[i−1, A[i,j−1]]: row 0 linear (0 2 4 6…), row 1 powers of two, row 2 towers of exponentials](/img/dsa/ahz0HvV_QYU/frame-00426.png)

*The class sequences are now the Ackermann rows: row $i$ is generated from row $i-1$ by $A[i,j]=A[i-1,A[i,j-1]]$.*

**Inverse Ackermann.** The number of rows you must climb before the values exceed everything relevant is the inverse Ackermann function:

$$
z = \alpha(m,n) = \min\Big\{\, i \;:\; A\!\left[\,i,\ \tfrac{m}{n}\,\right] \ge \log n \,\Big\}
$$

- $\alpha(m,n)$ grows so slowly it is $\le 4$ for every $n$ that can be written in the physical universe.

[watch from 1:38:37](https://youtu.be/ahz0HvV_QYU?t=5917)

---

## The charging argument (rank + path compression)

Same three buckets, re-evaluated with the Ackermann rows and the $n/2^k$ rank-count bound.

**$T_1$ — last edges.** Still one per class per find:

$$
T_1 = m \cdot z = m\,\alpha(m,n).
$$

**$T_2$ — non-last edges, classes $\le z$.** For a class-$i$ edge with endpoints in $[A[i,j],\,A[i,j+1]]$, the number of previous-row partitions inside that gap is at most $A[i,j]$ (its own index in the previous row). But we only need to charge it against the vertices whose ranks land there. Count nodes with rank in that gap using the rank bound, then sum the geometric series:

$$
\sum_{k = A[i,j]}^{A[i,j+1]} \frac{n}{2^{k}}
\ \le\ \frac{2n}{2^{\,A[i,j]}},
$$

and summing over all gaps and rows telescopes to $O(n)$ **per row**. Over $z$ rows:

$$
T_2 = O(n \cdot z) = O(n\,\alpha(m,n)).
$$

- The magic that makes each row cost only $O(n)$: nodes of rank $k$ number $\le n/2^{k}$, so any band of ranks contributes a convergent geometric sum — a constant times $n$.

![The T₂ node-count bound — total nodes with rank in a gap sum to at most 2n over 2 to the A of i comma j, giving O(n) per row, with the alpha of m,n row count and the at-most n over 2 to the k rank-population fact boxed at left](/img/dsa/ahz0HvV_QYU/frame-00492.png)

*Because at most $n/2^{k}$ vertices have rank $k$, the nodes inside any rank-band form a geometric series summing to $O(n)$ — so each of the $\alpha(m,n)$ rows costs only $O(n)$.*

**$T_3$ — class $z+1$.** By construction of $z$, row $z$ has at most $m/n$ elements not exceeding $\log n$ (all ranks are $< \log n$ under the rank heuristic). So each of the $n$ vertices contributes at most $m/n$ compressions:

$$
T_3 = n \cdot \frac{m}{n} = m.
$$

**Total.**

$$
T_1 + T_2 + T_3 = m\,\alpha(m,n) + O(n\,\alpha(m,n)) + m = O\!\big(m \cdot \alpha(m,n)\big)
$$

$$
\boxed{\;T_{\text{rank + path-comp}} = O\!\big(m\cdot\alpha(m,n)\big)\;}
$$

Since $m \ge n$, the $T_1$ term dominates $T_2$, and $\alpha(m,n)$ is a tiny constant in practice — DSU is **effectively linear**.

![Inverse Ackermann definition — z equals alpha of m,n, the least row i with A of i and m over n reaching log n, plus the balanced-tree property that rank k implies subtree at least 2 to the k, so at most n over 2 to the k nodes have rank k](/img/dsa/ahz0HvV_QYU/frame-00465.png)

*The row count $z=\alpha(m,n)$ is defined so row $z$ already exceeds $\log n$; the balanced-tree population bound $\le n/2^{k}$ makes every row cost $O(n)$.*

[watch from 2:00:05](https://youtu.be/ahz0HvV_QYU?t=7205)

---

## Complexity recap

Amortized per-operation cost of `find` under each heuristic combination (over $m$ finds, $n$ elements, $n \le m \le n^2$):

| Variant | Per find (amortized) | Total over m finds | Space |
| --- | --- | --- | --- |
| No heuristics (naive tree) | $O(n)$ worst | $O(mn)$ | $O(n)$ |
| Path compression only | $O\!\left(\log_{m/n} n\right)$ | $O\!\left(m\log_{m/n} n\right)$ | $O(n)$ |
| Union by rank only | $O(\log n)$ | $O(m\log n)$ | $O(n)$ |
| Rank + path compression | $O(\alpha(m,n))$ | $O(m\,\alpha(m,n))$ | $O(n)$ |

- Path-compression-only endpoints: $O(\log n)$ per op at $m\approx n$, down to $O(1)$ at $m\approx n^2$.
- $\alpha(m,n) \le 4$ for all practically representable $n$ — treat rank + compression as constant-time.

---

## Practice problems

**Honest note:** this lecture is a *complexity proof*, not an algorithmic technique — no interview will ask you to reproduce the $\alpha(n)$ accounting. What interviews *do* test is **applying** DSU. The problems below exercise the data structure you just saw analysed; you'll use `find`/`unite`, not prove their runtime.

**🎯 Interview (MAANG-style)**

- [Number of Provinces — LeetCode 547](https://leetcode.com/problems/number-of-provinces/) — Medium — count connected components with one DSU over an adjacency matrix.
- [Redundant Connection — LeetCode 684](https://leetcode.com/problems/redundant-connection/) — Medium — the first edge whose two endpoints already share a set is the cycle edge.
- [Most Stones Removed with Same Row or Column — LeetCode 947](https://leetcode.com/problems/most-stones-removed-with-same-row-or-column/) — Medium — union stones by shared row/column; answer is stones minus components.
- [Number of Connected Components in an Undirected Graph — LeetCode 323](https://leetcode.com/problems/number-of-connected-components-in-an-undirected-graph/) — Medium — the canonical "count sets after unions."

**🏆 Competitive**

- [Road Construction — CSES 1676](https://cses.fi/problemset/task/1676) — Medium — process each new road with a union, tracking component count and current largest component online. Pure union-by-size/rank.
- Codeforces DSU classic: **[Codeforces Round problem 25D "Roads not only in Berland"](https://codeforces.com/problemset/problem/25/D)** — Med — remove edges that close a cycle (detected by DSU) and reconnect the forest.

---

## Further reading

- [Disjoint Set Union — cp-algorithms](https://cp-algorithms.com/data_structures/disjoint_set_union.html) — implementations of both heuristics plus applications.
- [Disjoint-set data structure — Wikipedia](https://en.wikipedia.org/wiki/Disjoint-set_data_structure) — states the $O(\alpha(n))$ result and history.
- [Ackermann function — Wikipedia](https://en.wikipedia.org/wiki/Ackermann_function) — the fast-growing function whose inverse appears here.
- [Introduction to Disjoint Set — GeeksforGeeks](https://www.geeksforgeeks.org/introduction-to-disjoint-set-data-structure-or-union-find-algorithm/) and [Union by Rank and Path Compression — GeeksforGeeks](https://www.geeksforgeeks.org/union-by-rank-and-path-compression-in-union-find-algorithm/).
- R. E. Tarjan, *Efficiency of a Good But Not Linear Set Union Algorithm*, J. ACM 22(2), 1975 — [doi:10.1145/321879.321884](https://dl.acm.org/doi/10.1145/321879.321884) — the primary source the lecture follows (linked from the video description).

---

## Key takeaways

- To analyse an amortized structure, bound the **total** work over all operations and divide — do not chase individual operations.
- The proof engine is an **accounting argument**: freeze the final tree and the ranks, then charge each edge traversal to a **class** and prove each vertex graduates through a bounded number of classes.
- The only structural facts used are $r(\text{parent}) > r(\text{child})$ and, with the rank heuristic, $\le n/2^{k}$ vertices per rank $k$.
- Swapping arithmetic class-sequences for the **Ackermann rows** turns the row count into **inverse Ackermann** $\alpha(m,n)$ — a constant $\le 4$ in practice.
- Bottom line: rank + path compression is $O(m\,\alpha(m,n))$, effectively $O(1)$ per operation.

## Glossary

- **Rank** — a per-node integer, upper-bounding subtree height, assigned on the compression-free tree and never changed in the proof.
- **Path compression** — during `find`, re-point traversed nodes directly at the root.
- **Union by rank** — link the smaller-rank root under the larger to keep trees shallow.
- **Amortized cost** — total cost of a sequence divided by the number of operations.
- **Class of an edge** — the coarsest sequence-gap (smallest level) whose interval contains both endpoint ranks; drives the charging argument.
- **Ackermann function $A[i,j]$** — $A[i,j]=A[i-1,A[i,j-1]]$; each row grows dramatically faster than the previous.
- **Inverse Ackermann $\alpha(m,n)$** — the number of Ackermann rows needed to exceed $\log n$; the growth rate of DSU's amortized cost.
