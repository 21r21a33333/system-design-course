---
title: "S01E08 · Disjoint Sets (Union–Find)"
sidebar_position: 8
description: The disjoint-set forest, find and union, union by rank/size, path compression, and the near-constant inverse-Ackermann amortized bound with a full iterated-log proof.
---

# S01E08 · Disjoint Sets (Union–Find)

> **Source:** Pavel Mavrin, [_A&DS S01E08_](https://youtu.be/vq5u09x2Kzo) · 1h47m lecture → ~14 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- A **disjoint-set** structure maintains a partition of $n$ objects into non-overlapping sets and supports two operations: `union(x, y)` merges the sets containing $x$ and $y$, and `find(x)` returns a canonical **representative** of $x$'s set.
- Two elements are in the same set iff `find` returns the **same** representative — that is the entire interface.
- A naive **representative array** gives $O(1)$ `find` but $\Theta(n^2)$ total work for the $n-1$ unions. Adding per-set lists plus **union by size** (move the smaller set) drops the total to $\Theta(n \log n)$ — the *small-to-large merging* trick that recurs all over competitive programming.
- The fast structure stores each set as a **tree** whose root is the representative; `find` walks parent pointers to the root. **Union by rank** keeps trees balanced so rank $\le \log_2 n$, and **path compression** re-hangs every node visited by `find` directly under the root.
- With **both** heuristics the amortized cost of `find` is $O\big(\alpha(m, n)\big)$, the **inverse Ackermann** function — effectively constant. We state it precisely, prove the weaker $O(\log^* n)$ bound in full, and defer the full $\alpha$ proof to a later lecture.

---

## What a disjoint-set structure is

- Fix $n$ objects (here $1, 2, \dots, 7$). They are partitioned into **disjoint sets** — each object lives in exactly one set.
- Two operations, and only two:
  - `union(x, y)` — take the set containing $x$ and the set containing $y$ and merge them into one.
  - `find(x)` — return *which set* contains $x$.
- **Trick to avoid a second object type.** Rather than returning a whole set, mark one element of each set as its **representative** and return that. `find` is required to return the *same* representative for every element of a given set.
- So to test "are $x$ and $y$ in the same set?" you compute `find(x) == find(y)`. No separate set object is ever needed.

![Seven objects grouped into disjoint sets, titled Disjoint Sets / Union–Find](/img/dsa/vq5u09x2Kzo/frame-00015.png)

*The board's running example: objects 1..7 split into sets like $\{1,2,5\}$, $\{3,6\}$, $\{4,7\}$; one element per set is circled as its representative.*

[watch from 1:33](https://youtu.be/vq5u09x2Kzo?t=93)

---

## Version 1 — the representative array

- Keep a single array `p` of length $n$ where `p[x]` is the representative of the set containing `x`.
- `find` is a direct array lookup — $O(1)$.
- `union(x, y)` picks one representative (say `y`) to survive, then rewrites every entry equal to the other representative:

```cpp
vector<int> p;                        // p[x] = representative of x (1-indexed; p[0] unused)
int n;

void init(int n_) { n = n_; p.resize(n + 1); iota(p.begin(), p.end(), 0); }

int find(int x) {
    return p[x];                      // O(1)
}

void unite(int x, int y) {
    x = find(x);                      // representative of x's set
    y = find(y);                      // representative of y's set
    for (int i = 1; i <= n; i++)      // scan every element  -> O(n)
        if (p[i] == x)
            p[i] = y;                 // re-point x's set at y
}
```

- **Data structure / invariant:** `p[i]` always equals the representative of `i`'s set; every element of a set shares the same value.
- **Cost:** `find` is $\Theta(1)$; `union` is $\Theta(n)$ because of the scan.

![Array p = [5,5,3,7,5,3,7], the find and union code, with O(1) find and O(n) union](/img/dsa/vq5u09x2Kzo/frame-00056.png)

*The representative array and the two routines exactly as written on the board.*

[watch from 12:36](https://youtu.be/vq5u09x2Kzo?t=756)

### How many unions can happen, and the total cost

- We start with $n$ singleton sets, and **each** `union` reduces the set count by one. So there are at most $n-1$ unions over the whole lifetime.
- Because the number of operations is fixed at $n-1$, the natural quantity is the **total** time of all unions (a simple case of amortized analysis), not the cost of one call.
- Worst case: union $1{,}2$, then $2{,}3$, then $3{,}4$, … The $k$-th union rescans and repaints $k$ elements, so the total is $1 + 2 + \dots + (n-1) = \Theta(n^2)$.

![Per-set adjacency lists for representatives 3, 5, 7; note find is O(1), union O(n), total O(n squared)](/img/dsa/vq5u09x2Kzo/frame-00079.png)

*The board keeps, for each representative, the list of its members — the setup for the next optimization — alongside the $\Theta(n^2)$ total verdict.*

[watch from 18:11](https://youtu.be/vq5u09x2Kzo?t=1091)

---

## Version 2 — per-set lists + union by size

- The scan in `union` is wasteful: we only need the elements whose representative equals `x`. So maintain, for each representative, an explicit **list of its members**.
- Now `union` iterates just that list instead of the whole array. But this alone is still $\Theta(n)$ per call in the worst case (one giant set), and the same bad ordering as before still forces $\Theta(n^2)$ total.
- **The fix — union by size (small-to-large).** When merging, always move the elements of the **smaller** set into the larger one. Swap `x` and `y` so that `x` names the smaller set:

```cpp
vector<int> p;
vector<vector<int>> lists;            // lists[r] = members of the set whose rep is r

void init(int n) {
    p.resize(n + 1); iota(p.begin(), p.end(), 0);
    lists.assign(n + 1, {});
    for (int i = 0; i <= n; i++) lists[i] = {i};
}

int find(int x) {
    return p[x];
}

void unite(int x, int y) {
    x = find(x);
    y = find(y);
    if (x == y)
        return;
    if (lists[x].size() > lists[y].size())  // ensure x is the SMALLER set
        swap(x, y);
    for (int i : lists[x]) {           // move each smaller-set member into y
        p[i] = y;
        lists[y].push_back(i);
    }
    lists[x].clear();                  // free the emptied list
}
```

- **Data structure / invariant:** `p[i]` is the representative; `lists[r]` holds exactly the members of the set represented by `r` (and is empty when `r` is not a representative).

![Analysis sketch: an element's set size is at least 2, then 4, then 8… each move at least doubles it, so O(log n) moves per element](/img/dsa/vq5u09x2Kzo/frame-00155.png)

*The doubling argument: track one element $x$ across its lifetime; each time it is moved, it lands in a set at least twice as large.*

### Why the total is now $\Theta(n \log n)$

- Charge the work to **element moves**. `union` costs one move per element of the smaller set.
- Fix an element $x$ and count how often it is moved. When $x$ is moved, its set was the *smaller* of the two being merged, so the resulting set is **at least twice** the size of $x$'s old set.
- Starting from size $1$, the size of $x$'s set can double at most $\log_2 n$ times. Hence $x$ is moved $O(\log n)$ times.
- Summed over all $n$ elements: $O(n \log n)$ total moves, so $O(n \log n)$ total union time. `find` stays $O(1)$.
- **Why this matters beyond union–find:** the same "always move the smaller collection into the bigger one" idea makes *any* mergeable structure (heaps, maps, subtree data on a tree) cost $O(\log n)$ merges per element — the technique later known as **DSU on tree / small-to-large**.

[watch from 27:10](https://youtu.be/vq5u09x2Kzo?t=1630)

---

## Version 3 — the disjoint-set forest

- Represent each set as a **rooted tree** whose **root is the representative**. Every node stores a pointer to its **parent**; the root points to **itself** (a convenient sentinel that keeps the code branch-free).
- One array is enough: `p[x]` is the parent of `x`.

![Forest of three trees with self-looping roots 2, 3, 8; parent array p = [2,2,1,3,3,5,8,8]](/img/dsa/vq5u09x2Kzo/frame-00190.png)

*Each set is a tree; the root loops to itself. The array `p` stores parent pointers, e.g. `p[6]=5`, `p[5]=3`, `p[3]=3` (root).*

- **`find(x)`** walks parent pointers up to the root:

```cpp
vector<int> p;           // every element starts as its own root

void init(int n) { p.resize(n + 1); iota(p.begin(), p.end(), 0); }

int find(int x) {
    while (p[x] != x)    // root is the unique self-parent
        x = p[x];
    return x;
}
```

- **`union(x, y)`** finds both roots and hangs one under the other — constant work on top of the two `find`s:

```cpp
void unite(int x, int y) {
    x = find(x);
    y = find(y);
    if (x != y)
        p[x] = y;        // hang root x under root y
}
```

- **Cost so far:** `union` costs the same as `find` plus $O(1)$. But a bad merge order builds a **bamboo** (a single long path), so `find` can degrade to $\Theta(n)$ — exactly the situation we spent the whole lecture avoiding.

[watch from 46:03](https://youtu.be/vq5u09x2Kzo?t=2763)

---

## Union by rank — keeping the forest shallow

- Assign each node a **rank**: the height of its subtree (longest downward path to a leaf). Fresh singletons have rank $0$.
- On `union`, attach the **lower-rank** root under the **higher-rank** root. Swap so `x` is the smaller-rank root; then:
  - If $\operatorname{rank}(x) < \operatorname{rank}(y)$: attaching $x$ under $y$ leaves $y$'s longest path at $\operatorname{rank}(y)$ (since $\operatorname{rank}(x)+1 \le \operatorname{rank}(y)$), so **rank is unchanged**.
  - If $\operatorname{rank}(x) = \operatorname{rank}(y)$: the merged tree's longest path becomes $\operatorname{rank}(y)+1$, so **increment** $\operatorname{rank}(y)$.

```cpp
vector<int> parent, rnk;         // rnk avoids clashing with std::rank

void init(int n) {
    parent.resize(n + 1); iota(parent.begin(), parent.end(), 0);
    rnk.assign(n + 1, 0);
}

int find(int x) {
    while (parent[x] != x)
        x = parent[x];
    return x;
}

void unite(int x, int y) {
    x = find(x);
    y = find(y);
    if (x == y)
        return;
    if (rnk[x] > rnk[y])         // make x the smaller-rank root
        swap(x, y);
    parent[x] = y;               // attach smaller rank under larger
    if (rnk[x] == rnk[y])        // equal ranks -> new root grows by one
        rnk[y] += 1;
}
```

![Forest with ranks r(2)=1, r(3)=2, r(8)=1; the merge cases rank(x)+1 ≤ rank(y) vs equal ranks that bump rank(y)](/img/dsa/vq5u09x2Kzo/frame-00247.png)

*Rank heuristic: hang the shorter tree under the taller one; ranks only rise when two equal-rank trees merge.*

### Why rank stays $\le \log_2 n$

- **Claim:** a node of rank $r$ has a subtree of at least $2^r$ elements. Proof by induction on unions:
  - Base: a singleton has rank $0$ and $2^0 = 1$ element. ✓
  - Unequal-rank merge: the surviving root's rank is unchanged while its subtree only grows, so the bound still holds.
  - Equal-rank merge: two subtrees, each with $\ge 2^r$ elements, combine into one of rank $r+1$ with $\ge 2^{r} + 2^{r} = 2^{r+1}$ elements. ✓
- Since a subtree has at most $n$ elements, $2^{r} \le n$, hence $r \le \log_2 n$. Every `find` path is therefore $O(\log n)$, so `find` and `union` run in $O(\log n)$ **worst case** — no amortization needed yet.

[watch from 52:24](https://youtu.be/vq5u09x2Kzo?t=3144)

---

## Path compression — flattening on the way up

- **Idea:** every `find` already walks from `x` to the root. On the way back, re-point **every node on that path** directly at the root. Future `find`s from those nodes cost $O(1)$.
- Iterative version (two passes: find the root `y`, then relink each node on the path to `y`):

```cpp
int find(int x) {
    int y = x;
    while (p[y] != y)     // pass 1: locate the root
        y = p[y];
    while (p[x] != x) {   // pass 2: relink everything on the path to the root
        int z = p[x];
        p[x] = y;
        x = z;
    }
    return y;
}
```

- Recursive version — shorter, does the same relinking as the stack unwinds:

```cpp
int find(int x) {
    if (p[x] != x)
        p[x] = find(p[x]);  // relink x straight to the root
    return p[x];
}
```

- With path compression **alone** (no rank), amortized `find` is $O(\log n)$.

![Path Compressing: the compressing find code, plus T̃(find)=O(log n) alone and O(α(m,n)) with rank, n = tree size, m = number of finds](/img/dsa/vq5u09x2Kzo/frame-00305.png)

*The path-compression `find` and the headline bounds: $O(\log n)$ compression-only, $O(\alpha(m,n))$ with union by rank.*

[watch from 1:04:33](https://youtu.be/vq5u09x2Kzo?t=3873)

---

## The near-constant bound: inverse Ackermann and $\log^* n$

- With **both** union by rank **and** path compression, the amortized cost of `find` over $m$ operations on $n$ elements is
$$
O\big(\alpha(m, n)\big),
$$
where $\alpha$ is the **inverse Ackermann** function. It grows so slowly that for every $n$ that fits in the physical universe, $\alpha(m, n) \le 4$ — effectively constant.
- **Direction of the arguments (a nice sanity check):** larger $n$ makes $\alpha$ grow; larger $m$ makes it **shrink**. More `find`s means more compression, so paths flatten and later calls get cheaper.
- **The full $\alpha$ proof is deferred.** Pavel notes it needs a separate ~30-minute lecture to even define Ackermann's function; he does not prove the $\alpha$ bound here, and neither do we. Instead we prove the clean special case below.

### The iterated logarithm $\log^* n$

- Define $\log^* n$ as the number of times you must apply $\log_2$ to $n$ before the result drops to $\le 1$.
- It is astronomically slow: starting from the tower $2^{65536}$, one $\log$ gives $2^{16}$, then $2^4$, then $2^2$, then $2^1$, then $2^0$ — so $\log^*\!\big(2^{65536}\big) = 5$.

![Tower 2^65536 → 2^16 → 2^4 → 2^2 → 2^1 → 2^0, five log steps; with m=n, α(m,n) = log* n](/img/dsa/vq5u09x2Kzo/frame-00316.png)

*Even for $2^{65536}$ (far more than the number of atoms in the universe), $\log^* n = 5$.*

- **Theorem (what we prove).** With rank + path compression and $m \ge n$ operations, the total `find` cost is $O(m \log^* n)$, i.e. amortized $O(\log^* n)$ per `find`. This is the $m = n$ specialization of the $\alpha$ bound.

### Proof sketch of the $O(\log^* n)$ bound

- Charge the edges traversed by all `find`s. Ranks **strictly increase** from child to parent and never change once a node stops being a root, so they give a clean potential to charge against.
- **Last edges.** Each `find` has one final edge into the root; there are $m$ finds, so $m$ such edges total — an $O(m)$ term.
- Classify every other traversed edge $x \to p(x)$ by comparing the parent's rank to $x$'s:
  - **Big jump:** $\operatorname{rank}(p(x)) \ge 1.9^{\,\operatorname{rank}(x)}$ (the constant just needs to be strictly below $2$).
  - **Small jump:** otherwise.
- **Counting big jumps.** Along one `find` path, following big jumps sends the rank from $r$ to $\ge 1.9^{r}$ each time; two big jumps already exceed $2^{r}$. So a single path has at most $O(\log^* n)$ big jumps, giving $O(m \log^* n)$ big jumps overall.
- **Counting small jumps.** Whenever a non-final small-jump edge $x \to p(x)$ is used, path compression relinks $x$ to a **strictly higher-rank** root, so $\operatorname{rank}(p(x))$ strictly increases each time. After at most $1.9^{\,\operatorname{rank}(x)}$ such increases the edge becomes a big jump and is never a small jump again.
- Group nodes by rank $r$. There are at most $n / 2^{r}$ nodes of rank $r$ (each owns a disjoint subtree of $\ge 2^r$ elements), so the small-jump total is
$$
\sum_{r} \frac{n}{2^{r}} \cdot 1.9^{\,r} \;=\; n \sum_{r} \left(\frac{1.9}{2}\right)^{r} \;=\; O(n),
$$
because the geometric series converges. Adding the three parts gives total cost $O(m \log^* n + n) = O(m \log^* n)$ for $m \ge n$. $\blacksquare$

![Small jump versus big jump defined by comparing the parent rank to 1.9 raised to the child rank; a find path is a bamboo with one last edge](/img/dsa/vq5u09x2Kzo/frame-00346.png)

*The big/small-jump split that powers the $\log^* n$ bound: big jumps are few per path, small jumps are few per node.*

- **Takeaway:** in practice union–find behaves like a constant-time structure — the operations are all plain array reads and writes, and the average find touches a handful of pointers.

[watch from 1:11:38](https://youtu.be/vq5u09x2Kzo?t=4298)

---

## Complexity recap

| Implementation | `find` | `union` | Total for $n-1$ unions + $m$ finds | Space |
| --- | --- | --- | --- | --- |
| Representative array | $\Theta(1)$ | $\Theta(n)$ | $\Theta(n^2)$ | $O(n)$ |
| Lists + union by size | $\Theta(1)$ | amortized $O(\log n)$ | $\Theta(n \log n)$ | $O(n)$ |
| Forest, union by rank only | $O(\log n)$ | $O(\log n)$ | $O(m \log n)$ | $O(n)$ |
| Forest, path compression only | amortized $O(\log n)$ | amortized $O(\log n)$ | $O(m \log n)$ | $O(n)$ |
| Forest, rank + path compression | amortized $O(\alpha(m,n))$ | amortized $O(\alpha(m,n))$ | $O(m\,\alpha(m,n))$; $O(m\log^* n)$ when $m \ge n$ | $O(n)$ |

---

## Practice problems

Union–find is one of the highest-yield interview data structures: most "are these connected / how many groups" questions reduce to it.

**🎯 Interview (MAANG-style)**

- [Number of Provinces — LeetCode 547](https://leetcode.com/problems/number-of-provinces/) — Medium — count connected components; the canonical DSU warm-up.
- [Number of Islands — LeetCode 200](https://leetcode.com/problems/number-of-islands/) — Medium — union adjacent land cells; count roots (union-find variant of the grid classic).
- [Redundant Connection — LeetCode 684](https://leetcode.com/problems/redundant-connection/) — Medium — the edge that closes a cycle is the one whose endpoints already share a root.
- [Accounts Merge — LeetCode 721](https://leetcode.com/problems/accounts-merge/) — Medium — union accounts sharing an email, then group by representative.
- [Most Stones Removed with Same Row or Column — LeetCode 947](https://leetcode.com/problems/most-stones-removed-with-same-row-or-column/) — Medium — answer is stones minus number of connected components.
- [Graph Valid Tree — LeetCode 261](https://leetcode.com/problems/graph-valid-tree/) — Medium — a tree iff exactly $n-1$ edges and no union ever joins two nodes already connected.
- [Disjoint Set Union — GeeksforGeeks](https://www.geeksforgeeks.org/introduction-to-disjoint-set-data-structure-or-union-find-algorithm/) — Medium — implement `find` + `union` with both heuristics from scratch.

**🏆 Competitive**

- [Official home tasks & discussion — Codeforces](https://codeforces.com/blog/entry/84224) — the problem set Pavel assigned for this lecture (from the video description).
- [Road Construction — CSES 1676](https://cses.fi/problemset/task/1676) — Medium — process edges online, maintaining component count and largest component size with union by size.
- [Small-to-large / DSU on tree — USACO Guide](https://usaco.guide/gold/dsu) — the mergeable-structure technique from Version 2, generalized to subtree queries on trees.

---

## Further reading

- [Disjoint Set Union — cp-algorithms](https://cp-algorithms.com/data_structures/disjoint_set_union.html) — implementation plus applications and improvements.
- [Union by Rank and Path Compression — GeeksforGeeks](https://www.geeksforgeeks.org/union-by-rank-and-path-compression-in-union-find-algorithm/) — worked walkthrough of both heuristics.
- [Disjoint-set data structure — Wikipedia](https://en.wikipedia.org/wiki/Disjoint-set_data_structure) and [Proof of the $O(\log^* n)$ bound — Wikipedia](https://en.wikipedia.org/wiki/Proof_of_O(log*n)_time_complexity_of_union%E2%80%93find).
- [Ackermann function — Wikipedia](https://en.wikipedia.org/wiki/Ackermann_function) — the fast-growing function whose inverse $\alpha$ appears in the tight bound.

---

## Key takeaways

- The whole interface is `union` + `find`; "same set?" is just equal representatives.
- Small-to-large merging alone already buys $O(\log n)$ amortized per element — a technique worth internalizing on its own.
- The forest plus **union by rank** guarantees $O(\log n)$ height; **path compression** flattens paths as a side effect of querying.
- Together they give amortized $O(\alpha(m,n))$ — provably $O(\log^* n)$ for $m \ge n$ — which is constant for all practical inputs.
- Prove logarithmic *height* bounds by showing the subtree is *exponentially large* in the rank — the standard inverse trick.

## Glossary

- **Disjoint sets / union–find** — a partition of $n$ objects supporting merge and same-set queries.
- **Representative** — the canonical element `find` returns for every member of a set (the tree root here).
- **Union by rank/size** — attach the smaller/shorter tree under the larger/taller to keep trees shallow.
- **Path compression** — during `find`, re-point every visited node directly to the root.
- **Rank** — an upper bound on a node's subtree height; only rises when equal-rank trees merge.
- **$\log^* n$** — iterated logarithm: how many times you apply $\log_2$ before reaching $\le 1$.
- **$\alpha(m, n)$** — inverse Ackermann function; the tight amortized bound for union–find, effectively constant.
