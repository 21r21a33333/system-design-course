---
title: "S03E09 · String Hashing, KMP & Z-Algorithm"
sidebar_position: 9
description: The substring-search problem solved three ways — polynomial hashing with O(1) substring hashes, the KMP prefix function as a matching automaton, and the Z-function with its linear [l,r] window, all in O(n+m).
---

# S03E09 · String Hashing, KMP & Z-Algorithm

> **Source:** Pavel Mavrin, [_A&DS S03E09_](https://youtu.be/6t_1eRO-Cqo) · 1h33m lecture → ~16 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- The **substring-search problem**: given text $T$ of length $n$ and pattern $S$ of length $m$, find where $S$ occurs in $T$. Brute force is $O(nm)$.
- **Polynomial hashing** maps a string to $\text{hash}(s) = \big(s_0 x^{m-1} + s_1 x^{m-2} + \dots + s_{m-1}\big) \bmod M$. With random $x$ and prime $M$, two distinct length-$m$ strings collide with probability $\le m/M$.
- **Prefix hashes** let you compute the hash of **any** substring in $O(1)$: $\text{hash}(l,r) = p_r - p_l \cdot x^{r-l}$. This makes hashing a general-purpose "compare any two substrings" tool, not just a matcher.
- **KMP** builds the **prefix function** $\pi$ — the length of the longest proper border (prefix that is also a suffix) of every prefix — in $O(n)$ via a two-pointers argument. Matching is then substring search on $S \; \# \; T$.
- The **Z-function** computes, for each $i$, the longest common prefix of $s$ and its suffix $s[i..]$. Linear time comes from a maintained rightmost match window $[l, r)$.
- Both KMP and Z solve substring search in $\mathbf{O(n+m)}$ with tiny constants; hashing is $O(n+m)$ **expected** and can fail on a collision.

---

## The substring-search problem

- A **string** is an array of letters; you index any letter $s[i]$ in $O(1)$, exactly like an array.
- Named parts (all half-open):
  - **prefix** $s[0..i-1]$ — the first $i$ letters.
  - **suffix** $s[i..n-1]$ — the last letters.
  - **substring** $s[l..r-1]$ — any contiguous block.
- Useful identities the lecturer stresses: every **substring is a suffix of some prefix**, and equivalently a **prefix of some suffix**. KMP exploits the first view; the Z-function exploits the second.
- **Problem.** Given text $T$ (length $n$) and pattern $S$ (length $m$), find an index $i$ with $T[i..i+m-1] = S$. Sometimes you want the first occurrence, sometimes **all** of them.

**Brute force.** Slide $S$ over every start position and compare:

```cpp
#include <bits/stdc++.h>
using namespace std;

// all start positions i with T[i..i+m-1] == S
vector<int> bruteFind(const string& S, const string& T) {
    vector<int> res;
    int m = (int)S.size(), n = (int)T.size();
    for (int i = 0; i + m <= n; i++)          // i = 0 .. n-m
        if (T.compare(i, m, S) == 0) res.push_back(i);
    return res;
}
```

- The outer loop runs $n$ times; each comparison is up to $m$ characters, so the total is $O(nm)$.
- Correct but slow. The rest of the lecture makes it $O(n+m)$.

![Board: substring-search setup with brute-force loop and O(nm) bound](/img/dsa/6t_1eRO-Cqo/frame-00031.png)

[watch from 3:46](https://youtu.be/6t_1eRO-Cqo?t=226)

---

## Speeding up comparison with hashes (Rabin–Karp)

- **Key observation:** almost every comparison in brute force *fails*. Most of the runtime is spent proving two strings are **not** equal.
- **Idea:** instead of comparing the strings character-by-character, compare a **hash** of each. If two strings are equal, their hashes are equal; so if the hashes differ, the strings differ — reject in $O(1)$.
- Two things must be true for this to help:
  1. **Few collisions** — distinct strings should rarely share a hash.
  2. **Cheap recomputation** — computing a fresh hash naively is $O(m)$, which buys nothing. We need to slide the window in $O(1)$.

![Board: comparing hashes instead of strings — equal strings force equal hashes; a collision is the reverse failing](/img/dsa/6t_1eRO-Cqo/frame-00070.png)

[watch from 7:14](https://youtu.be/6t_1eRO-Cqo?t=434)

---

## The polynomial hash function

- Treat each character as a number and read the string as coefficients of a polynomial evaluated at $x$, all modulo $M$:

$$\text{hash}(s) = \Big(s_0\,x^{m-1} + s_1\,x^{m-2} + \dots + s_{m-1}\,x^{0}\Big) \bmod M.$$

- The hash is a **family**, parameterised by $(x, M)$: pick $M$ a random big prime, and $x$ a random value in $0 \dots M-1$. You then choose one function at random from the family.

**Why collisions are rare.** Suppose two distinct length-$m$ strings $a$ and $b$ collide. Then their difference polynomial is zero at $x$:

$$(a_0 - b_0)\,x^{m-1} + (a_1 - b_1)\,x^{m-2} + \dots + (a_{m-1} - b_{m-1}) \equiv 0 \pmod M.$$

- This is a nonzero polynomial of degree $\le m-1$ over the field $\mathbb{Z}_M$, so it has **at most $m-1$ roots**. Since $x$ was chosen uniformly among $M$ values, the collision probability is

$$P \le \frac{m}{M}.$$

- So enlarging $M$ shrinks the failure probability to anything you want.

![Board: polynomial hash, random big prime M and random x, collision probability at most m over M](/img/dsa/6t_1eRO-Cqo/frame-00107.png)

[watch from 14:04](https://youtu.be/6t_1eRO-Cqo?t=844)

---

## Rolling the hash across the text

- Cheap recomputation is the second requirement. Let $H$ be the hash of $T[i..i+m-1]$ and $H'$ the hash of the shifted window $T[i+1..i+m]$. Writing both as polynomials and lining up the shared coefficients, everything the two windows share is the same block scaled by one extra power of $x$. So:

$$H' = H\cdot x - T[i]\cdot x^{m} + T[i+m] \pmod M.$$

- Drop the leading term $T[i]\,x^{m}$, multiply the rest by $x$, add the new trailing character. That is $O(1)$ per shift.

**Rabin–Karp search.** Compute $H_S = \text{hash}(S)$ once, roll $H$ over the text, and only fall back to a full character compare when hashes match:

```cpp
#include <bits/stdc++.h>
using namespace std;

const long long M = 1000000007LL, X = 131;

vector<int> rabinKarp(const string& S, const string& T) {
    int m = (int)S.size(), n = (int)T.size();
    vector<int> res;
    if (m > n) return res;
    long long xm = 1;                       // x^m mod M
    for (int i = 0; i < m; i++) xm = xm * X % M;

    long long HS = 0, H = 0;
    for (int i = 0; i < m; i++) {           // hash(S) and hash(T[0..m-1])
        HS = (HS * X + S[i]) % M;
        H  = (H  * X + T[i]) % M;
    }
    for (int i = 0; i + m <= n; i++) {
        if (H == HS && T.compare(i, m, S) == 0) res.push_back(i);
        if (i + m < n)                      // roll to window starting at i+1
            H = ((H * X - (long long)T[i] * xm + T[i + m]) % M + (long long)M * M) % M;
    }
    return res;
}
```

**Time complexity.** With $M \gtrsim m^2$ the expected work is

$$n\Big(1 + \tfrac{m^2}{M}\Big) + m \;=\; O(n + m),$$

where the $\tfrac{m^2}{M}$ term is the expected cost of spurious full comparisons.

> **Double hashing note.** A single 32-bit or 64-bit hash is beatable and, in a set of $k$ strings, the collision probability is roughly $k^2 p$ — it grows *quadratically* in $k$. Guard against it by using a **larger modulus** (64- or 128-bit) or by pairing **two independent** hashes $(x_1, M_1)$ and $(x_2, M_2)$ and treating strings as equal only when both agree.

![Board: rolling-hash update H' = H·x − T[i]·xᵐ + T[i+m] with the O(n(1+m²/M)+m) analysis](/img/dsa/6t_1eRO-Cqo/frame-00150.png)

[watch from 21:03](https://youtu.be/6t_1eRO-Cqo?t=1263)

---

## Hash of any substring in O(1)

- Beyond sliding a fixed window, hashing becomes a general tool once you can hash **any** substring $s[l..r-1]$ in $O(1)$.
- **Precompute prefix hashes** $p$, where $p_i = \text{hash}(s[0..i-1])$. Extending a prefix by one character is one polynomial step:

$$p_{i+1} = p_i \cdot x + s_i.$$

- To carve out $s[l..r-1]$, take the prefix hash up to $r$ and subtract the prefix hash up to $l$, shifted so the powers of $x$ line up:

$$\text{hash}(l, r) = p_r - p_l \cdot x^{\,r-l} \pmod M.$$

```cpp
#include <bits/stdc++.h>
using namespace std;

struct Hashing {
    int n;
    vector<long long> p, pw;                 // prefix hashes, powers of x
    long long M, X;
    Hashing(const string& s, long long X_ = 131, long long M_ = 1000000007LL)
        : n((int)s.size()), p(n + 1, 0), pw(n + 1, 1), M(M_), X(X_) {
        for (int i = 0; i < n; i++) {
            p[i + 1]  = (p[i] * X + s[i]) % M;   // p[i+1] = p[i]*x + s[i]
            pw[i + 1] = pw[i] * X % M;
        }
    }
    long long sub(int l, int r) const {          // hash of s[l..r-1]
        return ((p[r] - p[l] * pw[r - l]) % M + M) % M;
    }
};
```

- Now you can **compare two arbitrary substrings** in $O(1)$, count **distinct** substrings, binary-search longest common extensions, and more. That flexibility is what makes hashing worth the collision risk.
- Note the honest tradeoff: an algorithm that *trusts* hashes to never collide is an algorithm that is *occasionally wrong*. For non-critical systems that is fine; for critical ones prefer a deterministic method (KMP or Z) when one exists.

![Board: prefix-hash recurrence p[i+1]=p[i]·x+s[i] and substring formula hash(l,r)=p[r]−p[l]·x^(r−l)](/img/dsa/6t_1eRO-Cqo/frame-00161.png)

[watch from 34:41](https://youtu.be/6t_1eRO-Cqo?t=2081)

---

## KMP: the prefix function

- The **prefix function** $\text{pref}(s)$ of a string is the length of the **longest proper border**: the longest string that is **both a prefix and a suffix** of $s$, and not equal to $s$ itself.
- Examples from the board:
  - $\text{pref}(\texttt{abbab}) = \texttt{ab}$ (length 2).
  - $\text{pref}(\texttt{ababa}) = \texttt{aba}$ (length 3 — the prefix and suffix are allowed to overlap).
  - $\text{pref}(\texttt{aabb}) = \varepsilon$ (length 0).
  - $\text{pref}(\varepsilon)$ is **undefined** — the only border would be $s$ itself, which is disallowed. In code we set it to $-1$, a sentinel that makes the loop terminate cleanly.

**All borders, not just the longest.** Every border of $s$ is itself a border of the longest border. So iterating $\pi, \pi(\pi), \pi(\pi(\pi)), \dots$ enumerates **all** borders in decreasing length. This "border chain" is exactly what the construction and the matcher walk.

![Board: prefix-function definition with worked examples abbab, ababa, aabb, empty string](/img/dsa/6t_1eRO-Cqo/frame-00198.png)

[watch from 44:44](https://youtu.be/6t_1eRO-Cqo?t=2684)

### Building the array

- Define $p[i] = $ prefix function of the length-$i$ prefix $s[0..i-1]$. For the string `abbaabbabb` the array is:

$$p = [\,-1,\;0,\;0,\;0,\;1,\;1,\;2,\;3,\;4,\;1,\;2\,]$$

(index 0 is the empty-string sentinel).

- **Transition.** To compute $p[i]$, the border of $s[0..i-1]$ is a border of $s[0..i-2]$ **extended by the character $s[i-1]$**. So take $k = p[i-1]$; while the candidate character $s[k]$ does not match $s[i-1]$, fall back along the border chain $k \leftarrow p[k]$. When you either match or hit $-1$, the answer is $k+1$.

```cpp
#include <bits/stdc++.h>
using namespace std;

// p[i] = length of longest proper border of s[0..i-1]; p[0] = -1 (empty)
vector<int> prefixFunction(const string& s) {
    int n = (int)s.size();
    vector<int> p(n + 1);
    p[0] = -1;
    for (int i = 1; i <= n; i++) {
        int k = p[i - 1];
        while (k >= 0 && s[k] != s[i - 1]) k = p[k];  // walk the border chain
        p[i] = k + 1;
    }
    return p;
}
```

**Why it is $O(n)$.** Look at $k$. Inside the `while` loop, $k$ strictly decreases (since $p[k] < k$). Between outer iterations $k$ increases by at most $1$ (we store $k+1$ and read it back next step). So over the whole run $k$ increases at most $n$ times, hence it can decrease at most $n$ times — total loop iterations are $O(n)$. It is the **two-pointers** argument: the left border of the matched block only moves right.

![Board: five-line prefix-function code with p[0]=−1 and the k=p[k] fallback, plus the O(n) argument](/img/dsa/6t_1eRO-Cqo/frame-00258.png)

[watch from 61:16](https://youtu.be/6t_1eRO-Cqo?t=3676)

### KMP as a matcher

- To search, build one string $S \; \# \; T$ where `#` is a separator that appears in neither $S$ nor $T$, then compute its prefix function.
- Wherever $p[i] = m = |S|$, the length-$m$ prefix (which is $S$) reappears as a suffix ending at that position — an occurrence of $S$ in $T$. The separator guarantees a border can never straddle the boundary, so $p[i]$ never exceeds $m$.
- This is precisely the "prefix function as a **finite-state automaton**" view: $p[i]$ is the automaton's current state, and matching $S$ corresponds to reaching the accepting state $m$.

```cpp
#include <bits/stdc++.h>
using namespace std;

vector<int> prefixFunction(const string&);   // defined above

// all start positions of pattern S inside text T, in O(n+m)
vector<int> kmpFind(const string& S, const string& T) {
    string s = S + '\x01' + T;               // '\x01' = separator in neither string
    vector<int> p = prefixFunction(s), res;
    int m = (int)S.size();
    for (int i = 1; i <= (int)s.size(); i++)
        if (p[i] == m) res.push_back(i - 2 * m - 1);  // map back to index in T
    return res;
}
```

![Board: KMP substring search via S # T and the condition p[i] = length(S)](/img/dsa/6t_1eRO-Cqo/frame-00277.png)

[watch from 67:58](https://youtu.be/6t_1eRO-Cqo?t=4078)

---

## The Z-function

- The **Z-function** looks at the same information from the other side. For each $i$, $z[i]$ is the largest $k$ such that

$$s[0..k-1] = s[i..i+k-1],$$

i.e. the length of the longest common prefix of $s$ and its suffix starting at $i$. By convention $z[0]$ is unused (it would be $n$).

- **Slow version** (quadratic): for each $i$, extend character-by-character while $s[z] = s[i+z]$. On `aaaa...` this is $O(n^2)$.

![Board: Z-function definition z(i)=max k with s[0..k-1]=s[i..i+k-1] and the slow O(n²) loop](/img/dsa/6t_1eRO-Cqo/frame-00314.png)

[watch from 71:54](https://youtu.be/6t_1eRO-Cqo?t=4314)

### The linear [l, r] window

- Maintain the **rightmost** match block seen so far: the position $l$ (among already-processed $i$) that maximises $l + z[l]$. Call the right edge $r = l + z[l]$. Inside $[l, r)$ the text equals the prefix, so we already know characters there.
- When computing $z[i]$ for $i$ inside the window, the block $s[l..r-1]$ equals $s[0..r-l-1]$, so the value at the mirror position $i-l$ carries over — but only up to the window's right edge. Initialise:

$$z[i] = \max\!\big(0,\ \min(\,r - i,\ z[i-l]\,)\big),$$

then extend past $r$ with the naive loop, and finally push the window right if the new block reaches farther:

```cpp
#include <bits/stdc++.h>
using namespace std;

// z[i] = length of longest common prefix of s and s[i..]; z[0] unused (=0)
vector<int> zFunction(const string& s) {
    int n = (int)s.size();
    vector<int> z(n, 0);
    int l = 0, r = 0;                        // window [l, r) = [l, l+z[l])
    for (int i = 1; i < n; i++) {
        if (i < r) z[i] = min(r - i, z[i - l]);          // reuse mirror, clamp to r
        while (i + z[i] < n && s[z[i]] == s[i + z[i]]) z[i]++;  // extend past r
        if (i + z[i] > r) { l = i; r = i + z[i]; }        // slide window right
    }
    return z;
}
```

- The clamp to $r-i$ is the "small implementation detail" the lecturer flags: without it $z[i]$ could over-run the known region (or go negative if written as $l + z[l] - i$ without the $\max(\cdot, 0)$).

**Why it is $O(n)$.** The `while` loop only runs when $i$ reaches $r$; each iteration pushes $r$ strictly right. Since $r$ never exceeds $n$, the total number of `while` iterations across all $i$ is at most $n$ — the same two-pointers argument as KMP, just from the left edge. Everything else is $O(1)$ per $i$, so overall $O(n)$.

**Z as a matcher.** Same trick: run the Z-function on $S \; \# \; T$; wherever $z[i] = m$, the pattern occurs.

```cpp
#include <bits/stdc++.h>
using namespace std;

vector<int> zFunction(const string&);        // defined above

vector<int> zFind(const string& S, const string& T) {
    string s = S + '\x01' + T;
    vector<int> z = zFunction(s), res;
    int m = (int)S.size();
    for (int i = m + 1; i < (int)s.size(); i++)
        if (z[i] == m) res.push_back(i - m - 1);
    return res;
}
```

![Board: linear Z with z[i]=min(z[i−l], l+z[l]−i), the while-extend, and the l-update, plus the [l,r] picture](/img/dsa/6t_1eRO-Cqo/frame-00344.png)

- KMP and Z compute "kind of the same thing from different sides." Given one array you can convert to the other. For some problems the border view (KMP) is natural; for others the common-prefix view (Z) is.

![Board: the two-pointers correctness argument for Z — the sum l+z[l] only grows, bounded by 2n](/img/dsa/6t_1eRO-Cqo/frame-00358.png)

[watch from 76:08](https://youtu.be/6t_1eRO-Cqo?t=4568)

---

## Complexity recap

| Operation | Best | Average | Worst | Space |
|---|---|---|---|---|
| Brute-force search | $O(n)$ | $O(nm)$ | $O(nm)$ | $O(1)$ |
| Build prefix hashes | $O(n)$ | $O(n)$ | $O(n)$ | $O(n)$ |
| Substring hash query | $O(1)$ | $O(1)$ | $O(1)$ | $O(1)$ |
| Rabin–Karp search | $O(n+m)$ | $O(n+m)$ exp. | $O(nm)$ (collisions) | $O(1)$ |
| KMP prefix function | $O(n)$ | $O(n)$ | $O(n)$ | $O(n)$ |
| KMP / Z search | $O(n+m)$ | $O(n+m)$ | $O(n+m)$ | $O(n+m)$ |

- Hashing's worst case is adversarial: a crafted input that forces collisions degrades it to $O(nm)$. KMP and Z are worst-case linear with no randomness.

---

## Practice problems

**🎯 Interview (MAANG-style)**
- [LeetCode 28 · Find the Index of the First Occurrence in a String](https://leetcode.com/problems/find-the-index-of-the-first-occurrence-in-a-string/) — Easy — the canonical KMP / Z drill: first occurrence of pattern in text.
- [LeetCode 1392 · Longest Happy Prefix](https://leetcode.com/problems/longest-happy-prefix/) — Hard — literally $\pi[n]$: the longest proper border of the whole string.
- [LeetCode 459 · Repeated Substring Pattern](https://leetcode.com/problems/repeated-substring-pattern/) — Easy — periodicity check via the prefix function: $s$ is a repeat iff $n - \pi[n]$ divides $n$.
- [LeetCode 214 · Shortest Palindrome](https://leetcode.com/problems/shortest-palindrome/) — Hard — prefix function of $s \; \# \; \text{reverse}(s)$ finds the longest palindromic prefix.
- [LeetCode 187 · Repeated DNA Sequences](https://leetcode.com/problems/repeated-dna-sequences/) — Medium — rolling polynomial hash over length-10 windows.
- [LeetCode 686 · Repeated String Match](https://leetcode.com/problems/repeated-string-match/) — Medium — how many copies of $a$ must be concatenated so $b$ is a substring; KMP over a bounded concatenation.
- [GeeksforGeeks · KMP Algorithm for Pattern Searching](https://www.geeksforgeeks.org/kmp-algorithm-for-pattern-searching/) — Medium — full prefix-function build and match walkthrough.
- [GeeksforGeeks · Z-Algorithm for Pattern Searching](https://www.geeksforgeeks.org/z-algorithm-linear-time-pattern-searching-algorithm/) — Medium — the linear-window Z construction end to end.

**🏆 Competitive**
- [CSES 1753 · String Matching](https://cses.fi/problemset/task/1753) — count occurrences of a pattern in a text; direct KMP / Z / hashing.
- [CSES 1732 · Finding Borders](https://cses.fi/problemset/task/1732) — enumerate all borders of a string by walking the $\pi$-chain from $\pi[n]$.
- [CSES 1733 · Finding Periods](https://cses.fi/problemset/task/1733) — all periods of a string; period $=$ complement of a border, straight from the prefix function.
- No official Codeforces home-task link was published for this lecture; the lecturer defers home tasks (prefix-function-as-automaton, KMP↔Z conversion) to the following practice session.

---

## Further reading

- [cp-algorithms · String Hashing](https://cp-algorithms.com/string/string-hashing.html) — polynomial hashing, choosing $x$ and $M$, and the double-hash safeguard.
- [cp-algorithms · Prefix function (KMP)](https://cp-algorithms.com/string/prefix-function.html) — the construction, the automaton, and applications (periods, compression).
- [cp-algorithms · Z-function](https://cp-algorithms.com/string/z-function.html) — the $[l, r]$ window and matching.
- [Wikipedia · Knuth–Morris–Pratt algorithm](https://en.wikipedia.org/wiki/Knuth%E2%80%93Morris%E2%80%93Pratt_algorithm) — history and the failure-function derivation.
- [Wikipedia · Rabin–Karp algorithm](https://en.wikipedia.org/wiki/Rabin%E2%80%93Karp_algorithm) — the rolling-hash matcher and its expected-time analysis.

---

## Key takeaways

- Substring search has three linear-ish solutions; pick by constraint. **Hashing** is the most flexible (compare any two substrings in $O(1)$) but randomised and collision-prone. **KMP** and **Z** are deterministic $O(n+m)$.
- The polynomial hash's safety rests on one fact: a nonzero degree-$(m-1)$ polynomial over $\mathbb{Z}_M$ has at most $m-1$ roots, so a random $x$ collides with probability $\le m/M$. Enlarge $M$ (or double-hash) to make failure negligible.
- Prefix hashes plus one subtraction give an $O(1)$ substring hash — the workhorse behind distinct-substring counting and longest-common-extension queries.
- The **prefix function** $\pi$ is a border length; its border chain $\pi, \pi(\pi), \dots$ lists all borders, and the matcher reaching state $m$ is an occurrence.
- The **Z-function** is the mirror-image tool; both run in linear time by the identical **two-pointers** argument — a monotone edge ($k$ for KMP, $r$ for Z) that only advances $n$ times.

---

## Glossary

- **Border** — a string that is simultaneously a proper prefix and a proper suffix of $s$.
- **Prefix function $\pi$** — for each prefix, the length of its longest border.
- **Z-value $z[i]$** — length of the longest common prefix of $s$ and the suffix $s[i..]$.
- **Polynomial (rolling) hash** — $\sum s_j x^{m-1-j} \bmod M$; supports $O(1)$ sliding and $O(1)$ substring queries via prefix hashes.
- **Collision** — two distinct strings with equal hash; unavoidable but made improbable by a large prime modulus.
- **Period** — a value $d$ such that $s[i] = s[i+d]$ for all valid $i$; the complement of a border ($d = n - \pi[n]$ for the smallest period).
