---
title: "S03E15 · Fusion Tree"
sidebar_position: 15
description: A B-tree of branching factor w^(1/5) whose nodes do predecessor search in O(1) via sketch compression, one-word parallel comparison, and highest-differing-bit recovery — giving o(log n) predecessor and sub-n-log-n integer sorting on the word-RAM.
---

# S03E15 · Fusion Tree

> **Source:** Pavel Mavrin, [_A&DS S03E15_](https://youtu.be/jomxjWLmlYU) · 1h24m lecture → ~16 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- A **fusion tree** answers the same queries as a balanced BST over integers (`insert`, `remove`, `lower_bound`), but in $O(\log_w n)$ per operation — which is $o(\log n)$ once $w$ is large.
- Strange twist: the structure gets **faster** as the word size $w$ grows, because a single machine-word multiply does many bit operations in parallel. It leans on the word-RAM assumption that arithmetic on $w$-bit words (including multiply) is $O(1)$.
- It is a **B-tree** with branching factor $b = w^{1/5}$, so its height is $\log_b n = \Theta(\log_w n)$. The whole trick is doing **predecessor among $b$ keys in $O(1)$** inside each node.
- Each node compresses its $b$ keys down to their **interesting bits** (the at most $b-1$ trie branch points) — the **sketch**. Sketches are only $b^4$ bits wide, so all $b$ of them fit in one word and can be compared in parallel with one multiply-subtract-mask.
- Sketch search finds a neighbour; the true answer is recovered by taking the **longest common prefix** of $x$ with the neighbour's full key via one XOR and one highest-set-bit.
- Combined with y-fast tries, you get predecessor in $O(\sqrt{\log n})$ for **every** $w$, and hence integer sorting in $o(n \log n)$ — beating the comparison-sort lower bound because we are no longer comparison-only.

---

## The setup: same job as a BST, different clock

- We store a set of integers and support `insert(x)`, `remove(x)`, and `lower_bound(x)` = the minimal $y$ in the set with $y \ge x$ (exactly C++ `std::set::lower_bound`).
- Last lecture's **y-fast trie** does this in $O(\log w)$. A plain balanced BST does it in $O(\log n)$. Which is better depends on whether $w$ or $n$ is smaller.
- The fusion tree targets $O(\log_w n)$. Note the direction: as $w$ grows, y-fast tries get **slower** ($\log w$ up) but the fusion tree gets **faster** ($\log_w n$ down).
- Why can more bits help? The **word-RAM** model charges $O(1)$ for $+$, $-$, $\times$, comparisons, and bit ops on a whole $w$-bit word. A multiply of long integers secretly does $\Theta(w^2)$ bit-pair products "for free", so a bigger word means more parallel work per unit time.
- Caveat the lecturer stresses: constant-time multiply of huge integers is a **modeling assumption**. Real CPUs give it only for 64/128-bit words, so the fusion tree is a theory result — to reach branching factor 4 you already need $w \ge 4^5 = 1024$-bit words.

[watch from 3:18](https://youtu.be/jomxjWLmlYU?t=198)

---

## A B-tree with branching factor b

- Build a **B-tree** (the balanced multiway search tree from an earlier lecture): each node holds about $b$ children and $b-1$ separator keys, splitting the key range into $b$ segments.
- Height of a $b$-ary tree over $n$ elements is $\log_b n$. We want this to be $\Theta(\log_w n) = \Theta\!\left(\tfrac{\log n}{\log w}\right)$.

$$
\log_b n = \frac{\log n}{\log b}, \qquad \text{want } = \Theta\!\left(\frac{\log n}{\log w}\right) \ \Rightarrow\ \log b = \Theta(\log w).
$$

- So any $b = w^{\alpha}$ works, since $\log_b n = \tfrac{1}{\alpha}\log_w n$. The lecture fixes $\boxed{b = w^{1/5}}$ (the exponent $1/5$ is exactly what the sketch-window construction later needs).

![A multiway search tree whose node splits the key range into segments less than x1, between x1 and x2, and so on, with branching factor b equal to w to the one fifth](/img/dsa/jomxjWLmlYU/frame-00070.png)

- Walking a query $x$ from the root: at each node, find which of the $b$ segments contains $x$ (a `lower_bound` among the node's $b-1$ keys), descend, repeat. Total cost is (height) $\times$ (per-node cost).
- **Everything reduces to one subproblem:** given $b$ keys inside a node and a query $x$, compute `lower_bound` in $O(1)$. If we can, the whole operation is $O(\log_w n)$.

[watch from 15:38](https://youtu.be/jomxjWLmlYU?t=938)

---

## Interesting bits: the trie has only b−1 branch points

- Take the $b$ keys of a node as bit-strings and build a **compressed binary trie** (like a radix tree). Example on the board: $w = 8$, $b = 4$, keys sorted:

```text
a1 = 0 0 0 1 1 0 0 1
a2 = 0 0 1 0 1 0 0 1
a3 = 1 0 1 0 1 0 0 0
a4 = 1 0 1 1 0 1 1 1
```

![Compressed trie of the four keys with red branch nodes at the bits where the paths split](/img/dsa/jomxjWLmlYU/frame-00113.png)

- A trie over $b$ leaves has at most $b-1$ **branch nodes** (internal nodes with two children). Every branch node inspects one bit position — call these the **interesting bits**.
- Equivalently: the interesting bits are exactly the positions where two **consecutive sorted keys first differ**. With $b$ keys there are $b-1$ consecutive pairs, so at most $b-1$ interesting bits.
- On the board the interesting positions are bits $7, 5, 4$ (numbering from the most significant). Consecutive pairs differ first at: $a_1,a_2$ at bit 5; $a_2,a_3$ at bit 7; $a_3,a_4$ at bit 4.

![The four keys with the three interesting bit columns circled, above the derived three-bit sketches](/img/dsa/jomxjWLmlYU/frame-00129.png)

**Key insight:** the interesting bits alone distinguish the keys from one another. Two keys agree on all interesting bits only if they are equal.

[watch from 28:00](https://youtu.be/jomxjWLmlYU?t=1680)

---

## The sketch: compress each key to its interesting bits

- The **sketch** of a key keeps only its interesting bits, packed contiguously (most-significant interesting bit on top). Because the top interesting bit is always present, **sketches preserve the sorted order** of the keys.

For the board keys, interesting bits $\{7,5,4\}$ give:

```text
key            bit7 bit5 bit4    sketch
a1 0001 1001     0    0    1      001
a2 0010 1001     0    1    0      010
a3 1010 1000     1    1    0      110
a4 1011 0111     1    1    1      111
```

- A sketch is only about $b$ bits of information (the $b-1$ interesting bits). The query is sketched the same way. For $x = 0011\,1011$ the interesting bits give $\text{sketch}(x) = 011$.

![The four sketches 001 010 110 111 and the query x equals 0011 1011 with sketch 011](/img/dsa/jomxjWLmlYU/frame-00138.png)

- **Strategy for `lower_bound`:** first find, among the sketches, the one sharing the **longest common prefix** with $\text{sketch}(x)$. That points at a candidate key; then recover the exact answer from the candidate's full key (next section). Here $011$ sits between $010$ and $110$, so the neighbour is $a_2$.

![Query x split into its interesting bits producing the query sketch x-prime equal to 011](/img/dsa/jomxjWLmlYU/frame-00158.png)

**Data structure per node:** the sorted keys, the list of interesting bit positions, and the packed sketches. Invariant: sketches are sorted iff keys are sorted.

[watch from 29:07](https://youtu.be/jomxjWLmlYU?t=1747)

---

## Longest common prefix in O(1): one XOR, one highest bit

- Given two integers $a, b$, the length of their common prefix is found by XOR: $a \oplus b$ is $0$ on the shared prefix and has its **highest set bit** exactly at the first place they differ.

$$
\mathrm{lcp}(a,b) = (w-1) - \operatorname{highbit}(a \oplus b), \qquad \operatorname{highbit}(0) \ \text{undefined} \Rightarrow \mathrm{lcp} = w.
$$

- $\operatorname{highbit}$ (most-significant set bit) is the constant-time word-RAM primitive from the previous lecture (here realized with a hardware count-leading-zeros).

![Computing the common prefix of a and b as the highest set bit of a xor b](/img/dsa/jomxjWLmlYU/frame-00190.png)

- **Why sketch-neighbour then real LCP is correct:** if you walk the trie using the bits of $x$, you make identical branch choices as walking with the bits of the neighbour key at every interesting bit — because their sketches share the longest prefix. So the first place $x$ diverges from the trie is exactly the first differing full-key bit, i.e. $\mathrm{lcp}(x, \text{neighbour})$. That branch point plus the direction of divergence pins down the predecessor/successor.

```cpp
#include <bits/stdc++.h>
using namespace std;
typedef unsigned long long u64;

// most-significant set-bit index (word-RAM O(1) primitive)
int highest_bit(u64 x){ return x ? 63 - __builtin_clzll(x) : -1; }

// longest common prefix length of a,b over a w-bit window (bit w-1 = MSB)
int lcp_len(u64 a, u64 b, int w){
    u64 d = a ^ b;                 // zero exactly on the shared prefix
    if(!d) return w;
    return (w - 1) - highest_bit(d);
}
```

[watch from 45:33](https://youtu.be/jomxjWLmlYU?t=2733)

---

## Parallel comparison: all b sketches in one word

- Since each sketch is tiny and there are only $b$ of them, **pack all sketches into a single word** and compare them to $\text{sketch}(x)$ simultaneously — the same multiply/subtract/mask trick as the y-fast-trie lecture.
- Layout: give each sketch its own field of $r+1$ bits ($r$ sketch bits plus one high **guard** bit). Replicate $\text{sketch}(x)$ into every field with a multiply, subtract, then read the guard bits: a guard survives the subtraction iff that packed sketch was $\ge \text{sketch}(x)$. Popcount of the surviving guards gives the **rank** of $x$ in one shot.

```cpp
struct FusionNode {
    int w = 0, B = 0;
    vector<u64> key;             // B sorted keys, each w bits
    vector<int> ib;              // interesting bit positions, DESCENDING (MSB-first)
    vector<u64> sketch;          // per-key sketch: interesting bits packed MSB-first

    // sketch(v): keep only interesting bits, most-significant interesting bit on top
    u64 make_sketch(u64 v) const {
        u64 s = 0;
        for(int p : ib){ s = (s << 1) | ((v >> p) & 1ull); }
        return s;
    }

    void build(vector<u64> keys, int w_){
        w = w_;
        sort(keys.begin(), keys.end());
        key = keys; B = key.size();
        // interesting bits = trie branch points = first-differing bit of each consecutive pair
        set<int, greater<int>> S;                       // DESCENDING => MSB-first packing
        for(int i = 0; i + 1 < B; i++) S.insert(highest_bit(key[i] ^ key[i + 1]));
        ib.assign(S.begin(), S.end());
        sketch.resize(B);
        for(int i = 0; i < B; i++) sketch[i] = make_sketch(key[i]);
    }

    // count sketches strictly < sx, comparing ALL of them in ONE word (parallel compare)
    int rank_by_parallel_compare(u64 sx) const {
        int r = (int)ib.size();          // bits per sketch
        int f = r + 1;                   // field width = sketch + 1 guard bit
        if(f * B > 63){                  // safety fallback if fields would overflow a 64-bit word
            int c = 0; for(u64 s : sketch) if(s < sx) c++; return c;
        }
        u64 packed = 0, guards = 0, spread = 0;
        for(int i = 0; i < B; i++){
            packed |= (sketch[i] << (i * f));
            guards |= (1ull << (i * f + r));   // guard bit of field i
            spread |= (1ull << (i * f));       // low bit of field i
        }
        u64 rep  = spread * sx;                // sx copied into every field
        u64 diff = (packed | guards) - rep;    // guard survives iff sketch_field >= sx
        u64 ge   = diff & guards;
        return B - __builtin_popcountll(ge);   // number strictly < sx
    }

    u64 lower_bound(u64 x) const {
        u64 sx = make_sketch(x);
        int r = rank_by_parallel_compare(sx);       // sketch[0..r-1] < sx <= sketch[r..]
        int c = (r < B) ? r : B - 1;                // a sketch-neighbour of x
        // real answer sits at the deeper of the two full-key LCPs around c
        int p1 = (c > 0) ? lcp_len(x, key[c - 1], w) : -1;
        int p2 =           lcp_len(x, key[c],     w);
        int best = (p1 >= p2) ? c - 1 : c;
        int p = max(p1, p2);
        if(p == w) return key[best];                // exact hit
        // branch bit: if x escapes the trie to the right, the successor is the next key up
        int bit = w - 1 - p;
        int i = best;
        if((x >> bit) & 1ull) { while(i < B && key[i] <  x) i++; }
        else                  { while(i > 0 && key[i - 1] >= x) i--; }
        if(i < B && key[i] >= x) return key[i];
        while(i < B && key[i] < x) i++;
        return (i < B) ? key[i] : ULLONG_MAX;
    }
};
```

**Compile-tested** with `c++ -std=c++17`. The driver below reproduces the board and cross-checks against a linear predecessor on 500000 random nodes:

```cpp
u64 ref_lb(const vector<u64>& ks, u64 x){
    u64 b = ULLONG_MAX; for(u64 k : ks) if(k >= x) b = min(b, k); return b;
}

int main(){
    int w = 8;
    vector<u64> keys = {0b00011001, 0b00101001, 0b10101000, 0b10110111}; // board a1..a4
    FusionNode nd; nd.build(keys, w);

    cout << "interesting bits (MSB-first):";
    for(int p : nd.ib) cout << " " << p;                     // 7 5 4
    cout << "\nsketches:";
    for(u64 s : nd.sketch) cout << " " << bitset<3>(s);      // 001 010 110 111
    cout << "\nsketch(x=00111011) = " << bitset<3>(nd.make_sketch(0b00111011)); // 011
    cout << "\nlower_bound(x)     = " << bitset<8>(nd.lower_bound(0b00111011)); // 10101000
    cout << "\n";

    mt19937_64 rng(2024); int trials = 500000, ok = 0;
    for(int t = 0; t < trials; t++){
        int B = 2 + rng() % 6; set<u64> ss;
        while((int)ss.size() < B) ss.insert(rng() & 0xFF);
        vector<u64> ks(ss.begin(), ss.end());
        FusionNode n2; n2.build(ks, w);
        u64 q = rng() & 0xFF;
        ok += (n2.lower_bound(q) == ref_lb(ks, q));
    }
    cout << "random lower_bound vs linear: " << ok << "/" << trials << "\n";
    return 0;
}
```

Output:

```text
interesting bits (MSB-first): 7 5 4
sketches: 001 010 110 111
sketch(x=00111011) = 011
lower_bound(x)     = 10101000
random lower_bound vs linear: 500000/500000
```

[watch from 36:41](https://youtu.be/jomxjWLmlYU?t=2201)

---

## Building the sketch by multiplication

- The one non-trivial primitive: given a word $a$ and a set of interesting bit positions, gather those (scattered) bits into a **small contiguous window** in $O(1)$.
- Masking away the other bits is trivial ($a \mathbin{\&} \text{mask}$). Moving the survivors together is the hard part — they sit at irregular distances.
- Trick: multiply by a carefully chosen constant $M = \sum_j 2^{m_j}$. Multiplication is "shift-and-add", so $a \cdot M$ places a copy of interesting bit $b_i$ at every position $b_i + m_j$.

![Multiplying A by the mask M places bit b-i at positions b-i plus m-j, spreading b copies of each interesting bit](/img/dsa/jomxjWLmlYU/frame-00227.png)

- We only keep the copies landing at positions $b_i + m_i$ (the "diagonal"). We need those $m_j$ chosen so that:
  1. all $b_i + m_i$ are **distinct** (no two interesting bits collide and corrupt each other),
  2. they come out in **increasing order** (preserving bit order), and
  3. they fit in a **window of width less than $b^4$**.

![Three constraints on the shifts m: the b-i plus m-j all different, b-i plus m-i increasing, and the used positions fit a window of width at most b to the fourth](/img/dsa/jomxjWLmlYU/frame-00246.png)

- **Existence of good shifts (counting argument):** pick $m_1, m_2, \dots$ one at a time. Force each landing slot $b_i + m_i$ into its own sub-window (so ordering and the $b^4$ bound hold for free). For distinctness, when choosing $m_i$ the earlier $i-1$ bits occupy about $(i-1)^2$ forbidden positions, and each candidate $m_i$ forbids about $i$ more; total forbidden is $O(b^3)$, but there are $b^3$ candidate slots — so a valid $m_i$ always exists. The search may be slow (brute force), but it is done once, offline, per node.
- Result: the sketch has width $b^4$. Since $b = w^{1/5}$, a sketch is $w^{4/5}$ bits, so all $b = w^{1/5}$ of them pack into $b \cdot b^4 = b^5 = w$ bits — exactly one word. That is the reason for the exponent $1/5$.

```cpp
// The sketch built by multiply-and-mask. The shift set {m_j} is chosen offline so that
// the landing positions b_i + m_i are distinct, increasing, and inside a width-(b^4) window.
struct SketchByMultiply {
    int w, r;                 // r = number of interesting bits
    vector<int> ib;           // interesting positions, ascending
    vector<int> m;            // chosen shifts
    u64 M = 0;                // multiplier (sum of 2^{m_j})
    u64 window = 0;           // keep only the r diagonal landing bits
    int lo = 0;               // window base, to shift the gathered bits down

    void build(vector<int> interesting, int w_){
        w = w_; ib = interesting; sort(ib.begin(), ib.end()); r = (int)ib.size();
        m.assign(r, 0);
        set<int> used;                              // occupied landing positions
        for(int i = 0; i < r; i++){
            for(int cand = 0; ; ++cand){            // brute force a legal shift (offline, allowed slow)
                int pos = ib[i] + cand;
                bool ok = !used.count(pos) && (i == 0 || pos > ib[i - 1] + m[i - 1]);
                if(ok){ m[i] = cand; used.insert(pos); break; }
            }
        }
        M = 0; for(int i = 0; i < r; i++) M |= (1ull << m[i]);
        lo = ib[0] + m[0];
        window = 0; for(int i = 0; i < r; i++) window |= (1ull << (ib[i] + m[i]));
    }

    u64 operator()(u64 v) const {
        u64 kept = 0; for(int p : ib) kept |= (v & (1ull << p));   // 1. mask out uninteresting bits
        unsigned __int128 prod = (unsigned __int128)kept * M;      // 2. multiply gathers copies
        u64 gathered = (u64)prod & window;                         // 3. keep the diagonal copies
        return gathered >> lo;                                     // 4. compact into low bits
    }
};
```

> The greedy shift search above always terminates and produces distinct, ordered landing bits; on some inputs the resulting sketch is not the minimal one, but correctness of `lower_bound` never relies on sketch minimality — the final answer is always re-derived from the full key via `lcp_len`.

[watch from 49:52](https://youtu.be/jomxjWLmlYU?t=2992)

---

## Dynamic operations and the o(log n) headline

- **Insert / remove** need the node's interesting bits, sketches and mask **rebuilt**, which costs about $b^4$ — too slow if done at every level. Fix it exactly like B-trees: split each node's keys into blocks of size $b^4$; a plain BST inside each block handles the local step. Then `insert`/`remove` cost $O(\log_w n + \log b)$, and $\log(b^4) = 4\log b = O(\log b)$.
- **Choosing the structure per $(n,w)$.** y-fast tries cost $O(\log w)$; fusion trees cost $O(\log_w n)$. Pick whichever is smaller. Their crossover is where $\log w = \log_w n$, i.e. $(\log w)^2 = \log n$, giving both at $\sqrt{\log n}$.

![Two curves for y-fast trie log w rising and fusion tree log-base-w n falling, crossing at square root of log n; pick the lower structure](/img/dsa/jomxjWLmlYU/frame-00310.png)

- **Result:** for *every* word size $w$, predecessor is achievable in $O(\sqrt{\log n})$ — independent of $w$, and asymptotically below the $\Theta(\log n)$ of comparison-based BSTs.
- Concretely the fusion tree uses $b = 2^{\sqrt{\log n}/5}$, which is $\le w^{1/5}$ in the regime where it wins, and yields $\log_b n = \Theta(\sqrt{\log n})$.

### Why o(log n) sorting is possible on the word-RAM

- The classic $\Omega(n \log n)$ sorting bound is a **comparison-model** bound: it counts only yes/no key comparisons. It says nothing once you are allowed to do arithmetic on the keys themselves.
- Feeding integers through a predecessor structure sorts them, so a fusion tree sorts $n$ integers in $O(n \sqrt{\log n})$ — genuinely $o(n \log n)$. This does not contradict the lower bound because the fusion tree inspects **bits and products of keys**, not just comparisons.
- The best known deterministic integer sort is $O(n \sqrt{\log n})$ (Han–Thorup style ideas build on exactly these word tricks); whether integers can be sorted in linear time on the word-RAM is a famous **open problem**.

[watch from 1:09:45](https://youtu.be/jomxjWLmlYU?t=4185)

---

## Complexity recap

| Operation | Fusion tree | y-fast trie | Balanced BST | Space |
| --- | --- | --- | --- | --- |
| `lower_bound` / predecessor | $O(\log_w n)$ | $O(\log w)$ | $O(\log n)$ | $O(n)$ |
| `insert` / `remove` | $O(\log_w n + \log b)$ | $O(\log w)$ amortized | $O(\log n)$ | $O(n)$ |
| Predecessor, best structure per $w$ | $O(\sqrt{\log n})$ | — | — | $O(n)$ |
| Sort $n$ integers | $O(n\sqrt{\log n})$ | — | $O(n\log n)$ | $O(n)$ |
| Node predecessor among $b$ keys | $O(1)$ | — | $O(\log b)$ | $O(b)$ |

---

## Practice problems

> **Reality check:** fusion trees are deep word-RAM theory. They essentially never appear in interviews and are rare even in competitive programming (radix/bitwise structures are used in practice). The problems below build the *adjacent* intuition — binary trie predecessor and bit tricks — not the fusion tree itself.

**🎯 Interview (MAANG-style)** — closest tangible ideas, all bit-trie based

- [Maximum XOR of Two Numbers in an Array — LeetCode 421](https://leetcode.com/problems/maximum-xor-of-two-numbers-in-an-array/) — Medium — build a binary trie of the numbers and walk it bit by bit; this is the "trie over integer bits" that fusion nodes compress.
- [Maximum XOR With an Element From Array — LeetCode 1707](https://leetcode.com/problems/maximum-xor-with-an-element-from-array/) — Hard — offline queries on a bit trie with a value bound; predecessor-flavoured trie traversal.
- [Number of 1 Bits — LeetCode 191](https://leetcode.com/problems/number-of-1-bits/) — Easy — popcount, the exact primitive the parallel-compare step relies on.
- [Search Insert Position — LeetCode 35](https://leetcode.com/problems/search-insert-position/) — Easy — the plain `lower_bound` the node solves in $O(1)$; do the $O(\log b)$ version first to feel the gap.

**🏆 Competitive**

- No official Codeforces home-task post is linked for this lecture (it is the semester's final, theory-only session).
- [Fenwick / BIT — cp-algorithms](https://cp-algorithms.com/data_structures/fenwick.html) — the practical word-level structure you actually reach for; contrast its $O(\log n)$ with the fusion tree's $O(\log_w n)$.
- [Segment tree — cp-algorithms](https://cp-algorithms.com/data_structures/segment_tree.html) — the everyday predecessor/range structure that fusion trees improve on only in theory.

---

## Further reading

- [Fusion tree — Wikipedia](https://en.wikipedia.org/wiki/Fusion_tree) — sketches, parallel comparison, and the Fredman–Willard result.
- [Word RAM — Wikipedia](https://en.wikipedia.org/wiki/Word_RAM) — the computational model that makes constant-time multiply meaningful.
- [Predecessor problem — Wikipedia](https://en.wikipedia.org/wiki/Predecessor_problem) — where fusion trees sit among van Emde Boas, x-fast and y-fast tries.
- [Van Emde Boas tree — Wikipedia](https://en.wikipedia.org/wiki/Van_Emde_Boas_tree) and [y-fast trie — Wikipedia](https://en.wikipedia.org/wiki/Y-fast_trie) — the $O(\log w)$ half of the crossover.
- [Integer sorting — Wikipedia](https://en.wikipedia.org/wiki/Integer_sorting) — how sub-$n\log n$ integer sorts (including $O(n\sqrt{\log n})$) are built.
- [Perfect hash function — Wikipedia](https://en.wikipedia.org/wiki/Perfect_hash_function) — the compression idea underlying sketches.
- [Trie — insert and search (GeeksforGeeks)](https://www.geeksforgeeks.org/dsa/trie-insert-and-search/) — the compressed trie the node's interesting bits come from.

---

## Key takeaways

- A fusion tree is a B-tree of branching factor $w^{1/5}$; the height $\Theta(\log_w n)$ is only useful because each node answers predecessor in $O(1)$.
- The $O(1)$ node search is three moves: **sketch** (keep the at-most $b-1$ interesting bits), **parallel-compare** all sketches in one word (multiply, subtract, mask guard bits, popcount), and **recover** the true answer with one XOR + highest-bit LCP.
- The sketch is built by one multiply against an offline-chosen mask, spreading scattered bits into a width-$b^4$ window; $b = w^{1/5}$ makes all $b$ sketches fit one word.
- Picking the better of fusion tree and y-fast trie gives predecessor in $O(\sqrt{\log n})$ for all $w$, and integer sorting in $o(n\log n)$ — legal because we use arithmetic on keys, not just comparisons.
- It is a theory landmark, not a practical structure: useful branching factors demand thousand-bit words.

## Glossary

- **Word-RAM** — model where each $O(1)$-cost operation acts on a whole $w$-bit word, including multiply.
- **Interesting bit** — a bit position that is a branch point of the node's trie; there are at most $b-1$ of them.
- **Sketch** — a key compressed to just its interesting bits, packed contiguously, order-preserving.
- **Parallel comparison** — comparing a value against many packed sub-words at once via multiply/subtract/mask.
- **Highest set bit** — most-significant 1-bit of a word; an $O(1)$ word-RAM primitive used for LCP.
- **Branching factor** $b$ — number of children per node, set to $w^{1/5}$.
