---
title: "S01E03 · Quicksort & Order Statistics"
sidebar_position: 3
description: Randomized quicksort with in-place partition, why worst case is O(n squared) but expected time is O(n log n), quickselect for the k-th order statistic in expected O(n), and the deterministic median-of-medians selection in worst-case O(n).
---

# S01E03 · Quicksort & Order Statistics

> **Source:** Pavel Mavrin, [_A&DS S01E03_](https://youtu.be/jHDgr-dKhgA) · 1h13m lecture → ~13 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- A **randomized algorithm** takes an extra input stream of random bits; those random choices can make a problem easier *on average* even when a worst-case adversary controls the data.
- **Quicksort** picks a random pivot $x$, partitions the segment into "less than $x$" and "at least $x$" in linear time, then recurses on both halves.
- **Worst case is $\Theta(n^2)$** (pivot is always the min/max); with the naive two-way split it can even loop forever on all-equal input. But the **expected** running time is $\Theta(n\log n)$, proved by an induction on the split recurrence.
- **Order statistics / quickselect** reuses the same partition but recurses into **only one** side — the side that contains rank $k$ — giving **expected $O(n)$** selection without fully sorting.
- **Median-of-medians (Blum–Floyd–Pratt–Rivest–Tarjan)** chooses the pivot deterministically (median of block medians of 5), guaranteeing a $7n/10$ split and thus **worst-case $O(n)$** selection.

---

## Randomized algorithms

- A deterministic algorithm is a black box: **input data → [Alg] → output data**. A randomized algorithm adds a **second input**: a stream of random numbers.
- The random stream is *not* part of the problem instance — it is an internal coin the algorithm flips. The same input can produce different run traces (and different running times) on different runs.
- **Why bother?** Random choices can dodge adversarial inputs. For quicksort, a fixed pivot rule (say "always take the first element") has a bad input that triggers $\Theta(n^2)$ every time; a random pivot has no such fixed enemy — no single input is slow *in expectation*.
- We measure a randomized algorithm by its **expected number of operations**, taken over the algorithm's own coins, for the worst input:

$$
T(n) = \max_{\text{input of size } n}\ \mathbb{E}\big[\,\#\text{operations}\,\big]
$$

- This is stronger than "average over random inputs": the input may be chosen by an adversary; only the coins are random.

[watch from 0:30](https://youtu.be/jHDgr-dKhgA?t=30)

---

## Quicksort: the algorithm

- **Idea.** To sort segment `a[l..r-1]`:
  1. Pick a **random pivot** $x = a[\text{random index in } l..r-1]$.
  2. **Partition** the segment so every element `< x` comes before every element `≥ x`. Let $m$ be the boundary index.
  3. Recurse on `a[l..m-1]` and `a[m..r-1]`.
- **In-place upgrade.** Instead of allocating two fresh arrays per call (like merge sort's merge), we rearrange **within the same array** and pass index borders. This mirrors merge sort in reverse: merge sort splits trivially then does work *merging*; quicksort does work *splitting* then recurses trivially.
- **Partition in linear time (Lomuto-style, as drawn on the board).** Walk `i` from `l` to `r-1` keeping the invariant that `a[l..m-1]` are all `< x`. When `a[i] < x`, swap it to position `m` and advance `m`. Elements `≥ x` are simply skipped and pile up in `a[m..i]`.

The full board code, transcribed faithfully:

```cpp
void quicksort(vector<int>& a, int l, int r) {
    // sort the half-open segment a[l:r] in place
    if (r - l <= 1)                          // size 0 or 1 → already sorted
        return;
    int x = a[l + rand() % (r - l)];         // random pivot value
    int m = l;                               // boundary: a[l:m] holds elements < x
    for (int i = l; i < r; i++) {
        if (a[i] < x) {
            swap(a[i], a[m]);                // move a[i] into the "< x" prefix
            m++;
        }
    }
    quicksort(a, l, m);                      // left part: elements < x
    quicksort(a, m, r);                      // right part: elements ≥ x
}

vector<int>& sort_arr(vector<int>& a) {
    quicksort(a, 0, a.size());
    return a;
}
```

- **Data structure:** just the input array plus two integer borders `l`, `r`. The invariant `a[l:m]` are `< x` at every step of the loop is the whole correctness argument.

![Quicksort sort(l, r): random pivot, m=l boundary, the for-i partition loop with swap(a[i], a[m]), and the two recursive calls sort(l, m) and sort(m, r)](/img/dsa/jHDgr-dKhgA/frame-00061.png)

[watch from 8:05](https://youtu.be/jHDgr-dKhgA?t=485)

---

## The equal-elements bug (and the fix)

- **The trap.** The two-way split above sends elements `≥ x` to the right. If **all elements are equal** and $x$ equals that value, then *no* element is `< x`: the "less" side is empty and the "at least" side is the whole segment. Then `m == l`, the right recursive call is the same segment again — **infinite recursion**.
- More generally, duplicates make the split lopsided and can degrade the split quality badly.
- **The fix: three-way (Dutch-flag) partition.** Split into three regions — `< x`, `== x`, `> x` — and only recurse on the outer two. Every element equal to the pivot lands in its final place immediately.

```cpp
void quicksort3(vector<int>& a, int l, int r) {
    // three-way partition: robust to duplicates, no infinite loop
    if (r - l <= 1)
        return;
    int x = a[l + rand() % (r - l)];
    int lt = l, i = l, gt = r;           // a[l:lt] < x, a[lt:i] == x, a[gt:r] > x
    while (i < gt) {
        if (a[i] < x) {
            swap(a[i], a[lt]);
            lt++;
            i++;
        } else if (a[i] > x) {
            gt--;
            swap(a[i], a[gt]);           // do not advance i: the swapped-in value is unchecked
        } else {
            i++;                         // equal to pivot: leave it in the middle band
        }
    }
    quicksort3(a, l, lt);                // strictly-less part
    quicksort3(a, gt, r);                // strictly-greater part
}
```

- With this, an all-equal array is partitioned into one big middle band in $O(n)$ and both recursive calls are empty — the loop terminates.

[watch from 12:49](https://youtu.be/jHDgr-dKhgA?t=769)

---

## Worst case: $\Theta(n^2)$

- The pivot quality is everything. The **worst pivot** is the minimum or maximum of the segment: it peels off a single element and leaves the rest.
- Then the segment sizes go $n,\ n-1,\ n-2,\ \dots$, and the partition costs sum to

$$
n + (n-1) + (n-2) + \dots + 1 = \frac{n(n+1)}{2} = \Theta(n^2).
$$

- With the **naive two-way split**, picking the minimum as pivot makes the "less" side empty and the right side the whole array again, so the size **never decreases** — the recursion can run forever. The three-way fix bounds it back to $\Theta(n^2)$.
- The saving grace: hitting the minimum *every single time* has probability $\frac{1}{n}\cdot\frac{1}{n-1}\cdots = \frac{1}{n!}$, essentially zero. Bad luck is possible but astronomically unlikely — which is exactly what the expected-time analysis formalizes.

![The staircase recursion: picking the extreme pivot each time peels one element off, giving segment sizes n, n-1, n-2, ... and total work Theta(n squared)](/img/dsa/jHDgr-dKhgA/frame-00088.png)

[watch from 19:03](https://youtu.be/jHDgr-dKhgA?t=1143)

---

## Expected time: $\Theta(n\log n)$

- Each pivot lands some rank uniformly at random, so if $k$ elements go left, $k$ is uniform on $0,1,\dots,n-1$. The expected cost obeys

$$
T(n) = n + \frac{1}{n}\sum_{k=0}^{n-1}\Big(T(k) + T(n-k)\Big),
$$

where the $n$ is the linear partition work and the sum averages the two recursive calls over the random pivot rank.

- **A clean way to bound it (the "middle third" argument).** Call a pivot **good** if its rank lands in the middle third of the segment — between $\tfrac{n}{3}$ and $\tfrac{2n}{3}$. A good pivot gives both sides size at most $\tfrac{2n}{3}$.
  - $\Pr[\text{good}] = \tfrac{1}{3}$, and even in the worst "bad" case a side is at most $n$. So

$$
T(n) \le n + \tfrac{1}{3}\Big(T\big(\tfrac{n}{3}\big) + T\big(\tfrac{2n}{3}\big)\Big) + \tfrac{2}{3}\,T(n).
$$

- Move the $\tfrac{2}{3}T(n)$ term to the left and multiply through by 3:

$$
T(n) \le 3n + T\big(\tfrac{n}{3}\big) + T\big(\tfrac{2n}{3}\big).
$$

![The expected-cost recurrence T(n) = n + (1/n) sum of T(k)+T(n-k), reduced via the good-split probability 1/3 to T(n) ≤ n + (1/3)(T(n/3)+T(2n/3)) + (2/3)T(n)](/img/dsa/jHDgr-dKhgA/frame-00134.png)

- **Induction proof that $T(n) \le c\,n\log n$.** Assume it for all sizes below $n$. Substitute $T(\tfrac{n}{3})$ and $T(\tfrac{2n}{3})$:

$$
T(n) \le 3n + c\tfrac{n}{3}\log\tfrac{n}{3} + c\tfrac{2n}{3}\log\tfrac{2n}{3}.
$$

Using $\log\tfrac{n}{3} = \log n - \log 3$ and grouping the $\log n$ terms (their coefficients $c\tfrac{n}{3} + c\tfrac{2n}{3} = cn$):

$$
T(n) \le c\,n\log n + n\Big(3 - c\big(\tfrac{1}{3}\log 3 + \tfrac{2}{3}\log\tfrac{3}{2}\big)\Big).
$$

For $c$ large enough the bracket is negative, so $T(n) \le c\,n\log n$. $\blacksquare$

![Induction step: expanding T(n) ≤ 3n + c(n/3)log(n/3) + c(2n/3)log(2n/3), collecting the c·n·log n term and choosing c large so the leftover bracket is ≤ 0](/img/dsa/jHDgr-dKhgA/frame-00142.png)

- **Intuition without algebra.** Roughly every third pivot is good, and each good pivot shrinks the segment to at most $\tfrac{2n}{3}$. So after about $3\log_{3/2} n$ pivots the segment is down to size 1: recursion depth is $\Theta(\log n)$, each level costs $\Theta(n)$, total $\Theta(n\log n)$.
- **Master theorem?** It does not apply cleanly here — the two recursive calls have *different* argument sizes ($\tfrac{n}{3}$ and $\tfrac{2n}{3}$), so the standard $a\,T(n/b)+f(n)$ form does not fit. The induction above is the right tool.
- **Practical constant tuning (still $\Theta(n\log n)$):** pick the median of 3 (or 5) random samples as the pivot. This raises the chance of a balanced split, shrinking the hidden constant without changing the asymptotics. This is why quicksort is "quick" in practice — it beats heap sort's constant and, unlike merge sort, sorts in place.

[watch from 25:27](https://youtu.be/jHDgr-dKhgA?t=1527)

---

## Order statistics: quickselect (expected $O(n)$)

- **Problem.** Given an array and an index $k$, return the element that *would* sit at position $k$ if the array were sorted — the **k-th order statistic**. The obvious solution sorts and indexes: $O(n\log n)$. We can do **expected $O(n)$**.
- **Quickselect** partitions exactly like quicksort but then recurses into **only one** side — whichever contains rank $k$:
  - if `k` is below the "less than $x$" boundary, the answer is in the left part;
  - if `k` lands among the pivot-equal elements, the pivot *is* the answer;
  - otherwise it is in the right "greater than $x$" part.
- The invariant maintained is `l ≤ k < r`: the target rank always lies inside the current segment.
- **Same duplicate trap as quicksort.** The board draws the two-way split, which — exactly like naive quicksort — stalls when the pivot value is duplicated: if every element is `≥ x` then `m == l` and `find(a, m, r, k)` recurses on the *same* segment forever. The fix is the same three-way (Dutch-flag) partition: if rank `k` falls inside the `== x` band, the pivot itself is the answer and no recursion is needed.

The board idea, made duplicate-safe with the three-way partition:

```cpp
int find(vector<int>& a, int l, int r, int k) {
    // return the element of rank k (0-indexed) in sorted order; invariant: l ≤ k < r
    if (r - l == 1)                          // single element left → that is the answer
        return a[l];
    int x = a[l + rand() % (r - l)];         // random pivot value
    int lt = l, i = l, gt = r;               // a[l:lt] < x, a[lt:i] == x, a[gt:r] > x
    while (i < gt) {                         // same linear (three-way) partition
        if (a[i] < x) {
            swap(a[i], a[lt]);
            lt++;
            i++;
        } else if (a[i] > x) {
            gt--;
            swap(a[i], a[gt]);               // do not advance i: swapped-in value unchecked
        } else {
            i++;
        }
    }
    if (k < lt)
        return find(a, l, lt, k);            // rank k is in the "< x" part
    else if (k < gt)
        return x;                            // rank k lands in the "== x" band → answer
    else
        return find(a, gt, r, k);            // rank k is in the "> x" part
}

int kth_order_statistic(vector<int>& a, int k) {
    return find(a, 0, a.size(), k);
}
```

- **Why linear, not $n\log n$?** Quicksort makes **two** recursive calls; quickselect makes **one**. With good splits (again, probability $\tfrac{1}{3}$) the segment shrinks to at most $\tfrac{2n}{3}$ before the single recursive call, so the expected work is a *geometric* series, not a tree:

$$
n + \tfrac{2}{3}n + \big(\tfrac{2}{3}\big)^2 n + \dots = n\cdot\frac{1}{1 - \tfrac{2}{3}} = 3n = O(n).
$$

![Quickselect find(l, r, k): partition once, compare k against boundary m, then a single recursive call into find(l, m, k) or find(m, r, k)](/img/dsa/jHDgr-dKhgA/frame-00219.png)

![The single-recursion intuition: every third pick is good and shrinks the segment to ≤ 2n/3, so total cost is the geometric sum n + 2n/3 + 4n/9 + ... = O(n)](/img/dsa/jHDgr-dKhgA/frame-00203.png)

[watch from 46:28](https://youtu.be/jHDgr-dKhgA?t=2788)

---

## Deterministic $O(n)$: median of medians

- Randomization is only needed to find a **good pivot**. If we could *deterministically* guarantee a good pivot, we would drop the randomness while keeping linear time. That is the **Blum–Floyd–Pratt–Rivest–Tarjan** algorithm (median of medians).
- **Choosing the pivot deterministically:**
  1. Break the array into $\lceil n/5 \rceil$ **blocks of 5** consecutive elements.
  2. **Sort each block** and take its **median** (a constant-cost operation per block, so $O(n)$ over all blocks).
  3. Take the **median of those $n/5$ medians** — recursively, using the *same* selection algorithm — and use it as the pivot $x$.
- **Why the pivot is good.** The median-of-medians $x$ beats at least half of the block medians, and each of those blocks contributes 3 elements (its median and the two smaller) that are `≤ x`. That forces at least about $\tfrac{3}{10}n$ elements on each side, so the *other* side has at most

$$
\frac{7n}{10}
$$

elements. Neither recursive call ever exceeds $\tfrac{7n}{10}$.

![Median-of-medians pivot: split into n/5 blocks of 5, take each block median, then the median of medians x; the elements guaranteed ≤ x force each side to at most 7n/10](/img/dsa/jHDgr-dKhgA/frame-00280.png)

Putting the two recursive costs together — one call of size $n/5$ to find the median of medians, one call of size at most $7n/10$ to recurse into the correct side, plus $O(n)$ partition work:

$$
T(n) = n + T\Big(\tfrac{n}{5}\Big) + T\Big(\tfrac{7n}{10}\Big).
$$

- **Induction that $T(n) \le c\,n$.** Substitute the bound into both terms:

$$
T(n) \le n + c\tfrac{n}{5} + c\tfrac{7n}{10} = n + c\,n\Big(\tfrac{1}{5} + \tfrac{7}{10}\Big) = n + \tfrac{9}{10}c\,n.
$$

Requiring $n + \tfrac{9}{10}cn \le cn$ gives $1 \le \tfrac{c}{10}$, i.e. $c \ge 10$. Pick $c = 10$: $T(n) \le 10n = O(n)$. $\blacksquare$

- The key that makes the recursion collapse: $\tfrac{1}{5} + \tfrac{7}{10} = \tfrac{9}{10} < 1$, so the two subproblems are *strictly smaller than the whole* — the sum of sizes shrinks by a constant factor, which is exactly the shape that yields linear time.

![The median-of-medians recurrence T(n) = n + T(n/5) + T(7n/10), whose sub-size sum 1/5 + 7/10 = 9/10 < 1 collapses to T(n) = O(n)](/img/dsa/jHDgr-dKhgA/frame-00286.png)

- **Reality check:** blocks of 5 are chosen because they make $\tfrac{1}{5} + \tfrac{7}{10} < 1$; blocks of 3 give $\tfrac{1}{3} + \tfrac{2}{3} = 1$ and the proof fails. In practice the constant is large, so randomized quickselect is preferred; median-of-medians matters as the **theoretical guarantee** of deterministic linear selection.

[watch from 60:05](https://youtu.be/jHDgr-dKhgA?t=3605)

---

## Complexity recap

| Routine | Best | Average / Expected | Worst | Space |
| --- | --- | --- | --- | --- |
| Quicksort (random pivot) | $\Theta(n\log n)$ | $\Theta(n\log n)$ | $\Theta(n^2)$ | $O(\log n)$ stack |
| Quicksort (3-way, duplicates) | $\Theta(n)$ all-equal | $\Theta(n\log n)$ | $\Theta(n^2)$ | $O(\log n)$ stack |
| Partition step | $\Theta(n)$ | $\Theta(n)$ | $\Theta(n)$ | $O(1)$ |
| Quickselect (random pivot) | $\Theta(n)$ | $\Theta(n)$ | $\Theta(n^2)$ | $O(1)$ iter / $O(\log n)$ rec |
| Median-of-medians select | $\Theta(n)$ | $\Theta(n)$ | $\Theta(n)$ | $O(\log n)$ stack |

---

## Practice problems

Quickselect and the partition routine are the interview payload of this lecture; the three-way partition is the Dutch-flag pattern.

**🎯 Interview (MAANG-style)**

- [Kth Largest Element in an Array — LeetCode 215](https://leetcode.com/problems/kth-largest-element-in-an-array/) — Medium — the canonical quickselect problem (expected $O(n)$).
- [Sort an Array — LeetCode 912](https://leetcode.com/problems/sort-an-array/) — Medium — implement quicksort (or merge sort) from scratch; beware the all-equal worst case.
- [Sort Colors — LeetCode 75](https://leetcode.com/problems/sort-colors/) — Medium — Dutch national flag: the exact three-way partition, in one pass.
- [Wiggle Sort II — LeetCode 324](https://leetcode.com/problems/wiggle-sort-ii/) — Hard — find the median by quickselect, then a virtual-indexed three-way partition.
- [Kth Largest Element in a Stream — LeetCode 703](https://leetcode.com/problems/kth-largest-element-in-a-stream/) — Easy — contrast: streaming data wants a size-$k$ heap, not quickselect (which needs the whole array in memory).
- [QuickSort — GeeksforGeeks](https://www.geeksforgeeks.org/quick-sort/) — Medium — reference implementation and partition variants.
- [QuickSelect (Kth Smallest/Largest) — GeeksforGeeks](https://www.geeksforgeeks.org/quickselect-algorithm/) — Medium — selection without full sorting.
- [Kth Smallest/Largest in Unsorted Array — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/kth-smallest-largest-element-in-unsorted-array/) — Medium — walks heap, sort, and quickselect trade-offs.

**🏆 Competitive**

- [Distinct Values Queries / selection drills — CSES 1621 (Distinct Numbers)](https://cses.fi/problemset/task/1621) — Easy — sorting-as-a-subroutine warm-up on large arrays.
- [Official home tasks & discussion — Codeforces](https://codeforces.com/blog/entry/83028) — the quicksort / order-statistics problem set Pavel assigned for this lecture (linked from the video description).

---

## Further reading

- [Quicksort — Wikipedia](https://en.wikipedia.org/wiki/Quicksort) — pivot strategies, Hoare vs Lomuto partition, and the expected-time proof.
- [Quickselect — Wikipedia](https://en.wikipedia.org/wiki/Quickselect) — the single-recursion selection algorithm.
- [Median of medians — Wikipedia](https://en.wikipedia.org/wiki/Median_of_medians) — the deterministic pivot and the $7n/10$ argument.
- [Selection algorithm — Wikipedia](https://en.wikipedia.org/wiki/Selection_algorithm) — survey of order-statistic algorithms and lower bounds.
- [Dutch national flag problem — Wikipedia](https://en.wikipedia.org/wiki/Dutch_national_flag_problem) — the three-way partition used for duplicates.

---

## Key takeaways

- Randomization buys robustness: a random pivot has no fixed adversarial input, so the *expected* time is $\Theta(n\log n)$ even though the worst case stays $\Theta(n^2)$.
- The partition invariant — `a[l:m]` are `< x` — is the whole correctness argument; the boundary index $m$ is where the two recursive calls split.
- Duplicates break the naive two-way split (all-equal input loops forever); the three-way Dutch-flag partition fixes it.
- Selection is cheaper than sorting: quickselect recurses into **one** side, turning the recursion tree into a geometric series → expected $O(n)$.
- Median-of-medians makes the good-pivot guarantee deterministic via blocks of 5, giving a $7n/10$ split and worst-case $O(n)$ — a beautiful theoretical result, though the constant keeps the randomized version dominant in practice.

## Glossary

- **Randomized algorithm** — one whose behavior depends on internal random bits; analyzed by expected cost over those bits for the worst input.
- **Pivot** — the element $x$ used to partition a segment into smaller and larger parts.
- **Partition** — rearranging a segment so all elements `< x` precede all elements `≥ x`; runs in $\Theta(n)$.
- **Order statistic** — the element at a given rank $k$ in sorted order (the $k$-th smallest).
- **Quickselect** — quicksort's partition with a single recursive call into the side holding rank $k$; expected $O(n)$.
- **Median of medians** — deterministic pivot rule (median of block-of-5 medians) guaranteeing worst-case $O(n)$ selection.
- **Dutch national flag** — three-way partition into `< x`, `== x`, `> x` in one pass.
