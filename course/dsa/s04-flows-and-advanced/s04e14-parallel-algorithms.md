---
title: "S04E14 · Parallel Algorithms"
sidebar_position: 14
description: The PRAM model and its EREW/CREW/CRCW variants, the work-depth model and Brent's scheduling bound, and a toolbox of parallel primitives — reduction, scan (prefix sums), filter, parallel merge sort, and batch insertion into a 2-3 tree.
---

# S04E14 · Parallel Algorithms

> **Source:** Pavel Mavrin, [_A&DS S04E14_](https://youtu.be/_vOEPvmy7tw) · 1h34m lecture → ~15 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- Clock speed hit a physical wall (light travels only ~10 cm per 3 GHz tick), so modern speedups come from **more cores**, not faster ones — hence parallel algorithms.
- The **PRAM** model = many processors sharing one RAM. Its variants differ only in how concurrent memory access is handled: **EREW** (exclusive read, exclusive write), **CREW** (concurrent read, exclusive write), **CRCW** (concurrent read, concurrent write). The strongest and weakest models are within a $\log$ factor of each other.
- The cleaner **work-depth** model rates an algorithm by two numbers on its operation DAG: **work** $W$ (total nodes = time on one processor) and **depth** $D$ (longest dependency path = time on infinitely many processors).
- **Brent's theorem:** with $p$ processors a greedy scheduler runs in $T_p = \Theta\!\big(\tfrac{W}{p} + D\big)$ — so you tune just two numbers and get the runtime for *every* $p$. The goal: **work-optimal** (same $W$ as the serial algorithm) with tiny depth ($\log n$, $\log^2 n$, or $\sqrt n$).
- The core primitives all run in $W = \Theta(n)$, $D = \Theta(\log n)$ by folding a **segment tree**: **reduce** (any associative $\oplus$), **scan** (prefix sums, up-sweep then down-sweep), and **filter** (map → scan → scatter).
- **Parallel merge** ranks each element by binary search into the other array — $W = \Theta(n)$, $D = \Theta(\log n)$ — giving a merge sort with $W = \Theta(n\log n)$, $D = \Theta(\log^2 n)$. **Batch-inserting** a sorted array into a **2-3 tree** parallelizes the same way.

---

## Why parallel: the speed-of-light wall

- Processor speed used to grow by clock rate: 100 MHz → 200 MHz → 1 GHz → ~3 GHz. Then it stalled.
- **Physics argument.** Light travels $c \approx 3\times10^{8}\ \text{m/s}$. In one tick of a 3 GHz chip ($1/3\times10^{9}\ \text{s}$) light moves only $\frac{3\times10^{8}}{3\times10^{9}} \approx 0.1\ \text{m}$ — about 10 cm. A signal cannot cross the chip much faster than it already does, so per-core frequency is near its ceiling.
- **The industry's answer:** stop raising operations-per-second, raise the **number of cores**. Laptops ship 4–8 cores; a GPU packs thousands of small cores. To exploit them, an algorithm must be **restructured to run in parallel** — the subject of this final lecture.

[watch from 0:04](https://youtu.be/_vOEPvmy7tw?t=4)

---

## The PRAM model: EREW / CREW / CRCW

- **PRAM = Parallel RAM.** One shared memory array; $p$ processors each execute their own stream of constant-time operations, all stepping in lockstep.
- **Cost.** In one step every busy processor does one op; $T_p$ is the number of steps until *all* processors finish. You want to minimize the makespan.
- **The subtlety is shared memory** — what if two processors touch the same cell in the same step? That is a *model parameter*, giving three variants:
  - **EREW** (Exclusive Read, Exclusive Write) — a cell may be read or written by **at most one** processor per step. The weakest, strictest model.
  - **CREW** (Concurrent Read, Exclusive Write) — many may **read** the same cell simultaneously (harmless — they all see the same value); only one may write. This is what the parallel-merge binary searches below need.
  - **CRCW** (Concurrent Read, Concurrent Write) — simultaneous writes are allowed; a sub-rule decides the winner (an **arbitrary** processor wins, or the **smallest-id** one, etc.).
- **How far apart are the models?** At most a $\log$ factor: any CRCW algorithm can be emulated on EREW with an $O(\log p)$ slowdown. That gap matters — turning a linear algorithm into an $n\log n$ one is a real regression — so we track it.

![PRAM: several processors over one shared RAM array, an operation dependency DAG, and the three access models EREW / CREW / CRCW](/img/dsa/_vOEPvmy7tw/frame-00044.png)

[watch from 3:21](https://youtu.be/_vOEPvmy7tw?t=201)

---

## Work and depth: rate the DAG, not the schedule

- Assigning operations to processors by hand is painful. Instead, describe the computation as a **DAG of operations**: each node is one constant-time op, each edge is a dependency (you cannot run a node until its predecessors are done).
- Two intrinsic numbers summarize the DAG:
  - **Work** $W = T_1$ = **number of nodes** = time on a single processor (you must do every op).
  - **Depth / span** $D = T_\infty$ = **length of the longest path** (critical path) = time with **infinitely** many processors, because dependencies force that chain to run one after another.
- These two numbers are model-independent and easy to reason about — you compute $W$ and $D$ once, and (via Brent below) you know $T_p$ for all $p$.

![Operation DAG with its critical path highlighted; W = number of nodes (one-processor time), D = longest path (infinite-processor time)](/img/dsa/_vOEPvmy7tw/frame-00070.png)

[watch from 9:21](https://youtu.be/_vOEPvmy7tw?t=561)

---

## Brent's theorem: two numbers give you every $T_p$

- **Two lower bounds** on any schedule with $p$ processors:
  - $T_p \ge D$ — the critical path is inherently sequential.
  - $T_p \ge \dfrac{W}{p}$ — $p$ processors clear at most $p$ ops per step, so $W$ ops need at least $W/p$ steps.
- Combining: $T_p \ge \max\!\left(D, \dfrac{W}{p}\right) \ge \dfrac{1}{2}\!\left(D + \dfrac{W}{p}\right) = \Omega\!\left(D + \dfrac{W}{p}\right).$
- **The reachable upper bound (Brent).** A greedy scheduler achieves it. Layer the DAG by distance from the start node; there are exactly $D$ layers. Let layer $i$ hold $n_i$ operations (independent, so runnable together). Layer $i$ takes $\left\lceil \dfrac{n_i}{p} \right\rceil \le \dfrac{n_i}{p} + 1$ steps. Summing over all $D$ layers:

$$
T_p \;\le\; \sum_{i=1}^{D}\left(\frac{n_i}{p} + 1\right) \;=\; \frac{1}{p}\sum_{i=1}^{D} n_i \;+\; D \;=\; \frac{W}{p} + D.
$$

$$
\boxed{\,T_p = \Theta\!\left(\dfrac{W}{p} + D\right)\,}
$$

- **Consequence.** Optimize just $W$ and $D$ and you have optimized runtime for *every* processor count. In practice $p \ll n$, so the $W/p$ term dominates: **first make the work optimal, then shrink the depth.** Ideal target is $W$ equal to the serial cost with $D \in \{\log n,\ \log^2 n,\ \sqrt n\}$.
- **Two algorithms need not be comparable.** $W = n,\ D = \log^2 n$ versus $W = n\log n,\ D = \log n$: which wins depends on $p$ and $n$ — for small $p$ the first (lower work) wins, for huge $p$ the second (lower depth) can.

![Brent's bound: Tp ≥ max(D, W/p) ≥ ½(D + W/p), matched above by Tp = O(D + W/p) via the layer-by-layer sum](/img/dsa/_vOEPvmy7tw/frame-00084.png)

[watch from 14:12](https://youtu.be/_vOEPvmy7tw?t=852)

---

## Primitive 1 — parallel reduction (sum via a segment tree)

- **Goal.** Sum $a[0..n-1]$ with **work equal to the serial cost** ($\Theta(n)$) and small depth.
- **Idea.** Break the array into pairs and add them, then pair the partial sums, and so on — exactly building the internal nodes of a **segment tree** bottom-up. All additions in one level are independent, so each level is one parallel step.
- **Analysis.** A segment tree over $n$ leaves has $n + n/2 + n/4 + \dots = 2n$ nodes → $W = \Theta(n)$ (work-optimal). Its height is $\log_2 n$ → $D = \Theta(\log n)$. This $\log n$ depth is essentially the best you can hope for.
- Same recipe works for **any associative operator** $\oplus$ (sum, min, max, gcd, matrix product, …): `reduce` folds $a_1 \oplus a_2 \oplus \dots \oplus a_n$ with $W = \Theta(n)$, $D = \Theta(\log n)$.
- **map** is the trivial extreme: $b_i = f(a_i)$ has no dependencies — $W = \Theta(n)$, $D = 1$ with $n$ processors (in practice forks are binary, adding a $\log n$ factor to spawn them).

The up-sweep, written as a sequential emulation whose loop structure exposes the parallel layers:

```cpp
#include <bits/stdc++.h>
using namespace std;

// Parallel reduction (up-sweep), sequential emulation.
// Work O(n); the outer loop runs O(log n) times = depth.
long long parallel_reduce(vector<long long> a) {
    int n = 1; while (n < (int)a.size()) n <<= 1;   // pad to power of two...
    a.resize(n, 0);                                 // ...with the identity (0 for +)
    for (int len = 1; len < n; len <<= 1)           // O(log n) layers  -> depth
        for (int i = 0; i + len < n; i += 2 * len)  // one layer: independent -> parallel
            a[i] += a[i + len];
    return a[0];                                     // total sum lands at index 0
}
```

![Reduction as a bottom-up segment tree on 3 5 2 6 2 1 3 4: pairwise sums 8,8,3,7 then 16,10 then 26; W = O(n), D = O(log n)](/img/dsa/_vOEPvmy7tw/frame-00127.png)

[watch from 25:29](https://youtu.be/_vOEPvmy7tw?t=1529)

---

## Primitive 2 — scan (parallel prefix sums)

- **Goal (scan).** Given $a$, produce $b$ with $b_i = \sum_{j\le i} a_j$ — the **prefix sums**. Serially trivial (`b[i] = b[i-1] + a[i]`), but that chain has depth $n$: each element depends on the previous one.
- **Blelloch's work-efficient scan** turns the $\Theta(n)$-depth chain into $\Theta(\log n)$ depth with two passes over the segment tree:
  - **Up-sweep** (same as reduction): compute the sum of every subtree, bottom-up.
  - **Down-sweep** (divide-and-conquer, root to leaves): carry a running "prefix offset" down. At each node, the **left** child inherits the parent's offset; the **right** child inherits offset **plus the left subtree's sum**. Leaves end up holding the *exclusive* prefix sums; add $a_i$ back for the *inclusive* answer.
- **Board trace.** On $[3,5,2,6,1,3,4]$ the down-sweep pushes the left-sum 16 into the right half, then 8 within a half, then 3, producing prefix sums $3,8,10,16,17,20,24$ — matching the serial left-to-right scan exactly.
- **Analysis.** Both sweeps touch $O(n)$ nodes over $O(\log n)$ levels → $W = \Theta(n)$, $D = \Theta(\log n)$. This is *the* workhorse primitive — everything below is built on it.

```cpp
// Work-efficient inclusive scan (Blelloch): up-sweep + down-sweep.
// b[i] = a[0] + ... + a[i].  Work O(n), depth O(log n).
vector<long long> parallel_scan(vector<long long> a) {
    int orig = a.size();
    int n = 1; while (n < orig) n <<= 1;
    a.resize(n, 0);
    vector<long long> t = a;                              // work buffer

    // up-sweep: t[i + 2len - 1] holds the subtree sum
    for (int len = 1; len < n; len <<= 1)
        for (int i = 0; i + 2 * len - 1 < n; i += 2 * len)
            t[i + 2 * len - 1] += t[i + len - 1];

    // down-sweep: root gets the identity, then push offsets down
    t[n - 1] = 0;
    for (int len = n >> 1; len >= 1; len >>= 1)
        for (int i = 0; i + 2 * len - 1 < n; i += 2 * len) {
            long long left = t[i + len - 1];
            t[i + len - 1]     = t[i + 2 * len - 1];       // left child <- parent offset
            t[i + 2 * len - 1] += left;                    // right child <- parent + leftsum
        }
    // t is now the EXCLUSIVE scan; add a to make it inclusive
    vector<long long> b(orig);
    for (int i = 0; i < orig; i++) b[i] = t[i] + a[i];
    return b;
}
```

![Scan down-sweep on the segment tree: push left-subtree sums (+16, +8, +3, ...) root-to-leaf to get prefix sums 3 8 10 16 17 20 24; W = n, D = log n](/img/dsa/_vOEPvmy7tw/frame-00160.png)

[watch from 34:13](https://youtu.be/_vOEPvmy7tw?t=2053)

---

## Primitive 3 — filter (map → scan → scatter)

- **Goal.** Keep exactly the elements with $f(a_i) = 1$ (e.g. the even numbers), preserving order and packing them densely into $b$.
- **The trick is finding each survivor's output index in parallel** — you cannot use a sequential counter. Prefix sums give it for free:
  1. **map**: compute the boolean mask $flag_i = f(a_i)$ ($D = 1$).
  2. **scan**: inclusive prefix sums of the mask. The last entry is the **output length**; for a kept element, $\text{pos}_i - 1$ is its 0-based destination.
  3. **scatter**: every kept element writes itself to `b[pos_i - 1]` — all writes independent, so parallel.
- **Board example.** $a=[3,5,2,6,1,7,3,2,1]$, keep evens → mask $[0,0,1,1,0,0,0,1,0]$, scan $[0,0,1,2,2,2,2,3,3]$, length 3, output $b=[2,6,2]$.
- **Analysis.** $W = \Theta(n)$, $D = \Theta(\log n)$ (dominated by the scan).

```cpp
// Filter: keep even elements, stable, destinations from a prefix scan.
vector<long long> parallel_filter_even(const vector<long long>& a) {
    int n = a.size();
    vector<long long> flag(n);
    for (int i = 0; i < n; i++) flag[i] = (a[i] % 2 == 0) ? 1 : 0;   // map, depth 1
    vector<long long> pos = parallel_scan(flag);                    // inclusive scan
    int total = n ? (int)pos.back() : 0;
    vector<long long> b(total);
    for (int i = 0; i < n; i++)                                      // scatter, parallel
        if (flag[i]) b[pos[i] - 1] = a[i];                          // 1-based -> 0-based
    return b;
}
```

![Filter of even elements from 3 5 2 6 1 7 3 2 1: boolean mask 0 0 1 1 0 0 0 1 0, its prefix scan gives output positions, result b = 2 6 2](/img/dsa/_vOEPvmy7tw/frame-00179.png)

[watch from 40:00](https://youtu.be/_vOEPvmy7tw?t=2400)

---

## Parallel merge and parallel merge sort

- **Plan.** Parallelize merge sort. The two recursive calls are already independent (run left and right in parallel); the hard part is the **merge** of two sorted arrays.
- **Naive parallel merge fails.** Splitting each array in half and merging halves independently is wrong — a small element in the right half of $A$ must precede everything in the left half of $B$. You need each element's *global* position.
- **Rank by binary search.** For element $x$ in $A$, its position in the merged $C$ is (its index in $A$) plus (how many elements of $B$ are less than $x$) — one **binary search** into $B$. Do this for **every** element, all at once. Because many searches read the same $B$ cells simultaneously, this needs **CREW**.
  - This single merge: $W = \Theta(n\log n)$ (each of $n$ elements does a $\log n$ search), $D = \Theta(\log n)$.
  - Feeding that into merge sort's $\log n$ layers gives $W = \Theta(n\log^2 n)$, $D = \Theta(\log^2 n)$ — but the work is now **worse** than the serial $n\log n$. Not good enough.

```cpp
// Parallel merge of two sorted arrays via per-element rank (binary search).
// Each write is independent -> parallelizable. Needs concurrent reads (CREW).
vector<long long> parallel_merge(const vector<long long>& A, const vector<long long>& B) {
    int n = A.size(), m = B.size();
    vector<long long> C(n + m);
    for (int i = 0; i < n; i++) {                    // A-elements, all independent
        int j = lower_bound(B.begin(), B.end(), A[i]) - B.begin();  // #B strictly < A[i]
        C[i + j] = A[i];
    }
    for (int j = 0; j < m; j++) {                    // B-elements
        int i = upper_bound(A.begin(), A.end(), B[j]) - A.begin();  // #A <= B[j] (ties: A first)
        C[i + j] = B[j];
    }
    return C;
}
```

- **Making merge work-optimal ($W = \Theta(n)$).** Kill the extra $\log n$ by ranking only $n/\log n$ elements instead of all $n$:
  1. Split $A$ into blocks of size $\log n$. Binary-search each block **boundary** into $B$ (that is only $n/\log n$ searches, each $O(\log n)$ → $\Theta(n)$ total work).
  2. Do the symmetric split of $B$ into blocks of $\log n$ and align them back into $A$. Now **both** arrays are cut into aligned pieces, each of size $\le \log n$.
  3. Assign each aligned pair of pieces to **one** processor, which merges them sequentially in $O(\log n)$ time. Piece sizes and offsets come from a prefix scan.
  - Result: $W = \Theta(n)$, $D = \Theta(\log n)$ for the merge (two pointers is inherently sequential, so blocks of $\log n$ are merged serially per processor).
- **Work-optimal parallel merge sort:** $W = \Theta(n\log n)$ (matches serial), $D = \Theta(\log^2 n)$.
- **Can depth drop to $\log n$?** Yes — via **sorting networks** (Batcher's odd–even mergesort, or the AKS network) with $\Theta(n\log n)$ comparators and $\Theta(\log n)$ depth — but they are complicated and rarely worth it. The single binary search on the critical path makes $\Theta(\log n)$ depth hard to beat with divide-and-conquer.

![Parallel merge by ranking: for element 10, count elements of both arrays that must precede it (binary search) to find its slot in C](/img/dsa/_vOEPvmy7tw/frame-00215.png)

[watch from 45:11](https://youtu.be/_vOEPvmy7tw?t=2711)

---

## Batch insertion into a 2-3 tree

- **Problem.** A balanced BST already holds elements; you are handed a **sorted array of $n$ new keys** and must insert them all. Serially that is $n$ inserts $\times \log n = \Theta(n\log n)$. Goal: work $\Theta(n\log n)$ but depth $\approx \log^2 n$.
- **Use a 2-3 tree** (a B-tree with branching 2 or 3): every node has 2 or 3 children, all leaves are on the same level, so height is $\Theta(\log n)$. A node with 3 children stores 2 keys $x_1 < x_2$. Standard single-insert adds a leaf, then splits any overfull (4-child) node upward until valid.
- **Easy sub-case first.** Suppose the batch is *spread out* — between any two batch keys there is already a tree key. Then each existing node receives **at most as many new children as it had**, so degree at most doubles (3 → 6). Insert every key in parallel into the bottom layer, then walk **layer by layer** splitting any node with more than 3 children into two valid nodes (all splits in a layer are independent → parallel). Depth $= \Theta(\log n)$ (one pass per level).
- **General case — insert in waves.** If keys can cluster, seed with the **middle** key alone; once it is in, every remaining key has a tree key between it and its neighbor, so the next wave can double. Insert 1, then 2, then 4, then 8, … keys — $\log n$ waves, each an $O(\log n)$-depth batch fix. Total depth $\Theta(\log^2 n)$ for a batch of size $n$ ($\log n$ waves $\times \log n$ per fix).
- **Pipelining** (a.k.a. cascading) overlaps the waves: start the next wave's bottom insert while the previous wave's split-fixes are still rippling toward the root. This shaves the depth back toward $\Theta(\log n)$ — harder to implement, better constant.

![Batch insert into a 2-3 tree: all leaves on one level so height is log n; a 3-child node stores keys x1,x2; W = n log n, D = log n per wave](/img/dsa/_vOEPvmy7tw/frame-00357.png)

[watch from 1:10:00](https://youtu.be/_vOEPvmy7tw?t=4200)

---

## Complexity recap

Work $W$ = one-processor time; depth $D$ = infinite-processor time; $T_p = \Theta(W/p + D)$.

| Primitive | Work $W$ | Depth $D$ | Model | Notes |
| --- | --- | --- | --- | --- |
| map ($b_i = f(a_i)$) | $\Theta(n)$ | $\Theta(1)$ | EREW | no dependencies; $\Theta(\log n)$ if forks are binary |
| reduce (assoc. $\oplus$) | $\Theta(n)$ | $\Theta(\log n)$ | EREW | segment-tree up-sweep |
| scan (prefix sums) | $\Theta(n)$ | $\Theta(\log n)$ | EREW | up-sweep then down-sweep |
| filter | $\Theta(n)$ | $\Theta(\log n)$ | EREW | map, then scan, then scatter |
| merge (naive rank) | $\Theta(n\log n)$ | $\Theta(\log n)$ | CREW | one binary search per element |
| merge (work-optimal) | $\Theta(n)$ | $\Theta(\log n)$ | CREW | $\log n$-blocks, serial per piece |
| merge sort (parallel) | $\Theta(n\log n)$ | $\Theta(\log^2 n)$ | CREW | work-optimal merge in each layer |
| 2-3 batch insert | $\Theta(n\log n)$ | $\Theta(\log^2 n)$ | CREW | $\log n$ waves; pipelining trims $D$ |

---

## Practice problems

Parallel algorithms are a **model / theory** topic — the PRAM machinery and Brent's theorem almost never appear in coding interviews. But the **prefix-sum / scan** pattern that anchors this lecture is squarely interview-relevant, and the parallel primitives (reduce/scan/filter) are exactly the ops you invoke on GPUs and in map-reduce. Practice the scan pattern; treat the parallel-model results as background.

**🎯 Interview (MAANG-style) — the scan pattern**

- [Range Sum Query - Immutable — LeetCode 303](https://leetcode.com/problems/range-sum-query-immutable/) — Easy — precompute prefix sums so each query is $O(1)$.
- [Sum of Absolute Differences in a Sorted Array — LeetCode 1685](https://leetcode.com/problems/sum-of-absolute-differences-in-a-sorted-array/) — Medium — split into left/right prefix sums around each index.
- [Product of Array Except Self — LeetCode 238](https://leetcode.com/problems/product-of-array-except-self/) — Medium — the **prefix / suffix scan** made explicit (product form of scan).
- [Subarray Sum Equals K — LeetCode 560](https://leetcode.com/problems/subarray-sum-equals-k/) — Medium — running prefix sum plus a hash map of seen sums.
- [Prefix Sum Array — GeeksforGeeks](https://www.geeksforgeeks.org/prefix-sum-array-implementation-applications-competitive-programming/) — Easy — the canonical prefix-sum build and use.
- [Parallel Algorithm Models — GeeksforGeeks](https://www.geeksforgeeks.org/parallel-algorithm-models-in-parallel-computing/) — reference — the PRAM/work-depth vocabulary from this lecture.

**🏆 Competitive**

- [Static Range Sum Queries — CSES 1646](https://cses.fi/problemset/task/1646) — Easy — 1-D prefix sums, answer range sums in $O(1)$.
- [Forest Queries — CSES 1652](https://cses.fi/problemset/task/1652) — Easy — 2-D prefix sums on a grid.
- [Prefix Sums (Fenwick / BIT) — cp-algorithms](https://cp-algorithms.com/data_structures/fenwick.html) — the dynamic cousin of scan, for online prefix sums.

> **No official Codeforces home-task link.** The video description (ITMO 2022, final lecture) contains no Codeforces problem-set URL — unlike most lectures in this course — so none is listed here. The problems above are curated to drill the interview-relevant scan pattern this lecture builds on.

> **Systems note — map-reduce & GPU scan use exactly these primitives.** Map-reduce is literally parallel **map** + parallel **reduce** over a cluster. On GPUs, CUDA Thrust / CUB and every deep-learning framework implement **scan** (`prefix_sum` / `cumsum`), **reduce**, and **filter** (stream compaction) as their fundamental building blocks — the up-sweep/down-sweep algorithm above is the one they ship. Knowing work-vs-depth is how you reason about whether a kernel will actually scale across thousands of cores.

---

## Further reading

- [Parallel RAM — Wikipedia](https://en.wikipedia.org/wiki/Parallel_RAM) — the PRAM model and its EREW/CREW/CRCW variants.
- [Analysis of parallel algorithms — Wikipedia](https://en.wikipedia.org/wiki/Analysis_of_parallel_algorithms) — the work-depth model and Brent's theorem.
- [Prefix sum — Wikipedia](https://en.wikipedia.org/wiki/Prefix_sum) — serial and parallel scan, up-sweep/down-sweep.
- [Merge sort — Wikipedia](https://en.wikipedia.org/wiki/Merge_sort) — includes the parallel merge and merge-sort variants.
- [Sorting network — Wikipedia](https://en.wikipedia.org/wiki/Sorting_network) and [Batcher odd–even mergesort — Wikipedia](https://en.wikipedia.org/wiki/Batcher_odd%E2%80%93even_mergesort) — the $\Theta(\log n)$-depth route mentioned at the end.

---

## Key takeaways

- Frequency plateaued at physics limits; parallelism (more cores) is the only remaining lever, so algorithms must be redesigned to expose independent work.
- Describe a parallel computation as a DAG and read off two numbers: **work** $W$ (one processor) and **depth** $D$ (infinite processors).
- **Brent:** $T_p = \Theta(W/p + D)$ — optimize $W$ and $D$ once and you have every processor count. Aim for **work-optimal** with $D$ of $\log n$ / $\log^2 n$ / $\sqrt n$.
- **Segment-tree folding** gives reduce, scan, and filter at $W = \Theta(n)$, $D = \Theta(\log n)$. **Scan** (prefix sums) is the keystone primitive.
- **Rank-by-binary-search** parallelizes merge (and thus merge sort and 2-3-tree batch insertion); block-by-$\log n$ makes the merge work-optimal.

## Glossary

- **PRAM** — Parallel RAM: many processors over one shared memory, stepping in lockstep.
- **EREW / CREW / CRCW** — exclusive/concurrent read × exclusive/concurrent write; the three PRAM contention models, within a $\log$ factor of one another.
- **Work $W$** — total operations = time on one processor ($T_1$).
- **Depth / span $D$** — longest dependency chain = time on infinitely many processors ($T_\infty$).
- **Brent's theorem** — greedy scheduling gives $T_p = \Theta(W/p + D)$.
- **Work-optimal** — a parallel algorithm whose work matches the best serial algorithm.
- **Scan** — parallel prefix sums; the up-sweep/down-sweep primitive underpinning filter, compaction, and much of GPU computing.
- **2-3 tree** — a B-tree with branching factor 2 or 3, all leaves on one level, height $\Theta(\log n)$.

---

> This is the **final lecture** of Pavel Mavrin's four-season _Algorithms & Data Structures_ course — from time complexity and merge sort in S01E01 all the way to parallel scan and sorting networks here. That completes the series. Thanks for reading to the end.
