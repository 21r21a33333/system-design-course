---
title: "S02E03 · Fenwick Tree & Sparse Table"
sidebar_position: 3
description: The Fenwick / Binary Indexed Tree for point-update prefix-sum queries via the low-bit trick, and the sparse table for O(1) idempotent range queries with O(n log n) build.
---

# S02E03 · Fenwick Tree & Sparse Table

> **Source:** Pavel Mavrin, [_A&DS S02E03_](https://youtu.be/Ti_U3Q_G7yM) · 1h29m lecture → ~14 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- The **Fenwick tree** (Binary Indexed Tree, BIT) answers *point update* and *prefix sum* in $O(\log n)$ using a **single array of size $n$** — no padding to a power of two, roughly half the memory of a segment tree and a smaller constant factor.
- Its magic is a **low-bit walk**: each cell $f[i]$ stores the sum of a block whose length is the lowest set bit of $i$, so both operations jump along at most $\log n$ blocks. The jump is one bitwise expression, `i & (-i)`.
- A BIT needs an **invertible** combine (sum, XOR): a range sum is $\text{prefix}(r) - \text{prefix}(l-1)$. It cannot do range-min or lazy range-update the way a segment tree can.
- The **sparse table** solves the *static* range-query problem: precompute minima over every $2^j$-length window in $O(n \log n)$, then answer any range min in **$O(1)$** by covering the range with two overlapping power-of-two windows.
- The $O(1)$ trick needs an **idempotent** operation ($\min(x,x)=x$): min, max, gcd, AND, OR. For a merely associative operation (plain sum) a **disjoint sparse table** (divide-and-conquer prefixes/suffixes) keeps $O(n\log n)$ build and $O(1)$ query.
- Choosing between them is about query volume: for $m$ queries, segment tree costs $O(n + m\log n)$, sparse table costs $O(n\log n + m)$ — sparse table wins when $m$ is large and the array never changes.

---

## Why another update structure

- We want an array supporting two operations, both in $O(\log n)$ — exactly the pair segment trees already solve:
  - `inc(i, v)` — add $v$ to a single element, `a[i] += v`.
  - `sum(l, r)` — return $\sum_{i=l}^{r-1} a[i]$ over a half-open segment.
- So why bother if the asymptotics match a segment tree? Two practical wins the lecturer stresses:
  - **Smaller constant.** The inner loop is a handful of integer ops, no recursion — a few times faster in practice than the segment-tree descent.
  - **Half the memory.** A segment tree over $n$ elements is padded up to the next power of two, then doubled for internal nodes — up to $\approx 4n$ cells in the worst case, at best $2n$. A Fenwick tree needs **exactly $n$** cells and doesn't even store the original array. For a billion-element array that is the difference between one gigabyte and two.
- The catch, stated up front: a BIT only works when the combine has an **inverse** (so `sum(l,r) = prefix(r) - prefix(l)`), and it does not support lazy range operations. When you need those, reach for a segment tree.

![Fenwick tree setup: array f of size n, operations inc(i,v) and sum(l,r) both O(log n)](/img/dsa/Ti_U3Q_G7yM/frame-00069.png)

[watch from 2:55](https://youtu.be/Ti_U3Q_G7yM?t=175)

---

## The one array and the function p

- Keep **one** array $f$ of size $n$. Cell $f[i]$ stores the sum of a *block* of $a$ ending at $i$:

$$
f[i] \;=\; \sum_{k \,=\, p(i)}^{\,i} a[k]
$$

- Everything hinges on choosing a good **block-start function** $p(i)$. The block $[\,p(i),\,i\,]$ must be sized so that:
  - a prefix sum is covered by only $O(\log n)$ blocks, and
  - each element sits inside only $O(\log n)$ blocks (so an update touches few cells).
- Bad choices make one side blow up: $p(i)=i$ gives singleton blocks (prefix sum walks all $n$ of them); $p(i)=0$ gives one huge block (every update touches $n$ cells). The lecturer notes $p(i)=i-\sqrt{i}$-style steps give $\sqrt n$ on both sides — better, but we want $\log n$.
- **Prefix sum** splits a range into two prefixes, then walks blocks leftward:

$$
\text{sum}(l, r) \;=\; \text{prefix}(r) - \text{prefix}(l)
$$

  Starting at $x=r$, add $f[x-1]$, then jump to the start of that block and repeat until $x$ hits $0$.
- **Update** walks the *other* direction: to add $v$ at position $i$, find every block that contains $i$ and add $v$ to each.

![f[i] holds the sum a[p(i)..i]; prefix sum walks blocks leftward, update walks up through containing blocks](/img/dsa/Ti_U3Q_G7yM/frame-00112.png)

[watch from 13:22](https://youtu.be/Ti_U3Q_G7yM?t=802)

---

## The low-bit trick: why blocks are powers of two

- The right $p$ makes each block length a **power of two**, so consecutive jumps double and only $\log n$ of them span any prefix. On the board $p$ is defined by bits: **clear the trailing run of ones** of $i$.
  - Example: $i = 0101\underline{0111}_2$. Its rightmost zero sits above three trailing ones; blank those ones to zero and $p(i) = 0101\underline{0000}_2$.
- The board computes this as a single AND. In the lecturer's **0-based** convention:

$$
p(i) \;=\; i \mathbin{\&} (i + 1)
$$

  **Why it works:** $i+1$ shares the same high prefix, carries a $1$ into the rightmost-zero slot, and zeros out the trailing ones. AND-ing keeps the common prefix and forces every trailing position to $0$ — precisely "erase the trailing ones."

![Board derivation: p(i) erases the trailing ones of i, computed as i AND (i+1)](/img/dsa/Ti_U3Q_G7yM/frame-00084.png)

- The competitive-programming standard instead uses a **1-based** array and the **lowest set bit**:

$$
\text{lowbit}(i) \;=\; i \mathbin{\&} (-i)
$$

  In two's complement $-i = \lnot i + 1$, so $i \mathbin{\&} (-i)$ isolates the single lowest set bit of $i$ — the length of the block ending at $i$. Prefix walk *subtracts* it (`i -= i & -i`); update walk *adds* it (`i += i & -i`). Both strictly change the trailing-bit pattern, so each loop runs at most $\log n$ times.

- **Canonical 1-based implementation** (the one to memorize and use):

```cpp
#include <bits/stdc++.h>
using namespace std;

struct Fenwick {
    int n;
    vector<long long> f;          // f[i] = sum of a[i - lowbit(i) + 1 .. i]
    Fenwick(int n) : n(n), f(n + 1, 0) {}

    // add v at position i (1-based); walk UP through containing blocks
    void update(int i, long long v) {
        for (; i <= n; i += i & (-i)) f[i] += v;
    }

    // prefix sum a[1..i]; walk DOWN, chopping off the low bit each step
    long long prefix(int i) const {
        long long s = 0;
        for (; i > 0; i -= i & (-i)) s += f[i];
        return s;
    }

    // sum a[l..r], 1-based inclusive
    long long range(int l, int r) const {
        return prefix(r) - prefix(l - 1);
    }
};
```

- **Board variant, verbatim.** The lecture writes the 0-based form with $p(i)=i\,\&\,(i+1)$. It is equivalent and also compiles/passes against brute force:

```cpp
// 0-based Fenwick exactly as on the board: f[i] covers (p(i) .. i]
int n; vector<long long> f;                 // size n

void inc(int i, long long v) {              // update
    for (int j = i; j < n; j = j | (j + 1)) // move to next containing block
        f[j] += v;
}

long long sum_prefix(int r) {               // sum a[0 .. r-1]
    long long res = 0;
    for (int x = r; x > 0; x = x & (x - 1))  // x & (x-1) clears lowest set bit
        res += f[x - 1];
    return res;
}

long long sum_range(int l, int r) {         // half-open [l, r)
    return sum_prefix(r) - sum_prefix(l);
}
```

  Here the update step `j = j | (j+1)` sets the rightmost zero (grows the block); the prefix step `x = x & (x-1)` clears the lowest one. Both add or remove one bit per iteration, so each loop is $O(\log n)$.

- **Complexity.** Each loop changes the number of set bits monotonically and there are at most $\log_2 n$ bit positions, so both operations are $O(\log n)$; on random data the walk averages about $\tfrac{1}{2}\log n$ steps.

![Complete Fenwick code on the board: inc walks j = j|(j+1); sum walks x down while adding f[x], both O(log n)](/img/dsa/Ti_U3Q_G7yM/frame-00140.png)

- **Verified** against a brute-force array over 2000 randomized trials (mixed updates and range queries) — the 1-based `range` and the 0-based `sum_range` both match exactly.

[watch from 24:34](https://youtu.be/Ti_U3Q_G7yM?t=1474)

---

## What a Fenwick tree cannot do

- It needs an **invertible** combine. Range sum works because $\text{sum}(l,r) = \text{prefix}(r) - \text{prefix}(l)$. There is no "subtract" for `min`/`max`, so a plain BIT cannot answer range-minimum.
- **No lazy range updates.** You cannot add a value to a whole segment in $O(\log n)$ the way a segment tree with lazy propagation can — an element can belong to up to $\log n$ blocks, and there is no clean place to hang a deferred tag. The lecturer leaves the harder "two-BIT range-update range-sum" trick as an exercise.
- **Rule of thumb:** if all you need is point-update + prefix-sum (or another invertible aggregate), the BIT is the smaller, faster tool. For richer queries (min with updates, lazy range assign/add, arbitrary associative merges with modification), use the more powerful segment tree.

![Increment walk j = j | (j+1) enumerates every block containing i, from i upward, adding v to each](/img/dsa/Ti_U3Q_G7yM/frame-00136.png)

[watch from 34:13](https://youtu.be/Ti_U3Q_G7yM?t=2053)

---

## Sparse table: the static range-query problem

- Now the array is **fixed** — no updates, only queries. This is the *static* setting, and it changes the accounting: split cost into **precompute** time (done once) plus **query** time (paid per request).
- For plain sums you do not even need a data structure: **prefix sums** give $O(n)$ precompute and $O(1)$ query. The interesting case is `min(l, r)`, where no subtraction exists.
- Three ways to serve static range-min, with different trade-offs:

| Structure | Precompute | Query |
| --- | --- | --- |
| Prefix sums (for sum only) | $O(n)$ | $O(1)$ |
| Segment tree | $O(n)$ | $O(\log n)$ |
| **Sparse table** | $O(n \log n)$ | $O(1)$ |

- **Which is better depends on the query count $m$.** Segment tree: $O(n + m\log n)$. Sparse table: $O(n\log n + m)$. Many queries on an unchanging array → sparse table wins; few queries → the cheaper build of the segment tree wins.
- Warm-up: with $O(n^2)$ precompute you could just tabulate $\min$ for every $(l,r)$ pair and answer in $O(1)$. The sparse table is the clever compression of that table down to $O(n\log n)$ entries.

![Static problem: precompute vs query cost for sum, segment tree, and sparse table](/img/dsa/Ti_U3Q_G7yM/frame-00279.png)

[watch from 40:02](https://youtu.be/Ti_U3Q_G7yM?t=2402)

---

## Building the sparse table by binary lifting

- Precompute $\min$ over only the windows whose **length is a power of two**. Define

$$
m[j][i] \;=\; \min\big(a[i],\, a[i+1],\, \dots,\, a[i + 2^{j} - 1]\big)
$$

  — the minimum of the length-$2^{j}$ window starting at $i$. There are $n$ starts $\times$ about $\log n$ lengths $= O(n\log n)$ entries.
- Fill it by **binary lifting** (a.k.a. doubling): a $2^{j}$ window is two adjacent $2^{j-1}$ windows, so each entry is one $\min$ of two already-computed halves:

$$
m[j][i] \;=\; \min\big(m[j-1][i],\; m[j-1][i + 2^{\,j-1}]\big)
$$

  Base layer $m[0][i] = a[i]$ (windows of length one). Each entry is $O(1)$, so the whole build is $O(n\log n)$.

![Binary lifting: m[j][i] = min of two length-2^(j-1) halves; base layer m[0][i] = a[i]](/img/dsa/Ti_U3Q_G7yM/frame-00232.png)

- **Query in $O(1)$.** For range $[l, r]$ of length $\text{len} = r - l + 1$, take the largest $k$ with $2^{k} \le \text{len}$. One length-$2^k$ window from the left and one from the right **overlap** but together cover $[l,r]$ exactly:

$$
\min(l, r) \;=\; \min\big(m[k][l],\; m[k][\,r - 2^{k} + 1\,]\big)
$$

  The overlap is harmless **only because $\min$ is idempotent**: counting an element twice is the same as once, since $\min(x,x)=x$.

![Query covers [l,r] with two overlapping length-2^k windows: min(m[k][l], m[k][r-2^k+1])](/img/dsa/Ti_U3Q_G7yM/frame-00236.png)

- **The $k = \lfloor \log_2 \text{len}\rfloor$ lookup.** Computing a log per query is avoidable: precompute a `lg` table in $O(n)$ so every query is pure integer work (hardware can also do it via a leading-zero-count instruction).

```cpp
#include <bits/stdc++.h>
using namespace std;

struct SparseTable {
    int n, LOG;
    vector<int> lg;                 // lg[len] = floor(log2(len)), precomputed
    vector<vector<int>> m;          // m[j][i] = min of a[i .. i + 2^j - 1]

    SparseTable(const vector<int>& a) {
        n = (int)a.size();
        lg.assign(n + 1, 0);
        for (int i = 2; i <= n; i++) lg[i] = lg[i / 2] + 1;
        LOG = lg[n] + 1;
        m.assign(LOG, vector<int>(n));
        for (int i = 0; i < n; i++) m[0][i] = a[i];              // length-1 windows
        for (int j = 1; j < LOG; j++)                            // double the length
            for (int i = 0; i + (1 << j) <= n; i++)
                m[j][i] = min(m[j - 1][i], m[j - 1][i + (1 << (j - 1))]);
    }

    // min on [l, r], 0-based inclusive, O(1)
    int query(int l, int r) const {
        int k = lg[r - l + 1];
        return min(m[k][l], m[k][r - (1 << k) + 1]);
    }
};
```

- **Verified** against brute-force RMQ over 3000 randomized trials — every query matches.

[watch from 55:13](https://youtu.be/Ti_U3Q_G7yM?t=3313)

---

## Idempotent vs merely associative

- The overlap trick above is legal only for **idempotent** operations: $\min$, $\max$, $\gcd$, bitwise AND, bitwise OR — any operation where combining a value with itself is a no-op.
- The build step uses only **associativity**; the *query* step is where idempotence is spent (the two windows overlap). For a plain **sum**, double-counting the overlap would be wrong.
- So how do we get $O(n\log n)$ / $O(1)$ for a merely associative operation like sum? Use a **disjoint sparse table** (divide-and-conquer prefixes and suffixes).

![Idempotent operations (min, max, gcd, AND, OR) allow the overlapping-window query; sum does not](/img/dsa/Ti_U3Q_G7yM/frame-00226.png)

[watch from 1:01:53](https://youtu.be/Ti_U3Q_G7yM?t=3713)

---

## Disjoint sparse table: O(1) for any associative op

- **Idea.** Split the array at the middle. In the left half precompute the **suffix** combine of every position (up to the split); in the right half precompute the **prefix** combine of every position (from the split). Recurse into each half — that is one *layer* per recursion depth, $\log n$ layers, each fillable in $O(n)$, so build is $O(n\log n)$.
- **Query.** Any range that **straddles a split point** is answered in $O(1)$ by combining one precomputed suffix (left of the split) with one precomputed prefix (right of the split) — the two pieces are **disjoint**, so no idempotence is needed:

$$
\text{combine}(l, r) \;=\; \text{suffix}[l] \;\oplus\; \text{prefix}[r]
$$

- **Which layer?** Pick the smallest layer whose split point lies inside $[l, r]$. On the board with sums `a = [5,2,1,6,7,3,5,4]`, the layer-0 split gives suffixes `... 7` on the left and prefixes `15 ...` on the right, so a straddling query is `7 + 15 = 22`.

![Disjoint sparse table on a=5,2,1,6,7,3,5,4: layer sums are suffixes|prefixes; query combines two disjoint pieces](/img/dsa/Ti_U3Q_G7yM/frame-00312.png)

- **Finding the layer with bits.** Index $l$ and $r$ split at a given layer exactly when their binary representations **first differ** at that bit. So `layer = position of the leftmost differing bit of l and r`, i.e. the highest set bit of `l XOR r`:

$$
\text{layer} \;=\; \big\lfloor \log_2 (l \oplus r) \big\rfloor
$$

  If the top bit differs they split at layer 0; if the next bit differs, layer 1; and so on. (A bit-magic-free alternative: store each split point's layer in an array and answer with a *min* sparse table — reusing the idempotent structure above.)

![Layer = leftmost differing bit of l and r, obtained from the highest set bit of l XOR r](/img/dsa/Ti_U3Q_G7yM/frame-00316.png)

- Implementation is short — three nested loops per layer (generate splits, sweep left for suffixes, sweep right for prefixes) — roughly 30–50 lines, no recursion needed.
- The lecturer flags that the $\log n$ factor can be removed entirely (down to $\alpha(n)$, inverse-Ackermann) by splitting into many parts per layer, but leaves that for a later lecture.

[watch from 1:12:30](https://youtu.be/Ti_U3Q_G7yM?t=4350)

---

## Complexity recap

| Structure / operation | Build / precompute | Query | Update | Space |
| --- | --- | --- | --- | --- |
| Fenwick (BIT) — point update, prefix sum | $O(n)$ | $O(\log n)$ | $O(\log n)$ | $O(n)$ |
| Segment tree — range query, point/range update | $O(n)$ | $O(\log n)$ | $O(\log n)$ | $O(2n)$–$O(4n)$ |
| Sparse table — idempotent RMQ (static) | $O(n \log n)$ | $O(1)$ | — | $O(n \log n)$ |
| Disjoint sparse table — any associative op (static) | $O(n \log n)$ | $O(1)$ | — | $O(n \log n)$ |

---

## Practice problems

**🎯 Interview (MAANG-style)**

- [Range Sum Query - Mutable — LeetCode 307](https://leetcode.com/problems/range-sum-query-mutable/) — Medium — the canonical point-update + prefix-sum BIT.
- [Count of Smaller Numbers After Self — LeetCode 315](https://leetcode.com/problems/count-of-smaller-numbers-after-self/) — Hard — coordinate-compress, then count with a BIT over values.
- [Reverse Pairs — LeetCode 493](https://leetcode.com/problems/reverse-pairs/) — Hard — count pairs $a_i > 2a_j$ with a BIT (or merge sort).
- [Count Good Triplets in an Array — LeetCode 2179](https://leetcode.com/problems/count-good-triplets-in-an-array/) — Hard — map to positions, count left/right smaller with a BIT.
- [Binary Indexed Tree — GeeksforGeeks](https://www.geeksforgeeks.org/binary-indexed-tree-or-fenwick-tree-2/) — Medium — the reference walkthrough of construction and queries.

**🏆 Competitive**

- [Dynamic Range Sum Queries — CSES 1648](https://cses.fi/problemset/task/1648) — Easy/Med — the textbook point-update, range-sum BIT.
- [Static Range Minimum Queries — CSES 1647](https://cses.fi/problemset/task/1647) — Easy/Med — sparse table RMQ, exactly this lecture's $O(1)$ query.
- [Forest Queries — CSES 1652](https://cses.fi/problemset/task/1652) — Medium — 2D BIT for rectangle sums (extend the 1D low-bit walk to two dimensions).

---

## Further reading

- [Fenwick tree — cp-algorithms](https://cp-algorithms.com/data_structures/fenwick.html) — the low-bit walk, range-update variants, and 2D BITs.
- [Sparse table — cp-algorithms](https://cp-algorithms.com/data_structures/sparse-table.html) — idempotence, the disjoint sparse table, and RMQ specialization.
- [Fenwick tree — Wikipedia](https://en.wikipedia.org/wiki/Fenwick_tree).
- [Range minimum query — Wikipedia](https://en.wikipedia.org/wiki/Range_minimum_query).

---

## Key takeaways

- Fenwick tree = **one array, low-bit walk**: `i & (-i)` isolates the block length; subtract it to descend a prefix, add it to climb through containing blocks. $O(\log n)$ point-update and prefix-sum in tiny constant factor and exactly $n$ cells.
- BITs demand an **invertible** combine and give **no** lazy range ops — that is the price for beating the segment tree's constant and memory.
- Sparse table = **precompute power-of-two windows by doubling**; answer any RMQ in $O(1)$ with two overlapping windows. Legal only because $\min$ is **idempotent**.
- Drop idempotence and you switch to the **disjoint sparse table**: prefixes/suffixes around each split, choose the layer from the leftmost differing bit of $l$ and $r$ — $O(n\log n)$ build, $O(1)$ query for any associative operation.
- Static vs dynamic and query count $m$ decide the tool: segment tree $O(n + m\log n)$ vs sparse table $O(n\log n + m)$.

## Glossary

- **Fenwick tree / BIT** — array-based structure for point-update + prefix-sum in $O(\log n)$, one cell per element.
- **Low bit / lowbit** — the lowest set bit of an index, `i & (-i)`; equals the length of the block that Fenwick cell $i$ summarizes.
- **Prefix sum** — cumulative aggregate $a[0]+\dots+a[i]$; a range aggregate is the difference of two prefixes when the op is invertible.
- **Sparse table** — table of aggregates over all $2^{j}$-length windows; $O(n\log n)$ build, $O(1)$ idempotent range query.
- **Binary lifting / doubling** — building a length-$2^{j}$ answer from two length-$2^{j-1}$ answers.
- **Idempotent operation** — one with $x \oplus x = x$ (min, max, gcd, AND, OR); required for the overlapping-window $O(1)$ query.
- **Disjoint sparse table** — divide-and-conquer prefixes/suffixes giving $O(1)$ range queries for any associative operation.
