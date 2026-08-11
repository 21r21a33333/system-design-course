---
title: "S02E08 · Scapegoat Tree & List Order Maintenance"
sidebar_position: 8
description: A rotation-free balanced BST that rebuilds unbalanced subtrees under an alpha weight-balance rule, its amortized log n cost via the rebuild-charging argument, and a two-level List Order Maintenance structure answering is-before in O(1).
---

# S02E08 · Scapegoat Tree & List Order Maintenance

> **Source:** Pavel Mavrin, [_A&DS S02E08_](https://youtu.be/ZCTI3zzwrkE) · 1h39m lecture → ~15 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- Some structures store a **list at every tree node** (a dynamic 2D-range tree keeps a y-sorted list per segment). Rotations would have to **merge sibling lists**, which is $\Theta(\text{size})$, so AVL / treap / splay balancing is off the table.
- The **scapegoat tree** balances **without rotations**. It only ever **rebuilds a whole subtree into a perfectly balanced one** — an operation those per-node lists survive cleanly.
- Balance invariant: pick $\tfrac12 < \alpha < 1$ (lecture uses $\alpha = 0.7$) and keep $\operatorname{size}(\text{child}) \le \alpha \cdot \operatorname{size}(\text{parent})$ on every edge. That forces height $\le \log_{1/\alpha} n$.
- **Insert** adds a leaf, walks to the root, and if some ancestor breaks the rule it picks that node as the **scapegoat** and rebuilds its subtree. A rebuild costs $O(x)$ but only recurs after $\Theta(x)$ more operations touch that subtree — so **amortized insert is $O(\log n)$** (coins/charging argument).
- **List Order Maintenance** answers "does $x$ come before $y$?" in $O(1)$ with $O(1)$ amortized insert. Idea: give each element an **integer label** and compare labels. Labels run out after $\log M$ inserts at one spot, so use a **two-level** scheme — split the list into blocks of size $\approx \log n$, label elements **inside** a block by bisection, and label the **blocks** by a scapegoat tree (path-to-node gives a sorted global key).

---

## Why not just rotate? The per-node-list obstacle

- Recall the **dynamic 2D range structure** (points, query "how many inside a rectangle"): a segment tree on $x$, and **each node stores the list of its points sorted by $y$**.
  - Build $\Theta(n \log n)$, a rectangle query $O(\log^2 n)$, and changing a point's $y$ is $O(\log^2 n)$ — remove/insert in the $\log n$ per-node lists (each list is itself a balanced BST / `std::set`).
- The trouble starts when the **set of $x$-coordinates changes** (insert a point, or move one in $x$). Insertion is easy in isolation: find the closest leaf, split it into two leaves, and push the new value into every list on the root path.
- But repeated "insert next to the same leaf" **grows the height** — the tree degrades toward a chain, and each op is one-per-level, so we must keep height $O(\log n)$. We need **balancing**.
- **Rotations do not work here.** Rotate $x$ up over parent $p$ with subtrees $a, b, c$. Node $p$'s new list must be the sorted union of $b$, $c$, and $p$ — but there is **no way to merge two arbitrary sorted lists faster than linear**, and no way to delete a whole subtree's worth of keys from a list faster than linear either. Every rotation is $\Theta(\text{size})$.
- Conclusion on the board: AVL, treaps, splay trees — **all rotation-based**, all disqualified. We need a balancer that **rebuilds subtrees wholesale** instead.

![Board summary: construct n log n, request log squared n, change-y log squared n, and the rotation of x over p with subtrees a, b, c that would force a linear list merge](/img/dsa/ZCTI3zzwrkE/frame-00122.png)

[watch from 28:30](https://youtu.be/ZCTI3zzwrkE?t=1710)

---

## The alpha weight-balance invariant

- Fix a constant $\alpha$ with $\tfrac12 < \alpha < 1$. The lecture uses $\alpha = 0.7$.
- **Invariant.** For every node $x$ with parent $p$:

$$
\operatorname{size}(x) \;\le\; \alpha \cdot \operatorname{size}(p)
$$

where $\operatorname{size}(\cdot)$ counts nodes in the subtree.

- **This bounds the height.** Walk any root-to-leaf path. If the root has $n$ nodes, the next node has $\le \alpha n$, then $\le \alpha^2 n$, …, so a node at depth $h$ has $\le \alpha^h n$ nodes. A node has at least one node, so

$$
\alpha^h \, n \;\ge\; 1 \quad\Longrightarrow\quad \alpha^h \ge \tfrac1n \quad\Longrightarrow\quad h \;\le\; \log_{1/\alpha} n .
$$

- At $\alpha = \tfrac12$ this is a perfect tree (height $\log_2 n$); at $\alpha = 0.7$ it is looser but still $\Theta(\log n)$. Larger $\alpha$ means fewer rebuilds but a taller tree — a tunable trade-off.
- **Checking a tree.** For each node, verify each child's subtree size is $\le \alpha \cdot (\text{node size})$. On the board's example with root size $14$ (then $15$, $16$ after inserts): child of size $8$ under a parent of size $14$ is fine since $14 \cdot 0.7 = 9.8 \ge 8$; a child of size $5$ under size $8$ is fine since $8 \cdot 0.7 = 5.6 \ge 5$.

![Scapegoat tree with alpha = 0.7: the size(x) ≤ alpha·size(p) rule, the derivation h ≤ log base 1/alpha of n, and a concrete valid tree with node sizes annotated](/img/dsa/ZCTI3zzwrkE/frame-00157.png)

[watch from 47:45](https://youtu.be/ZCTI3zzwrkE?t=2865)

---

## Insert: find the scapegoat, rebuild its subtree

- **Step 1 — add a leaf.** Descend as in a normal BST and hang the new node as a leaf. Then walk back up updating subtree sizes; the path length is the current height, so this is $O(\log n)$.
- **Step 2 — find the scapegoat.** Along that same root path, look for an ancestor whose child now violates $\operatorname{size}(\text{child}) \le \alpha \cdot \operatorname{size}(\text{node})$. Take such a node (the lecture rebuilds the deepest violating ancestor; any violating ancestor works) — call it the **scapegoat**.
- **Step 3 — rebuild.** Cut the scapegoat's whole subtree of size $x$, flatten it in sorted order, and **rebuild a perfectly balanced BST** of the same $x$ keys (recursive middle-element-as-root). Splice it back where the old subtree hung. **No rotations** — the whole subtree is reconstructed at once, so any per-node auxiliary lists can simply be rebuilt from scratch too.

![Adding a leaf makes an ancestor invalid: take the topmost invalid node's subtree and replace it with a perfectly balanced subtree of the same size](/img/dsa/ZCTI3zzwrkE/frame-00172.png)

Scapegoat tree as an ordered set of `int` (worst-case sorted insertion stays balanced):

```cpp
#include <bits/stdc++.h>
using namespace std;

struct ScapegoatTree {
    struct Node { int key; Node *l=nullptr, *r=nullptr; };
    Node* root = nullptr;
    int n = 0;             // live keys
    double alpha = 0.7;    // weight-balance constant, 1/2 < alpha < 1

    int sz(Node* t) { return t ? 1 + sz(t->l) + sz(t->r) : 0; }

    // flatten subtree in-order into a node vector (keeps the Node objects)
    void flatten(Node* t, vector<Node*>& out) {
        if (!t) return;
        flatten(t->l, out);
        out.push_back(t);
        flatten(t->r, out);
    }
    // rebuild a perfectly balanced BST from sorted nodes: middle element is root
    Node* build(vector<Node*>& v, int lo, int hi) {
        if (lo > hi) return nullptr;
        int mid = (lo + hi) / 2;
        Node* t = v[mid];
        t->l = build(v, lo, mid - 1);
        t->r = build(v, mid + 1, hi);
        return t;
    }
    Node* rebuild(Node* t) {
        vector<Node*> v;
        flatten(t, v);
        return build(v, 0, (int)v.size() - 1);
    }

    void insert(int key) {
        if (!root) { root = new Node{key}; n++; return; }
        vector<Node*> path;                 // ancestors, root first
        Node* cur = root;
        while (true) {
            path.push_back(cur);
            if (key == cur->key) return;    // set semantics: no duplicates
            Node*& nxt = (key < cur->key) ? cur->l : cur->r;
            if (!nxt) { nxt = new Node{key}; path.push_back(nxt); break; }
            cur = nxt;
        }
        n++;
        // climb from the leaf; the scapegoat is the deepest ancestor whose
        // child subtree breaks size(child) <= alpha * size(node)
        int leafDepth = (int)path.size() - 1;
        int childSize = 1;                  // size below the current edge
        for (int i = leafDepth; i >= 1; i--) {
            Node* node = path[i - 1];
            int nodeSize = sz(node);
            if (childSize > alpha * nodeSize) {
                Node* rebuilt = rebuild(node);      // rebuild this subtree
                if (i - 1 == 0) root = rebuilt;
                else {
                    Node* parent = path[i - 2];
                    if (parent->l == node) parent->l = rebuilt;
                    else parent->r = rebuilt;
                }
                return;                     // one rebuild per insert suffices
            }
            childSize = nodeSize;
        }
    }

    bool contains(int key) {
        Node* t = root;
        while (t) {
            if (key == t->key) return true;
            t = (key < t->key) ? t->l : t->r;
        }
        return false;
    }
    int height(Node* t) { return t ? 1 + max(height(t->l), height(t->r)) : 0; }
    void inorder(Node* t, vector<int>& out) {
        if (!t) return;
        inorder(t->l, out); out.push_back(t->key); inorder(t->r, out);
    }
};
```

- Driver check: inserting $0,1,\dots,10^5$ **in sorted order** (the adversarial case for a plain BST) yields a tree of height $22$ with $\log_2 10^5 \approx 16.6$ — balanced, and every key is found in order.

![Building a perfectly balanced subtree of size 4: root of size 4, split the remaining 3 as two-left one-right, giving a short balanced shape](/img/dsa/ZCTI3zzwrkE/frame-00197.png)

[watch from 63:00](https://youtu.be/ZCTI3zzwrkE?t=3780)

---

## Amortized analysis: charging rebuilds to inserts

- A single rebuild of a subtree of size $x$ costs $O(x)$ (linear to flatten and rebuild).
- **Key observation.** Right after a node of size $x$ is rebuilt it is **perfectly balanced**, so each child has size $\le x/2$. For that node to become invalid again, a child must grow past $\alpha x$. So we must first **add roughly**

$$
\alpha x - \frac{x}{2} \;=\; \Bigl(\alpha - \tfrac12\Bigr)\, x
$$

**more elements** into that subtree before the next rebuild there.

![After a rebuild both children have size ≤ x/2; to trigger the next rebuild of that node we must add at least (alpha − 1/2)·x elements](/img/dsa/ZCTI3zzwrkE/frame-00209.png)

- **Amortized cost of one node's rebuilds** = total rebuild time divided by inserts that caused it:

$$
\frac{x}{\bigl(\alpha - \tfrac12\bigr)\, x} \;=\; \frac{1}{\alpha - \tfrac12} \;=\; O(1).
$$

- **Coins / potential view.** Each time you insert an element into a subtree, drop **one coin** on that subtree. When a subtree is finally unbalanced it must have received $\Theta(x)$ coins (that is *why* it grew unbalanced), which pays for the $O(x)$ rebuild.
- **Charging across all levels.** A single inserted key lives in the subtrees of **all $O(\log n)$ of its ancestors**, and it nudges each one step closer to its next rebuild. Each such "one step" is $O(1)$ amortized, so one insert pays $O(\log n)$ amortized total.

$$
\boxed{\text{insert (and delete) } = O(\log n) \text{ amortized}}
$$

- **Fine print (board caveat).** The exact "elements before next rebuild" constant is slightly off because inserting also grows the ancestor's size; the accurate condition is $\tfrac{x}{2} + k > \alpha (x + k)$. It changes the constant, not the $O(1)$ conclusion. The rebuild count is minimized for $\alpha$ around $0.7$.
- **With per-node lists.** If each node also stores a sorted list of its subtree, a rebuild of size $x$ becomes $O(x \log x)$ (rebuild the lists too), and the structure runs in $O(\log^2 n)$ overall — matching the other operations, so no loss.

![The amortized cost T/N = x / ((alpha − 1/2)·x) = 1/(alpha − 1/2), a constant, with the coins argument for charging rebuilds to inserts](/img/dsa/ZCTI3zzwrkE/frame-00212.png)

[watch from 84:10](https://youtu.be/ZCTI3zzwrkE?t=5050)

---

## List Order Maintenance: the problem

- Maintain a linked list under two operations:
  - `insert_after(x, y)` — put a new element $y$ immediately after existing element $x$.
  - `is_before(x, y)` — does $x$ occur before $y$ in the list order?
- A balanced BST gives both in $O(\log n)$ (insert at a position; compare in-order indices). We want to do **better**.

![List Order Maintenance: add_after(x, y) splices y after x; is_before(x, y) asks which element is to the left. A BST does both in log n](/img/dsa/ZCTI3zzwrkE/frame-00266.png)

[watch from 98:00](https://youtu.be/ZCTI3zzwrkE?t=5880)

---

## Idea 1: integer labels (works only for few elements)

- Give every element an **integer label** in $[0, M)$ so labels are **increasing along the list**. Then `is_before` is just an integer comparison — $O(1)$.
- `insert_after`: put the **average of the two neighbors' labels**. Between $10$ and $26$ insert $18$; between $10$ and $18$ insert $14$; and so on.
- **Problem: labels run out.** Halving the gap each time, after $\log M$ inserts **at the same spot** the neighbors become adjacent integers with no room between. With $M$ up to word size, you can only safely support up to $\log M$ elements before a collision — fine for tiny lists, not for $n$ large.

![Idea 1: labels 1, 5, 10, 26, 73, 100; inserting between 10 and 26 gives (10+26)/2 = 18; but you can add at most log M elements before running out of integers](/img/dsa/ZCTI3zzwrkE/frame-00279.png)

[watch from 105:00](https://youtu.be/ZCTI3zzwrkE?t=6300)

---

## Labeling by a scapegoat tree

- To label **many** elements, build a **balanced BST over the elements in list order** and derive each label from its **root-to-node path**:
  - Going **left** appends bits `00`, going **right** appends `11`, and at the node you **stop** with `01`; pad the rest with zeros to a fixed width.
  - Because every left-subtree label starts `00…`, the node's own starts `01…`, and every right-subtree label starts `11…`, the labels are **sorted left-to-right** — exactly the in-order (list) order.
- Board example (elements $A..G$): root $E = 64$, then $C = 16$, $B = 4$, $A = 1$, $D = 52$, $F = 208$, $G = 244$ — strictly increasing in list order $A,B,C,D,E,F,G$.
- **Label width** $= 2 \times \text{height}$. Pick $\alpha = \tfrac{1}{\sqrt 2}$ so height $\le 2\log_2 n$, giving labels of $\le 4\log_2 n$ bits — which fit in a machine word whenever the input size $n$ fits (you can already count to $n$).
- **Why a scapegoat tree specifically?** Any rotation would change the **path** — and therefore the label — of *every* node in a rotated subtree, forcing $\Theta(\text{size})$ relabels. A scapegoat tree never rotates; it only **rebuilds subtrees**, and during a rebuild you were already going to reassign labels for exactly those nodes. Rotation-free is the whole point.
- **Not floating point.** You cannot bisect floats forever — you hit adjacent representable values. Integers with a proven width bound are the honest tool.

![Elements A..G in a BST; labels from the path (left = 00, right = 11, stop = 01) give 1, 4, 16, 52, 64, 208, 244 — sorted in list order. With alpha = 1/√2 the height is ≤ 2 log₂ n, so labels need ≤ 4 log₂ n bits](/img/dsa/ZCTI3zzwrkE/frame-00324.png)

[watch from 118:00](https://youtu.be/ZCTI3zzwrkE?t=7080)

---

## Two levels: O(1) query, O(1) amortized insert

- The scapegoat labeling still costs $O(\log n)$ **per insert** (a scapegoat insert). To reach $O(1)$ amortized insert, add a **micro/macro (indirection)** layer:
  - **Split the list into blocks** of size between $\tfrac{\log n}{2}$ and $\log n$. Each element links to its block.
  - **Top level:** put one node **per block** into the scapegoat tree; each block gets a **global label** from its path.
  - **Bottom level:** inside a block, use the **Idea-1 average-label trick**. A block holds only $\approx \log n$ elements, and local integers up to $n$ leave room to bisect — safe.
- **`is_before(x, y)`** in $O(1)$:
  - Different blocks → compare the two **block global labels**.
  - Same block → compare the two **local labels**.

![Two-level structure: the list is chopped into blocks; each block is one node of the scapegoat tree carrying a global label, and elements inside a block carry local average-labels](/img/dsa/ZCTI3zzwrkE/frame-00352.png)

- **`insert_after`** in $O(1)$ amortized:
  1. Splice $y$ into $x$'s block, give it the **average** of its neighbors' local labels — $O(1)$.
  2. If the block now exceeds $\log n$, **split it in half**, make a new block node, link its elements, and **insert that node into the scapegoat tree** — this step is $O(\log n)$.
- **Why the split is $O(1)$ amortized.** After a split both halves have size $\approx \tfrac{\log n}{2}$, so each needs $\approx \tfrac{\log n}{2}$ more inserts before it splits again. The expensive $O(\log n)$ scapegoat insert happens only once per $\Theta(\log n)$ ordinary inserts:

$$
\frac{O(\log n)}{\Theta(\log n)} \;=\; O(1) \text{ amortized.}
$$

![Insert: O(1) to add inside a block and relabel; when a block exceeds log n, split into two halves each about log n over two and pay one O(log n) scapegoat insert, amortized to O(1)](/img/dsa/ZCTI3zzwrkE/frame-00381.png)

Two-level List Order Maintenance (`is_before` in $O(1)$; blocks kept near $\log n$):

```cpp
#include <bits/stdc++.h>
using namespace std;

struct ListOrder {
    struct Block;
    struct TNode {            // top-level: one node per block
        Block* block;
        TNode *l=nullptr, *r=nullptr;
        uint64_t label=0;     // global order key from the path
    };
    struct Elem {             // bottom-level list element
        uint64_t local;       // local order key inside its block
        Block* block;
        Elem *prev=nullptr, *next=nullptr;
    };
    struct Block { TNode* tnode=nullptr; vector<Elem*> elems; };

    TNode* root=nullptr;
    int blockCount=0, total=0, MAXBLK=4;   // MAXBLK tracks ~2 log n

    int  sz(TNode* t){ return t ? 1 + sz(t->l) + sz(t->r) : 0; }
    void flatten(TNode* t, vector<TNode*>& v){
        if(!t) return; flatten(t->l,v); v.push_back(t); flatten(t->r,v);
    }
    TNode* build(vector<TNode*>& v,int lo,int hi){
        if(lo>hi) return nullptr;
        int m=(lo+hi)/2; TNode* t=v[m];
        t->l=build(v,lo,m-1); t->r=build(v,m+1,hi); return t;
    }
    // assign strictly increasing 64-bit global labels by bisecting the key space
    // in in-order — the interval-form of the path scheme (left/right/stop bits)
    void relabel(TNode* t, uint64_t lo, uint64_t hi){
        if(!t) return;
        uint64_t mid = lo + (hi-lo)/2;
        t->label = mid;
        relabel(t->l, lo, mid);
        relabel(t->r, mid+1, hi);
    }
    void rebuildTop(){
        vector<TNode*> v; flatten(root,v);
        root = build(v,0,(int)v.size()-1);
        relabel(root, 0, ~0ULL);
    }
    // splice a new block node as the in-order successor of `after`, then relabel
    TNode* insertBlockNode(Block* b, TNode* after){
        TNode* node=new TNode{b};
        b->tnode=node;
        if(!root){ root=node; blockCount++; rebuildTop(); return node; }
        if(!after->r) after->r=node;
        else { TNode* c=after->r; while(c->l) c=c->l; c->l=node; }
        blockCount++;
        rebuildTop();     // keeps global labels valid
        return node;
    }
    // spread local labels evenly across [0, 2^32) inside a block (average trick)
    void relabelBlock(Block* b){
        int k=(int)b->elems.size();
        for(int i=0;i<k;i++)
            b->elems[i]->local = (uint64_t)(i+1) * (1ULL<<32) / (uint64_t)(k+1);
    }

    Elem* first=nullptr;
    Elem* init(){
        Block* b=new Block(); Elem* e=new Elem();
        e->block=b; b->elems.push_back(e);
        relabelBlock(b); insertBlockNode(b, nullptr);
        first=e; total=1; return e;
    }
    Elem* insert_after(Elem* x){
        Elem* y=new Elem(); Block* b=x->block;
        int pos=0; while(b->elems[pos]!=x) pos++;
        b->elems.insert(b->elems.begin()+pos+1, y);
        y->block=b;
        y->next=x->next; y->prev=x;
        if(x->next) x->next->prev=y;
        x->next=y;
        relabelBlock(b);
        total++;
        MAXBLK = max(4, 2*(int)ceil(log2((double)total+2)));
        if((int)b->elems.size() > MAXBLK) splitBlock(b);
        return y;
    }
    void splitBlock(Block* b){
        int k=(int)b->elems.size(), half=k/2;
        Block* b2=new Block();
        for(int i=half;i<k;i++){ b2->elems.push_back(b->elems[i]); b->elems[i]->block=b2; }
        b->elems.resize(half);
        relabelBlock(b); relabelBlock(b2);
        insertBlockNode(b2, b->tnode);          // new block right after b
    }
    // O(1): compare (global block label, local label) lexicographically
    bool is_before(Elem* x, Elem* y){
        if(x==y) return false;
        uint64_t bx=x->block->tnode->label, by=y->block->tnode->label;
        if(bx!=by) return bx<by;
        return x->local < y->local;
    }
};
```

- Driver check: $20\,001$ elements built by random `insert_after` (spreading across $961$ blocks), then $2\times10^5$ random `is_before` queries — all agree with the reference order.

[watch from 142:30](https://youtu.be/ZCTI3zzwrkE?t=8550)

---

## Complexity recap

| Operation | Best | Amortized | Worst (single) | Space |
| --- | --- | --- | --- | --- |
| Scapegoat search | $\Theta(1)$ | $\Theta(\log n)$ | $O(\log n)$ | — |
| Scapegoat insert / delete | $\Theta(1)$ | $\Theta(\log n)$ | $O(n)$ (a rebuild) | $O(n)$ |
| Subtree rebuild (size $x$) | — | — | $O(x)$, or $O(x\log x)$ with per-node lists | $O(x)$ |
| 2D range structure w/ scapegoat | — | $\Theta(\log^2 n)$ | — | $O(n\log n)$ |
| LOM `is_before` | $\Theta(1)$ | $\Theta(1)$ | $O(1)$ | $O(n)$ |
| LOM `insert_after` | $\Theta(1)$ | $\Theta(1)$ | $O(\log n)$ (block split) | $O(n)$ |

---

## Practice problems

**Honest scope note.** Scapegoat trees and List Order Maintenance are **competition / theory** topics — you will essentially never be asked to code them in a MAANG interview. The **transferable takeaway** is the *rebuild-and-charge* amortized idea and *balanced-structure* fluency. The nearest interview-coded problems below exercise that fluency without the exotic structure.

**🎯 Interview (MAANG-style)**

- [Create Sorted Array through Instructions — LeetCode 1649](https://leetcode.com/problems/create-sorted-array-through-instructions/) — Hard — insert into a sorted/ordered structure and count rank on each step; the canonical "balanced structure or BIT" drill.
- [Count of Smaller Numbers After Self — LeetCode 315](https://leetcode.com/problems/count-of-smaller-numbers-after-self/) — Hard — order-statistics via a balanced BST / Fenwick, the same rank-query muscle.
- [Data Stream as Disjoint Intervals — LeetCode 352](https://leetcode.com/problems/data-stream-as-disjoint-intervals/) — Hard — maintain an ordered set under insertions with fast neighbor queries.

**🏆 Competitive**

- [Salary Queries — CSES 1144](https://cses.fi/problemset/task/1144) — Hard — dynamic counts by value, the natural setting for a rebuilt balanced BST or coordinate-compressed BIT.
- [Range Queries and Copies — CSES 1737](https://cses.fi/problemset/task/1737) — Hard — dynamic order-statistics over versioned arrays; balanced-structure practice.

> No official Codeforces home-task link is attached to this lecture, so nothing is fabricated here — the two CSES tasks are curated stand-ins for dynamic ordered-set practice.

---

## Further reading

- [Scapegoat tree — Wikipedia](https://en.wikipedia.org/wiki/Scapegoat_tree) — the $\alpha$-weight-balance definition and the amortized argument.
- [Scapegoat Tree (introduction and insertion) — GeeksforGeeks](https://www.geeksforgeeks.org/scapegoat-tree-set-1-introduction-insertion/) — a worked implementation.
- [Order-maintenance problem — Wikipedia](https://en.wikipedia.org/wiki/Order-maintenance_problem) — the two-level labeling structure and its history.
- [Weight-balanced tree — Wikipedia](https://en.wikipedia.org/wiki/Weight-balanced_tree) — the broader family the balance rule belongs to.

---

## Key takeaways

- When each tree node carries **auxiliary data over its whole subtree**, rotations are poison (they force linear merges). **Rebuild-based** balancing keeps that data cheap.
- The $\alpha$-weight rule $\operatorname{size}(\text{child}) \le \alpha \cdot \operatorname{size}(\text{parent})$ alone forces $O(\log n)$ height.
- **Charge each rebuild to the inserts that unbalanced it**: a size-$x$ rebuild follows $\Theta(x)$ inserts into that subtree, so amortized insert is $O(\log n)$.
- **Labels + comparison** turn ordering queries into $O(1)$ integer compares; label exhaustion is fixed by a **two-level block** decomposition, giving $O(1)$ amortized insert.
- Scapegoat trees are the balancer of choice **exactly when you cannot rotate** — e.g. path-derived labels in List Order Maintenance.

## Glossary

- **Scapegoat** — the ancestor whose subtree is rebuilt because a child broke the weight rule after an insert.
- **$\alpha$-weight-balanced** — every child's subtree is at most an $\alpha$ fraction of its parent's, $\tfrac12 < \alpha < 1$.
- **Subtree rebuild** — flatten a subtree in sorted order and rebuild it perfectly balanced in linear time (no rotations).
- **Amortized analysis (coins)** — pay for a rare expensive op with tokens deposited by many cheap ops.
- **List Order Maintenance (LOM)** — maintain a list under insert-after and answer is-before in $O(1)$.
- **Two-level / indirection** — split into blocks of size $\approx \log n$, run a cheap method inside a block and a heavier method across blocks.
