---
title: "S01E12 · Knapsack Problem"
sidebar_position: 12
description: The 0/1 knapsack as a dynamic program — subset-sum feasibility, the value table with reconstruction, the 1D rolling trick, why O(nW) is pseudo-polynomial and the problem is NP-complete, plus bitmask brute force, meet-in-the-middle, and bin-packing over subsets.
---

# S01E12 · Knapsack Problem

> **Source:** Pavel Mavrin, [_A&DS S01E12_](https://youtu.be/5C7JT8cVHDU) · 1h43m lecture → ~16 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- **0/1 knapsack:** $n$ items with weights $w_i$ and costs $c_i$, capacity $S$. Pick a subset with total weight $\le S$ maximizing total cost. The problem is **NP-complete** — no known algorithm is polynomial in the *input size*.
- It becomes tractable when the numbers are **small integers**: make the total weight a DP parameter. Table $D[i][j]$ answers "using the first $i$ items, can we hit weight exactly $j$?" (feasibility) or "what is the max cost at weight exactly $j$?" (values).
- The recurrence branches on the **last item** — take it or skip it: $D[i][j] = \max(D[i-1][j],\ D[i-1][j-w_{i-1}] + c_{i-1})$.
- Runtime is $O(nS)$ — **pseudo-polynomial**: polynomial in $S$'s *value* but exponential in $S$'s number of digits. A single big number like $S = 10^{18}$ kills it, which is exactly why the problem stays NP-complete.
- The $O(nS)$ table collapses to **one 1D array** by iterating $j$ downward. Item **reconstruction** walks the table backwards along the choice that produced each cell.
- When $n$ (not $S$) is small: **brute-force all $2^n$ subsets** with bitmasks, or **meet-in-the-middle** to reach $O(2^{n/2} \cdot n)$ by splitting, sorting one half, and binary-searching.
- A cousin — **bin packing** (fit all items into the fewest capacity-$S$ knapsacks) — is solved by bitmask DP over subsets: naively $O(3^n)$ via submask iteration, then $O(2^n \cdot n)$ by adding one item at a time and storing a $(\text{bins},\ \text{last load})$ pair.

---

## The classical knapsack problem

- **Setup.** $n$ items. Item $i$ has an integer **weight** $w_i$ and a **cost** (value) $c_i$. The knapsack has capacity $S$.
- **Goal.** Choose a subset of items so that $\sum w_i \le S$ and $\sum c_i$ is **maximized**.
- This shape appears constantly in real optimization work — recognizing "this is knapsack" tells you both what to try and what its limits are.
- **The catch: knapsack is NP-complete.** Informally, that means we have no algorithm that solves it fast in general, and no proof that a fast one is impossible either. For this lecture treat NP-complete as "a class we do not know how to solve efficiently."
- With **no extra constraints**, a general knapsack instance is effectively out of reach. The good news: several **special structures** make it solvable, and this lecture is a tour of them.

![Knapsack setup: n items with weights and costs, choose a subset with total weight at most S, cost maximized — labeled NP-complete](/img/dsa/5C7JT8cVHDU/frame-00018.png)

[watch from 0:37](https://youtu.be/5C7JT8cVHDU?t=37)

---

## Warm-up: subset-sum feasibility (no costs)

- Strip the costs first. Suppose costs equal weights, so we just want the largest total weight $\le S$. This is still NP-complete, but a small integer $S$ unlocks it.
- **State.** Let $D[i][j]$ be a boolean: *is it possible to choose a subset of the first $i$ items with total weight exactly $j$?*
- **Transition — branch on the last item $i-1$:**
  - It is **not** in the subset → the same target $j$ must be reachable from the first $i-1$ items: $D[i-1][j]$.
  - It **is** in the subset → remove it and the rest must reach $j - w_{i-1}$: $D[i-1][j - w_{i-1}]$.
  - These two cases are exhaustive (the last item is either in or out), so combine with **OR**.

$$
D[i][j] \;=\; D[i-1][j] \ \lor\ \big(j \ge w_{i-1} \ \land\ D[i-1][\,j - w_{i-1}\,]\big)
$$

- **Base row.** With zero items the only reachable weight is $0$: $D[0][0] = \text{true}$, everything else in row $0$ is false.
- **Answer.** Scan the last row and take the **rightmost true** — that is the maximum achievable weight $\le S$.

**Board example.** Weights $w = \lbrace 5, 3, 2, 3 \rbrace$, capacity $S = 9$. The table fills top-to-bottom, each cell reading the cell directly above (skip) and the cell $w_{i-1}$ columns to the left in the row above (take). The rightmost true in the last row lands at $j = 8$ (e.g. $3 + 2 + 3$).

![Subset-sum DP table for weights 5,3,2,3 and S=9: plus/minus grid, recurrence D[i][j]=D[i-1][j] OR D[i-1][j-w], rightmost true at 8](/img/dsa/5C7JT8cVHDU/frame-00082.png)

```cpp
#include <bits/stdc++.h>
using namespace std;

// Largest reachable total weight <= S using a subset of w.
int subset_sum_max_weight(const vector<int>& w, int S) {
    int n = w.size();
    vector<vector<char>> D(n + 1, vector<char>(S + 1, false));
    D[0][0] = true;                              // empty set reaches weight 0
    for (int i = 1; i <= n; i++)
        for (int j = 0; j <= S; j++) {
            D[i][j] = D[i - 1][j];               // skip item i-1
            if (j >= w[i - 1] && D[i - 1][j - w[i - 1]])
                D[i][j] = true;                  // take item i-1
        }
    int best = 0;
    for (int j = 0; j <= S; j++) if (D[n][j]) best = j;   // rightmost true
    return best;
}
```

- **Data structure.** A boolean table of $(n+1) \times (S+1)$ cells. Each cell is a self-contained subproblem; row $i$ depends only on row $i-1$.
- **Counting variant.** Replace the boolean by an integer "number of subsets reaching this weight" and add instead of OR — the same table then counts subsets, not just feasibility.

[watch from 10:38](https://youtu.be/5C7JT8cVHDU?t=638)

---

## Adding costs: the value table

- Now bring the costs back. Change the state from a boolean to a **number**:
- **State.** $D[i][j]$ = the **maximum total cost** of a subset of the first $i$ items whose total weight is **exactly** $j$ (or $-\infty$ if no such subset exists).
- **Transition — same two cases, now taking a max:**

$$
D[i][j] \;=\; \max\big(\underbrace{D[i-1][j]}_{\text{skip item } i-1},\ \ \underbrace{D[i-1][\,j - w_{i-1}\,] + c_{i-1}}_{\text{take item } i-1}\big)
$$

- **Unreachable weights get $-\infty$.** Since $-\infty$ is the identity for `max`, impossible states never win a comparison. Base: $D[0][0] = 0$, rest of row $0$ is $-\infty$.
- **Answer.** The best cost is $\max_{0 \le j \le S} D[n][j]$ — we do *not* need weight to equal $S$, just the best over all reachable weights.

**Board example.** Weights $w = \lbrace 5, 3, 2, 3 \rbrace$, costs $c = \lbrace 3, 2, 5, 3 \rbrace$, $S = 9$. Each cell is the max of the cell above (skip) and the cell $w_{i-1}$ to the left in the previous row **plus** $c_{i-1}$ (take). The best value in the last row is $\mathbf{10}$ — take the items of weight $3, 2, 3$ with costs $2 + 5 + 3$.

![Value knapsack table for weights 5,3,2,3 costs 3,2,5,3 S=9: recurrence max(D[i-1][j], D[i-1][j-w]+c), best cell 10 with reconstruction arrows](/img/dsa/5C7JT8cVHDU/frame-00126.png)

```cpp
#include <bits/stdc++.h>
using namespace std;

// Max cost over subsets with total weight <= S (2D table, -inf = unreachable).
long long knapsack_2d(const vector<int>& w, const vector<int>& c, int S) {
    int n = w.size();
    const long long NEG = LLONG_MIN / 4;         // stand-in for -infinity
    vector<vector<long long>> D(n + 1, vector<long long>(S + 1, NEG));
    D[0][0] = 0;
    for (int i = 1; i <= n; i++)
        for (int j = 0; j <= S; j++) {
            D[i][j] = D[i - 1][j];                       // skip
            if (j >= w[i - 1] && D[i - 1][j - w[i - 1]] > NEG)
                D[i][j] = max(D[i][j], D[i - 1][j - w[i - 1]] + c[i - 1]);  // take
        }
    long long best = 0;
    for (int j = 0; j <= S; j++) best = max(best, D[n][j]);
    return best;
}
```

[watch from 21:34](https://youtu.be/5C7JT8cVHDU?t=1294)

---

## Reconstructing the chosen items

- The table only tells you the **optimal value**. To recover **which items** were taken, walk backwards from the winning cell using the same recurrence that built it.
- At cell $(i, j)$ ask: did the value come from **above** ($D[i-1][j]$, item skipped) or from the **take** branch ($D[i-1][j - w_{i-1}] + c_{i-1}$)? Whichever matches is the predecessor; if it was the take branch, record item $i-1$ and jump left by $w_{i-1}$.
- Repeat until row $0$. The recorded items are one optimal subset (there can be several — any consistent back-link works).

```cpp
#include <bits/stdc++.h>
using namespace std;

// Rebuild one optimal item set from the 2D table.
vector<int> reconstruct(const vector<int>& w, const vector<int>& c, int S) {
    int n = w.size();
    const long long NEG = LLONG_MIN / 4;
    vector<vector<long long>> D(n + 1, vector<long long>(S + 1, NEG));
    D[0][0] = 0;
    for (int i = 1; i <= n; i++)
        for (int j = 0; j <= S; j++) {
            D[i][j] = D[i - 1][j];
            if (j >= w[i - 1] && D[i - 1][j - w[i - 1]] > NEG)
                D[i][j] = max(D[i][j], D[i - 1][j - w[i - 1]] + c[i - 1]);
        }
    int j = 0;                                   // pick the best final column
    for (int t = 0; t <= S; t++) if (D[n][t] > D[n][j]) j = t;

    vector<int> chosen;
    for (int i = n; i >= 1; i--) {
        if (D[i][j] == D[i - 1][j]) continue;    // came from "skip" — item not used
        chosen.push_back(i - 1);                 // item i-1 was taken
        j -= w[i - 1];                           // step left by its weight
    }
    reverse(chosen.begin(), chosen.end());
    return chosen;                               // 0-based item indices
}
```

[watch from 19:25](https://youtu.be/5C7JT8cVHDU?t=1165)

---

## The 1D rolling optimization

- Row $i$ only reads row $i-1$, so we do not need the whole table — **one array of length $S+1$** suffices.
- Let $dp[j]$ = best cost achievable with total weight **at most** $j$ after processing some prefix of items.
- **Critical detail: iterate $j$ from $S$ down to $w_i$.** Going downward guarantees $dp[j - w_i]$ still refers to the *previous* item's state, so each item is used **at most once** (0/1). Iterating **upward** instead would reuse an item repeatedly — which is exactly the **unbounded knapsack** below.

```cpp
#include <bits/stdc++.h>
using namespace std;

// 0/1 knapsack in O(nS) time and O(S) space.
long long knapsack_1d(const vector<int>& w, const vector<int>& c, int S) {
    int n = w.size();
    vector<long long> dp(S + 1, 0);              // dp[j] = best cost, weight <= j
    for (int i = 0; i < n; i++)
        for (int j = S; j >= w[i]; j--)          // DOWNWARD → each item used once
            dp[j] = max(dp[j], dp[j - w[i]] + c[i]);
    return dp[S];
}
```

- **Unbounded knapsack** (each item usable any number of times): the same loop but $j$ runs **upward**, so a freshly updated $dp[j - w_i]$ can feed the same item again.

```cpp
#include <bits/stdc++.h>
using namespace std;

// Unbounded knapsack: unlimited copies of each item.
long long knapsack_unbounded(const vector<int>& w, const vector<int>& c, int S) {
    int n = w.size();
    vector<long long> dp(S + 1, 0);
    for (int i = 0; i < n; i++)
        for (int j = w[i]; j <= S; j++)          // UPWARD → item reused
            dp[j] = max(dp[j], dp[j - w[i]] + c[i]);
    return dp[S];
}
```

[watch from 11:14](https://youtu.be/5C7JT8cVHDU?t=674)

---

## Why O(nS) is "pseudo-polynomial" and the problem is still NP-complete

- The DP runs in $O(nS)$: fill $n \cdot S$ cells, each in $O(1)$.
- **But $S$ is a value, not a size.** The *input size* of $S$ is its digit count — roughly $\log_2 S$ bits. So $O(nS) = O(n \cdot 2^{\log_2 S})$ is **exponential in the number of digits** of $S$. This is what "pseudo-polynomial" means: polynomial in the numeric value, exponential in the encoding length.
- **The asymmetry that makes it hard.** You can hand the algorithm a huge $S$ (say $10^{18}$) by typing a few characters — a big *number* is cheap to write. You cannot hand it a huge *array* cheaply, because that array physically occupies the input. Problems whose cost scales with a written-down number stay hard; problems whose cost scales with genuine input size are the "fast" ones.
- Contrast with earlier DPs (edit distance, LCS): their runtime depends on **string lengths** — real input size — so those are honestly polynomial. Knapsack's dependence on $S$ is the tell that it is NP-complete.
- **Practical rule of thumb from the lecture.** $S$ up to about $10^6$ is comfortable; the DP is a great fit when weights are small integers.

[watch from 30:48](https://youtu.be/5C7JT8cVHDU?t=1848)

---

## Small n: brute force over all subsets with bitmasks

- The other tractable regime: **few items**. If $2^n$ is manageable (say $n \le 25$, or $n \approx 40$ with time to spare), just **enumerate every subset**.
- **Subsets ↔ integers.** A subset $x$ of $\lbrace 0, \dots, n-1 \rbrace$ maps to an $n$-bit integer whose bit $i$ is $1$ iff item $i$ is in the set. Example: the set $\lbrace 1, 2, 4 \rbrace$ becomes $2 + 4 + 16 = 22$.
- **Bitwise vocabulary** the lecture writes out:
  - singleton set of $i$: `1 << i`
  - union $x \cup y$: `x | y`
  - intersection $x \cap y$: `x & y`
  - difference $x \setminus y$: `x & ~y` (or `x - y` when $y \subseteq x$)
  - membership "is $i$ in $x$?": `(x >> i) & 1` (equivalently `x & (1 << i)`)

![Bitmask set operations: subset of 0..n-1 as an integer, union x|y, intersection x&y, difference x and not y, membership (x››i)&1](/img/dsa/5C7JT8cVHDU/frame-00192.png)

```cpp
#include <bits/stdc++.h>
using namespace std;

// Try every subset; keep the best feasible cost. O(2^n * n).
long long brute_subsets(const vector<int>& w, const vector<int>& c, int S) {
    int n = w.size();
    long long res = 0;
    for (int x = 0; x < (1 << n); x++) {
        long long sw = 0, sc = 0;
        for (int i = 0; i < n; i++)
            if ((x >> i) & 1) { sw += w[i]; sc += c[i]; }   // i is in subset x
        if (sw <= S) res = max(res, sc);
    }
    return res;
}
```

- **Complexity** $O(2^n \cdot n)$. When you have an exponential factor, that factor is what you fight to shrink — the polynomial $n$ is usually the smaller worry.

![Enumerate all subsets x from 0 to 2^n - 1, sum weight and cost, update answer if weight ≤ S](/img/dsa/5C7JT8cVHDU/frame-00219.png)

[watch from 40:22](https://youtu.be/5C7JT8cVHDU?t=2422)

---

## Meet in the middle: 2^(n/2) instead of 2^n

- Splitting the exponent is a huge win. **Split the $n$ items into two halves** of size $\approx n/2$. Any subset is a left part $x$ plus a right part $y$, and the constraint decomposes:

$$
w_1(x) + w_2(y) \le S, \qquad c_1(x) + c_2(y) \to \max
$$

- **Idea.** Enumerate all $2^{n/2}$ right-half subsets into an array of $(\text{weight},\ \text{cost})$ pairs. Then for each of the $2^{n/2}$ left-half subsets $x$, we need the best right subset with $w_2(y) \le S - w_1(x)$.
- **The trick that avoids the $2^{n/2} \times 2^{n/2}$ blow-up:** sort the right array by weight and precompute a **prefix-max of cost**. For a fixed $x$ the allowed $y$'s are exactly a **prefix** of the sorted array (all weights $\le S - w_1(x)$), so a **binary search** finds the prefix boundary and the precomputed max gives the answer in $O(\log)$.

![Meet in the middle: for each x find optimal y with w1(x)+w2(y) ≤ S, sort right subsets by weight, binary search the valid prefix](/img/dsa/5C7JT8cVHDU/frame-00249.png)

```cpp
#include <bits/stdc++.h>
using namespace std;

// Meet-in-the-middle 0/1 knapsack. O(2^(n/2) * n) after the sort.
long long meet_in_middle(const vector<int>& w, const vector<int>& c, int S) {
    int n = w.size();
    int nl = n / 2, nr = n - nl;

    // Enumerate all subsets of a contiguous block into (weight, cost) pairs.
    auto gen = [&](int base, int cnt) {
        vector<pair<long long,long long>> v;
        for (int x = 0; x < (1 << cnt); x++) {
            long long sw = 0, sc = 0;
            for (int i = 0; i < cnt; i++)
                if ((x >> i) & 1) { sw += w[base + i]; sc += c[base + i]; }
            v.push_back({sw, sc});
        }
        return v;
    };

    auto L = gen(0, nl);
    auto R = gen(nl, nr);
    sort(R.begin(), R.end());                    // sort right half by weight

    vector<long long> pref(R.size());            // prefix max of cost
    for (size_t i = 0; i < R.size(); i++)
        pref[i] = i ? max(pref[i - 1], R[i].second) : R[i].second;

    long long res = 0;
    for (auto& [wx, cx] : L) {
        if (wx > S) continue;
        long long cap = S - wx;
        // rightmost index with R[.].weight <= cap
        int lo = 0, hi = (int)R.size() - 1, pos = -1;
        while (lo <= hi) {
            int mid = (lo + hi) / 2;
            if (R[mid].first <= cap) { pos = mid; lo = mid + 1; }
            else hi = mid - 1;
        }
        if (pos >= 0) res = max(res, cx + pref[pos]);
    }
    return res;
}
```

- **Complexity.** Building each half is $2^{n/2}$; sorting adds a $\log(2^{n/2}) = n/2$ factor; each of the $2^{n/2}$ left subsets does one binary search. Overall $O(2^{n/2} \cdot n)$ — pushing the tractable $n$ from ~30 to ~50 or more.

[watch from 52:33](https://youtu.be/5C7JT8cVHDU?t=3153)

---

## Cousin problem: bin packing over subsets (bitmask DP)

- A different flavor: **infinitely many** knapsacks each of size $S$; fit **all** items using the **fewest** knapsacks. This is bin packing, and it stays hard even for small weights because you would have to remember the load of *every* open bin — the state explodes.
- **Small $n$ rescue.** Use the **subset itself as the DP index**. Let $D[x]$ = the minimum number of knapsacks needed to pack exactly the item set $x$.
- **Transition.** Pick the set $y \subseteq x$ that goes into the **last** knapsack (so $\sum_{i \in y} w_i \le S$); the remaining items $x \setminus y$ are a smaller subproblem:

$$
D[x] \;=\; \min_{\substack{y \subseteq x \\ \sum_{i \in y} w_i \le S}} \big(1 + D[x \setminus y]\big), \qquad D[\varnothing] = 0
$$

![Bin packing: D[x] = min knapsacks to pack set x, recurrence 1 + D[x minus y] over submasks y of x with weight ≤ S](/img/dsa/5C7JT8cVHDU/frame-00312.png)

- **Iterating submasks efficiently.** To visit every subset $y$ of $x$, the idiom is `for (y = x; y > 0; y = (y - 1) & x)`. Subtracting $1$ borrows through the low bits; `& x` snaps the result back onto $x$'s bits, walking submasks from large to small.

![Submask enumeration: y' = (y - 1) & x steps to the next-smaller subset of x, generating all submasks](/img/dsa/5C7JT8cVHDU/frame-00355.png)

```cpp
#include <bits/stdc++.h>
using namespace std;

// Minimum number of size-S knapsacks to hold all items. O(3^n).
int min_knapsacks(const vector<int>& w, int S) {
    int n = w.size();
    vector<int> sum(1 << n, 0);                  // total weight of each subset
    for (int x = 1; x < (1 << n); x++) {
        int low = x & (-x), i = __builtin_ctz(x);
        sum[x] = sum[x ^ low] + w[i];
    }
    const int INF = 1e9;
    vector<int> D(1 << n, INF);
    D[0] = 0;
    for (int x = 1; x < (1 << n); x++)
        for (int y = x; y > 0; y = (y - 1) & x)  // all nonempty submasks of x
            if (sum[y] <= S)
                D[x] = min(D[x], 1 + D[x ^ y]);
    return D[(1 << n) - 1];
}
```

- **Why $O(3^n)$, not $O(4^n)$?** Count pairs $(x, y)$ with $y \subseteq x$. For each of the $n$ bits, it is in neither set, in both, or in $x$ only — **three** choices. So there are $3^n$ such pairs, and the submask loop touches each exactly once. That already beats iterating all $2^n$ subsets inside all $2^n$ states ($4^n$).

[watch from 76:27](https://youtu.be/5C7JT8cVHDU?t=4587)

---

## Bin packing, optimized: add one item at a time

- $3^n$ is expensive because each transition adds a **whole group** of items at once — too many predecessors per state. Fix it by adding **one item at a time**.
- **Richer state.** Store $D[x]$ = a **pair** $(a, b)$ where $a$ = number of knapsacks used and $b$ = current load in the **last, still-open** knapsack (the earlier knapsacks are full and shipped).
- **Transition.** From state $x$ with pair $(a, b)$, add an unused item $i$:
  - if $b + w_i \le S$ it fits in the open knapsack → $(a,\ b + w_i)$;
  - otherwise close the current knapsack and start a new one → $(a + 1,\ w_i)$.

$$
(a, b) \xrightarrow{\;\text{add } i\;}
\begin{cases}
(a,\ b + w_i) & \text{if } b + w_i \le S \\[2pt]
(a + 1,\ w_i) & \text{otherwise}
\end{cases}
$$

- **Comparing pairs.** We minimize $a$ first, then $b$ (lexicographically). This ordering is *valid* here: if state 1 has $(a_1, b_1)$ with $a_1 \le a_2$ and $b_1 \le b_2$ it is clearly better; and even when $a_1 < a_2$ but $b_1 > b_2$, state 1 still wins — you can always "close" state 1's open knapsack to reach $(a_1 + 1,\ 0)$, which is no worse than $(a_2, b_2)$ since $a_1 + 1 \le a_2$. So lexicographic min is safe.

![Comparing pairs (a1,b1) vs (a2,b2): minimize bins then last load; a smaller-bin state dominates by closing its open knapsack](/img/dsa/5C7JT8cVHDU/frame-00409.png)

```cpp
#include <bits/stdc++.h>
using namespace std;

// Bin packing via one-item-at-a-time DP. State = (bins used, load in open bin).
int min_knapsacks_fast(const vector<int>& w, int S) {
    int n = w.size();
    const pair<int,int> INF = {1e9, 0};
    vector<pair<int,int>> D(1 << n, INF);
    D[0] = {1, 0};                               // one open, empty knapsack
    for (int x = 0; x < (1 << n); x++) {
        if (D[x] == INF) continue;
        auto [a, b] = D[x];
        for (int i = 0; i < n; i++) {
            if ((x >> i) & 1) continue;          // item i already placed
            pair<int,int> nxt = (b + w[i] <= S)
                ? make_pair(a, b + w[i])         // fits in the open knapsack
                : make_pair(a + 1, w[i]);        // open a fresh knapsack
            D[x | (1 << i)] = min(D[x | (1 << i)], nxt);
        }
    }
    return D[(1 << n) - 1].first;
}
```

- **Complexity** $O(2^n \cdot n)$ — each of $2^n$ states tries $n$ single-item transitions. A big jump down from $O(3^n)$, and the general "add one element, carry a compact summary" pattern recurs across subset DPs.

[watch from 90:32](https://youtu.be/5C7JT8cVHDU?t=5432)

---

## Complexity recap

| Method | Time | Space | When to use |
| --- | --- | --- | --- |
| Subset-sum / 0-1 DP (2D) | $O(nS)$ | $O(nS)$ | small integer capacity $S$; need reconstruction |
| 0-1 DP (1D rolling) | $O(nS)$ | $O(S)$ | small $S$, value only |
| Unbounded knapsack | $O(nS)$ | $O(S)$ | unlimited copies per item |
| Brute-force bitmask | $O(2^n \cdot n)$ | $O(1)$ | few items ($n \lesssim 25$) |
| Meet in the middle | $O(2^{n/2} \cdot n)$ | $O(2^{n/2})$ | moderate $n$ ($\lesssim 50$), any weights |
| Bin packing (submask DP) | $O(3^n)$ | $O(2^n)$ | pack all items, small $n$ |
| Bin packing (one-at-a-time) | $O(2^n \cdot n)$ | $O(2^n)$ | same, faster |

- The DP's $O(nS)$ is **pseudo-polynomial**; there is no known truly polynomial algorithm because knapsack is **NP-complete**.

---

## Practice problems

Knapsack is one of the most heavily tested DP patterns in interviews — the recurrence "take it or skip it" reappears under many disguises.

**🎯 Interview (MAANG-style)**

- [Partition Equal Subset Sum — LeetCode 416](https://leetcode.com/problems/partition-equal-subset-sum/) — Medium — subset-sum feasibility for target $= \text{sum}/2$.
- [Target Sum — LeetCode 494](https://leetcode.com/problems/target-sum/) — Medium — assign $+/-$ signs; reduces to counting subsets with a fixed sum.
- [Coin Change — LeetCode 322](https://leetcode.com/problems/coin-change/) — Medium — unbounded knapsack minimizing coin count.
- [Coin Change II — LeetCode 518](https://leetcode.com/problems/coin-change-ii/) — Medium — unbounded knapsack counting combinations.
- [Ones and Zeroes — LeetCode 474](https://leetcode.com/problems/ones-and-zeroes/) — Medium — 0/1 knapsack with two capacity dimensions.
- [Last Stone Weight II — LeetCode 1049](https://leetcode.com/problems/last-stone-weight-ii/) — Medium — partition into two nearest-equal subsets (subset-sum).
- [0/1 Knapsack — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/0-1-knapsack-problem-dp-10/) — Medium — the canonical weight/value table.

**🏆 Competitive**

- [Book Shop — CSES 1158](https://cses.fi/problemset/task/1158) — Easy/Med — textbook 0/1 knapsack with the 1D rolling array.
- [Money Sums — CSES 1745](https://cses.fi/problemset/task/1745) — Easy/Med — subset-sum reachability: list all totals a coin set can form.

---

## Further reading

- [Knapsack problem — Wikipedia](https://en.wikipedia.org/wiki/Knapsack_problem) — variants, NP-completeness, FPTAS.
- [Subset sum problem — Wikipedia](https://en.wikipedia.org/wiki/Subset_sum_problem) — the cost-free special case.
- [Knapsack DP — cp-algorithms](https://cp-algorithms.com/dynamic_programming/knapsack.html) — implementation notes.
- [Iterating over all submasks — cp-algorithms](https://cp-algorithms.com/algebra/all-submasks.html) — the $3^n$ submask loop, proven.
- [Meet in the middle — Wikipedia](https://en.wikipedia.org/wiki/Meet-in-the-middle_attack) — the split-and-search technique in its original setting.
- [Unbounded knapsack — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/unbounded-knapsack-repetition-items-allowed/) — the upward-loop variant.

---

## Key takeaways

- The knapsack recurrence is always **"take the last item or skip it"** — a boolean OR for feasibility, a `max` for values.
- Make the **weight (or cost) a DP dimension** only when it is a small integer; that is what turns an NP-complete problem into an $O(nS)$ table.
- $O(nS)$ is **pseudo-polynomial**: fast when the number is small, exponential in its digit count — the reason knapsack stays NP-complete.
- Iterate the 1D array **downward for 0/1**, **upward for unbounded** — the direction *is* the semantics.
- When $n$ is small, attack the exponent: brute-force $2^n$, or **meet-in-the-middle** to $2^{n/2}$ by sorting one half and binary-searching.
- **Subset-as-index** DP plus **submask iteration** ($3^n$) solves bin-packing-style splits; carrying a compact $(\text{bins}, \text{load})$ summary and adding one item at a time cuts it to $2^n \cdot n$.

## Glossary

- **0/1 knapsack** — each item is taken at most once; capacity $S$, maximize value.
- **Unbounded knapsack** — unlimited copies of each item allowed.
- **Subset sum** — knapsack with cost $=$ weight; asks which totals are reachable.
- **Pseudo-polynomial** — polynomial in a numeric input's value but exponential in its bit-length.
- **NP-complete** — a class of problems with no known polynomial algorithm and no proof one is impossible.
- **Meet in the middle** — split the search space in two, precompute one half, combine via sort $+$ binary search.
- **Bitmask** — an integer whose bits encode set membership; enables $O(1)$ set operations.
- **Submask** — a subset $y$ of a set $x$; enumerated with `y = (y - 1) & x`.
- **Bin packing** — pack all items into the fewest fixed-capacity containers.
