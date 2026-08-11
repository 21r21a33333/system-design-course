---
title: "S01E07 · Linked Lists & the Pointer Machine"
sidebar_position: 7
description: The pointer-machine computational model contrasted with RAM, singly and doubly linked lists with full insert/remove pointer surgery, sentinel nodes and the linked-list deque, and persistent structures via node copying.
---

# S01E07 · Linked Lists & the Pointer Machine

> **Source:** Pavel Mavrin, [_A&DS S01E07_](https://youtu.be/16MvK6W1GwU) · 1h27m lecture → ~14 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- The **pointer machine** is a computational model with **no arrays**: data lives in **nodes**, each holding a constant number of data fields plus a constant number of **pointers** to other nodes. The only moves are create a node, free a node, read/overwrite a field, and follow a pointer.
- Because you can only touch a node **if you hold a pointer to it**, the model is easier to *reason about* than RAM — which pays off for garbage collection, concurrent structures, and persistence.
- A **linked list** stores each element in its own node with a `next` pointer. Iteration is $O(n)$, indexed access is $O(n)$, but **insert/remove given a pointer is $O(1)$** — the opposite trade-off from arrays.
- A **doubly linked list** adds a `prev` pointer so you can delete a node holding only a pointer to it; **sentinel nodes** at the ends erase the null-check `if` statements and give you a clean **deque**.
- **Stacks and queues** drop out of the linked list almost for free — one-directional links, a couple of pointer assignments per operation.
- **Persistence** = keep every past version. A persistent **stack** is trivial (just retain old top pointers → a version tree). A partially persistent **linked list** uses **fat nodes** capped at two versions with amortized-$O(1)$ node copying — the headline construction of the lecture.

---

## The pointer-machine model

- In **S01E01** we fixed the **RAM model**: one big array of cells, unit-cost read/write of `a[i]` for *any* index `i`. Every structure so far assumed it.
- The **pointer machine** replaces that global array with a graph of **nodes**:
  - Each node `x` has a **constant number of fields**. A field holds either **data** (e.g. `x.a = 5`, `x.b = 7`) or a **pointer** to another node (e.g. `x.p = y`).
  - A pointer may point to another node, to the node itself, or **nowhere** (`null`). This is exactly a class instance in Java or Python.
- **Allowed operations** — all $O(1)$:
  - `x = new Node()` — allocate a node.
  - free a node when it is no longer needed.
  - `x.b = 10` — overwrite a data field.
  - `x.p = z` — repoint a pointer field to another node.
- **The one thing you cannot do: index an array.** There is no `a[i]`. If you want a collection, you must wire nodes together with pointers.

![Pointer-machine node x with data fields a=5, b=7 and pointer field p→y; the create/set operations; 'No arrays!'](/img/dsa/16MvK6W1GwU/frame-00022.png)

**Pointer machine vs RAM, point by point:**

- **Addressing.** RAM: any cell by numeric index in $O(1)$. Pointer machine: a node **only** through a pointer you already hold.
- **Collections.** RAM: arrays are primitive. Pointer machine: you must *build* lists/trees from nodes.
- **Reach / capability.** RAM is strictly more powerful (it can simulate a pointer machine by storing nodes in memory and pointers as indices). So why weaken yourself on purpose?
- **Reasoning.** A weaker model is easier to analyze. In the pointer machine, the *only* way to reach a node is to follow a pointer, so you can enumerate exactly **who can touch a node** by tracking the pointers into it.
- **Payoffs of that discipline:**
  - **Garbage collection** — a node unreachable from any root can be freed automatically (this is essentially how a tracing GC in Java works).
  - **Concurrency** — knowing the exact set of nodes that can reach a node makes it far easier to prove no other thread is looking at it before you mutate.
  - **Persistence** — the subject of the last third of the lecture.

[watch from 0:24](https://youtu.be/16MvK6W1GwU?t=24)

---

## Singly linked lists

- **Layout.** Each node stores one list element in a `data` field and one `next` pointer to the following node. A separate `first` pointer names the head; the last node's `next` is `null`.

```cpp
struct Node {
    int data;                 // payload used by your algorithm
    Node* next;               // pointer to the next node (nullptr = end)

    Node(int d) : data(d), next(nullptr) {}
};
```

- **Iterate all elements.** With an array you write `for (int i = 0; i < n; i++) cout << a[i]`. With no array, you *chase the pointers* from `first`:

```cpp
void iterate(Node* first) {
    Node* x = first;
    while (x != nullptr) {    // x != null
        cout << x->data;
        x = x->next;          // jump to the next node
    }
}
```

![The board's linked list first→…→null with the iterate loop: x=first; while x≠null: print(x); x=x.next](/img/dsa/16MvK6W1GwU/frame-00048.png)

- **What you lose vs arrays:** **indexed access.** To reach the element at position `i` you must walk from `first` through `i` links — $O(n)$, versus $O(1)$ array indexing.
- **What you gain vs arrays:** **cheap insertion in the middle.** Inserting into an array shifts everything right ($O(n)$); in a list you just rewire two pointers ($O(1)$) — provided you already hold a pointer to the insertion point.

[watch from 5:53](https://youtu.be/16MvK6W1GwU?t=353)

---

## Insert: `add_after` (singly linked)

- **Goal.** Given a pointer to node `x` and a fresh node `z`, splice `z` in right after `x`.
- **Pointer surgery.** Remember `x`'s old successor, then relink:

```cpp
void add_after(Node* x, Node* z) {
    Node* y = x->next;    // y = old successor of x (may be nullptr)
    x->next = z;          // x now points to the new node
    z->next = y;          // new node points to the old successor
}
```

- **Cost:** three field writes → $O(1)$, independent of list length.
- **Caveat the lecturer stresses:** you can only do this if you *hold a pointer to `x`*. Getting that pointer by position is the $O(n)$ walk; the splice itself is $O(1)$.

![Insertion of z between x and y drawn on the board: reroute x.next→z and z.next→y](/img/dsa/16MvK6W1GwU/frame-00056.png)

[watch from 11:53](https://youtu.be/16MvK6W1GwU?t=713)

---

## Remove, and why you need `prev`

- **Removing a node** means routing the **previous** node's `next` around it: `prev.next = x.next`.
- **The problem in a singly linked list:** to remove `x` you need the node *before* `x`, but a plain node only points forward. Holding a pointer to `x` alone is **not enough** to delete it in $O(1)$ — you'd have to re-walk from `first` to find its predecessor.
- **Fix: the doubly linked list.** Give every node a second pointer `prev` to its predecessor. Now, from `x` alone, you can reach both neighbours:

```cpp
struct DNode {
    int data;
    DNode* next;              // successor
    DNode* prev;              // predecessor

    DNode(int d) : data(d), next(nullptr), prev(nullptr) {}
};
```

[watch from 12:35](https://youtu.be/16MvK6W1GwU?t=757)

---

## Doubly linked list: insert & remove with all the `if`s

- **Insert `add_after(x, z)`** now touches **four** pointers — `x.next`, `z.next`, `z.prev`, and the successor's `prev`. The successor may be `null` (inserting after the tail), so guard that write:

```cpp
void add_after(DNode* x, DNode* z) {
    DNode* y = x->next;       // old successor (may be nullptr)
    x->next = z;
    z->next = y;
    if (y != nullptr)         // avoid null-pointer dereference at the tail
        y->prev = z;
    z->prev = x;
}
```

![The board's doubly-linked add_after(x,z): y=x.next; x.next=z; z.next=y; if y≠null: y.prev=z; z.prev=x](/img/dsa/16MvK6W1GwU/frame-00095.png)

- **Remove `remove(x)`** joins `x`'s two neighbours together, guarding each side against `null`, and fixes `first` if the head was removed:

```cpp
DNode* first = nullptr;   // global pointer to the head of the sentinel-free list

void remove(DNode* x) {
    DNode* y = x->prev;       // predecessor (may be nullptr)
    DNode* z = x->next;       // successor   (may be nullptr)
    if (z != nullptr)
        z->prev = y;
    if (y != nullptr)
        y->next = z;
    if (x == first)           // removed the head -> advance first
        first = z;
}
```

- **Data structure invariant:** for every interior node, `node->next->prev == node` and `node->prev->next == node`. Every branch above exists purely to keep that invariant true at the two boundaries (head/tail) where a neighbour is `null`.

![The board's remove(x): y=x.prev; z=x.next; if z≠null: z.prev=y; if y≠null: y.next=z; if x=first: first=z](/img/dsa/16MvK6W1GwU/frame-00104.png)

- **Why this is unpleasant:** even these tiny routines already carry **three `if`s**. Every branch is a code path you must test, and an untested branch is where bugs hide. The lecturer's next move is to make the branches disappear.

[watch from 17:06](https://youtu.be/16MvK6W1GwU?t=1026)

---

## Sentinel nodes and the deque

- **Trick: add dummy end nodes.** Put one extra node before the first real element and one after the last. Point `first` and `last` at these **sentinels**. They carry no payload and are **never removed**.
- **Effect:** every *real* node now always has a non-null `prev` and `next` — the sentinels stand in for the boundaries. So `add_after` and `remove` lose **all** their `if`s: no null neighbour can ever occur, and you never delete a sentinel, so `first`/`last` never move.
- **This structure is exactly a deque** (double-ended queue): you can push/pop at both ends, and iterate in either direction, all in $O(1)$.
- **Even slicker — one circular sentinel.** The front sentinel only ever uses its `next` and the back sentinel only its `prev`, so you can merge them into **one** dummy node whose `next` is the first real node and whose `prev` is the last. That gives a **circular doubly linked list**: follow the dummy's `next` to walk forward, its `prev` to walk backward.
- **Concatenation is $O(1)$.** With sentinels, joining two lists is just dropping one dummy and rewiring a couple of pointers; likewise a list can be split in a constant number of writes.

![Circular doubly linked list with a single sentinel node linking the head and tail (the deck construction)](/img/dsa/16MvK6W1GwU/frame-00121.png)

[watch from 21:31](https://youtu.be/16MvK6W1GwU?t=1291)

---

## Stacks and queues from a linked list

- **Stack** (LIFO). Only the **top** moves, and `pop` needs to step from the top to the element *below* it — a jump **right-to-left**. So a **single** `next` pointer chaining top → below-top → … suffices:

```cpp
Node* top = nullptr;  // pointer to the current top node, nullptr if empty

void push(Node* x) {
    x->next = top;    // new node points down to old top
    top = x;          // top is now the new node
}

Node* pop() {
    Node* res = top;  // remember the node we are removing
    top = top->next;  // advance top to the node below
    return res;
}
```

![The board's stack: nodes chained right-to-left to top; push(x): x.next=top; top=x. pop(): res=top; top=top.next; return res](/img/dsa/16MvK6W1GwU/frame-00161.png)

- **Queue** (FIFO). Keep both a `head` (dequeue end) and a `tail` (enqueue end). `add` appends after `tail`; `remove` advances `head` — both need links pointing **left-to-right** (head → … → tail). Empty-queue is the only special case:

```cpp
Node* head = nullptr;
Node* tail = nullptr;

void add(Node* x) {
    if (head == nullptr) {    // empty queue
        head = tail = x;
    } else {
        tail->next = x;       // link old tail to new node
        tail = x;             // tail is now the new node
    }
}

Node* remove() {
    Node* res = head;         // node to dequeue
    if (head == tail)         // queue had exactly one element
        head = tail = nullptr;
    else
        head = head->next;    // advance head
    return res;
}
```

![The board's queue: head→…→tail; add(x) with the empty-queue guard, remove() with the single-element guard](/img/dsa/16MvK6W1GwU/frame-00173.png)

- **Takeaway:** these are barely longer than the array versions from **S01E06** — the pointer machine is not much harder to program with than RAM for these workhorses.

[watch from 23:17](https://youtu.be/16MvK6W1GwU?t=1397)

---

## Persistent data structures

- **Ordinary (ephemeral) structures** throw the past away: an operation moves the structure from an old state to a new state, and you keep only the new one.
- **Persistent structures** retain **every** past version, so after a sequence of updates you can still query (and sometimes branch from) any earlier version. Think of it as version control for a data structure.
- **Two flavours:**
  - **Fully persistent** — you may branch *and* update from any version. Versions form a **tree**, and two versions can be incomparable ("which is older?" has no answer).
  - **Partially persistent** — you may read any old version but only **update the latest** one. Versions then form a **line**, so they carry a natural total order (version 1, 2, 3, …). That linear order is exactly what makes the linked-list construction below run in linear time.
- **Big fact:** almost any structure built in the *pointer machine* can be made persistent with no extra asymptotic cost. The lecture shows this concretely for a stack and a linked list rather than proving the general theorem.

[watch from 45:04](https://youtu.be/16MvK6W1GwU?t=2705)

---

## Persistent stack: free by construction

- Recall `push` only does `x.next = top; top = x`, and `pop` only *moves* `top` — **it never mutates an existing node.** That is the whole trick.
- To keep a version around, **just remember its `top` pointer.** All the old nodes are still there, still pointing down the chain.
- **Worked example from the board** (elements `A B C D` then operations):
  - Push `E` onto version `v1` (top at `D`): create `E`, `E.next = D`, and set a **new** pointer `top2 = E`. Now `top1→D` still reads the old stack `A B C D`, and `top2→E` reads `A B C D E`. Both versions coexist.
  - Pop from `v2`: no node changes — a new pointer `top3` simply points back at `D`. Version 3 is the stack `A B C D` again, sharing all its nodes.
  - Branch: from `v2`'s top (`E`) push `F` → `top4 = F`. From `v3`'s top (`D`) push `G` → `top5 = G`.
- The nodes therefore form a **tree** rooted at the bottom of the stack; each version is a leaf-ward pointer into it. Every push adds one node; nothing is ever copied.

![The persistent stack: node tree A-B-C-D with E,F hanging off D→E and G off D, plus the version DAG v1→v2→(v3,v4) with top1..top6](/img/dsa/16MvK6W1GwU/frame-00248.png)

- **Cost:** $O(1)$ per operation, same as the ephemeral stack — persistence is *free* here.
- **Why the queue is harder:** a queue mutates the `tail.next` of an existing node on every enqueue, so branching from an old version would demand a *second* `next` pointer on a node that already has one. The clean fix is to build a queue out of two persistent stacks — but that inherits the stacks' *amortized* $O(1)$, and amortization breaks under full persistence (you can repeatedly branch just before an expensive operation and pay the worst case every time). A real-time queue from a handful of stacks fixes this, but is beyond this lecture.

[watch from 48:30](https://youtu.be/16MvK6W1GwU?t=2915)

---

## Partially persistent linked list: fat nodes

- **Setup.** We want a linked list supporting `add_after(x, z)`, `remove(x)`, and `iterate()`, **partially persistent**: read any version, modify only the latest. Number the versions `1, 2, 3, …` in their linear order.
- **The obstacle.** Inserting `y` between `x` and `z` must change `x.next` and `z.prev`. But if we overwrite those fields we destroy the *old* version, which some earlier reader still needs.
- **Fat nodes — store two versions inside one node.** Each node keeps up to **two** copies of its fields plus a **version stamp** saying when the second copy took effect:

```cpp
struct FatNode {
    // version 1 of the fields
    int data1;
    FatNode* prev1;
    FatNode* next1;
    // version 2 of the fields (filled in on the first later change)
    int data2;
    FatNode* prev2;
    FatNode* next2;
    // the version at/after which copy 2 becomes active
    long long since;          // -1 means "only copy 1 exists"

    FatNode(int data)
        : data1(data), prev1(nullptr), next1(nullptr),
          data2(0), prev2(nullptr), next2(nullptr), since(-1) {}

    FatNode* next_at(long long version) {
        // pick the correct successor for the version we are reading
        if (since != -1 && version >= since) return next2;
        return next1;
    }

    FatNode* prev_at(long long version) {
        // symmetric reader for the predecessor pointer
        if (since != -1 && version >= since) return prev2;
        return prev1;
    }
};
```

- **Reading a version.** A global `version` selects which copy to follow. To step forward from a fat node you call `next_at(version)`: if `version` is at least the node's `since` stamp, follow copy 2, else copy 1. Choosing between **two** copies is $O(1)$ — that is why the cap is two.

![Fat node with fields data1/prev1/next1, data2/prev2/next2 and a version stamp; the alternative helper-node encoding x'→(version)→x](/img/dsa/16MvK6W1GwU/frame-00316.png)

- **Two field-writers that copy on overflow.** All mutation goes through `write_next`/`write_prev`. A **slim** node (no copy 2 yet) simply fills its second slot and stays put. A node that is **already fat** has no room for a third version, so we clone it into a fresh slim node carrying the new pointer — and now whoever pointed at the old node must point at the **clone** instead. Repointing that neighbour is itself a write, so it may **cascade** until we reach a node with a free slot (or run off the end and copy the rest of the list).
- **The load-bearing rule:** each writer **returns the node that now carries this identity** — the original if it was slim, or the clone if it was fat — and *every caller must adopt that return value*. The sketch below shows the mechanism; the crucial detail is that the cascade rewires the returned clone, never discards it. (The lecturer draws this on the board rather than coding it; the entry point into the list must itself be tracked per version so a cloned head is not lost.)

```cpp
long long version = 1;                       // global current version

FatNode* write_next(FatNode* node, FatNode* target) {
    // set node->next = target as of the current `version`; return the live node
    if (node->since == -1) {                 // slim node: fill copy 2 in place
        node->data2 = node->data1;           // inherit the unchanged fields...
        node->prev2 = node->prev1;
        node->next2 = target;                // ...then apply the change
        node->since = version;
        return node;                         // identity unchanged
    }
    // already fat -> clone into a slim node and cascade left
    FatNode* clone = new FatNode(node->data2);
    clone->next1 = target;
    clone->prev1 = node->prev2;
    if (node->prev2 != nullptr)              // predecessor must now point at the clone
        clone->prev1 = write_next(node->prev2, clone);   // adopt the (maybe cloned) pred
    return clone;                            // caller must repoint to this
}

FatNode* write_prev(FatNode* node, FatNode* target) {
    // symmetric: set node->prev = target as of the current `version`
    if (node->since == -1) {
        node->data2 = node->data1;
        node->next2 = node->next1;
        node->prev2 = target;
        node->since = version;
        return node;
    }
    FatNode* clone = new FatNode(node->data2);
    clone->prev1 = target;
    clone->next1 = node->next2;
    if (node->next2 != nullptr)
        clone->next1 = write_prev(node->next2, clone);   // adopt the (maybe cloned) succ
    return clone;
}
```

- **Insert.** To splice a fresh node `y` between adjacent nodes `x` and `z` at a new version: bump `version`, wire `y`'s own (copy-1) pointers, then push the two neighbour changes through the writers — **adopting each returned node** so a cloned neighbour is not orphaned.

```cpp
FatNode* add_after(FatNode* x, int z) {
    // x is a fat node; splice a fresh node carrying payload z right after it
    version += 1;
    FatNode* old_next = x->next_at(version - 1);   // x's successor in the previous version
    FatNode* y = new FatNode(z);                   // brand-new node lives only in this version
    y->prev1 = x;
    y->next1 = old_next;
    x = write_next(x, y);                // x -> y from this version on (adopt clone)
    y->prev1 = x;                        // y's predecessor is the live x
    if (old_next != nullptr) {
        FatNode* new_next = write_prev(old_next, y);   // old successor's prev -> y (adopt clone)
        y->next1 = new_next;
    }
    return y;
}
```

- **Why the cap is exactly two.** With at most two versions per node, `next_at`/`prev_at` decide in $O(1)$, so `iterate()` stays $O(n)$. Allow three or more and you would need a **balanced BST over the versions** inside each node — an extra $\log v$ factor per step, where $v$ is the number of versions.
- **Amortized cost is $O(1)$.** Use the **potential** $\Phi = $ number of fat (two-copy) nodes. A long operation that copies $k$ nodes turns $k$ fat nodes back into slim/new ones ($\Delta\Phi \approx -k$) while creating only the two new fat neighbours ($+2$). Actual cost $k$ plus $\Delta\Phi = -k + 2$ gives amortized cost $\approx 2 = O(1)$. Partial persistence is what makes this potential argument valid — you can never revisit and re-trigger the same expensive copy.

![Node copying on a full insert: fat node x is copied to a new node and the change cascades left toward the nearest slim node (version=…, cur=…)](/img/dsa/16MvK6W1GwU/frame-00300.png)

- **Encoding note.** "Fat node" can be realized two ways, both $O(1)$-size and both fine:
  - one node with a double set of fields plus the version stamp, or
  - a small **helper node** holding the version and two pointers, one to each version copy.

[watch from 1:05:56](https://youtu.be/16MvK6W1GwU?t=3956)

---

## Complexity recap

| Operation | Array (RAM) | Singly linked | Doubly linked | Space |
| --- | --- | --- | --- | --- |
| Access element `i` | $O(1)$ | $O(n)$ | $O(n)$ | — |
| Iterate all | $O(n)$ | $O(n)$ | $O(n)$ | $O(1)$ extra |
| Insert given a pointer | $O(n)$ | $O(1)$ | $O(1)$ | $O(1)$ |
| Remove given a pointer | $O(n)$ | $O(n)$ * | $O(1)$ | $O(1)$ |
| Push / pop (stack) | $O(1)$ | $O(1)$ | $O(1)$ | $O(1)$ |
| Enqueue / dequeue (queue) | $O(1)$ amort. | $O(1)$ | $O(1)$ | $O(1)$ |
| Concatenate two lists | $O(n)$ | $O(1)$ ** | $O(1)$ | $O(1)$ |
| Persistent stack op | — | $O(1)$ | $O(1)$ | $O(1)$/op |
| Partially persistent list op | — | — | $O(1)$ amortized | $O(1)$ amortized |

\* singly linked remove is $O(1)$ only if you already hold the *predecessor*; otherwise $O(n)$ to find it.
\*\* with a tail pointer / sentinel.

---

## Practice problems

**Reality check on scope.** The **pointer-machine model** and the **persistence** constructions are *theory* — they show up in advanced courses and research, essentially never in a standard interview loop. But **linked-list pointer manipulation itself is one of the most heavily tested interview topics.** Master the surgery below; treat the persistence section as conceptual depth.

**🎯 Interview (MAANG-style)**

- [Reverse Linked List — LeetCode 206](https://leetcode.com/problems/reverse-linked-list/) — Easy — the canonical three-pointer `prev`/`cur`/`next` rewiring.
- [Merge Two Sorted Lists — LeetCode 21](https://leetcode.com/problems/merge-two-sorted-lists/) — Easy — splice two lists with a dummy/sentinel head.
- [Linked List Cycle — LeetCode 141](https://leetcode.com/problems/linked-list-cycle/) — Easy — Floyd's slow/fast pointer detection.
- [Remove Nth Node From End of List — LeetCode 19](https://leetcode.com/problems/remove-nth-node-from-end-of-list/) — Medium — two-pointer gap; a dummy head kills the head-removal `if`.
- [Add Two Numbers — LeetCode 2](https://leetcode.com/problems/add-two-numbers/) — Medium — build a result list node-by-node while carrying.
- [Copy List with Random Pointer — LeetCode 138](https://leetcode.com/problems/copy-list-with-random-pointer/) — Medium — clone a pointer graph; the interview cousin of "copy the nodes."
- [LRU Cache — LeetCode 146](https://leetcode.com/problems/lru-cache/) — Medium — doubly linked list + hash map, using sentinel head/tail exactly as taught here.
- [Doubly Linked List — GeeksforGeeks](https://www.geeksforgeeks.org/doubly-linked-list/) — Easy/Medium — implement the `prev`/`next` operations from scratch.

**🏆 Competitive**

- [Concert Tickets — CSES 1091](https://cses.fi/problemset/task/1091) — Easy — ordered multiset / two-pointer style greedy over a maintained collection.
- [Sliding Window Median — CSES 1076](https://cses.fi/problemset/task/1076) — Medium — maintain an evolving ordered structure as a window slides (list/heap intuition).
- [Official home tasks & discussion — Codeforces](https://codeforces.com/blog/entry/84009) — the problem set Pavel assigned for this lecture (linked from the video description).

---

## Further reading

- [Linked list — Wikipedia](https://en.wikipedia.org/wiki/Linked_list) and [Doubly linked list — Wikipedia](https://en.wikipedia.org/wiki/Doubly_linked_list).
- [Pointer machine — Wikipedia](https://en.wikipedia.org/wiki/Pointer_machine) — the formal model and its variants.
- [Persistent data structure — Wikipedia](https://en.wikipedia.org/wiki/Persistent_data_structure) — fat nodes, path copying, and the general result.
- [Linked List — GeeksforGeeks](https://www.geeksforgeeks.org/data-structures/linked-list/) and [Persistent Data Structures — GeeksforGeeks](https://www.geeksforgeeks.org/persistent-data-structures/).
- [Deleting from a data structure in O(log n) — cp-algorithms](https://cp-algorithms.com/data_structures/deleting_in_log_n.html) — a related "roll back the versions" technique.

---

## Key takeaways

- The pointer machine drops arrays and keeps nodes-with-pointers; you touch a node only by holding a pointer to it, which is a **weakness that buys analyzability** (GC, concurrency, persistence).
- Lists invert the array trade-off: $O(n)$ indexed access, but $O(1)$ insert/remove *given a pointer*.
- You need `prev` to delete in $O(1)$; **sentinel nodes** then erase the boundary `if`s and hand you a deque.
- Stacks and queues are a few pointer writes each; a persistent **stack** is free because its operations never mutate existing nodes.
- The partially persistent linked list is the payoff: **fat nodes capped at two versions** + cascading copies give amortized $O(1)$ updates and $O(n)$ iteration.

## Glossary

- **Pointer machine** — model where data lives in nodes with a constant number of data and pointer fields; no arrays, only pointer following.
- **Linked list** — nodes each holding one element and a `next` pointer; optionally a `prev` pointer (doubly linked).
- **Sentinel node** — a payload-free dummy node at a boundary so real nodes always have non-null neighbours, removing edge-case branches.
- **Deque** — double-ended queue; push/pop/iterate at both ends in $O(1)$, naturally a doubly linked list with sentinels.
- **Persistent structure** — retains all past versions; **fully** persistent allows branching from any version, **partially** persistent allows updates only to the latest.
- **Fat node** — a node storing up to two versions of its fields plus a version stamp, the building block of the partially persistent list.
- **Potential function** — a bookkeeping quantity (here, the count of fat nodes) used to prove amortized cost.
