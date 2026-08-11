---
title: "S01E06 · Stacks, Queues & Amortized Cost"
sidebar_position: 6
description: Array-backed stacks and queues, the growable (doubling) dynamic array with O(1) amortized push, a queue built from two stacks, and the three views of amortized analysis — aggregate, accounting (banker's), and the potential method.
---

# S01E06 · Stacks, Queues & Amortized Cost

> **Source:** Pavel Mavrin, [_A&DS S01E06_](https://youtu.be/EU09CpPUrZc) · 1h36m lecture → ~14 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- A **stack** is LIFO (`push`/`pop` at one end); a **queue** is FIFO (`add` at the tail, `remove` at the head). Both are trivially one array plus one or two integer indices.
- A queue on a fixed array **walks rightward** and eventually overruns the end — fix it by making the array **cyclic** (advance indices modulo the capacity).
- The **growable array (vector)** hides an unknown final size: when full, allocate a **doubled** array and copy. A single `push` is $O(n)$ worst case, but the doubling makes it **$O(1)$ amortized**.
- **Amortized cost** $\tilde{T}$ is a per-operation budget you *assign* so that $\sum \tilde{T} \ge \sum T$ over every prefix — a rigorous "average over a worst-case sequence" with no probability involved.
- Three tools prove the same $O(1)$: **aggregate** (sum the geometric series $1+2+4+\dots \le 2m$), **accounting / banker's** (prepay 2 coins per push), and the **potential method** $\tilde{T}_i = T_i + \Phi_{i+1} - \Phi_i$ with $\Phi = 2\cdot(\text{filled cells in the right half})$.
- A **queue from two stacks** (`in` and `out`): `add` pushes onto `in`; `remove` pops `out`, refilling it by draining `in` when empty. Each element is moved a constant number of times → **$O(1)$ amortized** per operation.

---

## Stacks: LIFO on one array

- A **stack** stores elements so that the **last one pushed is the first one popped** (LIFO). Two operations: `push(x)` adds on top, `pop()` removes and returns the top.
- Example: `push(a); push(b); push(c)` then `pop()` returns `c` and removes it — the newest element leaves first.
- **Implementation.** Keep one array `a` and a size counter `n`. Elements occupy indices $0 \dots n-1$; the "top" is index $n-1$.
  - **Invariant:** `a[0..n-1]` are the live elements, bottom-to-top; `n` is both the count and the index of the next free slot.

![Board: stack drawn as an array A B C with the top marked, indices 0..n-1, and push(a)/push(b)/push(c)/pop→c traced](/img/dsa/EU09CpPUrZc/frame-00021.png)

```cpp
struct Stack {
    vector<int> a;               // reserve the max size up front
    int n = 0;                   // number of live elements

    Stack(int capacity) : a(capacity) {}

    void push(int x) {
        a[n] = x;                // write into the free slot
        n++;                     // a[n] = x ; n++
    }

    int pop() {
        n--;                     // shrink first
        return a[n];             // return a[n] (the old top)
    }
};
```

- **Why stacks matter even if you never write one:** every recursive call frame lives on the **call stack**. Calling `f(n)` saves `n`, the locals, and the **return pointer** `p` (where to resume); recursing pushes a new frame, returning pops it. That block of saved locals per call is exactly a stack.

[watch from 3:55](https://youtu.be/EU09CpPUrZc?t=235)

---

## Queues: FIFO with head and tail

- A **queue** removes the **oldest** element first (FIFO), like a line at a shop window: you join at the **tail**, you are served from the **head**.
- Two operations: `add(x)` appends at the tail; `remove()` pops the head element and returns it.
- **Implementation.** One array plus two indices:
  - `head` = index of the oldest live element (front of the line),
  - `tail` = index of the **first empty** slot (where the next `add` goes).
  - **Invariant:** live elements are `a[head .. tail-1]`; the queue is empty exactly when `head == tail`.

![Board: queue as an array with head/tail pointers, add(a/b/c) then remove→a, plus the add/remove code a[tail++]=x and return a[head++]](/img/dsa/EU09CpPUrZc/frame-00057.png)

```cpp
struct Queue {
    vector<int> a;
    int head = 0;
    int tail = 0;

    Queue(int capacity) : a(capacity) {}

    void add(int x) {
        a[tail] = x;              // a[tail] = x
        tail++;                   // tail++
    }

    int remove() {
        int x = a[head];          // oldest element
        head++;                   // head++
        return x;
    }
};
```

- **Deque (double-ended queue).** Add/remove at **both** ends — the union of stack and queue behaviour. In C++ `std::deque` exposes `push_front / push_back / pop_front / pop_back`; when unsure which structure you need, a deque covers all of them. A C++ `std::vector` is essentially a stack (`push_back` / `pop_back`).

![Board: stack, queue and deque side by side — the deque supports push_front/back and pop_front/back](/img/dsa/EU09CpPUrZc/frame-00113.png)

[watch from 12:56](https://youtu.be/EU09CpPUrZc?t=776)

---

## The fixed-size problem, and the cyclic queue

- Infinite arrays do not exist. With a fixed capacity, the two structures fail differently:
  - **Stack:** if you know the maximum size, reserve that much — mildly wasteful but simple.
  - **Queue:** even knowing the max size is not enough. Every `add`/`remove` pair shifts the live window **rightward**, so the queue eventually walks off the **right edge** and index-out-of-bounds.
- **Fix — make the array cyclic.** When `tail` reaches the end, wrap to index $0$ and keep going into the space freed by earlier `remove`s. Advance both pointers **modulo the capacity**:
  - `tail = (tail + 1) % capacity`, `head = (head + 1) % capacity`.
  - Choose `capacity` = max simultaneous elements, and the wrap makes the window chase its own tail forever without overrun.

```cpp
struct CyclicQueue {
    vector<int> a;
    int cap;
    int head = 0;
    int tail = 0;
    int n = 0;                         // live count, to tell full from empty

    CyclicQueue(int capacity) : a(capacity), cap(capacity) {}

    void add(int x) {
        a[tail] = x;
        tail = (tail + 1) % cap;       // wrap around
        n++;
    }

    int remove() {
        int x = a[head];
        head = (head + 1) % cap;       // wrap around
        n--;
        return x;
    }
};
```

- **Why the `n` counter?** With only `head` and `tail`, a full queue and an empty queue both satisfy `head == tail`. Tracking the live count `n` disambiguates them (the alternative is to leave one slot always empty).

[watch from 19:39](https://youtu.be/EU09CpPUrZc?t=1179)

---

## The growable array: doubling on overflow

- Real use is worse: you usually **do not know** the final stack size. Reserving the theoretical maximum (say 1000) when the typical size is 10 wastes almost all the memory. We want a **small array when small, a big array when big**.
- **Idea (how `std::vector` grows).** Start with a tiny backing array. On `push`, if it is full: allocate a **new, larger** array, **copy** everything over, then write the new element.
- **How much larger?** Growing by **one** cell (`n+1`) is fatal — *every* push then copies all $n$ elements, so each push costs $\Theta(n)$. Instead grow by a **constant factor**: allocate size $2n$. (In practice $1.5\times$ is common; $2\times$ is the cleanest to analyze.) Multiplying the size means copies happen **rarely**.

![Board: push(x) with the resize branch — if n == size, a' = new array(2n), copy a'[0..n-1] = a[0..n-1], a = a', then a[n++] = x, labelled O(n) resize + O(1) write](/img/dsa/EU09CpPUrZc/frame-00132.png)

```cpp
struct GrowableStack {
    vector<int> a;                         // capacity starts at 1
    int n = 0;

    GrowableStack() : a(1) {}

    void push(int x) {
        if (n == (int)a.size()) {              // array is full
            vector<int> nw(2 * a.size());      // double the capacity
            for (int i = 0; i < n; i++)        // copy old contents -> O(n)
                nw[i] = a[i];
            a = nw;
        }
        a[n] = x;                              // a[n] = x
        n++;                                   // n++
    }
};
```

- **Worst-case one push:** $O(n)$ (the copy). **But** the resize timeline is: two cheap pushes, one slow (copy 1); two cheap, one slow (copy 2); four cheap, one slow (copy 4); … The slow ones are **rare and their sizes double**, which is exactly the regime amortized analysis was invented for.

[watch from 29:08](https://youtu.be/EU09CpPUrZc?t=1748)

---

## Amortized cost: the definition

- Some operations are slow but **infrequent**; a per-operation worst case ($O(n)$) badly over-counts the real total. We want the **average cost over a worst-case sequence** — with **no probability**.
- Give every operation a real cost $T(\text{op})$ and *invent* an **amortized cost** $\tilde{T}(\text{op})$ — a budget you assign, not a property of the code.
- **Correctness condition.** Starting from an empty structure, for **every** sequence of $m$ operations $o_1, o_2, \dots, o_m$:

$$
\sum_{i=1}^{m} T(o_i) \;\le\; \sum_{i=1}^{m} \tilde{T}(o_i)
$$

- If this holds for *every* prefix, the assigned $\tilde{T}$ is a valid amortized bound: the total real work never exceeds the total budget, so the budget is an honest per-operation charge.

![Board: amortized analysis setup — T(op) real time, T̃(op) amortized time, sequence o1..om, and the requirement ΣT(oi) ≤ ΣT̃(oi)](/img/dsa/EU09CpPUrZc/frame-00164.png)

- **Goal for doubling push:** prove $\tilde{T}(\text{push}) = c$ (a constant). By the definition, "amortized $O(1)$" means: for every $m$ pushes, $\sum T \le c\cdot m$. That single inequality *is* the whole claim.

[watch from 35:58](https://youtu.be/EU09CpPUrZc?t=2158)

---

## Method 1 — Aggregate: sum the whole sequence

- The most direct proof: push $m$ elements one by one and bound the **total** real time, then divide by $m$.
- **Per-push base cost.** Each of the $m$ pushes does the constant work of `a[n] = x; n += 1` → $m$ total.
- **Copy cost.** Copies happen only when the array doubles. Over $m$ pushes the arrays have sizes $1, 2, 4, \dots, 2^k$, so the copies move
$$
1 + 2 + 4 + \dots + 2^{k} = 2^{\,k+1} - 1
$$
elements in all (geometric series).
- **Relate $k$ to $m$.** The last doubling to size $2^{k+1}$ only fires once the array of size $2^k$ is full, so $2^k \le m$, giving $2^{\,k+1}-1 < 2^{\,k+1} \le 2m$. Total copy work $\le 2m$.
- **Add them up:**
$$
\sum_{i=1}^{m} T(o_i) \;\le\; \underbrace{m}_{\text{writes}} + \underbrace{2m}_{\text{copies}} \;=\; 3m .
$$
So $\tilde{T}(\text{push}) = 3 = O(1)$ amortized. (The all-important assumption: allocating an array of any size is treated as $O(1)$.)

![Board: aggregate proof — the doubling cascade of copies 1+2+4+…+2^k = 2^{k+1}, ΣT(oi) = m + 2m and T̃(push) = c with ΣT(oi) ≤ c·m](/img/dsa/EU09CpPUrZc/frame-00190.png)

[watch from 42:56](https://youtu.be/EU09CpPUrZc?t=2576)

---

## Method 2 — Accounting (banker's): prepay with coins

- Aggregate summing gets messy for complex structures. The **accounting** method is more local: keep a **bank account** of prepaid time (coins).
  - `put_coin(t)`: reserve time for the future — charges the operation an **extra** $t$, so its amortized cost goes **up** by $t$.
  - `get_coin(t)`: spend reserved time on real work now — the operation's amortized cost goes **down** by $t$ (it can even be negative).
- **Invariant that must always hold:** the account never goes negative — you can only spend coins you actually saved earlier.

![Board: accounting method — put_coin(t) makes T̃ = t, get_coin(t) makes T̃ = −t; each push stores a coin, copies are paid from the saved coins](/img/dsa/EU09CpPUrZc/frame-00317.png)

- **Scheme for doubling push.** When you push a new element, place a **coin of size 2** on it (amortized cost $= 1$ write $+ 2$ saved $= 3$).
  - After the array of size $n$ fills, the **right half** (the $n/2$ freshly added cells since the last doubling) each carry a coin of size $2$ → $n/2 \times 2 = n$ coins saved.
  - The next doubling must copy $n$ elements: pay for **all $n$ copies** out of those saved coins, so the copy step's own amortized cost is $0$.
- **Result:** every push costs an amortized $3$, copies are free (prepaid), and the account is always solvent → $\tilde{T}(\text{push}) = 3 = O(1)$.

[watch from 1:07:27](https://youtu.be/EU09CpPUrZc?t=4047)

---

## Method 3 — The potential method (Φ)

- The most powerful and reusable tool. Attach a **potential** $\Phi_i \ge 0$ to the **state after $i$ operations** — a number measuring "how much stored-up trouble" the structure holds. Require:
  - $\Phi_0 = 0$ (empty structure has no stored work),
  - $\Phi_i \ge 0$ always (you never owe the bank).
- **Define** the amortized cost of the $i$-th operation as the real cost plus the change in potential:

$$
\tilde{T}_i \;=\; T_i + \Delta\Phi \;=\; T_i + \Phi_{i} - \Phi_{i-1}.
$$

- **Why this is automatically valid.** Sum over all $m$ operations — the potential terms **telescope**:

$$
\sum_{i=1}^{m} \tilde{T}_i \;=\; \sum_{i=1}^{m} T_i \;+\; (\Phi_m - \Phi_0) \;=\; \sum_{i=1}^{m} T_i \;+\; \Phi_m \;\ge\; \sum_{i=1}^{m} T_i,
$$

since $\Phi_0 = 0$ and $\Phi_m \ge 0$. So **any** non-negative $\Phi$ with $\Phi_0 = 0$ yields a valid amortized bound — you never have to re-prove the prefix inequality.

![Board: potential method — Φ0 = 0, Φi ≥ 0, T̃ = T + ΔΦ, the telescoping sum ΣT̃ = ΣT + (Φm − Φ0) ≥ ΣT, and Φ = 2·(elements in the right part)](/img/dsa/EU09CpPUrZc/frame-00256.png)

**Finding a good Φ.** You want $\Phi$ **large just before** a slow operation and **small just after**, so the drop $\Delta\Phi \approx -n$ cancels the slow $+n$ real cost. For doubling: right before a resize the array is **full** (right half packed); right after, the right half is **empty**. So let

$$
\boxed{\ \Phi \;=\; 2 \cdot (\text{number of filled cells in the right half of the array})\ }
$$

**The doubling derivation, operation by operation:**

- **Cheap push** (no resize): fills one more right-half cell → $\Delta\Phi = +2$. Real cost $T_i = 1$. So $\tilde{T}_i = 1 + 2 = 3$.
- **Resize push:** just before, right half holds $n/2$ elements, so $\Phi_{\text{before}} = 2\cdot\frac{n}{2} = n$; just after the copy into a $2n$ array, the right half is empty, $\Phi_{\text{after}} = 0$. Real cost $T_i = n$ (the copy). Then

$$
\tilde{T}_i \;=\; T_i + \Phi_{\text{after}} - \Phi_{\text{before}} \;=\; n + 0 - n \;=\; O(1).
$$

- **Every** push is amortized $O(1)$. Notice this is the **same** quantity as the accounting scheme (a coin of size $2$ per right-half element), just expressed as a single global number instead of coins pinned to cells — which is why the potential method generalizes to non-integer potentials and structures where "where did I put the coin" is awkward.

![Board: doubling potential worked out — resize row shows Φ goes n → 0, ΔΦ = −n cancels the T = n copy, giving amortized O(1)](/img/dsa/EU09CpPUrZc/frame-00298.png)

[watch from 53:35](https://youtu.be/EU09CpPUrZc?t=3215)

---

## Pop and shrinking: why you need a gap

- `pop()` should also **shrink** the array — otherwise a long run of pushes blows the capacity up, and popping most elements leaves a huge mostly-empty array.
- **Naive (broken) rule:** halve the array when it becomes **half full**. This fails: sit at exactly the threshold and alternate `push, pop, push, pop, …` — each operation crosses the boundary and triggers an $O(n)$ resize, so **every** operation is slow and the amortized cost is $\Theta(n)$, not constant.
- **Fix — leave hysteresis (a gap) between the grow and shrink thresholds:**
  - **Grow** (double) when the array becomes **full** ($n = \text{size}$),
  - **Shrink** (halve) only when it drops to **one quarter** full ($n < \text{size}/4$).
- After a shrink the array is half full, so it takes $\approx n$ more operations before either a grow or the next shrink can fire. That $\Theta(n)$ gap between consecutive resizes is what keeps **both** `push` and `pop` at **$O(1)$ amortized**.

```cpp
struct DynamicArrayStack {
    vector<int> a;
    int n = 0;

    DynamicArrayStack() : a(1) {}

    void push(int x) {
        if (n == (int)a.size())                // full -> grow x2
            a = resized(2 * a.size());
        a[n] = x;
        n++;
    }

    int pop() {
        int res = a[n - 1];
        n--;
        if ((int)a.size() >= 4 && n < (int)a.size() / 4)  // 1/4 full -> shrink x2
            a = resized(a.size() / 2);
        return res;
    }

    vector<int> resized(int new_cap) {
        vector<int> nw(new_cap);
        for (int i = 0; i < n; i++)
            nw[i] = a[i];
        return nw;
    }
};
```

- **Accounting view of the pair:** put a coin of size $2$ on each element when you **push** (funds the next grow), and save a coin when you **pop** (funds the next shrink). Both resizes are then prepaid, so both operations are amortized constant. Amortized time may even go **negative** occasionally — that is fine; it is a virtual quantity, not real runtime.

[watch from 1:16:26](https://youtu.be/EU09CpPUrZc?t=4586)

---

## Queue from two stacks

- **Setup.** You have two stacks, `in` (call it $S_2$) and `out` (call it $S_1$), and want a FIFO queue out of them. Conceptually the queue is split in half: `in` holds the newest elements top-up, `out` holds the oldest elements ready to leave.
- **`add(x)`:** just `in.push(x)` — real cost $O(1)$.
- **`remove()`:** serve from `out`. If `out` is empty, **drain** every element from `in` into `out` (popping `in` and pushing `out` reverses the order, so the oldest element ends up on top of `out`), then `out.pop()`.

![Board: queue-from-two-stacks — S1 (out) holds A B C ready to serve, S2 (in) takes new pushes; add = S2.push, remove = refill S1 from S2 when empty then S1.pop; amortized T̃ = const](/img/dsa/EU09CpPUrZc/frame-00384.png)

```cpp
struct QueueFromTwoStacks {
    DynamicArrayStack s_in;             // S2: new elements pushed here
    DynamicArrayStack s_out;            // S1: elements served from here (reversed)

    void add(int x) {
        s_in.push(x);                   // T̃ = 2  (push + save one coin)
    }

    int remove() {
        if (s_out.n == 0) {             // out empty -> refill from in
            while (s_in.n > 0)          // this while is the "slow" step
                s_out.push(s_in.pop()); // reverse order
        }
        return s_out.pop();             // oldest element, T̃ = O(1)
    }
};
```

- **Why the `while` is not a disaster.** A single `remove` that triggers a refill is $O(n)$, but **each element is moved at most a constant number of times overall**: pushed onto `in` once, popped from `in` once, pushed onto `out` once, popped from `out` once.
- **Accounting proof.** On each `add`, store a coin on the element (so `add` is amortized $2$). The refill loop moves each element using its own saved coin, so the whole `while` is amortized $0$; the final `s_out.pop()` is $O(1)$. Both operations are **$O(1)$ amortized**.
- **Potential proof.** Let $\Phi = \lvert S_2 \rvert$ (the size of the `in` stack). Each `add` raises $\Phi$ by $1$ (paying for the future move); a refill drains `in` to empty, so $\Delta\Phi = -\lvert S_2\rvert$ exactly cancels the $\lvert S_2\rvert$ moves. Same $O(1)$ amortized, expressed as a clean non-integer-free potential.

[watch from 1:27:32](https://youtu.be/EU09CpPUrZc?t=5252)

---

## Complexity recap

| Operation | Worst (single) | Amortized | Space | Notes |
| --- | --- | --- | --- | --- |
| Stack `push` / `pop` (fixed array) | $O(1)$ | $O(1)$ | $O(1)$ | one array + size `n` |
| Queue `add` / `remove` (cyclic array) | $O(1)$ | $O(1)$ | $O(1)$ | indices mod capacity |
| Growable `push` (doubling) | $O(n)$ | $\Theta(1)$ | $O(n)$ | copy on resize |
| Dynamic array `push` + `pop` (grow×2, shrink at ¼) | $O(n)$ | $\Theta(1)$ | $O(n)$ | hysteresis gap needed |
| Queue-from-two-stacks `add` / `remove` | $O(n)$ | $\Theta(1)$ | $O(n)$ | each element moved $O(1)$ times |

---

## Practice problems

The interview payload here is twofold: **implementing** stacks/queues/deques out of each other, and the **monotonic stack/deque** pattern those structures unlock.

**🎯 Interview (MAANG-style)**

- [Min Stack — LeetCode 155](https://leetcode.com/problems/min-stack/) — Med — augment a stack so `getMin` is $O(1)$; the auxiliary-stack trick.
- [Implement Queue using Stacks — LeetCode 232](https://leetcode.com/problems/implement-queue-using-stacks/) — Easy — the two-stack queue of this lecture; prove $O(1)$ amortized.
- [Implement Stack using Queues — LeetCode 225](https://leetcode.com/problems/implement-stack-using-queues/) — Easy — the dual construction, one or two queues.
- [Design Circular Queue — LeetCode 622](https://leetcode.com/problems/design-circular-queue/) — Med — the cyclic-array queue with modular indices.
- [Daily Temperatures — LeetCode 739](https://leetcode.com/problems/daily-temperatures/) — Med — the **monotonic stack** pattern, each index pushed/popped once ($O(n)$ amortized).
- [Largest Rectangle in Histogram — LeetCode 84](https://leetcode.com/problems/largest-rectangle-in-histogram/) — Hard — monotonic stack of increasing bar heights.
- [Sliding Window Maximum — LeetCode 239](https://leetcode.com/problems/sliding-window-maximum/) — Hard — the **monotonic deque**; the amortized argument that each element enters/leaves once.
- [Introduction to Stack — GeeksforGeeks](https://www.geeksforgeeks.org/introduction-to-stack-data-structure-and-algorithm-tutorials/) — Easy — array/linked implementations and applications.
- [Queue Data Structure — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/queue-data-structure/) — Easy — array, cyclic and linked queues.
- [Introduction to Amortized Analysis — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/introduction-to-amortized-analysis/) — Med — aggregate, accounting and potential methods worked out.

**🏆 Competitive**

- [Advertisement (sliding-window min/max) — CSES 1141](https://cses.fi/problemset/task/1141) — Med — monotonic-deque range extremum, the queue amortization in the wild.
- [Official home tasks & discussion — Codeforces](https://codeforces.com/blog/entry/83756) — the problem set Pavel assigned for this lecture (linked from the video description).

---

## Further reading

- [Amortized analysis — Wikipedia](https://en.wikipedia.org/wiki/Amortized_analysis) — aggregate, accounting and potential methods side by side.
- [Potential method — Wikipedia](https://en.wikipedia.org/wiki/Potential_method) — the $\tilde{T} = T + \Delta\Phi$ framework in general.
- [Dynamic array — Wikipedia](https://en.wikipedia.org/wiki/Dynamic_array) — growth factors, geometric expansion, why doubling gives $O(1)$ amortized.
- [Stack (abstract data type) — Wikipedia](https://en.wikipedia.org/wiki/Stack_(abstract_data_type)) and [Queue (abstract data type) — Wikipedia](https://en.wikipedia.org/wiki/Queue_(abstract_data_type)).
- [Minimum stack / minimum queue — cp-algorithms](https://cp-algorithms.com/data_structures/stack_queue_modification.html) — the two-stack minimum-queue, the competitive cousin of this lecture.

---

## Key takeaways

- Stacks and queues are one array plus one or two indices; the only real subtlety on fixed memory is **wrapping the queue** (cyclic, modular indices) and **growing the stack** (doubling).
- Grow by a **constant factor**, never by one — a $2\times$ (or $1.5\times$) resize turns $O(n)$-per-push into $O(1)$ amortized.
- **Amortized $\ne$ average-case:** it is a worst-case-sequence guarantee with no probability. Prove it by showing $\sum \tilde{T} \ge \sum T$ over every prefix.
- Three interchangeable proofs: **aggregate** (sum a geometric series), **accounting** (prepay coins, account stays non-negative), **potential** ($\Phi_0=0$, $\Phi\ge0$, $\tilde{T}=T+\Delta\Phi$ telescopes for free).
- When you add `pop` with shrinking, keep a **gap** between grow (full) and shrink (quarter-full) thresholds, or alternating operations destroy the amortized bound.
- A queue from two stacks is the canonical amortized-$O(1)$ construction: each element is touched a constant number of times.

## Glossary

- **LIFO / FIFO** — last-in-first-out (stack) / first-in-first-out (queue) removal order.
- **Deque** — double-ended queue; add and remove at both ends.
- **Cyclic (ring) buffer** — fixed array whose indices wrap modulo the capacity, so a queue reuses freed space.
- **Dynamic (growable) array** — array that reallocates to a larger buffer (typically $2\times$) when full; the basis of `std::vector` / Python `list`.
- **Amortized cost** $\tilde{T}$ — an assigned per-operation budget with $\sum \tilde{T} \ge \sum T$ over every prefix; a worst-case-sequence average.
- **Aggregate method** — bound the total real cost of $m$ operations directly, then divide by $m$.
- **Accounting (banker's) method** — prepay "coins" on cheap operations to fund later expensive ones; the account must stay non-negative.
- **Potential method** — a function $\Phi \ge 0$ of the current state with $\Phi_0 = 0$; amortized cost $= T + \Delta\Phi$, valid because the sum telescopes.
