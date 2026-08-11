---
title: "S03E14 · Y-Fast Trie"
sidebar_position: 14
description: Integer data structures beyond the comparison lower bound — the word-RAM model, X-fast tries with per-level hash tables and longest-common-prefix binary search, and the Y-fast trie that buckets keys into balanced BSTs for predecessor in O(log log U) time and O(n) space.
---

# S03E14 · Y-Fast Trie

> **Source:** Pavel Mavrin, [_A&DS S03E14_](https://youtu.be/ZAYD8SyRkVc) · 1h43m lecture → ~16 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- For **abstract, comparison-only** objects, any predecessor/`lower_bound` structure needs $\Omega(\log n)$ per query — that is the sorting lower bound. **Integers give you more:** arithmetic, bit ops, and array indexing let you beat it.
- We work in the **word-RAM model** with word size $w$ bits. Every key fits in one word; $+$, $-$, $\times$, bitwise AND/OR/XOR, and shifts all cost $O(1)$. Complexity is measured in **two** parameters, $n$ and $w$.
- An **X-fast trie** is a binary trie over the bit-strings of the keys. Its trick: store every node's prefix in a **hash table per level**, then **binary-search the longest common prefix** of a query. That gives `lower_bound` in $O(\log w)$ — but $O(n\,w)$ space and $O(w)$ updates.
- A **Y-fast trie** fixes space and updates: bucket the $n$ keys into $\Theta(n/w)$ **blocks** of size $\Theta(w)$, each a balanced BST; keep one **representative per block** in an X-fast trie. Result: `lower_bound`, `insert`, `erase` all in $O(\log w)$ (updates amortized), in $O(n)$ space.
- Since $w \ge \log n$ always, $\log w \ge \log\log n$, so predecessor is $O(\log\log U)$ where $U = 2^w$ is the universe size — exponentially faster than $O(\log n)$ for small words. **In practice a balanced BST or a bitwise trie is used instead**; these integer structures are a theory result.

---

## Why integers break the comparison lower bound

- A **balanced BST** stores abstract objects and answers `lower_bound(x)` — the smallest stored key $\ge x$ — in $O(\log n)$. That is optimal *when your only tool is a comparator*: with $k$ comparisons you can distinguish at most $2^k$ orderings, so locating $x$ among $n$ keys needs $\ge \log_2 n$ comparisons (same argument as the $\Omega(n\log n)$ sorting bound).
- **Integers are not abstract.** Stored as bit-strings, they admit:
  - arithmetic $+, -$ (needed even to index an array: `base + i * size`),
  - $\times$ — assumed $O(1)$ here, though it is genuinely the *controversial* op (multiplication has no constant-depth polynomial-size boolean circuit),
  - bitwise **AND / OR / XOR** and **left/right shifts** — trivially parallel per bit, hence cheap in any real CPU.
- So the question becomes: with these extra powers, how fast can `lower_bound` go? Today's answer is $O(\log w)$; next lecture (fusion trees) gets $O(\log_w n)$.

![RAM model, allowed operations, and the operation list — plus, minus, multiply, bitwise, shifts — with word size w as a model parameter](/img/dsa/ZAYD8SyRkVc/frame-00093.png)

[watch from 2:36](https://youtu.be/ZAYD8SyRkVc?t=156)

---

## The word-RAM model and the two-parameter cost

- Memory is one big array; `a[i]` for any index costs $O(1)$ (random access).
- The **word size $w$** is a model parameter: every integer we store has $w$ bits, so the universe is $U = 2^w$.
- **Assumed $O(1)$ operations:** $+,-,\times$, integer division / shifts, bitwise AND/OR/XOR. Division and multiplication are the "expensive" ones; shifts and bitwise ops are the honest-to-parallelize ones, and you can simulate a left shift as a multiply by a precomputed power of two.
- **Complexity is a function of both $n$ and $w$.** The structures today get *faster* as $w$ **shrinks**; fusion trees get faster as $w$ **grows**. Since only $w \ge \log n$ is guaranteed (you must fit an index into a word) and there is no upper bound on $w$, you can pick whichever structure wins for your $(n, w)$ — that is how you eventually beat $n\log n$ sorting.

[watch from 8:46](https://youtu.be/ZAYD8SyRkVc?t=526)

---

## X-fast trie: a bit-trie with per-level hash tables

- Treat each key as a **string of $w$ bits** and build a binary **trie**: going left appends a `0`, going right appends a `1`. A key is a root-to-leaf path of length $w$.
- Example on the board, $w = 4$, keys $\{0010, 0100, 1001, 1101, 1110\}$.
- **Naive `lower_bound(x)`:** walk down the path spelled by $x$'s bits.
  - If you can follow the whole path, $x$ itself is present.
  - Otherwise you fall off at some node. Two mirror cases:
    - You wanted to go **left** (next bit of $x$ is `0`) but only the **right** child exists → the successor of $x$ is the **minimum leaf** in that right subtree.
    - You wanted to go **right** (next bit is `1`) but only the **left** child exists → the **maximum leaf** in that left subtree is the *predecessor* of $x$; step one to the right along a leaf linked list to get the successor.
- **Data stored to make this $O(1)$ at the fall-off node:**
  - each subtree root caches a pointer to its **min** and **max** leaf (a segment-tree-style precomputation),
  - all leaves are threaded into a **sorted doubly-linked list** so "the next leaf" is one hop.
- This is already correct, but walking the path costs $O(w)$ time and the trie costs $O(n\,w)$ space. Both are too much.

![X-fast trie for w=4 over five keys, showing the fall-off node, subtree min/max pointers, and the leaf linked list; lower_bound of 0011 lands next to its predecessor](/img/dsa/ZAYD8SyRkVc/frame-00141.png)

[watch from 26:31](https://youtu.be/ZAYD8SyRkVc?t=1591)

### The speedup: binary-search the longest existing prefix

- The only slow part is **finding the fall-off node** = the **longest prefix of $x$ that is a node in the trie**. Everything after it is $O(1)$.
- Prefix-existence is **monotone**: if a length-$\ell$ prefix of $x$ is a node, so is every shorter one. So **binary-search the prefix length** $\ell \in [0, w]$.
- To test "is this prefix a node?" in $O(1)$: keep a **hash table per level**. For level $\ell$, hash the integer value of the top-$\ell$ bits of every stored key. A prefix is a node iff it is a key of `level[ℓ]`. Because prefixes are integers packed in one word, computing and hashing a prefix is $O(1)$.
- **Why per-level tables (not one global table):** the prefix `0` at level 1 and the prefix `0` at level 3 are the same integer; separating by level disambiguates. (Alternatively, set a sentinel `1` bit just above the prefix so different levels get different integers.)
- Binary search does $O(\log w)$ probes, each $O(1)$ → **`lower_bound` in $O(\log w)$**.
- **Corollary — you don't even need the tree.** The nodes are just the set of prefix-integers; a hash table alone answers everything. Going left/right is appending a `0`/`1` to the current prefix value.

![Binary search over prefix length using per-level hash tables; the fall-off node is the maximal prefix of x present in the trie, found in log w probes](/img/dsa/ZAYD8SyRkVc/frame-00159.png)

### Codeable core: X-fast trie predecessor via level hash tables

This is a faithful, compile-tested X-fast trie. Instead of explicit min/max leaf pointers we store, per prefix, the **min and max key** sharing that prefix (equivalent information); the "leaf linked list" is modeled by an ordered set so the one-step-over move is a single call. `lower_bound` and `predecessor` both run in $O(\log w)$ query time.

```cpp
#include <bits/stdc++.h>
using namespace std;

// X-fast trie over w-bit keys.
// level[l] : prefix-of-length-l  ->  {min key, max key} sharing that prefix.
// Leaves are threaded in sorted order (an ordered set stands in for the list).
// lower_bound / predecessor run in O(log w): binary-search the longest existing
// prefix, then one min/max hint plus at most one leaf step.
struct XFastTrie {
    int W;
    struct MinMax { uint64_t mn, mx; };
    vector<unordered_map<uint64_t, MinMax>> level;
    set<uint64_t> leaves;                         // stands in for the leaf list
    explicit XFastTrie(int w): W(w), level(w + 1) {}

    uint64_t pref(uint64_t x, int l) const { return l == 0 ? 0 : (x >> (W - l)); }

    void add_key_to_levels(uint64_t x) {
        for (int l = 0; l <= W; l++) {
            uint64_t p = pref(x, l);
            auto it = level[l].find(p);
            if (it == level[l].end()) level[l][p] = {x, x};
            else { it->second.mn = min(it->second.mn, x);
                   it->second.mx = max(it->second.mx, x); }
        }
    }
    void rebuild() {                              // full rebuild after a change
        for (auto& m : level) m.clear();
        for (uint64_t x : leaves) add_key_to_levels(x);
    }
    void insert(uint64_t x) { if (leaves.insert(x).second) rebuild(); }
    void erase(uint64_t x)  { if (leaves.erase(x))         rebuild(); }

    // longest prefix length of x present as a node, by binary search on length
    int longest_prefix(uint64_t x) const {
        int lo = 0, hi = W, ans = 0;              // prefix length 0 = root, always present
        while (lo <= hi) {
            int mid = (lo + hi) / 2;
            if (level[mid].count(pref(x, mid))) { ans = mid; lo = mid + 1; }
            else hi = mid - 1;
        }
        return ans;
    }
    bool lower_bound(uint64_t x, uint64_t& out) const {   // smallest key >= x
        if (leaves.empty()) return false;
        int l = longest_prefix(x);
        if (l == W) { out = x; return true; }             // exact leaf hit
        const MinMax& mm = level[l].at(pref(x, l));
        int nextBit = (x >> (W - 1 - l)) & 1ull;
        // x diverges here on the next bit: it wanted the ABSENT child.
        // nextBit 0: wanted left(absent)  -> node min > x -> min is the successor.
        // nextBit 1: wanted right(absent) -> node max < x -> its list-successor.
        if (nextBit == 0) { out = mm.mn; return true; }
        auto it = leaves.upper_bound(mm.mx);
        if (it == leaves.end()) return false;
        out = *it; return true;
    }
    bool predecessor(uint64_t x, uint64_t& out) const {   // largest key <= x
        if (leaves.empty()) return false;
        int l = longest_prefix(x);
        if (l == W) { out = x; return true; }
        const MinMax& mm = level[l].at(pref(x, l));
        int nextBit = (x >> (W - 1 - l)) & 1ull;
        if (nextBit == 1) { out = mm.mx; return true; }
        auto it = leaves.lower_bound(mm.mn);              // mm.mn > x; step one left
        if (it == leaves.begin()) return false;
        --it; out = *it; return true;
    }
};
```

- `insert`/`erase` here are $O(n\,w)$ (a full rebuild) and space is $O(n\,w)$ — the X-fast trie alone only *queries* fast. The Y-fast trie below is what makes updates and space efficient.

[watch from 32:35](https://youtu.be/ZAYD8SyRkVc?t=1955)

---

## Y-fast trie: bucket into $\Theta(w)$-size blocks

- **Idea (indirection).** Do not put all $n$ keys in the X-fast trie. Instead:
  1. Sort-partition the keys into consecutive **blocks**, each of size between $w/4$ and $w$.
  2. Store each block as a **balanced BST** (AVL / red-black / whatever).
  3. Pick one **representative** per block (its maximum, or any separating boundary value) and put **only the representatives** in an X-fast trie.
- Board example: keys $\{1,2,4,5,7,10,12,13,15\}$ split into blocks, with boundaries $3, 7, 11$ inserted into the X-fast trie as the representatives.

![Nine keys split into blocks of size between w/4 and w, with block boundaries 3, 7, 11 promoted into the X-fast trie as representatives](/img/dsa/ZAYD8SyRkVc/frame-00179.png)

### `lower_bound` still $O(\log w)$

- To find `lower_bound(x)`:
  1. Run the **X-fast `lower_bound`** on the representatives → the block that must contain $x$ if present, in $O(\log w)$.
  2. Run **BST `lower_bound`** inside that block, in $O(\log w)$ (block has $\le w$ keys).
  3. **Edge case:** the answer may not be in that block (every key there is $< x$). Then step to the **next block** and take its minimum. You inspect at most **two** blocks.
- Total: $O(\log w)$.

![Computing lower_bound of 6: X-fast lower_bound finds boundary 7 hence the correct block, then a BST search inside; if the block has no key at least x, take the next block minimum](/img/dsa/ZAYD8SyRkVc/frame-00220.png)

### Space is now $O(n)$

- Balanced BSTs holding $n$ keys total use $O(n)$ space.
- The X-fast trie holds only representatives. There are $\Theta(n/w)$ blocks (each of size $\ge w/4$, so $\le 4n/w$ blocks), and the X-fast trie over $m$ keys uses $O(m\,w)$ space. Here $m = O(n/w)$, so its space is $O((n/w)\cdot w) = O(n)$.
- The factor $w$ that blew up the plain X-fast trie is exactly cancelled by bucketing $\Theta(w)$ keys per representative.

[watch from 45:45](https://youtu.be/ZAYD8SyRkVc?t=2745)

### Updates: split / merge, amortized $O(\log w)$

- **`insert(x)`:** find the target block ($O(\log w)$), insert into its BST ($O(\log w)$). If the block **overflows** past size $w$, **split** it into two blocks of size $w/2$ and insert the new boundary representative into the X-fast trie.
- **`erase(x)`:** find the block, delete from its BST. If the block **underflows** below $w/4$, **merge** with a neighbor (then re-split if the merged block is too big) and update representatives in the X-fast trie — exactly the **B-tree** rebalancing rule.
- **Why splits/merges are rare (amortized $O(1)$):** a fresh block after a split or merge has size $\approx w/2$, i.e. it sits an $\Omega(w)$ distance away from **both** thresholds $w/4$ and $w$. So at least $\Omega(w)$ further insertions or deletions must hit that block before it can trigger another structural change. Charging the $O(w)$ split cost over those $\Omega(w)$ cheap operations gives **$O(1)$ amortized** per update for the restructuring, on top of the $O(\log w)$ for the point operation.
- Net: **`insert` and `erase` are $O(\log w)$ amortized**, `lower_bound` is $O(\log w)$ worst case, space $O(n)$.

![Insert cost breakdown: log w to find the block, log w to insert, plus an O(w) split that happens only every ~w operations, giving O(1) amortized restructuring](/img/dsa/ZAYD8SyRkVc/frame-00253.png)

### Codeable core: Y-fast trie on top of the X-fast trie

Faithful, compile-tested. Blocks are `std::set` (balanced BST); representatives live in the `XFastTrie` above; `insert`/`erase` do the split/merge B-tree dance.

```cpp
// (append below the XFastTrie definition above)

// Y-fast trie: n keys bucketed into O(n/w) blocks of size in [w/4 .. w], each a
// balanced BST. One representative per block (its max) lives in an X-fast trie.
// lower_bound = X-fast lower_bound on reps (find the block) + BST lower_bound
// inside, O(log w). Space O(n). Splits/merges keep block sizes away from the
// thresholds, so insert/erase are O(log w) amortized.
struct YFastTrie {
    int W;
    XFastTrie reps;                        // representative (block max) -> X-fast
    map<uint64_t, set<uint64_t>> blocks;   // rep -> the block's keys (BST)
    explicit YFastTrie(int w): W(w), reps(w) {}

    size_t hi() const { return (size_t)W; }
    size_t lo() const { return max<size_t>(1, W / 4); }

    void insert(uint64_t x) {
        if (blocks.empty()) { blocks[x].insert(x); reps.insert(x); return; }
        uint64_t rep;
        if (reps.lower_bound(x, rep)) {                 // smallest rep >= x
            auto& b = blocks[rep];
            b.insert(x);
            if (b.size() > hi()) split(rep);
        } else {                                        // x above every rep
            auto last = prev(blocks.end());
            uint64_t oldRep = last->first;
            set<uint64_t> keys = std::move(last->second);
            keys.insert(x);
            blocks.erase(oldRep); reps.erase(oldRep);
            blocks[x] = std::move(keys); reps.insert(x); // promote x to block max
            if (blocks[x].size() > hi()) split(x);
        }
    }
    void erase(uint64_t x) {
        auto bit = block_of(x);
        if (bit == blocks.end()) return;
        uint64_t rep = bit->first;
        auto& b = bit->second;
        if (!b.erase(x)) return;
        if (b.empty()) { blocks.erase(rep); reps.erase(rep); return; }
        if (x == rep) {                                 // representative changed
            reps.erase(rep);
            uint64_t nrep = *b.rbegin();
            set<uint64_t> keys = std::move(b);
            blocks.erase(rep);
            blocks[nrep] = std::move(keys);
            reps.insert(nrep);
            rep = nrep;
        }
        if (blocks[rep].size() < lo()) merge(rep);
    }
    map<uint64_t, set<uint64_t>>::iterator block_of(uint64_t x) {
        uint64_t rep;
        if (reps.lower_bound(x, rep)) return blocks.find(rep);
        if (!blocks.empty()) return prev(blocks.end());
        return blocks.end();
    }
    bool lower_bound(uint64_t x, uint64_t& out) {        // smallest key >= x
        uint64_t rep;
        if (!reps.lower_bound(x, rep)) return false;     // x above every rep -> none
        auto& b = blocks[rep];
        auto it = b.lower_bound(x);
        if (it != b.end()) { out = *it; return true; }   // found inside this block
        uint64_t rep2;                                   // else next block's minimum
        if (!reps.lower_bound(rep + 1, rep2)) return false;
        out = *blocks[rep2].begin(); return true;
    }
    void split(uint64_t rep) {                           // overflow -> two blocks
        set<uint64_t> keys = std::move(blocks[rep]);
        blocks.erase(rep); reps.erase(rep);
        vector<uint64_t> v(keys.begin(), keys.end());
        size_t m = v.size() / 2;
        uint64_t r1 = v[m - 1], r2 = v.back();
        blocks[r1] = set<uint64_t>(v.begin(), v.begin() + m); reps.insert(r1);
        blocks[r2] = set<uint64_t>(v.begin() + m, v.end());   reps.insert(r2);
    }
    void merge(uint64_t rep) {                           // underflow -> merge/rebalance
        auto it = blocks.find(rep);
        map<uint64_t,set<uint64_t>>::iterator a, b;
        if (it != blocks.begin()) { b = it; a = prev(it); }
        else if (next(it) != blocks.end()) { a = it; b = next(it); }
        else return;                                     // single block: nothing to do
        vector<uint64_t> v(a->second.begin(), a->second.end());
        v.insert(v.end(), b->second.begin(), b->second.end());
        uint64_t ra = a->first, rb = b->first;
        blocks.erase(ra); reps.erase(ra);
        blocks.erase(rb); reps.erase(rb);
        if (v.size() <= hi()) {                          // fits into one block
            uint64_t r = v.back();
            blocks[r] = set<uint64_t>(v.begin(), v.end()); reps.insert(r);
        } else {                                         // rebalance into two
            size_t m = v.size() / 2;
            uint64_t r1 = v[m - 1], r2 = v.back();
            blocks[r1] = set<uint64_t>(v.begin(), v.begin() + m); reps.insert(r1);
            blocks[r2] = set<uint64_t>(v.begin() + m, v.end());   reps.insert(r2);
        }
    }
};
```

- Both structures were fuzz-tested against `std::set`: tens of thousands of random `insert` / `erase` / `lower_bound` / `predecessor` calls over $w = 16$, all matching. The X-fast trie rebuilds its level tables on each update (correct but slow); the Y-fast trie keeps them small by only inserting representatives.

[watch from 51:34](https://youtu.be/ZAYD8SyRkVc?t=3094)

---

## Bonus: word-level parallelism (a taste of fusion trees)

- The lecture closes with the trick that makes big $w$ a *feature*: pack many small numbers into one word and operate on all of them with a single arithmetic op.
- **Packed compare.** To count how many of $a_1,\dots,a_k$ (each $b$ bits, packed) are $\ge x$: prepend a **guard bit** `1` above each $a_i$ and `0` above each copy of $x$, then **subtract** the two packed words. The guard bit of block $i$ survives as `1` iff $a_i \ge x$ and flips to `0` iff $a_i < x$. One subtraction does $k$ comparisons.

![Packed subtraction A minus X with guard bits: each block's high bit records whether that a_i is at least x, doing k comparisons in one operation](/img/dsa/ZAYD8SyRkVc/frame-00296.png)

- **Broadcast a value.** To build the packed word $x, x, \dots, x$ ($k$ copies) in $O(1)$: multiply the single $x$ by a mask $M$ that has a `1` at the start of each block. Multiplication shifts a copy of $x$ into every block and sums them — the same reason $7 \times 101 = 707$ in decimal.
- **Popcount via multiply.** To sum the $k$ guard bits: AND out everything but the guard bits, then multiply by the block mask so all guard bits pile up (shifted) into one block, and read that block. Multiplication doubles as a parallel prefix-sum.

![Broadcasting x to all blocks by multiplying by a mask, then summing the comparison bits with another multiply by the same mask](/img/dsa/ZAYD8SyRkVc/frame-00396.png)

- **Highest set bit in $O(1)$.** Split a $w$-bit word into $\sqrt{w}$ blocks of $\sqrt{w}$ bits. Build a $\sqrt{w}$-bit sketch marking which blocks are nonzero (using packed compare-against-zero and a multiply to gather the marks); find the highest set bit of the sketch to locate the block; recurse once inside that block. Each level is a "highest bit in a $\sqrt{w}$-bit number", solvable by the packed-compare count of satisfied inequalities. This needs $O(\log k)$ spare bits per block to hold the sum — the recurring caveat.
- **Caveat / why this is theory.** All of this leans on **$O(1)$ multiplication of $w$-bit words**, which is exactly the operation that is not really constant-time, and it only helps when $w$ is large. Powerful on paper, rarely worth it in practice.

[watch from 1:12:00](https://youtu.be/ZAYD8SyRkVc?t=4320)

---

## Complexity recap

Let $n$ = number of keys, $w$ = word size in bits, $U = 2^w$ the universe. Recall $w \ge \log n$, so $\log w \ge \log\log n$ and $\log w = \log\log U$.

| Operation | X-fast trie | Y-fast trie | Balanced BST |
| --- | --- | --- | --- |
| `lower_bound` / predecessor | $O(\log w)$ | $O(\log w)$ | $O(\log n)$ |
| `insert` | $O(w)$ | $O(\log w)$ amortized | $O(\log n)$ |
| `erase` | $O(w)$ | $O(\log w)$ amortized | $O(\log n)$ |
| Space | $O(n\,w)$ | $O(n)$ | $O(n)$ |

- Predecessor in $O(\log w) = O(\log\log U)$ is the headline. Van Emde Boas trees hit the same bound with a different structure; **fusion trees** (next lecture) trade to $O(\log_w n)$, and choosing the better of the two per $(n,w)$ sorts in $o(n\log n)$.

---

## Practice problems

**Honest note:** X-fast / Y-fast tries (and van Emde Boas trees) are **theory data structures** — they essentially never appear in interviews, and in real code a balanced BST (`std::set`, `TreeMap`) or a **bitwise trie** is used instead. The nearest interview-relevant skills are ordered-set / predecessor queries and bitwise-trie search; the competitive links below are where the ideas actually show up.

**🎯 Interview (MAANG-style) — the ordered-set / predecessor skill**

- [Range Module — LeetCode 715](https://leetcode.com/problems/range-module/) — Hard — maintain a set of intervals with add/remove/query; the canonical ordered-set-of-boundaries problem, the same "find the block a point falls in" move as Y-fast bucketing.
- [Count Integers in Intervals — LeetCode 2276](https://leetcode.com/problems/count-integers-in-intervals/) — Hard — merge intervals on insert using `lower_bound` on an ordered map; predecessor/successor navigation in disguise.
- [My Calendar I — LeetCode 729](https://leetcode.com/problems/my-calendar-i/) — Medium — ordered-map `lower_bound` to detect the neighbor booking; gentle warm-up for the two above.
- [Maximum XOR of Two Numbers in an Array — LeetCode 421](https://leetcode.com/problems/maximum-xor-of-two-numbers-in-an-array/) — Medium — build a **bitwise trie** over the numbers and walk it bit by bit; the practical cousin of the X-fast bit-trie.

**🏆 Competitive**

- [Fenwick / order-statistics tree — cp-algorithms](https://cp-algorithms.com/data_structures/fenwick.html) — the standard integer-key toolkit for predecessor/rank queries when you do not want a full BST.
- [Aho–Corasick — cp-algorithms](https://cp-algorithms.com/string/aho_corasick.html) — the trie machinery this lecture reuses; good to revisit since X-fast tries are "tries over integers".
- [USACO Guide — data structures springboard](https://usaco.guide/adv/springboards) — curated advanced problems where a bitwise trie answers predecessor / max-XOR style queries.

> There is **no** official Codeforces home-task post in this lecture's description, so none is linked here.

---

## Further reading

- [X-fast trie — Wikipedia](https://en.wikipedia.org/wiki/X-fast_trie) — the level hash tables and LCP search, formally.
- [Y-fast trie — Wikipedia](https://en.wikipedia.org/wiki/Y-fast_trie) — bucketing, representatives, and the amortized analysis.
- [van Emde Boas tree — Wikipedia](https://en.wikipedia.org/wiki/Van_Emde_Boas_tree) — the other $O(\log\log U)$ predecessor structure with the same bound.
- [Fusion tree — Wikipedia](https://en.wikipedia.org/wiki/Fusion_tree) — next lecture's structure, the $O(\log_w n)$ side of the trade.
- [Trie — Wikipedia](https://en.wikipedia.org/wiki/Trie) and [Trie insert and search — GeeksforGeeks](https://www.geeksforgeeks.org/trie-insert-and-search/) — the base data structure.

---

## Key takeaways

- Comparison-only structures are stuck at $\Omega(\log n)$; **integers** unlock arithmetic and bit tricks that beat it.
- An **X-fast trie** = bit-trie + **per-level hash tables** + **binary search on the longest common prefix** → predecessor in $O(\log w)$, but $O(n\,w)$ space and $O(w)$ updates.
- A **Y-fast trie** = **bucket $\Theta(w)$ keys per block** into balanced BSTs, keep **representatives** in an X-fast trie → $O(\log w)$ everywhere (updates amortized via B-tree split/merge) in **$O(n)$** space.
- $\log w = \log\log U \le \log\log n$-ish territory: exponentially better than $\log n$ when words are small.
- **Use a balanced BST or a bitwise trie in practice.** These structures are a beautiful theory result and the on-ramp to fusion trees and word-parallelism.

## Glossary

- **Word-RAM model** — memory of $w$-bit words; arithmetic, bitwise, and shift ops on a word cost $O(1)$; complexity is a function of $n$ and $w$.
- **Predecessor / `lower_bound`** — largest stored key $\le x$ / smallest stored key $\ge x$.
- **X-fast trie** — binary trie over key bit-strings with a hash table of node-prefixes per level, giving $O(\log w)$ predecessor.
- **Longest common prefix search** — binary-searching the deepest node-prefix of a query, exploiting monotonicity of prefix existence.
- **Y-fast trie** — X-fast trie of block representatives plus balanced BSTs per block, giving $O(\log w)$ ops in $O(n)$ space.
- **Representative** — one key (or boundary) per block promoted into the X-fast trie to route queries to the right block.
- **Amortized cost** — average cost per operation over a worst-case sequence; here split/merge is $O(w)$ but happens only every $\Omega(w)$ updates, so $O(1)$ amortized.
