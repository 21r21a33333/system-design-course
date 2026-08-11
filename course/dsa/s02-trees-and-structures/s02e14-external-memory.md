---
title: "S02E14 · External Memory Algorithms"
sidebar_position: 14
description: The external-memory (I/O and cache) model with block size B and memory M, the scan and external merge sort bounds, B-trees, the sorting lower bound, and the sort-then-scan design recipe.
---

# S02E14 · External Memory Algorithms

> **Source:** Pavel Mavrin, [_A&DS S02E14_](https://youtu.be/I0E0xJ6VTgE) · 1h24m lecture → ~16 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- The **RAM model** charges one unit for any random access; on a disk (or across a cache line, an SSD, or a network) a random byte is roughly a **million times** slower than a sequential byte, so we need a different cost model.
- The **external-memory model** has two parameters: block size $B$ and internal memory size $M$. Data moves between disk and RAM only in whole blocks of $B$; **cost = number of block reads/writes**, and all in-RAM work is free.
- **Scan** (sum, filter, sequential pass) costs $\Theta\left(\lceil N/B \rceil\right)$ I/Os — the $/B$ speedup is the whole point.
- **External merge sort** builds sorted runs, then does $M/B$-way merges, giving the model's headline bound $\Theta\!\left(\frac{N}{B}\log_{M/B}\frac{N}{B}\right)$ — and this is provably optimal for comparison sorting.
- **B-trees** keep $\approx B$ keys per node so search is $\Theta\left(\log_B N\right)$ I/Os; they power real databases and filesystems. Heaps, stacks, and queues stay cheap because you only touch a small, predictable window.
- The universal recipe: **turn random access into a list of operations, sort it, then apply sequentially** — inverse permutation and function composition both reduce to one external sort.

---

## Why RAM model breaks on a disk

- In the **RAM model** (semester 1, lecture 1) all data sits in one big array and any cell `a[i]` is readable in $O(1)$. Fine for a normal program in main memory — access there really is near-constant.
- It stops being fine when the data lives on an **external device** you cannot cheaply random-access. Classic case: a spinning **hard disk (HDD)**.
- Physical picture: a platter spins under a fixed head; you can only read data at the point currently under the head. One rotation is about **10 ms** (roughly 100 rotations/second).
- To read a byte at an arbitrary location you must **wait for it to rotate under the head** — that seek delay dominates.

![Hard-disk platter with a read head, and the rotation and speed constants on the board](/img/dsa/I0E0xJ6VTgE/frame-00017.png)

- **The million-to-one gap.** Random single-byte reads run at $\approx 100$ bytes/s (one seek per byte). Sequential reads run at $\approx 100$ MB/s. The ratio is $\approx 10^6$ — a constant far too large to hand-wave away.
- We usually ignore constants, but a factor of a million between "read sequentially" and "read randomly" changes which algorithm you pick. So the model must reward sequential access.

[watch from 2:00](https://youtu.be/I0E0xJ6VTgE?t=120)

---

## Reading in blocks: the optimal block size

- Since seeks are what hurt, never read one byte — read a whole **block** and amortize the seek over many useful bytes.
- Time to read one block of size $B$:

$$
T_\text{read} = T_\text{seek} + \frac{B}{S_\text{read}}
$$

  — a fixed seek term plus a transfer term proportional to the block size.
- **Optimal block size** balances the two terms. If the block is tiny, you spend almost all your time seeking and almost none transferring — wasteful. Set them roughly equal:

$$
B \approx T_\text{seek} \cdot S_\text{read} \approx 10\,\text{ms} \times 100\,\tfrac{\text{MB}}{\text{s}} \approx 1\,\text{MB}
$$

![The T_read = T_seek + B / S_read formula and the B is about 1 MB estimate](/img/dsa/I0E0xJ6VTgE/frame-00046.png)

- In **practice** you go a bit larger (say 10 MB) so seeking is only $\approx 10\%$ of the time; but for asymptotics the exact constant does not matter. What matters is that from now on **all I/O happens in units of one block of $B$**.

[watch from 9:30](https://youtu.be/I0E0xJ6VTgE?t=570)

---

## The external-memory model

- Fix a block size $B$. The machine has:
  - a **CPU** with a small fast **local memory (RAM)** of size $M$;
  - a large slow **disk** that holds all the data.
- Every transfer between RAM and disk is exactly one block of size $B$ (read or write).
- $M$ and $B$ are the **two parameters of the model**; every complexity you derive is a formula in $N$, $M$, and $B$.

![CPU with internal memory M, disk, block transfers of size B, and cost = number of reads and writes](/img/dsa/I0E0xJ6VTgE/frame-00061.png)

- **Cost measure:** $T = $ number of block reads/writes. Everything the CPU does inside its RAM is **free** — a deliberate simplification. Real programs do care about in-RAM work, but here we optimize only I/O.
- The same model describes many "far memory" situations, only the seek reason differs:
  - **CPU cache vs main RAM** — a cache line is the block; column-major traversal of a big array is slow purely from cache misses.
  - **SSD** — no rotation, but the request-to-data delay is still large relative to transfer.
  - **Remote server / network** — a round trip per byte is fatal; fetch a block per request.

[watch from 13:19](https://youtu.be/I0E0xJ6VTgE?t=799)

---

## Scan: the linear pass costs N over B

- **Problem:** sum an array `a[0..n-1]` stored on disk.
- RAM answer: walk element by element. External answer: **read block by block** — read a block, sum it in RAM, discard, read the next block, until the array ends.
- We count blocks, not elements, so the cost is $N/B$, not $N$. Because $B$ is huge, that is a million-fold win.
- **The ceiling matters.** A run of $N$ elements still needs at least one block read even when $N \le B$:

$$
\text{scan}(N) = \left\lceil \frac{N}{B} \right\rceil = O\!\left(\frac{N}{B} + 1\right)
$$

![Scan cost with the ceiling, written as O of N over B plus 1](/img/dsa/I0E0xJ6VTgE/frame-00108.png)

- Why the $+1$ is not pedantic: if you have **many tiny arrays** and read each separately, each still forces one block read, so the total is $\Theta(N)$, not $\Theta(N/B)$. The ceiling is invisible for one big array but decisive for many small ones.

[watch from 22:00](https://youtu.be/I0E0xJ6VTgE?t=1332)

---

## Sorting: pick an algorithm that reads sequentially

- Sorting on disk is the workhorse. We need a sort whose memory access pattern is **sequential**.
- **Heap sort is bad here.** A binary heap stores children of node `i` at `2*i+1` and `2*i+2`; sifting jumps far across the array, and every jump is a fresh block read. Random jumps defeat the model.
- **Merge sort is good.** Its access pattern is left-to-right scans, which split cleanly into blocks.

### Merging two sorted arrays, block by block

- To merge sorted `a` and `b` into `c`: look at the front of each, move the smaller into `c`, advance. That is the standard two-pointer merge — and every pointer only moves **forward**.
- In external memory keep exactly **three blocks resident**: the current block of `a`, the current block of `b`, and the current output block of `c`.
  - When an input block is exhausted, read the next block of that array.
  - When the output block fills, write it to disk and start a fresh one.
- So a full merge of two arrays of total size $N$ costs $\Theta(N/B)$ I/Os.

![Merging arrays a and b into c one block at a time, keeping three blocks in local memory](/img/dsa/I0E0xJ6VTgE/frame-00136.png)

### Plain external merge sort

- Standard divide and conquer: split in two, sort each half, merge. Stop recursing once a subarray fits in **one block** (or in $M$): read it, sort it in RAM, write it back.
- Recursion depth is $\log \frac{N}{B}$ and each level scans everything for $\Theta(N/B)$, so:

$$
T(N) = O\!\left(\frac{N}{B}\log \frac{N}{B}\right)
$$

![Two-way external merge sort recursion tree with depth log of N over B, each level costing N over B](/img/dsa/I0E0xJ6VTgE/frame-00148.png)

[watch from 27:06](https://youtu.be/I0E0xJ6VTgE?t=1626)

---

## The improvement: M over B-way merge

- Two-way merge wastes memory — it only ever uses **three blocks**, even though $M$ may hold many more. Use all of $M$ by merging many runs at once.
- To merge $k$ sorted runs simultaneously you keep **one block per run** plus one output block resident. With memory $M$ that allows

$$
k \approx \frac{M}{B} \quad \text{runs merged in a single pass.}
$$

- Now the recursion branches $M/B$ ways instead of $2$, so its depth drops to $\log_{M/B}\frac{N}{B}$. Each level still scans everything at $\Theta(N/B)$. The headline result:

$$
\boxed{\,T_\text{sort}(N) = \Theta\!\left(\frac{N}{B}\,\log_{M/B}\frac{N}{B}\right)\,}
$$

![Multiway merge tree branching M over B ways, giving the log base M over B bound](/img/dsa/I0E0xJ6VTgE/frame-00167.png)

- **Practical tweak:** stop the recursion when a run reaches size $M$ (sort it entirely in RAM), giving $\log_{M/B}\frac{N}{M}$ passes. That is the same asymptotics — it differs by one from $\log_{M/B}\frac{N}{B}$ — just tidier.

### k-way merge in C++

The k-way merge is the one piece worth coding: a min-heap over the run heads picks the next key in $O(\log k)$ RAM work (free in the model), and refills from whichever run it drained.

```cpp
#include <bits/stdc++.h>
using namespace std;

// k-way merge of already-sorted runs — the core of external merge sort.
// In the model each run lives on disk; we keep one block per run resident
// (here a live index) plus one output block. A min-heap over the run heads
// selects the next smallest key; that O(log k) RAM work is charged as free.
vector<long long> kway_merge(const vector<vector<long long>>& runs) {
    using Node = tuple<long long,int,int>;             // (value, run, position)
    priority_queue<Node, vector<Node>, greater<Node>> pq;
    for (int r = 0; r < (int)runs.size(); r++)
        if (!runs[r].empty())
            pq.emplace(runs[r][0], r, 0);

    vector<long long> out;
    while (!pq.empty()) {
        auto [val, r, pos] = pq.top(); pq.pop();
        out.push_back(val);                            // append to output block
        if (pos + 1 < (int)runs[r].size())             // refill from same run
            pq.emplace(runs[r][pos + 1], r, pos + 1);
    }
    return out;
}

// External merge sort: sorted runs of size <= M, then merge k = M/B at a time.
vector<long long> external_sort(vector<long long> a, int M, int B) {
    int k = max(2, M / B);                             // fan-in per merge pass
    vector<vector<long long>> runs;
    for (int i = 0; i < (int)a.size(); i += M) {       // phase 0: in-RAM runs
        vector<long long> run(a.begin()+i, a.begin()+min((int)a.size(), i+M));
        sort(run.begin(), run.end());
        runs.push_back(run);
    }
    if (runs.empty()) return {};
    while (runs.size() > 1) {                          // merge passes
        vector<vector<long long>> next;
        for (int i = 0; i < (int)runs.size(); i += k) {
            vector<vector<long long>> group(
                runs.begin()+i, runs.begin()+min((int)runs.size(), i+k));
            next.push_back(kway_merge(group));
        }
        runs = std::move(next);
    }
    return runs[0];
}
```

- Data structure: a **min-heap** whose invariant is "its top is the global minimum among all un-emitted run heads". Each run contributes at most one heap entry at a time.

[watch from 36:15](https://youtu.be/I0E0xJ6VTgE?t=2175)

---

## The sorting lower bound (why you cannot beat it)

- Recall the RAM argument: sorting needs $\log_2 N! \approx N\log N$ bits of information, and each comparison yields one bit — hence $\Omega(N\log N)$ comparisons.
- In external memory, first **sort every block internally**; that is free scanning. The information still needed to order the whole array is then

$$
\log_2 \frac{N!}{(B!)^{N/B}} \approx N \log \frac{N}{B}.
$$

![Lower bound part 1: log of N factorial over B factorial to the N over B is about N log of N over B](/img/dsa/I0E0xJ6VTgE/frame-00197.png)

- **Information per read.** When you pull in a fresh block of $B$ elements alongside the $M$ already resident, comparing the new $B$ against the resident $M$ can only tell you **where those $B$ slot into the sorted order** of the $M$ — one of $\binom{M}{B}$ placements. So one read yields at most

$$
\log_2 \binom{M}{B} = \log_2 \frac{M!}{(M-B)!\,B!} \approx B\,\log \frac{M}{B} \ \text{bits.}
$$

- Divide total information needed by information per read:

$$
\frac{N\log\frac{N}{B}}{\,B\log\frac{M}{B}\,} = \frac{N}{B}\,\log_{M/B}\frac{N}{B}.
$$

![Full lower bound: log of M choose B is about B log of M over B, dividing to N over B log base M over B](/img/dsa/I0E0xJ6VTgE/frame-00259.png)

- So the $M/B$-way merge sort is **asymptotically optimal** — no comparison sort does fewer I/Os.

[watch from 42:40](https://youtu.be/I0E0xJ6VTgE?t=2560)

---

## Linear structures: stack, queue

- A **stack** on disk keeps only the **top block** in RAM. Push writes into it; when it fills, flush to disk and open a new block. Pop reads from it; when it empties, load the previous block. Same idea as scan.
- **Bug at the boundary.** If you keep exactly one block and sit on a block edge, an alternating `push, pop, push, pop, ...` forces a read then a write **every single operation** — catastrophic.
- **Fix:** keep **two blocks** near the boundary (the same doubling trick used for dynamic vectors). You only drop the old block after moving a full $B$ elements away from the edge, so any expensive flush is amortized over $\Theta(B)$ cheap operations:

$$
T(\text{push}/\text{pop}) = O\!\left(\frac{1}{B}\right)
$$

- This **fractional** cost is the goal: not $O(1)$ (that would mean an I/O per op, i.e. 10 ms each), but one I/O per $\approx B$ operations. A **queue** works the same way, keeping the first and last blocks resident.

![External stack keeping two blocks near the boundary, with amortized cost 1 over B per operation](/img/dsa/I0E0xJ6VTgE/frame-00249.png)

[watch from 50:02](https://youtu.be/I0E0xJ6VTgE?t=3002)

---

## B-trees: the right search tree for disk

- A binary search tree is **bad** on disk: one node per block, so a search is $\Theta(\log_2 N)$ I/Os — worse than one I/O per operation.
- **B-tree** fixes this by fattening each node. A node stores about $B$ keys, which split the key space into $\approx B+1$ ranges, so the node has $\approx B+1$ children.
- **Search:** read the root block, binary-search its $B$ keys to find which child range the query falls in, descend, repeat. Each level divides the remaining element count by $\approx B$:

$$
T_\text{search} = \Theta\!\left(\log_B N\right) \ \text{I/Os.}
$$

- Contrast with a heap or hash table: a B-tree still costs **more than one I/O per query** because a BST-like structure lets you address **any** of the $N$ keys, so you must pay $\Omega(\log_B N)$ to reach an arbitrary one.

![B-tree node holding about B keys with about B plus one children, giving log base B search](/img/dsa/I0E0xJ6VTgE/frame-00273.png)

- **Why heaps and hash tables can be fast but a BST cannot.** A heap only ever exposes the **minimum**, so the next few operations touch a small, predictable set — keep the small elements resident, spill the big ones. A BST or a general map/set lets you address any element, so no small resident window suffices. That is exactly why on-disk indexes are B-trees, not binary trees.
- **System design note.** B-trees (and B+ trees) are the on-disk index of essentially every relational database and many filesystems, precisely because their node fan-out matches the disk block: a few block reads reach any record among billions.

[watch from 60:05](https://youtu.be/I0E0xJ6VTgE?t=3605)

---

## The design recipe: emit, sort, apply

The rest of the lecture shows the pattern that most external-memory algorithms follow: **replace random access by a list of operations, sort the list, then apply it in one sequential scan.**

### Problem 1 — inverse permutation

- Want `r` with `r[p[i]] = i`. The RAM one-liner `for i: r[p[i]] = i` writes `r` at random indices `p[i]` — one seek per element on disk.
- Instead emit the pairs $(p_i, i)$ = (target index, value), **sort by the target index**, then write `r` left-to-right in a single scan. Board example `p = 3 1 5 2 4` sorts to give `r = 2 4 1 5 3`.

![Reverse permutation: the code r of p of i equals i, and the list of pairs to sort](/img/dsa/I0E0xJ6VTgE/frame-00285.png)

![The pairs sorted by target index producing the result 2 4 1 5 3](/img/dsa/I0E0xJ6VTgE/frame-00300.png)

### Problem 2 — function composition (a database join)

- Want `c[i] = b[a[i]]`. Reading `b` at random index `a[i]` is again one seek per element.
- Emit pairs $(a_i, i)$, **sort by $a_i$**, then two-pointer merge against `b` indexed by position (already sorted by index). Each matched pair says "row `i` of the result takes `b[a_i]`". This is literally a **sort-merge join** of two tables.

![Composition c of i equals b of a of i shown as joining two pair tables by a sort-merge](/img/dsa/I0E0xJ6VTgE/frame-00326.png)

### Both problems in C++

```cpp
#include <bits/stdc++.h>
using namespace std;

// r[p[i]] = i, via emit pairs -> external sort -> sequential apply.
vector<int> inverse_permutation_ext(const vector<int>& p) {
    int n = p.size();
    vector<pair<int,int>> ops(n);
    for (int i = 0; i < n; i++) ops[i] = {p[i], i};    // (target index, value)
    sort(ops.begin(), ops.end());                      // stands in for ext sort
    vector<int> r(n);
    for (auto& [idx, val] : ops) r[idx] = val;         // one sequential scan
    return r;
}

// c[i] = b[a[i]], via a sort-merge join on key a[i].
vector<int> compose_ext(const vector<int>& a, const vector<int>& b) {
    int n = a.size();
    vector<pair<int,int>> left(n);                     // (a[i], i)
    for (int i = 0; i < n; i++) left[i] = {a[i], i};
    sort(left.begin(), left.end());                    // sort by key a[i]

    vector<int> c(n);
    int j = 0;                                         // pointer into b (index j)
    for (auto& [key, i] : left) {                      // left sorted by key
        while (j < key) j++;                           // advance right pointer
        c[i] = b[key];                                 // c[i] = b[a[i]]
    }
    return c;
}
```

- Cost of both: dominated by the **sort**, so each runs in $\Theta\!\left(\frac{N}{B}\log_{M/B}\frac{N}{B}\right)$ I/Os. A random-access algorithm that looked "linear" in RAM becomes a sort on disk — and that sort is the fastest honest way to do it.

[watch from 68:37](https://youtu.be/I0E0xJ6VTgE?t=4117)

---

## Complexity recap

All costs are **block I/Os** ($M$ = memory size, $B$ = block size, $N$ = element count).

| Operation | Cost (I/Os) | Notes |
| --- | --- | --- |
| Scan (sum / filter / pass) | $\Theta\left(\frac{N}{B} + 1\right)$ | sequential; ceiling matters for tiny inputs |
| Merge two sorted arrays | $\Theta\left(\frac{N}{B}\right)$ | three resident blocks |
| Two-way external merge sort | $\Theta\left(\frac{N}{B}\log\frac{N}{B}\right)$ | wastes memory |
| $M/B$-way external merge sort | $\Theta\left(\frac{N}{B}\log_{M/B}\frac{N}{B}\right)$ | optimal for comparison sort |
| Stack / queue push, pop | $O\left(\frac{1}{B}\right)$ amortized | two resident blocks at the edge |
| B-tree search / insert | $\Theta\left(\log_B N\right)$ | fan-out $\approx B$ |
| Inverse permutation / composition | $\Theta\left(\frac{N}{B}\log_{M/B}\frac{N}{B}\right)$ | reduces to one external sort |

---

## Practice problems

This is a **model and systems** lecture, not a typical coding round. There is no single Codeforces home-task post in the description. The interview-relevant payload is the **k-way merge** (the beating heart of external sort) and **cache-aware data structures**; the exam-relevant payload is the model and its bounds.

**🎯 Interview (MAANG-style)**

- [Merge k Sorted Lists — LeetCode 23](https://leetcode.com/problems/merge-k-sorted-lists/) — Hard — the exact k-way min-heap merge that external sort runs each pass.
- [Merge Two Sorted Lists — LeetCode 21](https://leetcode.com/problems/merge-two-sorted-lists/) — Easy — the two-pointer merge, three-block idea in miniature.
- [LRU Cache — LeetCode 146](https://leetcode.com/problems/lru-cache/) — Medium — the eviction policy behind keeping the right block resident.
- [LFU Cache — LeetCode 460](https://leetcode.com/problems/lfu-cache/) — Hard — a second cache-replacement policy, same "what stays in fast memory" theme.
- [External Sorting — GeeksforGeeks](https://www.geeksforgeeks.org/external-sorting/) — Medium — the canonical run-generation plus multiway-merge walkthrough.
- [Merge k Sorted Arrays — GeeksforGeeks](https://www.geeksforgeeks.org/merge-k-sorted-arrays/) — Medium — array form of the merge pass.

**🏆 Competitive**

- [Distinct Numbers — CSES 1621](https://cses.fi/problemset/task/1621) — Easy — sort then a single scan, the exact "sort, then sequential apply" recipe.
- [Ferris Wheel — CSES 1090](https://cses.fi/problemset/task/1090) — Easy — sort then two pointers.
- [Towers — CSES 1073](https://cses.fi/problemset/task/1073) — Medium — greedy over a sorted stream, sequential-friendly.
- [Josephus Problem II — CSES 2163](https://cses.fi/problemset/task/2163) — Medium — random deletes made efficient with an order-statistics structure, the "avoid random access" motive.

> Honest label: fusion of the model with a coding round is rare. If you are prepping interviews, the two things that transfer are (1) implement k-way merge from scratch, and (2) reason about cache lines and I/O when asked "how would this scale past memory".

---

## Further reading

- [External memory algorithm — Wikipedia](https://en.wikipedia.org/wiki/External_memory_algorithm) — the model and its landmark results.
- [External sorting — Wikipedia](https://en.wikipedia.org/wiki/External_sorting) — run generation and multiway merge in depth.
- [B-tree — Wikipedia](https://en.wikipedia.org/wiki/B-tree) and [B+ tree — Wikipedia](https://en.wikipedia.org/wiki/B%2B_tree) — the on-disk index structure and its database variant.
- [Cache-oblivious algorithm — Wikipedia](https://en.wikipedia.org/wiki/Cache-oblivious_algorithm) — same bounds without knowing $B$ or $M$, via recursive layouts.
- [Merge algorithm — Wikipedia](https://en.wikipedia.org/wiki/Merge_algorithm) — two-way and k-way merging.
- [External Sorting — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/external-sorting/) — worked implementation.

---

## Key takeaways

- Switch cost models when the data does not fit in fast memory: count **block I/Os**, treat in-RAM work as free.
- The two knobs are $M$ (memory) and $B$ (block); every bound is a formula in $N$, $M$, $B$, and the recurring speedup is the $/B$.
- Sequential-access algorithms win: **scan** is $N/B$, **merge sort** with $M/B$-way merges is $\frac{N}{B}\log_{M/B}\frac{N}{B}$ and optimal.
- Fatten nodes to match the block: **B-trees** give $\log_B N$ search and are why databases and filesystems index on disk the way they do.
- When you are tempted to random-access, **emit operations, sort them, apply sequentially** — inverse permutation and joins both collapse to one external sort.

## Glossary

- **External-memory model** — cost model where data moves between a size-$M$ RAM and disk only in blocks of $B$; cost is the block-transfer count.
- **$B$ (block size)** — the granularity of every disk transfer; the sequential sweet spot ($\approx 1$ MB on a HDD).
- **$M$ (memory size)** — how much fast internal memory the CPU has; sets the merge fan-out $M/B$.
- **Scan** — a single sequential pass over $N$ elements, costing $\lceil N/B \rceil$ I/Os.
- **Run** — an already-sorted chunk produced in the first phase of external sort.
- **$M/B$-way merge** — merging $M/B$ runs at once, keeping one block per run resident.
- **B-tree** — a search tree with $\approx B$ keys and $\approx B+1$ children per node, giving $\log_B N$ I/O search.
- **Cache-oblivious** — an algorithm optimal in the model without being told $B$ or $M$.
