---
title: "S01E05 · Binary Search"
sidebar_position: 5
description: The lo/hi search and its loop invariant, the universal boundary search over a monotone predicate, lower_bound/upper_bound, binary search on the answer with exponential bracketing, epsilon vs fixed-iteration real search, and ternary search with the golden-ratio speedup.
---

# S01E05 · Binary Search

> **Source:** Pavel Mavrin, [_A&DS S01E05_](https://youtu.be/GWj9PcBgyy4) · 1h24m lecture → ~14 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- **Binary search** shrinks a search segment by half each step, so it costs $\Theta(\log n)$ — but the naive three-branch version is riddled with off-by-one traps.
- The **universal formulation** searches for a *boundary* in a monotone `false…false true…true` sequence: keep `a[l] < x` and `a[r] ≥ x`, halve `[l, r]` until they are adjacent, and return `r`. One invariant, no `±1` guesswork.
- **Sentinels** `l = -1`, `r = n` let the search report "no answer" cleanly (`r == n`) without ever touching an out-of-range index, because the probe `m` is always **strictly** between `l` and `r`.
- `lower_bound` (leftmost `≥ x`) and `upper_bound` (leftmost `> x`) are the same loop with a different comparison — that comparison *is* the predicate.
- **Binary search on the answer** (parametric search) applies whenever a `good(x)` test is **monotone**: pack rectangles into a square, gather people on a line — you binary-search over the answer, not over an array.
- For real-valued answers, prefer a **fixed iteration count** (e.g. 100 halvings) over an `epsilon` loop; floating-point spacing can make `l` and `r` un-narrowable and hang an `epsilon` loop forever.
- **Ternary search** finds the peak of a unimodal function in $\Theta(\log n)$ probes; the **golden-ratio** variant reuses one function value per step and halves the number of costly evaluations.

---

## The problem and the naive search

- **Setup.** A sorted array `a = [2, 5, 6, 10, 12, 18, 21]` and a target `x = 18`; find an index `i` with `a[i] == x`.
- **Idea.** Maintain a segment `[l, r]` with the invariant "if `x` is present, it lies in `a[l..r]`". Probe the middle `m = l + (r - l) / 2` (integer division) and use sortedness to discard half.
- **Three cases** at each step:
  - `a[m] < x` → everything left of `m` is also `< x`; recurse right: `l = m + 1`.
  - `a[m] > x` → everything right of `m` is also `> x`; recurse left: `r = m - 1`.
  - `a[m] == x` → found it, return `m`.

```cpp
int binary_search(const vector<int>& a, int x) {
    int l = 0, r = (int)a.size() - 1;
    while (r - l + 1 >= 1) {             // segment a[l..r] is non-empty
        int m = l + (r - l) / 2;        // avoids l + r overflow
        if (a[m] < x)      l = m + 1;
        else if (a[m] > x) r = m - 1;
        else               return m;    // any index with a[m] == x
    }
    return -1;                          // not found
}
```

![Naive three-branch binary search: pointers l, m, r on the sorted array with l+r over 2 as the midpoint and the three-case split](/img/dsa/GWj9PcBgyy4/frame-00030.png)

- **Why $\Theta(\log n)$:** each iteration replaces a segment of size $s$ with one of size at most $\lceil s/2 \rceil$. Starting from $n$, the count of halvings until the segment is empty is

$$
k \le \log_2 n + 1 = \Theta(\log n).
$$

- **Why it is awkward:** three branches, an asymmetric `m + 1` / `m - 1`, and — if several entries equal `x` — it returns *some* matching index, not a well-defined one. Good enough for "is `x` here?", bad as a building block. The rest of the lecture replaces it.

[watch from 6:16](https://youtu.be/GWj9PcBgyy4?t=376)

---

## The universal formulation: search for a boundary

- **Reframe the goal.** Instead of "find `x`", find the **leftmost element `≥ x`** (the `lower_bound`). This answers "is `x` present?", "what is the closest element on each side?", and "where would `x` be inserted?" all at once.
- **Two pointers, one invariant.** Keep `l` and `r` so that:

$$
a[l] < x \qquad\text{and}\qquad a[r] \ge x .
$$

  Think of the array as split into a `< x` region on the left and a `≥ x` region on the right — a monotone `false…false true…true` pattern. We are hunting the seam between them.

- **Sentinels fix initialization.** If every element is `< x`, no real index satisfies `a[r] ≥ x`; if every element is `≥ x`, no index satisfies `a[l] < x`. So imagine two virtual elements: `a[-1] = -∞` and `a[n] = +∞`, and initialize

  ```cpp
  int l = -1, r = n;
  ```

  These are never physically stored — the loop never reads `a[l]` or `a[r]`, only `a[m]`, and `m` stays strictly inside `(l, r)`.

- **The loop.** While `l` and `r` are not yet adjacent, probe the middle and move whichever pointer keeps its invariant true:

```cpp
int lower_bound(const vector<int>& a, int x) {
    int n = (int)a.size();
    int l = -1, r = n;              // virtual a[-1] = -inf, a[n] = +inf
    while (r - l > 1) {             // stop when l and r are adjacent
        int m = l + (r - l) / 2;   // l < m < r always -> never touches a[-1] or a[n]
        if (a[m] >= x) r = m;      // a[m] >= x keeps a[r] >= x
        else           l = m;      // a[m] <  x keeps a[l] <  x
    }
    return r;                       // leftmost index with a[r] >= x; r == n means none exist
}
```

![The universal lower_bound: l=-1, r=n sentinels, invariant a[l] below x and a[r] at-or-above x, midpoint strictly inside, return r; r==n signals no element at-or-above x](/img/dsa/GWj9PcBgyy4/frame-00108.png)

- **Termination is guaranteed.** Because `l < m < r`, each iteration sets either `l = m` or `r = m` with `m` strictly between them, so `r - l` strictly decreases. The loop ends exactly when `r == l + 1`.
- **Reading the result.** At exit `a[l] < x ≤ a[r]`, and `r` is the smallest index with `a[r] ≥ x`. If `r == n`, no element is `≥ x` (all are smaller). To test *exact presence*: check `r < n && a[r] == x`.
- **This is the whole trick.** Every later section is this same loop with a different "is the probe on the `true` side?" test.

[watch from 15:59](https://youtu.be/GWj9PcBgyy4?t=959)

---

## lower_bound, upper_bound, and the mirror search

- **Choosing the comparison is choosing the predicate.** The loop body asks one yes/no question about `a[m]`; swapping that question changes which boundary you land on.

| Want | Predicate `true` when | Move on `true` | Answer |
| --- | --- | --- | --- |
| leftmost `≥ x` (`lower_bound`) | `a[m] >= x` | `r = m` | `r` |
| leftmost `> x` (`upper_bound`) | `a[m] > x` | `r = m` | `r` |
| rightmost `≤ x` | `a[m] <= x` | `l = m` | `l` |
| rightmost `< x` | `a[m] < x` | `l = m` | `l` |

- **`upper_bound`** — leftmost element strictly greater than `x` — is one character different:

```cpp
int upper_bound(const vector<int>& a, int x) {
    int n = (int)a.size();
    int l = -1, r = n;
    while (r - l > 1) {
        int m = l + (r - l) / 2;
        if (a[m] > x) r = m;        // strictly greater is the only change
        else          l = m;
    }
    return r;
}
```

- **The mirror search** — rightmost element `≤ x` — keeps `a[l] ≤ x` and `a[r] > x`, then returns `l`:

```cpp
int rightmost_le(const vector<int>& a, int x) {
    int n = (int)a.size();
    int l = -1, r = n;              // a[-1] = -inf, a[n] = +inf
    while (r - l > 1) {
        int m = l + (r - l) / 2;
        if (a[m] <= x) l = m;       // a[m] <= x keeps a[l] <= x; take the RIGHT one
        else           r = m;
    }
    return l;                       // rightmost index with a[l] <= x; l == -1 means none exist
}
```

- **Handy consequence.** `upper_bound(a, x) - lower_bound(a, x)` is the count of elements equal to `x`, in $\Theta(\log n)$ — no linear scan.

![lower_bound on the board for x=3 finding the minimal index with a[i] at-or-above x, contrasted with the three-branch version returning m](/img/dsa/GWj9PcBgyy4/frame-00050.png)

[watch from 25:30](https://youtu.be/GWj9PcBgyy4?t=1530)

---

## Binary search on a predicate

- **Generalize past arrays.** Drop the array entirely. Suppose every integer is labelled `good` or `bad`, and the labelling is **monotone**:

$$
x \text{ is good} \ \text{and}\ y \ge x \ \implies\ y \text{ is good}.
$$

  On the number line this is `bad … bad | good … good` with a single seam. The task: find the **minimum good** value.

- **Same loop, `good(m)` as the test.** Keep `good(l)` false and `good(r)` true; return `r`.

```cpp
long long min_good(long long l, long long r, const function<bool(long long)>& good) {
    // precondition: good(l) is false, good(r) is true
    while (r - l > 1) {
        long long m = l + (r - l) / 2;
        if (good(m)) r = m;         // keep good(r) true
        else         l = m;         // keep good(l) false
    }
    return r;                       // minimal good value
}
```

![The predicate picture: E split into good and bad, monotone x-good implies y-good, the bad/good seam on the number line, and the min_good loop returning l or r depending on framing](/img/dsa/GWj9PcBgyy4/frame-00131.png)

- **The engine is fixed; only `good` changes.** In every real problem the entire difficulty is *writing a correct, monotone `good(x)`* — the search itself is boilerplate you never touch.
- **A note on which endpoint you return.** If you frame `good` as "`≥ x`" and want the first `good`, return `r`. If you frame the seam as "last `good`" (a `good…good bad…bad` picture), return `l`. Pick the framing so the monotonicity runs the natural direction, then read off the matching pointer.

[watch from 28:33](https://youtu.be/GWj9PcBgyy4?t=1713)

---

## Binary search on the answer: packing rectangles

- **Problem.** Given `n` rectangles of size `w × h`, find the smallest square of side `x` that fits all `n` of them (axis-aligned, laid out in a grid).
- **The monotone test.** Define `x` is *good* if all `n` rectangles fit in an `x × x` square. If side `x` works, any larger side works too — enlarge the square and the same layout fits — so `good` is monotone. 
- **Implement `good(x)`.** In an `x × x` square you can place `⌊x / w⌋` rectangles across and `⌊x / h⌋` down, so the capacity is their product:

```cpp
bool good(long long x, long long w, long long h, long long n) {
    return (x / w) * (x / h) >= n;
}
```

![Rectangle packing: h by w tiles in an x-by-x grid, capacity (x//w)*(x//h), the min_good loop, and good(x) returning (x//w)*(x//h) at-least n](/img/dsa/GWj9PcBgyy4/frame-00169.png)

- **Bracketing the search: find `l` and `r` first.** `min_good` needs a `bad` lower bound and a `good` upper bound.
  - `l = 0` is safely `bad`: a zero-side square holds nothing (for `n ≥ 1`).
  - For `r`, one safe-but-huge choice is `max(w, h) · n` (a single row of all rectangles). But that value can be enormous — up to $10^{18}$ when `n, w, h ≤ 10^9` — and squaring it inside `good` risks 64-bit **overflow** in languages with fixed-width integers.

- **Exponential bracketing** finds a *small* good `r` instead of guessing a giant one: start at `1` and double until the test passes.

```cpp
long long find_min_square(long long w, long long h, long long n) {
    auto good = [&](long long x) { return (x / w) * (x / h) >= n; };

    long long r = 1;
    while (!good(r)) r *= 2;         // exponential search: 1, 2, 4, 8, ... (stops at r <= 2 * answer)
    long long l = r / 2;            // previous power of two was bad (or l = 0)

    while (r - l > 1) {            // standard boundary search on [l, r]
        long long m = l + (r - l) / 2;
        if (good(m)) r = m;
        else         l = m;
    }
    return r;
}
```

![Exponential bracketing r = 1; while not good(r): r *= 2, then the boundary search, with the n up-to 1e9, w,h up-to 1e9, r = 1e18 overflow analysis](/img/dsa/GWj9PcBgyy4/frame-00196.png)

- **Why this dodges overflow.** The doubling stops at the first good `r`, which is at most twice the true answer. There, `x / w` and `x / h` (integer division) are each roughly the count that fits along one side, so their product stays near `n` (small) rather than blowing up to $10^{36}$. Cost: $O(\log(\text{answer}))$ doublings plus the usual $O(\log(\text{answer}))$ search.
- **Language note.** C++ has fixed-width integers, so a giant `r` really can overflow — even `long long` tops out near $9.2 \times 10^{18}$, and squaring $10^{18}$ is hopeless. Exponential bracketing keeps every factor small; where a product could still be large, use `long long` (or `__int128` for one wide multiply) and reason about the maximum value each factor can take before it is computed.

[watch from 31:24](https://youtu.be/GWj9PcBgyy4?t=1884)

---

## Real-valued answers: the gathering problem

- **Problem.** `n` people sit at coordinates `x[i]` on a line, each able to move at speed up to `v[i]` in either direction. Find the **minimum time** `t` for all of them to meet at one common point.
- **Monotone test.** `t` is *good* if they can all reach a common point within time `t`. More time never hurts (reach the point early, then wait), so `good` is monotone in `t`.
- **Implement `good(t)`.** In time `t`, person `i` can occupy any coordinate in the segment `[x[i] − t·v[i], x[i] + t·v[i]]`. They can meet iff all these segments share a common point, i.e. the largest left endpoint does not exceed the smallest right endpoint:

$$
\max_i \big(x_i - t\,v_i\big) \ \le\ \min_i \big(x_i + t\,v_i\big).
$$

```cpp
bool good(double t, const vector<double>& xs, const vector<double>& vs) {
    double lo = -1e18, hi = 1e18;
    for (size_t i = 0; i < xs.size(); i++) {
        lo = max(lo, xs[i] - t * vs[i]);          // highest left endpoint
        hi = min(hi, xs[i] + t * vs[i]);          // lowest right endpoint
    }
    return lo <= hi;                              // segments share a point
}
```

![The gathering problem: people with coordinates x_i and speeds v_i, each reachable segment from x_i minus t v_i to x_i plus t v_i, good(t) tests max left endpoint at-most min right endpoint](/img/dsa/GWj9PcBgyy4/frame-00242.png)

- **The answer is a real number**, so we search over reals. The naive `epsilon` loop:

```cpp
double min_time_eps(const vector<double>& xs, const vector<double>& vs, double eps = 1e-9) {
    double lo = 0.0, hi = 1e10;    // good(lo) is false, good(hi) is true
    while (hi - lo > eps) {
        double m = (lo + hi) / 2;
        if (good(m, xs, vs)) hi = m;
        else                 lo = m;
    }
    return hi;
}
```

- **Why `epsilon` is dangerous.** Doubles carry ~15–16 significant digits. If the answer is around $10^9$, then two *adjacent* representable doubles already differ by about $10^{9} \cdot 10^{-16} = 10^{-7}$ — larger than an `eps` of $10^{-9}$. The loop can never make `hi − lo` that small, `m` collapses onto `lo` or `hi`, and it **spins forever**.

- **Prefer a fixed iteration count.** A plain `for` loop cannot hang, and 100 halvings shrink the interval by $2^{100} \approx 10^{30}$ — far past any useful precision:

```cpp
double min_time(const vector<double>& xs, const vector<double>& vs) {
    double lo = 0.0, hi = 1e10;    // bracket: 0 is bad, 1e10 is good
    for (int it = 0; it < 100; it++) {   // 100 halvings -> interval / 2^100
        double m = (lo + hi) / 2;
        if (good(m, xs, vs)) hi = m;
        else                 lo = m;
    }
    return hi;
}
```

- **Rule of thumb.** Real-valued binary search → fixed loop count (50–100). It is the safest, most predictable option; trim the count only if it times out.

[watch from 49:19](https://youtu.be/GWj9PcBgyy4?t=2959)

---

## Ternary search: optimizing a unimodal function

- **Problem.** A function `f` is **unimodal** on `[l, r]`: it strictly increases up to a peak, then strictly decreases. You can only *evaluate* `f` at a point (you cannot ask "is it rising here?"). Find the peak.
- **Invariant.** Keep `l` and `r` bracketing the peak (the maximum lies in `[l, r]`), and shrink the bracket by comparing two interior probes.
- **Two probes at the thirds.** Split `[l, r]` into three:

$$
m_1 = l + \frac{r - l}{3} = \frac{2l + r}{3}, \qquad m_2 = r - \frac{r - l}{3} = \frac{l + 2r}{3}.
$$

  Compare `f(m1)` and `f(m2)`:
  - `f(m1) < f(m2)` → the peak cannot be left of `m1`; discard `[l, m1]` by setting `l = m1`.
  - `f(m1) > f(m2)` → the peak cannot be right of `m2`; discard `[m2, r]` by setting `r = m2`.
  - (equal → discard either outer third; safe under strict unimodality)

```cpp
double ternary_search(const function<double(double)>& f, double l, double r) {
    for (int it = 0; it < 200; it++) {  // fixed count: interval / (2/3)^200
        double m1 = l + (r - l) / 3;
        double m2 = r - (r - l) / 3;
        if (f(m1) < f(m2)) l = m1;      // peak is right of m1
        else               r = m2;      // peak is left of m2
    }
    return (l + r) / 2;                 // argmax; f((l+r)/2) is the maximum
}
```

![Ternary search over a unimodal f: increasing then decreasing, probes m1 = (2l+r)/3 and m2 = (l+2r)/3 at the thirds of [l, r]](/img/dsa/GWj9PcBgyy4/frame-00296.png)

- **Complexity.** Each step keeps two of the three parts, so the interval shrinks by a factor of $2/3$: still $\Theta(\log n)$ iterations to reach a target width, just with base $3/2$ instead of $2$.
- **The accuracy trap.** If `m1` and `m2` sit very close together on a nearly-flat stretch, `f(m1)` and `f(m2)` are almost equal, floating-point noise can flip the comparison, and you may discard the **wrong** third and lose the peak. Keep the two probes reasonably far apart (as the thirds do).

- **Golden-ratio speedup.** The costly part is *evaluating* `f`; the plain version spends two fresh evaluations per step. Choose the split ratio $\alpha$ so that after moving, one of the new probes lands exactly on a previously computed point — then only **one** new evaluation is needed per step. Requiring the reused point to coincide gives

$$
(1 - \alpha)^2 = \alpha \ \Longleftrightarrow\ \alpha^2 - 3\alpha + 1 = 0,
$$

  whose relevant root is $\alpha = \dfrac{3 - \sqrt{5}}{2} \approx 0.382$ (tied to the golden ratio $\varphi = \tfrac{1+\sqrt5}{2}$). This roughly **halves** the number of function evaluations for the same convergence — the payoff when `f` is expensive.

[watch from 1:07:19](https://youtu.be/GWj9PcBgyy4?t=4039)

---

## Complexity recap

| Routine | Best | Average | Worst | Space |
| --- | --- | --- | --- | --- |
| Naive three-branch search | $\Theta(1)$ | $\Theta(\log n)$ | $\Theta(\log n)$ | $O(1)$ |
| Boundary search (`lower_bound` / `upper_bound`) | $\Theta(\log n)$ | $\Theta(\log n)$ | $\Theta(\log n)$ | $O(1)$ |
| Binary search on the answer | $\Theta(\log R \cdot C)$ | $\Theta(\log R \cdot C)$ | $\Theta(\log R \cdot C)$ | $O(1)$ |
| Exponential bracketing | $\Theta(\log A)$ | $\Theta(\log A)$ | $\Theta(\log A)$ | $O(1)$ |
| Real search (fixed 100 iters) | $\Theta(100 \cdot C)$ | — | $\Theta(100 \cdot C)$ | $O(1)$ |
| Ternary search | $\Theta(\log n \cdot C)$ | $\Theta(\log n \cdot C)$ | $\Theta(\log n \cdot C)$ | $O(1)$ |

Here `R` is the answer range, `A` the answer's magnitude, and `C` the cost of one `good`/`f` evaluation.

---

## Practice problems

The interview payload of this lecture is the **boundary search** (`lower_bound`/`upper_bound` done without off-by-one bugs) and **binary search on the answer** (find a monotone `good` test, then search over it).

**🎯 Interview (MAANG-style)**

- [Binary Search — LeetCode 704](https://leetcode.com/problems/binary-search/) — Easy — the canonical exact-match search; get the invariant right.
- [Search Insert Position — LeetCode 35](https://leetcode.com/problems/search-insert-position/) — Easy — literally `lower_bound`.
- [Find First and Last Position of Element in Sorted Array — LeetCode 34](https://leetcode.com/problems/find-first-and-last-position-of-element-in-sorted-array/) — Medium — `lower_bound` and `upper_bound` back to back.
- [Search in Rotated Sorted Array — LeetCode 33](https://leetcode.com/problems/search-in-rotated-sorted-array/) — Medium — a monotone half still exists; decide which side to keep.
- [Find Minimum in Rotated Sorted Array — LeetCode 153](https://leetcode.com/problems/find-minimum-in-rotated-sorted-array/) — Medium — boundary search for the rotation point.
- [Koko Eating Bananas — LeetCode 875](https://leetcode.com/problems/koko-eating-bananas/) — Medium — binary search on the answer (eating speed); `good(k)` = "finishes in time".
- [Median of Two Sorted Arrays — LeetCode 4](https://leetcode.com/problems/median-of-two-sorted-arrays/) — Hard — binary search on the partition of the smaller array.
- [Binary Search — GeeksforGeeks](https://www.geeksforgeeks.org/binary-search/) — Easy — reference implementation and iterative vs recursive forms.
- [Aggressive Cows — GeeksforGeeks](https://www.geeksforgeeks.org/aggressive-cows/) — Medium — the textbook binary-search-on-the-answer (maximize the minimum gap).

**🏆 Competitive**

- [Factory Machines — CSES 1620](https://cses.fi/problemset/task/1620) — Medium — binary search on time; `good(t)` = "the machines together make ≥ t products".
- [Official home tasks & discussion — Codeforces](https://codeforces.com/blog/entry/83518) — the problem set Pavel assigned for this lecture (linked from the video description), including the rectangle-packing and gathering problems shown on the board.

> If a problem asks for the smallest/largest value satisfying a monotone condition — or a real-valued optimum of a unimodal function — reach for binary/ternary search on the answer before anything cleverer.

---

## Further reading

- [Binary search — cp-algorithms](https://cp-algorithms.com/num_methods/binary_search.html) — the boundary formulation, on-the-answer searching, and real-valued variants.
- [Ternary search — cp-algorithms](https://cp-algorithms.com/num_methods/ternary_search.html) — unimodal optimization and the golden-ratio refinement.
- [Binary search algorithm — Wikipedia](https://en.wikipedia.org/wiki/Binary_search_algorithm) and [Ternary search — Wikipedia](https://en.wikipedia.org/wiki/Ternary_search).
- [Golden-section search — Wikipedia](https://en.wikipedia.org/wiki/Golden-section_search) — the evaluation-reusing scheme behind the $\alpha^2 - 3\alpha + 1 = 0$ ratio.
- [Binary Search — GeeksforGeeks](https://www.geeksforgeeks.org/binary-search/) — implementations, pitfalls, and complexity.

---

## Key takeaways

- Write binary search **once**, as a boundary search over a monotone predicate; never rewrite the `±1` logic per problem.
- Hold the invariant `a[l]` on the false side, `a[r]` on the true side; with sentinels `l = -1`, `r = n` the probe `m` is always strictly interior, so `a[-1]`/`a[n]` are never read.
- `lower_bound`, `upper_bound`, and the rightmost variants differ only in the comparison — and `r == n` (or `l == -1`) is the clean "no such element" signal.
- Binary search on the answer turns an optimization into a decision: build a monotone `good`, bracket it (exponential doubling avoids overflow), then search.
- For real answers, loop a **fixed** number of times, not until `eps`; floating-point spacing can otherwise stall the loop.
- Ternary search finds a unimodal peak in $\Theta(\log n)$; the golden-ratio split reuses one evaluation per step when `f` is costly.

## Glossary

- **Loop invariant** — a property true before and after every iteration; here `a[l]` false, `a[r]` true — the thing that makes the search provably correct.
- **Sentinel** — a virtual boundary element (`a[-1] = -∞`, `a[n] = +∞`) that keeps initialization and edge cases uniform without being stored.
- **`lower_bound` / `upper_bound`** — leftmost index with `a[i] ≥ x` / `a[i] > x`.
- **Predicate / monotone `good`** — a boolean test that, once true, stays true for all larger inputs — the precondition for binary search on the answer.
- **Parametric search (binary search on the answer)** — searching over the value of the answer using a monotone feasibility test instead of over an array.
- **Exponential bracketing** — doubling a bound until the test passes, to find a *small* valid upper bound and avoid overflow.
- **Unimodal** — a function that increases to a single peak then decreases (or the mirror image); the domain of ternary search.
- **Ternary search** — repeatedly discard an outer third of a bracket by comparing two interior probes, to locate a unimodal extremum.
