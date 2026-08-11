---
title: "S02E06 · Treaps & Implicit Keys"
sidebar_position: 6
description: A treap is a BST by key and a heap by random priority; split and merge are its two primitives, insert/erase are built from them, and implicit keys turn it into an array with O(log n) insert, erase, and range-reverse.
---

# S02E06 · Treaps & Implicit Keys

> **Source:** Pavel Mavrin, [_A&DS S02E06_](https://youtu.be/svAHk-FAQgM) · 1h18m lecture → ~14 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- A **treap** (tree + heap, also *cartesian tree*) stores two keys per node: an ordinary BST key $x$ and a **random priority** $y$. It is a BST on $x$ and a max-heap on $y$ at the same time.
- If all priorities are distinct and random, the treap's shape is **unique** and its expected height is $O(\log n)$ — the same argument as quicksort's expected recursion depth.
- Two primitives do all the work: $\text{split}(t, x)$ cuts a tree into "keys $\lt x$" and "keys $\ge x$"; $\text{merge}(a, b)$ joins two trees where every key in $a$ is below every key in $b$. Both run in $O(\text{height}) = O(\log n)$ expected.
- **Insert** = split by $x$, then merge the two halves around a single-node tree. **Erase** = split out the element and merge the rest. Each is a handful of lines.
- **Implicit keys**: drop the $x$ key entirely and let a node's position be its **subtree-size rank**. The treap becomes a dynamic array supporting insert-at, erase-at, index-access, and — with one lazy "reverse" flag — **range reverse** and **cut-and-paste**, all in $O(\log n)$.

---

## Two new operations: split and merge

- A treap is a binary search tree, so it supports everything from the previous lecture: insert, erase, find, next, previous, minimum, maximum — all in $O(\log n)$.
- Two extra operations make the structure powerful:
  - **Split by $x$**: take one ordered set and cut it into two ordered sets — everything strictly less than $x$, and everything greater than or equal to $x$.
  - **Merge**: the inverse. Given two trees where *every* key in the first is less than *every* key in the second, glue them into one.
- Think of the elements as a sorted sequence: split cuts the sequence at a point, merge concatenates two sequences.

[watch from 1:50](https://youtu.be/svAHk-FAQgM?t=110)

---

## Structure of the tree: BST by key, heap by priority

- Each node holds **two** values: the search key $x$ and a second key $y$.
- The one and only invariant to maintain:
  - Look at any node with keys $(x, y)$. Every node in its **left** subtree has first key $\lt x$; every node in its **right** subtree has first key $\ge x$. That is the ordinary BST property on $x$.
  - Simultaneously, $y$ obeys the **heap** property: a parent's $y$ is larger than both children's $y$ (max-heap on priority).
- Visualize it on a plane: plot each node at coordinates $(x, y)$. The root is the topmost point; its left subtree lives down-and-left, its right subtree down-and-right. The picture looks exactly like a tree hanging from its highest point.

![Treap definition: a node stores keys x and y; left subtree has smaller x, right subtree larger x, drawn as points on an x–y plane](/img/dsa/svAHk-FAQgM/frame-00034.png)

- **Why two keys?** The $x$ key is the real search key. The $y$ key exists only to control balance — and we assign it at **random**.

[watch from 4:15](https://youtu.be/svAHk-FAQgM?t=255)

### Why random priorities give logarithmic height

- If all $x$ are distinct and all $y$ are distinct, there is **exactly one** valid treap on that set. Proof: the root must be the node with maximum $y$ (heap property forces it). That node splits the rest by $x$ into a left group and a right group, and each group is built the same way recursively. No freedom remains.
- Now make $y = \text{rand}()$. Because priorities are random and symmetric, **every element is equally likely to be the maximum**, hence equally likely to be the root. We pick a uniformly random root, partition by $x$, and recurse — this is **identical to randomized quicksort choosing a random pivot**.
- Quicksort's recursion depth is $O(\log n)$ in expectation, so:

$$
y = \text{rand}() \;\Longrightarrow\; \mathbb{E}[h] = O(\log n).
$$

- One-third argument for intuition: with probability $\tfrac13$ the random root falls in the middle third of the sorted order, so each of its two subproblems has size at most $\tfrac23 n$. That happens often enough that the height stays within roughly $3\log_{3/2} n = O(\log n)$.

![y = rand() gives expected height O(log n); a sample treap plotted on the x–y plane with the max-y node as root](/img/dsa/svAHk-FAQgM/frame-00066.png)

- Unlike AVL or red-black trees (deterministic), a treap is a **randomized** BST: the height is not fixed, but with high probability it is logarithmic. The payoff is that the code is dramatically simpler — this is one of the simplest balanced BSTs to implement.

[watch from 9:47](https://youtu.be/svAHk-FAQgM?t=587)

---

## Implementing split

- **Node layout** and priority source (a single global RNG):

```cpp
#include <bits/stdc++.h>
using namespace std;
mt19937 rng(2572);

struct Node {
    int key;                 // the BST key x
    unsigned pr;             // random priority y (heap key)
    Node *left = nullptr, *right = nullptr;
    Node(int k) : key(k), pr(rng()) {}
};
using pNode = Node*;
```

- **Idea** (see the board picture): to split a subtree by $x$, look at its root.
  - If the root key is $\lt x$, the root and its **entire left subtree** belong to the "less than $x$" part. Only its right subtree can contain keys $\ge x$, so recurse right, then reattach.
  - If the root key is $\ge x$, mirror it: recurse into the left subtree.
- The recursion bottoms out on the empty tree, which splits into two empty trees.

```cpp
// left half = keys < x, right half = keys >= x
void split(pNode t, int x, pNode& l, pNode& r) {
    if (!t) { l = r = nullptr; return; }   // splitting empty gives two empties
    if (t->key < x) {                      // root goes to the LEFT result
        split(t->right, x, t->right, r);   // its right subtree may straddle x
        l = t;
    } else {                               // root goes to the RIGHT result
        split(t->left, x, l, t->left);     // its left subtree may straddle x
        r = t;
    }
}
```

![split(node, x): the recursive rule — if node.key is below x, split node.right and keep node on the left; otherwise mirror](/img/dsa/svAHk-FAQgM/frame-00110.png)

- Each recursive call descends into exactly one child, so split touches $O(\text{height}) = O(\log n)$ nodes.

![split code: base case for the empty tree, then the node.key below x branch splitting node.right](/img/dsa/svAHk-FAQgM/frame-00114.png)

[watch from 20:20](https://youtu.be/svAHk-FAQgM?t=1220)

---

## Implementing merge

- **Precondition**: every key in tree $a$ is strictly less than every key in tree $b$. We must *not* reorder anything — we only decide the heap shape.
- **Idea**: the root of the merged tree is whichever of the two roots has the larger priority $y$.
  - If $a.y \gt b.y$, then $a$ is the root. Its left subtree stays; its right subtree must now hold everything greater than $a$'s key — that is $a.\text{right}$ merged with all of $b$. Recurse.
  - Otherwise $b$ is the root, and its left subtree becomes $a$ merged with $b.\text{left}$.

```cpp
// precondition: all keys in a < all keys in b
pNode merge(pNode a, pNode b) {
    if (!a) return b;                 // one side empty -> the other side
    if (!b) return a;
    if (a->pr > b->pr) {              // a wins the heap contest -> a is root
        a->right = merge(a->right, b);
        return a;
    } else {                          // b is root
        b->left = merge(a, b->left);
        return b;
    }
}
```

![merge(A, B): compare root priorities; the larger-y root stays and we recurse into the side that must absorb the other tree](/img/dsa/svAHk-FAQgM/frame-00130.png)

- Like split, each step descends one level in one of the two trees, so the total work is $O(\log n)$ expected.

[watch from 29:49](https://youtu.be/svAHk-FAQgM?t=1789)

---

## Insert and erase from split + merge

- **Insert $x$ — the easy way** (split + two merges): cut the tree at $x$, sandwich a one-node tree in the middle, glue back.

```cpp
pNode insert_slow(pNode t, int x) {
    pNode l, r;
    split(t, x, l, r);                        // l: <x   r: >=x
    return merge(merge(l, new Node(x)), r);   // l + {x} + r
}
```

- **Insert $x$ — the fast way** (one descent). Generate the new node's priority first. If it beats the current root's priority, the new node becomes the root here: split the current tree by $x$ to form its two children. Otherwise walk into the correct child, exactly like a normal BST insert.

```cpp
pNode insert(pNode t, int x) {
    pNode nn = new Node(x);
    if (!t) return nn;
    if (nn->pr > t->pr) {                     // new node outranks the root
        split(t, x, nn->left, nn->right);     // its children come from the split
        return nn;
    }
    if (x < t->key) t->left  = insert(t->left,  x);
    else            t->right = insert(t->right, x);
    return t;
}
```

- **Erase $x$** (two splits + one merge): isolate the sub-range equal to $x$ and drop it. Splitting by $x$ and by $x+1$ carves out exactly the copies of $x$.

```cpp
pNode erase(pNode t, int x) {
    pNode a, b, c;
    split(t, x,     a, b);   // a: <x     b: >=x
    split(b, x + 1, b, c);   // b: ==x    c: >x
    return merge(a, c);      // drop b, join the rest
}
```

- Each operation is a constant number of $O(\log n)$ split/merge/descent calls, so insert and erase are $O(\log n)$ expected. The single-descent insert avoids re-splitting the same nodes and runs roughly three times faster in practice than split-plus-two-merges.

![add(node, newNode): compare priorities, split when the new node wins the root; full split and merge code side by side](/img/dsa/svAHk-FAQgM/frame-00179.png)

[watch from 36:55](https://youtu.be/svAHk-FAQgM?t=2215)

---

## Implicit-key treaps: the tree as an array

- **Goal**: maintain a *list* of arbitrary objects and support merging two lists, splitting a list after its first $k$ elements, and reading the element at a given index — all in $O(\log n)$.
- **First idea (works, but overkill)**: store each list as a BST keyed by *index* $1, 2, 3, \dots$. To concatenate list $A$ (size 4) with list $B$, add $4$ to every key of $B$ with a **lazy add on the root** (like a segment tree's lazy propagation), then merge. To split, subtract afterward. This is correct but carries needless key arithmetic.
- **Key insight (implicit keys)**: the index of an element is just its **position in the in-order traversal** — which is determined entirely by the tree's shape. So *do not store the index at all*. Keep only the random priority $y$ for balance, and augment each node with the **size of its subtree**.

```cpp
mt19937 rng(90210);

struct Node {
    int val;                 // the stored object (no search key!)
    unsigned pr;             // random priority for balance
    int size = 1;            // subtree size = how many elements it spans
    bool rev = false;        // lazy "reverse this subtree" flag
    Node *left = nullptr, *right = nullptr;
    Node(int v) : val(v), pr(rng()) {}
};
using pNode = Node*;

int  sz(pNode t) { return t ? t->size : 0; }
void upd(pNode t) { if (t) t->size = 1 + sz(t->left) + sz(t->right); }
```

- The **implicit key** of a node is `sz(left) + 1` within its subtree — the count of elements that come before it in order. This replaces the BST key in every comparison.

![Implicit-key list merge: [Q,Y,P,K] concatenated with [W,N,B] by merging the two treaps on priority alone; a get-by-index example below](/img/dsa/svAHk-FAQgM/frame-00229.png)

[watch from 44:50](https://youtu.be/svAHk-FAQgM?t=2690)

### Lazy reverse

- Add one lazy flag `rev`. Applying it swaps a node's children and flips the flag; **pushing** it down propagates to both children before we descend. Because reversing a sequence is exactly "reverse left, reverse right, swap them", the flag composes correctly through split and merge.

```cpp
void applyRev(pNode t) { if (t) { t->rev ^= 1; swap(t->left, t->right); } }
void push(pNode t) {
    if (t && t->rev) {
        applyRev(t->left);
        applyRev(t->right);
        t->rev = false;
    }
}
```

### Split and merge on subtree size

- **Split first $k$**: at each node the root's rank is `sz(left)`. If `sz(left) < k`, the root and its left subtree fall entirely in the first part — recurse right for the remaining `k - sz(left) - 1`. Otherwise recurse left. Push the lazy flag before descending; update sizes on the way up.

```cpp
// first k elements -> l, the rest -> r
void split(pNode t, int k, pNode& l, pNode& r) {
    if (!t) { l = r = nullptr; return; }
    push(t);
    if (sz(t->left) < k) {                             // root + left go left
        split(t->right, k - sz(t->left) - 1, t->right, r);
        l = t;
    } else {
        split(t->left, k, l, t->left);
        r = t;
    }
    upd(t);
}

pNode merge(pNode a, pNode b) {
    if (!a) return b;
    if (!b) return a;
    if (a->pr > b->pr) {
        push(a);
        a->right = merge(a->right, b);
        upd(a);
        return a;
    } else {
        push(b);
        b->left = merge(a, b->left);
        upd(b);
        return b;
    }
}
```

### List operations built on split/size/merge

```cpp
// insert value v so it lands at position pos (0-indexed)
pNode insertAt(pNode t, int pos, int v) {
    pNode l, r; split(t, pos, l, r);
    return merge(merge(l, new Node(v)), r);
}

// erase the element at position pos
pNode eraseAt(pNode t, int pos) {
    pNode a, b, c;
    split(t, pos, a, b);
    split(b, 1, b, c);          // b is the single element at pos
    return merge(a, c);
}

// reverse the half-open range [lo, hi)
pNode reverseRange(pNode t, int lo, int hi) {
    pNode a, b, c;
    split(t, lo, a, b);
    split(b, hi - lo, b, c);    // b is the target segment
    applyRev(b);                // flip it lazily in O(1)
    return merge(merge(a, b), c);
}

// value at index pos
int getAt(pNode t, int pos) {
    push(t);
    if (sz(t->left) == pos) return t->val;
    if (pos < sz(t->left))  return getAt(t->left, pos);
    return getAt(t->right, pos - sz(t->left) - 1);
}
```

- **Cut-and-paste** falls straight out: to move segment $[lo, hi)$ to the end, split it out and reattach it after the rest — two splits and two merges, $O(\log n)$.

```cpp
// cut [lo, hi) and paste it at the end: A B C -> A C B
pNode moveToEnd(pNode t, int lo, int hi) {
    pNode a, b, c;
    split(t, lo, a, b);
    split(b, hi - lo, b, c);    // b = the segment
    return merge(merge(a, c), b);
}
```

![Implicit merge tree for the combined list, the split-by-4 recursion trace, and cut-a-segment-and-paste-it-elsewhere (A B C to A C B)](/img/dsa/svAHk-FAQgM/frame-00294.png)

- With this structure you get everything a segment tree offers (range aggregates via extra augmentation) **plus** the ability to physically rearrange elements — reverse a range, rotate a segment, cut and paste — each in $O(\log n)$.

[watch from 71:03](https://youtu.be/svAHk-FAQgM?t=4263)

---

## A note on persistence

- Persistent treaps are almost free: run the same split/merge code, but whenever you would mutate a node, **copy it first** and return the copy. Each operation touches $O(\log n)$ nodes, so each new version costs $O(\log n)$ extra memory while all old versions stay intact.
- This turns the treap into a fully persistent ordered sequence — every historical version remains queryable.

[watch from 73:17](https://youtu.be/svAHk-FAQgM?t=4397)

---

## Complexity recap

| Operation | Best | Average | Worst | Space |
| --- | --- | --- | --- | --- |
| split | $\Theta(\log n)$ | $\Theta(\log n)$ | $\Theta(n)$ | $O(\log n)$ stack |
| merge | $\Theta(\log n)$ | $\Theta(\log n)$ | $\Theta(n)$ | $O(\log n)$ stack |
| insert / erase (by key) | $\Theta(\log n)$ | $\Theta(\log n)$ | $\Theta(n)$ | $O(\log n)$ |
| find / next / min (by key) | $\Theta(\log n)$ | $\Theta(\log n)$ | $\Theta(n)$ | $O(\log n)$ |
| insertAt / eraseAt / getAt | $\Theta(\log n)$ | $\Theta(\log n)$ | $\Theta(n)$ | $O(\log n)$ |
| range reverse / cut-and-paste | $\Theta(\log n)$ | $\Theta(\log n)$ | $\Theta(n)$ | $O(\log n)$ |
| whole structure | — | — | — | $O(n)$ |

The worst case ($\Theta(n)$) needs an adversary who knows every priority in advance; with a real RNG it occurs with negligible probability, and the **expected** bound is $\Theta(\log n)$.

---

## Practice problems

Honest framing: treaps are a **competitive-programming** structure. You will essentially never be asked to code one in an interview — production systems reach for red-black trees instead. But the **split/merge idea** (and the implicit-key trick) is genuinely powerful, and "design a balanced ordered structure" does appear in interviews. Reach for a treap when you need a **dynamic sequence with range reverse, cut-and-paste, or order-statistics** that a plain segment tree or BST cannot rearrange.

**🎯 Interview (MAANG-style)**

- [Design Skiplist — LeetCode 1206](https://leetcode.com/problems/design-skiplist/) — Hard — the nearest interview analogue: build a balanced ordered structure with add/erase/search in expected $O(\log n)$. A skiplist is the randomized cousin of a treap.
- [Kth Largest Element in a Stream — LeetCode 703](https://leetcode.com/problems/kth-largest-element-in-a-stream/) — Easy — order-statistics on a dynamic set; a subtree-size augmentation answers it, which is the implicit-key idea in miniature.
- [Count of Smaller Numbers After Self — LeetCode 315](https://leetcode.com/problems/count-of-smaller-numbers-after-self/) — Hard — order-statistics BST / Fenwick; a size-augmented treap solves it directly.

**🏆 Competitive**

- [Cut and Paste — CSES 2072](https://cses.fi/problemset/task/2072) — Hard — the canonical implicit-treap problem: repeatedly cut a range and paste it elsewhere. This is exactly the moveToEnd operation above.
- [Substring Reversals — CSES 2073](https://cses.fi/problemset/task/2073) — Hard — reverse arbitrary ranges of a string; needs the lazy-reverse flag verbatim.
- [List Removals — CSES 1749](https://cses.fi/problemset/task/1749) — Medium — repeatedly delete the element at a given position; an implicit treap indexed by subtree size removes the k-th remaining item in O(log n).
- [Sliding Window Median — CSES 1076](https://cses.fi/problemset/task/1076) — Hard — an order-statistics tree (a key treap with subtree sizes) reads off the median as you slide.

> This lecture assigns no Codeforces home-task post (none was linked in the video description), so the competitive list above is curated to match the lecture's split/merge and implicit-key content.

---

## Further reading

- [Treap (cp-algorithms)](https://cp-algorithms.com/data_structures/treap.html) — split/merge, implicit keys, and lazy propagation with reference C++.
- [Treap — Wikipedia](https://en.wikipedia.org/wiki/Treap) — origin, the tree-plus-heap invariant, and the expected-height proof.
- [Random binary search tree — Wikipedia](https://en.wikipedia.org/wiki/Random_binary_search_tree) — the randomization argument underpinning the logarithmic height.
- [Treap: a randomized BST (GeeksforGeeks)](https://www.geeksforgeeks.org/treap-a-randomized-binary-search-tree/) and [search/insert/delete in a treap (GeeksforGeeks)](https://www.geeksforgeeks.org/dsa/implementation-of-search-insert-and-delete-in-treap/) — worked rotation-based and split/merge implementations.

---

## Key takeaways

- A treap is two structures in one: a **BST on the key** and a **max-heap on a random priority**. Random priorities buy $O(\log n)$ expected height with none of the rotation bookkeeping of AVL or red-black trees.
- **split** and **merge** are the whole library. Once you have them, insert is split-plus-two-merges (or a single fast descent) and erase is two-splits-plus-a-merge.
- The expected-height proof is the **quicksort argument**: a random priority means a random root, so the tree mirrors quicksort's balanced random-pivot recursion.
- **Implicit keys** replace the search key with subtree-size rank, turning the treap into a dynamic array with $O(\log n)$ insert-at, erase-at, index-access, range-reverse (one lazy flag), and cut-and-paste.
- Persistence is nearly free: copy-on-write each touched node and every past version survives.

## Glossary

- **Treap / cartesian tree** — a BST on key $x$ that is simultaneously a heap on a second key $y$.
- **Priority** — the random second key $y$; its heap order is what keeps the tree balanced.
- **split(t, x)** — cut a treap into "keys below $x$" and "keys at or above $x$".
- **merge(a, b)** — join two treaps where every key in $a$ is below every key in $b$.
- **Implicit key** — a node's position in the in-order sequence, computed from subtree sizes rather than stored.
- **Lazy propagation** — deferring a pending update (here, "reverse this subtree") in a flag and pushing it down only when a node is visited.
- **Persistent structure** — keeps every past version available by copying nodes instead of mutating them.
