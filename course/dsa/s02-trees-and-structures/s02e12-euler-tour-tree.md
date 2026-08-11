---
title: "S02E12 · Euler Tour Tree & Tarjan's Algorithm"
sidebar_position: 12
description: Represent a dynamic forest by its Euler tour in a balanced BST for link/cut/connectivity, flatten a static tree to in/out times for subtree queries, and solve offline LCA with Tarjan's DSU sweep.
---

# S02E12 · Euler Tour Tree & Tarjan's Algorithm

> **Source:** Pavel Mavrin, [_A&DS S02E12_](https://youtu.be/sdad8cFarHA) · 1h08m lecture → ~15 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- An **Euler tour** writes down the sequence of edges (and vertices) visited by a walk that doubles every edge of a tree. It linearizes a tree into a list.
- **Euler Tour Tree (ETT)** stores that list in a balanced BST (splay tree or treap). Then a forest's `link`, `cut`, and per-tree aggregate all become $O(\log n)$ **split**/**merge** operations on the tour.
- `link(u, v)` splices two tours together; `cut(u, v)` snips out the middle segment. The trick is finding *where* to split — solved by keeping, for each vertex and edge, a **direct pointer** to its BST node.
- A separate, simpler use of the same idea: for a **static** tree, record entry/exit times $tin$/$tout$ by DFS. A subtree becomes a **contiguous range**, so subtree-sum reduces to a segment tree — the interview-favourite "Euler tour technique".
- **Tarjan's offline LCA** answers a whole batch of $(u, v)$ ancestor queries in one DFS using a **DSU**: total cost $\Theta\big((n + m)\,\alpha(n)\big)$ — practically linear, and faster in practice than the fancy constant-time methods.

---

## The problem: a dynamic forest

- We are given a **forest** — several undirected trees, no fixed root, no parent/child direction. We want three operations:
  - `link(u, v)` — add an edge joining two vertices in **different** trees, merging them into one.
  - `cut(u, v)` — remove an existing edge, splitting one tree into two.
  - `calc(v)` — evaluate an associative function (sum, min, …) over **all nodes of the tree that contains $v$**.
- A Link-Cut Tree can also do this, but `calc` over a whole subtree is awkward there because LCT aggregates along *paths*. The Euler Tour Tree is a much simpler structure for whole-tree aggregates.
- Because the tree is unrooted, the function must be **commutative/associative** — we do not control the order in which nodes appear.

![Unrooted forest with link(u,v), cut(u,v) and calc(v) = sum of val(u) over u in tree(v) written on the board](/img/dsa/sdad8cFarHA/frame-00037.png)

The board's running example: a star at vertex 3 with leaves 1, 5, 2, 6 and 5–4 attached, whose Euler tour of edges reads `13 35 53 36 64 46 63 32 23 31`.

[watch from 1:13](https://youtu.be/sdad8cFarHA?t=73)

---

## Euler tour of a tree

- Root the walk anywhere (say vertex 1). Walk the tree, and **every time you traverse an edge, write it down**. Since a DFS enters and leaves each subtree once, every edge is written **twice** — once in each direction. This is exactly the Euler tour used earlier for LCA.
- For the board tree the edge sequence is:

```text
1→3   3→5   5→3   3→6   6→4   4→6   6→3   3→2   2→3   3→1
```

- That list of $2(n-1)$ directed edges **is** the representation of the tree. Everything else is list surgery.
- Key structural fact used everywhere below: the tour of any **subtree** is a **contiguous segment** of the parent's tour. When you first step onto edge $u\!\to\!v$ you enter $v$'s subtree; you leave it exactly when you step back on $v\!\to\!u$. Everything between those two occurrences is the subtree's own tour.

[watch from 6:19](https://youtu.be/sdad8cFarHA?t=379)

---

## Cut = split the tour, reconnect the outside

- To `cut` edge $(3, 6)$: locate the two occurrences $3\!\to\!6$ and $6\!\to\!3$ in the tour.
- The segment **strictly between** them is the Euler tour of the detached subtree (the part hanging below 6).
- The **remaining** tour of the big tree is the **prefix before $3\!\to\!6$ concatenated with the suffix after $6\!\to\!3$** — both ends meet at vertex 3, so they join cleanly.
- Concretely, splitting the example tour at those two edges gives:
  - Outer tree: `1→3 3→5 5→3` ++ `3→2 2→3 3→1`
  - Inner tree: `6→4 4→6` (the tour rooted at 6)
- So `cut` is: two **splits** to isolate the middle, discard the two boundary edges, then **merge** the two outer pieces.

[watch from 8:20](https://youtu.be/sdad8cFarHA?t=500)

---

## Link = split both tours, splice four pieces

- To `link(u, v)` where $u$ and $v$ live in different trees: take tour $A$ (containing $u$) and tour $B$ (containing $v$).
- **Reroot each tour** at the joining vertex, i.e. rotate the cyclic tour so it *starts* at $u$ (resp. $v$). On a splay/treap tour this is one split-then-merge: cut at the vertex's position and swap the two halves.
- Then build the merged tour as:

$$
\text{tour}(u) \;+\; (u\!\to\!v) \;+\; \text{tour}(v) \;+\; (v\!\to\!u)
$$

- On the board this is drawn as **four segments** reassembled: the head of $A$, the new edge, all of $B$'s tour, then the new reverse edge, then the tail of $A$ — every split point is a place we already have a pointer to.

![Link of two trees, one on vertices 1-3-5-2 and one on vertices 5-4-6: the resulting Euler tour is assembled from four tour segments plus the two new edges 3-6 and 6-3](/img/dsa/sdad8cFarHA/frame-00104.png)

[watch from 17:39](https://youtu.be/sdad8cFarHA?t=1059)

---

## Where do we split? Pointers, not searches

- The only non-trivial part is **finding the split positions in $O(\log n)$**. Searching the tour by value would be too slow.
- The clean solution shown on the board: **enrich the tour with vertex-occurrences**. Besides the $2(n-1)$ edges, insert one node per vertex (any single occurrence of it). The example tour becomes seven elements instead of four: `1  1→3  3  3→2  2  2→3  3→1`.
- Keep two pointer tables (drawn as class fields):
  - `Vertex` → its BST `Node` (one chosen occurrence in the tour).
  - `Edge` → its BST `Node`.
- To split at a vertex, follow its pointer straight to the treap node, walk parents to compute its position, and split there — no map lookups, no scanning.

![Board class sketch: Vertex holds a Node pointer, Edge holds a Node pointer, and each tour list is actually a splay tree](/img/dsa/sdad8cFarHA/frame-00132.png)

![Enriched Euler tour carrying both edge-occurrences and vertex-occurrences, e.g. 1 13 3 22 2 23 31, so every vertex has a known position](/img/dsa/sdad8cFarHA/frame-00150.png)

- **Cut caveat.** For `cut(u, v)` you must know which of the two occurrences, $u\!\to\!v$ or $v\!\to\!u$, comes first in the tour. Split at one of them, then test **which side** holds the other (splay/search it), and branch on the two cases. This is the single fiddly `if` in an otherwise tiny implementation.

[watch from 23:12](https://youtu.be/sdad8cFarHA?t=1392)

---

## Implementation: Euler Tour Forest on a treap

The lecture uses splay trees; a **treap** with an *implicit key* (position) gives the same $O(\log n)$ split/merge and is shorter to write. Each treap node is one tour element; vertex-occurrences carry the vertex value, edge-occurrences carry the neutral element $0$. The whole-tree sum is just the treap root's aggregate.

```cpp
#include <bits/stdc++.h>
using namespace std;

struct Node {
    int key;          // vertex id for vertex-nodes, -1 for edge-nodes
    long long val;    // vertices carry val, edges carry 0 (neutral element)
    long long sum;    // aggregate of val over this treap subtree
    int pri, sz;
    Node *l, *r, *par;
    Node(int k, long long v) : key(k), val(v), sum(v), pri(rand()), sz(1),
        l(nullptr), r(nullptr), par(nullptr) {}
};

int  sz(Node* t){ return t ? t->sz  : 0; }
long long sm(Node* t){ return t ? t->sum : 0; }

void upd(Node* t){
    if(!t) return;
    t->sz  = 1 + sz(t->l) + sz(t->r);
    t->sum = t->val + sm(t->l) + sm(t->r);
    t->par = nullptr;
    if(t->l) t->l->par = t;
    if(t->r) t->r->par = t;
}

// first k nodes -> a, the rest -> b (implicit key = position)
void splitBySize(Node* t, int k, Node*& a, Node*& b){
    if(!t){ a = b = nullptr; return; }
    if(sz(t->l) < k){ a = t; splitBySize(t->r, k - sz(t->l) - 1, a->r, b); upd(a); }
    else            { b = t; splitBySize(t->l, k, a, b->l);                 upd(b); }
}
Node* merge(Node* a, Node* b){
    if(!a) return b;
    if(!b) return a;
    if(a->pri > b->pri){ a->r = merge(a->r, b); upd(a); return a; }
    else               { b->l = merge(a, b->l); upd(b); return b; }
}

// position (0-indexed) of x inside its treap, by walking to the root
int position(Node* x){
    int pos = sz(x->l);
    for(Node* c = x; c->par; c = c->par)
        if(c == c->par->r) pos += sz(c->par->l) + 1;
    return pos;
}
Node* root(Node* x){ while(x->par) x = x->par; return x; }

struct EulerTourForest {
    int n;
    vector<Node*> vnode;                 // vnode[v] = tour node holding vertex v
    map<pair<int,int>, Node*> enode;     // enode[(a,b)] = tour node for edge a->b

    void init(int n_, const vector<long long>& val){
        n = n_; vnode.resize(n);
        for(int v = 0; v < n; v++) vnode[v] = new Node(v, val[v]);
    }
    // rotate v's tour so it begins exactly at v's occurrence
    void reroot(int v){
        int p = position(vnode[v]);
        Node *A, *B;
        splitBySize(root(vnode[v]), p, A, B);   // B starts at v
        merge(B, A);                            // B first, then A
    }
    bool connected(int u, int v){ return root(vnode[u]) == root(vnode[v]); }

    void link(int u, int v){                    // u, v in different trees
        reroot(u); reroot(v);
        Node* tu = root(vnode[u]);
        Node* tv = root(vnode[v]);
        Node* euv = new Node(-1, 0); enode[{u,v}] = euv;
        Node* evu = new Node(-1, 0); enode[{v,u}] = evu;
        merge(merge(merge(tu, euv), tv), evu);  // tour(u)+u→v+tour(v)+v→u
    }
    void cut(int u, int v){                      // (u,v) must be an edge
        reroot(u);                               // tour = [ u ... u→v ... v→u ... ]
        int pa = position(enode[{u,v}]);
        int pb = position(enode[{v,u}]);
        if(pa > pb) swap(pa, pb);
        Node *A, *B, *C, *D, *E, *whole = root(vnode[u]);
        splitBySize(whole, pa, A, B);            // A = prefix before first edge
        splitBySize(B, 1, B, C);                 // drop first edge occurrence (B)
        splitBySize(C, pb - pa - 1, D, E);       // D = inner tour, E = second edge + tail
        splitBySize(E, 1, E, C);                 // drop second edge occurrence (E)
        merge(A, C);                             // outer tree = prefix ++ tail; inner = D
        enode.erase({u,v}); enode.erase({v,u});
    }
    long long treeSum(int v){ return sm(root(vnode[v])); }  // calc(v)
};
```

- **Data structure & invariants.** One treap per tree; in-order position = tour order; each node's `sum` is the aggregate over its treap subtree, so the root holds the whole tree's aggregate. `vnode`/`enode` give $O(1)$ access to any split point.
- **Verified.** Compiled with `c++ -std=c++17` and stress-tested against a BFS brute force over thousands of random `link`/`cut`/`connected`/`treeSum` sequences — all agreed.

[watch from 37:08](https://youtu.be/sdad8cFarHA?t=2228)

---

## calc(v): read the aggregate off the tree's BST

- Because each tree is exactly **one** splay/treap, evaluating the tree function is trivial: it is the aggregate already stored at that treap's root.
- If values live on **vertices**, put the real value on vertex-occurrences and the neutral element ($0$ for sum, $+\infty$ for min) on edge-occurrences; each vertex is counted once. If values live on **edges**, swap the roles.
- The flagship application (sketched, not coded, in lecture): **dynamic connectivity**. Maintain a spanning forest with ETT; two vertices are connected iff they share a treap root. On deleting a tree edge you must hunt for a replacement non-tree edge — that is the harder layer on top.

[watch from 39:58](https://youtu.be/sdad8cFarHA?t=2398)

---

## The static shortcut: flatten to in/out times

- For a **static rooted** tree, you do not need a balanced BST at all. One DFS records an **entry time** $tin[v]$ and **exit time** $tout[v]$.
- Because DFS fully finishes a subtree before backtracking, the subtree of $v$ occupies the **contiguous range** $[\,tin[v],\ tout[v]\,)$ of the flattened order.
- So "sum/min/max over the subtree of $v$" becomes a **range query** over an array indexed by entry time — answered by a segment tree or Fenwick tree in $O(\log n)$, with point updates too. This is the interview-relevant "Euler tour technique".

```cpp
#include <bits/stdc++.h>
using namespace std;

struct EulerFlatten {                 // flatten a static rooted tree
    int n, timer = 0;
    vector<vector<int>> children;
    vector<int> tin, tout;            // subtree of v = positions [tin[v], tout[v])
    void init(int n_){ n = n_; children.assign(n, {}); tin.assign(n,0); tout.assign(n,0); }
    void dfs(int v){
        tin[v] = timer++;
        for(int c : children[v]) dfs(c);
        tout[v] = timer;              // half-open interval
    }
};

struct SegTree {                      // iterative point-update / range-sum
    int n; vector<long long> t;
    void init(int n_){ n = n_; t.assign(2*n, 0); }
    void build(const vector<long long>& a){
        for(int i = 0; i < n; i++) t[n+i] = a[i];
        for(int i = n-1; i >= 1; i--) t[i] = t[2*i] + t[2*i+1];
    }
    void update(int pos, long long val){
        for(t[pos += n] = val; pos > 1; pos >>= 1) t[pos>>1] = t[pos] + t[pos^1];
    }
    long long query(int l, int r){    // sum over [l, r)
        long long res = 0;
        for(l += n, r += n; l < r; l >>= 1, r >>= 1){
            if(l & 1) res += t[l++];
            if(r & 1) res += t[--r];
        }
        return res;
    }
};

// subtree sum of v:
//   place vertex values at flattened positions: flat[tin[v]] = val[v];
//   build the segment tree on flat;
//   answer = st.query(tin[v], tout[v]);
```

- **Verified.** Compiled and stress-tested: for random trees, mixed point-updates and subtree-sum queries matched a brute-force subtree scan on every case.

[watch from 40:38](https://youtu.be/sdad8cFarHA?t=2438)

---

## Tarjan's offline LCA (via DSU)

- **What this segment actually covers:** Pavel returns to the earlier **lowest-common-ancestor** problem and presents **Tarjan's offline LCA algorithm**. It is *offline*: all $(u, v)$ queries must be known in advance so we may answer them in whatever order the DFS visits nodes. It is **not** the strongly-connected-components Tarjan and **not** the ETT dynamic-connectivity method — it is a single DFS plus a **Disjoint Set Union**.
- Setup: attach each query to **both** its endpoints. When the DFS later reaches the *second* endpoint of a query, the first endpoint is already visited, and its **top-of-set representative** is the answer.

![LCA problem restated: lca(u,v) with O(n) precompute, O(1) per query, and a list of queries to answer offline](/img/dsa/sdad8cFarHA/frame-00199.png)

![During the DFS, when we reach v its query partner u sits in a set whose top unmarked ancestor is exactly lca(u,v)](/img/dsa/sdad8cFarHA/frame-00216.png)

**The idea.** Run a DFS. When a node $x$ finishes (its whole subtree is done), **mark** it and **union** its set into its parent's set. The DSU representative of any finished set points at the **closest still-unmarked ancestor** — precisely the LCA of any finished node against a node being visited now.

![Finishing x unions x's whole subtree into one set; its representative's top node becomes the parent, i.e. the closest unmarked ancestor](/img/dsa/sdad8cFarHA/frame-00236.png)

```cpp
#include <bits/stdc++.h>
using namespace std;

// Tarjan's offline LCA via DSU.
struct DSU {
    vector<int> parent, ancestor;         // ancestor[find(x)] = top node of that set
    void init(int n){
        parent.resize(n); ancestor.resize(n);
        for(int i = 0; i < n; i++){ parent[i] = i; ancestor[i] = i; }
    }
    int find(int x){
        while(x != parent[x]){ parent[x] = parent[parent[x]]; x = parent[x]; }
        return x;
    }
};

struct TarjanLCA {
    int n;
    vector<vector<int>> children;
    vector<vector<pair<int,int>>> queriesAt;  // (other endpoint, query id)
    vector<bool> visited;
    vector<int> answer;
    DSU dsu;

    void init(int n_){
        n = n_;
        children.assign(n, {});
        queriesAt.assign(n, {});
        visited.assign(n, false);
        dsu.init(n);
    }
    void addQuery(int u, int v, int qid){     // list[u].add(v); list[v].add(u)
        queriesAt[u].push_back({v, qid});
        queriesAt[v].push_back({u, qid});
    }
    void go(int v){
        visited[v] = true;
        dsu.ancestor[dsu.find(v)] = v;         // v is its own top node for now
        for(auto [u, qid] : queriesAt[v])
            if(visited[u]) answer[qid] = dsu.ancestor[dsu.find(u)];  // = lca(u,v)
        for(int x : children[v]){
            go(x);
            dsu.parent[dsu.find(x)] = dsu.find(v);  // union child set into v
            dsu.ancestor[dsu.find(v)] = v;          // representative's top node = v
        }
    }
    vector<int> solve(int root, int q){
        answer.assign(q, -1);
        go(root);
        return answer;
    }
};
```

![Full board pseudocode: for each query add it to both lists, then go(v) answers marked partners with topNode(u), recurses into children, unions, and marks v — total n + m·alpha(m,n)](/img/dsa/sdad8cFarHA/frame-00266.png)

- **Verified.** Compiled with `c++ -std=c++17` and cross-checked against a depth-walk brute-force LCA over thousands of random trees and query batches — all correct.
- **Complexity.** One DFS ($\Theta(n)$) plus $m$ query touches, each a near-constant DSU operation: total $\Theta\big((n + m)\,\alpha(n)\big)$.
- **Why bother** when we already had $\langle O(n)$ precompute, $O(1)$ query$\rangle$ via sparse-table-on-blocks? Because that method carries a heavy constant and lots of code. Tarjan's is a handful of lines with tiny constants, so **in practice it is faster** — the inverse-Ackermann factor is $\le 4$ for any realistic $n$. The catch is that it is offline.
- **Bonus.** Swapping the plain DSU for the *linkable* aggregate structure from the bonus lectures lets you also compute an associative function along each root-to-ancestor path, not just the LCA vertex.

[watch from 47:00](https://youtu.be/sdad8cFarHA?t=2820)

---

## Complexity recap

| Operation | Time | Space | Notes |
| --- | --- | --- | --- |
| ETT `link` / `cut` | $O(\log n)$ | $O(n)$ | constant number of split/merge on treap |
| ETT `connected(u,v)` | $O(\log n)$ | $O(n)$ | compare treap roots |
| ETT `calc(v)` (whole tree) | $O(1)$ read / $O(\log n)$ update | $O(n)$ | aggregate at treap root |
| Flatten build ($tin$/$tout$) | $\Theta(n)$ | $O(n)$ | one DFS |
| Subtree query (flatten + segtree) | $O(\log n)$ | $O(n)$ | subtree = contiguous range |
| Tarjan offline LCA (all queries) | $\Theta\big((n+m)\,\alpha(n)\big)$ | $O(n+m)$ | one DFS + DSU, offline only |

---

## Practice problems

The **Euler tour technique** (flatten to $tin$/$tout$, then range-query) is genuinely interview-relevant. Full dynamic **Euler Tour Trees** and offline Tarjan LCA are competitive-programming topics beyond a typical interview round — the nearest interview-shaped stand-ins are subtree and LCA problems.

**🎯 Interview (MAANG-style)**

- [Smallest Missing Genetic Value in Each Subtree — LeetCode 2003](https://leetcode.com/problems/smallest-missing-genetic-value-in-each-subtree/) — Hard — subtree aggregation via a single DFS; the Euler-tour mindset (subtree = contiguous work) is exactly the setup.
- [Number of Nodes in the Sub-Tree With the Same Label — LeetCode 1519](https://leetcode.com/problems/number-of-nodes-in-the-sub-tree-with-the-same-label/) — Medium — per-subtree counts merged bottom-up; the canonical "aggregate over a subtree" pattern.
- [Lowest Common Ancestor of a Binary Tree — LeetCode 236](https://leetcode.com/problems/lowest-common-ancestor-of-a-binary-tree/) — Medium — the online single-query LCA that Tarjan's algorithm generalizes to batches.
- [Euler Tour of Tree — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/euler-tour-tree/) — Medium — build the tour itself, the foundation of every technique above.
- [Euler Tour subtree sum with segment tree — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/euler-tour-subtree-sum-using-segment-tree/) — Medium — the flatten-then-segment-tree recipe, worked end to end.

**🏆 Competitive**

- [Subtree Queries — CSES 1137](https://cses.fi/problemset/task/1137) — Medium — point-update a vertex, query subtree sum: the Euler-tour flatten technique verbatim.
- [Path Queries — CSES 1138](https://cses.fi/problemset/task/1138) — Medium — same flatten, but a root-to-node path sum via the $+/-$ difference trick on $tin$/$tout$.

> No official Codeforces home-task post is linked in this lecture's description, so none is cited here.

---

## Further reading

- [Euler tour technique — Wikipedia](https://en.wikipedia.org/wiki/Euler_tour_technique) — the general linearization idea and its uses.
- [Lowest common ancestor — Wikipedia](https://en.wikipedia.org/wiki/Lowest_common_ancestor) and [Tarjan's off-line LCA algorithm — Wikipedia](https://en.wikipedia.org/wiki/Tarjan%27s_off-line_lowest_common_ancestors_algorithm).
- [Lowest Common Ancestor with Tarjan's offline algorithm — cp-algorithms](https://cp-algorithms.com/graph/lca_tarjan.html) — the DSU sweep in full.
- [Segment tree — cp-algorithms](https://cp-algorithms.com/data_structures/segment_tree.html) — the range-query engine behind the flatten technique.
- [Euler path and circuit — cp-algorithms](https://cp-algorithms.com/graph/euler_path.html) — the graph-theoretic Euler walk this tour is named after.

---

## Key takeaways

- An **Euler tour turns a tree into a list**; storing that list in a balanced BST turns tree edits into $O(\log n)$ split/merge.
- ETT `link`/`cut` are just: reroot at the joining vertex, then splice or snip — the only real work is finding split points, solved by **direct node pointers**, not searches.
- For **static** trees, skip the BST: DFS $tin$/$tout$ makes every subtree a **contiguous range**, so subtree queries become segment-tree range queries.
- **Tarjan's offline LCA** answers a whole batch of ancestor queries in one DFS with a DSU in near-linear time — simpler and often faster than online constant-time LCA, at the cost of needing all queries up front.

## Glossary

- **Euler tour (of a tree)** — the sequence of edges (and optionally vertices) visited by a walk that traverses every edge twice, once in each direction.
- **Euler Tour Tree (ETT)** — a balanced BST holding a tree's Euler tour, supporting `link`/`cut`/aggregate in $O(\log n)$.
- **Euler tour technique** — flatten a static tree to $tin$/$tout$ times so each subtree is a contiguous array range.
- **Treap** — a randomized BST keyed by an implicit position, supporting split and merge in expected $O(\log n)$.
- **DSU (union-find)** — disjoint-set structure with near-constant $\alpha(n)$ operations, here tracking merged subtrees.
- **Offline query** — a query known in advance, so the algorithm may reorder answers; contrasts with online queries answered one at a time.
- **$\alpha(n)$** — the inverse Ackermann function; $\le 4$ for every practical input size.
