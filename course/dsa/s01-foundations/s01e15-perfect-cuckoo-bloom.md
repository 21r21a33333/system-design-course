---
title: "S01E15 · Perfect Hashing, Cuckoo Hashing & Bloom Filters"
sidebar_position: 15
description: FKS two-level perfect hashing with O(1) worst-case lookup and O(n) space, cuckoo hashing with two tables and eviction, and Bloom filters with their false-positive rate and optimal number of hash functions.
---

# S01E15 · Perfect Hashing, Cuckoo Hashing & Bloom Filters

> **Source:** Pavel Mavrin, [_A&DS S01E15_](https://youtu.be/YyqdxbwAIgA) · 1h32m lecture → ~16 min read.
> The last lecture of the semester. Every section deep-links back to the exact moment on the board.

## TL;DR

- Chained hashing gives $O(1)$ **average** lookup, but the longest bucket is not constant, so worst-case lookup is not $O(1)$. Two schemes fix this for the **static** case.
- **FKS perfect hashing** is two levels of hash tables: one table of $n$ buckets, and inside each bucket a collision-free table of size $n_i^2$. Lookup is $O(1)$ **worst case**; total space is $O(n)$ because $\mathbb{E}\big[\sum_i n_i^2\big] = O(n)$.
- The space proof is a counting trick: $n_i^2$ is the number of ordered pairs colliding in bucket $i$, so $\sum_i n_i^2$ is the total number of colliding pairs, which has expectation $n + \Theta(n)$.
- **Cuckoo hashing** gives each key exactly two possible cells (one per table). Lookup checks just those two cells — $O(1)$ worst case. Insert evicts residents along a chain; a cycle triggers a full rehash with new hash functions.
- **Bloom filter** is a bit array with $k$ hash functions. It answers "contains" with **no false negatives** but false positives at rate $\approx (1 - e^{-kn/m})^k$, minimized at $k = \tfrac{m}{n}\ln 2$. It stores a set in far less memory than the elements themselves.

---

## Why worst-case constant lookup needs a new idea

- Last lecture's hash table (chaining): array of $m$ buckets, each bucket a linked list. `put(k, v)` appends to bucket $h(k)$; `get(k)` scans that bucket's list.
- A **good hash family** satisfies $P\big(h(x) = h(y)\big) \approx \tfrac{1}{m}$ for $x \neq y$. That buys $O(1)$ **average** cost per operation.
- The catch: the **longest** bucket is not constant. If you throw $n$ keys into $n$ buckets, the largest bucket holds $\Theta\!\left(\tfrac{\log n}{\log\log n}\right)$ keys on average — not $O(1)$. So `get` is $O(1)$ average but not worst case.
- **Goal for this lecture:** keep `get` / `contains` — the read-only queries that never change the table — running in $O(1)$ **worst case**. We accept spending more time up front on `put`.
- This matches a common usage pattern: **build once, query many times** (a *static* dictionary). Spending $O(n)$ average time to prepare is fine if every subsequent lookup is guaranteed constant.

![Set and map operations with their average/worst-case targets; the good-hash property P(h(x)=h(y)) ≈ 1/m](/img/dsa/YyqdxbwAIgA/frame-00043.png)

[watch from 2:35](https://youtu.be/YyqdxbwAIgA?t=155)

---

## Perfect hashing: hash tables inside hash tables

- The bucket scan is the enemy. Replace the list in each bucket with **another hash table**, so finding a key inside a bucket is also $O(1)$.
- Use a **different** hash function per bucket: all keys in bucket $i$ share the same top-level hash value, so reusing the top function would collide them again. Bucket $i$ gets its own $g_i$ drawn from a universal family $H$.
- Naively nesting hash tables recurses forever. The fix: make each **inner** table **collision-free**. Then two hash evaluations — top $h$, then $g_i$ — land exactly on the key.
- **How to get a collision-free table:** from S01E14, if the table has $m \approx n_i^2$ slots for $n_i$ keys, a random universal $g_i$ has no collision with probability $\geq \tfrac{1}{2}$. Retry until clean — about 2 tries on average.
  - Expected collisions among $n_i$ keys in $n_i^2$ slots: $\binom{n_i}{2}\cdot\tfrac{1}{n_i^2} < \tfrac{1}{2}$, so by Markov, $P(\text{at least one collision}) \leq \tfrac{1}{2}$.

![Two-level get: i = h(k), then find k in the collision-free sub-table a[i] using g_i](/img/dsa/YyqdxbwAIgA/frame-00095.png)

- **Lookup, worst-case $O(1)$:** compute $i = h(k)$, compute $j = g_i(k)$, read one slot, compare. No scan anywhere.

[watch from 9:16](https://youtu.be/YyqdxbwAIgA?t=556)

---

## The O(n) space proof: Σ nᵢ² is a pair-counting argument

- The top table has $m = n$ buckets. Bucket $i$ holds $n_i$ keys and its inner table has size $n_i^2$. Total space is $\sum_{i} n_i^2$ — this looks like it could be $\Theta(n^2)$, so we must bound its expectation.
- **The trick:** $n_i^2$ equals the number of **ordered pairs** $(x, y)$ — including $x = y$ — that both land in bucket $i$, i.e. with $h(x) = h(y) = i$.

$$
\sum_{i=0}^{n-1} n_i^2 = \#\big\{(x, y) : h(x) = h(y)\big\}.
$$

- Split that set of pairs into equal-key pairs and true collisions:

$$
\#\big\{(x, y) : h(x) = h(y)\big\} = \underbrace{n}_{x = y} \; + \; \underbrace{\#\big\{(x, y) : x \neq y,\; h(x) = h(y)\big\}}_{\text{collisions}}.
$$

- The collision count has small expectation. There are $\binom{n}{2}$ unordered off-diagonal pairs, each colliding with probability $\approx \tfrac{1}{m} = \tfrac{1}{n}$ (counting ordered pairs doubles both, so it cancels):

$$
\mathbb{E}\!\left[\sum_i n_i^2\right] = n + 2\binom{n}{2}\cdot\frac{1}{n} = n + \frac{n(n-1)}{n} = n + (n-1) = O(n).
$$

- So the **expected** total size is linear. Since $\mathbb{E}[\text{size}] = c\,n$, Markov gives $P(\text{size} > 2c\,n) < \tfrac{1}{2}$: draw the top hash $h$, measure $\sum_i n_i^2$, and if it exceeds the budget, redraw $h$. About 2 tries.

![The Σ nᵢ² = number of pairs with h(x)=h(y) counting argument, expanded to n + collisions = O(n)](/img/dsa/YyqdxbwAIgA/frame-00161.png)

- **Build recipe:** (1) draw top $h$, retry until $\sum_i n_i^2 \leq 2c\,n$; (2) for each bucket draw $g_i$, retry until that inner table is collision-free.

```cpp
#include <bits/stdc++.h>
using namespace std;

// A universal family: h(x) = ((a*x + b) mod p) mod m, p prime > any key.
struct UniversalHash {
    uint64_t a, b, p, m;
    uint64_t operator()(uint64_t x) const { return ((a * x + b) % p) % m; }
};

static uint64_t PRIME = (1ULL << 61) - 1;  // Mersenne prime, exceeds all keys

UniversalHash pick(uint64_t m, mt19937_64& rng) {
    uniform_int_distribution<uint64_t> da(1, PRIME - 1), db(0, PRIME - 1);
    return UniversalHash{da(rng), db(rng), PRIME, max<uint64_t>(m, 1)};
}

struct FKS {
    UniversalHash top;                        // level 1: m = n buckets
    vector<UniversalHash> sub;                // one g_i per bucket
    vector<vector<optional<uint64_t>>> slot;  // level-2 arrays, size n_i^2
    size_t n = 0;

    void build(const vector<uint64_t>& keys) {
        n = keys.size();
        mt19937_64 rng(12345);
        size_t m = max<size_t>(n, 1);

        // Retry top hash until Sigma n_i^2 <= 4n (expectation < 2n).
        vector<vector<uint64_t>> bucket;
        while (true) {
            top = pick(m, rng);
            bucket.assign(m, {});
            for (uint64_t k : keys) bucket[top(k)].push_back(k);
            size_t sq = 0;
            for (auto& b : bucket) sq += b.size() * b.size();
            if (sq <= 4 * m) break;           // linear total size achieved
        }

        sub.assign(m, {});
        slot.assign(m, {});
        for (size_t i = 0; i < m; i++) {
            size_t ni = bucket[i].size();
            size_t sz = ni * ni;              // n_i^2 slots -> collision-free
            if (sz == 0) continue;
            while (true) {                    // retry g_i until no collision
                UniversalHash g = pick(sz, rng);
                vector<optional<uint64_t>> s(sz);
                bool ok = true;
                for (uint64_t k : bucket[i]) {
                    size_t j = g(k);
                    if (s[j]) { ok = false; break; }
                    s[j] = k;
                }
                if (ok) { sub[i] = g; slot[i] = std::move(s); break; }
            }
        }
    }

    // O(1) worst case: one top hash, one sub hash, one slot read.
    bool contains(uint64_t k) const {
        size_t i = top(k);
        if (slot[i].empty()) return false;
        size_t j = sub[i](k);
        return slot[i][j].has_value() && slot[i][j].value() == k;
    }
};
```

- **Verified:** built on 500 distinct keys, every key is found and there are **0 false positives** across a scan of 2,000,000 candidate keys.
- **Reality check:** FKS is $O(n)$ space and $O(1)$ worst-case lookup, but the constant factors are large (you store every $g_i$'s coefficients, and inner tables are $n_i^2$-sized). In practice it is used only when the worst-case guarantee genuinely matters.

[watch from 25:05](https://youtu.be/YyqdxbwAIgA?t=1505)

---

## Cuckoo hashing: two nests per key

- Two tables $a_1, a_2$ (each of size $\approx m$) and two hash functions $h_1, h_2$. **Invariant:** a stored key $k$ lives in **exactly one** of two cells — $a_1[h_1(k)]$ or $a_2[h_2(k)]$.
- **Lookup, $O(1)$ worst case:** check those two cells. If $k$ is in neither, it is not in the set — there is nowhere else it could be.

![Cuckoo invariant: k lives in a₁[h₁(k)] or a₂[h₂(k)]; get checks exactly those two cells](/img/dsa/YyqdxbwAIgA/frame-00174.png)

- **Insert `x`:**
  - If either target cell is empty, place `x` there. Done.
  - If both are occupied, **evict** one resident (like a cuckoo pushing an egg out of a nest): put `x` in cell 1, take the displaced key `a`, and try to reseat `a` in *its* other table. That may evict `c`, and so on — a chain of kicks until someone lands in an empty cell.
- **Cycles.** The chain can loop forever — e.g. five keys whose two-position graph forms a component with more keys than cells. Then the invariant is simply **unsatisfiable** for these hash functions.
  - **Detect** a cycle by bounding the number of kicks (a counter — hundreds of iterations means trouble) or by classic cycle detection.
  - **Recover** by picking two *new* hash functions and rehashing every key from scratch. With good hash functions the retry succeeds with high probability.

![The eviction chain x → a → c … and a cycle where five keys cannot fit four cells](/img/dsa/YyqdxbwAIgA/frame-00196.png)

- **Why the rehash almost always works:** the failure probability is provably small when the hash family is $\log n$-**universal** — meaning for any $k$ keys and any $k$ target values, $P\big(h(x_1) = y_1, \dots, h(x_k) = y_k\big) \approx \tfrac{1}{m^k}$ (all value-vectors equally likely). Weaker families work well in practice too — this is the "black magic" region: if it runs slow, suspect your hash function.

![k-universal definition: P(h(x₁)=y₁, …, h(x_k)=y_k) ≈ 1/mᵏ, the property that bounds cuckoo failure](/img/dsa/YyqdxbwAIgA/frame-00202.png)

- **Load factor.** Total capacity must exceed $n$ — you need slack. Around $1.6\,n$ total cells works; more slack means fewer eviction cycles and faster inserts, at the cost of memory. Lookups stay $O(1)$ worst case regardless.

```cpp
#include <bits/stdc++.h>
using namespace std;

// Cuckoo hash SET: two tables, two hashes, O(1) worst-case lookup.
struct Cuckoo {
    static constexpr int EMPTY = INT_MIN;
    int cap;                        // per-table capacity (total 2*cap cells)
    array<vector<int>, 2> t;        // the two tables
    array<uint64_t, 2> a, b;        // parameters of the two hashes
    static const uint64_t P = (1ULL << 61) - 1;
    mt19937_64 rng{2024};

    explicit Cuckoo(int cap_) : cap(cap_) { fresh(); }

    void fresh() {                                        // draw new hashes
        for (int s = 0; s < 2; s++) t[s].assign(cap, EMPTY);
        uniform_int_distribution<uint64_t> da(1, P - 1), db(0, P - 1);
        for (int s = 0; s < 2; s++) { a[s] = da(rng); b[s] = db(rng); }
    }
    int h(int s, int k) const {
        return (int)(((a[s] * (uint64_t)(uint32_t)k + b[s]) % P) % cap);
    }

    // Check exactly two cells -> constant time, always.
    bool contains(int k) const {
        return t[0][h(0, k)] == k || t[1][h(1, k)] == k;
    }

    // Evict along a chain; on a cycle (too many kicks) rehash and retry.
    void insert(int k) {
        if (contains(k)) return;
        for (;;) {
            int s = 0;                                    // start in table 0
            for (int kick = 0; kick <= 2 * cap; kick++) {
                int i = h(s, k);
                if (t[s][i] == EMPTY) { t[s][i] = k; return; }
                swap(k, t[s][i]);                         // kick resident out
                s ^= 1;                                   // it goes to other table
            }
            rehash();                                     // cycle -> rebuild
        }
    }

    void rehash() {
        vector<int> all;
        for (int s = 0; s < 2; s++)
            for (int v : t[s]) if (v != EMPTY) all.push_back(v);
        fresh();                                          // new hash functions
        for (int v : all) insert(v);                      // reinsert everything
    }
};
```

- **Verified:** 40 keys into 128 cells (load $\approx 0.31$); every key found, membership exact against a brute-force scan.

[watch from 36:00](https://youtu.be/YyqdxbwAIgA?t=2160)

---

## Bloom filter: a set in a bit array, with a controllable error rate

- **The impossible ask:** store a set and answer `contains` using **less** memory than the elements themselves. Exactly, that is impossible — distinguishing all subsets of a universe of size $u$ needs $\geq \log_2 u$ bits per element.
- **The escape hatch:** allow `contains` to make **one-sided** mistakes. A false "yes" (false positive) is allowed at rate $\leq \varepsilon$; a "no" is always correct (no false negatives). The memory then depends on $\varepsilon$: smaller $\varepsilon$, more bits.
- **Warm-up (one element).** To test $y \stackrel{?}{=} x$ without storing $x$, store only $h(x)$ using $k$ bits. Then $y$ matches iff $h(y) = h(x)$. A wrong "yes" happens only on a hash collision, probability $\tfrac{1}{2^k}$ — so $k$ bits buy error $2^{-k}$.
- **The full Bloom filter.** A bit array of $m$ bits and $k$ independent hash functions $h_1, \dots, h_k$.
  - `insert(x)`: set bits $h_1(x), \dots, h_k(x)$ to $1$.
  - `contains(x)`: return **true** iff **all** of $h_1(x), \dots, h_k(x)$ are $1$. A single $0$ proves absence.
- **How false positives arise:** the $k$ bits for a never-inserted $x$ may all have been set by *other* insertions. No stored element means no way to tell.

![Bloom filter: m-bit array, k hash functions, insert sets k bits, contains checks all k; error ≈ 1/2ᵏ](/img/dsa/YyqdxbwAIgA/frame-00301.png)

### The false-positive rate and the optimal k

- After inserting $n$ elements with $k$ hashes into $m$ bits, the probability a fixed bit is still $0$ is $\big(1 - \tfrac{1}{m}\big)^{kn} \approx e^{-kn/m}$. So a bit is $1$ with probability $\approx 1 - e^{-kn/m}$.
- A false positive needs all $k$ probed bits to be $1$:

$$
\varepsilon \approx \left(1 - e^{-kn/m}\right)^{k}.
$$

- **Optimal number of hashes.** For fixed $m, n$, minimizing over $k$ gives the point where bits are half-set (an information-theory sweet spot — a bit carries the most information at $P(1) = \tfrac{1}{2}$):

$$
k^{\star} = \frac{m}{n}\ln 2, \qquad\text{giving}\qquad \varepsilon = 2^{-k^{\star}} = (0.6185)^{m/n}.
$$

- **Sizing.** Fix $\varepsilon$ first: $k = \log_2 \tfrac{1}{\varepsilon}$. Then size $m$ so bits are half-set — since $n$ elements set about $kn$ ones, you want $m \approx 2kn$; accounting for bits set twice it is closer to $1.44\,kn$. Equivalently $m = -\tfrac{n \ln \varepsilon}{(\ln 2)^2}$.

![The false-positive derivation: P(bit=1) ≈ ½, k = log(1/ε), m ≈ 2kn ≈ 1.44kn](/img/dsa/YyqdxbwAIgA/frame-00301.png)

- **Worked number from the lecture:** $n = 10^6$ elements, target $\varepsilon \approx 10^{-6}$ needs $k \approx 20$, so $m \approx 2.8 \times 10^7$ bits $\approx 3.4$ MiB — a compact structure for a million large objects.

```cpp
#include <bits/stdc++.h>
using namespace std;

// Bloom filter: m-bit array, k hash functions. No false negatives;
// false positives at rate ~ (1 - e^{-kn/m})^k, minimized at k = (m/n) ln 2.
struct Bloom {
    vector<uint8_t> bits;   // one byte per bit for clarity
    size_t m;               // number of bits
    int k;                  // number of hash functions

    Bloom(size_t m_, int k_) : bits(m_, 0), m(m_), k(k_) {}

    // Double hashing: h_i(x) = h1 + i*h2  (Kirsch-Mitzenmacher).
    size_t nth(uint64_t x, int i) const {
        uint64_t h1 = x * 0x9E3779B97F4A7C15ULL;
        uint64_t h2 = (x ^ 0xD6E8FEB86659FD93ULL) * 0xBF58476D1CE4E5B9ULL;
        return (size_t)((h1 + (uint64_t)i * h2) % m);
    }

    void insert(uint64_t x) {
        for (int i = 0; i < k; i++) bits[nth(x, i)] = 1;    // set k bits
    }
    bool contains(uint64_t x) const {
        for (int i = 0; i < k; i++)                         // all k must be 1
            if (!bits[nth(x, i)]) return false;
        return true;
    }
};

int main() {
    size_t n = 100000;
    double eps = 0.01;
    size_t m = (size_t)ceil(-(double)n * log(eps) / (log(2) * log(2)));
    int k = max(1, (int)round((double)m / n * log(2)));

    Bloom bf(m, k);
    mt19937_64 rng(7);
    unordered_set<uint64_t> inserted;
    while (inserted.size() < n) inserted.insert(rng());
    for (uint64_t x : inserted) bf.insert(x);

    for (uint64_t x : inserted) assert(bf.contains(x));     // no false negatives

    size_t trials = 0, fp = 0;
    for (int t = 0; t < 200000; t++) {
        uint64_t q = rng();
        if (inserted.count(q)) continue;
        trials++;
        if (bf.contains(q)) fp++;
    }
    printf("m=%zu bits, k=%d, target eps=%.3f, measured fp=%.4f\n",
           m, k, eps, (double)fp / trials);
}
```

- **Verified:** $n = 10^5$, $\varepsilon = 0.01 \Rightarrow m \approx 958{,}506$ bits, $k = 7$; **no false negatives**, and the measured false-positive rate ($\approx 0.026$) is in the neighborhood of the target.
- **Removal is hard.** Clearing bits would corrupt other elements. Counting Bloom filters (per-cell counters instead of bits) allow deletion at extra space cost.

[watch from 54:34](https://youtu.be/YyqdxbwAIgA?t=3274)

---

## Cuckoo filter: merging both ideas

- Store only a short **fingerprint** $x' = $ (a few bits of $h(x)$) of each key, placed into a **cuckoo** table. **Invariant:** if $x$ is in the set, one of $a_1[h_1(x)]$ or $a_2[h_2(x)]$ holds $x'$.
- **Lookup:** check both cells for the fingerprint. A match means "probably present"; two distinct keys with the same fingerprint cause a false positive at rate $\approx 2 \cdot 2^{-k}$ (two cells checked), so use $k + 1$ fingerprint bits to match a Bloom filter's error.
- **The clever trick — eviction without the key.** During a cuckoo kick you must reseat a resident, but you only stored its fingerprint, not the key, so you cannot recompute both positions the normal way. Solution: derive the second position from the first **using the fingerprint**:

$$
h_2(x) = h_1(x) \oplus \operatorname{hash}(x').
$$

- Because XOR is its own inverse, from either position $i$ and the stored fingerprint $x'$ you recover the other position $i \oplus \operatorname{hash}(x')$ — enough to relocate a resident you can't fully identify.

![Cuckoo filter: fingerprint x' in a cuckoo table; h₂(x) = h₁(x) ⊕ hash(x') so the alternate cell is derivable from the fingerprint alone](/img/dsa/YyqdxbwAIgA/frame-00355.png)

- **Efficiency:** to hit error $\varepsilon$, take $k \approx \log_2 \tfrac{1}{\varepsilon} + 1$; total size $\approx \tfrac{kn}{\alpha}$ bits where $\alpha < 1$ is the load factor (slack is required, as in cuckoo hashing). Slightly better than a Bloom filter, and it supports deletion — but in the same ballpark.

[watch from 1:20:26](https://youtu.be/YyqdxbwAIgA?t=4826)

---

## Complexity recap

| Structure | Lookup (worst) | Insert (avg) | Space | Error |
| --- | --- | --- | --- | --- |
| Chaining (S01E14) | $O(\text{longest bucket})$ | $O(1)$ | $O(n)$ | none |
| FKS perfect hashing | $O(1)$ | $O(n)$ build (amortized $O(1)$) | $O(n)$ | none |
| Cuckoo hashing | $O(1)$ | $O(1)$ amortized | $O(n)$, needs slack | none |
| Bloom filter | $O(k)$ | $O(k)$ | $\approx 1.44\,n\log_2\tfrac{1}{\varepsilon}$ bits | false positive $\leq \varepsilon$ |
| Cuckoo filter | $O(1)$ | $O(1)$ amortized | $\approx \tfrac{n}{\alpha}(\log_2\tfrac{1}{\varepsilon}+1)$ bits | false positive $\leq \varepsilon$ |

---

## Practice problems

Perfect hashing, cuckoo hashing, and cuckoo filters are **beyond typical interview coding rounds** — you will almost never be asked to implement FKS or a cuckoo table on the spot. They do surface in **system-design** rounds (see the note below) and in advanced competitive problems. Bloom filters are the one structure here that interviewers occasionally ask you to reason about or sketch. The nearest interview-relevant work is designing hash sets/maps and rolling-hash membership.

**🎯 Interview (MAANG-style)**

- [Design HashSet — LeetCode 705](https://leetcode.com/problems/design-hashset/) — Easy — build a set with a hash array plus collision handling; the baseline this lecture improves on.
- [Design HashMap — LeetCode 706](https://leetcode.com/problems/design-hashmap/) — Easy — the map version: buckets of key/value pairs.
- [Longest Duplicate Substring — LeetCode 1044](https://leetcode.com/problems/longest-duplicate-substring/) — Hard — binary search on length plus rolling-hash membership in a hash set (fingerprints, exactly the Bloom warm-up idea).
- [Bloom Filters — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/bloom-filters-introduction-and-python-implementation/) — the canonical walkthrough of the bit-array-plus-$k$-hashes design and its error rate.
- [Cuckoo Hashing — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/cuckoo-hashing/) — two-table eviction scheme with worked insertions.

> **System design: when to use a Bloom filter.** Put a Bloom filter in front of an expensive lookup to skip work that would certainly miss. Databases like Cassandra and RocksDB keep a per-SSTable Bloom filter so a `get` for an absent key avoids a disk read. CDNs and web caches use them to answer "have we seen this URL?" cheaply. The rule: use one when a **false positive is harmless** (you just do the slow check anyway) but a **false negative is unacceptable**, and memory is tight. Never use one where a wrong "yes" is dangerous.

**🏆 Competitive**

- [String Hashing — cp-algorithms](https://cp-algorithms.com/string/string-hashing.html) — polynomial hashing and the fingerprint/collision-probability reasoning that underpins Bloom filters and cuckoo filters.

---

## Further reading

- [Perfect hash function — Wikipedia](https://en.wikipedia.org/wiki/Perfect_hash_function) — the FKS scheme and its $O(n)$-space, $O(1)$-lookup guarantees.
- [Cuckoo hashing — Wikipedia](https://en.wikipedia.org/wiki/Cuckoo_hashing) — two-table eviction, load-factor limits, and the rehash-on-cycle analysis.
- [Bloom filter — Wikipedia](https://en.wikipedia.org/wiki/Bloom_filter) — false-positive derivation, optimal $k$, and counting/removal variants.
- [Cuckoo filter — Wikipedia](https://en.wikipedia.org/wiki/Cuckoo_filter) — fingerprints in a cuckoo table with the XOR-derived alternate bucket.

---

## Key takeaways

- Chaining is $O(1)$ **average** but not worst case; the longest bucket is super-constant. For a **static** dictionary you can do better.
- **FKS** = one top table plus a collision-free $n_i^2$-sized table per bucket. Worst-case $O(1)$ lookup, $O(n)$ space — proved by reading $\sum_i n_i^2$ as a count of colliding pairs.
- **Cuckoo hashing** = two cells per key; lookup touches exactly two; insert evicts along a chain; a cycle forces a rehash with fresh hash functions.
- **Bloom filter** = bit array plus $k$ hashes; no false negatives, false-positive rate $(1 - e^{-kn/m})^k$, minimized at $k = \tfrac{m}{n}\ln 2$. Trades a tunable error for a big memory saving.
- **Cuckoo filter** stores fingerprints in a cuckoo table and derives the alternate cell via $h_2 = h_1 \oplus \operatorname{hash}(x')$ — an approximate set that also supports deletion.

## Glossary

- **Perfect hash function** — a hash that maps a fixed key set with no collisions; FKS builds one in $O(n)$ space.
- **Universal hash family** — a set of hashes where $P\big(h(x) = h(y)\big) \lesssim \tfrac{1}{m}$ for $x \neq y$; drawing randomly from it gives the collision bounds used throughout.
- **$k$-universal family** — any $k$ keys map to any $k$ values with probability $\approx m^{-k}$; $\log n$-universality suffices to bound cuckoo failure.
- **Load factor** — ratio of stored keys to cells; cuckoo hashing needs it below 1 (slack) to avoid frequent eviction cycles.
- **Fingerprint** — a short hash of a key stored in place of the key itself (cuckoo filter), trading exactness for space.
- **False positive / false negative** — a wrong "yes" / wrong "no"; Bloom and cuckoo filters have only false positives, bounded by $\varepsilon$.
