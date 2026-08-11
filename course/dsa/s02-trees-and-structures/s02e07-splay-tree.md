---
title: "S02E07 · Splay Tree"
sidebar_position: 7
description: The splay operation (zig, zig-zig, zig-zag), splay-based find/insert/delete/split/merge, and a point-wise potential-method proof that every access is amortized O(log n) via the sum-of-ranks potential and the access lemma.
---

# S02E07 · Splay Tree

> **Source:** Pavel Mavrin, [_A&DS S02E07_](https://youtu.be/2eCKpEmkxIc) · 1h18m lecture → ~14 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- A **splay tree** is a binary search tree that stores **no balance metadata at all** — no height, no size, no priority. Any BST shape is a valid splay tree; the structure rebalances itself lazily.
- The one primitive is **splay(x)**: a sequence of rotations that carries node $x$ to the root while keeping the in-order key sequence unchanged. Every operation ends by splaying the last node it touched.
- Splaying uses three step types on $x$, its parent $p$, and grandparent $g$: **zig** (no grandparent, one rotation), **zig-zig** ($x,p$ same side, rotate $p$ then $x$), **zig-zag** ($x,p$ opposite sides, rotate $x$ twice).
- **find / insert / erase / split / merge** all reduce to descend-then-splay, or to split and merge, so they inherit splay's cost.
- The cost is **amortized $O(\log n)$**, proved by the **potential method** with $\Phi = \sum_x r(x)$ where $r(x) = \log_2 s(x)$ (rank = log of subtree weight). The **access lemma** bounds one splay by $1 + 3\big(r'(x) - r(x)\big)$, which telescopes to $O(\log n)$.
- No single operation is worst-case $O(\log n)$ — a splay can be linear — but any sequence of $k$ operations runs in $O(k \log n)$, and on skewed access patterns splay trees can beat every balanced tree.

---

## The idea: a self-adjusting BST with no invariant

- Earlier trees each maintained one property: **AVL** keeps heights balanced by rotations; a **treap** assigns random priorities so the expected height is $\Theta(\log n)$. A splay tree maintains **nothing**.
- Any BST is a legal splay tree. At each moment the current shape is simply "what the tree currently thinks is best for the recent access pattern."
- The self-adjustment rule is a cache analogy: **whenever you touch a node, move it to the root.** Recently accessed keys drift toward the top (fast to reach again); untouched keys sink toward the bottom. That is exactly move-to-front on a queue, lifted to a tree.

[watch from 0:36](https://youtu.be/2eCKpEmkxIc?t=36)

---

## splay(x): move a node to the root

- **splay(x)** takes any node $x$ and rotates it up until it is the root. The tree ends up holding the **same set of keys in the same in-order sequence**, only reshaped so that $x$ is on top.
- Because rotations preserve BST order, any element can legally become the root — after splaying $12$, the key $12$ is the root and every other key hangs consistently below it.
- Every dictionary operation follows the same skeleton: walk down to the target node $x$ along the search path, do the operation's work, then call **splay(x)**. The walk up during splaying retraces the same path, so a splay costs at most twice the descent.

![Splay tree: splaying x lifts it to the root; find(x) descends the search path then calls splay(x)](/img/dsa/2eCKpEmkxIc/frame-00033.png)

- So the analysis target is narrow: if **splay** is amortized $O(\log n)$, then find, insert, erase — everything — is too, since each is one descent plus one splay of the same length.

[watch from 4:49](https://youtu.be/2eCKpEmkxIc?t=289)

---

## The three splay steps: zig, zig-zig, zig-zag

Look at $x$, its parent $p$, and grandparent $g$, and repeat one of three cases until $x$ is the root.

**Case 1 — zig (no grandparent):** $p$ is the root. Do a single rotation of the edge $(x, p)$. Now $x$ is the root, $p$ is its child, and the three hanging subtrees $A, B, C$ reattach in order. This case fires at most once, at the very end of a splay.

![Zig: single rotation when x's parent is the root, subtrees A, B, C reattach in order](/img/dsa/2eCKpEmkxIc/frame-00060.png)

**Case 2 — zig-zag (x and p on opposite sides):** $x$ is a right child of $p$ while $p$ is a left child of $g$ (or the mirror). Make $x$ the local root with $p$ and $g$ as its two children. Implement it as **two single rotations of $x$**: rotate $(x,p)$, then rotate $(x,g)$.

![Zig-zag: x and p bend in opposite directions, so x becomes the root with p and g as its children](/img/dsa/2eCKpEmkxIc/frame-00067.png)

**Case 3 — zig-zig (x and p on the same side):** both edges point the same way — for example $x$ is the left child of $p$ and $p$ is the left child of $g$. Here order matters: **rotate the upper edge $(p,g)$ first, then the lower edge $(x,p)$.** (Zig-zag rotates $x$ twice; zig-zig rotates $p$ then $x$ — that asymmetry is what makes the amortized proof work.)

![Zig-zig: x and p bend the same way, so rotate the upper edge p-g first, then x-p](/img/dsa/2eCKpEmkxIc/frame-00074.png)

- Implementation: write one `rotate(x)` that lifts $x$ one level, then the whole splay loop is "while $x$ is not the root, classify the case and issue the right pair of rotations." Roughly 30 lines total.

```cpp
#include <bits/stdc++.h>
using namespace std;

// Splay tree as an ordered set of distinct keys.
struct Node {
    int key;
    Node *left, *right, *parent;
    Node(int k) : key(k), left(nullptr), right(nullptr), parent(nullptr) {}
};

struct SplayTree {
    Node* root = nullptr;

    void attachLeft(Node* p, Node* c)  { if (p) p->left = c;  if (c) c->parent = p; }
    void attachRight(Node* p, Node* c) { if (p) p->right = c; if (c) c->parent = p; }

    // Single rotation of edge (x, parent). x moves one level up.
    void rotate(Node* x) {
        Node* p = x->parent;
        Node* g = p->parent;
        if (p->left == x) {              // right rotation
            attachLeft(p, x->right);
            attachRight(x, p);
        } else {                         // left rotation
            attachRight(p, x->left);
            attachLeft(x, p);
        }
        x->parent = g;                   // relink to grandparent (or crown x)
        if (!g)                 root = x;
        else if (g->left == p)  g->left = x;
        else                    g->right = x;
    }

    // Move x to the root using zig / zig-zig / zig-zag steps.
    void splay(Node* x) {
        while (x->parent) {
            Node* p = x->parent;
            Node* g = p->parent;
            if (!g) {
                rotate(x);                               // zig
            } else if ((g->left == p) == (p->left == x)) {
                rotate(p); rotate(x);                    // zig-zig: parent first
            } else {
                rotate(x); rotate(x);                    // zig-zag: x twice
            }
        }
        root = x;
    }
};
```

- **Worked example (from the board):** to access the deepest key, descend to it, then splay. If $x$ sits under a same-side then opposite-side then top pattern, the splay is `zig-zig`, then `zig-zag`, then a final `zig`. Each step lifts $x$ two levels (or one, for the closing zig) and it lands at the root.

![Splaying node 23 up a 15-node tree: a zig-zig, then a zig-zag, then a final zig lands it at the root](/img/dsa/2eCKpEmkxIc/frame-00093.png)

[watch from 12:50](https://youtu.be/2eCKpEmkxIc?t=770)

---

## All operations reduce to splay (+ split / merge)

- **find(key):** descend by BST comparison to the node holding `key`; splay it and return it. If the key is absent, splay the **last node visited** anyway — that is what keeps the amortized bound honest and pulls the boundary of the search to the root.
- **split(key):** `find(key)` first, bringing a boundary node to the root, then cut one child edge. Left tree gets all keys $< \text{key}$, right tree gets all keys $\ge \text{key}$.
- **merge(a, b)** (every key of `a` strictly below every key of `b`): splay the **maximum** of `a` to `a`'s root — it then has no right child — and hang `b` there.
- **insert(key):** `split` on the key, then make a fresh node the root with the two halves as its children (a duplicate key becomes a no-op).
- **erase(key):** `find` the node to the root, detach its two subtrees, delete it, and `merge` the halves.

```cpp
    Node* find(int key) {
        Node* cur = root; Node* last = nullptr;
        while (cur) {
            last = cur;
            if (key == cur->key) { splay(cur); return cur; }
            cur = (key < cur->key) ? cur->left : cur->right;
        }
        if (last) splay(last);      // splay the boundary even on a miss
        return nullptr;
    }

    bool contains(int key) { return find(key) != nullptr; }

    // left tree: keys < key ; right tree: keys >= key
    pair<Node*,Node*> split(int key) {
        if (!root) return {nullptr, nullptr};
        find(key);
        Node* r = root;
        if (r->key < key) {
            Node* right = r->right;
            if (right) right->parent = nullptr;
            r->right = nullptr; root = r;
            return {r, right};
        } else {
            Node* left = r->left;
            if (left) left->parent = nullptr;
            r->left = nullptr; root = r;
            return {left, r};
        }
    }

    // every key in a < every key in b
    Node* merge(Node* a, Node* b) {
        if (!a) return b;
        if (!b) return a;
        Node* cur = a;
        while (cur->right) cur = cur->right;   // max of a
        root = a; splay(cur);                  // now cur has no right child
        attachRight(cur, b);
        return cur;
    }

    void insert(int key) {
        if (!root) { root = new Node(key); return; }
        auto pr = split(key);                  // pr.first < key <= pr.second
        if (pr.second && pr.second->key == key) {   // already present
            root = merge(pr.first, pr.second);
            find(key);
            return;
        }
        Node* x = new Node(key);
        attachLeft(x, pr.first);
        attachRight(x, pr.second);
        root = x;
    }

    void erase(int key) {
        if (!find(key)) return;                // splays boundary on a miss
        Node* r = root;                        // r->key == key, now the root
        Node* L = r->left;  if (L) L->parent = nullptr;
        Node* R = r->right; if (R) R->parent = nullptr;
        delete r;
        root = merge(L, R);
    }
```

- **min / max** are the same pattern: walk to the leftmost or rightmost node, then splay it. The lecture leaves the fully general splay-based split/merge as a home task; the versions above are complete and were stress-tested against `std::set` over 20000 random operations.

[watch from 5:35](https://youtu.be/2eCKpEmkxIc?t=335)

---

## What amortized O(log n) means here

- A single splay can be **linear**: on a fully skewed tree, accessing the deepest leaf walks the whole path. That is allowed.
- The claim is about **sequences**: for any $k$ operations, the **total** time is $O(k \log n)$ — no single-operation guarantee, but the average over the run is $\log n$, not by a lucky constant but always.
- **Killer example.** Access the same key $k$ times in a row. A balanced tree (AVL, red-black, treap) pays $\log n$ every time: total $\Theta(k \log n)$. A splay tree pays $\log n$ once — the first access splays that key to the root — then every later access is $O(1)$. Total $O(\log n + k)$. Splay adapts to the workload; the balanced trees cannot.

![The k-repeat access: AVL costs k log n, splay costs log n + k because the first splay caches the key at the root](/img/dsa/2eCKpEmkxIc/frame-00273.png)

[watch from 7:14](https://youtu.be/2eCKpEmkxIc?t=434)

---

## The potential method and the sum-of-ranks potential

- Amortized cost is defined through a **potential function** $\Phi$ over the data-structure state:

$$
\tilde{T} = T + \Delta\Phi = T + \big(\Phi_{\text{after}} - \Phi_{\text{before}}\big)
$$

- **Why this bounds real time.** Sum over a sequence of $k$ operations — the potential differences telescope:

$$
\sum_{i=1}^{k} \tilde{T}_i = \sum_{i=1}^{k} T_i + \big(\Phi_{\text{final}} - \Phi_{\text{initial}}\big)
$$

- We will use a **non-negative** potential with $\Phi_{\text{initial}} = 0$ (or at least $\Phi_{\text{final}} \ge \Phi_{\text{initial}}$), so $\Phi_{\text{final}} - \Phi_{\text{initial}} \ge 0$ and therefore

$$
\sum_i T_i \;\le\; \sum_i \tilde{T}_i .
$$

- Bounding each amortized $\tilde{T}_i$ by $O(\log n)$ then bounds the whole real running time by $O(k \log n)$. The design goal for $\Phi$: it must **drop** exactly when we run an expensive (deep) splay, paying for the long operation out of stored potential.

![Amortized cost T-tilde equals real time plus change of potential; assign weight W(x) = 1 to every node](/img/dsa/2eCKpEmkxIc/frame-00124.png)

- **The construction (Sleator and Tarjan, 1985).** Assign every node a **weight** $w(x) > 0$. Today take $w(x) = 1$ for all nodes. Define:
  - **subtree weight** $s(x) = \sum_{y \in \text{subtree}(x)} w(y)$ — with unit weights this is just the number of nodes under $x$ (inclusive),
  - **rank** $r(x) = \log_2 s(x)$,
  - **potential** $\Phi = \sum_{x} r(x)$ — the sum of all ranks.

$$
w(x) = 1,\qquad s(x) = \!\!\sum_{y \in \text{subtree}(x)}\!\! w(y),\qquad r(x) = \log_2 s(x),\qquad \Phi = \sum_x r(x)
$$

![Definitions: weight w(x), subtree weight s(x), rank r(x) = log2 s(x), potential Phi = sum of ranks; the access lemma gives O(log n)](/img/dsa/2eCKpEmkxIc/frame-00148.png)

[watch from 23:22](https://youtu.be/2eCKpEmkxIc?t=1402)

---

## The access lemma and why it gives O(log n)

- **Access lemma.** For a full **splay(x)**, the amortized cost obeys

$$
\tilde{T}\big(\text{splay}(x)\big) \;\le\; 1 + 3\big(r'(x) - r(x)\big),
$$

where $r(x)$ is $x$'s rank **before** the splay and $r'(x)$ its rank **after**.

- **Why the lemma suffices.** After splaying, $x$ is the root, so its subtree is the whole tree of weight $n$, giving $r'(x) = \log_2 n$. Since $r(x) \ge 0$,

$$
\tilde{T} \;\le\; 1 + 3\log_2 n - 3\,r(x) \;\le\; 1 + 3\log_2 n \;=\; O(\log n).
$$

- **The stronger reading.** The bound depends on the node's **current** rank: splaying a high-rank node (one already near the root, holding many descendants) is **cheap**, because $r'(x) - r(x)$ is small. This finer form — cost proportional to the rank difference, not a flat $\log n$ — is what makes splay trees composable inside **link-cut trees** three lectures later.

- **How the lemma is assembled — telescoping.** A splay is a chain of steps that carry $x$ up two levels at a time. Prove a per-step bound where the middle ranks cancel:
  - each **zig-zig / zig-zag** step: $\;\tilde{T}_{\text{step}} \le 3\big(r'(x) - r(x)\big)$ — no additive constant,
  - the **single zig** (fires at most once, at the end): $\;\tilde{T}_{\text{zig}} \le 1 + 3\big(r'(x) - r(x)\big)$.
  Summing the chain, each step's "after" rank of $x$ is the next step's "before" rank, so the intermediate terms telescope:

$$
\sum_{\text{steps}} 3\big(r_{i}(x) - r_{i-1}(x)\big) \;=\; 3\big(r_{\text{final}}(x) - r_{\text{initial}}(x)\big),
$$

  and only the lone zig contributes the $+1$. That is precisely why the constant must live in the zig case alone: an additive $+1$ in every step would sum to a term proportional to the **number** of steps, i.e. the depth — destroying the bound.

[watch from 33:25](https://youtu.be/2eCKpEmkxIc?t=2005)

---

## Proof of the per-step bounds

Throughout, primes denote ranks **after** the step; only $x$, $p$, $g$ change rank (subtrees hanging off them keep the same node sets, hence the same $s$ and $r$).

### Zig (single rotation)

- Real time $1$; only $x$ and $p$ change rank:

$$
\tilde{T}_{\text{zig}} = 1 + \big(r'(x) - r(x)\big) + \big(r'(p) - r(p)\big).
$$

- After the rotation $x$ sits where $p$ was, so $r'(x) = r(p)$ and $r'(p) \le r'(x)$. Hence $r'(p) - r(p) \le r'(x) - r(x)$, and since $r'(x) - r(x) \ge 0$:

$$
\tilde{T}_{\text{zig}} \le 1 + 2\big(r'(x) - r(x)\big) \le 1 + 3\big(r'(x) - r(x)\big).
$$

### Zig-zag

- Two rotations, so real time $2$; $x, p, g$ change rank:

$$
\tilde{T} = 2 + \big(r'(x) - r(x)\big) + \big(r'(p) - r(p)\big) + \big(r'(g) - r(g)\big).
$$

![Zig-zag amortized cost: T-tilde = 2 + (r'(x)-r(x)) + (r'(p)-r(p)) + (r'(g)-r(g))](/img/dsa/2eCKpEmkxIc/frame-00192.png)

- **Simplify.** Before the step the old root of this local piece is $g$ with $r(g) = r'(x)$ (both cover the same node set), so those two terms cancel. Also $r(p) \ge r(x)$, so $-r(p) \le -r(x)$. That leaves the goal

$$
r'(p) + r'(g) - 2\,r'(x) \;\le\; -2,
$$

which will finish the case (giving $\tilde{T} \le 3(r'(x) - r(x))$, stronger than the $2$-coefficient we technically need).

- **The log-of-product trick.** Ranks are logs, so a sum of ranks is the log of a product:

$$
r'(p) + r'(g) - 2\,r'(x) = \log_2\!\frac{s'(p)\,s'(g)}{s'(x)\,s'(x)}.
$$

- **The fraction bound.** After the step, $x$ is the local root; $p$ and $g$ become its two children, and $s'(x) \ge s'(p) + s'(g)$ (the local root also holds $x$ itself). Writing $\alpha = s'(p)$, $\beta = s'(g)$, $\gamma = s'(x) \ge \alpha + \beta$:

$$
\frac{\alpha}{\gamma} + \frac{\beta}{\gamma} \;\le\; 1.
$$

- **Product of two numbers summing to $\le 1$.** For fixed sum, a product is largest when the two factors are equal, so

$$
\frac{\alpha}{\gamma}\cdot\frac{\beta}{\gamma} \;\le\; \frac{1}{4}
\quad\Longrightarrow\quad
\log_2\!\frac{s'(p)\,s'(g)}{s'(x)^2} \le \log_2 \tfrac14 = -2.
$$

- Substituting back, $\tilde{T}_{\text{zig-zag}} \le 3\big(r'(x) - r(x)\big)$ — no additive constant. Done.

![Zig-zag final steps: reduce to log of s'(p) s'(g) over s'(x)^2, use fractions summing to at most one, product at most one-quarter](/img/dsa/2eCKpEmkxIc/frame-00237.png)

### Zig-zig

- Same start: real time $2$, and

$$
\tilde{T} = 2 + \big(r'(x) - r(x)\big) + \big(r'(p) - r(p)\big) + \big(r'(g) - r(g)\big).
$$

![Zig-zig: same potential-change form; the two children fractions again sum to at most one so the product is at most one-quarter](/img/dsa/2eCKpEmkxIc/frame-00230.png)

- **Reductions.** As before $r'(x) = r(g)$ (same node set covered), so those cancel. Two order facts hold here: $r(p) \ge r(x)$ so $-r(p) \le -r(x)$; and $r'(p) \le r'(x)$ since after the step $p$ is a **child** of $x$. Push everything to one side; the target becomes

$$
r(x) + r'(g) - 2\,r'(x) \;\le\; -2,
$$

i.e. in size form

$$
\log_2\!\frac{s(x)\,s'(g)}{s'(x)^2} \;\le\; -2.
$$

- **Same fraction bound.** After the step $x$ is the local root and the old subtree of $x$ (size $s(x)$) and the new subtree of $g$ (size $s'(g)$) are disjoint pieces sitting under $x$, so $s'(x) \ge s(x) + s'(g)$. The two fractions $s(x)/s'(x)$ and $s'(g)/s'(x)$ sum to $\le 1$, their product is $\le 1/4$, and the log is $\le -2$.

- Hence $\tilde{T}_{\text{zig-zig}} \le 3\big(r'(x) - r(x)\big)$ — again no additive constant. Both non-terminal cases meet the telescoping form, the lone zig supplies the single $+1$, and the access lemma follows.

[watch from 43:01](https://youtu.be/2eCKpEmkxIc?t=2581)

---

## Why (and when) to use a splay tree

- **Practical caveat, stated plainly.** In practice splay trees are **not** widely used as a general dictionary. The guarantee is amortized, so an individual operation may run long — bad for latency-sensitive systems that need a fast response on *every* call. Balanced trees give a hard per-operation $O(\log n)$.
- **Where they shine.** Splay trees **self-optimize to the access pattern for free**. Frequently accessed keys migrate near the root, so hot keys are cheaper than cold ones — no configuration, no statistics kept.
- **Provable adaptivity.** Accessing keys $1, 2, \dots, n$ in order costs $\Theta(n)$ total on a splay tree — the same as the offline optimum — even though the tree never plans ahead. Several such "adapts as well as the best static BST" theorems (static optimality, working-set, sequential access) are known.
- **Dynamic optimality conjecture (open).** Let $T_{\text{opt}}$ be the minimum cost of a sequence over **all** BSTs that may rotate freely (even knowing the whole sequence in advance). Conjecture: a splay tree is within a **constant factor** of $T_{\text{opt}}$ on every sequence. Nobody has proved or disproved it — the obstacle is that computing the offline optimal BST cost itself is hard to characterize.
- **The forward pointer.** In three lectures, **link-cut trees** will embed splay trees as their inner structure; an operation there becomes a sequence of splays, and the rank-difference form of the access lemma (not a flat $\log n$ per splay) is exactly what collapses the total to $O(\log n)$ instead of $O(\log^2 n)$.

![T_opt = minimum time over all BSTs; splay's log n + k on the k-repeat pattern versus AVL's k log n](/img/dsa/2eCKpEmkxIc/frame-00273.png)

[watch from 60:32](https://youtu.be/2eCKpEmkxIc?t=3632)

---

## Complexity recap

| Operation | Best | Amortized | Worst (single op) | Space |
| --- | --- | --- | --- | --- |
| find / contains | $\Theta(1)$ | $O(\log n)$ | $O(n)$ | $O(n)$ |
| insert | $\Theta(1)$ | $O(\log n)$ | $O(n)$ | $O(n)$ |
| erase | $\Theta(1)$ | $O(\log n)$ | $O(n)$ | $O(n)$ |
| split / merge | $\Theta(1)$ | $O(\log n)$ | $O(n)$ | $O(n)$ |
| min / max | $\Theta(1)$ | $O(\log n)$ | $O(n)$ | $O(n)$ |
| $k$-operation sequence | — | $O(k\log n)$ total | $O(k\log n)$ total | $O(n)$ |

- No per-node balance metadata is stored — the tree carries only keys and child/parent pointers.

---

## Practice problems

Splay trees are a **theory-and-competitive** structure: they are almost never asked to be coded in an interview round. What *is* interview-relevant is the **amortized-structure design intuition** — the "touch it, move it to the front, and the average cost stays low" idea. The nearest interview problems below exercise that intuition without requiring a splay tree; the competitive ones are where splay (or its cousin, the implicit treap) is the intended tool.

**🎯 Interview (MAANG-style) — the amortized/self-adjusting intuition, not the tree itself**

- [LRU Cache — LeetCode 146](https://leetcode.com/problems/lru-cache/) — Medium — the canonical move-to-front-on-access design; same "recently used floats to the top" principle splaying enforces on a tree.
- [Insert Delete GetRandom O(1) — LeetCode 380](https://leetcode.com/problems/insert-delete-getrandom-o1/) — Medium — amortized $O(1)$ dictionary design; reasoning about amortized cost under a mix of operations.
- [Design a data structure with amortized guarantees — dynamic array / hashing](https://www.geeksforgeeks.org/introduction-to-splay-tree-data-structure/) — the GfG splay overview frames where amortized analysis (not worst-case) is the right lens.

**🏆 Competitive**

- [Cut and Paste — CSES 2072](https://cses.fi/problemset/task/2072) — Hard — split and merge a sequence by position; the canonical **implicit balanced-BST** problem (implicit treap or splay by subtree size).
- [List Removals — CSES 1749](https://cses.fi/problemset/task/1749) — Medium — order-statistics deletion; a balanced BST keyed by position, exactly the split/merge machinery above.
- Codeforces has splay-friendly implicit-tree problems (sequence reversal, range assignment); most are solvable with an implicit treap, so splay is optional. No official Codeforces home-task post is linked from this lecture's description, so none is cited here.

> Honest framing: if an interviewer wants a self-balancing BST they will accept a red-black tree or `std::set`; if they want the *concept*, they will ask about LRU/amortized design. Reach for a splay tree only in competitive settings or inside a link-cut tree.

---

## Further reading

- [Splay tree — Wikipedia](https://en.wikipedia.org/wiki/Splay_tree) — the three cases, the access lemma, and the adaptivity theorems.
- [Splay Tree (insert / delete) — GeeksforGeeks](https://www.geeksforgeeks.org/splay-tree-set-2-insert-delete/) and the [introduction](https://www.geeksforgeeks.org/introduction-to-splay-tree-data-structure/) — worked implementations.
- [Potential method — Wikipedia](https://en.wikipedia.org/wiki/Potential_method) and [Amortized analysis — Wikipedia](https://en.wikipedia.org/wiki/Amortized_analysis) — the accounting framework used in the proof.
- [Dynamic optimality conjecture — Wikipedia](https://en.wikipedia.org/wiki/Dynamic_optimality_conjecture) and [Tango tree — Wikipedia](https://en.wikipedia.org/wiki/Tango_tree) — the open problem and the $O(\log\log n)$-competitive partial answer.
- [Link/cut tree — Wikipedia](https://en.wikipedia.org/wiki/Link/cut_tree) — the structure that reuses splay trees three lectures later.

---

## Key takeaways

- A splay tree keeps **no balance data**; the sole primitive **splay(x)** rotates $x$ to the root, and every operation ends with a splay of the node it touched.
- Three step types: **zig** (one rotation, at the end only), **zig-zag** (rotate $x$ twice), **zig-zig** (rotate $p$ then $x$). The zig-zig ordering is not cosmetic — it is what the proof needs.
- The **potential** is $\Phi = \sum_x r(x)$ with $r(x) = \log_2 s(x)$. The **access lemma** $\tilde{T} \le 1 + 3(r'(x) - r(x))$ telescopes to $O(\log n)$ amortized per access, and to $O(k\log n)$ per $k$-operation sequence.
- The proof's engine: sums of ranks are logs of products, two child-subtree fractions sum to $\le 1$, so their product is $\le \tfrac14$ and the log is $\le -2$ — cancelling the rotation cost.
- Splay trees are amortized, not worst-case, so they suit competitive/theory use and link-cut trees more than latency-critical dictionaries — but they **adapt to the workload** in ways balanced trees cannot.

## Glossary

- **Splay** — the operation that rotates a node to the root while preserving in-order key sequence.
- **Zig / zig-zig / zig-zag** — the three rotation patterns of a splay step, chosen by the positions of $x$, its parent, and grandparent.
- **Amortized cost** — real cost plus change of potential; bounds the total over a sequence, not each single operation.
- **Potential function $\Phi$** — a non-negative state function; here the sum of node ranks.
- **Rank $r(x)$** — $\log_2 s(x)$, the log of the subtree weight (node count under $x$ with unit weights).
- **Access lemma** — the bound $\tilde{T}(\text{splay}(x)) \le 1 + 3(r'(x) - r(x))$ from which $O(\log n)$ follows.
- **Dynamic optimality conjecture** — the open claim that splay trees are within a constant factor of the best possible BST on every access sequence.
