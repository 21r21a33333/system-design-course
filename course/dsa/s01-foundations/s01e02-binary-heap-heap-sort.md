---
title: "S01E02 · Binary Heap & Heap Sort"
sidebar_position: 2
description: What a data structure is, the priority-queue interface, the binary-heap array layout with parent/child index math, sift-up and sift-down, extract-min, in-place heap sort, and the O(n) bottom-up build-heap proof.
---

# S01E02 · Binary Heap & Heap Sort

> **Source:** Pavel Mavrin, [_A&DS S01E02_](https://youtu.be/koyuy564TZ8) · 1h25m lecture → ~14 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- A **data structure** is chosen by the **operations** you need — decide the operations first, then pick the structure; each operation gets its own complexity.
- A **priority queue** (heap) supports `insert(x)` and `remove_min()`. A plain array gives $O(1)$ insert but $O(n)$ remove; a sorted array flips that. The **binary heap** makes *both* $O(\log n)$.
- The heap is an **almost-complete binary tree** with the **heap property**: every node is $\le$ its children. It is stored in a flat array — node $i$ has children $2i+1$, $2i+2$ and parent $\lfloor (i-1)/2 \rfloor$; no pointers.
- `insert` appends at the end and **sifts up**; `remove_min` swaps root with the last element, shrinks, and **sifts down** the new root past the smaller child. Both walk one tree path $= O(\log n)$.
- **Heap sort** builds a heap from the array, then repeatedly extracts — $O(n \log n)$, and it runs **in place** by reusing the array's front as the heap and its back as the sorted tail.
- **Building a heap bottom-up with sift-down is $O(n)$**, not $O(n \log n)$: most nodes are near the leaves and sift down a tiny distance. This is the headline analysis of the lecture.

---

## What is a data structure?

- A data structure is *structure imposed on data so you can operate on it*. Dumping everything into one flat array and "encoding" it is possible, but then answering queries (find an element, get last-year's average) is slow.
- **Operations come first, structure second.** You decide which operations your algorithm needs, and *those* operations pick the structure — not the other way round.
- Structures are grouped into **classes** defined by the operations they support. Two structures in the same class expose the same interface but trade off *which* operation is fast.
- **Analyze each operation separately.** A structure can be $O(1)$ for one operation and $O(n)$ for another; there is no single "complexity of the structure."
- **Simplest example — the array (really a primitive):** two operations, both $O(1)$.

```cpp
// array as a primitive: index in, value out
int get(vector<int>& a, int i) {   // get(i)  -> a[i]
    return a[i];                   // O(1)
}

void put(vector<int>& a, int i, int v) {   // put(i, v) -> a[i] = v
    a[i] = v;                              // O(1)
}
```

- Algorithms and data structures are intertwined: an operation is implemented by an algorithm, and algorithms lean on data structures to go faster — so the course develops them together.

![Operations define the structure; array primitive with O(1) get/put, and the priority-queue interface insert(x) / remove_min()](/img/dsa/koyuy564TZ8/frame-00040.png)

[watch from 5:22](https://youtu.be/koyuy564TZ8?t=322)

---

## The priority-queue interface

- A **heap** (a.k.a. **priority queue**) holds a set of comparable elements and supports two operations today:
  - `insert(x)` — add an element.
  - `remove_min()` — remove and return the smallest element (there is always a unique minimum under the comparator).
- Before the real heap, two naive attempts fix ideas and set the bar. Both keep the set in the first $n$ cells of a big-enough array.

**Attempt 1 — unsorted array.** Insert at the end; scan to find the min on removal.

```cpp
struct UnsortedArrayPQ {
    vector<int> a;
    int n;

    UnsortedArrayPQ(int capacity) : a(capacity), n(0) {}

    void insert(int x) {          // O(1)
        a[n] = x;
        n++;
    }

    int remove_min() {            // O(n)
        int j = 0;
        for (int i = 1; i < n; i++) {
            if (a[i] < a[j])
                j = i;                         // index of the current minimum
        }
        swap(a[j], a[n - 1]);
        n--;
        return a[n];              // the min now sits just past the new end
    }
};
```

- On removal we swap the min into the last slot and shrink `n`, so no hole is left in the middle. Insert is $O(1)$, remove is $O(n)$ (the scan).

**Attempt 2 — array sorted in decreasing order.** Now the min is always last, so removal is trivial; insertion must slide the new element into place (exactly the insertion-sort inner loop from S01E01).

```cpp
struct SortedArrayPQ {             // kept in DECREASING order
    vector<int> a;
    int n;

    SortedArrayPQ(int capacity) : a(capacity), n(0) {}

    int remove_min() {             // O(1): min is at the end
        n--;
        return a[n];
    }

    void insert(int x) {           // O(n): keep the array sorted
        a[n] = x;
        n++;
        int i = n - 1;
        while (i > 0 && a[i] > a[i - 1]) {   // bubble left while too big
            swap(a[i], a[i - 1]);
            i--;
        }
    }
};
```

![Sorted-array PQ (decreasing order): O(1) remove-min at the end, O(n) insert that bubbles the new element left](/img/dsa/koyuy564TZ8/frame-00088.png)

- **The trade-off.** Real algorithms interleave $n$ inserts and $n$ removes. Attempt 1 costs $n \cdot O(1) + n \cdot O(n) = \Theta(n^2)$; attempt 2 is the same $\Theta(n^2)$ the other way round. We want both operations sub-linear.

| Structure | `insert` | `remove_min` | $n$ of each |
| --- | --- | --- | --- |
| Unsorted array | $O(1)$ | $O(n)$ | $\Theta(n^2)$ |
| Sorted array | $O(n)$ | $O(1)$ | $\Theta(n^2)$ |
| **Binary heap** | $O(\log n)$ | $O(\log n)$ | $\Theta(n \log n)$ |

[watch from 12:20](https://youtu.be/koyuy564TZ8?t=740)

---

## The binary heap: shape and the heap property

- A **binary tree**: each node has at most two children (a left and a right child).
- The heap's tree is **almost complete**: every level is completely full except possibly the last, which is filled **left to right**. So the *shape* is fixed by $n$ alone — 10 elements always give the same silhouette.
- Each node stores one set element. The ordering invariant is the **heap property (min-heap):**

$$
\forall\, \text{node } v:\quad h[v] \le h[\text{left}(v)] \quad\text{and}\quad h[v] \le h[\text{right}(v)]
$$

- Equivalently, every node is $\le$ all of its descendants. There is **no** left-right ordering between siblings — only the parent-child relation matters.
- **Consequence:** the global minimum sits at the **root**. That is what makes `remove_min` cheap to *locate*.

![Almost-complete binary tree of 10 nodes with the heap property (each node ≤ its children); root holds the minimum](/img/dsa/koyuy564TZ8/frame-00105.png)

[watch from 24:17](https://youtu.be/koyuy564TZ8?t=1457)

---

## Array representation and index math

- A general binary tree needs `node` objects with left/right pointers. But here the shape is fixed by $n$, so we skip pointers entirely and **number the nodes level by level, left to right**: root $= 0$, then $1, 2, 3, \dots$
- Store the elements in a flat array `h` at those indices. To "follow a pointer" we just compute an index:

$$
\text{left}(i) = 2i + 1, \qquad \text{right}(i) = 2i + 2, \qquad \text{parent}(i) = \left\lfloor \frac{i - 1}{2} \right\rfloor
$$

- **Why the parent formula collapses to one case.** A left child has index $2p+1$, a right child $2p+2$ for parent $p$.
  - Left child $i = 2p+1$: $\dfrac{i-1}{2} = \dfrac{2p}{2} = p$.
  - Right child $i = 2p+2$: $\dfrac{i-1}{2} = \dfrac{2p+1}{2} = p + 0.5$, and $\lfloor p + 0.5 \rfloor = p$.
  - So $\lfloor (i-1)/2 \rfloor$ recovers the parent in *both* cases — one formula, floored.
- These identities hold because the tree is complete: level $k$ holds exactly $2^k$ nodes packed left to right, which is provable by induction on $i$.

```cpp
int left(int i)   { return 2 * i + 1; }
int right(int i)  { return 2 * i + 2; }
int parent(int i) { return (i - 1) / 2; }   // integer division = ⌊(i-1)/2⌋
```

- **Why arrays, not linked lists:** an array gives $O(1)$ random access by index, which every navigation step above relies on. A linked list cannot jump to index $i$ in one step.

![Level-order numbering 0..9 of the heap; children 2i+1 / 2i+2 and parent ⌊(i-1)/2⌋ let one array replace all pointers](/img/dsa/koyuy564TZ8/frame-00169.png)

[watch from 28:13](https://youtu.be/koyuy564TZ8?t=1693)

---

## Insert: append and sift up

- **Where to put a new element** so the tree stays almost complete? The one free spot: the next slot in the last level, i.e. index `n`. Appending there never breaks the *shape*.
- That append can break the *heap property* on the single edge from the new node to its parent. Fix it by **sifting up**: while the node is smaller than its parent, swap them. Each swap moves the violation up one level; everything else stays valid.

```cpp
struct BinaryHeap {
    vector<int> h;
    int n;

    BinaryHeap(int capacity) : h(capacity), n(0) {}

    void insert(int x) {
        h[n] = x;                     // append in the last position
        n++;
        int i = n - 1;
        while (i > 0 && h[i] < h[parent(i)]) {   // heap property broken?
            int p = parent(i);
            swap(h[i], h[p]);                    // swap up
            i = p;
        }
    }

    // ... remove_min defined below, in the same struct ...
};
```

- **Walkthrough (insert 4 into the 10-node heap).** 4 lands as a new leaf; it is smaller than parent 13, swap; smaller than parent 5, swap; parent is now the root value 2, and $4 \ge 2$, stop. Duplicate keys (`insert 2` when a 2 exists) are fine — the $\le$ comparison keeps them valid.
- **Complexity.** The loop climbs at most the height of the tree. An almost-complete tree of $n$ nodes has height $\lfloor \log_2 n \rfloor$, so `insert` is $O(\log n)$.

![insert(x): put x at index n, then sift up swapping with parent ⌊(i-1)/2⌋ while smaller — O(log n) up one root-path](/img/dsa/koyuy564TZ8/frame-00194.png)

[watch from 35:00](https://youtu.be/koyuy564TZ8?t=2100)

---

## Remove-min: swap-to-root and sift down

- The minimum is at the root (index 0). Deleting the root directly would split the tree in two, which is awkward to re-merge.
- **Trick:** overwrite the root with the **last** element (removing a *leaf* keeps the shape almost-complete), shrink `n`, then repair by **sifting down**.
- **Sift down** the demoted root: compare it with its children, swap it with the **smaller** child, and repeat until it is $\le$ both children (or it reaches the bottom). Using the *smaller* child guarantees the promoted child is $\le$ the other child too, so both edges heal at once.

```cpp
    // member function of BinaryHeap (see the struct above)
    int remove_min() {
        swap(h[0], h[n - 1]);              // root <-> last
        n--;
        int i = 0;
        while (2 * i + 1 < n) {            // while a left child exists
            int j = 2 * i + 1;            // assume left child is the smaller
            if (2 * i + 2 < n && h[2 * i + 2] < h[j])
                j = 2 * i + 2;            // right child is smaller
            if (h[j] >= h[i])             // both children already >= node
                break;
            swap(h[i], h[j]);             // swap down
            i = j;
        }
        return h[n];                      // the old min, now just past the end
    }
```

- **Child-count handling.** The guard `2i+1 < n` means "a left child exists." If there is no left child there is no right child either (higher index), so we are at a leaf and stop. Otherwise there is at least one child; the inner `if` checks for a right child before comparing.
- **Complexity.** Like sift-up, sift-down walks one root-to-leaf path, so `remove_min` is $O(\log n)$.

![remove_min(): swap root with last, shrink n, then sift down past the smaller child (2i+1 / 2i+2) — O(log n)](/img/dsa/koyuy564TZ8/frame-00259.png)

[watch from 52:39](https://youtu.be/koyuy564TZ8?t=3159)

---

## Heap sort

- **The one-liner idea.** Push every element into a heap, then pop them all: they come out in increasing order.

```cpp
vector<int> heap_sort_naive(vector<int>& a) {
    BinaryHeap hp(a.size());
    for (int x : a)
        hp.insert(x);                      // n inserts, O(log n) each
    vector<int> out;
    out.reserve(a.size());
    for (size_t k = 0; k < a.size(); k++)
        out.push_back(hp.remove_min());    // n removes, O(log n) each
    return out;
}
```

- $n$ inserts $+$ $n$ removes, each $O(\log n)$ $\Rightarrow$ $O(n \log n)$ — same class as merge sort. But this uses a **second array** of size $n$ for the heap.

**Making it in place.** Two observations let us reuse the input array `a` with **no extra array**:

- While inserting, the prefix of `a` we have already consumed and the prefix of the heap we have filled are the *same length*. So split `a` in two conceptually — grow the heap into the front, shrinking the "unprocessed" region — and the two never collide.
- Each new element is *already in the right array slot* (index `n` of the heap); we just enlarge the heap by one and **sift it up**.
- After the whole array is one big heap, extract repeatedly. Each `remove_min` swaps the root to the current last heap slot and shrinks the heap — freeing that slot for the sorted output, filled **from the right**.

```cpp
void sift_up(vector<int>& h, int i) {
    while (i > 0 && h[i] < h[parent(i)]) {
        int p = parent(i);
        swap(h[i], h[p]);
        i = p;
    }
}

void sift_down(vector<int>& h, int i, int size) {
    while (2 * i + 1 < size) {
        int j = 2 * i + 1;
        if (2 * i + 2 < size && h[2 * i + 2] < h[j])
            j = 2 * i + 2;
        if (h[j] >= h[i])
            break;
        swap(h[i], h[j]);
        i = j;
    }
}

vector<int>& heap_sort(vector<int>& a) {
    int n = a.size();
    // phase 1: build a min-heap in place by sifting each new element up
    for (int i = 0; i < n; i++)
        sift_up(a, i);                          // a[0..i] is a heap
    // phase 2: repeatedly move the min to the back
    for (int size = n; size > 0; size--) {
        swap(a[0], a[size - 1]);                // min -> sorted tail
        sift_down(a, 0, size - 1);              // restore heap on the shrunk front
    }
    return a;                                   // sorted in DECREASING order
}
```

- **Direction note.** A min-heap that fills the tail with successive minima leaves the array **decreasing**. To get increasing order, either reverse at the end, or build a **max-heap** (flip every comparison) so the tail fills with maxima.
- **Complexity.** Phase 1 as written is $n$ sift-ups $= O(n \log n)$; phase 2 is $n$ sift-downs $= O(n \log n)$. Total $O(n \log n)$, in place, $O(1)$ extra memory. The next section speeds up phase 1.

![Heap sort in place: sift_up loop builds the heap in a's front, sift_down loop empties the min into a's back](/img/dsa/koyuy564TZ8/frame-00312.png)

[watch from 1:02:10](https://youtu.be/koyuy564TZ8?t=3730)

---

## Building a heap in O(n)

- **Insert-one-by-one (sift up) is $O(n \log n)$.** Cost depends on a node's *height above the leaves* — how far it can rise. Level $k$ (from the top, root $=0$) has $2^k$ nodes, and each may sift up $k$ steps:

$$
\sum_{k=0}^{\log n} 2^k \cdot k \;=\; \Omega(n \log n)
$$

  The pain is that the **bottom level has the most nodes** ($\approx n/2$) and each of those can travel the full $\log n$ up to the root.

- **Bottom-up (sift down) is $O(n)$.** Process nodes from the last internal node up to the root, sifting each **down**. Now a node's cost is its distance to the **bottom**, i.e. $\log n - k$ for level $k$:

$$
\sum_{k=0}^{\log n} 2^k \,(\log n - k) \;=\; O(n)
$$

- **Why the second sum is linear (swap-counting argument).** Count, per level, the swaps needed to sift *all* elements below it. Each element from the levels above $k$ crosses the edge from level $k$ to level $k+1$ **at most once** during the whole build, so that edge-crossing costs at most $2^k$ swaps. Summing a geometric series:

$$
\sum_{k=0}^{\log n} 2^k \;=\; 2^{\log n + 1} - 1 \;=\; 2n - 1 \;=\; O(n)
$$

- **Intuition.** The many bottom nodes are cheap (they barely move); the few top nodes are expensive but rare. The product stays linear. Building a heap is therefore *strictly faster* than $n$ separate inserts.

```cpp
vector<int>& build_heap(vector<int>& a) {
    int n = a.size();
    // last internal node is parent(n-1); leaves need no work
    for (int i = parent(n - 1); i >= 0; i--)
        sift_down(a, i, n);
    return a;                   // a is now a valid min-heap, built in O(n)
}
```

- Swapping phase 1 of `heap_sort` for `build_heap` makes the build $O(n)$; the overall sort is still $O(n \log n)$ (phase 2 dominates), but with a smaller constant and a cleaner analysis.

![Build-heap: sift-up sum Σ 2^k·k = Ω(n log n) vs bottom-up sift-down sum Σ 2^k·(log n − k) = O(n)](/img/dsa/koyuy564TZ8/frame-00337.png)

[watch from 1:16:09](https://youtu.be/koyuy564TZ8?t=4569)

---

## Complexity recap

| Operation | Best | Average | Worst | Space |
| --- | --- | --- | --- | --- |
| `insert` (sift up) | $\Theta(1)$ | $\Theta(\log n)$ | $\Theta(\log n)$ | $O(1)$ |
| `remove_min` (sift down) | $\Theta(1)$ | $\Theta(\log n)$ | $\Theta(\log n)$ | $O(1)$ |
| `find_min` (read root) | $\Theta(1)$ | $\Theta(1)$ | $\Theta(1)$ | $O(1)$ |
| Build heap (insert one by one) | $\Theta(n)$ | $\Theta(n \log n)$ | $\Theta(n \log n)$ | $O(1)$ |
| Build heap (bottom-up sift down) | $\Theta(n)$ | $\Theta(n)$ | $\Theta(n)$ | $O(1)$ |
| Heap sort | $\Theta(n \log n)$ | $\Theta(n \log n)$ | $\Theta(n \log n)$ | $O(1)$ |

- Heap sort is **not stable** (swaps across the array reorder equal keys), but it is $\Theta(n \log n)$ *always* and needs only $O(1)$ extra memory — its edge over merge sort.

---

## Practice problems

The interview payload of this lecture is the **top-k / streaming-median** family (a heap in disguise) and implementing the heap operations themselves.

**🎯 Interview (MAANG-style)**

- [Kth Largest Element in an Array — LeetCode 215](https://leetcode.com/problems/kth-largest-element-in-an-array/) — Medium — a size-$k$ min-heap, the canonical heap interview question.
- [Last Stone Weight — LeetCode 1046](https://leetcode.com/problems/last-stone-weight/) — Easy — repeated extract-max, a direct max-heap drill.
- [Top K Frequent Elements — LeetCode 347](https://leetcode.com/problems/top-k-frequent-elements/) — Medium — heap keyed by frequency.
- [Merge k Sorted Lists — LeetCode 23](https://leetcode.com/problems/merge-k-sorted-lists/) — Hard — a heap of $k$ list heads; each pop is a `remove_min`.
- [Find Median from Data Stream — LeetCode 295](https://leetcode.com/problems/find-median-from-data-stream/) — Hard — two heaps (max-heap + min-heap) balancing around the median.
- [Kth Largest Element in a Stream — LeetCode 703](https://leetcode.com/problems/kth-largest-element-in-a-stream/) — Easy — maintain a bounded heap as elements arrive.
- [Heap Sort — GeeksforGeeks](https://www.geeksforgeeks.org/heap-sort/) — Medium — implement sift-down and the two-phase sort from scratch.
- [Building Heap from Array — GeeksforGeeks](https://www.geeksforgeeks.org/building-heap-from-array/) — Medium — the $O(n)$ bottom-up build proved above.

**🏆 Competitive**

- [Concert Tickets — CSES 1091](https://cses.fi/problemset/task/1091) — Easy — greedy best-fit over a multiset/heap-like structure (priority-queue mindset).
- [Official home tasks & discussion — Codeforces](https://codeforces.com/blog/entry/82779) — the problem set Pavel assigned for this lecture (linked from the video description).

---

## Further reading

- [Binary heap — Wikipedia](https://en.wikipedia.org/wiki/Binary_heap) — array layout, operations, and the linear build-heap proof.
- [Heapsort — Wikipedia](https://en.wikipedia.org/wiki/Heapsort) — in-place variant and comparison with other sorts.
- [Binary Heap — GeeksforGeeks](https://www.geeksforgeeks.org/binary-heap/) — worked insert/extract with diagrams.
- [Heap (data structure) — Wikipedia](https://en.wikipedia.org/wiki/Heap_(data_structure)) — the abstract priority-queue interface across implementations.

---

## Key takeaways

- Pick a data structure by its **operations**, and cost each operation on its own.
- The binary heap is an **almost-complete tree in a flat array**: children $2i+1$, $2i+2$, parent $\lfloor (i-1)/2 \rfloor$, min at the root.
- `insert` = append + **sift up**; `remove_min` = swap-root-with-last + **sift down** past the smaller child. Both are $O(\log n)$ — one tree path.
- **Heap sort** = build-heap then extract; $\Theta(n \log n)$ and fully **in place** by using the array's front as the heap and its back as the sorted output.
- **Bottom-up build-heap is $O(n)$** because the many leaf-level nodes sift down almost no distance — the geometric series $\sum 2^k$ sums to $2n-1$.

## Glossary

- **Priority queue** — a set supporting `insert` and remove-extreme (min or max).
- **Binary heap** — an almost-complete binary tree with the heap property, stored in an array.
- **Heap property** — every node is $\le$ (min-heap) or $\ge$ (max-heap) each of its children.
- **Almost-complete tree** — all levels full except possibly the last, which fills left to right.
- **Sift up / sift down** — restore the heap property by swapping a node toward the root / toward the leaves.
- **In-place** — uses $O(1)$ auxiliary memory beyond the input array.
