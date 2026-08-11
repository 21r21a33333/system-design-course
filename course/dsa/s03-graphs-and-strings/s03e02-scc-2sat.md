---
title: "S03E02 · Strongly Connected Components & 2-SAT"
sidebar_position: 2
description: Strong connectivity in directed graphs, the condensation DAG, Kosaraju's two-pass linear-time SCC algorithm with a full correctness proof, and reducing 2-SAT to SCCs on the implication graph.
---

# S03E02 · Strongly Connected Components & 2-SAT

> **Source:** Pavel Mavrin, [_A&DS S03E02_](https://youtu.be/i6jRvjlsuC4) · 1h32m lecture → ~14 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- Two vertices of a **directed** graph are **strongly connected** if each is reachable from the other. This is an equivalence relation, so the vertices split into **strongly connected components (SCCs)**.
- Squeezing every SCC into one node gives the **condensation** — and it is always a **DAG** (any cycle would merge into one component).
- The naive "two DFS per vertex, intersect" method is $\Theta(V\cdot E)$. **Kosaraju's algorithm** finds all SCCs in **$O(V+E)$** with two depth-first passes: one on the graph to order vertices by exit time, one on the **reversed** graph in that order.
- Kosaraju also hands you the SCCs already in the **topological order** of the condensation — no extra top-sort needed.
- **2-SAT** (a CNF formula with exactly two literals per clause) reduces to SCCs: build an **implication graph** on the $2n$ literals; the formula is satisfiable **iff no variable $x$ shares an SCC with $\lnot x$**. A satisfying assignment falls out of the condensation's topological order. Whole thing is $O(n+m)$.

---

## Strong connectivity in directed graphs

- In an **undirected** graph, connectivity is easy: two vertices are connected iff they sit in the same connected component (a symmetric relation).
- In a **directed** graph, reachability is **not symmetric**: $u$ may be reachable from $v$ while $v$ is not reachable from $u$.
- Define: $v$ and $u$ are **strongly connected** if there is a path $v \to u$ **and** a path $u \to v$.
- This relation is:
  - **symmetric** — the two paths just swap roles;
  - **transitive** — if $v \leftrightarrow u$ and $u \leftrightarrow w$, splice the paths to get $v \leftrightarrow w$;
  - reflexive.
- So it is an **equivalence relation**, and the vertices partition into equivalence classes called **strongly connected components**.
- A single vertex with no return path to anyone else is its own SCC (size-1 components are fine).

![Directed example graph with vertices 1 through 7 used all lecture](/img/dsa/i6jRvjlsuC4/frame-00031.png)

- **Running example** (board): 7 vertices. The four vertices $\lbrace 2,3,6,7 \rbrace$ form one SCC (call it **A**) because you can travel from any of them to any other and back. Vertices $\lbrace 1,5 \rbrace$ form a two-cycle SCC (**B**), and vertex $\lbrace 4 \rbrace$ sits alone as SCC **C**.

![The same graph with SCCs A, B, C circled](/img/dsa/i6jRvjlsuC4/frame-00041.png)

[watch from 3:47](https://youtu.be/i6jRvjlsuC4?t=227)

---

## The condensation is a DAG

- Build a new graph, the **condensation**: one vertex per SCC; draw an edge $A \to B$ whenever the original graph has any edge from a vertex of $A$ to a vertex of $B$.
- On the board: edge $3 \to 1$ gives $A \to B$; edge $6 \to 4$ gives $A \to C$; edge $4 \to 1$ gives $C \to B$.
- **Key fact: the condensation is always acyclic.** If it had a cycle $A \to B \to \dots \to A$, then every vertex on that cycle could reach every other and come back, so they would all be in the **same** SCC — contradiction, since each SCC is a single condensation node.
- Why this matters: a DAG admits a **topological order**, and countless graph algorithms become easy on a DAG. A common recipe is: find SCCs → build the condensation → run a DAG algorithm on it.

![Condensation of the example: nodes A, B, C with A to B, A to C, C to B — an acyclic graph](/img/dsa/i6jRvjlsuC4/frame-00061.png)

- Building the condensation once you know each vertex's component label is trivial: scan all edges, and for every edge whose endpoints have **different** labels, add that edge between the two component nodes.

[watch from 8:41](https://youtu.be/i6jRvjlsuC4?t=521)

---

## The naive algorithm and why it is too slow

- To find the SCC of a vertex $s$ directly:
  1. DFS from $s$ on the graph → set $R^{+}$ of vertices **reachable from** $s$.
  2. DFS from $s$ on the **reversed** graph → set $R^{-}$ of vertices **that reach** $s$.
  3. $\text{SCC}(s) = R^{+} \cap R^{-}$ — every $x$ in both can go to $s$ and back.
- Repeat for the next unlabeled vertex, and so on.
- **Cost:** each pair of DFS traversals is $O(E)$, but the intersection can be tiny (imagine an almost-acyclic graph where each round labels only one vertex). In the worst case you pay $O(E)$ per vertex → $\Theta(V \cdot E)$. Too slow for large graphs.

[watch from 13:35](https://youtu.be/i6jRvjlsuC4?t=815)

---

## Kosaraju's algorithm — two passes, linear time

The lecture uses **Kosaraju's algorithm** (it mentions Tarjan's as the alternative, deferring its "lowlink magic" to the bridges lecture). Two depth-first passes:

**Pass 1 — order by exit time.** Run DFS on the graph exactly as in topological sort: when a vertex finishes (all its out-edges explored), append it to a list `order`.

```cpp
#include <bits/stdc++.h>
using namespace std;

struct Kosaraju {
    int n;
    vector<vector<int>> g, gr;   // graph and reversed graph
    vector<int> comp;            // comp[v] = SCC id of v, or -1
    vector<char> used;           // visited flags for pass 1
    vector<int> order;           // vertices by DFS exit time (pass 1)
    int ncomp = 0;               // number of SCCs found

    Kosaraju(int n) : n(n), g(n), gr(n), comp(n, -1), used(n, 0) {}

    void add_edge(int u, int v) {
        g[u].push_back(v);
        gr[v].push_back(u);      // build the reversed graph in parallel
    }

    void dfs1(int v) {                        // pass 1: on g
        used[v] = 1;
        for (int u : g[v]) if (!used[u]) dfs1(u);
        order.push_back(v);                   // append on EXIT
    }
```

**Pass 2 — peel SCCs on the reversed graph.** Reverse `order`, then walk it. For each still-unlabeled vertex, DFS on the **reversed** graph; everything that DFS reaches is exactly one SCC.

```cpp
    void dfs2(int v, int label) {             // pass 2: on gr
        comp[v] = label;
        for (int u : gr[v]) if (comp[u] == -1) dfs2(u, label);
    }

    void run() {
        for (int v = 0; v < n; v++)
            if (!used[v]) dfs1(v);
        reverse(order.begin(), order.end());  // now: descending exit time
        for (int v : order)
            if (comp[v] == -1)                // new sink-side SCC
                dfs2(v, ncomp++);
    }
};
```

- **Data structures.** `used` is the pass-1 visited marker; `comp` doubles as pass-2's visited marker **and** the final label array (each vertex ends up tagged with its SCC id). `order` maintains the invariant "vertices appended in increasing finish time".
- **Bonus:** because `ncomp` is incremented as we peel components from the source side of the condensation toward the sinks, the SCC **ids come out in topological order of the condensation** — you get the top-sort for free.

![Kosaraju code on the right: dfs(v) marks and appends to p, reverse(p), then dfs2 over p on reverse edges](/img/dsa/i6jRvjlsuC4/frame-00124.png)

- Board trace on the example. Pass 1 from vertex 1 then 2 produces an exit-order list; reversed, the front vertex belongs to a **source** SCC of the condensation. The second DFS on reversed edges from that vertex marks exactly $\lbrace 2,3,6,7\rbrace$ (component A), then $\lbrace 4\rbrace$, then $\lbrace 1,5\rbrace$.

![Board with p = 2 6 7 4 3 1 5, the reversed order, and the second-pass code](/img/dsa/i6jRvjlsuC4/frame-00104.png)

[watch from 19:16](https://youtu.be/i6jRvjlsuC4?t=1156)

---

## Why the reversed-order second pass is exactly one SCC

Two observations carry the whole proof (both mirror the topological-sort argument).

- **Observation 1 — the first-entered vertex exits last within its SCC.** When DFS first enters an SCC through some vertex $v$, none of that SCC is marked yet. Since every other vertex $u$ of the SCC is reachable from $v$ **inside** the SCC, the recursion from $v$ marks all of them before returning. Hence $v$ **exits last** among its SCC, so in `order` $v$ is the **rightmost** of its SCC (before the final reverse, the leftmost after it).
- **Observation 2 — first-vertices respect condensation order.** Take two SCCs $A, B$ with a condensation edge $A \to B$, and let $v_A, v_B$ be their first-entered vertices. Because you cannot finish $v_A$ before exploring the $A \to B$ edge, some vertex of $B$ finishes before $v_A$, so $v_A$ exits after $v_B$ — meaning in the reversed `order`, $v_A$ comes **before** $v_B$. So the first-vertices appear in **topological order** of the condensation.

- **Putting it together.** After reversing, the front of `order` is the first-vertex of a **source** SCC of the condensation (no incoming condensation edges). Running DFS on the **reversed** graph from it:
  - reaches every vertex of that SCC (they are mutually reachable), but
  - cannot escape it — an escape would require a **reverse-graph** edge out, i.e. a normal edge **into** the SCC, which a source SCC does not have.
  - So it marks **exactly** that SCC. Peel it, advance to the next unmarked front vertex (now a source of the remaining condensation), repeat.

![Proof sketch: within an SCC the entry vertex finishes last; entry vertices are in topological order](/img/dsa/i6jRvjlsuC4/frame-00187.png)

- **Complexity.** Build reverse graph $O(V+E)$, two DFS passes $O(V+E)$, labeling $O(V+E)$. Total **$O(V+E)$**.

[watch from 44:08](https://youtu.be/i6jRvjlsuC4?t=2648)

---

## The 2-SAT problem

- A **2-SAT** instance is a boolean formula in **CNF** where **every clause has exactly two literals**, each literal a variable or its negation:

$$
(x \lor y) \land (\lnot y \lor z) \land (\lnot z \lor \lnot x) \land (\lnot y \lor x)
$$

- **Question:** is there an assignment of the $n$ variables making the whole formula true?
- Context: **3-SAT** (three literals per clause) is NP-complete, and general SAT is too. **2-SAT is special** — it is solvable in **linear time**. Counting the number of satisfying assignments, however, is still hard.
- Manual intuition: fix a value for one variable and propagate. If $x = 0$ in $(x \lor y)$, then $y$ must be $1$; that forces the next clause, and so on. Sometimes a guess cascades into a **contradiction**, so you try the other value. The clean way to automate this is a graph.

![The board formula (x or y) and (not y or z) and (not z or not x) and (not y or x)](/img/dsa/i6jRvjlsuC4/frame-00254.png)

[watch from 49:56](https://youtu.be/i6jRvjlsuC4?t=2996)

---

## The implication graph

- Rewrite each clause $a \lor b$ as **two implications**: $\lnot a \Rightarrow b$ and $\lnot b \Rightarrow a$ (if one side is false, the other must be true).
- Build a directed graph with $2n$ nodes — one for each **literal** $x_i$ and $\lnot x_i$ — and add both implication edges per clause. For $(x \lor y)$: edges $\lnot x \Rightarrow y$ and $\lnot y \Rightarrow x$.

```cpp
// Literal encoding: variable i -> node 2*i (x_i true), 2*i+1 (x_i false).
struct TwoSat {
    int n;                 // number of variables
    Kosaraju k;            // implication graph on 2*n literal-nodes
    TwoSat(int n) : n(n), k(2 * n) {}

    int lit(int i, bool val) { return 2 * i + (val ? 0 : 1); }

    // clause: (var i == vi) OR (var j == vj)
    void add_clause(int i, bool vi, int j, bool vj) {
        k.add_edge(lit(i, !vi), lit(j,  vj));   // !A => B
        k.add_edge(lit(j, !vj), lit(i,  vi));   // !B => A
    }
```

- The graph is **skew-symmetric**: edges come in mirror pairs, and negating both endpoints of $u \Rightarrow v$ gives the valid edge $\lnot v \Rightarrow \lnot u$. A consequence proven on the board: SCCs come in **mirror pairs**, and the condensation is itself skew-symmetric.

![Implication graph for the formula: literal nodes x, not x, y, not y, z, not z with implication edges](/img/dsa/i6jRvjlsuC4/frame-00285.png)

[watch from 59:56](https://youtu.be/i6jRvjlsuC4?t=3596)

---

## Satisfiability = no variable shares an SCC with its negation

- Inside any SCC, **every literal implies every other**, so all literals of an SCC must take the **same** truth value (all true or all false).
- If $x_i$ and $\lnot x_i$ land in the **same** SCC, then $x_i \Rightarrow \lnot x_i$ **and** $\lnot x_i \Rightarrow x_i$ — no value works for $x_i$. The formula is **unsatisfiable**.
- **This is the only obstruction:** if for every variable $x_i$ and $\lnot x_i$ sit in **different** SCCs, the formula **is** satisfiable. So the satisfiability test is exactly:

$$
\text{SAT} \iff \forall i:\quad \operatorname{comp}(x_i) \neq \operatorname{comp}(\lnot x_i)
$$

- Run Kosaraju once on the implication graph and compare the two component ids per variable.

![Condensation of the implication graph; mirror-paired components A and not-A](/img/dsa/i6jRvjlsuC4/frame-00351.png)

[watch from 1:06:06](https://youtu.be/i6jRvjlsuC4?t=3966)

---

## Reading off an assignment

- Work on the **condensation** (a DAG). Take its **topological order**. Because the graph is skew-symmetric, the SCC of $x_i$ and the SCC of $\lnot x_i$ are distinct nodes; one comes **later** in topological order than the other.
- **Rule:** set a literal **true** when its SCC appears **later** in topological order than the SCC of its negation (equivalently: assign the *sink*-side component true, the *source*-side false).
- **Why it is consistent.** Take the topologically-first component; it has no incoming edges, so assigning it $0$ satisfies every implication out of it (`0 ⇒ anything` holds). Its mirror component then has no outgoing edges (skew symmetry), so assigning it $1$ satisfies every implication into it (`anything ⇒ 1` holds). Remove both, recurse.
- Kosaraju already emits SCC ids in condensation-topological order, so with the encoding above the rule is simply `comp[x_i] > comp[!x_i]`.

```cpp
    bool solve(vector<char>& assign) {
        k.run();                       // SCCs; ids in condensation topo order
        assign.assign(n, 0);
        for (int i = 0; i < n; i++) {
            int ct = k.comp[lit(i, true)], cf = k.comp[lit(i, false)];
            if (ct == cf) return false;        // x_i and !x_i in same SCC
            assign[i] = (ct > cf);             // later component wins -> true
        }
        return true;
    }
};
```

- On the lecture formula the solver returns satisfiable with $x = 1,\ y = 0,\ z = 0$ — check: $(1\lor 0)\land(1\lor 0)\land(1\lor 0)\land(1\lor 1)$, all true. (The board also finds $x=0,y=1,z=1$; multiple assignments can be valid.)

![Topological order of the condensation with pairs A, not-A assigned 0 and 1](/img/dsa/i6jRvjlsuC4/frame-00364.png)

- **End-to-end cost.** Building the implication graph is $O(n+m)$ edges, Kosaraju is $O(n+m)$, assignment is $O(n)$. So 2-SAT is **$O(n+m)$**.

[watch from 1:21:27](https://youtu.be/i6jRvjlsuC4?t=4887)

---

## Complexity recap

| Operation | Time | Space |
| --- | --- | --- |
| Naive SCC (DFS-pair per vertex) | $\Theta(V \cdot E)$ | $O(V+E)$ |
| Kosaraju SCC (two passes) | $\Theta(V+E)$ | $O(V+E)$ |
| Build condensation from labels | $\Theta(V+E)$ | $O(V+E)$ |
| 2-SAT solve (implication graph + SCC) | $\Theta(n+m)$ | $O(n+m)$ |

Here $V, E$ are the vertices and edges of the directed graph; $n$ is the number of variables and $m$ the number of clauses in a 2-SAT instance (implication graph has $2n$ nodes and $2m$ edges).

---

## Practice problems

SCC and 2-SAT lean **competitive** — 2-SAT rarely shows up in standard interview rounds, but SCC/Tarjan ideas do surface as "find bridges / critical edges" and connectivity questions.

**🎯 Interview (MAANG-style)**

- [Critical Connections in a Network — LeetCode 1192](https://leetcode.com/problems/critical-connections-in-a-network/) — Hard — bridges via Tarjan lowlink, the sibling DFS-timestamp technique to the SCC one.
- [Number of Connected Components in an Undirected Graph — LeetCode 323](https://leetcode.com/problems/number-of-connected-components-in-an-undirected-graph/) — Medium — the undirected warm-up; contrast with directed strong connectivity.
- [Course Schedule — LeetCode 207](https://leetcode.com/problems/course-schedule/) — Medium — cycle detection in a directed graph; a satisfiable schedule needs the condensation to have only singleton SCCs.
- [Redundant Connection II — LeetCode 685](https://leetcode.com/problems/redundant-connection-ii/) — Hard — directed-graph structure reasoning in the spirit of SCC analysis.

**🏆 Competitive**

- [Planets and Kingdoms — CSES 1683](https://cses.fi/problemset/task/1683) — Medium — label every vertex with its SCC id; a direct Kosaraju/Tarjan implementation.
- [Flight Routes Check — CSES 1682](https://cses.fi/problemset/task/1682) — Medium — the graph is strongly connected iff there is exactly one SCC; otherwise print a missing route.
- [Giant Pizza — CSES 1684](https://cses.fi/problemset/task/1684) — Hard — the canonical 2-SAT problem: toppings as variables, wishes as two-literal clauses.
- [Strongly Connected Components — cp-algorithms](https://cp-algorithms.com/graph/strongly-connected-components.html) — reference implementation and the condensation build.
- [2-SAT — cp-algorithms](https://cp-algorithms.com/graph/2SAT.html) — implication-graph construction and assignment recovery, matching this lecture.

---

## Further reading

- [Strongly connected component — Wikipedia](https://en.wikipedia.org/wiki/Strongly_connected_component).
- [Kosaraju's algorithm — Wikipedia](https://en.wikipedia.org/wiki/Kosaraju%27s_algorithm) and [Tarjan's SCC algorithm — Wikipedia](https://en.wikipedia.org/wiki/Tarjan%27s_strongly_connected_components_algorithm).
- [2-satisfiability — Wikipedia](https://en.wikipedia.org/wiki/2-satisfiability).
- [Strongly Connected Components — GeeksforGeeks](https://www.geeksforgeeks.org/strongly-connected-components/) and [Tarjan's algorithm — GeeksforGeeks](https://www.geeksforgeeks.org/tarjan-algorithm-find-strongly-connected-components/).
- [2-Satisfiability (2-SAT) — GeeksforGeeks](https://www.geeksforgeeks.org/2-satisfiability-2-sat-problem/).

---

## Key takeaways

- Strong connectivity partitions a directed graph into SCCs; collapsing them yields the **condensation**, which is always a **DAG**.
- **Kosaraju** = DFS-by-exit-time on the graph, then DFS in reversed exit order on the **reversed** graph. Linear time, and it delivers SCCs in condensation-topological order.
- The correctness rests on two facts: an SCC's first-entered vertex finishes last within it, and first-entered vertices respect the condensation's topological order.
- **2-SAT** is an SCC problem in disguise: build the implication graph, then it is satisfiable **iff no $x$ and $\lnot x$ share an SCC**, with the assignment read from the condensation's topological order — all in $O(n+m)$.

## Glossary

- **Strongly connected** — two vertices each reachable from the other in a directed graph.
- **SCC** — a maximal set of mutually strongly-connected vertices.
- **Condensation** — the DAG obtained by contracting each SCC to a single vertex.
- **Implication graph** — for 2-SAT, a directed graph on the $2n$ literals whose edges encode `if A then B`.
- **Skew-symmetric graph** — a graph where negating both endpoints of any edge yields another edge; the 2-SAT implication graph is one, so its SCCs come in mirror pairs.
- **CNF** — conjunctive normal form: an AND of clauses, each clause an OR of literals.
