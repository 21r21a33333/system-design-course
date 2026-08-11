---
title: "S01E11 · Dynamic Programming, Part 2"
sidebar_position: 11
description: Practical DP — Levenshtein (edit) distance as a two-dimensional table with recurrence and change-log reconstruction, plus Knuth's text-justification DP with cubed-gap badness, and a bonus recursive run-length encoding.
---

# S01E11 · Dynamic Programming, Part 2

> **Source:** Pavel Mavrin, [_A&DS S01E11_](https://youtu.be/kBtTT3fTSc8) · 1h26m lecture → ~14 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- **Edit (Levenshtein) distance** = minimum number of single-character edits — change, remove, insert — to turn string $a$ into string $b$. This is exactly the engine inside the `diff` utility (lines of code play the role of characters).
- The DP is a $(n+1)\times(m+1)$ table $D[i][j]$ = distance between the length-$i$ prefix of $a$ and the length-$j$ prefix of $b$; fill it with one recurrence, read the answer off $D[n][m]$ in $\Theta(nm)$ time.
- To emit the actual **change log**, walk backwards from $D[n][m]$ to $D[0][0]$, reporting the operation taken at each step.
- **Text justification** (the problem Donald Knuth solved for TeX): split words into lines to minimize total *badness*, where a line's badness is the **cube of its trailing gap**. DP over prefixes: $D[i]=\min_k\big(D[i-k]+\mathrm{bad}(i-k,\,i)\big)$, running the width sum on the fly.
- Both are the same shape as last lecture's grasshopper: **you are choosing where to make the last jump**, then reusing the optimum of the remaining prefix.
- Bonus: **recursive run-length encoding** compresses a string with nestable repeats like `2(3AB)`; its DP is over *substrings* $D[l][r]$ and — a first for this course — each state combines **two** smaller subproblems.

---

## Motivation: the diff utility

- A version-control `diff` is handed two files and must reconstruct the **minimal list of edits** that turns the old version into the new one — it has no change log, only the two snapshots.
- Erasing every old line and adding every new line is always *a* valid answer, but not minimal. `diff` wants the shortest edit script so that "small change in one spot" shows as a small diff.
- Replace each line of code with a single character and the problem becomes: **cheapest way to edit one string into another**. That is the Levenshtein distance.

![diff of two program versions on the left; the edit-distance setup for strings A=apple, B=alpine with the three allowed operations](/img/dsa/kBtTT3fTSc8/frame-00060.png)

- Allowed operations, each costing $1$ (the simplest cost model — general edit distance can weight them differently):
  1. **change** a letter,
  2. **add** (insert) a letter,
  3. **remove** (delete) a letter.

[watch from 7:32](https://youtu.be/kBtTT3fTSc8?t=452)

---

## The recurrence: look at the last character

- Fix the running example $a=$ `apple`, $b=$ `alpine`. Compare the **last characters** $x=a[i-1]$ and $y=b[j-1]$ and reduce to a strictly smaller prefix problem.
- **If $x = y$:** it is always optimal (when all costs are equal) to keep that character untouched — no operation — and solve for the two shorter prefixes.

  $$D[i][j] = D[i-1][j-1]$$

- **If $x \ne y$:** at least one operation must touch $x$. There are exactly three ways, each shrinking the problem:
  - **change** $x \to y$, then align $a[0..i-2]$ with $b[0..j-2]$ → $1 + D[i-1][j-1]$;
  - **remove** $x$ from $a$, then align $a[0..i-2]$ with $b[0..j-1]$ → $1 + D[i-1][j]$;
  - **insert** $y$ at the end of $a$, then align $a[0..i-1]$ with $b[0..j-2]$ → $1 + D[i][j-1]$.

  $$D[i][j] = 1 + \min\big(D[i-1][j-1],\; D[i-1][j],\; D[i][j-1]\big)$$

- **Base row/column** (one prefix empty): to turn the empty string into a length-$k$ string you insert $k$ characters, and vice versa, so $D[i][0]=i$, $D[0][j]=j$. On the board this is folded into one line: if $i=0$ or $j=0$, then $D[i][j]=i+j$.

![The full board: state D[i][j], the for-loops, the base case i+j, the equal-character branch D[i-1][j-1], and the min-of-three-plus-one branch, with the empty D table drawn for apple vs alpine](/img/dsa/kBtTT3fTSc8/frame-00120.png)

[watch from 13:32](https://youtu.be/kBtTT3fTSc8?t=812)

---

## The code

- Iterate `i` over prefixes of `a`, `j` over prefixes of `b`, filling row by row. Every cell only reads cells above and to the left, so a single forward sweep is safe.
- The `+ 1` factors out of all three unequal-case options — the lecturer writes it once, outside the `min`.

```cpp
#include <bits/stdc++.h>
using namespace std;

int edit_distance(const string& a, const string& b) {
    int n = a.size(), m = b.size();
    vector<vector<int>> d(n + 1, vector<int>(m + 1, 0));
    for (int i = 0; i <= n; i++) {
        for (int j = 0; j <= m; j++) {
            if (i == 0 || j == 0) {
                d[i][j] = i + j;                  // one prefix empty: insert/delete the rest
            } else if (a[i - 1] == b[j - 1]) {
                d[i][j] = d[i - 1][j - 1];         // last chars equal: keep, no op
            } else {
                d[i][j] = 1 + min({ d[i - 1][j - 1],   // change  x -> y
                                    d[i - 1][j],       // remove  x from a
                                    d[i][j - 1] });    // insert  y into a
            }
        }
    }
    return d[n][m];                                // answer for the two full strings
}

int main() {
    cout << edit_distance("apple", "alpine") << "\n"; // 3
    cout << edit_distance("kitten", "sitting") << "\n"; // 3
    cout << edit_distance("", "abc") << "\n";           // 3
    cout << edit_distance("abc", "abc") << "\n";         // 0
}
```

- **Data structure:** one 2-D array `d` of size $(n+1)\times(m+1)$; invariant — after cell $(i,j)$ is written it holds the true edit distance of the two prefixes. (You can shrink to two rows if you only need the number, not the script.)
- Compiled with `c++ -std=c++17` this prints `3 / 3 / 3 / 0` — `apple` → `alpine` needs three edits, matching the board.

[watch from 22:52](https://youtu.be/kBtTT3fTSc8?t=1372)

---

## Filling the table by hand

- For `apple` (rows) vs `alpine` (columns) the table is $6\times7$. The first row and first column are just $0,1,2,\dots$ — the "empty prefix" base case.
- Then sweep left-to-right, top-to-bottom. At each cell: if the two current letters match, copy the up-left diagonal; otherwise take the min of the three neighbours and add one.

![The partially filled D table for apple vs alpine, matching diagonals copied and mismatches taking min-of-three plus one; the +1 branch labelled add(n)](/img/dsa/kBtTT3fTSc8/frame-00152.png)

- The bottom-right cell reads **3** — three operations: insert `l`, change `p`→`i`, change `l`→`n` (equivalently: change `p`→`l`, then fix the tail). The DP is "smarter than me," as the lecturer quips after his own hand-count briefly disagreed.
- **Symmetry.** With equal costs, edit distance is symmetric: $d(a,b)=d(b,a)$ — every insert going one way is a remove going the other. So the same table solves both directions.

[watch from 27:43](https://youtu.be/kBtTT3fTSc8?t=1663)

---

## Reconstructing the change log

- Computing the number is not enough for a real `diff` — you need the operations. Standard DP reconstruction: start at the final state $(n,m)$ and repeatedly step to the predecessor that produced the current value, recording the operation you undid.
- Which neighbour did we come from? Check them in the same order as the recurrence: a free diagonal move if the letters matched, else whichever of change / remove / insert realizes $D[i][j]$.

```cpp
#include <bits/stdc++.h>
using namespace std;

vector<string> edit_script(const string& a, const string& b) {
    int n = a.size(), m = b.size();
    vector<vector<int>> d(n + 1, vector<int>(m + 1, 0));
    for (int i = 0; i <= n; i++)
        for (int j = 0; j <= m; j++) {
            if (i == 0 || j == 0)            d[i][j] = i + j;
            else if (a[i - 1] == b[j - 1])   d[i][j] = d[i - 1][j - 1];
            else d[i][j] = 1 + min({ d[i - 1][j - 1], d[i - 1][j], d[i][j - 1] });
        }

    vector<string> ops;
    int i = n, j = m;
    while (i > 0 || j > 0) {                       // walk back to (0,0)
        if (i > 0 && j > 0 && a[i - 1] == b[j - 1] && d[i][j] == d[i - 1][j - 1]) {
            i--; j--;                              // kept a matching char, no op
        } else if (i > 0 && j > 0 && d[i][j] == d[i - 1][j - 1] + 1) {
            ops.push_back(string("change ") + a[i - 1] + "->" + b[j - 1]);
            i--; j--;
        } else if (i > 0 && d[i][j] == d[i - 1][j] + 1) {
            ops.push_back(string("remove ") + a[i - 1]);
            i--;
        } else {
            ops.push_back(string("insert ") + b[j - 1]);
            j--;
        }
    }
    reverse(ops.begin(), ops.end());              // we discovered them back-to-front
    return ops;
}

int main() {
    for (auto& s : edit_script("apple", "alpine")) cout << s << "\n";
}
```

- Output — exactly three operations, agreeing with $D[n][m]=3$:

```text
insert l
change p->i
change l->n
```

- Each backward step maps to a move on the table: a diagonal step with an operation is a change, a step up is a remove, a step left is an insert. The path from $(0,0)$ to $(n,m)$ *is* the optimal edit script.

[watch from 33:40](https://youtu.be/kBtTT3fTSc8?t=2020)

- **Scaling note.** The full table is $\Theta(nm)$ time and memory. For two million-line files that is a trillion cells — too much. Real `diff` assumes the files are mostly similar and only computes a **band around the main diagonal**, trading guaranteed optimality for speed when the two inputs are close.

[watch from 38:24](https://youtu.be/kBtTT3fTSc8?t=2304)

---

## Text justification: what makes a paragraph "look nice"

- Setup: a paragraph is a list of words with widths $w_0, w_1, \dots, w_{n-1}$, and a page of width $L$. Split the words into consecutive lines. Only the widths matter, not the letters.
- A greedy "cram each line as full as possible" layout can leave one line with a huge trailing gap when the next word doesn't fit — ugly. We want the gaps spread evenly.
- To optimize we first need a numeric measure of ugliness — **badness**. The insight (Knuth's, for TeX): penalize a gap with a **fast-growing but not too-fast** function. He settled empirically on the **cube**.

![Two candidate layouts of the same six words; the good one has small even gaps, the bad one has one large gap. Below: badness ~ x^3 and the objective sum of badness → min](/img/dsa/kBtTT3fTSc8/frame-00219.png)

- For a line holding words $[l, r)$ with total width $\sum_{i=l}^{r-1} w_i$, the trailing gap is $L - \sum w_i$ and

  $$\mathrm{bad}(l, r) = \Big(L - \sum_{i=l}^{r-1} w_i\Big)^{3}.$$

- A **fully justified** variant (spread the gap between words instead of trailing it) distributes the slack over the $r-l-1$ inter-word gaps:

  $$\mathrm{bad}_{\text{just}}(l, r) = \Big(\frac{L - \sum_{i=l}^{r-1} w_i}{\,r - l - 1\,}\Big)^{3}\cdot (r - l - 1).$$

- The last line is usually exempt from the penalty (a short final line is fine). The rest of the DP is identical whichever badness you pick.

![Two badness formulas: the trailing-gap cube, and the per-gap justified version divided by (r-l-1) then multiplied back; the last-line box marked exempt](/img/dsa/kBtTT3fTSc8/frame-00236.png)

[watch from 42:04](https://youtu.be/kBtTT3fTSc8?t=2524)

---

## The justification DP

- Objective: split the array into lines to **minimize the sum of badness**. As with `diff`, decide the **last line** first, then reuse the optimum of the remaining prefix.
- State: $D[i]$ = minimal total badness for the first $i$ words. Base $D[0]=0$ (zero words need no lines, cost zero).
- Transition: try every possible last-line length $k$ (the last line is words $[i-k, i)$); charge its badness and add the optimum for the prefix before it:

  $$D[i] = \min_{k \ge 1}\big(D[i-k] + \mathrm{bad}(i-k,\, i)\big), \qquad D[0]=0.$$

![The justification DP: D(i) = min over k of ( bad(i-k, i) + D(i-k) ), D(0)=0, with the last-line box of k words drawn over the width-L line](/img/dsa/kBtTT3fTSc8/frame-00281.png)

- **On-the-fly width sum.** Rather than recompute $\sum w$ for every $(l,r)$, grow the last line one word at a time: accumulate `s`, and **break** the moment `s` exceeds `L` — a line wider than the page is invalid, and any longer line is too. This is also what makes it fast in practice.

```cpp
#include <bits/stdc++.h>
using namespace std;
typedef long long ll;

ll cube(ll x) { return x * x * x; }

// Returns { minimal total badness, start index of each line }.
// L = page width, w[i] = width of word i (spaces folded into the widths).
pair<ll, vector<int>> justify(const vector<int>& w, ll L) {
    int n = w.size();
    const ll INF = LLONG_MAX / 4;
    vector<ll> D(n + 1, INF);
    vector<int> from(n + 1, -1);           // from[i] = first word of the line ending at i
    D[0] = 0;
    for (int i = 1; i <= n; i++) {
        ll s = 0;
        for (int k = 1; k <= i; k++) {     // last line = words [i-k, i)
            s += w[i - k];
            if (s > L) break;              // overflows the page: this k and all larger fail
            ll cand = D[i - k] + cube(L - s);
            if (cand < D[i]) { D[i] = cand; from[i] = i - k; }
        }
    }
    vector<int> starts;                    // reconstruct line breaks: walk n -> 0
    for (int i = n; i > 0; i = from[i]) starts.push_back(from[i]);
    reverse(starts.begin(), starts.end());
    return { D[n], starts };
}

int main() {
    vector<int> w = {3, 2, 2, 5, 2, 4};
    auto [bad, starts] = justify(w, 10);
    cout << "min badness = " << bad << "\n";      // 216
    cout << "line starts:";
    for (int s : starts) cout << " " << s;         // 0 3 4
    cout << "\n";
}
```

- **Data structure:** the 1-D array `D` (prefix optima) plus a parallel `from` array of back-pointers; reconstructing the layout is the same backward walk as `diff`, one hop per line instead of per character. Brute force over all splits confirms `216` for this input.
- **Complexity.** Two nested loops → $O(n^2)$ worst case, but the inner loop only runs while a line still fits, i.e. at most the max words-per-line $\approx L$. In practice $L$ is bounded by the page, so it behaves like $O(n \cdot L)$ — a genuinely practical algorithm.

![The complete justification board: bad(l,r), the min-over-k recurrence equal to D(i), the on-the-fly sum with break at s ≥ L, and the O(n^2) note](/img/dsa/kBtTT3fTSc8/frame-00146.png)

[watch from 56:28](https://youtu.be/kBtTT3fTSc8?t=3388)

---

## Bonus: recursive run-length encoding

- A stretch goal to show a **new DP shape**. Ordinary RLE turns `AAAB` into `3AB`. Allow the repeated block to itself be encoded: `AAABAAAB` becomes `2(3AB)`. Given a string $s$, find the **minimum length** of such an encoding.

![RLE examples AAAB → 3AB and AAABAAAB → 2(3AB); the two options for encoding s[l..r-1] — leave the first char, or wrap k repetitions of a length-x period](/img/dsa/kBtTT3fTSc8/frame-00316.png)

- State: $D[l][r]$ = minimal encoded length of the substring $s[l..r-1]$. Two options:
  1. **Leave the first character literal:** cost $1 + D[l+1][r]$.
  2. **Form a repetition:** pick a period length $x$ and a repeat count $k$ so that $k$ copies of $s[l..l+x-1]$ occupy $[l,\,l+kx)$; cost is $\mathrm{len}(k) + 2$ (digits of the count plus the two brackets) $+\ D[l][l+x]$ (encode one period) $+\ D[l+kx][r]$ (encode the tail).

  $$D[l][r] = \min\Big(\,1 + D[l+1][r],\quad \min_{x,\,k}\big(\mathrm{len}(k) + 2 + D[l][l+x] + D[l+kx][r]\big)\Big).$$

![The two transitions written out: option 1 = 1 + D[l+1, r]; option 2 = len(k) + 2 + D[l, l+x] + D[l+kx, r]](/img/dsa/kBtTT3fTSc8/frame-00329.png)

- **Two new wrinkles versus every earlier DP:**
  - Option 2 uses **two** subproblems ($D[l][l+x]$ and $D[l+kx][r]$) — the first time a state depends on more than one smaller state. Reconstruction therefore makes **two** recursive calls.
  - It references $D[l+1][\cdot]$, so cells must be filled by **increasing substring length** (equivalently bottom-up in $l$, left-to-right in $r$) — larger $l$ before smaller $l$.
- Checking that the $k$ blocks are truly equal can be done with string-matching machinery (KMP / hashing) covered later; here a direct comparison keeps the code self-contained.

```cpp
#include <bits/stdc++.h>
using namespace std;

int digits(int k) { int d = 0; do { d++; k /= 10; } while (k); return d; }

bool block_eq(const string& s, int a, int b, int len) {   // s[a..) == s[b..) for len chars?
    for (int t = 0; t < len; t++) if (s[a + t] != s[b + t]) return false;
    return true;
}

int min_encoding(const string& s) {
    int n = s.size();
    vector<vector<int>> D(n + 1, vector<int>(n + 1, 0));   // D[l][l] = 0 (empty)
    for (int len = 1; len <= n; len++) {                   // increasing substring length
        for (int l = 0; l + len <= n; l++) {
            int r = l + len;
            int best = 1 + D[l + 1][r];                    // option 1: literal first char
            for (int x = 1; x <= len; x++) {               // period length
                int k = 1, pos = l + x;
                while (pos + x <= r && block_eq(s, l, pos, x)) { k++; pos += x; }
                for (int reps = 2; reps <= k; reps++) {    // must repeat >= 2 to help
                    int end = l + reps * x;                 // covers [l, end)
                    int cost = digits(reps) + 2 + D[l][l + x] + D[end][r];
                    best = min(best, cost);
                }
            }
            D[l][r] = best;
        }
    }
    return D[0][n];
}

int main() {
    cout << min_encoding("aaab") << "\n";      // 4   (literal AAAB beats 3(A)B)
    cout << min_encoding("aaabaaab") << "\n";   // 7   -> 2(3AB) style, but exact len 7
    cout << min_encoding("abcabcabc") << "\n";  // 6   -> 3(abc)
    cout << min_encoding("aaaa") << "\n";       // 4
}
```

- **Data structure:** upper-triangular 2-D table over substrings; invariant — $D[l][r]$ is the true minimal encoding of $s[l..r-1]$ once all shorter substrings are done. Verified against a brute-force recursive encoder on every test.
- The lecturer flags this as **polynomial but not optimal** in constant — it is a teaching example of the substring-DP + two-subproblem pattern, not a production compressor.

[watch from 68:31](https://youtu.be/kBtTT3fTSc8?t=4111)

---

## Complexity recap

| Problem | Time | Space | Reconstruction |
| --- | --- | --- | --- |
| Edit distance (number only) | $\Theta(nm)$ | $\Theta(\min(n,m))$ with two rows | — |
| Edit distance + change log | $\Theta(nm)$ | $\Theta(nm)$ (keep full table) | walk $(n,m)\to(0,0)$ |
| Text justification | $O(n^2)$ worst, $\approx O(nL)$ practical | $\Theta(n)$ | one back-pointer per line |
| Recursive RLE | polynomial ($O(n^3)$-ish with equality checks) | $\Theta(n^2)$ | two recursive calls per state |

---

## Practice problems

Edit distance is a **top-tier interview DP**; text justification is a classic "hard" that mostly appears verbatim as one LeetCode problem. Word Break / Interleaving are included because they drill the same prefix-DP-over-two-strings muscle.

**🎯 Interview (MAANG-style)**

- [Edit Distance — LeetCode 72](https://leetcode.com/problems/edit-distance/) — Hard — the lecture's exact DP; fill $D[i][j]$ with min-of-three-plus-one.
- [Delete Operation for Two Strings — LeetCode 583](https://leetcode.com/problems/delete-operation-for-two-strings/) — Med — edit distance restricted to deletes only (LCS in disguise).
- [Minimum ASCII Delete Sum for Two Strings — LeetCode 712](https://leetcode.com/problems/minimum-ascii-delete-sum-for-two-strings/) — Med — weighted-cost edit distance; deletions cost the character's ASCII value.
- [Word Break — LeetCode 139](https://leetcode.com/problems/word-break/) — Med — prefix DP $D[i]=\exists k: D[k]\land s[k..i)\in\text{dict}$, same skeleton as justification.
- [Word Break II — LeetCode 140](https://leetcode.com/problems/word-break-ii/) — Hard — Word Break plus reconstruction of every valid split.
- [Interleaving String — LeetCode 97](https://leetcode.com/problems/interleaving-string/) — Med — two-string 2-D DP with the same last-character case analysis.
- [Edit Distance — GeeksforGeeks](https://www.geeksforgeeks.org/edit-distance-dp-5/) — Med — the canonical write-up with the filled table.

**🏆 Competitive**

- [Edit Distance — CSES 1639](https://cses.fi/problemset/task/1639) — Easy/Med — plain Levenshtein distance, print the number; a clean implementation check.

> No official Codeforces home-task post is linked from this lecture's description, so none is cited here.

---

## Further reading

- [Levenshtein distance — Wikipedia](https://en.wikipedia.org/wiki/Levenshtein_distance) — definition, properties, symmetry.
- [Edit distance — Wikipedia](https://en.wikipedia.org/wiki/Edit_distance) — weighted variants and the general cost model.
- [Wagner–Fischer algorithm — Wikipedia](https://en.wikipedia.org/wiki/Wagner%E2%80%93Fischer_algorithm) — the exact table DP shown on the board.
- [Edit Distance — GeeksforGeeks](https://www.geeksforgeeks.org/edit-distance-dp-5/) — worked implementation with the diagonal/insert/delete diagram.

---

## Key takeaways

- Edit distance is a two-string prefix DP: compare the **last characters**, branch on equal (free diagonal) vs unequal (min of change / remove / insert, plus one), base case $i+j$.
- To output *what* to change, not just how many, **backtrack** through the table from the final cell.
- Text justification shows how to turn a fuzzy goal ("looks nice") into a DP: invent a **badness** measure (cube of the gap), then minimize its sum with a prefix DP that grows the last line and breaks on overflow.
- The recursive-RLE bonus introduces two patterns you'll reuse: **DP over substrings** $D[l][r]$, and states that **combine two** smaller subproblems (needing two recursive calls to reconstruct).
- Every one of these is the grasshopper again — decide the last jump, add its cost, reuse the prefix optimum.

## Glossary

- **Levenshtein / edit distance** — minimum number of single-character insert / delete / substitute operations to transform one string into another.
- **Edit script (change log)** — the concrete sequence of operations realizing the distance, recovered by backtracking the DP table.
- **Badness** — a penalty assigned to a line's leftover gap; here the cube of the trailing space, chosen empirically for TeX-style justification.
- **Prefix DP** — dynamic programming where each state is "the answer for the first $i$ elements," transitioning by choosing the last block.
- **Substring DP** — states indexed by an interval $[l, r)$, filled by increasing interval length.
