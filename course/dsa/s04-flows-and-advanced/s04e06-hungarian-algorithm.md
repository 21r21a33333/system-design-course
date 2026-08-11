---
title: "S04E06 · Assignment Problem & Hungarian Algorithm"
sidebar_position: 6
description: Minimum-cost perfect matching in a weighted bipartite graph — row/column potentials, tight-edge subgraphs, Kuhn augmentation with dual updates, the e-maxx O(n cubed) implementation, and the LP-duality view.
---

# S04E06 · Assignment Problem & Hungarian Algorithm

> **Source:** Pavel Mavrin, [_A&DS S04E06_](https://youtu.be/Sal6kHewGcM) · 1h26m lecture → ~14 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- The **assignment problem**: given an $n \times n$ cost matrix $c$, pick one cell per row and per column (a permutation $\pi$) minimizing $\sum_i c_{i,\pi(i)}$ — equivalently, a **min-cost perfect matching** in a complete weighted bipartite graph.
- **Safe operation:** adding a constant $\delta$ to every edge at one node (one row or one column of the matrix) changes *every* perfect matching's cost by exactly $\delta$, so it **never changes which matching is optimal**. These are the **potentials** $u_i$ (rows) and $v_j$ (columns).
- Subtract each row's minimum, then each column's: all entries become $\ge 0$ and every row/column gets a **zero**. A perfect matching using only **zero cells** has total cost $0$ — hence optimal.
- If no perfect matching exists among the zeros, run **Kuhn's DFS** for an augmenting path; when it gets stuck, take $\Delta = \min$ reduced cost from the visited left side $L^{+}$ to the unvisited right side $R^{-}$, and apply the dual update — this **only adds** reachable nodes, never removes any, so the search always makes progress.
- Naively $O(n^4)$; maintaining **column minima** `minv[]` plus the `way[]` back-pointers gives the classic **e-maxx $O(n^3)$**. The whole thing is a **primal-dual** algorithm: grow the matching (primal) while tightening the potentials (dual) until they meet at the LP optimum.

---

## What the assignment problem is

- You have $n$ **workers** and $n$ **jobs**; $c_{ij}$ is the cost of giving job $j$ to worker $i$. Assign exactly one job per worker and one worker per job, minimizing total cost.
- As a graph: a **complete weighted bipartite graph**, left = workers, right = jobs, edge weight $c_{ij}$. We want a **minimum-weight perfect matching** — not the fewest edges (that was plain bipartite matching in [S04E01](./s04e01-bipartite-matching)), but the cheapest full assignment.
- As a matrix: choose cells so that **each row and each column has exactly one chosen cell**. That is exactly a permutation $\pi$, and the objective is

$$
\min_{\pi \in S_n} \sum_{i=1}^{n} c_{i,\pi(i)}.
$$

- **Missing edges** (a worker who cannot do a job) are modeled by $c_{ij} = +\infty$, so the full-matrix view loses no generality.
- **Maximize instead of minimize?** Negate all costs and minimize. The algorithm never relies on the entries being non-negative except as a bookkeeping convenience, so both directions are the same problem.
- **Brute force** tries all $n!$ permutations — correct but hopeless past $n \approx 11$.

![Bipartite worker-job graph with edge costs and its cost-matrix form, objective min sum c(i, pi(i)) over all permutations](/img/dsa/Sal6kHewGcM/frame-00046.png)

[watch from 0:20](https://youtu.be/Sal6kHewGcM?t=20)

---

## The one safe operation: potentials

- **Claim.** Take any single node and add the same $\delta$ to *all* edges touching it. Every perfect matching contains **exactly one** edge at that node, so every matching's cost rises by exactly $\delta$. The set of costs shifts uniformly, so the **minimum stays the minimum** — the optimal matching is unchanged.
- In the matrix this means: **add $\delta$ to a whole row** (a left node) or **add $\delta$ to a whole column** (a right node). Both are reversible and both preserve the optimal assignment.
- Bookkeep these shifts as two potential arrays: $u_i$ for rows, $v_j$ for columns. The **reduced cost** of a cell is

$$
c'_{ij} \;=\; c_{ij} - u_i - v_j .
$$

- We will keep the invariant $c'_{ij} \ge 0$ for all cells. A cell with $c'_{ij} = 0$ is called **tight**; only tight cells are eligible for the matching.

![Row and column shifts on the bipartite graph, c'(i,j) = c(i,j) minus delta, translated to adding delta to a matrix row or column](/img/dsa/Sal6kHewGcM/frame-00090.png)

[watch from 11:19](https://youtu.be/Sal6kHewGcM?t=679)

---

## Reduce the matrix, then match the zeros

- **Row reduction:** for each row subtract its minimum. **Column reduction:** for each column subtract its minimum. Now every entry is $\ge 0$ and every row and every column contains at least one **zero**.
- The lecture's matrix (row minima $5,1,4,1$ shown on the board):

$$
c=\begin{pmatrix} 8&6&9&5\\ 1&1&1&3\\ 6&4&7&4\\ 8&1&7&3 \end{pmatrix}
\;\xrightarrow{\text{row-reduce}}\;
\begin{pmatrix} 3&1&4&0\\ 0&0&0&2\\ 2&0&3&0\\ 7&0&6&2 \end{pmatrix}
$$

- **Why this solves it if you're lucky:** build the subgraph of **only the zero (tight) cells**. If that subgraph has a **perfect matching**, its total cost is $0$; since all reduced costs are $\ge 0$, no assignment can beat $0$, so it is optimal — and because potentials never change the optimum, it is optimal for the original matrix too.
- Reduction is not strictly required for correctness (the dual updates below would create the zeros anyway), but it is a fast way to seed lots of tight edges.

![Initial matrix 8 6 9 5 / 1 1 1 3 / 6 4 7 4 / 8 1 7 3 with row minima, the reduced matrix with its zeros circled, and the duality note c'(i,j) greater-or-equal 0](/img/dsa/Sal6kHewGcM/frame-00078.png)

[watch from 14:52](https://youtu.be/Sal6kHewGcM?t=892)

---

## When the zeros don't suffice: augment, then update potentials

- Run **Kuhn's augmenting-path DFS** (from [S04E01](./s04e01-bipartite-matching)) over the tight subgraph. Take an unmatched left node $s$ and grow an **alternating tree**: non-matching edges go left→right, matching edges go right→left.
- Label the DFS forest: $L^{+}, R^{+}$ = left / right nodes **reached** by the DFS; $L^{-}, R^{-}$ = **not reached**. A key structural fact (same as plain matching): there is **never a tight edge from $R^{+}$ to $L^{-}$**, because any matching edge leaving a reached right node lands on an already-reached left node.

![DFS alternating tree with L-plus, R-plus reached and L-minus, R-minus unreached; goal is to grow the reached set](/img/dsa/Sal6kHewGcM/frame-00109.png)

- **Stuck** means: no augmenting path, and no tight edge from $L^{+}$ to $R^{-}$ to extend the tree. To create one, pick the cheapest reduced cost crossing that boundary:

$$
\Delta \;=\; \min_{\,u \in L^{+},\; v \in R^{-}} c'_{uv},
\qquad c'_{uv} \ge 0 .
$$

- **Dual update:** subtract $\Delta$ from every row in $L^{+}$ and add $\Delta$ to every column in $R^{+}$ (equivalently $u_u \mathrel{+}= \Delta$ for $u\in L^{+}$, $v_v \mathrel{-}= \Delta$ for $v\in R^{+}$). Effect on the four regions of the matrix:

| region | rows | cols | change to $c'$ |
| --- | --- | --- | --- |
| $L^{+}\times R^{+}$ | $-\Delta$ | $+\Delta$ | unchanged |
| $L^{+}\times R^{-}$ | $-\Delta$ | — | $-\Delta$ (**creates a new zero**) |
| $L^{-}\times R^{+}$ | — | $+\Delta$ | $+\Delta$ (destroys some zeros) |
| $L^{-}\times R^{-}$ | — | — | unchanged |

- **Why progress is guaranteed.** The update creates $\ge 1$ new tight edge from $L^{+}$ to $R^{-}$, so the DFS reaches at least one new node. The zeros it destroys all lie in $L^{-}\times R^{+}$ — edges the DFS **never used** (they leave un-reached left nodes), so no previously reached node becomes unreachable. The reached set only **grows**, so after $\le n$ dual updates you find an augmenting path.

![Four-region matrix showing the dual update: L-plus x R-minus decreases by delta creating a zero, L-minus x R-plus increases, other two regions unchanged](/img/dsa/Sal6kHewGcM/frame-00181.png)

- Applying it to the example with $\Delta = 2$ opens a new tight edge, the DFS reaches the last free job, and inverting the augmenting path completes the perfect matching:

![Reduced matrix after a delta=2 dual update with the new zero circled and the completed perfect matching over tight cells](/img/dsa/Sal6kHewGcM/frame-00162.png)

[watch from 22:35](https://youtu.be/Sal6kHewGcM?t=1355)

---

## The naive $O(n^4)$ version, literally from the board

- Structure: `for` each left node $s$, repeatedly `dfs`; on failure compute $\Delta$ and update potentials; repeat until an augmenting path appears.
- This is the exact loop Pavel writes (`for s in L`, `while !dfs(s)`, $\Delta = \min c'_{uv}$, update, apply path). Reduced costs stay $\ge 0$ throughout; tight cells are those with $c'_{ij}=0$.

```cpp
#include <bits/stdc++.h>
using namespace std;

// Direct "board" Hungarian: row potentials a[], column potentials b[].
// reduced(i,j) = c[i][j] - a[i] - b[j] >= 0 always; tight edges have reduced == 0.
// O(n^4) but a one-to-one transcription of the lecture. matchRow[i] = column of row i.
// PRECONDITION: costs must be non-negative (c[i][j] >= 0). The board version starts
// from potentials a=b=0, which is only dual-feasible when the matrix is already >= 0
// (the lecture achieves this by row/column-reducing first). For matrices with negative
// entries, either add a constant to make every entry >= 0, or use the e-maxx O(n^3)
// version below, which seeds potentials correctly and handles negatives directly.
long long hungarianNaive(const vector<vector<long long>>& c, int n, vector<int>& matchRow) {
    const long long INF = LLONG_MAX / 4;
    vector<long long> a(n, 0), b(n, 0);          // potentials u (rows), v (cols)
    vector<int> matchCol(n, -1);                 // column -> row, -1 if free
    matchRow.assign(n, -1);                      // row -> column
    for (int s = 0; s < n; s++) {                // add row s to the matching
        while (true) {
            vector<char> Lp(n, false), Rp(n, false);  // L+ and R+ (reached sets)
            function<bool(int)> dfs = [&](int i) -> bool {
                Lp[i] = true;
                for (int j = 0; j < n; j++) {
                    if (Rp[j]) continue;
                    if (c[i][j] - a[i] - b[j] != 0) continue;   // only tight edges
                    Rp[j] = true;
                    if (matchCol[j] == -1 || dfs(matchCol[j])) {
                        matchCol[j] = i; matchRow[i] = j;       // invert path edge
                        return true;
                    }
                }
                return false;
            };
            if (dfs(s)) break;                   // augmenting path found -> next s
            long long delta = INF;               // dual step: min over L+ x R-
            for (int i = 0; i < n; i++) if (Lp[i])
                for (int j = 0; j < n; j++) if (!Rp[j])
                    delta = min(delta, c[i][j] - a[i] - b[j]);
            for (int i = 0; i < n; i++) if (Lp[i]) a[i] += delta;  // rows in L+
            for (int j = 0; j < n; j++) if (Rp[j]) b[j] -= delta;  // cols in R+
        }
    }
    long long cost = 0;
    for (int i = 0; i < n; i++) cost += c[i][matchRow[i]];
    return cost;
}
```

- **Complexity.** Outer loop $n$; each augmentation costs up to $n$ dual updates; each dual update scans the $n\times n$ matrix for $\Delta$. That is $n \cdot n \cdot n^2 = O(n^4)$.

[watch from 49:29](https://youtu.be/Sal6kHewGcM?t=2969)

---

## Speeding up: potentials as arrays, and column minima

- The bottleneck is finding $\Delta$ and applying the shifts. Two cheap data-structure ideas kill it.
- **Shifts are just two arrays.** Instead of touching the matrix, keep `a[i]` (row shift) and `b[j]` (column shift); the current value is a $O(1)$ query. No 2-D segment tree needed — plain arrays are enough:

```text
add_row(i, delta)     : a[i] += delta          # shift a whole row
add_column(j, delta)  : b[j] += delta           # shift a whole column
get(i, j)             : return c[i][j] + a[i] + b[j]
```

![Data-structure design: add_row, add_column and get on cost matrix c with row array a and column array b, all in constant time](/img/dsa/Sal6kHewGcM/frame-00234.png)

- **Column minima for $\Delta$ in linear time.** The set $L^{+}\times R^{-}$ is a union of columns. Maintain, per column $j$, the minimum reduced cost over the reached rows:

$$
m_j \;=\; \min_{\,i \in L^{+}} c'_{ij},
\qquad
\Delta \;=\; \min_{\,j \in R^{-}} m_j .
$$

- Each time a row joins $L^{+}$, refresh every $m_j$ with that row's reduced costs ($O(n)$ per row, $O(n^2)$ per augmentation). Then $\Delta$ and the augment are $O(n)$. Total $O(n^3)$.

![Column-minima array m over the reached rows; delta = min m[j] over R-minus, and the m[j] refresh when a row joins L-plus](/img/dsa/Sal6kHewGcM/frame-00259.png)

[watch from 51:44](https://youtu.be/Sal6kHewGcM?t=3104)

---

## The e-maxx $O(n^3)$ implementation

- The clean version folds "one DFS step at a time" into the `minv`/`way` arrays: `minv[j]` is the current best reduced cost to reach column $j$, and `way[j]` records which column the alternating path came through, so augmentation is a single back-walk. Columns are 1-indexed with a **sentinel column $0$** holding the current free row.

```cpp
#include <bits/stdc++.h>
using namespace std;

// e-maxx style O(n^3) Hungarian for a square cost matrix a[1..n][1..n].
// Returns minimum assignment cost; ansRowForCol[j] = row matched to column j.
long long hungarian(const vector<vector<long long>>& a, int n, vector<int>& ansRowForCol) {
    const long long INF = LLONG_MAX / 4;
    vector<long long> u(n + 1, 0), v(n + 1, 0);   // row / column potentials
    vector<int> p(n + 1, 0), way(n + 1, 0);       // p[j] = row assigned to column j
    for (int i = 1; i <= n; i++) {
        p[0] = i;                                 // add row i; column 0 is the sentinel
        int j0 = 0;
        vector<long long> minv(n + 1, INF);       // best reduced cost to reach column j
        vector<char> used(n + 1, false);          // columns already on the tree (R+)
        do {
            used[j0] = true;
            int i0 = p[j0], j1 = -1;
            long long delta = INF;
            for (int j = 1; j <= n; j++) if (!used[j]) {
                long long cur = a[i0][j] - u[i0] - v[j];   // reduced cost
                if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
                if (minv[j] < delta) { delta = minv[j]; j1 = j; }
            }
            for (int j = 0; j <= n; j++) {         // apply the dual update in O(n)
                if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
                else         { minv[j] -= delta; }
            }
            j0 = j1;
        } while (p[j0] != 0);                      // stop when we hit a free column
        do { int j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);   // augment
    }
    ansRowForCol.assign(n + 1, 0);
    long long cost = 0;
    for (int j = 1; j <= n; j++) { ansRowForCol[j] = p[j]; cost += a[p[j]][j]; }
    return cost;                                   // = -v[0] as well, by LP duality
}
```

- **Data structures.**
  - `u[i]`, `v[j]` — potentials; the invariant $a_{ij} - u_i - v_j \ge 0$ holds throughout.
  - `p[j]` — current matching (row assigned to column $j$); `p[0]` holds the free row being added.
  - `minv[j]` — running minimum reduced cost to reach column $j$ from the tree; `way[j]` — predecessor column, so the augmenting path is recovered by following `way` back to $0$.
  - `used[j]` — the reached set $R^{+}$.
- **Correctness check (compile-tested).** Against brute force over all $n!$ permutations on 4000 random matrices with $n \le 6$ (entries in $[-20, 20]$, so negatives included), the returned cost and the recovered permutation matched every time. On the lecture's own matrix the optimum is $\mathbf{13}$.

```text
lecture matrix: hungarian=13 brute=13  OK
stress: 4000 random cases, fails=0
```

[watch from 67:35](https://youtu.be/Sal6kHewGcM?t=4055)

---

## The primal-dual / LP-duality view

- The assignment problem is a **linear program** (its constraint matrix is totally unimodular, so the LP optimum is integral — a genuine permutation).

$$
\min \sum_{i,j} c_{ij}\,x_{ij}
\quad\text{s.t.}\quad
\sum_j x_{ij}=1,\;\; \sum_i x_{ij}=1,\;\; x_{ij}\ge 0 .
$$

- Its **dual** assigns a potential $u_i$ to each row and $v_j$ to each column:

$$
\max \sum_i u_i + \sum_j v_j
\quad\text{s.t.}\quad
u_i + v_j \le c_{ij}\;\;\forall i,j .
$$

- The reduced-cost invariant $c_{ij}-u_i-v_j \ge 0$ is exactly **dual feasibility**. A tight edge ($u_i+v_j = c_{ij}$) is where **complementary slackness** permits $x_{ij}=1$. The Hungarian algorithm is a textbook **primal-dual method**:
  - **Primal step** — an augmenting path enlarges the matching (progress on $x$).
  - **Dual step** — when stuck, raise $\sum u_i + \sum v_j$ by $\Delta$, tightening the potentials toward the primal.
- When a perfect matching using only tight edges exists, primal and dual objectives are **equal**, certifying optimality: $\text{cost} = \sum_i u_i + \sum_j v_j$ (and in the e-maxx code this equals $-v_0$).

![Primal-dual picture: build the matching from one side while adapting the potential constraints from the other until they meet](/img/dsa/Sal6kHewGcM/frame-00201.png)

[watch from 75:37](https://youtu.be/Sal6kHewGcM?t=4537)

---

## Sparse graphs: heaps with a lazy global shift

- For a **sparse** graph ($m \ll n^2$ edges) replace the per-column-minimum scan with a **heap** of candidate edges. The dual update must add $\Delta$ to every key in the heap at once.
- **Trick:** keep a single `shift` value. To add $\Delta$ to all keys, do `shift += delta`; the true key is `stored + shift`. On extract-min, return `min_stored + shift`; on insert of a value $x$, push `x - shift` so it carries the same offset.
- This yields **$O(nm\log n)$** with a binary heap, or **$O(n(m + n\log n))$** with a Fibonacci heap — the Dijkstra-flavored bound for sparse min-cost assignment.

[watch from 78:06](https://youtu.be/Sal6kHewGcM?t=4686)

---

## Complexity recap

| Approach | Time | Space | Note |
| --- | --- | --- | --- |
| Brute force (all permutations) | $O(n!\cdot n)$ | $O(n)$ | baseline only |
| Board Hungarian (naive $\Delta$ scan) | $O(n^4)$ | $O(n^2)$ | literal transcription |
| e-maxx Hungarian (`minv` + `way`) | $O(n^3)$ | $O(n^2)$ | the standard CP version |
| Sparse (binary heap + lazy shift) | $O(nm\log n)$ | $O(n+m)$ | good when $m \ll n^2$ |
| Sparse (Fibonacci heap) | $O\!\big(n(m+n\log n)\big)$ | $O(n+m)$ | best asymptotic |

---

## Practice problems

The assignment problem is squarely a **competitive-programming** topic, but its small-$n$ cousin — optimal one-to-one assignment via **bitmask DP** — shows up in interviews. For $n \le 20$, $O(2^n \cdot n)$ bitmask DP is the interview-expected solution; the Hungarian $O(n^3)$ is the scalable one.

**🎯 Interview (MAANG-style)**

- [Minimum XOR Sum of Two Arrays — LeetCode 1879](https://leetcode.com/problems/minimum-xor-sum-of-two-arrays/) — Hard — min-cost assignment with cost $a_i \oplus b_j$; canonical bitmask-DP assignment.
- [Maximum Compatibility Score Sum — LeetCode 1947](https://leetcode.com/problems/maximum-compatibility-score-sum/) — Medium — assign students to mentors maximizing total score; bitmask DP or Hungarian.
- [Minimum Cost to Connect Two Groups of Points — LeetCode 1595](https://leetcode.com/problems/minimum-cost-to-connect-two-groups-of-points/) — Hard — assignment-flavored bipartite covering (not a pure permutation) via bitmask DP.
- [Hungarian Algorithm — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/hungarian-algorithm-assignment-problem-set-1-introduction/) — Medium — the manual row/column-reduction walkthrough.

**🏆 Competitive**

- [Parcel Delivery — CSES 2121](https://cses.fi/problemset/task/2121) — Hard — min-cost max-flow, the general framework the assignment problem specializes from.
- [Hungarian algorithm — cp-algorithms](https://cp-algorithms.com/graph/hungarian-algorithm.html) — reference implementation and a curated Codeforces problem list for the assignment problem.

> No official Codeforces home-task post was linked in this lecture's description, so none is cited here.

---

## Further reading

- [Hungarian algorithm — cp-algorithms](https://cp-algorithms.com/graph/hungarian-algorithm.html) — the $O(n^3)$ derivation and code this note follows.
- [Hungarian algorithm — Wikipedia](https://en.wikipedia.org/wiki/Hungarian_algorithm) — history (Kőnig, Egerváry) and the matrix-reduction formulation.
- [Assignment problem — Wikipedia](https://en.wikipedia.org/wiki/Assignment_problem) — the LP formulation and total unimodularity.
- [Hungarian Algorithm for Assignment — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/hungarian-algorithm-assignment-problem-set-1-introduction/) — step-by-step manual example.
- [Duality (optimization) — Wikipedia](https://en.wikipedia.org/wiki/Duality_(optimization)) — the primal-dual and complementary-slackness background.

---

## Key takeaways

- Shifting all edges at one node (a row or a column) is the **only** move you need — it preserves the optimal matching while changing which cells are tight.
- Keep the reduced-cost invariant $c_{ij}-u_i-v_j\ge 0$; **tight** cells ($=0$) are the matchable ones, and a perfect matching on tight cells is optimal.
- Alternate **primal** augmentation (Kuhn's DFS) with **dual** updates ($\Delta = \min$ over $L^{+}\times R^{-}$); the reached set only grows, so it terminates.
- The dual update never invalidates progress because every zero it destroys sits in $L^{-}\times R^{+}$, edges the search never touched.
- Column minima + `way` back-pointers turn the naive $O(n^4)$ into the standard **$O(n^3)$**; heaps with a lazy shift handle sparse graphs.

## Glossary

- **Assignment problem** — choose a permutation $\pi$ minimizing $\sum_i c_{i,\pi(i)}$; min-cost perfect matching in a weighted bipartite graph.
- **Potential** — a per-row ($u_i$) or per-column ($v_j$) value added to all incident edges; a dual variable of the LP.
- **Reduced cost** — $c_{ij}-u_i-v_j$; kept $\ge 0$ (dual feasibility).
- **Tight edge** — a cell with reduced cost $0$; only tight edges are eligible for the matching (complementary slackness).
- **Augmenting path** — an alternating path between two free nodes; inverting its edges grows the matching by one.
- **Primal-dual method** — solve an LP by improving a primal (matching) and dual (potentials) together until their objectives coincide.
