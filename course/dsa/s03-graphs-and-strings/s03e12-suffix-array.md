---
title: "S03E12 · Suffix Array"
sidebar_position: 12
description: Building a suffix array in O(n log n) by prefix doubling with counting sort, substring search by binary search, and the LCP array via Kasai's linear-time algorithm.
---

# S03E12 · Suffix Array

> **Source:** Pavel Mavrin, [_A&DS S03E12_](https://youtu.be/dpu0RDXZAH0) · 1h35m lecture → ~15 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- A **suffix array** is the list of all suffixes of a string in lexicographic order, stored as just their **start indices** — one integer array of length $n$, not the $\Theta(n^2)$ characters of the suffixes themselves.
- Any **substring** of the text is a **prefix of some suffix**, so a substring query reduces to a **binary search** over the sorted suffixes: $O(|q|\log n)$ per query.
- Naively sorting suffixes with a full string comparator is $O(n^2\log n)$ worst case; hashing plus binary-search comparison cuts it to $O(n\log^2 n)$.
- The lecture's main algorithm is **prefix doubling**: over $\log n$ phases, sort all cyclic shifts of length $2^k$ by treating each as a **pair of two half-classes**; with **counting sort** each phase is $O(n)$, giving $O(n\log n)$ total.
- The **LCP array** (longest common prefix of adjacent suffixes) is built in $O(n)$ by **Kasai's algorithm** — walk suffixes longest-to-shortest and reuse the previous overlap, dropping at most one character per step.
- With the LCP array plus a range-minimum structure, the LCP of *any* two suffixes is a min-query over the array between their ranks.

---

## What a suffix array is, and how to store it

- Take a string $s$ and list **all its suffixes in lexicographic order**, including the empty suffix first.
- Running example all lecture: $s = \text{abbaba}$. The sorted suffixes are the empty one, then `a`, `aba`, `abbaba`, `ba`, `baba`, `bbaba`.
- **Do not store the suffixes as strings.** Their total length is $1 + 2 + \dots + n = \Theta(n^2)$ — far too much.
- Instead store only the **start index** of each suffix. Index the characters $0,1,\dots,n-1$, with $n$ standing for the empty suffix at the end.
- The result is one integer array $p$ (the "suffix array"): $p[r]$ is the start index of the suffix of rank $r$. For $s=\text{abbaba}$ it is $p = [6,5,3,0,4,2,1]$.

![Suffix Array title board: s = abbaba with all suffixes listed in lexicographic order, empty suffix first](/img/dsa/dpu0RDXZAH0/frame-00013.png)

- The index array is enough to recover any character of any suffix in $O(1)$: the $j$-th character of the suffix of rank $i$ is $s[\,p[i]+j\,]$ — you never need the strings.

![The p array with the S[p[i]+j] character-access formula written underneath](/img/dsa/dpu0RDXZAH0/frame-00042.png)

- **Data structure:** a single `vector<int> p` of length $n$. For text of a million characters you add just one array of a million integers — extremely memory-compact.

[watch from 2:17](https://youtu.be/dpu0RDXZAH0?t=137)

---

## Why: substring search by binary search

- Classic use case: you hold a fixed **text** and answer many **substring queries** $q$ arriving **one at a time** (you cannot batch them, so Aho–Corasick from the previous lecture does not apply).
- **Key observation:** every substring of the text is a **prefix of some suffix**. So "does $q$ occur" becomes "is there a suffix that starts with $q$".
- Because the suffixes are sorted, **binary search** for the first suffix that is $\ge q$. If any occurrence of $q$ exists, that first suffix must start with $q$ — check its prefix and read off the position from $p$.

![Binary search locating Q = abb: the first suffix greater-or-equal to abb must start with abb](/img/dsa/dpu0RDXZAH0/frame-00048.png)

- The comparator compares $q$ against a suffix character by character, so one comparison costs $O(|q|)$ and the whole query is $O(|q|\log n)$ — near-linear, since $\log n$ is small in practice.

```cpp
// Substring search: returns a start index where q occurs in s, or -1.
// s has the sentinel appended; p is its suffix array. compare() stops at |q|.
int contains(const string& s, const vector<int>& p, const string& q) {
    int n = (int)s.size();
    int lo = 0, hi = n;                       // find first suffix >= q
    while (lo < hi) {
        int mid = (lo + hi) / 2;
        if (s.compare(p[mid], q.size(), q) < 0) lo = mid + 1;
        else                                    hi = mid;
    }
    if (lo < n && s.compare(p[lo], q.size(), q) == 0) return p[lo];
    return -1;                                // no suffix starts with q
}
```

- With extra precomputation the query can be pushed to $O(|q| + \log n)$ (reuse characters already matched at earlier binary-search steps) — the lecturer leaves this as an exercise.

[watch from 10:26](https://youtu.be/dpu0RDXZAH0?t=626)

---

## Simple constructions (and why they are not enough)

- **Just sort.** Fill $p$ with $0\dots n-1$ and run any $O(n\log n)$ sort with a string comparator. The comparator walks both suffixes to the first differing character.
- **Worst case $O(n^2\log n)$:** on a string of one repeated letter every comparison scans to the end. On genuinely **random** strings the common prefix is short with exponentially decaying probability, so the comparator is near-$O(1)$ and this is a legitimately good, zero-extra-memory choice.
- **Hashing plus binary search.** To compare two suffixes, find their longest common prefix by binary searching its length, testing equality of prefixes with **polynomial hashes** ($O(1)$ per test). Each comparison becomes $O(\log n)$, so sorting is $O(n\log^2 n)$.

![Board listing "1) Just sort O(n log n comp) → O(n^2 log n)" and "2) Bin search + hashes O(n log^2 n)"](/img/dsa/dpu0RDXZAH0/frame-00081.png)

- **Drawbacks of the hashing route:** any hash **collision** silently corrupts the sort (one wrong comparison breaks the whole order), and modular hashing carries a heavy constant. The main algorithm below is exact and faster.

[watch from 17:57](https://youtu.be/dpu0RDXZAH0?t=1077)

---

## Main algorithm: prefix doubling

**Three preprocessing tricks** make the suffixes uniform and easy to sort:

- Append a **sentinel** character (written `$` on the board, in code the `'\0'` byte) that is **smaller than every real character**. It never changes the suffix order, and it guarantees no suffix is a prefix of another.
- Extend every suffix to full length by **wrapping the string cyclically** — so instead of suffixes we sort **cyclic shifts** of equal length. The order is identical because the sentinel forces the first difference before the wrap ever matters.
- Pad the length up to a **power of two** by continuing the cyclic characters, so we can always split a length-$2^{k+1}$ block into two length-$2^k$ halves.

**The doubling idea.** Run phases $k = 0, 1, 2, \dots$. In phase $k$ we have all blocks of length $2^k$ sorted, with a **class array** $c$: equal blocks share a class number, and smaller blocks get smaller numbers. To sort blocks of length $2^{k+1}$, split each into two halves of length $2^k$ and compare them as a **pair of classes**:

$$
A < B \iff \big(c[A_1] < c[B_1]\big)\ \text{or}\ \big(c[A_1]=c[B_1]\ \text{and}\ c[A_2] < c[B_2]\big)
$$

which is exactly comparing the pairs $(c[A_1],c[A_2])$ and $(c[B_1],c[B_2])$ — an **$O(1)$ comparison**.

![Phase k board: sort blocks S from i to i plus 2^k minus 1; split A and B into two halves of length 2^k; comparator says A is less than B iff the pair A1 A2 is less than the pair B1 B2](/img/dsa/dpu0RDXZAH0/frame-00160.png)

- **The second half is easy to locate:** the block at position $i$ has first half at $i$ and second half at $i + 2^k$ (modulo $n$ in the cyclic string). We already know both halves' classes from the previous phase, so each pair is read off in $O(1)$.

![Comparator restated as pairs: A is less than B when the pair A1 A2 is less than the pair B1 B2, with the two half-blocks drawn](/img/dsa/dpu0RDXZAH0/frame-00186.png)

- **Building the class array $c$.** After sorting, walk the sorted order top to bottom assigning $0,1,2,\dots$; give **equal adjacent blocks the same number**, bump the number when they differ. Equal blocks are detected by equal pairs, again $O(1)$.

### Worked run on `abbaba`

- **Phase $k=0$** sorts single characters. Sorted indices $p = [6,5,3,0,4,2,1]$ (the sentinel index 6 first, then the three `a`s, then the two `b`s), and the class array by index is $c=[1,2,2,1,2,1,0]$ (sentinel `$`→0, `a`→1, `b`→2).
- **Phase $k=1$** sorts blocks of length 2 by pairs $(c[i],\,c[i+1])$; re-sort, recompute classes.
- **Phase $k=2$** sorts blocks of length 4 by pairs $(c[i],\,c[i+2])$. Now **all classes are distinct**, so every suffix is uniquely ordered and we stop early — the array is the final suffix array.

![Run-through of k=0,1,2 for abbaba: p and c arrays at each phase, ending when all classes differ](/img/dsa/dpu0RDXZAH0/frame-00267.png)

- **Early exit:** once the number of classes equals $n$, all suffixes are distinguished and no further phase is needed.

![Board with k=1 pairs (Bi, Ai) and the class column C being filled from the sorted order](/img/dsa/dpu0RDXZAH0/frame-00214.png)

[watch from 25:40](https://youtu.be/dpu0RDXZAH0?t=1540)

---

## From O(n log² n) to O(n log n): counting sort the pairs

- Sorting the array afresh each phase with a general sort gives $O(n\log n)$ per phase and $O(n\log^2 n)$ total.
- But each phase sorts **pairs of small integers** in $[0, n)$. That is exactly what **radix / counting sort** handles in $O(n)$: counting-sort by the **second** component, then a **stable** counting-sort by the **first** component.
- Result: **$O(n)$ per phase $\times \log n$ phases $= O(n\log n)$**, exact and hash-free.

Full construction, compile-tested against a brute-force sort of all suffixes:

```cpp
#include <bits/stdc++.h>
using namespace std;

// Suffix array via prefix doubling + counting sort, O(n log n).
// Append a sentinel '\0' (smallest) to s before calling; then p[0] is the
// empty suffix and every suffix is uniquely ordered.
vector<int> build_suffix_array(const string& s) {
    int n = (int)s.size();
    vector<int> p(n), c(n);                 // p = order, c = class per index

    // ---- phase k = 0: counting-sort single characters ----
    {
        vector<int> cnt(256, 0);
        for (int i = 0; i < n; i++) cnt[(unsigned char)s[i]]++;
        for (int i = 1; i < 256; i++) cnt[i] += cnt[i - 1];
        for (int i = 0; i < n; i++) p[--cnt[(unsigned char)s[i]]] = i;
        c[p[0]] = 0;
        int classes = 1;
        for (int i = 1; i < n; i++) {
            if (s[p[i]] != s[p[i - 1]]) classes++;
            c[p[i]] = classes - 1;
        }
    }

    // ---- phases k = 1,2,... : sort length-2h blocks by pair (c[i], c[i+h]) ----
    vector<int> pn(n), cn(n);
    for (int h = 1; h < n; h <<= 1) {
        // p is already ordered by the SECOND half from the previous phase;
        // shifting by -h turns "order by block at i+h" into "order by second half".
        for (int i = 0; i < n; i++) {
            pn[i] = p[i] - h;
            if (pn[i] < 0) pn[i] += n;
        }
        // stable counting-sort by the FIRST half's class -> radix sort of pairs
        vector<int> cnt(n, 0);
        for (int i = 0; i < n; i++) cnt[c[pn[i]]]++;
        for (int i = 1; i < n; i++) cnt[i] += cnt[i - 1];
        for (int i = n - 1; i >= 0; i--) p[--cnt[c[pn[i]]]] = pn[i];
        // recompute classes from the pairs (c[i], c[i+h])
        cn[p[0]] = 0;
        int classes = 1;
        for (int i = 1; i < n; i++) {
            pair<int,int> cur = {c[p[i]],     c[(p[i] + h) % n]};
            pair<int,int> prv = {c[p[i - 1]], c[(p[i - 1] + h) % n]};
            if (cur != prv) classes++;
            cn[p[i]] = classes - 1;
        }
        c.swap(cn);
        if (classes == n) break;            // all suffixes distinct -> done
    }
    return p;
}
```

- **Data structures:** `p` (current order), `c` (class of each start index — the RMQ-friendly "rank"), plus two scratch arrays. All $O(n)$ memory.
- **On linear-time SA.** With alphabet size $O(n)$ one *can* build a suffix array in $O(n)$ (e.g. via a suffix tree, or DC3/SA-IS), but the constant factor and memory are worse; in practice this $O(n\log n)$ doubling method is usually the fastest and is what gets used.

![Board: total complexity — phase 0 costs n log n, each of log n phases costs O(n) with counting sort → O(n log n)](/img/dsa/dpu0RDXZAH0/frame-00357.png)

[watch from 52:20](https://youtu.be/dpu0RDXZAH0?t=3140)

---

## LCP array and Kasai's O(n) algorithm

- For many problems the suffix array alone is not enough; you also need the **longest common prefix** of two suffixes: $\operatorname{lcp}(a,b)$ is the maximal $k$ with $s[a..a+k-1] = s[b..b+k-1]$.
- **LCP of any two suffixes reduces to adjacent ones.** Between the ranks of two suffixes, every suffix in between shares their common prefix (sorted order), so the LCP of the two equals the **minimum** of the adjacent LCPs across that rank range — a **range-minimum query** (sparse table or segment tree).

![Reduction: lcp of two suffixes at ranks i and j is the minimum of adjacent lcps l[i+1..j]](/img/dsa/dpu0RDXZAH0/frame-00307.png)

- So it suffices to precompute $L$ where $L[i] = \operatorname{lcp}$ of the suffixes at ranks $i-1$ and $i$.

**Kasai's insight.** Process suffixes from **longest to shortest** (in start-index order $i = 0\dots n-1$). Suppose suffix $i$ and its predecessor in the SA share $k$ characters. Dropping the first character of both gives suffixes $i+1$ and its own predecessor, which must share **at least $k-1$** characters — so we never re-compare those. We drop at most one from $k$ per step and only ever grow $k$ by matching, so the total work is $O(n)$ (a two-pointer argument).

![Kasai transition: suffix i and previous share k; removing the first char leaves at least k-1 shared for suffix i+1](/img/dsa/dpu0RDXZAH0/frame-00357.png)

```cpp
// LCP array via Kasai, O(n). lcp[r] = LCP of the suffixes at ranks r-1 and r
// (lcp[0] = 0). Requires the suffix array p of s (with sentinel).
vector<int> build_lcp(const string& s, const vector<int>& p) {
    int n = (int)s.size();
    vector<int> pos(n);                     // pos[i] = rank of suffix i
    for (int i = 0; i < n; i++) pos[p[i]] = i;
    vector<int> lcp(n, 0);
    int k = 0;
    for (int i = 0; i < n; i++) {           // suffixes longest -> shortest
        if (pos[i] == 0) { k = 0; continue; }
        int j = p[pos[i] - 1];              // predecessor suffix in the SA
        while (i + k < n && j + k < n && s[i + k] == s[j + k]) k++;
        lcp[pos[i]] = k;
        if (k > 0) k--;                     // reuse: next step keeps k-1
    }
    return lcp;
}
```

- **Board pseudocode** (matches the code above): `for i in 0..n-1: j = p[pos[i]-1]; while s[i+k]==s[j+k]: k++; l[pos[i]] = k; if k>0: k--`.

![Board with Kasai's loop written out: k set to 0; loop over i; j is p at pos i minus 1; while characters equal increment k; l at pos i equals k; if k is positive decrement k; linear time O(n)](/img/dsa/dpu0RDXZAH0/frame-00367.png)

- **Why linear:** $k$ increases only inside the `while` (bounded total increase $\le n$) and decreases by at most 1 across the $n$ iterations, so both movements are $O(n)$ — the same two-pointer accounting used for Z-function and the "newborn" (Z/prefix) algorithms.

[watch from 74:34](https://youtu.be/dpu0RDXZAH0?t=4474)

---

## Complexity recap

| Operation | Best | Average | Worst | Space |
| --- | --- | --- | --- | --- |
| Build SA — plain sort + string cmp | $\Theta(n\log n)$ | — | $\Theta(n^2\log n)$ | $O(1)$ extra |
| Build SA — hashing + binary search cmp | $\Theta(n\log^2 n)$ | $\Theta(n\log^2 n)$ | $\Theta(n\log^2 n)$ | $O(n)$ |
| Build SA — doubling + counting sort | $\Theta(n\log n)$ | $\Theta(n\log n)$ | $\Theta(n\log n)$ | $O(n)$ |
| Build LCP — Kasai | $\Theta(n)$ | $\Theta(n)$ | $\Theta(n)$ | $O(n)$ |
| Substring search (per query $q$) | $O(\log n)$ | $O(\lvert q\rvert\log n)$ | $O(\lvert q\rvert\log n)$ | $O(1)$ |
| LCP of any two suffixes (after RMQ build) | $O(1)$ | $O(1)$ | $O(1)$ | $O(n\log n)$ sparse table |

---

## Practice problems

The interview payload here is **substring / repeated-substring** questions; the competitive payload is the CSES string section, where suffix arrays and their LCP shine.

**🎯 Interview (MAANG-style)**

- [Longest Duplicate Substring — LeetCode 1044](https://leetcode.com/problems/longest-duplicate-substring/) — Hard — binary search on length with hashing, or the single largest value of the LCP array.
- [Maximum Length of Repeated Subarray — LeetCode 718](https://leetcode.com/problems/maximum-length-of-repeated-subarray/) — Medium — longest common substring of two arrays; concatenate with a separator and read the LCP array (or DP).
- [Number of Distinct Substrings in a String — LeetCode 1698](https://leetcode.com/problems/number-of-distinct-substrings-in-a-string/) — Medium — count all substrings then subtract repeats, i.e. $\binom{n+1}{2} - \sum \operatorname{lcp}$ over the suffix array.
- [Suffix Array — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/suffix-array-set-1-introduction/) — Medium — build the array and answer pattern queries.

**🏆 Competitive**

- [Finding Borders — CSES 1732](https://cses.fi/problemset/task/1732) — Medium — all borders of a string (prefix = suffix); a string-structure staple.
- [Finding Periods — CSES 1733](https://cses.fi/problemset/task/1733) — Medium — all periods, dual to borders.
- [Counting Patterns — CSES 2103](https://cses.fi/problemset/task/2103) — Easy — for each query pattern, count its occurrences; binary search on the suffix array gives the occurrence range.

> No official Codeforces home-task post is linked from this lecture's description; the lecturer points to his own Codeforces suffix-array lesson, which is where he writes the full code and problem set.

---

## Further reading

- [Suffix array — cp-algorithms](https://cp-algorithms.com/string/suffix-array.html) — the same doubling-plus-counting-sort construction with applications (comparison, LCP, distinct substrings).
- [Suffix Array — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/suffix-array-set-1-introduction/) — introduction with a naive build and search.
- [Suffix array — Wikipedia](https://en.wikipedia.org/wiki/Suffix_array) and [LCP array — Wikipedia](https://en.wikipedia.org/wiki/LCP_array).

---

## Key takeaways

- Store suffixes as **indices**, sorted — one $O(n)$ integer array captures all substrings of the text compactly.
- **Substring search = binary search** on the suffix array: any substring is a prefix of a suffix, so find the first suffix $\ge q$.
- **Prefix doubling** sorts length-$2^{k+1}$ blocks by comparing them as **pairs of length-$2^k$ classes**; **counting-sort the pairs** to hit $O(n\log n)$, and stop early once all classes are distinct.
- The sentinel plus cyclic padding turn awkward variable-length suffixes into uniform cyclic shifts — conceptual scaffolding you can drop in an optimized implementation.
- **Kasai** builds the LCP array in $O(n)$ by reusing overlap between consecutive suffixes; combined with an RMQ it answers the LCP of any two suffixes.

## Glossary

- **Suffix array** — the start indices of all suffixes of a string, in lexicographic order.
- **Sentinel** — an appended character smaller than every real one, so no suffix is a prefix of another.
- **Class array $c$** — maps each block-start index to its rank among equal-length blocks; equal blocks share a class.
- **Prefix doubling** — sorting blocks of length $2^{k+1}$ from sorted blocks of length $2^k$ by pairing halves.
- **LCP array** — for each adjacent pair in the suffix array, the length of their longest common prefix.
- **Kasai's algorithm** — linear-time LCP-array construction that walks suffixes longest-to-shortest, reusing overlap.
- **RMQ** — range-minimum query; over the LCP array it yields the LCP of any two suffixes.
