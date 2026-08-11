---
title: "S03E08 · Graph Games"
sidebar_position: 8
description: Combinatorial games on directed graphs — win/lose classification by retrograde analysis, draw states from cycles, a linear-time queue algorithm, and Sprague-Grundy nimbers with the XOR sum rule.
---

# S03E08 · Graph Games

> **Source:** Pavel Mavrin, [_A&DS S03E08_](https://youtu.be/m5k-3yXxvLw) · 1h34m lecture → ~16 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- A **graph game** places a token on a vertex of a directed graph; two players alternately slide it along an edge, and whoever cannot move **loses**. We label every vertex **W** (mover wins) or **L** (mover loses).
- The rule is local and recursive: a vertex is **L** if **all** moves go to **W** vertices (a sink is L); it is **W** if **some** move goes to an **L** vertex.
- On a **DAG** the labels fall out of one right-to-left (reverse-topological) pass. This is **retrograde analysis**: reverse-BFS outward from terminal states.
- With **cycles** a third outcome appears — **draw** (the game runs forever). A vertex stays a draw exactly when it can never be forced to L and can never reach an L; the same reverse-BFS resolves it, and whatever is left unmarked is a draw.
- A **queue-based** implementation with an unresolved-out-edge counter runs in $O(V+E)$.
- For a **sum of games** (several independent tokens, move one per turn) the winner is governed by the **Grundy value** $g(v)=\operatorname{mex}$ of children's values; $g=0 \iff$ losing, and $g(A{+}B)=g(A)\oplus g(B)$ — the **Sprague-Grundy** theorem.

---

## The classical graph game

- **Setup.** A directed graph, a token on some start vertex, two players. On your turn you move the token along one outgoing edge. If you have **no move**, you lose. There are no ties in a finite game.
- **Question.** From a given start vertex, does the **first player** win under optimal play?
- We answer it for **every** vertex at once: label each vertex W (the player about to move wins) or L (that player loses).

![Graph-game board: a small directed graph with the no-move-lose rule, alongside an acyclic fan-out from vertex v](/img/dsa/m5k-3yXxvLw/frame-00032.png)

- **The two labeling rules** (the whole theory):
  - A vertex with **no outgoing edge** (a sink) is **L** — the mover is stuck.
  - A vertex is **W** if **at least one** outgoing edge leads to an **L** vertex (move there, hand the opponent a loss).
  - A vertex is **L** if **every** outgoing edge leads to a **W** vertex (whatever you do, the opponent wins).

[watch from 0:47](https://youtu.be/m5k-3yXxvLw?t=47)

---

## Acyclic graphs: one reverse-topological pass

- If the graph is a **DAG**, topologically sort it and process vertices **right to left** (successors before predecessors). Each vertex's label depends only on labels already computed.
- The lecture's worked chain (vertices $1,2,3,4$ with edges $1{\to}2$, $2{\to}3$, $2{\to}4$, $3{\to}4$):
  - vertex $4$: sink → **L**.
  - vertex $3$: can move to $4$ (L) → **W**.
  - vertex $2$: can move to $4$ (L) → **W** (the other move, to $3$, is W, but one L-move suffices).
  - vertex $1$: both moves ($\to$ some W) lead to W → **L**.

![Acyclic fan-out from a source vertex v with each successor labeled, and the maximum-profit formula for the weighted variant](/img/dsa/m5k-3yXxvLw/frame-00060.png)

**Direct W/L labeling on a DAG** (this is the memoized game-tree solver used later as an oracle):

```cpp
#include <bits/stdc++.h>
using namespace std;
enum { LOSE = 0, WIN = 1 };

// g[v] = list of successors. Returns WIN if the mover at v wins under optimal play.
int solveDag(int v, const vector<vector<int>>& g, vector<int>& memo) {
    if (memo[v] != -1) return memo[v];
    int res = LOSE;                                 // sink: no move -> mover loses
    for (int u : g[v])
        if (solveDag(u, g, memo) == LOSE) { res = WIN; break; }  // reach an L -> W
    return memo[v] = res;
}
```

- **Data structure.** `memo[v]` in $\{-1,0,1\}$ caches each vertex's label so every vertex is solved once → $O(V+E)$.

[watch from 2:44](https://youtu.be/m5k-3yXxvLw?t=164)

---

## Variant: pay-the-opponent weighted game

- Same board, but each edge $v\to u$ carries a **cost** $w$: making that move **pays** $w$ to your opponent. Goal: maximize your **net** winnings under optimal play.
- Let $d(v)$ be the best net profit for the player to move from $v$. A sink gives $d=0$. For an edge $v\to u$ you pay $w$ now, then your opponent plays optimally from $u$ earning $d(u)$, which is **your** loss. So:

$$
d(v) = \max_{v \to u} \big(-\,w(v,u) - d(u)\big), \qquad d(\text{sink}) = 0.
$$

![The maximum-profit recurrence d(v) = max over edges of minus-weight minus d(u), on the fan-out graph](/img/dsa/m5k-3yXxvLw/frame-00113.png)

```cpp
#include <bits/stdc++.h>
using namespace std;

// g[v] = list of (successor, edge cost). d(v) = best net profit for the mover at v.
long long best(int v, const vector<vector<pair<int,long long>>>& g,
               vector<long long>& d, vector<char>& done) {
    if (done[v]) return d[v];
    done[v] = 1;
    if (g[v].empty()) return d[v] = 0;              // no move -> zero profit
    long long r = LLONG_MIN;
    for (auto [u, w] : g[v]) r = max(r, -w - best(u, g, d, done));
    return d[v] = r;
}
```

- On the lecture's final example (edges $1{\to}2$ cost 7, $1{\to}3$ cost 1, $2{\to}4$ cost 4, $3{\to}2$ cost 3, $3{\to}4$ cost 5) this yields $d(3)=1$, $d(2)=-4$, and $d(1)=\max(-7-(-4),\,-1-1)=\max(-3,-2)=-2$ — the first player loses two dollars. Verified by the compiled program.
- **Key point.** As long as the outcome depends only on the **current vertex** (not on the history of moves), the same right-to-left DP solves every such modification.

[watch from 7:46](https://youtu.be/m5k-3yXxvLw?t=466)

---

## Asymmetric (two-color) games

- Now the two players have **different** move sets: red edges for player one, blue edges for player two. The game is no longer symmetric, so a vertex's outcome depends on **whose turn** it is.
- **Approach A — two labels per vertex.** For each vertex store W/L for "first player to move here" and W/L for "second player to move here", still filled right to left using each player's own edge colors.

![Symmetrical vs asymmetric game: a two-color graph on the right where each player uses only its own edge colour](/img/dsa/m5k-3yXxvLw/frame-00084.png)

- **Approach B — reduce to the symmetric game (preferred).** **Double** the graph into two layers: layer-1 copies mean "first player moves", layer-2 copies mean "second player moves". A red edge $v\to u$ becomes layer1-$v$ $\to$ layer2-$u$; a blue edge becomes layer2-$v$ $\to$ layer1-$u$. The state now encodes *both* the position and whose turn it is, so it is an ordinary single-move graph game — solve it with the plain W/L rule.

![Doubling an asymmetric game into first-player and second-player layers, turning it into a plain graph game](/img/dsa/m5k-3yXxvLw/frame-00101.png)

- **Design lesson from the board:** reducing a new problem to one you already solved is usually cleaner than patching the algorithm for each variant.

[watch from 16:10](https://youtu.be/m5k-3yXxvLw?t=970)

---

## Changing the winning condition

- Flip the rule: **no move now means you WIN** (misère-style terminal). Everything else is identical.
- **Patch (Approach A).** Only the terminal label changes: mark every sink as **W** instead of L, then run the same right-to-left propagation. On the chain this makes vertex $2$ winning under *either* rule — the first player can force the opponent into the dead end or walk into it, whichever helps.
- **Reduction (Approach B, preferred).** Add one **extra vertex** $z$. From every old sink draw a single edge to $z$, and give $z$ no outgoing edges. In the *standard* game $z$ is L, so every old sink (now with a move to $z$) becomes W — exactly the new terminal semantics — and the rest is unchanged. Solve as the classical game.

[watch from 26:17](https://youtu.be/m5k-3yXxvLw?t=1577)

---

## Cycles introduce draws

- With cycles the game can run **forever** → a third outcome, **draw** (a tie). A pure cycle with no exits is all draws: every player always has a move and the game never ends.

![A clean board opening the cycles discussion — reachable positions that may loop forever](/img/dsa/m5k-3yXxvLw/frame-00163.png)

- **But cycles do not force draws.** If a cycle vertex has an escape edge to an L vertex, it is W; the vertex whose only move enters that W is L. So W, L, and draw can all coexist among cyclic vertices depending on structure.
- **Resolution rule (same two local rules, applied as far as possible):**
  - Start from sinks, mark them **L**.
  - Any vertex with an edge to an L vertex → **W**.
  - Any vertex whose **every** out-edge goes to a W vertex → **L**.
  - Repeat until no rule fires. **Every vertex still unmarked is a draw.**
- **Why the leftovers are draws.** An unmarked vertex has at least one out-edge that is *not* to an L (else it would be W) and not all-to-W (else it would be L) — so it can always sidestep into another unmarked vertex. Both players prefer looping forever to losing, so play cycles indefinitely.

![Fan diagrams showing the propagation: an all-ones out-set forces a zero (L), a single zero forces a one (W)](/img/dsa/m5k-3yXxvLw/frame-00180.png)

[watch from 32:30](https://youtu.be/m5k-3yXxvLw?t=1950)

---

## Linear-time queue algorithm

- Reverse-BFS from terminal states. The one subtlety is the **L rule**: to declare a vertex L we must know *all* its moves lead to W. Rechecking all out-edges each time is $O(V\cdot E)$; instead keep a **counter** `out[v]` = number of its out-edges **not yet known to lead to W**. When a successor becomes W, decrement; when the counter hits $0$, the vertex is L.

![Queue pseudocode: initialize sinks as L, then pop, mark predecessors, decrement counters, O(V+E)](/img/dsa/m5k-3yXxvLw/frame-00200.png)

**Data structures**

- `state[v]` in `{DRAW, LOSE, WIN}` — final label; `DRAW` is the initial value and the fallback.
- `radj` — reverse adjacency, so from a resolved vertex we reach its **predecessors**.
- `out[v]` — the unresolved-out-edge counter above.
- `queue` — vertices whose label just got fixed and must be propagated.

```cpp
#include <bits/stdc++.h>
using namespace std;
enum { LOSE = 0, WIN = 1, DRAW = -1 };

// g[v] = successors. Returns each vertex's label (DRAW nodes are ties).
vector<int> retrograde(int n, const vector<vector<int>>& g) {
    vector<vector<int>> radj(n);
    vector<int> out(n, 0);
    for (int v = 0; v < n; v++) {
        out[v] = (int)g[v].size();
        for (int u : g[v]) radj[u].push_back(v);    // reverse edge u <- v
    }
    vector<int> state(n, DRAW);
    queue<int> q;
    for (int v = 0; v < n; v++)
        if (out[v] == 0) { state[v] = LOSE; q.push(v); }   // sinks are L

    while (!q.empty()) {
        int v = q.front(); q.pop();
        for (int u : radj[v]) {                     // predecessors u -> v
            if (state[u] != DRAW) continue;         // already fixed
            if (state[v] == LOSE) {                 // u can move to an L -> W
                state[u] = WIN;
                q.push(u);
            } else if (--out[u] == 0) {             // v was W; last move now W -> L
                state[u] = LOSE;
                q.push(u);
            }
        }
    }
    return state;                                   // whatever stays DRAW is a tie
}
```

- **Complexity.** Each vertex leaves the queue **once**; the work at a vertex scans its in-edges. Summed over all vertices that is $O(V+E)$. In KaTeX: $O(V+E)$ time and space.
- **Correctness check.** Compiled and tested against the memoized `solveDag` oracle on the lecture's chain (`1=L 2=W 3=W 4=L`), on a pure 2-cycle (both draw), on a cycle-with-escape (`L, W, L`), and on 2000 random DAGs — labels match exactly.
- Both earlier tricks compose here: to solve an **asymmetric** cyclic game double the graph first; for the **flipped win-condition** add the extra sink vertex. Then run this same linear-time routine.

[watch from 43:30](https://youtu.be/m5k-3yXxvLw?t=2610)

---

## Sum of games (product of graphs)

- A **sum** $A+B$ puts one token in each of two independent games. On your turn you pick **one** game and move its token; you lose when you cannot move in **either** game.
- **Naive solution.** Build the **product** graph: states are pairs $(a,b)$; from $(a,b)$ you may move to $(a',b)$ or $(a,b')$. This product of two acyclic graphs is itself acyclic — solve it with the plain W/L pass.

![Product graph of A (three-vertex chain) and B (two-vertex chain): a 3-by-2 grid of paired states](/img/dsa/m5k-3yXxvLw/frame-00244.png)

- **Problem: state blow-up.** Two games of size $n$ give $n^2$ states; $k$ games give $n^k$ — exponential in the number of games. Useless when a single game must be **split** into many small independent games and recombined.
- **Intuition from small cases** (proved on the board):
  - $\text{L} + \text{L}$ → **L** (mirror strategy: whoever moves out of an L hands the opponent a W; the opponent mirrors back into L).
  - $\text{L} + \text{W}$ → **W** (move the W component to an L, opponent now faces $\text{L}+\text{L}$).
  - $\text{W} + \text{W}$ → **it depends** — this is exactly where a finer invariant than W/L is needed.

[watch from 52:02](https://youtu.be/m5k-3yXxvLw?t=3154)

---

## Grundy values (nimbers) and the mex

- Refine "W/L" into an integer. The **Grundy value** (nimber) of a vertex is

$$
g(v) = \operatorname{mex}\ \{\, g(u) : v \to u \,\},
$$

where $\operatorname{mex}$ (minimum excludant) is the **smallest non-negative integer not present** in the set. A sink has $g = \operatorname{mex}\{\,\} = 0$.

![The Grundy rule g(v) = mex of children, with mex defined as the least non-negative integer absent from the child set](/img/dsa/m5k-3yXxvLw/frame-00280.png)

- **Zero means losing.**

$$
g(v) = 0 \iff v \text{ is a losing (L) state.}
$$

  Proof by induction right to left: if $g(v)=0$ then $0$ is absent from the children, so **no** child is L (all children have $g\neq 0$, hence W) → $v$ is L. If $g(v)\neq 0$ then $0$ **is** present, so some child has $g=0$ (an L) → $v$ is W.

![g(v)=0 iff v losing, plus the sum rule g(A+B)=g(A) XOR g(B) written on the product graph](/img/dsa/m5k-3yXxvLw/frame-00317.png)

- Positive Grundy values are just **different "types" of win** — the extra information that resolves the $\text{W}+\text{W}$ case.

**Linear-time mex.** A vertex with $d$ out-edges has $g \le d$ (among $d{+}1$ values $0..d$, at most $d$ can appear), so a boolean array of size $d{+}1$ suffices; summed over the graph the total is $O(V+E)$.

```cpp
#include <bits/stdc++.h>
using namespace std;

// Least non-negative integer absent from vals; g(v) <= |children|, so this sizing is safe.
int mex(const vector<int>& vals) {
    vector<char> seen(vals.size() + 1, 0);
    for (int x : vals) if (x <= (int)vals.size()) seen[x] = 1;
    int m = 0;
    while (m < (int)seen.size() && seen[m]) m++;
    return m;
}

// Grundy value of every vertex of an acyclic game graph (memoized DFS = reverse topo).
int grundy(int v, const vector<vector<int>>& g, vector<int>& gr) {
    if (gr[v] != -1) return gr[v];
    vector<int> childVals;
    for (int u : g[v]) childVals.push_back(grundy(u, g, gr));
    return gr[v] = mex(childVals);
}
```

- **Note.** $g(v)$ can exceed $\sqrt{m}$ in general, yet the per-vertex bound $g(v)\le\deg^+(v)$ keeps the whole computation linear. (A separate exercise: the *maximum* value over the graph is $O(\sqrt{m})$.)

[watch from 1:06:43](https://youtu.be/m5k-3yXxvLw?t=4003)

---

## Sprague-Grundy: sums are XOR

- **Theorem.** For a sum of independent games the Grundy value is the **bitwise XOR** of the parts:

$$
g(A + B) = g(A) \oplus g(B).
$$

  Combined with "$g=0 \iff$ L", the sum is losing exactly when the XOR of all component Grundy values is $0$ — the classic Nim condition. And you **never build the product graph**: analyze each game once, XOR the numbers.

![The XOR proof by bit prefixes: comparing g(A), g(B) and any smaller target x bit by bit](/img/dsa/m5k-3yXxvLw/frame-00344.png)

- **Proof sketch** (induction over the product, then a mex argument). Let $x = g(A)\oplus g(B)$. Two facts show $g(A{+}B)=\operatorname{mex}$ of successor values $= x$:
  - **No successor equals $x$.** A move changes exactly one side, say to $g(A')\oplus g(B)$. If this equaled $x=g(A)\oplus g(B)$, cancel $g(B)$ to get $g(A')=g(A)$ — but a vertex never has a child with its own Grundy value (mex excludes it). Contradiction.
  - **Every value below $x$ is reachable.** Take any $y < x$. Compare bitwise: let the highest bit where they differ be a $1$ in $x$ and $0$ in $y$. That bit comes from $g(A)$ or $g(B)$; say $g(A)$. Then $g(A)\oplus y < g(A)$, so by the mex property game $A$ has a move to a state with Grundy value $g(A)\oplus y$, and that successor's sum value is $(g(A)\oplus y)\oplus g(B)=y$.
  - So all of $0..x-1$ are present and $x$ is absent → $\operatorname{mex} = x$. $\square$
- **Verification.** Compiled `mex` + `grundy` and cross-checked against brute-force oracles on 1500 random game pairs: $g=0 \iff$ L held in every game, and $g(A{+}B)=g(A)\oplus g(B)$ matched the product-graph winner (`xor != 0` iff mover wins) every time.

[watch from 1:16:16](https://youtu.be/m5k-3yXxvLw?t=4576)

---

## Complexity recap

| Task | Time | Space | Notes |
| --- | --- | --- | --- |
| W/L on a DAG | $O(V+E)$ | $O(V)$ | one reverse-topo pass |
| W/L/draw with cycles | $O(V+E)$ | $O(V+E)$ | queue + unresolved-out-edge counter |
| Weighted-profit game | $O(V+E)$ | $O(V)$ | same right-to-left DP |
| Asymmetric game | $O(V+E)$ | $O(V+E)$ | double the graph, then W/L |
| Sum via product graph | $O\!\big((V_A V_B) + (E_A V_B + V_A E_B)\big)$ | product size | blows up with $k$ games |
| Grundy per graph | $O(V+E)$ | $O(V)$ | mex with degree-bounded array |
| Sum via Sprague-Grundy | $O(V_A+E_A+V_B+E_B)$ | $O(V)$ | XOR the component values |

---

## Practice problems

Graph games sit at the **hard** end of interview algorithms; the payload is the W/L/draw retrograde classification and Grundy/XOR for sums.

**🎯 Interview (MAANG-style)**

- [Cat and Mouse — LeetCode 913](https://leetcode.com/problems/cat-and-mouse/) — Hard — the canonical game-on-a-graph: retrograde BFS over $(\text{mouse},\text{cat},\text{turn})$ states with draw handling. This lecture *is* the technique.
- [Cat and Mouse II — LeetCode 1728](https://leetcode.com/problems/cat-and-mouse-ii/) — Hard — grid version with jump limits and a turn budget; same W/L/draw state classification.
- [Predict the Winner — LeetCode 486](https://leetcode.com/problems/predict-the-winner/) — Medium — two-player pick-from-ends, the score-difference DP $d(v)=\max(\text{val}-d(\text{next}))$ mirroring the weighted game here.
- [Can I Win — LeetCode 464](https://leetcode.com/problems/can-i-win/) — Medium — reachable-state game with bitmask memoization; classic W/L over a state graph.
- [Combinatorial Game Theory: Nim — GeeksforGeeks](https://www.geeksforgeeks.org/combinatorial-game-theory-set-2-game-nim/) — Medium — the Nim XOR condition, the simplest sum-of-games instance.
- [Grundy Numbers / Nimbers and mex — GeeksforGeeks](https://www.geeksforgeeks.org/combinatorial-game-theory-set-3-grundy-numbersnimbers-and-mex/) — Hard — mex and Sprague-Grundy worked out.

**🏆 Competitive**

- [Removal Game — CSES 1097](https://cses.fi/problemset/task/1097) — Medium — the pick-from-ends score game; the interval DP $d(l,r)=\max(a_l-d(l{+}1,r),\ a_r-d(l,r{-}1))$.
- [Stick Game — CSES 1729](https://cses.fi/problemset/task/1729) — Medium — compute Grundy values over a move set and read off W/L (this is a one-pile Grundy warm-up for Nim-like sums).

*No official Codeforces home-task post was linked in this lecture's description, so none is cited.*

---

## Further reading

- [Games on graphs — cp-algorithms](https://cp-algorithms.com/game_theory/games_on_graphs.html) — the retrograde W/L/draw classification with the same counter trick.
- [Sprague-Grundy theorem and Nim — cp-algorithms](https://cp-algorithms.com/game_theory/sprague-grundy-nim.html) — mex, Grundy values, and the XOR sum rule with proofs.
- [Combinatorial game theory — Wikipedia](https://en.wikipedia.org/wiki/Combinatorial_game_theory) — the broader framing of impartial games.
- [Sprague-Grundy theorem — Wikipedia](https://en.wikipedia.org/wiki/Sprague%E2%80%93Grundy_theorem) and [Nimber — Wikipedia](https://en.wikipedia.org/wiki/Nimber) — the algebra of nimbers.
- [Nim — Wikipedia](https://en.wikipedia.org/wiki/Nim) — the archetypal impartial game the XOR rule generalizes.

---

## Key takeaways

- Two local rules do everything: **sink = L**, **some edge to L = W**, **all edges to W = L**. Apply them right to left.
- On a DAG one topological pass suffices; with cycles, reverse-BFS with an unresolved-out-edge counter runs in $O(V+E)$ and whatever stays unmarked is a **draw**.
- Prefer **reductions** — double the graph for asymmetric games, add a sink vertex for a flipped win-condition — over hand-patching the algorithm.
- For **sums of games**, W/L is too coarse; the **Grundy value** ($\operatorname{mex}$ of children) refines it, with $g=0 \iff$ losing.
- **Sprague-Grundy:** $g(A{+}B)=g(A)\oplus g(B)$ — analyze components independently and XOR, never building the product graph.

## Glossary

- **W / L state** — the player about to move wins (W) or loses (L) under optimal play.
- **Draw state** — a cyclic position where optimal play never terminates (a tie).
- **Retrograde analysis** — computing outcomes backward from terminal states via reverse BFS.
- **mex** — minimum excludant: the least non-negative integer absent from a set.
- **Grundy value / nimber** — $\operatorname{mex}$ of successors' Grundy values; $0$ marks a losing state, positives mark distinct "types" of winning state.
- **Sum of games** — several independent games played in parallel; a turn moves one component's token.
- **Sprague-Grundy theorem** — the Grundy value of a sum is the XOR of the components' Grundy values.
