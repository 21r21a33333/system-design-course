---
title: "S01E14 · Hash Tables"
sidebar_position: 14
description: Sets and maps via hashing — chaining and open addressing, the (a·k+b mod p) mod m universal family, the expected O(1) proof via E[chain length] = n/m, load factor, rehashing, and the birthday-bound cost of collision-free tables.
---

# S01E14 · Hash Tables

> **Source:** Pavel Mavrin, [_A&DS S01E14_](https://youtu.be/QM_m5TfoQm4) · 1h34m lecture → ~15 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- A **hash table** implements a **set** (`add`, `remove`, `contains`) or a **map** (`put`, `get`) by turning a big key into a small array index via a hash function $h$.
- The base trick: if keys are small integers in $[0, m)$, use the key itself as an index. For big keys, index by $h(k) = k \bmod m$ instead — but different keys can land in the same cell, a **collision**.
- **Chaining** stores a list of `(key, value)` pairs per cell; **open addressing** stores one pair per cell and probes the next free cell on collision.
- With a **truly random** $h$, the probability two distinct keys collide is $\tfrac{1}{m}$, so a chain holds $\tfrac{n}{m}$ keys in expectation — pick $m \approx n$ and `get`/`put` are **expected $O(1)$**.
- True randomness is unaffordable ($m^u$ functions need $u\log m$ bits), so use the **universal family** $h(k) = ((a k + b) \bmod p) \bmod m$ with $p$ a big prime and $a$ random; it satisfies the same $\Pr[\text{collision}] \le \tfrac{1}{m}$.
- Avoiding collisions **entirely** needs $m \approx n^2$ cells (the **birthday paradox**), so in practice we keep the load factor bounded and **rehash** (double the array, new random $h$) — amortized $O(1)$.

---

## Sets and maps: the interface hashing serves

- **Set** — a bag of distinct objects with `add(x)`, `remove(x)`, `contains(x)`. Canonical use: count distinct items by inserting all of them and reading the size.
- **Map** (a.k.a. dictionary in Python, `HashMap` in Java) — a mapping from **key** objects to **value** objects, like an array whose index is an arbitrary object. Core operations: `put(k, v)` and `get(k)`.
- Both are among the most-used structures in real code and in competitive problems; hashing is the standard way to make them fast.

[watch from 0:42](https://youtu.be/QM_m5TfoQm4?t=42)

---

## From direct addressing to a hash function

- **Simplest case — small integer keys.** If a key is an integer $k \in [0, m)$ with $m$ small, just use it as an array index. `put(k, v)` is `a[k] = v`; `get(k)` returns `a[k]`. This is **direct addressing** — no hashing needed.
- **Big keys.** If $k$ ranges over a huge universe $[0, u)$, an array of size $u$ is impossible. Introduce a function $h : [0, u) \to [0, m)$ that squeezes a big key into a small index, and store at `a[h(k)]`.
- The lecture's first (deliberately naive) choice: $h(k) = k \bmod m$.
  - Example, $m = 5$: `put(37, 3)` computes $h(37) = 37 \bmod 5 = 2$, so `a[2] = 3`.
  - `get(37)` recomputes the *same* $h(37) = 2$, reads `a[2]`, returns `3`. The hash function is **fixed for the life of the table**, so the same key always maps to the same cell.

![Board: direct addressing for small keys, then h(k)=k mod m for big keys, with put(37,3) landing in cell 2](/img/dsa/QM_m5TfoQm4/frame-00061.png)

- **The problem — collisions.** `get(52)` computes $52 \bmod 5 = 2$, the *same* cell as key 37. Two distinct keys sharing a cell is a **collision**: distinct $x \neq y$ with $h(x) = h(y)$. Whenever the domain is bigger than the range (which is the whole point), collisions are unavoidable by pigeonhole.

[watch from 4:26](https://youtu.be/QM_m5TfoQm4?t=266)

---

## Chaining: a list of pairs per cell

Two fixes turn the naive table into a correct one:

- **Store the key alongside the value.** A cell holds a **pair** $(k, v)$, not just $v$ — otherwise, after a collision, you cannot tell whether the stored value belongs to the key you asked for.
- **Store a list of pairs per cell.** When a second key hashes to an occupied cell, append its pair to that cell's list. Each array cell is now the head of a linked list (a **bucket**).

`get` walks the bucket and compares keys:

![Board: array of buckets, put appends pairs, get scans the bucket for x == k and returns y else null](/img/dsa/QM_m5TfoQm4/frame-00082.png)

The board pseudocode is `put(k,v): a[h(k)].add((k,v))` and `get(k): for (x,y) in a[h(k)]: if x==k return y; return null`. Here is that exact algorithm as compilable C++, with insert-or-replace on `put`:

```cpp
#include <bits/stdc++.h>
using namespace std;

// Chaining hash map: array of buckets, each a list of (key, value) pairs.
struct ChainMap {
    int m;                                   // number of buckets
    long long a, b, p;                       // universal-hash parameters (next section)
    vector<list<pair<long long,long long>>> table;
    int n = 0;                               // stored elements; load factor = n / m

    ChainMap(int buckets, long long prime) : m(buckets), p(prime) {
        mt19937_64 rng(random_device{}());
        a = 1 + rng() % (p - 1);             // a in [1, p-1]
        b = rng() % p;                       // b in [0, p-1]
        table.assign(m, {});
    }

    int h(long long k) const {               // ((a*k + b) mod p) mod m
        long long r = ((__int128)a * k + b) % p;
        return (int)(r % m);
    }

    void put(long long k, long long v) {     // insert-or-replace
        auto& bucket = table[h(k)];
        for (auto& kv : bucket)
            if (kv.first == k) { kv.second = v; return; }
        bucket.push_back({k, v});
        n++;
    }

    // returns true and writes out if key present, false otherwise ("null")
    bool get(long long k, long long& out) const {
        for (auto& kv : table[h(k)])
            if (kv.first == k) { out = kv.second; return true; }
        return false;
    }
};

int main() {
    ChainMap mp(5, 1000000007LL);
    mp.put(37, 3);
    mp.put(52, 5);                           // 37 and 52 both hash near cell 2
    mp.put(37, 9);                           // replaces the value for key 37
    long long v;
    cout << (mp.get(37, v) ? v : -1) << "\n"; // 9
    cout << (mp.get(52, v) ? v : -1) << "\n"; // 5
    cout << (mp.get(99, v) ? v : -1) << "\n"; // -1
}
```

- **Data structure & invariant.** `table[i]` holds exactly the pairs whose key hashes to `i`. `n` tracks the element count; $n/m$ is the **load factor**.
- **Note on the board's version.** The lecturer's minimal `put` just appends and is only correct when the key is *not* already present; the replace-scan above (used by real `HashMap`s) makes it fully correct.

[watch from 11:33](https://youtu.be/QM_m5TfoQm4?t=693)

---

## Time complexity, and why a fixed hash is dangerous

- **`put` is $O(1)$** in the naive form — it just prepends to a list.
- **`get` is $O(\text{bucket length})$**, which is $O(n)$ in the **worst case**: if every key lands in one bucket, `get` scans a length-$n$ list.
- **A fixed hash function is exploitable.** With any hard-coded $h$, an adversary (or merely structured, non-random input) can generate many keys sharing one hash value and collapse the table to a single list. This is real: Java's `String.hashCode` is fixed, so attackers can force collisions. (Java's mitigation: once a bucket gets large it switches the list to a **balanced BST** for $O(\log n)$ worst case — but that is a separate topic.)
- **The fix:** don't fix $h$. Pick it **at random** so no attacker can predict it.

![Board: put is O(1), get worst case O(n); the danger of a fixed hash and adversarial keys](/img/dsa/QM_m5TfoQm4/frame-00094.png)

[watch from 16:44](https://youtu.be/QM_m5TfoQm4?t=1004)

---

## The expected O(1) proof (idealized random hash)

Model $h$ as chosen uniformly at random from **all** functions $[0,u) \to [0,m)$. There are $m^u$ such functions (each of the $u$ inputs independently picks one of $m$ outputs).

- **Time of `get(k)` equals the expected bucket length** at $h(k)$ — the expected number of stored keys $x$ with $h(x) = h(k)$.
- **Collision probability.** For a fixed key $k$ and any other key $x \neq k$, by symmetry of a uniformly random function,

$$
\Pr\big[h(x) = h(k)\big] = \frac{1}{m}.
$$

- **Expected chain length** by linearity of expectation over the $n$ stored keys:

$$
\mathbb{E}\big[T(\text{get})\big] = \mathbb{E}\big[\#\{x : h(x) = h(k)\}\big] = \sum_{x} \Pr\big[h(x) = h(k)\big] = n \cdot \frac{1}{m} = \frac{n}{m}.
$$

- **Choose $m \approx n$.** Then the expected chain length is $\Theta(1)$, so both `get` and `put` run in **expected $O(1)$**. This $n/m$ is exactly the **load factor**.

![Board: E[T(get)] = E[#x : h(x)=h(k)] = n·(1/m) = n/m, so with m ≈ n get is O(1)](/img/dsa/QM_m5TfoQm4/frame-00106.png)

[watch from 21:08](https://youtu.be/QM_m5TfoQm4?t=1268)

---

## Can we avoid collisions entirely? The birthday bound

- Suppose we want $\Pr[\text{any collision}] < \varepsilon$ for some $\varepsilon < 1$ (even $\varepsilon = 0.9$ suffices — retry with a fresh $h$ until the table is collision-free).
- With $n$ keys there are about $\binom{n}{2} \approx n^2/2$ pairs, each colliding with probability $\tfrac{1}{m}$. Expected collisions $\approx \tfrac{n^2}{2m}$. To push this below a constant you need

$$
m \approx n^2.
$$

- This is the **birthday paradox**: ~30 people already likely share a birthday among 365 days, because the count of *pairs* grows quadratically.
- **Consequence.** Collision-free hashing costs $m \approx n^2$ memory — fine for tiny $n$ (this is the seed of **perfect hashing**, next lecture) but hopeless for a million keys. So real tables **tolerate** collisions and just keep chains short.

[watch from 26:47](https://youtu.be/QM_m5TfoQm4?t=1607)

---

## Universal hashing: an affordable random family

- **Why not a truly random $h$?** Storing one of $m^u$ functions needs about $u\log m$ bits, and $u$ is astronomically large. Unaffordable.
- **Idea.** Draw $h$ from a **small set of good functions**, not from all functions. The lecture uses the classic universal family parameterized by two integers:

$$
h_{a,b}(k) = \big((a \cdot k + b) \bmod p\big) \bmod m,
$$

where $p$ is a fixed **big prime** ($p > u$), $a$ is random in $[1, p)$, and $b$ is random in $[0, p)$. Picking a function means picking $(a, b)$ — just two numbers.

![Board: h(k) = ((k·a + b) mod p) mod m with p a big random prime; the only property the proof needs is Pr[h(x)=h(y)] ≤ 1/m](/img/dsa/QM_m5TfoQm4/frame-00166.png)

- **What the earlier proof actually needed** was only one property: $\Pr[h(x) = h(y)] \le \tfrac{1}{m}$ for $x \neq y$. If this family has it, the whole expected-$O(1)$ argument goes through unchanged.

**Proof that the family is universal.** For distinct keys $x \neq y$, a collision means

$$
(a x + b) \equiv (a y + b) \pmod{p} \ \text{after} \bmod m \quad\Longrightarrow\quad (x - y)\,a \bmod p \equiv k m \pmod{p}
$$

for some integer $k$. The right side ranges over multiples of $m$ inside $[0, p)$, and there are $\lceil p/m \rceil$ of them. Because $p$ is **prime** and $x - y \not\equiv 0$, the map $a \mapsto (x-y)\,a \bmod p$ is a bijection: for each target multiple $km$ there is **exactly one** bad $a$. So

$$
\Pr[\,a \text{ is bad}\,] = \frac{\lceil p/m \rceil}{p - 1} \le \frac{1}{m} + \frac{1}{p-1} \approx \frac{1}{m}.
$$

That is exactly the property the expected-$O(1)$ proof requires.

![Board: (x−y)·a ≡ km (mod p); primality gives a unique bad a per multiple, so ≈ p/m bad values out of p ⇒ probability ≈ 1/m](/img/dsa/QM_m5TfoQm4/frame-00180.png)

- **Warning — the right property matters.** Uniformity alone is not enough. The family $h_i(x) = i$ (constant functions) satisfies $\Pr[h(x) = i] = \tfrac{1}{m}$ for every key, yet sends **all** keys to the same cell — one giant list. You need the *pairwise* collision bound $\Pr[h(x) = h(y)] \le \tfrac{1}{m}$, not merely uniform placement.

[watch from 34:14](https://youtu.be/QM_m5TfoQm4?t=2054)

---

## Open addressing: one pair per cell, probe on collision

An alternative to chaining that stores everything **inside the array** — no per-cell lists.

- **Insert.** Compute $i = h(k)$. If cell $i$ is occupied, step right ($i \leftarrow (i+1) \bmod m$, a **cyclic array**) until an empty cell appears; place the pair there. This step rule is **linear probing**.
- **Lookup.** Start at $h(k)$ and scan right. **Stop at the first empty cell** — if you reach an empty cell without finding $k$, then $k$ is absent (had it been inserted, it would have taken that or an earlier free cell).

![Board: open addressing put — i = h(k); while a[i] != null: i = (i+1) mod m; a[i] = (k,v)](/img/dsa/QM_m5TfoQm4/frame-00253.png)

The board writes `put`, then `get` with the empty-cell stop condition:

![Board: open addressing get — scan from h(k), return on key match, stop and return null at first empty cell](/img/dsa/QM_m5TfoQm4/frame-00266.png)

Here is the full open-addressing map in C++, including **rehashing** (grow when the load factor exceeds $\tfrac12$) — because a full array makes `get` on a missing key loop forever:

```cpp
#include <bits/stdc++.h>
using namespace std;

// Open addressing with linear probing; grows (rehashes) to keep load <= 1/2.
struct OpenMap {
    struct Slot { long long k, v; bool used = false; };
    int m;                                   // capacity (number of cells)
    int n = 0;                               // stored elements
    long long a, b, p;
    vector<Slot> a_;

    OpenMap(int cap, long long prime) : m(cap), p(prime) {
        mt19937_64 rng(random_device{}());
        a = 1 + rng() % (p - 1);
        b = rng() % p;
        a_.assign(m, Slot{});
    }

    int h(long long k) const {               // ((a*k + b) mod p) mod m
        long long r = ((__int128)a * k + b) % p;
        return (int)(r % m);
    }

    // insert into a given array of capacity cap (used by both put and grow)
    void rawput(vector<Slot>& arr, int cap, long long k, long long v) {
        int i = (int)(((__int128)a * k + b) % p % cap);
        while (arr[i].used) {                // occupied -> step right, cyclically
            if (arr[i].k == k) { arr[i].v = v; return; }
            i = (i + 1) % cap;
        }
        arr[i] = {k, v, true};
    }

    void grow() {                            // double capacity, reinsert all pairs
        int nc = m * 2;
        vector<Slot> na(nc, Slot{});
        for (auto& s : a_)
            if (s.used) rawput(na, nc, s.k, s.v);
        a_.swap(na);
        m = nc;
    }

    void put(long long k, long long v) {
        if (2 * (n + 1) > m) grow();         // keep load factor n/m <= 1/2
        long long tmp;
        bool existed = get(k, tmp);
        rawput(a_, m, k, v);
        if (!existed) n++;
    }

    bool get(long long k, long long& out) const {
        int i = h(k);
        while (a_[i].used) {                 // stop at first empty cell
            if (a_[i].k == k) { out = a_[i].v; return true; }
            i = (i + 1) % m;
        }
        return false;
    }
};

int main() {
    OpenMap mp(4, 1000000007LL);
    for (int i = 0; i < 20; i++) mp.put(i, i * 10);   // triggers several rehashes
    mp.put(37, 3);
    mp.put(52, 5);
    mp.put(37, 9);                           // replace
    long long v;
    cout << (mp.get(37, v) ? v : -1) << "\n"; // 9
    cout << (mp.get(52, v) ? v : -1) << "\n"; // 5
    cout << (mp.get(7,  v) ? v : -1) << "\n"; // 70
    cout << (mp.get(99, v) ? v : -1) << "\n"; // -1
    cout << "load " << mp.n << "/" << mp.m << "\n";
}
```

- **Why store the key, not just the value?** Same reason as chaining: on a collision you must confirm the pair at a probed cell actually belongs to $k$.
- **Sizing.** With capacity $m = 2n$ (load factor $\tfrac12$), about half the cells are empty, so the nearest empty cell is usually close.

[watch from 57:51](https://youtu.be/QM_m5TfoQm4?t=3471)

---

## Why linear probing is expected O(1) (and why clusters hurt)

- **Model.** With a random hash and load factor $\tfrac12$, treat each cell as independently full with probability $\tfrac12$. Then a single probe step continues with probability $\tfrac12$.
- **Expected probe count.** The number of probes to the next empty cell has expectation

$$
\mathbb{E}[\text{steps}] = \tfrac12 \cdot 1 + \tfrac14 \cdot 2 + \tfrac18 \cdot 3 + \cdots = \sum_{k\ge 1} \frac{k}{2^{k}} = 2,
$$

a **constant**, so `put`/`get` are **expected $O(1)$**. (On the board the lecturer first writes this sum as "$=1$", then corrects himself — the point is only that it is some constant independent of $n$.)

![Board: with m = 2n, Pr[cell full] = 1/2, the expected probe count is a constant sum 1/2 + 2/4 + 3/8 + ...](/img/dsa/QM_m5TfoQm4/frame-00336.png)

- **The catch — primary clustering.** Those probabilities are **not independent**. A run of consecutive occupied cells (a **cluster**) is likely to grow: any key hashing anywhere inside it extends it further. Clusters make the constant worse, though the expectation stays $O(1)$ (a rigorous proof is subtler and out of scope).

[watch from 1:12:37](https://youtu.be/QM_m5TfoQm4?t=4357)

---

## Probe-sequence variants: quadratic and double hashing

To reduce clustering, change the **step rule**. The only hard requirement: use the **same probe sequence** on `put` and `get`, so a key is found where it was placed.

- **Linear probing** — step $+1$ each time: positions $h(k), h(k)+1, h(k)+2, \dots$ Cache-friendly but clusters badly.
- **Quadratic probing** — the $i$-th probe is $h(k) + i^2$: positions $h(k)+1, h(k)+4, h(k)+9, \dots$ Breaks up long clusters.
- **Double hashing** — the step size is a **second** hash: $h(k) + i \cdot h_2(k)$. Different keys jump by different strides, scattering probes; the trade-off is worse cache behavior (probes land far apart in memory).

```cpp
#include <bits/stdc++.h>
using namespace std;

// Probe-sequence variants over a table of size m.
// The SAME mode must be used on put and get, or lookups fail.
struct Table {
    struct Slot { long long k, v; bool used = false; };
    int m; vector<Slot> a;
    long long A, B, P;
    Table(int cap, long long prime) : m(cap), P(prime) {
        mt19937_64 rng(12345);
        A = 1 + rng() % (P - 1); B = rng() % P;
        a.assign(m, Slot{});
    }
    int h1(long long k) const { return (int)(((__int128)A * k + B) % P % m); }
    int h2(long long k) const {              // second hash, nonzero mod m
        return 1 + (int)(((__int128)(A + 7) * k + B) % P % (m - 1));
    }
    int probe(long long k, int i, int mode) const {
        int s = h1(k);
        switch (mode) {
            case 0:  return (s + i) % m;                                   // linear
            case 1:  return (int)(((long long)s + (long long)i * i) % m);  // quadratic
            default: return (int)(((long long)s + (long long)i * h2(k)) % m); // double
        }
    }
    void put(long long k, long long v, int mode) {
        for (int i = 0; i < m; i++) {
            int j = probe(k, i, mode);
            if (!a[j].used || a[j].k == k) { a[j] = {k, v, true}; return; }
        }
    }
    bool get(long long k, long long& out, int mode) const {
        for (int i = 0; i < m; i++) {
            int j = probe(k, i, mode);
            if (!a[j].used) return false;
            if (a[j].k == k) { out = a[j].v; return true; }
        }
        return false;
    }
};

int main() {
    const char* names[] = {"linear", "quadratic", "double"};
    for (int mode = 0; mode < 3; mode++) {
        Table t(17, 1000000007LL);           // prime size helps quadratic reach slots
        for (int i = 0; i < 8; i++) t.put(i, i * 100, mode);
        long long v; int ok = 0;
        for (int i = 0; i < 8; i++) if (t.get(i, v, mode) && v == i * 100) ok++;
        cout << names[mode] << ": found " << ok << "/8\n";
    }
}
```

![Board: quadratic and double hashing — put(k1), put(k2), put(k3) with the same h(k) must follow identical jump sequences](/img/dsa/QM_m5TfoQm4/frame-00356.png)

[watch from 1:21:14](https://youtu.be/QM_m5TfoQm4?t=4874)

---

## Rehashing: keeping the load factor bounded

Two situations force a rebuild, and both are **amortized $O(1)$** exactly like a growing vector:

- **Table too full (growth).** You rarely know $n$ up front. When the load factor crosses a threshold, allocate an array **twice** the size and reinsert every pair. Doubling makes the total reinsertion cost $O(n)$ spread over $n$ inserts → amortized $O(1)$.
- **Adversary detected (defense).** Randomness only happens at the *moment you pick $h$*; everything after is deterministic. If an attacker learns your $h$, they can flood one bucket. **Detect** it by checking bucket sizes every ~1000 operations — a bucket should be $O(1)$ in expectation, so an oversized one signals trouble. **Respond** by drawing a fresh random $(a,b)$ and rehashing the whole table; against the new function the same keys scatter again.
- Because a full rebuild is $O(n)$ and happens at most every $\Theta(n)$ operations, the amortized cost stays constant.

[watch from 1:26:16](https://youtu.be/QM_m5TfoQm4?t=5176)

---

## Coda: when a balanced BST beats a hash table

The lecture closes by contrasting hash tables with **balanced binary search trees** (next semester's topic), the other standard map/set backing:

- **Deterministic worst case.** A BST is $O(\log n)$ **worst case, always** — no randomization, no adversarial blowup, no rehash pauses.
- **Ordered operations.** A BST keeps keys sorted, so it also supports next/previous, minimum/maximum, and range queries — which a hash table, being unordered, cannot.
- **The trade.** Hash tables give expected $O(1)$ but only the unordered set/map interface; BSTs give guaranteed $O(\log n)$ plus order.

[watch from 1:32:44](https://youtu.be/QM_m5TfoQm4?t=5564)

---

## Complexity recap

| Operation | Best | Average (random $h$) | Worst | Space |
| --- | --- | --- | --- | --- |
| Chaining `put` / `get` | $\Theta(1)$ | $\Theta(1 + n/m)$ | $\Theta(n)$ | $\Theta(n + m)$ |
| Open-addressing `put` / `get` | $\Theta(1)$ | $\Theta(1)$ at load $\le \tfrac12$ | $\Theta(n)$ | $\Theta(m)$ |
| Rehash / resize (one rebuild) | $\Theta(n)$ | $\Theta(n)$, amortized $\Theta(1)$ | $\Theta(n)$ | $\Theta(n)$ |
| Collision-free table | — | needs $m \approx n^2$ | — | $\Theta(n^2)$ |

With load factor kept constant ($m \approx n$), average-case `get`/`put` are $\Theta(1)$.

---

## Practice problems

Hashing is the single most reused interview tool: **use a hash map to trade $O(n^2)$ scans for $O(n)$ lookups.** The problems below drill exactly that, plus building the table itself.

**🎯 Interview (MAANG-style)**

- [Two Sum — LeetCode 1](https://leetcode.com/problems/two-sum/) — Easy — one-pass hash map of value → index; the archetypal "hash to $O(n)$" move.
- [Design HashSet — LeetCode 705](https://leetcode.com/problems/design-hashset/) — Easy — implement a set with chaining or open addressing from scratch.
- [Design HashMap — LeetCode 706](https://leetcode.com/problems/design-hashmap/) — Easy — the `put`/`get`/`remove` table built in this lecture.
- [Group Anagrams — LeetCode 49](https://leetcode.com/problems/group-anagrams/) — Medium — hash each word by its sorted/count signature into buckets.
- [Longest Consecutive Sequence — LeetCode 128](https://leetcode.com/problems/longest-consecutive-sequence/) — Medium — a hash set gives $O(1)$ neighbor checks for an $O(n)$ scan.
- [Insert Delete GetRandom O(1) — LeetCode 380](https://leetcode.com/problems/insert-delete-getrandom-o1/) — Medium — hash map (value → index) beside a dynamic array for $O(1)$ random.
- [Hashing — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/hashing-data-structure/) — the concept hub: hash functions, chaining, open addressing.
- [Load Factor and Rehashing — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/load-factor-and-rehashing/) — the $n/m$ threshold and the doubling rebuild.

**🏆 Competitive**

- [Sum of Two Values — CSES 1640](https://cses.fi/problemset/task/1640) — Easy — the Two Sum idea; a hash map of complements solves it in $O(n)$.
- [Registration System — Codeforces 4C](https://codeforces.com/problemset/problem/4/C) — Easy — a canonical `map<string,int>` problem: append a counter when a name already exists.

---

## Further reading

- [Hash table — Wikipedia](https://en.wikipedia.org/wiki/Hash_table) — chaining vs open addressing, load factor, resizing.
- [Universal hashing — Wikipedia](https://en.wikipedia.org/wiki/Universal_hashing) — the $((ak+b)\bmod p)\bmod m$ family and its collision bound.
- [Open addressing — Wikipedia](https://en.wikipedia.org/wiki/Open_addressing) and [Linear probing — Wikipedia](https://en.wikipedia.org/wiki/Linear_probing) — probe sequences and clustering.
- [Separate chaining — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/separate-chaining-collision-handling-technique-in-hashing/) and [open addressing — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/open-addressing-collision-handling-technique-in-hashing/).
- [String hashing — cp-algorithms](https://cp-algorithms.com/string/string-hashing.html) — polynomial hashes, the competitive-programming cousin used to hash non-integer keys.

---

## Key takeaways

- A hash table is "an array with tricks": index by $h(k)$, then resolve collisions by **chaining** (list per cell) or **open addressing** (probe to the next free cell).
- The whole speed story is one line: $\Pr[h(x)=h(y)] \le \tfrac{1}{m}$ ⇒ expected chain length $n/m$ ⇒ pick $m \approx n$ ⇒ expected $O(1)$.
- Never fix the hash function — draw it from the **universal family** $((ak+b)\bmod p)\bmod m$; a fixed $h$ is an adversarial DoS waiting to happen.
- Collision-free costs $m \approx n^2$ (birthday paradox), so keep the **load factor** bounded and **rehash** by doubling — amortized $O(1)$.
- Open addressing is cache-friendly and pointer-free but suffers **clustering**; quadratic probing and double hashing spread the probes.
- When you need order or a hard worst-case guarantee, reach for a balanced BST instead.

## Glossary

- **Hash function $h$** — maps a big key to a small array index $[0, m)$.
- **Collision** — distinct keys $x \neq y$ with $h(x) = h(y)$.
- **Chaining** — each cell stores a list of pairs that hash there.
- **Open addressing** — each cell stores one pair; collisions probe to another cell.
- **Load factor** — $n/m$, stored elements over table size; the expected chain length.
- **Universal family** — a small set of hash functions with $\Pr[h(x)=h(y)] \le \tfrac{1}{m}$, e.g. $((ak+b)\bmod p)\bmod m$.
- **Probe sequence** — the order of cells inspected on collision (linear, quadratic, double hashing).
- **Primary clustering** — runs of occupied cells in linear probing that tend to grow.
- **Rehashing** — rebuilding the table (bigger size or fresh $h$) to restore a good load factor.
