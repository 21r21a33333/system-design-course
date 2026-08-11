---
title: "S04E09 · Linear Programming"
sidebar_position: 9
description: Linear programs and their feasible polytope, the vertex principle, standard and equality forms, LP duality with weak and strong duality, complementary slackness, and how max-flow, matching, and vertex cover are all LPs.
---

# S04E09 · Linear Programming

> **Source:** Pavel Mavrin, [_A&DS S04E09_](https://youtu.be/dwC133f5fVo) · 1h38m lecture → ~18 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- A **linear program (LP)** optimizes a linear objective $c^\top x$ subject to linear constraints $Ax \le b$. Many course problems — **max-flow, bipartite matching, vertex cover, assignment** — are LPs in disguise.
- The feasible region is an intersection of half-spaces: a **convex polytope**. The optimum is always attained at a **vertex**, so 2-variable LPs are solved by enumerating polygon corners.
- **Real-valued LP is in $P$** (polynomial, though the practical workhorse — the **simplex method** — is worst-case exponential). Forcing $x \in \mathbb{Z}$ gives **integer LP**, which is **NP-complete** (it encodes 3-SAT).
- Every LP can be rewritten into **standard form** ($x \ge 0$, all constraints $\le$, maximize) or **equality form** ($x \ge 0$, $Ax = b$) with only a polynomial blow-up.
- **Duality:** every max-LP has a paired min-LP. **Weak duality** says any dual feasible point upper-bounds any primal feasible point; **strong duality** says the two optima coincide. **Complementary slackness** turns "is this optimal?" into cheap per-coordinate checks — and it is exactly the invariant the Hungarian algorithm maintains.

---

## What is a linear program?

- **Ingredients** (all linear, this is the whole definition):
  - **Variables** $x_1, x_2, \dots, x_n$.
  - **Constraints**: linear inequalities such as $2x_1 + 3x_2 + 7x_5 \le 10$, and more of the same.
  - **Objective**: a linear function such as $x_1 + 3x_3 + 4x_5 \to \max$ (maximize or minimize).
- That is all an LP is: some variables, a stack of linear (in)equalities restricting them, and one linear function to push to its extreme.

![Board defining a linear program: variables x1..xn, a constraint 2x1+3x2+7x5 le 10, objective to maximize](/img/dsa/dwC133f5fVo/frame-00008.png)

- **Why we care:** this class has *universal* solution and analysis methods. If you can phrase your problem as an LP, you inherit both a solver and a rich duality theory for free.

[watch from 0:44](https://youtu.be/dwC133f5fVo?t=44)

---

## Course problems that are secretly LPs

**Max-flow as an LP.** One variable $f_{uv}$ per edge (the flow on it):

$$
0 \le f_{uv} \le c_{uv}, \qquad \sum_{u} f_{uv} = \sum_{w} f_{vw} \ \ (\text{conservation at each } v \ne s,t), \qquad \sum_{w} f_{sw} \to \max
$$

- Capacity bounds are linear; conservation is linear; the objective (flow leaving the source) is linear. So max-flow is a plain LP — no integrality demanded.

![Board writing max-flow as an LP: 0 le f_uv le c_uv, conservation sum equals zero, maximize outflow](/img/dsa/dwC133f5fVo/frame-00017.png)

**Maximum matching as an LP.** One variable $x_{uv} \in \{0,1\}$ per edge (take it or not):

$$
0 \le x_{uv} \le 1, \qquad \forall v:\ \sum_{u} x_{uv} \le 1, \qquad \sum x_{uv} \to \max
$$

- Each vertex is used by at most one matched edge; maximize the count of chosen edges.
- **The crucial fork:** matching *demands* $x_{uv} \in \mathbb{Z}$ (you cannot take half an edge), whereas max-flow never needs integrality.

**Real vs integer — the complexity cliff:**

| Variables allowed | Problem class | Complexity |
| --- | --- | --- |
| $x_i \in \mathbb{R}$ | Linear program | **$P$** (polynomial) |
| $x_i \in \mathbb{Z}$ | Integer linear program | **NP-complete** |

- Integer LP encodes 3-SAT: make each variable Boolean ($0 \le x_i \le 1$, integer) and add, per clause, a constraint "at least one literal is true." No surprise it is NP-hard. The genuinely *surprising* fact is that dropping integrality lands you in $P$.

![Board contrasting x in R (P) versus x in Z (NPC), with the max-matching LP and a bipartite graph](/img/dsa/dwC133f5fVo/frame-00061.png)

[watch from 4:03](https://youtu.be/dwC133f5fVo?t=243)

---

## When can you drop integrality for free?

- Sometimes the **real relaxation already yields an integer optimum**, so you can ignore the $\mathbb{Z}$ constraint and still get the exact integer answer.
- **Max-flow with integer capacities.** Max-flow equals min-cut, and a min-cut value is an integer, so the optimum is integer automatically.
- **Bipartite matching.** Reduce it to max-flow (add source $s$ to the left side, sink $t$ from the right, unit capacities). The flow optimum is integer, hence so is the matching. Real LP suffices.
- **Non-bipartite matching — it breaks.** Take a triangle with edges $x_1, x_2, x_3$:

$$
x_1 + x_2 \le 1,\quad x_1 + x_3 \le 1,\quad x_2 + x_3 \le 1,\qquad x_1 + x_2 + x_3 \to \max
$$

- The **integer** optimum is $1$ (pick one edge). But the **real** optimum is $x_1 = x_2 = x_3 = \tfrac12$, giving $\tfrac32$. The relaxation over-shoots because the polytope has a **fractional vertex**.
- **Takeaway:** the relaxation is a valid *upper bound*, sometimes a good approximation — but only integer-vertex polytopes give the exact integer answer for free.

[watch from 10:22](https://youtu.be/dwC133f5fVo?t=622)

---

## The feasible polytope and the vertex principle

- Consider two variables, $x_1, x_2 \ge 0$, with $3x_1 + 2x_2 \le 5$ and $x_1 + 4x_2 \le 6$.
- Each inequality is a **half-plane** (a line plus one side). The feasible set is their intersection: a **convex polygon**.

![Two-variable LP: constraints 3x1+2x2 le 5 and x1+4x2 le 6, plotted as the feasible polygon](/img/dsa/dwC133f5fVo/frame-00097.png)

- **Objective as a direction.** Maximizing $x_1 + x_2$ means finding the feasible point with the largest **projection onto the vector $(1,1)$** — slide the objective line outward until it last touches the polygon.
- **Vertex principle (fundamental theorem of LP).** At least one optimum sits at a **vertex** of the polytope. Sketch: from any interior or edge point, linearity gives a direction along which the objective is non-decreasing; follow it to the boundary, then along an edge, until you reach a vertex.

```mermaid
graph LR
    A["interior point"] -->|move along non-decreasing direction| B["hit an edge"]
    B -->|slide along edge| C["reach a vertex"]
    C --> D["optimum lives at a vertex"]
```

- **Two-variable algorithm.** Intersect all half-planes, list the polygon's vertices (at most $n$ for $n$ lines), evaluate the objective at each, take the best. Simple and exact.
- **Higher dimensions.** The polygon becomes a **polytope** (n-dimensional convex figure with vertices, edges, faces). The same "check every vertex" idea works — but the **number of vertices can grow exponentially** in the dimension, so brute enumeration stops being practical.

![3D feasible region: three half-spaces x1+x2 le 1 etc. intersect into a polytope with a non-integer apex vertex](/img/dsa/dwC133f5fVo/frame-00120.png)

- This is exactly why the triangle relaxation failed: its 3D polytope has the apex vertex $(\tfrac12,\tfrac12,\tfrac12)$, and the objective is maximized *there*.

[watch from 16:21](https://youtu.be/dwC133f5fVo?t=981)

---

## Standard form and equality form

Solvers expect a fixed shape. Any LP converts, with only polynomial growth.

**Standard form:** $x \ge 0$, all constraints $\le$, **maximize**.

$$
\max\ c^\top x \quad\text{s.t.}\quad Ax \le b,\ \ x \ge 0
$$

![Standard form Ax le b with c^T x to max, and the equality form Ax = b with x ge 0 slack variable](/img/dsa/dwC133f5fVo/frame-00140.png)

- **Free variable → non-negative pair.** A variable $x_i$ of unknown sign becomes $x_i = x_i^{+} - x_i^{-}$ with $x_i^{+}, x_i^{-} \ge 0$ (doubles the variable count).
- **$\ge$ constraint → $\le$.** Multiply both sides by $-1$: $2x_1 + 3x_2 \ge 5$ becomes $-2x_1 - 3x_2 \le -5$ (negative coefficients are fine).
- **Equality → two inequalities.** $\text{(sum)} = 5$ becomes $\text{(sum)} \le 5$ **and** $\text{(sum)} \ge 5$.
- **Minimize → maximize.** Negate the objective: minimizing $c^\top x$ is maximizing $-c^\top x$.

![Standard-form conversions: free variable x_i = x_i^+ - x_i^- and a 2x1+3x2 ge 5 constraint negated](/img/dsa/dwC133f5fVo/frame-00158.png)

**Equality form:** $x \ge 0$, $Ax = b$ (some algorithms require it).

$$
\max\ c^\top x \quad\text{s.t.}\quad Ax = b,\ \ x \ge 0
$$

- **Inequality → equality via a slack variable.** For $(\text{sum}) \le 5$, introduce a slack $y_1 \ge 0$ and write $(\text{sum}) + y_1 = 5$. Since $y_1 \ge 0$, this is exactly the original inequality. One extra variable per constraint.

![Equality form: an inequality plus slack y1 ge 0 turned into 2x1+3x2+y1 = 5](/img/dsa/dwC133f5fVo/frame-00176.png)

- **Why not just Gaussian-eliminate $Ax = b$?** Because there are **fewer equations than variables**: the solution set is a whole subspace, not a point. You still must optimize $c^\top x$ over that subspace — the LP has not gone away.

[watch from 33:33](https://youtu.be/dwC133f5fVo?t=2013)

---

## The simplex method (implementation)

- **Idea.** Walk from vertex to vertex of the polytope, each step moving to an adjacent vertex that does not decrease the objective, until no improving move remains.
- **Tableau.** Put the LP in equality form with slacks. The **basis** is the set of variables currently "in" (one per row); non-basic variables are pinned to $0$. Each **pivot** swaps one variable in and one out — geometrically, a hop to a neighboring vertex.
- **Pivot rule (Bland's rule).** Enter the smallest-index variable with a negative reduced cost; among rows, leave via the minimum-ratio test (ties broken by smallest basis index). Bland's rule prevents cycling, guaranteeing termination.
- In practice you use a library simplex — but here is a complete, runnable tableau simplex for `max c·x s.t. Ax ≤ b, x ≥ 0` (assuming the origin is feasible, i.e. `b ≥ 0`):

```cpp
#include <bits/stdc++.h>
using namespace std;

// Dense simplex (Bland's rule): maximize c^T x  s.t.  A x <= b,  x >= 0.
// Assumes b >= 0 so the origin is a feasible starting vertex.
struct Simplex {
    int m, n;                  // m constraints, n structural variables
    vector<vector<double>> T;  // tableau: (m+1) rows x (n+m+1) cols
    vector<int> basis;         // basic variable index per row
    const double EPS = 1e-9;

    Simplex(const vector<vector<double>>& A, const vector<double>& b,
            const vector<double>& c) {
        m = A.size();
        n = A[0].size();
        // columns: [n structural | m slack | 1 RHS]
        T.assign(m + 1, vector<double>(n + m + 1, 0.0));
        basis.resize(m);
        for (int i = 0; i < m; i++) {
            for (int j = 0; j < n; j++) T[i][j] = A[i][j];
            T[i][n + i]  = 1.0;    // slack column for row i
            T[i][n + m]  = b[i];   // RHS
            basis[i]     = n + i;  // slacks start basic (vertex = origin)
        }
        for (int j = 0; j < n; j++) T[m][j] = -c[j];  // objective row holds -c
    }

    void pivot(int row, int col) {
        double p = T[row][col];
        for (double& v : T[row]) v /= p;          // normalize pivot row
        for (int i = 0; i <= m; i++) {            // eliminate column elsewhere
            if (i == row) continue;
            double f = T[i][col];
            if (fabs(f) < EPS) continue;
            for (int j = 0; j < (int)T[i].size(); j++) T[i][j] -= f * T[row][j];
        }
        basis[row] = col;
    }

    // true = bounded optimum reached, false = unbounded
    bool solve() {
        while (true) {
            int col = -1;                                   // entering variable
            for (int j = 0; j < n + m; j++)
                if (T[m][j] < -EPS) { col = j; break; }     // Bland: first negative
            if (col == -1) return true;                     // optimal
            int row = -1; double best = 0;                  // leaving variable
            for (int i = 0; i < m; i++) {
                if (T[i][col] > EPS) {
                    double r = T[i][n + m] / T[i][col];     // ratio test
                    if (row == -1 || r < best - EPS ||
                        (fabs(r - best) < EPS && basis[i] < basis[row])) {
                        best = r; row = i;
                    }
                }
            }
            if (row == -1) return false;                    // unbounded
            pivot(row, col);
        }
    }

    double value() { return T[m][n + m]; }                  // optimum objective

    vector<double> primal() {                               // optimal x
        vector<double> x(n, 0.0);
        for (int i = 0; i < m; i++)
            if (basis[i] < n) x[basis[i]] = T[i][n + m];
        return x;
    }
};

int main() {
    // The lecture's 2-variable example:
    // maximize x1 + x2  s.t.  3x1 + 2x2 <= 5,  x1 + 4x2 <= 6,  x >= 0
    vector<vector<double>> A = {{3, 2}, {1, 4}};
    vector<double> b = {5, 6}, c = {1, 1};
    Simplex s(A, b, c);
    bool ok = s.solve();
    auto x = s.primal();
    printf("bounded=%d  opt=%.4f  at x1=%.4f x2=%.4f\n",
           ok, s.value(), x[0], x[1]);   // opt=2.1000 at (0.8, 1.3)
    return 0;
}
```

- **Verified output:** `bounded=1  opt=2.1000  at x1=0.8000 x2=1.3000`. Hand-check: the two constraint lines cross at $3x_1+2x_2=5,\ x_1+4x_2=6 \Rightarrow (0.8, 1.3)$, and $0.8+1.3 = 2.1$ beats every other vertex $((0,0),(5/3,0),(0,3/2))$. The optimum is the interior corner, exactly as the vertex principle predicts.
- **Complexity caveat.** Simplex is fast in practice yet **worst-case exponential**; there exist polynomial LP algorithms (ellipsoid, interior-point) that are theoretically polynomial but often slower in practice.

[watch from 32:29](https://youtu.be/dwC133f5fVo?t=1949)

---

## LP duality

Every LP comes with a paired LP. The transformation is mechanical; the meaning is deep.

**The recipe.** Given the primal (left), the dual is (right):

$$
\underbrace{\max\ c^\top x,\ \ Ax \le b,\ \ x \ge 0}_{\text{primal}}
\qquad\Longleftrightarrow\qquad
\underbrace{\min\ b^\top y,\ \ A^\top y \ge c,\ \ y \ge 0}_{\text{dual}}
$$

- **One dual variable per primal constraint** (so $m$ constraints give $m$ dual variables $y_1, \dots, y_m$).
- **Transpose $A$**, and **swap the roles of $b$ and $c$**. The objective flips $\max \leftrightarrow \min$; the constraints flip $\le \leftrightarrow \ge$.

![Duality table: primal max c^T x with Ax le b becomes dual min b^T y with A^T y ge c, y ge 0](/img/dsa/dwC133f5fVo/frame-00202.png)

**Worked dual.** Primal: $x_1,x_2,x_3 \ge 0$ with $3x_1+2x_2+5x_3 \le 10$ and $2x_1+x_2+2x_3 \le 7$, maximize $x_1 + 7x_2 + 3x_3$. Two constraints → two dual variables $y_1, y_2$; transpose reads the coefficients **down the columns**:

$$
3y_1 + 2y_2 \ge 1,\quad 2y_1 + y_2 \ge 7,\quad 5y_1 + 2y_2 \ge 3,\qquad \min\ 10y_1 + 7y_2
$$

**Weak duality (proved on the board).** Take any primal-feasible $x$ and dual-feasible $y$. Then

$$
c^\top x \ \le\ (A^\top y)^\top x \ =\ y^\top A x \ \le\ y^\top b \ =\ b^\top y
$$

- First $\le$ uses $A^\top y \ge c$ with $x \ge 0$; second $\le$ uses $Ax \le b$ with $y \ge 0$. **Every dual feasible value is an upper bound on every primal feasible value.**

![Weak-duality derivation boxed: c^T x le (A^T y)^T x le b^T y, so c^T x le b^T y](/img/dsa/dwC133f5fVo/frame-00214.png)

**Strong duality (stated).** The two optima are **equal** — the primal max and the dual min meet at the same value. So the dual's *best* upper bound is *exactly* the primal optimum. (Proof needs more linear algebra; not shown in this lecture.)

$$
\max_{x}\ c^\top x \ =\ \min_{y}\ b^\top y
$$

[watch from 44:41](https://youtu.be/dwC133f5fVo?t=2681)

---

## Duals of the problems we know

Building duals mechanically reproduces classical combinatorial pairings.

**Matching → vertex cover.** Start from the (simplified) bipartite-matching LP $x_{uv} \ge 0$, $\forall v: \sum_u x_{uv} \le 1$, maximize $\sum x_{uv}$. The matrix $A$ has a row per vertex with $1$s on that vertex's incident edges. Transposing, each **edge** $uv$ gives a dual constraint on the endpoint variables:

$$
y_u + y_v \ge 1 \ \ (\forall\, \text{edges } uv), \qquad y_v \ge 0, \qquad \min\ \sum_v y_v
$$

- Read literally: assign each vertex a value so that **every edge has a marked endpoint**, minimizing the marks used. That is the **minimum vertex cover** — dual to maximum matching, recovering **König's theorem** with pure linear algebra instead of combinatorial argument.

**Assignment → potentials (Hungarian).** Perfect matching of minimum cost: $x_{uv} \ge 0$, $\forall v: \sum_u x_{uv} = 1$ (equality!), minimize $\sum x_{uv} w_{uv}$.

- The equality constraint makes the dual variables **free (unbounded in sign)** — an equality primal constraint yields a sign-free dual variable.

$$
y_u + y_v \le w_{uv}\ \ (\forall\, uv), \qquad \max\ \sum_v y_v
$$

- These $y_v$ are exactly the **potentials** of the Hungarian algorithm: the reduced weight $w_{uv} - y_u - y_v \ge 0$ is the Hungarian non-negativity condition, and maximizing $\sum y_v$ is what the method drives.

![Matching/vertex-cover/assignment duals side by side, with the reduced-weight condition w_uv - y_u - y_v ge 0 boxed](/img/dsa/dwC133f5fVo/frame-00274.png)

[watch from 53:36](https://youtu.be/dwC133f5fVo?t=3216)

---

## Complementary slackness

- **Goal.** Given a primal $x$ and a dual $y$, certify optimality *cheaply*. By strong duality, both are optimal exactly when their objectives are equal: $c^\top x = b^\top y$.
- **Derivation.** For the equality-form pair ($Ax = b$, $x \ge 0$; $A^\top y \ge c$, $\min b^\top y$), rewrite $c^\top x - b^\top y = 0$. Substituting $b^\top y = x^\top A^\top y$ gives

$$
c^\top x - x^\top A^\top y = 0 \quad\Longrightarrow\quad x^\top\!\left(c - A^\top y\right) = 0
$$

![Complementary slackness derivation: c^T x - b^T y = 0 becomes x^T (c - A^T y) = 0](/img/dsa/dwC133f5fVo/frame-00308.png)

- Here $x \ge 0$ and $c - A^\top y \le 0$ (dual feasibility), so this is a dot product of a non-negative vector with a non-positive vector equalling zero. That forces **per-coordinate**: for each $i$,

$$
x_i = 0 \quad\textbf{or}\quad (A^\top y)_i = c_i
$$

- **Complementary slackness.** In each complementary pair of constraints, **at least one is tight**. One awkward global equality becomes many tiny local checks — far easier to verify.
- **Matching / vertex cover reading.** $x_{uv} = 1 \Rightarrow$ exactly one endpoint of that edge is in the cover; $y_v = 1 \Rightarrow$ that cover vertex has a matched edge on it. These are precisely the König-duality conditions.
- **Assignment / Hungarian reading.** $x_{uv} = 1 \Rightarrow y_u + y_v = w_{uv}$, i.e. **matched edges have reduced weight zero** — the invariant the Hungarian method maintains while nudging potentials and augmenting the matching until every constraint is satisfied and both solutions are optimal.

[watch from 1:11:33](https://youtu.be/dwC133f5fVo?t=4293)

---

## Postscript: non-bipartite matching needs exponentially many constraints

- The fractional triangle vertex $(\tfrac12,\tfrac12,\tfrac12)$ is killed by adding a cutting plane $x_1 + x_2 + x_3 \le 1$.
- **General odd-set constraints.** For every odd-size subset $U \subseteq V$, add

$$
\sum_{u,v \in U} x_{uv} \ \le\ \left\lfloor \frac{\lvert U \rvert}{2} \right\rfloor
$$

![The fractional triangle vertex removed by the odd-set cut x1+x2+x3 le 1, alongside the assignment dual](/img/dsa/dwC133f5fVo/frame-00364.png)

- There are **exponentially many** such subsets — but in a dual solution **almost all corresponding variables are zero** (non-zero only for contracted **blossoms**, and there are polynomially many). Maintaining just those makes weighted non-bipartite matching polynomial without ever writing the exponential system explicitly. (That is a lecture of its own.)

[watch from 1:29:27](https://youtu.be/dwC133f5fVo?t=5367)

---

## Complexity recap

| Aspect | Result |
| --- | --- |
| Real-valued LP | in $P$ (polynomial: ellipsoid / interior-point) |
| Integer LP (ILP) | NP-complete |
| Simplex, practical | fast on typical inputs |
| Simplex, worst case | exponential number of pivots |
| Standard/equality-form conversion | polynomial blow-up (variables at most doubled, one slack per constraint) |
| Feasible region | convex polytope; optimum at a vertex |
| Vertices of an $n$-dim polytope | up to exponential in $n$ |
| Weak duality | any dual value $\ge$ any primal value (max side) |
| Strong duality | primal max $=$ dual min |

---

## Practice problems

> **Honesty note.** Linear programming is essentially **never hand-coded in interviews** — you would call a solver in practice. What *is* interview-relevant is the **modeling and duality intuition**: recognizing max-flow / matching / min-cut / assignment structure, and using min-cut = max-flow or König-style min-max reasoning. The problems below train that intuition; the simplex tableau itself is competitive-only and rare.

**Modeling problems as LPs — the real skill.** Ask: what are the variables, which constraints are linear, what is being optimized, and does an integer optimum come for free (integral polytope, e.g. bipartite / flow) or not (odd cycles)? If the constraint matrix is *totally unimodular*, the LP relaxation is already integral — that is the lens behind flows and bipartite matching.

**🎯 Interview (MAANG-style)** — duality / min-max / matching intuition

- [Maximum Bipartite Matching — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/maximum-bipartite-matching/) — Med — the primal whose dual is vertex cover.
- [Minimum Cost to Connect Two Groups of Points — LeetCode 1595](https://leetcode.com/problems/minimum-cost-to-connect-two-groups-of-points/) — Hard — an assignment-flavored min-cost covering problem.
- [Campus Bikes II — LeetCode 1066](https://leetcode.com/problems/campus-bikes-ii/) — Med — the assignment problem in miniature (worker-to-task min-cost matching).
- [Maximum Students Taking Exam — LeetCode 1349](https://leetcode.com/problems/maximum-students-taking-exam/) — Hard — an independent-set / matching-style packing, an ILP in spirit.
- [Course Schedule IV — LeetCode 1462](https://leetcode.com/problems/course-schedule-iv/) — Med — reachability constraints; practice translating rules into a constraint system.

**🏆 Competitive** — where LP/simplex actually appears

- [Cutting Figures — cp-algorithms max-flow track (Edmonds–Karp)](https://cp-algorithms.com/graph/edmonds_karp.html) — the flow LP solved combinatorially; integer optimum for free.
- [Kuhn's bipartite matching — cp-algorithms](https://cp-algorithms.com/graph/kuhn_maximum_bipartite_matching.html) — the matching primal / vertex-cover dual pair, coded.
- [Codeforces problems tagged `math` + `flows`/`matchings`](https://codeforces.com/problemset?tags=flows) — model-it-as-flow/LP is the recurring trick; a true "write a simplex" task is rare and usually flagged as such.

---

## Further reading

- [Linear programming — Wikipedia](https://en.wikipedia.org/wiki/Linear_programming) — forms, geometry, algorithms.
- [Simplex algorithm — Wikipedia](https://en.wikipedia.org/wiki/Simplex_algorithm) — tableau, pivoting, Bland's rule, worst case.
- [Dual linear program — Wikipedia](https://en.wikipedia.org/wiki/Dual_linear_program) and [Duality (optimization) — Wikipedia](https://en.wikipedia.org/wiki/Duality_(optimization)) — weak/strong duality, complementary slackness.
- [Fundamental theorem of linear programming — Wikipedia](https://en.wikipedia.org/wiki/Fundamental_theorem_of_linear_programming) — the optimum-at-a-vertex result.
- [Linear Programming — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/linear-programming/) and [Simplex algorithm, tabular method — GeeksforGeeks](https://www.geeksforgeeks.org/simplex-algorithm-tabular-method/).
- [König's theorem — Wikipedia](https://en.wikipedia.org/wiki/König%27s_theorem_(graph_theory)) and [Max-flow min-cut theorem — Wikipedia](https://en.wikipedia.org/wiki/Max-flow_min-cut_theorem) — the combinatorial faces of LP duality.

---

## Key takeaways

- An LP optimizes a linear objective over an intersection of half-spaces; the feasible region is a **convex polytope** and the optimum sits at a **vertex**.
- **Real LP is in $P$; integer LP is NP-complete.** The relaxation gives an upper bound, exact only when the polytope has integer vertices (flows, bipartite matching).
- Any LP normalizes to **standard** or **equality form** cheaply (free-variable split, sign flips, slack variables).
- **Simplex** hops between adjacent vertices via pivots; fast in practice, exponential in the worst case.
- **Duality** pairs every max-LP with a min-LP: weak duality bounds, strong duality equates, and **complementary slackness** decomposes optimality into per-coordinate tightness — the exact machinery behind König's theorem and the Hungarian algorithm.

## Glossary

- **Polytope** — a bounded convex region formed by intersecting finitely many half-spaces; the LP feasible set.
- **Vertex (basic feasible solution)** — a corner of the polytope; some optimum always lands on one.
- **Standard form** — $x \ge 0$, $Ax \le b$, maximize $c^\top x$.
- **Equality form** — $x \ge 0$, $Ax = b$ (reached by adding slack variables), maximize $c^\top x$.
- **Slack variable** — a non-negative variable added to turn $\le$ into $=$.
- **Dual LP** — the paired problem: transpose $A$, swap $b$ and $c$, flip $\max \leftrightarrow \min$ and $\le \leftrightarrow \ge$.
- **Weak duality** — every dual feasible value bounds every primal feasible value.
- **Strong duality** — primal optimum equals dual optimum.
- **Complementary slackness** — at optimality, in each primal-dual constraint pair at least one is tight; $x_i = 0$ or its dual constraint is equality.
- **Integer LP (ILP)** — an LP with variables restricted to integers; NP-complete.
- **Blossom** — an odd cycle contracted in non-bipartite matching, corresponding to a non-zero odd-set dual variable.
