---
title: "S01E10 · Dynamic Programming"
sidebar_position: 10
description: Optimal substructure and overlapping subproblems, memoization vs tabulation, and worked grasshopper problems — counting paths, minimum-cost paths with reconstruction, the 2D grid turtle, and a two-parameter momentum state.
---

# S01E10 · Dynamic Programming

> **Source:** Pavel Mavrin, [_A&DS S01E10_](https://youtu.be/_jK_sJrvrkY) · 1h31m lecture → ~14 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- **Dynamic programming is a technique, not an algorithm** — it appears inside many algorithms. Two ingredients make it work: **overlapping subproblems** (the same sub-answer is needed many times) and **optimal substructure** (an optimal whole is built from optimal parts).
- The naive recursive Fibonacci is $\Theta(\varphi^n)$ (exponential) because $F_7$ alone is recomputed many times. **Memoization** — store each answer the first time and reuse it — collapses this to $\Theta(n)$.
- The same recurrence solved by **memoization (top-down)** and by **tabulation (bottom-up)** gives the same table; the bottom-up loop just fills cells left-to-right and drops the recursion.
- **Counting problems** reuse the Fibonacci recurrence verbatim: the grasshopper's path count is $D[n] = D[n-1] + D[n-2]$, and so is the count of binary vectors with no two adjacent ones.
- **Optimization problems** swap the sum for a `min`/`max`: minimum-cost path is $D[n] = \min(D[n-1], D[n-2]) + c[n]$. To recover the path itself, store a **parent pointer** `p[n]` alongside the value.
- Two closing generalizations: the **2D grid** ("turtle") is $D[i][j] = \max(D[i-1][j], D[i][j-1]) + a[i][j]$, and a **momentum rule** ("each jump at least as long as the last") forces a second state dimension — the state becomes `(cell, last-jump-length)`.

---

## Fibonacci: the motivating example

- The Fibonacci numbers are defined by $F_1 = F_2 = 1$ and $F_n = F_{n-1} + F_{n-2}$. The obvious way to compute them is to translate that definition straight into a recursive function.
- This function is **correct** — it returns the right value — but its running time is disastrous.

```cpp
long long fib(int n) {
    if (n <= 2)
        return 1;
    return fib(n - 1) + fib(n - 2);
}
```

![The Fibonacci definition F1=F2=1, Fn=Fn-1+Fn-2 and the direct recursive fib(n) on the board](/img/dsa/_jK_sJrvrkY/frame-00016.png)

- **Why it is slow.** The cost obeys $T(n) = 1 + T(n-1) + T(n-2)$. This is *almost* the master-theorem shape from lecture 1, but the two recursive arguments differ ($n-1$ vs $n-2$), so it is not covered by the master theorem directly.
- The number of calls grows like the Fibonacci numbers themselves: $T(n) \ge F_n$, and $F_n \ge \varphi^{\,n}$ for a constant $\varphi > 1$ (the golden ratio). So the algorithm is **exponential**, $T(n) = \Theta(\varphi^n)$ — unacceptable.

[watch from 1:53](https://youtu.be/_jK_sJrvrkY?t=113)

---

## Overlapping subproblems and memoization

- Draw the recursion tree for `fib(10)`. Its children are `fib(9)` and `fib(8)`; those expand into `fib(8), fib(7)` and `fib(7), fib(6)`; and so on.
- **The waste is visible in the tree.** `fib(8)` is evaluated twice, `fib(7)` three times, `fib(6)` five times — each earlier value is recomputed more and more often. This is the **overlapping-subproblems** property: a small set of distinct subproblems, each solved over and over.

![Recursion tree for fib(10) beside the memoized version that checks res[n] before recomputing](/img/dsa/_jK_sJrvrkY/frame-00045.png)

- **The fix — cost memoization.** Keep an array `res` of already-computed answers. On entry, if `res[n]` is filled, return it in $O(1)$. Otherwise compute it once, store it, and return it. Each distinct `n` runs the real body exactly once.

```cpp
const long long EMPTY = -1;      // sentinel: this cell is not yet computed

long long fib_memo(int n, vector<long long>& res) {
    if (res[n] != EMPTY)         // already computed → O(1) hit
        return res[n];
    if (n <= 2)
        res[n] = 1;
    else
        res[n] = fib_memo(n - 1, res) + fib_memo(n - 2, res);
    return res[n];               // store, then return
}

long long fib_memo(int n) {
    vector<long long> res(n + 1, EMPTY);
    return fib_memo(n, res);
}
```

- **Data structure.** One array `res[0..n]` whose invariant is: `res[k]` is either `EMPTY` or the final value of $F_k$. It never changes once set. Cost: $O(n)$ extra memory — the lecturer notes you *can* remove this array for Fibonacci specifically, but that is a separate optimization, not today's topic.
- **New time complexity.** Every entry either is an $O(1)$ cache hit or runs the body once. The body runs once per distinct `n`, so across all calls it runs $n$ times total → $\Theta(n)$.

![The memoized recursion tree degenerates to a single left spine plus O(1) right stubs, giving O(n)](/img/dsa/_jK_sJrvrkY/frame-00058.png)

- **Why the tree flattens.** Going down the left branch you compute `fib(9), fib(8), fib(7), …` once each. Every right branch you reach is *already* in `res`, so it returns immediately. The tree becomes a straight left spine of $n$ nodes plus $n$ constant-time stubs — about $2n$ nodes total, hence linear.

[watch from 4:57](https://youtu.be/_jK_sJrvrkY?t=297)

---

## Tabulation: the bottom-up version

- The memoized recursion goes **deep first, then fills answers on the way back up**. If you always come back and add the two previous cells, you can skip the recursion entirely and fill the array directly with a plain loop.
- This is **tabulation (bottom-up DP)**: pick the order in which subproblems become computable (here, increasing `n`) and fill the table in that order.

```cpp
long long fib_table(int n) {
    vector<long long> res(n + 1, 0);
    res[1] = res[2] = 1;
    for (int i = 3; i <= n; i++)
        res[i] = res[i - 1] + res[i - 2];  // both predecessors already filled
    return res[n];
}
```

![Bottom-up fib: initialize res[1]=res[2]=1, then a single for-loop filling res[i]=res[i-1]+res[i-2]](/img/dsa/_jK_sJrvrkY/frame-00089.png)

- **Same table, no stack.** The array holds exactly the values the memoized version cached, but we never recurse — one loop, $n$ iterations, so clearly $\Theta(n)$ time. (Fibonacci can be computed even faster with matrix exponentiation, but that is outside this lecture.)
- **Top-down vs bottom-up — the tradeoff:**
  - *Memoization (top-down):* code mirrors the recurrence; only reachable subproblems are computed; risk of deep recursion / stack limits.
  - *Tabulation (bottom-up):* no recursion overhead; you must know a valid fill order up front; may compute cells you did not strictly need.

[watch from 13:20](https://youtu.be/_jK_sJrvrkY?t=800)

---

## Counting problem: the grasshopper's paths

- **Setup.** A strip of cells numbered $0 \dots n-1$. A grasshopper starts on cell $0$ and wants to reach the last cell. From cell $i$ it may jump to $i+1$ (small jump) or $i+2$ (big jump). **How many distinct paths reach the last cell?**
- **The DP idea.** Let $D[n]$ be the number of paths that end at cell $n$. Look at the **last jump** into cell $n$: it came either from cell $n-1$ or from cell $n-2$. Those two path-sets are disjoint and cover everything, so add them.

$$
D[n] = D[n-1] + D[n-2], \qquad D[0] = 1,\ D[1] = 1
$$

![D[n] = number of paths to cell n, split by whether the last jump came from n-1 or n-2, giving D[n]=D[n-1]+D[n-2]](/img/dsa/_jK_sJrvrkY/frame-00107.png)

- **It is Fibonacci in disguise** — same recurrence, different base cases. Filling the strip left to right gives $1, 1, 2, 3, 5, 8, 13, \dots$: there is one way to sit on cell $0$; cell $2$ is reachable two ways; cell $3$ three ways; and so on.

```cpp
long long count_paths(int n) {
    vector<long long> D(n + 1, 0);
    D[0] = 1;
    D[1] = 1;
    for (int i = 2; i <= n; i++)
        D[i] = D[i - 1] + D[i - 2];
    return D[n];
}
```

- **State definition.** `D[i]` = number of valid grasshopper paths from cell $0$ to cell $i$. Time $\Theta(n)$, space $\Theta(n)$.
- **Same recurrence, different dressing — binary vectors.** Count binary vectors of length $n$ with **no two adjacent ones**. Split on the last bit: if it is $0$, the first $n-1$ bits are any valid vector → $D[n-1]$; if it is $1$, the bit before it must be $0$, leaving $n-2$ free bits → $D[n-2]$. So $D[n] = D[n-1] + D[n-2]$ again, now with $D[0] = 1,\ D[1] = 2$. (This is not idle: the logarithm of that count is the number of bits you can safely transmit over a channel that forbids adjacent ones.)

[watch from 22:03](https://youtu.be/_jK_sJrvrkY?t=1323)

---

## Generalizing the jump: sum of the last k values

- **Stronger grasshopper.** Now it may jump any length from $1$ to $k$: from cell $i$ it can land on $i+1, i+2, \dots, i+k$. The last jump into cell $n$ came from one of $n-1, n-2, \dots, n-k$, so:

$$
D[n] = \sum_{j=1}^{k} D[n-j] \quad(\text{skip terms with } n-j < 0)
$$

![Generalized recurrence D[i] = D[i-1] + D[i-2] + … + D[i-k], with a note to guard the array bounds for i-j < 0](/img/dsa/_jK_sJrvrkY/frame-00148.png)

- **Avoid a wall of special cases.** Rather than hand-initialize $k$ leading cells (whose count you do not even know until $k$ is fixed), initialize only $D[0]$ and use an inner loop with a **bounds guard** `i - j >= 0`. That keeps the code uniform for any `k`.

```cpp
long long count_paths_k(int n, int k) {
    vector<long long> D(n + 1, 0);
    D[0] = 1;
    for (int i = 1; i <= n; i++)
        for (int j = 1; j <= k; j++)
            if (i - j >= 0)
                D[i] += D[i - j];
    return D[n];
}
```

- **Complexity.** Two nested loops → $\Theta(n \cdot k)$ time. It can be pushed to $\Theta(n)$: the inner sum is over a sliding window of $k$ previous cells, so maintain a **prefix-sum array** and read each window as one subtraction, `prefix[i] - prefix[i - k]`.

[watch from 36:17](https://youtu.be/_jK_sJrvrkY?t=2177)

---

## Optimization problem: minimum-cost path

- **New rules.** Each cell $i$ carries a cost $c[i]$; landing on it costs that much. The grasshopper jumps $+1$ or $+2$ as before. **Find the cheapest path** from cell $0$ to the last cell.
- **The DP idea — swap the sum for a min.** Let $D[n]$ be the minimum total cost to reach cell $n$. The last jump came from $n-1$ or $n-2$; to be optimal overall, the sub-path to that predecessor must itself be optimal (**optimal substructure**), because a sum is minimized by minimizing its parts.

$$
D[n] = \min\big(D[n-1],\ D[n-2]\big) + c[n], \qquad D[0] = 0,\ D[1] = c[1]
$$

![D[n] = min cost to reach cell n = min(D[n-1], D[n-2]) + c[n], with the board's cost strip and the running fill](/img/dsa/_jK_sJrvrkY/frame-00197.png)

- **Worked fill.** With costs `c = [0, 3, 5, 6, 7, 1, 5, 4, 0]` (cell $0$ is the free start, so `c[0] = 0`), filling $D$ left to right gives `D = [0, 3, 5, 9, 12, 10, 15, 14, 14]` — the optimum to reach the end is **14**. (The lecturer stresses: index the added cost as `c[i]`, not `c[n]`, inside the loop — an easy off-by-name slip. On the board Pavel hand-fills the row and catches a couple of his own arithmetic slips out loud; the array above is the corrected, self-consistent version that his recurrence and final answer of **14** actually produce.)

```cpp
const long long INF = LLONG_MAX;

long long min_cost(const vector<long long>& c) {
    int n = c.size();
    vector<long long> D(n, 0);
    D[0] = 0;
    if (n > 1)
        D[1] = c[1];
    for (int i = 2; i < n; i++)
        D[i] = min(D[i - 1], D[i - 2]) + c[i];
    return D[n - 1];
}
```

![Bottom-up min-cost code: D[0]=0, D[1]=c[1], loop D[i]=min(D[i-1],D[i-2])+c[i], with the filled array 0 3 5 9 12 10 15 14 14](/img/dsa/_jK_sJrvrkY/frame-00210.png)

- **Generalized to jumps of length 1..k.** Same trick as counting: initialize only $D[0]=0$, set every other cell to $+\infty$, and **relax** it against each legal predecessor. Minimum-of-`k`-values is done by starting from infinity and taking the running minimum.

```cpp
long long min_cost_k(const vector<long long>& c, int k) {
    int n = c.size();
    vector<long long> D(n, INF);
    D[0] = 0;
    for (int i = 1; i < n; i++)
        for (int j = 1; j <= k; j++)
            if (i - j >= 0 && D[i - j] != INF)   // guard the INF sentinel from overflow
                D[i] = min(D[i], D[i - j] + c[i]);
    return D[n - 1];
}
```

- **State + complexity.** `D[i]` = cheapest cost to reach cell $i$. Time $\Theta(n \cdot k)$, space $\Theta(n)$. The inner minimum is a sliding-window minimum, so this too reaches $\Theta(n)$ — but with a **min-queue** (two-stacks queue) rather than prefix sums, since a range minimum cannot be recovered by subtraction.

[watch from 41:05](https://youtu.be/_jK_sJrvrkY?t=2465)

---

## Recovering the path, not just its cost

- Knowing the optimum is **14** is not enough — you usually want the actual sequence of cells. Two ways to get it:
  - **Backtrack from the value array.** Start at the last cell; the predecessor is whichever of $D[n-1], D[n-2]$ produced $D[n]$. Walk back to cell $0$, then reverse.
  - **Store parent pointers while filling** (cleaner in contests). Alongside `D`, keep `p[i]` = the cell you jumped *from* to achieve the optimal `D[i]`. Update `p[i]` exactly when you improve `D[i]`.

![Value array D = 0 3 5 9 12 10 15 14 and the parent array p = [-1, 0, 0, 1, 2, 3, …] recording the predecessor of each optimal cell](/img/dsa/_jK_sJrvrkY/frame-00253.png)

```cpp
pair<long long, vector<int>> min_cost_with_path(const vector<long long>& c, int k) {
    int n = c.size();
    vector<long long> D(n, INF);
    vector<int> p(n, -1);
    D[0] = 0;
    for (int i = 1; i < n; i++)
        for (int j = 1; j <= k; j++)
            if (i - j >= 0 && D[i - j] != INF && D[i - j] + c[i] < D[i]) {
                D[i] = D[i - j] + c[i];
                p[i] = i - j;           // remember how we reached i
            }
    // reconstruct: walk parents from the last cell back to 0
    vector<int> path;
    int x = n - 1;
    while (x != -1) {
        path.push_back(x);
        x = p[x];
    }
    reverse(path.begin(), path.end());
    return {D[n - 1], path};
}
```

- **Ties are fine.** If two predecessors give the same cost, following either pointer yields *some* optimal path; the routine returns one of them.
- **Why `p` and not a graph.** The strip is not stored as a graph, but the parent pointers are exactly "predecessor on the optimal path" — reversing them reconstructs the route from cell $0$ to the end.

[watch from 57:50](https://youtu.be/_jK_sJrvrkY?t=3470)

---

## Two generalizations to close

### The 2D grid — the "turtle"

- **Setup.** An $n \times m$ table; a turtle starts top-left, moves only **right or down**, and eats the grass value $a[i][j]$ on each visited cell. Maximize the total collected on the way to the bottom-right.
- **State goes 2D.** $D[i][j]$ = maximum grass on any valid path ending at cell $(i,j)$. The last step into $(i,j)$ came from **above** $(i-1,j)$ or from the **left** $(i,j-1)$:

$$
D[i][j] = \max\big(D[i-1][j],\ D[i][j-1]\big) + a[i][j]
$$

![2D turtle: table of grass values with D(i,j) = max(D(i-1,j), D(i,j-1)) + a(i,j), plus x=n; while x!=start: path.add(x); x=p(x); reverse(path)](/img/dsa/_jK_sJrvrkY/frame-00289.png)

```cpp
long long max_grass(const vector<vector<long long>>& a) {
    int n = a.size();
    int m = a[0].size();
    vector<vector<long long>> D(n, vector<long long>(m, 0));
    for (int i = 0; i < n; i++)
        for (int j = 0; j < m; j++) {
            long long best = 0;
            if (i > 0)
                best = max(best, D[i - 1][j]);
            if (j > 0)
                best = max(best, D[i][j - 1]);
            D[i][j] = best + a[i][j];
        }
    return D[n - 1][m - 1];
}
```

- **Nothing new conceptually** — a state is "the cell we want to reach", we ask "how did we get here", and take the best predecessor. The only change is **two loops instead of one**. This is the same computation you would run over any **acyclic graph**: process vertices in topological order and combine incoming edges.

[watch from 1:06:12](https://youtu.be/_jK_sJrvrkY?t=3972)

### Momentum — a second state dimension

- **Rule.** No braking: each jump must be **at least as long as the previous one**. The naive state "which cell" is no longer enough, because what you may do next depends on **how you arrived**.
- **Enrich the state.** Make the state a pair: **(current cell, length of the last jump)**. Let $d(n, k)$ = number of ways to reach cell $n$ whose last jump had length **at most** $k$. Splitting on that last jump of length $j \le k$:

$$
d(n, k) = \sum_{j=1}^{k} d(n-j,\ j)
$$

reaching cell $n-j$ with a last jump of length **at most** $j$ (so the following jump of length $j$ is legal — it is not shorter).

![Two-parameter state d(n,k) = number of paths to cell n with last jump ≤ k, drawn as a small acyclic graph of (cell, jump) states](/img/dsa/_jK_sJrvrkY/frame-00338.png)

- **The design lesson.** A DP state is "the minimum set of variables that fully describe what you can do next." Add a dimension only when the transition truly depends on it — and keep the state **as small as possible**, because the number of states multiplies straight into the running time.
- The optimization variant ($\min$ cost under the same momentum rule) uses the identical two-parameter state; the naive sum/min is $\Theta(n \cdot k^2)$ and can be reduced to $\Theta(n \cdot k)$ with 2D prefix sums along the same idea as the 1D case.

[watch from 1:12:26](https://youtu.be/_jK_sJrvrkY?t=4346)

---

## Complexity recap

| Problem | Recurrence | Time (naive DP) | Time (optimized) | Space |
| --- | --- | --- | --- | --- |
| Fibonacci (naive recursion) | $T(n)=T(n{-}1)+T(n{-}2)$ | $\Theta(\varphi^n)$ | — | $O(n)$ stack |
| Fibonacci (memo / tabulation) | $F_n=F_{n-1}+F_{n-2}$ | $\Theta(n)$ | $\Theta(\log n)$ (matrix) | $\Theta(n)$ |
| Count paths, jumps 1–2 | $D_n=D_{n-1}+D_{n-2}$ | $\Theta(n)$ | — | $\Theta(n)$ |
| Count paths, jumps 1–k | $D_n=\sum_{j=1}^{k}D_{n-j}$ | $\Theta(nk)$ | $\Theta(n)$ (prefix sums) | $\Theta(n)$ |
| Min-cost path, jumps 1–k | $D_n=\min_j D_{n-j}+c_n$ | $\Theta(nk)$ | $\Theta(n)$ (min-queue) | $\Theta(n)$ |
| 2D grid max path | $D_{ij}=\max(D_{i-1,j},D_{i,j-1})+a_{ij}$ | $\Theta(nm)$ | — | $\Theta(nm)$ |
| Momentum (2 params) | $d_{n,k}=\sum_{j\le k} d_{n-j,\,j}$ | $\Theta(nk^2)$ | $\Theta(nk)$ (2D prefix) | $\Theta(nk)$ |

---

## Practice problems

This is the introductory DP lecture: the payload is recognizing a recurrence, choosing memoization vs tabulation, and reconstructing the optimal object from a parent array. Every problem below is a linear or grid DP in the same family as the grasshopper.

**🎯 Interview (MAANG-style)**

- [Climbing Stairs — LeetCode 70](https://leetcode.com/problems/climbing-stairs/) — Easy — literally the count-paths grasshopper, $D_n = D_{n-1} + D_{n-2}$.
- [House Robber — LeetCode 198](https://leetcode.com/problems/house-robber/) — Medium — the "no two adjacent" split, now maximizing a sum.
- [Coin Change — LeetCode 322](https://leetcode.com/problems/coin-change/) — Medium — min over `k` predecessors (fewest coins), the min-cost-path pattern.
- [Unique Paths — LeetCode 62](https://leetcode.com/problems/unique-paths/) — Medium — the 2D turtle, counting instead of maximizing.
- [Longest Increasing Subsequence — LeetCode 300](https://leetcode.com/problems/longest-increasing-subsequence/) — Medium — 1D DP over "best subsequence ending here"; a classic next step.
- [Longest Common Subsequence — LeetCode 1143](https://leetcode.com/problems/longest-common-subsequence/) — Medium — 2D grid DP on two strings.
- [Edit Distance — LeetCode 72](https://leetcode.com/problems/edit-distance/) — Hard — the canonical 2D optimization DP with three transitions.
- [Dynamic Programming — GeeksforGeeks](https://www.geeksforgeeks.org/dynamic-programming/) — mixed — a graded catalog covering memoization, tabulation, and reconstruction.

**🏆 Competitive**

- [Dice Combinations — CSES 1633](https://cses.fi/problemset/task/1633) — Easy — count-paths with jumps 1–6; the exact $\sum_{j=1}^{k} D_{n-j}$ recurrence.
- [Minimizing Coins — CSES 1634](https://cses.fi/problemset/task/1634) — Easy — min over predecessors, the min-cost pattern.
- [Coin Combinations I — CSES 1635](https://cses.fi/problemset/task/1635) — Easy — ordered count-paths over coin lengths.
- [Grid Paths — CSES 1638](https://cses.fi/problemset/task/1638) — Easy — the 2D turtle, right/down over an obstacle grid.
- [Official home tasks & discussion — Codeforces](https://codeforces.com/blog/entry/84861) — the problem set Pavel assigned for this lecture (linked from the video description).

---

## Further reading

- [Introduction to Dynamic Programming — cp-algorithms.com](https://cp-algorithms.com/dynamic_programming/intro-to-dp.html) — states, transitions, and top-down vs bottom-up worked out.
- [Overlapping Subproblems — GeeksforGeeks](https://www.geeksforgeeks.org/overlapping-subproblems-property-in-dynamic-programming-dp-1/) and [Optimal Substructure — GeeksforGeeks](https://www.geeksforgeeks.org/optimal-substructure-property-in-dynamic-programming-dp-2/) — the two defining properties, with examples.
- [Dynamic programming — Wikipedia](https://en.wikipedia.org/wiki/Dynamic_programming) and [Memoization — Wikipedia](https://en.wikipedia.org/wiki/Memoization).
- [Optimal substructure — Wikipedia](https://en.wikipedia.org/wiki/Optimal_substructure).

---

## Key takeaways

- DP applies when a problem has **overlapping subproblems** and **optimal substructure**; the win is computing each subproblem **once**.
- **Memoization** = recursion + a cache; **tabulation** = the same table filled by a loop in dependency order. Same answers, different control flow.
- Counting reuses a **sum** recurrence; optimization swaps in **min/max**. The skeleton — "look at the last step, branch on where it came from" — is identical.
- To recover the optimal object, keep a **parent pointer** updated whenever you improve a cell, then walk it back and reverse.
- The **state** is the smallest tuple that determines your future moves; growing it (2D grid, momentum) is the same technique with more loops, and its size sets the running time.

## Glossary

- **Overlapping subproblems** — the recursion revisits the same subproblem many times; caching removes the repetition.
- **Optimal substructure** — an optimal solution is composed of optimal solutions to subproblems, so local optima combine into a global one.
- **Memoization (top-down)** — recursive computation that stores each result on first use and returns the stored value thereafter.
- **Tabulation (bottom-up)** — iterative DP that fills a table in an order where every dependency is ready before it is needed.
- **State** — the minimal set of variables describing a subproblem; the total number of states drives the time complexity.
- **Relaxation** — tentatively improving a cell's optimum against a candidate value (`D[i] = min(D[i], candidate)`).
- **Parent pointer** — for each state, the predecessor that achieved its optimum; reversing the chain reconstructs the optimal path.
