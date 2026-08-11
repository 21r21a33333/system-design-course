---
title: "S01E13 · DP on Subsets & Profiles"
sidebar_position: 13
description: Bitmask DP over subsets for the Hamiltonian-path / TSP dp[mask][v], then profile DP and broken-profile DP for domino tiling, with the O(2^n · n) and profile complexities derived.
---

# S01E13 · DP on Subsets & Profiles

> **Source:** Pavel Mavrin, [_A&DS S01E13_](https://youtu.be/0bnMHlFUM_o) · 1h32m lecture → ~16 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- **DP on subsets (bitmask DP):** when the only thing you must remember about a partial solution is *which elements are used* (not their order), encode that set as an integer and index a DP array by it. For $n \le 20$ there are $\le 2^{20} \approx 10^6$ subsets — a perfectly fine array size.
- **Hamiltonian path / TSP:** state $dp[\text{mask}][v]$ = cheapest path that has visited exactly the vertex set `mask` and currently sits at $v$. Answer = $\min_v dp[\,2^n-1\,][v]$. Runs in $O(2^n \cdot n^2)$ time, $O(2^n \cdot n)$ space — far below the $n!$ of brute-forcing all orders.
- **DP on profiles:** to count domino tilings of an $n \times m$ board, sweep **column by column**; the state is the set of rows where a horizontal tile *sticks out* into the next column. Transition = enumerate the next profile $q$ and check the gap between $p$ and $q$ is fillable — a $O(1)$ bit-magic `comp(p, q)`.
- **Broken-profile DP:** instead of filling a whole column per step, fill **one cell at a time**. State $(i, j, p)$ has only **three** tiny transitions (skip / horizontal / vertical) — simpler code and a better constant than the full-profile version.
- Both techniques are exponential in the *small* dimension ($2^n$ masks) but polynomial in the large one — the classic "$n$ is small, so $2^n$ is affordable" regime. Bitmask DP is a genuine hard-interview topic; broken-profile tiling is competitive-leaning.

---

## DP on subsets: when a set is your state

- Last lecture introduced the idea; here we exploit it fully. A DP indexed by a **subset** looks like $d[x]$ where $x$ is not a number but a *set* of elements, stored as the bits of an integer.
- **Feasibility rule of thumb:** if $n$ is small (say $n \approx 20$), there are $2^n \approx$ one million subsets. An array of a million entries is cheap, so the whole approach is viable.
- **When does it apply?** When the only fact you need about a constructed prefix is *the subset of elements it uses* — never their internal order or arrangement. If that holds, promote the subset to a DP parameter and you get a $2^n$-sized table.

[watch from 0:24](https://youtu.be/0bnMHlFUM_o?t=24)

---

## The problem: minimum-weight Hamiltonian path (TSP)

- **Setup.** A weighted graph of cities; edges are roads with a known length. Start at a fixed city $s$ and visit **every** city exactly once, minimizing total distance travelled. In graph theory this route is a **Hamiltonian path**.
- This is the **travelling-salesman problem (TSP)**, and it is **NP-complete** — no known polynomial algorithm.
- **Variations are interchangeable.** "Must return to $s$" vs "may end anywhere", "minimize cost" vs "count paths" vs "does a path exist" — all are NP-complete and reducible to one another. Example reduction: to turn "end anywhere" into "end at $s$", add one dummy vertex joined to every real vertex by cost-$0$ edges and force start/end there.
- **Why bother with an exponential algorithm?** Because $2^n \ll n!$. For $n = 20$, $2^{20} \approx 10^6$, whereas $20!$ is astronomically larger. Brute-forcing all $n!$ vertex orders is hopeless; a $2^n$ DP is fast. Non-polynomial algorithms still come in wildly different grades.

![Graph of cities with road weights; the salesman must visit every vertex once, and n! paths vastly exceed 2^n](/img/dsa/0bnMHlFUM_o/frame-00017.png)

[watch from 1:34](https://youtu.be/0bnMHlFUM_o?t=94)

---

## Designing the state: $dp[\text{mask}][v]$

- Imagine you are **midway** through building the path: you have already walked some prefix and you now stand at a vertex $v$. What must you remember about that prefix to extend it correctly?
- **Only the subset of visited vertices.** The order you visited them in is irrelevant to the future — you will never revisit any of them. So the whole state collapses to two numbers:
  - $x$ — the subset (bitmask) of vertices already visited;
  - $v$ — the vertex you are currently standing on (necessarily inside $x$).
- **Definition.** $d[x][v]$ = the minimum total distance of a path that visits **exactly** the set $x$ and **ends** at vertex $v$.

![State dp[x][v] = min distance to visit subset x and finish in v, drawn on the graph G](/img/dsa/0bnMHlFUM_o/frame-00089.png)

[watch from 8:06](https://youtu.be/0bnMHlFUM_o?t=486)

---

## The transition and the full code

- **Push-style (forward) transition.** From state $(x, v)$, take any edge $v \to u$ where $u \notin x$. The new state is $y = x \cup \lbrace u \rbrace$ ending at $u$, and we relax:

$$
d[\,x \cup \lbrace u \rbrace\,][u] \;=\; \min\!\big(\,d[\,x \cup \lbrace u \rbrace\,][u],\; d[x][v] + \text{len}(v, u)\,\big)
$$

- **Membership test.** "$u \notin x$" is `x & (1 << u) == 0`: intersect the singleton $\lbrace u \rbrace$ with $x$ and check it is empty. Adding $u$ is `x + (1 << u)` (safe because $u \notin x$) or equivalently `x | (1 << u)`.
- **Base case.** Path starts at $s$ having visited only $s$: `d[1 << s][s] = 0`.
- **Answer.** After the table is filled, the full-visit states are those with `mask == (1 << n) - 1` (all ones). Take the best over every possible last vertex: $\text{res} = \min_v d[\,2^n-1\,][v]$.

![The bitmask-DP loop: base case only-s, iterate over mask and v, relax the visited-plus-u state, answer as the minimum over all last vertices of the full mask](/img/dsa/0bnMHlFUM_o/frame-00086.png)

```cpp
#include <bits/stdc++.h>
using namespace std;

const long long INF = LLONG_MAX / 4;

// Minimum-cost Hamiltonian path starting at s (may end at any vertex).
// dp[mask][v] = min cost of a path visiting exactly the set `mask`, now at v.
long long tsp_path(int n, int s, const vector<vector<long long>>& len) {
    vector<vector<long long>> dp(1 << n, vector<long long>(n, INF));
    dp[1 << s][s] = 0;                               // base: only s visited

    for (int mask = 0; mask < (1 << n); mask++) {
        for (int v = 0; v < n; v++) {
            if (dp[mask][v] == INF) continue;        // unreachable state
            if (!(mask & (1 << v))) continue;        // v must be inside mask
            for (int u = 0; u < n; u++) {            // every edge v -> u
                if (len[v][u] < 0) continue;         // -1 means "no edge"
                if (mask & (1 << u)) continue;       // u already in x
                int y = mask | (1 << u);             // x + {u}
                long long cand = dp[mask][v] + len[v][u];
                if (cand < dp[y][u]) dp[y][u] = cand;
            }
        }
    }

    long long res = INF;                             // path may end anywhere
    int full = (1 << n) - 1;
    for (int v = 0; v < n; v++) res = min(res, dp[full][v]);
    return res;
}
```

- **Complexity.** The outer loops are $2^n$ masks $\times\ n$ current vertices, and each state scans $n$ candidate next-vertices: $O(2^n \cdot n^2)$ with an adjacency matrix (or $O(2^n \cdot m)$ summing over out-edges). Space is $O(2^n \cdot n)$.

[watch from 10:17](https://youtu.be/0bnMHlFUM_o?t=617)

---

## Submask enumeration (a companion idiom)

- Many subset DPs need to iterate over **every subset of a given mask** (e.g. partition-style DP, set-cover, assignment). The idiom is:

```cpp
for (int s = mask; ; s = (s - 1) & mask) {
    // use submask s  (includes mask itself and 0)
    if (s == 0) break;
}
```

- **Why it works:** `(s - 1) & mask` clears the lowest set bit of `s` and re-fills all lower bits *that belong to* `mask`, walking submasks in strictly decreasing order down to $0$.
- **Cost of the whole sweep.** Summing $2^{\text{popcount}(mask)}$ over all masks gives $\sum_{k}\binom{n}{k}2^k = 3^n$, so "enumerate every submask of every mask" is $\Theta(3^n)$ — not $4^n$. (This same $3^n$ reappears below in profile DP, for the same combinatorial reason.)

[watch from 19:05](https://youtu.be/0bnMHlFUM_o?t=1145)

---

## DP on profiles: tiling a board with dominoes

- **Classic problem (the "parquet" problem from 1990s Russian olympiads):** count the number of ways to tile an $n \times m$ rectangle with $1 \times 2$ dominoes (each placed horizontally or vertically). *(Fun fact: a closed-form via Kasteleyn's algebra exists for the pure counting version — but the DP generalizes to weighted/constrained variants.)*
- **Sweep column by column**, left to right. Suppose columns $0 \ldots i-1$ are fully tiled. What must you remember about that filled left part to continue?
- **Only which rows have a horizontal tile sticking out** one square into column $i$. Encode that as an $n$-bit profile: bit $r = 1$ iff row $r$ has a protruding square.
- **State.** $d[i][p]$ = number of ways to fill the first $i$ columns leaving exactly the stick-out pattern $p$ on the frontier.

![Column sweep: the left part is tiled, some tiles protrude; profile p is the n-bit stick-out pattern on the boundary](/img/dsa/0bnMHlFUM_o/frame-00116.png)

[watch from 20:49](https://youtu.be/0bnMHlFUM_o?t=1249)

---

## Profile transition and the compatibility check

- **Transition.** To advance from column $i$ (profile $p$) to column $i+1$ (profile $q$), fill every currently-empty cell of column $i$ using dominoes; the tiles that stick into column $i+1$ define $q$. For each pair $(p, q)$ the fill (if it exists) is **unique**, so each compatible pair contributes exactly one way:

$$
d[i+1][q] \mathrel{+}= d[i][p] \quad\text{whenever } \texttt{comp}(p, q)
$$

- **Base / answer.** $d[0][0] = 1$ (empty board, nothing protrudes); the answer is $d[m][0]$ (all columns filled, nothing sticking out past the board).

![Profile DP driver: d[0][0]=1, triple loop over i, p, q with if comp(p,q) then d[i+1][q]+=d[i][p], answer d[m][0]; plus the comp() bit-magic](/img/dsa/0bnMHlFUM_o/frame-00227.png)

- **`comp(p, q)` — is the gap between two profiles fillable?** Reason cell by cell down the two boundary columns; four bit-combinations arise:
  - `p=1, q=1` → **impossible**: that row is already occupied by $p$'s protrusion, so you cannot also start a horizontal tile there. Detect *all* such rows at once: if `p & q != 0`, reject.
  - `p=1, q=0` → fine: the cell was filled by an earlier tile; do nothing.
  - `p=0, q=1` → fine: place a **horizontal** tile (the only way to make this bit $1$).
  - `p=0, q=0` → place a **vertical** tile, which needs **two consecutive** free rows. So every `0-0` row must pair up with its neighbour.

![Cell-by-cell case analysis for comp: p&q≠0 is the impossible overlap; the four 0/1 combinations map to skip / horizontal / vertical tiles](/img/dsa/0bnMHlFUM_o/frame-00199.png)

- **Checking the vertical pairing in $O(1)$.** Let $x$ mark the rows that are $0$ in both profiles: `x = (~p & ~q) & ((1<<n)-1)`. Those must split into adjacent pairs. Trick: the bit pattern `11` equals $3$, so `x / 3` collapses each such pair to a single bit `y`; then the pairs are non-overlapping iff `y` has **no two adjacent set bits**, i.e. `y & (y << 1) == 0`.

```cpp
int N;  // number of rows

// Can the gap between stick-out profiles p and q be filled by 1x2 tiles? O(1).
bool comp(int p, int q) {
    if (p & q) return false;                 // both protrude in one row -> impossible
    int x = (~p & ~q) & ((1 << N) - 1);      // rows that are 0 in both -> need vertical tiles
    if (x % 3 != 0) return false;            // "00" pairs must map cleanly onto base-3 units
    int y = x / 3;                           // collapse each 0-0 pair to one bit
    if (y & (y << 1)) return false;          // two adjacent bits -> overlapping vertical pairs
    return true;
}

// Column-by-column profile DP: # of domino tilings of an N x M board.
long long count_tilings(int rows, int cols) {
    N = rows;
    int P = 1 << N;
    vector<vector<long long>> d(cols + 1, vector<long long>(P, 0));
    d[0][0] = 1;                             // empty board, no stick-outs

    for (int i = 0; i < cols; i++)
        for (int p = 0; p < P; p++) {
            if (!d[i][p]) continue;
            for (int q = 0; q < P; q++)      // naive: try every q and test comp
                if (comp(p, q))
                    d[i + 1][q] += d[i][p];
        }

    return d[cols][0];                       // full board, nothing stuck out
}
```

[watch from 33:25](https://youtu.be/0bnMHlFUM_o?t=2005)

---

## Complexity of profile DP (and why it is slow)

- **Naive bound.** $m$ columns $\times\ 2^n$ profiles $p\ \times\ 2^n$ profiles $q$ gives $O(m \cdot 4^n)$ — the two independent $2^n$ loops multiply.
- **The real cost is the number of transitions, not states.** There are only $m \cdot 2^n$ states, but each state fans out to many compatible successors, inflating the constant.
- **Tighter bound.** If instead of testing all $q$ you *generate* only compatible profiles, the count of valid $(p, q)$ pairs is at most $3^n$ (each row is one of three allowed combinations — never `1-1`), and actually a bit less because the `0-0` pairing constraint forbids some patterns. So a careful implementation is roughly $O(m \cdot c^n)$ with $2 < c \le 3$ — better than $4^n$ but still exponential with a fat base.

[watch from 55:09](https://youtu.be/0bnMHlFUM_o?t=3323)

---

## Broken-profile DP: fill one cell at a time

- **Diagnosis.** The full-column transition is expensive because a single step fills an *entire* new column, and there are many ways to do that. **Fix:** make each transition tiny — add **one square** per step, sweeping top-to-bottom, left-to-right.
- **State $(i, j, p)$:** first $i$ columns done, first $j$ cells of the current column done, and $p$ = the stick-out profile along the *ragged* (broken) frontier. The boundary is no longer a straight vertical line — it is a staircase — hence **broken profile**.

![Broken-profile state (i, j, p): i columns and j cells of the next column filled; the frontier is a staircase, not a straight line](/img/dsa/0bnMHlFUM_o/frame-00326.png)

- **Just three transitions**, deciding cell $(i, j)$ from bit $j$ of $p$:
  - **Bit $j$ is $1$** — cell already covered by a protrusion. Clear it and move on: $q = p \setminus \lbrace j \rbrace$.
  - **Bit $j$ is $0$, place a horizontal tile** — it sticks into the next column, so set bit $j$: $q = p \cup \lbrace j \rbrace$.
  - **Bit $j$ is $0$ and bit $j+1$ is $0$ (and $j+1 < n$), place a vertical tile** — it occupies row $j+1$ of the current column, so set bit $j+1$ (bit $j$ stays $0$): $q = p \cup \lbrace j+1 \rbrace$.
- **Column carry.** After the last cell of a column ($j = n$), roll over: state $(i, n, p)$ becomes $(i+1, 0, p)$ with the same profile.

![Broken-profile driver: base state empty, triple loop over i, j, p with the three cell transitions, a column-carry step, and the all-filled empty-profile answer](/img/dsa/0bnMHlFUM_o/frame-00342.png)

```cpp
// Broken-profile DP for # of domino tilings of an N x M board.
long long count_tilings_broken(int rows, int cols) {
    int N = rows, M = cols, P = 1 << N;
    vector<vector<vector<long long>>> d(
        M + 1, vector<vector<long long>>(N + 1, vector<long long>(P, 0)));
    d[0][0][0] = 1;

    for (int i = 0; i < M; i++) {
        for (int j = 0; j < N; j++)
            for (int p = 0; p < P; p++) {
                long long cur = d[i][j][p];
                if (!cur) continue;
                if (p & (1 << j)) {                       // cell already filled
                    int q = p ^ (1 << j);                 // consume protrusion
                    d[i][j + 1][q] += cur;
                } else {                                  // cell empty: must place a tile
                    int q = p | (1 << j);                 // horizontal -> sticks into next column
                    d[i][j + 1][q] += cur;
                    if (j + 1 < N && !(p & (1 << (j + 1)))) {  // vertical: cell below must be free
                        int r = p | (1 << (j + 1));       // occupy row j+1; bit j stays 0
                        d[i][j + 1][r] += cur;
                    }
                }
            }
        for (int p = 0; p < P; p++)                       // column carry (i,N,p) -> (i+1,0,p)
            d[i + 1][0][p] += d[i][N][p];
    }

    return d[M][0][0];
}
```

- **Why it wins.** Each of the $O(m \cdot n \cdot 2^n)$ states has at most **two** outgoing edges (skip, or one of horizontal/vertical). No `comp()`, no $q$-loop, no division — the code is shorter *and* the total work is $O(m \cdot n \cdot 2^n)$, strictly better than the full-profile $O(m \cdot 3^n)$-ish transition count.
- **When to reach for it.** Any **layered** problem on a 2-D grid where filling the next layer depends *only* on the previous layer's boundary state: domino/parquet tiling, or "colour the grid so no $2 \times 2$ block is monochrome" (profile stores the previous column's colours; the broken variant stores $n+1$ bits to also see the cell above the current one).

[watch from 1:17:14](https://youtu.be/0bnMHlFUM_o?t=4634)

---

## Complexity recap

| Algorithm | Time | Space | Notes |
| --- | --- | --- | --- |
| Hamiltonian path / TSP, bitmask DP | $O(2^n \cdot n^2)$ | $O(2^n \cdot n)$ | vs $\Theta(n!)$ brute force over orders |
| Submask enumeration (all submasks of all masks) | $\Theta(3^n)$ | depends | $\sum_k \binom{n}{k} 2^k = 3^n$ |
| Tiling, full-profile DP (naive `comp` loop) | $O(m \cdot 4^n)$ | $O(2^n)$ rolling | two independent $2^n$ loops |
| Tiling, full-profile DP (compatible-only) | $O(m \cdot c^n),\ 2 < c \le 3$ | $O(2^n)$ rolling | fewer transitions, fat constant |
| Tiling, broken-profile DP | $O(m \cdot n \cdot 2^n)$ | $O(2^n)$ rolling | $\le 2$ transitions/state, simplest code |

---

## Practice problems

Bitmask DP over subsets is a legitimate **hard-interview** topic (it shows up at MAANG for small-$n$ optimization/assignment). Broken-profile / tiling DP is **competitive-leaning** — rarely asked in interviews, common on Codeforces/CSES.

**🎯 Interview (MAANG-style)**

- [Shortest Path Visiting All Nodes — LeetCode 847](https://leetcode.com/problems/shortest-path-visiting-all-nodes/) — Hard — BFS over $(\text{mask}, v)$ states; the unweighted cousin of $dp[\text{mask}][v]$.
- [Find the Shortest Superstring — LeetCode 943](https://leetcode.com/problems/find-the-shortest-superstring/) — Hard — TSP-style bitmask DP with overlap weights; reconstruct the path.
- [Maximum Students Taking Exam — LeetCode 1349](https://leetcode.com/problems/maximum-students-taking-exam/) — Hard — profile DP row by row; the mask is the previous row's seating.
- [Beautiful Arrangement — LeetCode 526](https://leetcode.com/problems/beautiful-arrangement/) — Medium — count permutations via $dp[\text{mask}]$ over used positions.
- [Stickers to Spell Word — LeetCode 691](https://leetcode.com/problems/stickers-to-spell-word/) — Hard — DP over the bitmask of letters still needed.
- [Bitmasking and Dynamic Programming — GeeksforGeeks](https://www.geeksforgeeks.org/bitmasking-and-dynamic-programming-set-1-count-ways-to-assign-unique-cap-to-every-person/) — Medium — the canonical "assign caps to people" subset DP walkthrough.

**🏆 Competitive**

- [Hamiltonian Flights — CSES 1690](https://cses.fi/problemset/task/1690) — Hard — count Hamiltonian paths $1 \to n$ with $dp[\text{mask}][v]$; the counting variant of this lecture's TSP.
- [Elevator Rides — CSES 1653](https://cses.fi/problemset/task/1653) — Med/Hard — bitmask DP storing (rides, last-load) per subset; a bin-packing-flavoured subset DP.
- [Counting Tilings — CSES 2181](https://cses.fi/problemset/task/2181) — Hard — exactly the broken-profile domino-tiling DP built here, modulo $10^9+7$.

---

## Further reading

- [Submask enumeration — cp-algorithms](https://cp-algorithms.com/algebra/all-submasks.html) — the `(s-1) & mask` idiom and its $3^n$ analysis.
- [Dynamic programming on broken profile — cp-algorithms](https://cp-algorithms.com/dynamic_programming/profile-dynamics.html) — the tiling DP with the same cell-by-cell transitions.
- [Travelling salesman problem — Wikipedia](https://en.wikipedia.org/wiki/Travelling_salesman_problem) and the [Held–Karp algorithm](https://en.wikipedia.org/wiki/Held%E2%80%93Karp_algorithm) — the $O(2^n n^2)$ DP by name.
- [TSP using dynamic programming — GeeksforGeeks](https://www.geeksforgeeks.org/travelling-salesman-problem-using-dynamic-programming/) — worked $dp[\text{mask}][v]$ implementation.
- [Domino tiling — Wikipedia](https://en.wikipedia.org/wiki/Domino_tiling) — the counting problem and Kasteleyn's closed form.

---

## Key takeaways

- Reach for **bitmask DP** exactly when a partial solution's only relevant memory is *which elements it uses* — then $d[\text{subset}][\ldots]$ turns an $n!$ search into a $2^n$ table.
- $dp[\text{mask}][v]$ is the workhorse: base `d[1<<s][s]=0`, relax along edges to $u \notin \text{mask}$, answer over the full mask. Learn it cold.
- Bit tests are the vocabulary: `mask & (1<<u)` for membership, `mask | (1<<u)` to add, `(s-1)&mask` to walk submasks.
- **Profile DP** sweeps a grid column by column, remembering only the boundary stick-out pattern; **broken-profile DP** advances one cell at a time for simpler code and fewer transitions.
- The recurring lesson: these are exponential in the *small* dimension. Keep $n \lesssim 20$ and the $2^n$ (or $3^n$) factor is a feature, not a bug.

## Glossary

- **Bitmask / subset DP** — dynamic programming whose state includes a set of elements encoded as the bits of an integer.
- **Hamiltonian path** — a path visiting every vertex of a graph exactly once.
- **TSP (travelling salesman problem)** — find a minimum-cost Hamiltonian path/cycle; NP-complete.
- **Profile** — the bitmask describing the boundary between the filled and unfilled parts of a grid (which rows have a protruding tile).
- **Broken profile** — a profile whose frontier is a staircase (one cell filled at a time) rather than a straight column boundary.
- **NP-complete** — a class of problems with no known polynomial-time algorithm; small instances are still tractable with exponential methods like $2^n$ DP.
