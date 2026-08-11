---
title: "S02E05 · Binary Search Tree & AVL Tree"
sidebar_position: 5
description: Binary search trees as ordered sets and maps, find/insert/delete with the two-children successor swap, in-order traversal, and the AVL balancing scheme with height and balance factor, the four rotations, and an O(log n) height proof by a Fibonacci-like bound.
---

# S02E05 · Binary Search Tree & AVL Tree

> **Source:** Pavel Mavrin, [_A&DS S02E05_](https://youtu.be/OCQh0ZVFhrg) · 1h28m lecture → ~16 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- A **binary search tree (BST)** stores comparable keys so that for every node $x$, all keys in its left subtree are $<x$ and all keys in its right subtree are $>x$. In-order traversal then yields the keys **sorted**.
- **find / insert / delete** all walk one root-to-node path, so each costs $\Theta(h)$ where $h$ is the tree height. There is never a branching search — at each node you know which single child to descend into.
- **Deleting a node with two children** is the only subtle case: replace its key with its in-order **successor** (the minimum of the right subtree), then delete that successor, which has at most one child.
- A plain BST can degenerate to a path with $h=\Theta(n)$. **AVL** keeps it balanced by an invariant: at every node the two subtree heights differ by at most one, i.e. $\lvert h_L - h_R\rvert \le 1$.
- That single invariant forces $h \le 2\log_2 n$. The proof: the **minimum** node count $F(h)$ of an AVL tree of height $h$ satisfies $F(h)=1+F(h-1)+F(h-2)$ — a Fibonacci-like recurrence that grows like $\varphi^h$, so $n$ grows exponentially in $h$.
- After each insert/delete you walk back up recomputing heights and, at the first out-of-balance node, apply one of **four rotations** — LL, RR (single) or LR, RL (double) — to restore the invariant in $O(1)$.

---

## What a BST is: sets and maps

- A BST is the workhorse behind ordered **set** and **map** abstractions:
  - **Set** — `add(k)`, `remove(k)`, `contains(k)`.
  - **Map** — `put(k, v)`, `get(k)`: a key-to-value association.
- You can already build sets and maps with **hash tables**. So why a BST?
  - Hash tables are typically faster ($O(1)$ expected) and simpler when you only need the three basic operations.
  - A BST is more **powerful**: it keeps keys in sorted order, so it also answers order queries a hash table cannot — "closest key to $x$", predecessor/successor, range sums (covered at the end).
- Requirement: keys must be **comparable** — you need a way to decide $x < y$ (numbers compare directly; strings compare lexicographically; general objects need a comparator).
- **BST ordering invariant:** for a node holding key $x$, every key in the left subtree is $< x$ and every key in the right subtree is $> x$. This differs from a binary heap, where both children are simply $\ge$ the parent with no left/right ordering.

![Board: the set and map operations, the ordering rule that the left subtree is less than x and the right subtree is greater than x, and the example tree rooted at 10](/img/dsa/OCQh0ZVFhrg/frame-00036.png)

- **Running example** used throughout: root $10$; left child $5$ (whose left child is $1$); right child $25$ (children $13$ and $32$, with $13$ carrying a right child $28$). In-order this reads $1, 5, 10, 13, 25, 28, 32$ — sorted.

[watch from 1:19](https://youtu.be/OCQh0ZVFhrg?t=79)

---

## find: searching for a key

- Start at the root and compare. If the target $k$ equals the node key, done. If $k$ is smaller, the key can only be in the **left** subtree; if larger, only in the **right**. Recurse into that one child.
- Searching for $13$: at $10$ go right (bigger), at $25$ go left (smaller), reach $13$ — found.
- Searching for a missing key like $2$: at $10$ go left, at $5$ go left, at $1$ go right, hit an empty child — so $2$ is not present. Reaching a null pointer is exactly the "not found" signal.
- Each step drops one level, so `find` visits at most $h+1$ nodes: $\Theta(h)$.

The node type and the search, as the lecturer wrote it (Java-style objects on the board; here as idiomatic C++):

```cpp
#include <bits/stdc++.h>
using namespace std;

struct Node {
    int key;
    Node *left = nullptr, *right = nullptr;
    Node(int k) : key(k) {}
};

// return the node whose key == k, or nullptr if absent
Node* find(Node* x, int k) {
    if (x == nullptr) return nullptr;      // empty subtree: k not here
    if (x->key == k)  return x;            // found
    if (k < x->key)   return find(x->left,  k);
    else              return find(x->right, k);
}
```

![Board: the find(x, k) pseudocode returning null on an empty subtree, x on a match, and recursing left or right; alongside the Node class with key, left, right](/img/dsa/OCQh0ZVFhrg/frame-00082.png)

- **Implementation note (from the lecture):** for competitive programming, instead of many small heap-allocated node objects you can index nodes by integer and store `int key[]`, `int left[]`, `int right[]` as parallel arrays — far more cache-friendly. The logic is identical; only the representation changes.

[watch from 6:58](https://youtu.be/OCQh0ZVFhrg?t=418)

---

## insert: adding a key

- Adding a key reuses the search: walk down as if searching for $k$; when you fall off the tree into an empty slot, put the new node there.
- Adding $18$: at $10$ go right, at $25$ go left, at $13$ go right — that child is empty, so $18$ becomes the new right child of $13$.
- The clean recursive form has each call **return the (possibly new) root** of its subtree, and the parent re-links to it. That "return the new root" pattern is what later lets AVL rebalance on the way back up.

```cpp
// insert k into the subtree rooted at x; return the subtree's new root
Node* insert(Node* x, int k) {
    if (x == nullptr) return new Node(k);       // empty: make a one-node tree
    if (k < x->key)      x->left  = insert(x->left,  k);
    else if (k > x->key) x->right = insert(x->right, k);
    // k == x->key: already present, do nothing
    return x;                                    // root of this subtree unchanged
}
```

![Board: the add(18) walk down the example tree into the empty right child of 13, with the height marker H on the right edge](/img/dsa/OCQh0ZVFhrg/frame-00056.png)

- Cost: one root-to-leaf descent, $\Theta(h)$.

[watch from 19:07](https://youtu.be/OCQh0ZVFhrg?t=1147)

---

## delete: removing a key

- Removing a node is the trickiest of the three, because of what to do with its subtrees.
- **Case split on the number of children of the target node $x$:**
  - **No children** — just detach it.
  - **One child** — splice the node out; its single child takes its place.
  - **Two children** — the interesting case below.
- **Two-children delete via the successor.** Find the node's in-order **successor** $y$: the **minimum** of its right subtree, reached by going right once then left as far as possible. Copy $y$'s key up into $x$, then delete $y$ from the right subtree. Because $y$ is a leftmost node, $y$ has **no left child**, so deleting it falls into the easy one-child / no-child case.
- Why this preserves order: the successor is the smallest key still larger than everything in the left subtree and smaller than everything else in the right subtree — exactly the key that may legally sit where $x$ was.

![Board: removing an element with two subtrees b and c, finding the minimal element y in the right subtree and moving it up in place of x](/img/dsa/OCQh0ZVFhrg/frame-00103.png)

```cpp
Node* find_min(Node* x) {          // leftmost node = minimum key
    while (x->left) x = x->left;
    return x;
}

// erase key k from the subtree rooted at x; return the new subtree root
Node* erase(Node* x, int k) {
    if (x == nullptr) return nullptr;
    if (k < x->key)      x->left  = erase(x->left,  k);
    else if (k > x->key) x->right = erase(x->right, k);
    else {                                     // found the node to delete
        if (x->left  == nullptr) { Node* r = x->right; delete x; return r; }
        if (x->right == nullptr) { Node* l = x->left;  delete x; return l; }
        Node* succ = find_min(x->right);       // in-order successor
        x->key   = succ->key;                  // move successor key up
        x->right = erase(x->right, succ->key); // delete it (has no left child)
    }
    return x;
}
```

- Cost: down to $x$, then down to the successor — still bounded by two root-to-leaf paths, $\Theta(h)$.

**In-order traversal** gives the keys in sorted order and is the standard way to dump or validate a BST (left subtree, then node, then right subtree):

```cpp
void inorder(Node* x, vector<int>& out) {
    if (!x) return;
    inorder(x->left, out);
    out.push_back(x->key);
    inorder(x->right, out);
}
```

For the example tree after inserting $18$ and erasing $25$, this prints `1 5 10 13 18 28 32` — still sorted, as it must be.

[watch from 22:12](https://youtu.be/OCQh0ZVFhrg?t=1332)

---

## Why height matters, and the degenerate case

- All three operations cost $\Theta(h)$. So the whole game is keeping $h$ small.
- **Worst case:** insert $1, 2, 3, \ldots, n$ in order. Every new key is larger than all existing keys, so the tree becomes a single right-leaning path — $h = n-1 = \Theta(n)$. Now find/insert/delete are $\Theta(n)$, no better than a linked list.
- **Best case:** a perfectly balanced tree has $h = \Theta(\log n)$.
- We cannot keep the tree **perfectly** balanced under updates — a single insert could force reshuffling the whole tree. Instead we keep it **approximately** balanced: guarantee $h \le c\cdot\log n$ for some constant $c$. That is enough to make every operation $O(\log n)$.

[watch from 27:34](https://youtu.be/OCQh0ZVFhrg?t=1654)

---

## The AVL invariant and its height bound

- **AVL invariant:** at **every** node, the heights of its two subtrees differ by at most one:

$$
\lvert h_L - h_R \rvert \le 1 .
$$

Here height is measured as the longest root-to-leaf edge count within the subtree (an empty subtree has height $0$).

![Board: the AVL balance condition that the absolute difference of left and right subtree heights is at most one, holding at every node, with a valid example tree](/img/dsa/OCQh0ZVFhrg/frame-00215.png)

- An AVL tree need not look pretty — it is not perfectly balanced — but the invariant alone forces logarithmic height. We want to prove $h \le c\cdot\log_2 n$.

**Proof by a Fibonacci-like lower bound on size.** Rearranging $h \le c\log_2 n$ gives $n \ge 2^{h/c} = \alpha^{\,h}$ for a constant $\alpha>1$. So it suffices to show that the **minimum** number of nodes in a height-$h$ AVL tree grows exponentially in $h$. Let $F(h)$ be that minimum.

- A height-$h$ AVL tree has a root ($1$ node) plus two AVL subtrees. To minimise the node count, one subtree has height $h-1$ (it dictates the height) and — by the AVL invariant — the other may be as small as height $h-2$. Hence

$$
F(h) = 1 + F(h-1) + F(h-2), \qquad F(0)=1,\; F(1)=2 .
$$

- This is the Fibonacci recurrence plus one. It grows exponentially. A quick lower bound: since $F(h-1) \ge F(h-2)$,

$$
F(h) \ge 2\,F(h-2) \;\Longrightarrow\; F(h) \ge \big(\sqrt{2}\big)^{\,h}.
$$

- Therefore $n \ge (\sqrt2)^h$, i.e. $h \le 2\log_2 n$. (The tight constant is $1/\log_2\varphi \approx 1.44$, using the golden ratio $\varphi=\tfrac{1+\sqrt5}{2}$; the lecture's $\sqrt2$ bound already proves logarithmic height.)

![Board: the induction F(H) = 1 + F(H minus 1) + F(H minus 2) for the minimum node count, giving n at least two to the power H over two and hence logarithmic height](/img/dsa/OCQh0ZVFhrg/frame-00187.png)

- To check the invariant cheaply, each node **stores its own subtree height**. After a local change you recompute heights only along the path back to the root — $O(\log n)$ nodes.

[watch from 37:44](https://youtu.be/OCQh0ZVFhrg?t=2264)

---

## Rotations: restructuring while preserving order

- A **rotation** changes the shape of the tree while keeping it a valid BST — same key set, same in-order sequence.
- **Right rotation** around $x$ (its left child $y$ moves up): subtrees $A, B, C$ hang off $y, x$ so that in-order order $A, x, B, y, C$ is identical before and after. A **left rotation** is the mirror image.

![Board: a rotation lifting child y above x while subtrees A, B, C keep the in-order sequence A x B y C](/img/dsa/OCQh0ZVFhrg/frame-00148.png)

- The invariant that must survive a rotation is precisely the in-order key order: $A$ keys $<x<$ $B$ keys $<y<$ $C$ keys, both before and after. Only parent/child links move.

```cpp
struct Node {
    int key;
    int h = 1;                 // subtree height; leaf = 1, empty subtree = 0
    Node *l = nullptr, *r = nullptr;
    Node(int k) : key(k) {}
};

int  height (Node* x) { return x ? x->h : 0; }
int  balance(Node* x) { return x ? height(x->l) - height(x->r) : 0; }
void update (Node* x) { x->h = 1 + max(height(x->l), height(x->r)); }

// right rotation around x: its left child y becomes the subtree root
Node* rotate_right(Node* x) {
    Node* y = x->l;
    x->l = y->r;
    y->r = x;
    update(x); update(y);      // update the demoted node x first, then y
    return y;
}

// left rotation around x: its right child y becomes the subtree root
Node* rotate_left(Node* x) {
    Node* y = x->r;
    x->r = y->l;
    y->l = x;
    update(x); update(y);
    return y;
}
```

[watch from 33:24](https://youtu.be/OCQh0ZVFhrg?t=2004)

---

## The four rebalancing cases

- A single insert or delete changes any subtree height by at most $1$, so a node can go out of balance by at most $2$: $\lvert h_L - h_R\rvert = 2$. Which rotation fixes it depends on **where** the heavy grandchild sits. Four cases, two of them mirror images:

- **RR (single left rotation).** The right subtree of $x$ is too tall **and** its own right child is the heavy one (right-right). One `rotate_left(x)` lifts the right child $y$ to the top; heights fall back into range.

![Board: the RR case, node x with right child y where y's right subtree is the heavy one, fixed by a single left rotation](/img/dsa/OCQh0ZVFhrg/frame-00237.png)

- **LL (single right rotation).** Mirror of RR: left subtree too tall, its left child heavy. One `rotate_right(x)`.

- **RL and LR (double rotation).** The heavy grandchild is on the **inside**. Example RL: $x$'s right child $y$ is too tall, but it is $y$'s **left** child $z$ that is heavy. A single rotation would not help — you first `rotate_right(y)` to convert it to the RR shape, then `rotate_left(x)`. LR is the mirror: `rotate_left` the left child, then `rotate_right(x)`. Node $z$ ends up as the new root of the subtree.

![Board: the RR-turn above and the RL-turn below, the double rotation first rotating the inner grandchild z up before the outer rotation, plus the lower_bound goal min y at least k](/img/dsa/OCQh0ZVFhrg/frame-00296.png)

- The double rotation is exactly two single rotations; implementing it as "rotate the child, then rotate the node" keeps stored heights correct automatically because each `rotate_*` calls `update`.

**Rebalance one node**, assuming its children are already valid AVL subtrees, then wire it into insert and delete:

```cpp
// restore balance at x; return the new subtree root
Node* rebalance(Node* x) {
    update(x);
    int b = balance(x);
    if (b > 1) {                        // left heavy
        if (balance(x->l) < 0)          // LR: left child is right-heavy
            x->l = rotate_left(x->l);
        return rotate_right(x);         // LL, or the finishing turn of LR
    }
    if (b < -1) {                       // right heavy
        if (balance(x->r) > 0)          // RL: right child is left-heavy
            x->r = rotate_right(x->r);
        return rotate_left(x);          // RR, or the finishing turn of RL
    }
    return x;                           // already balanced
}

Node* insert(Node* x, int k) {
    if (!x) return new Node(k);
    if (k < x->key)      x->l = insert(x->l, k);
    else if (k > x->key) x->r = insert(x->r, k);
    else return x;                      // duplicate: ignore
    return rebalance(x);                // rebalance on the way back up
}

Node* find_min(Node* x) { while (x->l) x = x->l; return x; }

Node* erase(Node* x, int k) {
    if (!x) return nullptr;
    if (k < x->key)      x->l = erase(x->l, k);
    else if (k > x->key) x->r = erase(x->r, k);
    else {
        if (!x->l) { Node* r = x->r; delete x; return r; }
        if (!x->r) { Node* l = x->l; delete x; return l; }
        Node* s = find_min(x->r);       // successor
        x->key = s->key;
        x->r   = erase(x->r, s->key);
    }
    return rebalance(x);                // rebalance on the way back up
}
```

- **Where to rebalance:** after the recursive call returns, you are walking back toward the root. At the first unbalanced node apply the matching rotation — that makes the node balanced and, because everything below is already balanced, the fix is local. Continue up; you may fix several nodes, and after reaching the root the whole tree satisfies the invariant. Each rotation is $O(1)$, and there are $O(\log n)$ nodes on the path, so an update stays $O(\log n)$.

- **Debugging tip from the lecture:** write a `validate` function that traverses the whole tree and asserts (a) the BST order and (b) the AVL height condition at every node, then call it after each operation while developing. A bug in the link-rewiring of a rotation typically produces a cycle or a wrong parent link, which this catches immediately. Here is that verifier, used as the stress-test oracle:

```cpp
// returns subtree height; aborts if BST order or AVL balance is violated
int check(Node* x, long lo, long hi) {
    if (!x) return 0;
    assert(lo < x->key && x->key < hi);       // BST ordering
    int hl = check(x->l, lo, x->key);
    int hr = check(x->r, x->key, hi);
    assert(abs(hl - hr) <= 1);                 // AVL balance
    assert(x->h == 1 + max(hl, hr));           // stored height is correct
    return 1 + max(hl, hr);
}
```

Running $200{,}000$ random interleaved inserts and deletes against a `std::set` oracle: the tree's in-order output matches the set exactly, `check` never fires, and for the final $n=2515$ keys the height is $13$, comfortably under $2\log_2 n \approx 22.6$.

[watch from 46:00](https://youtu.be/OCQh0ZVFhrg?t=2760)

---

## Bonus 1: lower_bound (closest key to the right)

- The order structure a hash table lacks: given $k$, find the **smallest key $\ge k$** — C++'s `lower_bound`. A hash table cannot do this because it only knows equality, not order.
- Walk from the root, keeping the best candidate seen:
  - If the current key is $< k$, then everything in its left subtree is also $< k$ (all worse), so go **right**.
  - Otherwise the current key is a valid candidate ($\ge k$); record it, then try to find something even smaller by going **left**.
- When you fall off the tree, the last recorded candidate is the answer (or none).

```cpp
// smallest key >= k, or nullptr if every key is < k
Node* lower_bound(Node* x, int k) {
    Node* best = nullptr;
    while (x) {
        if (x->key < k) x = x->r;               // whole left subtree too small
        else { best = x; x = x->l; }            // candidate; try smaller on the left
    }
    return best;
}
```

- On the example tree: `lower_bound(2)=5`, `lower_bound(13)=13`, `lower_bound(26)=28`, `lower_bound(50)=none`. Predecessor / upper-bound queries are symmetric. Cost $\Theta(h)=O(\log n)$.

[watch from 1:09:47](https://youtu.be/OCQh0ZVFhrg?t=4187)

---

## Bonus 2: a balanced BST as a segment tree

- Because the keys sit in sorted order left-to-right, the tree can double as a **segment tree over the sorted key sequence**. Store in each node the minimum and maximum key of its subtree (the key range it covers), plus an aggregate such as the subtree sum.
- A range query "aggregate over all keys in $[l, r]$" runs the same recursion as an array segment tree: if a node's range is fully inside $[l, r]$ add its stored aggregate and stop; if fully outside return the identity; otherwise recurse into both children.

![Board: the example tree annotated with the min-to-max key range covered by each subtree, treating the sorted keys 1 5 8 9 10 13 25 28 32 45 as segment-tree leaves](/img/dsa/OCQh0ZVFhrg/frame-00343.png)

- Only $O(\log n)$ subtrees are ever partially cut on each side, so a query is $O(\log n)$ — same argument as the array segment tree. Lazy propagation (segment updates) transfers over identically.
- The payoff over an array-backed segment tree: you can **insert and delete keys in the middle** of the ordered sequence while keeping all range queries $O(\log n)$, which a flat array cannot do. This idea reappears in later, more advanced structures.

[watch from 1:16:28](https://youtu.be/OCQh0ZVFhrg?t=4588)

---

## Complexity recap

| Operation | BST (balanced) | BST (worst) | AVL |
| --- | --- | --- | --- |
| find / contains | $\Theta(\log n)$ | $\Theta(n)$ | $\Theta(\log n)$ |
| insert | $\Theta(\log n)$ | $\Theta(n)$ | $\Theta(\log n)$ |
| delete | $\Theta(\log n)$ | $\Theta(n)$ | $\Theta(\log n)$ |
| lower_bound / successor | $\Theta(\log n)$ | $\Theta(n)$ | $\Theta(\log n)$ |
| in-order traversal | $\Theta(n)$ | $\Theta(n)$ | $\Theta(n)$ |
| range aggregate | — | — | $\Theta(\log n)$ |
| height guarantee | — | $h=\Theta(n)$ | $h \le 2\log_2 n$ |
| space | $\Theta(n)$ | $\Theta(n)$ | $\Theta(n)$ |

Every AVL update also does $O(\log n)$ height recomputations and at most $O(\log n)$ $O(1)$-cost rotations, so the bound holds.

---

## Practice problems

BST operations are **interview-core** — validation, search, insert, and the two-children delete come up constantly. Coding the **AVL rotations** by hand is rarer in interviews (library balanced trees hide them), but the balance concept and the height proof are fair game; treat rotations as competitive / systems knowledge.

**🎯 Interview (MAANG-style)**

- [Search in a Binary Search Tree — LeetCode 700](https://leetcode.com/problems/search-in-a-binary-search-tree/) — Easy — the plain `find` descent.
- [Insert into a Binary Search Tree — LeetCode 701](https://leetcode.com/problems/insert-into-a-binary-search-tree/) — Med — the "return the new subtree root" insert.
- [Delete Node in a BST — LeetCode 450](https://leetcode.com/problems/delete-node-in-a-bst/) — Med — the three delete cases, including successor swap for two children.
- [Validate Binary Search Tree — LeetCode 98](https://leetcode.com/problems/validate-binary-search-tree/) — Med — enforce the min/max order bound at every node (the `validate` idea).
- [Balanced Binary Tree — LeetCode 110](https://leetcode.com/problems/balanced-binary-tree/) — Easy — check the exact AVL height condition at every node.
- [Balance a Binary Search Tree — LeetCode 1382](https://leetcode.com/problems/balance-a-binary-search-tree/) — Med — flatten to sorted order, then rebuild balanced.
- [Convert Sorted Array to BST — LeetCode 108](https://leetcode.com/problems/convert-sorted-array-to-binary-search-tree/) — Easy — the "pick the middle" balanced build.
- [Introduction to AVL Tree — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/introduction-to-avl-tree/) — Med — the rotations and rebalancing written out in full.

**🏆 Competitive**

- [Sliding Window Median — CSES 1076](https://cses.fi/problemset/task/1076) — Hard — maintain a balanced-BST / multiset over a sliding window and read the median each step; the order-statistics use case a hash set cannot serve.

> No official Codeforces home-task post is linked in this lecture's description, so none is cited here.

---

## Further reading

- [Binary Search Tree — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/binary-search-tree-data-structure/) — operations with worked diagrams.
- [Insertion in an AVL Tree — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/insertion-in-an-avl-tree/) — the four rotation cases step by step.
- [AVL tree — Wikipedia](https://en.wikipedia.org/wiki/AVL_tree) and [Binary search tree — Wikipedia](https://en.wikipedia.org/wiki/Binary_search_tree).
- [Self-balancing binary search tree — Wikipedia](https://en.wikipedia.org/wiki/Self-balancing_binary_search_tree) — the wider family (red-black, treap, splay).
- [Treap — cp-algorithms](https://cp-algorithms.com/data_structures/treap.html) — a simpler randomized balanced BST, the usual next lecture.

---

## Key takeaways

- The BST ordering invariant (left $<$ node $<$ right) makes find/insert/delete single-path walks costing $\Theta(h)$, and in-order traversal emits sorted keys.
- Deleting a two-children node = copy up the in-order successor (right subtree's minimum), then delete that successor, which has at most one child.
- Unbalanced BSTs degrade to $\Theta(n)$; AVL enforces $\lvert h_L-h_R\rvert\le 1$ at every node, and the Fibonacci-like minimum-size recurrence $F(h)=1+F(h-1)+F(h-2)$ pins the height at $O(\log n)$.
- Rebalancing is local: walk back up, and at the first unbalanced node apply LL, RR, LR, or RL — single or double rotations, each $O(1)$, chosen by which grandchild is heavy.
- Sorted order is the BST's edge over hashing: `lower_bound`, successors, and range aggregates all come for free, and a balanced BST can even act as a mutable segment tree.

## Glossary

- **BST ordering invariant** — for every node, all left-subtree keys are less than it and all right-subtree keys are greater.
- **Height $h$** — longest root-to-leaf edge count; drives the cost of every operation.
- **Balance factor** — $h_L - h_R$ at a node; AVL requires it to stay in the range from $-1$ to $1$.
- **In-order successor** — the next key in sorted order; for a node with a right subtree it is that subtree's minimum.
- **Rotation** — a local relinking (single: LL/RR, double: LR/RL) that changes tree shape while preserving in-order key order.
- **AVL tree** — a self-balancing BST keeping every node's balance factor within one, guaranteeing $O(\log n)$ height.
