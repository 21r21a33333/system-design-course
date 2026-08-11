---
title: "S01E09 · Fibonacci Heap"
sidebar_position: 9
description: Priority queues beyond the binary heap — binomial heaps as a warm-up, then Fibonacci heaps with O(1) insert/merge, O(1) amortized decrease-key via cascading cuts, O(log n) extract-min via consolidation, and the potential-function proof that pins it all down.
---

# S01E09 · Fibonacci Heap

> **Source:** Pavel Mavrin, [_A&DS S01E09_](https://youtu.be/Dt3LDjl4jEc) · 1h40m lecture → ~16 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- A **heap** supports `add`, `extract-min`, and — the interesting extras — `merge` (unite two heaps) and `decrease_key` (lower an existing element's key via a pointer to it, only ever downward: $y < x$).
- **Binomial heap** = a forest of **binomial trees** $B_k$ (each $B_k$ has $2^k$ nodes, root degree $k$, and is two copies of $B_{k-1}$ fused). All three core ops run in $\Theta(\log n)$.
- **Fibonacci heap** relaxes the binomial structure into a *lazy* forest: `add` and `merge` become **$O(1)$** (just splice into the root list); the bill is deferred.
- **extract-min** pays the deferred bill: move the min's children up, then **consolidate** (merge equal-rank roots through a bucket array) so ranks are distinct again → **$O(\log n)$ amortized**.
- **decrease-key** cuts the node out to the root list; if its parent was already marked, **cascading cuts** propagate upward → **$O(1)$ amortized**.
- The whole amortized argument rides on one **potential function** $\Phi = (\text{number of trees}) + 2\cdot(\text{number of marked nodes})$, and on the fact that a Fibonacci tree of rank $k$ has $\ge F_{k+2}$ nodes, forcing **max rank $= O(\log n)$**.

---

## What a heap must do, and why decrease-key matters

- The four operations on the board, with binary-heap costs beside them:

| Operation | Meaning | Binary heap |
| --- | --- | --- |
| `add(x)` | insert a new element | $O(\log n)$ |
| `extract_min()` | remove and return the smallest | $O(\log n)$ |
| `merge(H1, H2)` | unite two heaps into one | $O(n)$ rebuild / $O(n \log n)$ by re-insertion |
| `decrease_key(x, y)` | given a pointer to node `x`, lower its key to `y` (requires $y < x$) | $O(\log n)$ |

- **A note on the merge cost.** On tape Pavel calls the re-insertion merge "something like log square" and immediately hedges ("but it's not… it's widely used"). Dumping the smaller heap's elements into the larger one is really $O(n \log n)$ (one $O(\log n)$ insert per element), or $O(n)$ if you throw both arrays together and re-heapify from scratch — there is no $O(\log^2 n)$ merge for a binary heap. The point stands: a plain binary heap has no *cheap* merge, which is exactly what the Fibonacci heap fixes.
- **`decrease_key` never raises a key** — it only lowers it. That one-directional constraint is exactly what graph algorithms need.
- **Why care so much about `decrease_key`?** In Dijkstra / Prim you keep, per vertex, its best-known tentative distance in the queue. Relaxing an edge only ever *lowers* that distance. Fast `decrease_key` is what turns Dijkstra into $O(E + V\log V)$ — the headline application, covered in the graph lectures.
- The lecturer's honest caveat, up front: Fibonacci heaps are **not usually implemented in practice** — the constant factor is too large, so a binary heap wins on real inputs. Their value is **theoretical**. We still build one because the amortized reasoning is the point.

![Board title with the four heap operations (add, remove-min, merge, decrease-key) and the decrease-key picture y &lt; x](/img/dsa/Dt3LDjl4jEc/frame-00034.png)

[watch from 0:24](https://youtu.be/Dt3LDjl4jEc?t=24)

---

## Warm-up: binomial trees

- Before Fibonacci heaps we build the simpler **binomial heap**, which is easier to reason about and sets up every idea we reuse.
- A **binomial tree** $B_k$ is defined recursively:
  - $B_0$ = a single node.
  - $B_k$ = a root whose children are $B_0, B_1, \dots, B_{k-1}$ (one subtree of each smaller rank).
- Equivalent view: $B_k$ = two copies of $B_{k-1}$, with one root becoming a child of the other. Both descriptions produce the same shape.
- **Key counts** (read straight off the recursion):
  - $B_k$ has exactly $2^k$ nodes.
  - The root of $B_k$ has exactly $k$ children (its **rank** = root degree).
  - Height is $k$.

![Binomial trees B0, B1, B2, B3 … Bk, showing Bk as a root with children B0…B(k-1), and Bk built from two copies of B(k-1)](/img/dsa/Dt3LDjl4jEc/frame-00050.png)

- **Rank** here just means "root degree" — a label we track per node. (It is *not* subtree height; that distinction becomes important for Fibonacci trees.)

[watch from 5:53](https://youtu.be/Dt3LDjl4jEc?t=353)

---

## Building a binomial heap

- A **binomial heap** = a **forest** of binomial trees, each with the min-heap property (every node $\le$ its children), and **all of distinct rank**.
- Because $B_k$ holds $2^k$ nodes, a heap of $n$ elements uses exactly the trees whose ranks are the set bits of $n$. For $n = 11 = 8 + 2 + 1$: one $B_3$, one $B_1$, one $B_0$.
- **Why distinct ranks?** Two trees of the same rank $k$ can always be fused into one $B_{k+1}$, lowering the tree count. Minimizing the number of trees ⇒ all ranks distinct ⇒ at most $\lceil\log_2 n\rceil + 1$ trees.
- So the two structural invariants are:
  1. **All roots have different ranks.**
  2. **Number of trees $\le \log_2 n + 1$** (since each rank is $\le \log_2 n$).

![A binomial heap of n = 11 = 8 + 2 + 1 elements: a B3, a B1 and a B0, each satisfying the min-heap property](/img/dsa/Dt3LDjl4jEc/frame-00109.png)

- **Fusing two equal-rank trees is $O(1)$.** Compare the two roots; the larger root becomes a child of the smaller. To append a child in $O(1)$, store each node's **children as a linked list** with a pointer to the tail — appending is a couple of pointer writes.

```cpp
struct Node {
    long long key;
    int rank = 0;                    // = number of children
    vector<Node*> children;          // linked list in practice; vector here for clarity
    Node* parent = nullptr;
    bool mark = false;               // used later by the Fibonacci heap
    Node(long long k): key(k) {}
};

// Fuse two trees of equal rank into one of rank+1. O(1). Returns the new root.
Node* link(Node* a, Node* b) {
    if (b->key < a->key)
        swap(a, b);                  // a is the smaller root, becomes parent
    b->parent = a;
    a->children.push_back(b);        // O(1) append with a tail pointer
    a->rank += 1;
    return a;
}
```

[watch from 11:12](https://youtu.be/Dt3LDjl4jEc?t=672)

---

## Binomial heap: add, merge, extract-min

- **`add(x)`** — wrap `x` as a lone $B_0$, then carry-propagate: while a tree of the current rank already exists, `link` them (rank goes up by one) and repeat. This is **binary addition** with trees as bits ⇒ $O(\log n)$.
- **`merge(H1, H2)`** — exactly like merging two sorted lists by rank, then resolving carries. Walk both root lists in rank order; whenever two trees share a rank, `link` them (a carry may itself collide with the next rank — up to three same-rank trees can meet at once).

```cpp
// h1, h2: lists of roots kept sorted by rank. Returns merged root list.
vector<Node*> merge_binomial(const vector<Node*>& h1, const vector<Node*>& h2) {
    vector<Node*> merged;
    size_t i = 0, j = 0;
    while (i < h1.size() || j < h2.size()) {           // like merging two sorted arrays
        if (j >= h2.size() || (i < h1.size() && h1[i]->rank <= h2[j]->rank)) {
            merged.push_back(h1[i]); i++;
        } else {
            merged.push_back(h2[j]); j++;
        }
    }
    // second pass: fuse any adjacent equal-rank trees (carry resolution)
    vector<Node*> result;
    for (Node* t : merged) {
        while (!result.empty() && result.back()->rank == t->rank) {
            Node* u = result.back(); result.pop_back();
            t = link(u, t);
        }
        result.push_back(t);
    }
    return result;                                     // O(log n) trees, O(log n) work
}
```

- **`extract_min()`** — the min is always some **root** (heap property). Remove it; its children $B_0, B_1, \dots, B_{k-1}$ already form a valid binomial heap $H'$. `merge` the leftover forest with $H'$, then scan the $O(\log n)$ roots for the new minimum.

```cpp
pair<long long, vector<Node*>> extract_min_binomial(vector<Node*> roots) {
    int m = 0;
    for (int i = 1; i < (int)roots.size(); i++)
        if (roots[i]->key < roots[m]->key) m = i;
    Node* minroot = roots[m];
    roots.erase(roots.begin() + m);
    vector<Node*> childrens_heap(minroot->children);   // already a heap: ranks 0..k-1, distinct
    for (Node* c : childrens_heap)
        c->parent = nullptr;
    sort(childrens_heap.begin(), childrens_heap.end(),
         [](Node* a, Node* b) { return a->rank < b->rank; });
    roots = merge_binomial(roots, childrens_heap);
    return {minroot->key, roots};                      // O(log n)
}
```

- **`decrease_key`** in a binomial heap is dull: lower the key and **sift up** toward the root, at most height $= O(\log n)$ swaps. (Fibonacci heaps exist precisely to beat this $\log n$.)

![Merging two binomial heaps H1 and H2 like two sorted arrays, resolving equal-rank collisions by linking](/img/dsa/Dt3LDjl4jEc/frame-00164.png)

- **Binomial heap scorecard:** `add`, `merge`, `extract_min`, `decrease_key` all $\Theta(\log n)$.

[watch from 33:04](https://youtu.be/Dt3LDjl4jEc?t=1984)

---

## The Fibonacci plan: get lazy

- **Goal:** push three operations below $\log n$ — down to **$O(1)$ amortized** — and accept that `extract_min` stays $O(\log n)$ (some operation must, or we could sort in linear time).
- The single idea: **do work only when you are forced to.** Keep the heap sloppy (many trees, repeated ranks allowed) and only clean up during `extract_min`, which has to walk the roots anyway.
- **`add(x)`** — create a one-node tree, splice it into the root list, update the `min` pointer if needed. No carry propagation. **$O(1)$.**
- **`merge(H1, H2)`** — concatenate the two root lists (linked lists!), keep whichever `min` pointer is smaller. **$O(1)$.**

```cpp
struct FibHeap {
    vector<Node*> roots;                     // the forest's top level (a linked list in practice)
    Node* min_node = nullptr;                // pointer to the current minimum root
};

Node* add(FibHeap& H, long long x) {
    Node* node = new Node(x);
    H.roots.push_back(node);                 // splice into root list, O(1)
    if (H.min_node == nullptr || x < H.min_node->key)
        H.min_node = node;
    return node;                             // caller keeps this pointer for decrease_key
}

FibHeap& merge(FibHeap& H1, FibHeap& H2) {
    for (Node* r : H2.roots)                 // concatenate linked lists, O(1)
        H1.roots.push_back(r);
    if (H2.min_node && (H1.min_node == nullptr || H2.min_node->key < H1.min_node->key))
        H1.min_node = H2.min_node;
    return H1;
}
```

- The catch: after many lazy `add`s you may hold $n$ separate one-node trees. Finding the *next* min after removing one is then $\Theta(n)$ — unless we clean up. That cleanup is `extract_min`, and its cost is what the potential function will amortize away.

![Operation summary on the board: add O(1), remove-min O(log n), merge O(1), decrease-key O(1) — the last three marked "amortized"](/img/dsa/Dt3LDjl4jEc/frame-00220.png)

[watch from 49:31](https://youtu.be/Dt3LDjl4jEc?t=2971)

---

## Extract-min with consolidation

- **Steps** when removing the minimum (we hold a pointer to it):
  1. Remove the min root; **promote its children** into the root list ($O(1)$ with linked lists).
  2. **Consolidate**: walk all roots and fuse equal-rank trees until every rank is unique.
  3. Scan the surviving $O(\log n)$ roots to set the new `min`.
- **Consolidate uses a bucket array** indexed by rank. For each root, if its rank's bucket is occupied, `link` the two (producing rank $+1$), carry into the next bucket, and repeat — the same carry logic as binomial `add`, but run once over the whole messy forest.

```cpp
void consolidate(FibHeap& H) {
    unordered_map<int, Node*> bucket;        // rank -> root
    for (Node* t : vector<Node*>(H.roots)) {
        t->parent = nullptr;
        while (bucket.count(t->rank)) {      // collision: fuse and carry up
            Node* u = bucket[t->rank];
            bucket.erase(t->rank);
            t = link(t, u);                  // rank increases by 1
        }
        bucket[t->rank] = t;
    }
    H.roots.clear();                         // now all ranks distinct
    H.min_node = nullptr;
    for (auto& kv : bucket) {
        H.roots.push_back(kv.second);
        if (H.min_node == nullptr || kv.second->key < H.min_node->key)
            H.min_node = kv.second;
    }
}

long long extract_min(FibHeap& H) {
    Node* z = H.min_node;
    for (Node* c : z->children) {            // promote children to root list
        c->parent = nullptr;
        H.roots.push_back(c);
    }
    H.roots.erase(find(H.roots.begin(), H.roots.end(), z));
    if (!H.roots.empty())
        consolidate(H);                      // the deferred bill is paid here
    else
        H.min_node = nullptr;
    return z->key;
}
```

- The bucket array during a real consolidation — roots stream in, equal ranks collide, buckets $0,1,2,3,\dots$ fill up until every rank is unique:

![The consolidate step: an array of buckets indexed 0,1,2,3, each holding at most one root as equal-rank trees get fused](/img/dsa/Dt3LDjl4jEc/frame-00244.png)

[watch from 52:12](https://youtu.be/Dt3LDjl4jEc?t=3132)

---

## The potential method for extract-min

- **Amortized cost** of an operation is defined as
$$
\tilde{T} = T + \Delta\Phi,
$$
where $T$ is the real cost and $\Phi$ is a **potential** (a non-negative "savings account") that is a function of the data structure's state. Summed over a sequence, the $\Delta\Phi$ terms telescope, so total amortized cost bounds total real cost (up to the initial potential).
- **First attempt** (just for `extract_min`): let $\Phi = (\text{number of trees})$.
- Say consolidation starts with $m$ trees. The real work is $T = \Theta(m)$ — we touch every root. Afterward, distinct ranks force $\le \log n$ trees, so
$$
\Delta\Phi = (\log n) - m .
$$
- Adding them:
$$
\tilde{T} = T + \Delta\Phi = m + (\log n - m) = \log n .
$$
The linear $m$ **cancels** — that is the whole trick. A single expensive consolidation is "pre-paid" by all the cheap `add`s that inflated the tree count.
- Consistency check on the cheap operations: `add` creates one tree, so $\Delta\Phi = +1$, giving $\tilde{T} = O(1)$; `merge`'s concatenation leaves the tree count unchanged, $\Delta\Phi = 0$. Both stay $O(1)$ amortized. 

![The amortized identity T̃ = T + ΔΦ = log n, with Φ = number of trees and the before/after (m trees → log n trees) picture](/img/dsa/Dt3LDjl4jEc/frame-00293.png)

[watch from 63:27](https://youtu.be/Dt3LDjl4jEc?t=3807)

---

## Fibonacci trees: relaxing the shape for fast decrease-key

- **Problem with binomial trees:** they are *rigid* — a $B_k$ always looks identical. You cannot pluck a subtree out without breaking the structure, so `decrease_key` is stuck at $\log n$ (sift up).
- **Fix:** use a looser tree family. In a **Fibonacci tree** of rank $k$, the root still has $k$ children, but the child ranks need only satisfy a *lower bound*, not an equality:
$$
\text{the } i\text{-th child (in attach order) has rank} \ge i-1, \quad i = 1,\dots,k .
$$
So child ranks are $\ge 0, \ge 1, \ge 2, \dots, \ge k-1$ — looser than the binomial "exactly $0,1,\dots,k-1$". This flexibility lets us cut and re-attach subtrees cheaply.
- **Marks.** Each node may **lose at most one child**. A node that has lost one child gets a **mark** ($k^{*}$). A rank-$k$ node with a mark therefore has $k-1$ children but still *remembers* it "should" have had rank $k$. Losing a second child is forbidden — that triggers a cut of the node itself.
- **Rank $\ne$ depth.** Here **rank is just a number stored per node** (roughly its child count), deliberately decoupled from subtree height. Two children can even share a rank.

![A valid Fibonacci heap: nodes annotated with ranks and marks (starred), with the note "ranks ≤ log n"](/img/dsa/Dt3LDjl4jEc/frame-00356.png)

- **Why the mark distinction matters — the size bound.** Because a rank-$k$ node's children have ranks $\ge 0, \ge 1, \dots, \ge k-2$ (allowing one lost child), the *minimum* number of nodes $S_k$ in a rank-$k$ tree satisfies a Fibonacci-style recurrence:
$$
S_k \ge S_{k-1} + S_{k-2}, \qquad S_k \ge F_{k+2} \ge \varphi^{k},
$$
where $\varphi = \frac{1+\sqrt5}{2}$. Inverting: a tree of rank $k$ has $\ge \varphi^k$ nodes, so
$$
k \le \log_\varphi n = O(\log n) .
$$
That is the origin of the name **Fibonacci** heap, and it guarantees consolidation's bucket array stays $O(\log n)$ wide. (Mavrin leaves the exact recurrence as an exercise; the bound is what you need.)

![Fibonacci tree rank rule: children ranks ≥ 0, ≥ 1, … ≥ k-1, and the marked variant K* that has lost one child](/img/dsa/Dt3LDjl4jEc/frame-00300.png)

[watch from 68:14](https://youtu.be/Dt3LDjl4jEc?t=4094)

---

## Decrease-key with cascading cuts

- **The move.** Lower `x`'s key. If it now violates the heap property against its parent, **cut** `x`'s whole subtree out and splice it into the root list (its mark is cleared — roots are never marked).
- **Cascade.** Cutting `x` removed a child from its parent `p`:
  - If `p` was **unmarked**, mark it and stop.
  - If `p` was **already marked** (it had lost a child before), it is now losing a *second* child — not allowed. So **cut `p` too**, move it to the root list, and recurse on `p`'s parent. This chain of cuts is the **cascading cut**; it climbs until it reaches an unmarked node (which it marks) or a root.

```cpp
// Detach x's subtree, move it to the root list, clear its mark.
void cut(FibHeap& H, Node* x, Node* parent) {
    parent->children.erase(find(parent->children.begin(), parent->children.end(), x));
    parent->rank -= 1;
    x->parent = nullptr;
    x->mark = false;
    H.roots.push_back(x);
}

void cascading_cut(FibHeap& H, Node* node) {
    Node* p = node->parent;
    if (p == nullptr)
        return;                              // already a root, nothing to do
    if (!p->mark)
        p->mark = true;                      // first lost child: just mark it
    else {
        cut(H, p, p->parent);                // second lost child: cut p too...
        cascading_cut(H, p);                 // ...and cascade upward
    }
}

void decrease_key(FibHeap& H, Node* x, long long new_key) {
    assert(new_key < x->key);                // decrease only
    x->key = new_key;
    Node* p = x->parent;
    if (p != nullptr && x->key < p->key) {   // heap property broken
        cut(H, x, p);
        cascading_cut(H, p);
    }
    if (x->key < H.min_node->key)
        H.min_node = x;
}
```

- Every function called above (`cut`, `cascading_cut`, `link`, `Node`) is defined here or earlier — the `decrease_key` block is self-contained.

![Cascading cut: node x cut to the root list, then marked ancestors A, …, up the chain are cut in turn; T̃ = T + ΔΦ with Φ = trees + 2·marked nodes](/img/dsa/Dt3LDjl4jEc/frame-00388.png)

[watch from 85:13](https://youtu.be/Dt3LDjl4jEc?t=5113)

---

## The full potential function and the O(1) proof

- A single `decrease_key` can cut a whole chain of $k$ marked ancestors, so its **real cost is $T = k + 1$** — potentially large. We need the potential to *drop* by about $k$ to cancel it.
- **Upgrade the potential** to cover both `extract_min` and `decrease_key` with one formula:
$$
\Phi = (\text{number of trees}) + 2\cdot(\text{number of marked nodes}).
$$
- **Accounting for one `decrease_key`** that cascades through $k$ marked nodes:
  - Those $k$ marked nodes get cut and become **unmarked roots**: marks fall by $k$ → $\Delta\Phi_{\text{marks}} = -2k$.
  - We add $k+1$ new trees to the root list (the $k$ cut ancestors + the original node): $\Delta\Phi_{\text{trees}} = +(k+1)$.
  - The node where the cascade stops gains one new mark: $\Delta\Phi_{\text{marks}} = +2$.
  - Total: $\Delta\Phi = (k+1) - 2k + 2 = 3 - k$.
- **Amortized cost:**
$$
\tilde{T} = T + \Delta\Phi = (k+1) + (3 - k) = 4 = O(1) .
$$
The $k$ cancels — cascading cuts are **free in amortized terms**.
- **Accounting method (the coin picture Mavrin draws):** give each **mark 2 coins** and each **root 1 coin**. When a node earns its mark, stash 2 coins on it. Later, when the cascade cuts that node, use 1 coin to move it to the root list and leave 1 coin on it as a root — every future cut is pre-funded. No operation ever runs short.
- Why the factor **2** on marks: one coin pays the cut work; the other funds the node's new life as a root. With coefficient 1 the books would not balance.

- **This one potential serves the whole structure.** For it to be valid, every operation must respect it: `add` ($+1$ tree), `merge` ($0$), `extract_min` (trees drop to $O(\log n)$, marks only fall), and `decrease_key` (just shown). All stay within budget.

[watch from 91:09](https://youtu.be/Dt3LDjl4jEc?t=5469)

---

## Complexity recap

Amortized bounds for the Fibonacci heap, with binary and binomial heaps for contrast:

| Operation | Binary heap | Binomial heap | **Fibonacci heap** |
| --- | --- | --- | --- |
| `add` | $O(\log n)$ | $O(\log n)$ | $O(1)$ amortized |
| `merge` | $O(n)$ | $O(\log n)$ | $O(1)$ amortized |
| `decrease_key` | $O(\log n)$ | $O(\log n)$ | $O(1)$ amortized |
| `extract_min` | $O(\log n)$ | $O(\log n)$ | $O(\log n)$ amortized |
| `find_min` | $O(1)$ | $O(\log n)$ | $O(1)$ |
| Space | $O(n)$ | $O(n)$ | $O(n)$ |

- The Fibonacci row is **amortized**, i.e. worst case over a *sequence*, not per single operation — a lone `extract_min` can be $\Theta(n)$, but a run of them averages to $O(\log n)$.
- **Constant factors are large**, so in practice a binary heap usually wins; the table above is a theoretical guarantee, not a benchmark.

---

## Practice problems

**Reality check:** Fibonacci heaps are **essentially never coded in an interview or a contest** — the constant factor kills them and a binary heap is simpler. Their entire payoff is theoretical: they give Dijkstra its $O(E + V\log V)$ bound. So the problems below drill the *use* of a priority queue (a binary heap is fine for all of them) and the amortized-thinking muscle, not the Fibonacci implementation itself.

**🎯 Interview (MAANG-style)**

- [Network Delay Time — LeetCode 743](https://leetcode.com/problems/network-delay-time/) — Medium — textbook Dijkstra with a priority queue; a binary heap suffices, `decrease_key` is faked by "lazy deletion" (push duplicates, skip stale pops).
- [Cheapest Flights Within K Stops — LeetCode 787](https://leetcode.com/problems/cheapest-flights-within-k-stops/) — Medium — Dijkstra/Bellman-Ford hybrid on a bounded-hop shortest path; heap-ordered frontier.
- [Path With Minimum Effort — LeetCode 1631](https://leetcode.com/problems/path-with-minimum-effort/) — Medium — Dijkstra where the edge relaxation minimizes a max-of-path; same priority-queue skeleton.
- [Find Median from Data Stream — LeetCode 295](https://leetcode.com/problems/find-median-from-data-stream/) — Hard — a *contrast* problem: two binary heaps balancing a stream, to keep the heap toolkit sharp.
- [Fibonacci Heap — GeeksforGeeks](https://www.geeksforgeeks.org/fibonacci-heap-set-1-introduction/) — reference — the one place you would actually read/write the structure; use it to check your `decrease_key` mental model.

> One-line note: in all of the Dijkstra problems above, a standard binary heap with lazy deletion is the practical choice — the Fibonacci heap only changes the asymptotic bound, not the accepted-solution reality.

**🏆 Competitive**

- [Shortest Routes I — CSES 1671](https://cses.fi/problemset/task/1671) — Easy/Med — single-source shortest paths, the canonical Dijkstra-with-heap task.
- [Flight Discount — CSES 1195](https://cses.fi/problemset/task/1195) — Medium — Dijkstra on a layered/state graph, heavy on priority-queue relaxations.
- [Official home tasks & discussion — Codeforces](https://codeforces.com/blog/entry/84598) — the problem set Pavel assigned for this lecture (linked from the video description; binomial/Fibonacci-heap and heap-application tasks).

---

## Further reading

- [Fibonacci heap — Wikipedia](https://en.wikipedia.org/wiki/Fibonacci_heap) — full operation set, the $\Phi = t + 2m$ potential, and the $F_{k+2}$ size proof.
- [Binomial heap — Wikipedia](https://en.wikipedia.org/wiki/Binomial_heap) — the warm-up structure with clean merge diagrams.
- [Fibonacci Heap — GeeksforGeeks](https://www.geeksforgeeks.org/fibonacci-heap-set-1-introduction/) and [Binomial Heap — GeeksforGeeks](https://www.geeksforgeeks.org/binomial-heap-2/) — worked implementations.
- [Dijkstra on sparse graphs — cp-algorithms](https://cp-algorithms.com/graph/dijkstra_sparse.html) — where fast `decrease_key` pays off, and why a binary heap with lazy deletion is used in practice instead.

---

## Key takeaways

- **Be lazy, then pay once.** Fibonacci heaps make `add`/`merge` trivial ($O(1)$) and defer all cleanup to `extract_min`'s consolidation.
- **Consolidate = binomial carry on the whole forest** via a rank-indexed bucket array; it restores distinct ranks and costs $O(\log n)$ amortized because the potential $\Phi = \text{trees}$ cancels the linear scan.
- **Cascading cuts** make `decrease_key` $O(1)$ amortized: cut the node out, and if its parent was already marked, cut upward until you hit an unmarked node.
- **One potential rules them all:** $\Phi = (\text{trees}) + 2\cdot(\text{marks})$ balances both consolidation and cascading cuts.
- **Fibonacci trees** trade the rigid binomial shape for lower-bounded child ranks; the $\ge F_{k+2}$ size bound keeps max rank at $O(\log n)$.
- **Theory, not practice.** Great asymptotics, bad constants — a binary heap wins in real code; the win shows up only in Dijkstra's $O(E + V\log V)$ analysis.

## Glossary

- **Rank** — a number stored per node, roughly its child count (root degree); here decoupled from subtree height.
- **Root list** — the forest's top level, held as a linked list so splicing and concatenation are $O(1)$.
- **Mark** — a flag meaning "this node has already lost one child"; losing a second triggers a cut.
- **Cascading cut** — the upward chain of cuts triggered when a marked node loses a second child during `decrease_key`.
- **Consolidate** — the `extract_min` sweep that fuses equal-rank roots through a bucket array until all ranks are distinct.
- **Potential function $\Phi$** — a non-negative state function whose change amortizes real cost; here $\Phi = \text{trees} + 2\cdot\text{marks}$.
- **Amortized cost** — $\tilde{T} = T + \Delta\Phi$; a worst-case average over a sequence of operations, not a per-operation worst case.
