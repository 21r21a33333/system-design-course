---
title: "S03E10 · Finite State Automata"
sidebar_position: 10
description: DFA and NFA basics, counting strings by DP on an automaton, the linear-time KMP string-matching automaton, tries for a set of strings, and DFA minimization by state-equivalence marking plus the Hopcroft idea.
---

# S03E10 · Finite State Automata

> **Source:** Pavel Mavrin, [_A&DS S03E10_](https://youtu.be/WyvBbFuCVx8) · 1h57m lecture → ~18 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- A **finite automaton** is a labelled graph: states (vertices), one start state, some terminal states, and letter-labelled transitions. A string is **accepted** if reading it letter by letter from the start ends in a terminal state.
- **Deterministic (DFA):** at most one transition per letter out of each state. **Non-deterministic (NFA):** several — powerful but usually turned into a DFA (possibly $2^n$ states) before use.
- An automaton turns a **string problem into a graph problem**: the number of accepted strings of length $m$ equals the number of length-$m$ paths from start to a terminal state, computed by a Bellman-Ford-style DP.
- The **string-matching automaton** for a pattern $s$ has $m+1$ states (one per prefix length); its transition $\delta$ is built in **$\Theta(m\cdot|\Sigma|)$** by reusing already-computed transitions, and it doubles as the KMP prefix function.
- A **trie** is the automaton of a finite set of strings, built in $\Theta(\sum|s_i|)$; it is a set/map over strings that also exposes every prefix.
- **DFA minimization:** mark non-equivalent state pairs (terminal vs non-terminal, then propagate backwards over equal letters) in $\Theta(n^2\cdot|\Sigma|)$; the same marking checks whether two automata are equivalent. **Hopcroft** does it in $\Theta(n\log n\cdot|\Sigma|)$ by refining partitions.

---

## What a finite automaton is

- A **finite state automaton** is a directed graph:
  - each **vertex** is a **state**; one is the **start state** $s$;
  - each **transition** (edge) is labelled with a **letter** from a fixed alphabet $\Sigma$ (in the examples $\Sigma = \lbrace a, b\rbrace$, always a constant size);
  - some states are **terminal** (accepting), drawn as double circles.
- **Running a string:** start at $s$; for each next letter of the input, follow the transition labelled by that letter. If you finish in a terminal state, the string is **accepted**.
- The set of all accepted strings is the automaton's **language** (a *regular* language — the theory is left to a formal-languages course).
- **Deterministic (DFA):** each state has at most one out-edge per letter, so the run is forced. **Non-deterministic (NFA):** a state may have several out-edges for the same letter. Any NFA has an equivalent DFA, but the DFA can blow up to $2^n$ states, so algorithmic work sticks to DFAs.
- Why bother: an automaton is a **bridge from strings to graphs**. Model your language as an automaton, then reuse everything you know about graphs.

![Intro DFA over the alphabet a, b with a start state and a double-circle terminal state, plus a sample run of the string aabba](/img/dsa/WyvBbFuCVx8/frame-00048.png)

[watch from 0:47](https://youtu.be/WyvBbFuCVx8?t=47)

---

## Counting strings: DP on the automaton

- **Problem.** Given an automaton and a length $m$, count the distinct accepted strings of length exactly $m$.
- **Key reduction.** Each accepted string is a **path** of length $m$ from the start state to some terminal state, so the count of strings equals the count of such paths:

$$
\#\lbrace \text{accepted strings of length } m\rbrace \;=\; \#\lbrace \text{length-}m\text{ paths } s \rightsquigarrow t,\ t \in T\rbrace .
$$

- **DP (Bellman-Ford flavour).** Let $d[v][k]$ be the number of length-$k$ paths from $s$ to $v$:

$$
d[v][0] = [\,v = s\,], \qquad
d[v][k+1] = \sum_{(u \xrightarrow{c} v)} d[u][k].
$$

  The answer is $\sum_{t \in T} d[t][m]$. Each step costs $\Theta(\text{edges}) = \Theta(n\cdot|\Sigma|)$, so counting is $\Theta(m\cdot n\cdot|\Sigma|)$.
- This is *the* payoff of automata: once the language is an automaton, counting, shortest strings, and **language intersection** (product of two automata) all become standard graph or DP work.

![Board relating number of strings of length n to number of paths from start to a terminal state, with the DP definition d of v and k as the number of paths of length k to v](/img/dsa/WyvBbFuCVx8/frame-00060.png)

[watch from 8:47](https://youtu.be/WyvBbFuCVx8?t=527)

---

## The string-matching automaton (KMP automaton)

- **Goal.** Given a pattern $s$ of length $m$, build a DFA that accepts every text $t$ that **contains $s$ as a substring**.
- **Skeleton.** Since $t = s$ must be accepted, lay down a spine of $m+1$ states with transitions $s_0, s_1, \dots, s_{m-1}$ from start to the single terminal state.
- **Meaning of a state.** State $i$ means: *the longest prefix of $s$ that is a suffix of the text read so far has length $i$.* So state $i$ remembers "how much of $s$ we have matched", and state $m$ means a full occurrence just ended.

![The pattern S equals abbaba laid out as a spine of states, with the note that the automaton accepts texts T that contain S as a substring](/img/dsa/WyvBbFuCVx8/frame-00090.png)

- **Building the other transitions.** From state $i$ on letter $c$:
  - if $c = s_i$, advance to $i+1$ (extend the match);
  - otherwise find the **longest suffix** of "prefix of length $i$, then $c$" that is again a prefix of $s$ — exactly the KMP fallback.
- **Absorbing the terminal state.** Put a self-loop on state $m$ for every letter, so once a match is found the run stays accepted forever. The resulting DFA accepts precisely the texts containing $s$.
- **Size is linear.** $m+1$ states and $(m+1)\cdot|\Sigma|$ edges — linear when $|\Sigma|$ is constant.

![The finished string-matching automaton for abbaba with fallback edges drawn and an absorbing a,b self-loop on the accepting state, size O of n](/img/dsa/WyvBbFuCVx8/frame-00110.png)

[watch from 13:18](https://youtu.be/WyvBbFuCVx8?t=798)

### First attempt: the quadratic construction

- Compute the standard prefix function $p$, then for every state $i$ and letter $c$ walk the fallback chain $k \leftarrow p[k]$ until $s_k = c$:

```text
for i = 0 .. n:                 # states
    for c in Σ:                 # alphabet
        k = i
        while k > 0 and s[k] != c:
            k = p[k]            # follow prefix-function fallback
        δ[i][c] = k + (s[k] == c)
```

- **Why it can be slow.** Unlike KMP's scan (which resumes from the *previous* $k$), here every $(i,c)$ restarts the `while` from $i$. On $s = a^{m}$ with a stray letter $b$, each state walks all the way back, giving $\Theta(n^2\cdot|\Sigma|)$.

![Board writing the transition rule delta of i and c using k equals i and a while loop k equals p of k while s of k is not x](/img/dsa/WyvBbFuCVx8/frame-00150.png)

[watch from 27:07](https://youtu.be/WyvBbFuCVx8?t=1627)

### Linear-time construction (reuse previous transitions)

- The fix: never re-walk the chain. When $c \ne s_i$, the shorter prefix we fall back to is $p[i]$, and its transition on $c$ is **already computed**. So:

$$
\delta[i][c] =
\begin{cases}
i+1 & \text{if } c = s_i,\\[2pt]
0 & \text{if } i = 0,\\[2pt]
\delta[\,p[i]\,][c] & \text{otherwise.}
\end{cases}
$$

- Every entry is filled in $O(1)$, so the whole table is **$\Theta(n\cdot|\Sigma|)$**.

![The linear transition recurrence delta of i and c equals i plus one if s of i equals c else delta of p of i and c, with complexity O of n times sigma](/img/dsa/WyvBbFuCVx8/frame-00165.png)

- **Bonus: the prefix function comes for free.** $p[i+1]$ is the length of the longest proper prefix that is also a suffix of $s_0 \dots s_i$; that is exactly the transition from $p[i]$ on letter $s_i$:

$$
p[i+1] = \delta[\,p[i]\,][\,s_i\,] \qquad (i \ge 1),\qquad p[1] = 0.
$$

  So one loop builds both the automaton and the prefix function — no separate KMP pass. (Plain KMP is still stronger when $|\Sigma|$ is huge, since it avoids the $|\Sigma|$ factor.)

![Board computing the prefix function inside the same loop, p of i plus one equals delta of p of i and s of i](/img/dsa/WyvBbFuCVx8/frame-00180.png)

Full implementation — builds the table and prefix function in one pass, then both scans for all occurrences and (as an absorbing recognizer) decides the "contains $s$" language:

```cpp
#include <bits/stdc++.h>
using namespace std;

// String-matching (KMP) automaton for pattern s over a fixed alphabet.
// aut[i][c] = state reached from state i after reading character c, where state
// i in 0..m means: the longest prefix of s that is a suffix of the text read so
// far has length i. State m means a full occurrence of s just ended.
struct KmpAutomaton {
    int m;
    string alphabet;
    vector<array<int, 128>> aut;

    KmpAutomaton(const string& s, const string& alpha) : m((int)s.size()), alphabet(alpha) {
        aut.assign(m + 1, {});
        for (auto& row : aut) row.fill(0);
        vector<int> p(m + 1, 0);                                   // prefix function of s
        for (int i = 0; i <= m; i++) {
            for (char c : alphabet) {
                if (i < m && c == s[i]) aut[i][(int)c] = i + 1;     // extend the match
                else if (i == 0)        aut[i][(int)c] = 0;         // empty prefix loops
                else                    aut[i][(int)c] = aut[p[i]][(int)c]; // reuse
            }
            if (i > 0 && i < m) p[i + 1] = aut[p[i]][(int)s[i]];    // KMP prefix fn, in-loop
        }
    }

    // All start positions (0-indexed) where s occurs in t. Uses the raw table:
    // entering state m signals one occurrence ending at the current character.
    vector<int> find_all(const string& t) const {
        vector<int> hits;
        int state = 0;
        for (int j = 0; j < (int)t.size(); j++) {
            state = aut[state][(int)t[j]];
            if (state == m) hits.push_back(j - m + 1);
        }
        return hits;
    }
};

// Recognizer for the language "texts that CONTAIN s". Same table, but state m
// is made absorbing so that once matched the run stays accepted.
struct SubstringRecognizer {
    KmpAutomaton base;
    SubstringRecognizer(const string& s, const string& alpha) : base(s, alpha) {
        for (char c : alpha) base.aut[base.m][(int)c] = base.m;    // absorbing accept
    }
    bool accepts(const string& t) const {
        int state = 0;
        for (char ch : t) state = base.aut[state][(int)ch];
        return state == base.m;
    }
};

int main() {
    string s = "abbaba", alpha = "ab";
    KmpAutomaton A(s, alpha);
    string t = "abbabbababbaba";
    for (int start : A.find_all(t)) cout << start << " ";  // prints: 3 8
    cout << "\n";
    SubstringRecognizer R(s, alpha);
    cout << R.accepts("xxabbabaxx") << "\n";               // 0 here (x not in Σ); "abbaba" -> 1
    return 0;
}
```

- Compile-tested (`c++ -std=c++17`): `find_all` reproduces the brute-force occurrence list, and the recognizer agrees with `string::find` on 20000 random texts.

**Counting texts that contain $s$** — the DP-on-automaton payoff, on the absorbing recognizer:

```cpp
#include <bits/stdc++.h>
using namespace std;

// Number of length-L texts over `alpha` that contain s as a substring, by
// counting paths that reach the absorbing accepting state m.
long long count_with_substring(const string& s, const string& alpha, int L) {
    int m = s.size();
    vector<int> p(m + 1, 0);
    vector<array<int, 128>> aut(m + 1);
    for (auto& r : aut) r.fill(0);
    for (int i = 0; i <= m; i++) {
        for (char c : alpha) {
            if (i < m && c == s[i]) aut[i][(int)c] = i + 1;
            else if (i == 0)        aut[i][(int)c] = 0;
            else                    aut[i][(int)c] = aut[p[i]][(int)c];
        }
        if (i > 0 && i < m) p[i + 1] = aut[p[i]][(int)s[i]];
    }
    for (char c : alpha) aut[m][(int)c] = m;                 // absorbing accept
    vector<long long> dp(m + 1, 0); dp[0] = 1;
    for (int step = 0; step < L; step++) {                   // one Bellman-Ford-style layer
        vector<long long> nx(m + 1, 0);
        for (int i = 0; i <= m; i++) if (dp[i])
            for (char c : alpha) nx[aut[i][(int)c]] += dp[i];
        dp = nx;
    }
    return dp[m];
}

int main() {
    // s = "aba", Σ = {a,b}: counts are 0,0,0,1,4,11,27,63,142 for L = 0..8.
    for (int L = 0; L <= 8; L++) cout << count_with_substring("aba", "ab", L) << " ";
    cout << "\n";
    return 0;
}
```

- Compile-tested: the DP counts match brute-force enumeration for all $L \le 8$.

---

## Tries: the automaton of a finite set of strings

- **Problem.** Build a DFA that accepts *exactly* a given finite set of strings.
- **Construction.** Insert strings one at a time, each as a path from the start state; when a transition is missing, create a new state. Mark the last state of each string terminal. This is a **trie** (prefix tree).
- **Build cost.** Each character adds at most one edge in $O(1)$, so the whole trie is $\Theta(\sum_i |s_i|)$.

![A trie built from the strings a a a a b, a a a b c a, a b b c, b b b a, labelled build automaton accepts only the S i, cost O of sum of s i](/img/dsa/WyvBbFuCVx8/frame-00210.png)

- **Uses.**
  - **Set:** does string $p$ belong to the set? Follow $p$ from the root; accept if you land on a terminal node. **Map:** store a value in each terminal node.
  - **Dynamic:** `add` and `remove` a string in $O(|p|)$ (remove strips the terminal flag, then peels back edges with no other children). It is a hash map without hashes.
  - **Prefix structure:** every trie node is a distinct prefix of some string in the set, so any "over all prefixes" computation runs on the tree.
- **Storing transitions.** Either an $n \times |\Sigma|$ array (fast, $\Theta(n\cdot|\Sigma|)$ memory) or a per-node hash map from letter to child (linear memory for sparse, large alphabets).

![Trie used as a set and map: given a string P, answer P in S, plus add, remove, find, and the transition delta of v and c](/img/dsa/WyvBbFuCVx8/frame-00230.png)

Trie in C++ (set / map over strings, lowercase alphabet):

```cpp
#include <bits/stdc++.h>
using namespace std;

// Trie = automaton accepting exactly a finite set of strings. Each node is a
// state, one child per letter; terminal nodes mark accepted strings.
struct Trie {
    struct Node { array<int, 26> nxt; bool terminal = false;
                  Node() { nxt.fill(-1); } };
    vector<Node> t;
    Trie() { t.emplace_back(); }                 // node 0 = root = start state

    void insert(const string& s) {
        int v = 0;
        for (char ch : s) { int c = ch - 'a';
            if (t[v].nxt[c] == -1) { t[v].nxt[c] = t.size(); t.emplace_back(); }
            v = t[v].nxt[c];
        }
        t[v].terminal = true;
    }
    bool contains(const string& s) const {
        int v = 0;
        for (char ch : s) { int c = ch - 'a';
            if (t[v].nxt[c] == -1) return false;
            v = t[v].nxt[c];
        }
        return t[v].terminal;
    }
};

int main() {
    Trie tr;
    for (string w : {"abaab", "abbba", "abba", "bbba"}) tr.insert(w);
    cout << tr.contains("abba") << " " << tr.contains("ab") << "\n"; // 1 0
    return 0;
}
```

- Compile-tested: stores the set exactly (accepts all inserted strings, rejects the tested non-members).

[watch from 46:29](https://youtu.be/WyvBbFuCVx8?t=2789)

---

## Minimization and equivalence of DFAs

- **Problem.** Given a DFA, find an **equivalent DFA with the fewest states**. There is no unique automaton for a language, but the minimal DFA *is* unique.
- **Example (board).** The language $(a\mid b)\,b^{*}\,a$ has a 4-state DFA and an equivalent 3-state DFA — two states in the big one behave identically and merge.

![Two automata for the regular expression a or b then b star then a: a four-state version above and the minimal three-state version below](/img/dsa/WyvBbFuCVx8/frame-00265.png)

- **When are two states equal?** For a state $u$, let $S(u)$ be the set of strings that, read starting at $u$, lead to a terminal state. Two states are **equivalent** iff $S(u) = S(v)$.

$$
u \equiv v \iff S(u) = S(v),\qquad
u \not\equiv v \iff \exists\, w:\ w \in S(u)\ \text{XOR}\ w \in S(v).
$$

![Definition of S of u as the set of strings accepted from state u, with u equivalent to v iff S of u equals S of v, and the backward-propagation picture](/img/dsa/WyvBbFuCVx8/frame-00300.png)

- **Marking algorithm** (fill a boolean matrix $\mathrm{NEQ}[u][v]$):
  1. **Seed:** any terminal / non-terminal pair is non-equivalent (empty string distinguishes them).
  2. **Propagate backwards:** if $u \not\equiv v$ and there are equal-letter in-edges $u' \xrightarrow{c} u$ and $v' \xrightarrow{c} v$, then $u' \not\equiv v'$ (prepend $c$ to the distinguishing string).
  3. Repeat with a queue until closure. Unmarked pairs are equivalent — merge them.

![The minimization algorithm on the board: seed NEQ over terminal and non-terminal pairs, then a queue loop over letters and in-going edges marking new non-equal pairs](/img/dsa/WyvBbFuCVx8/frame-00310.png)

- **Complexity: $\Theta(n^2\cdot|\Sigma|)$.** The four nested loops look like $n^4$, but each *pair of equal-letter transitions* is visited at most once; there are $\Theta(n)$ transitions per letter, hence $\Theta(n^2)$ transition-pairs, times $|\Sigma|$.

![The full minimization pseudocode with the queue and three inner loops over c, u-prime, v-prime, and the O of n squared times sigma bound](/img/dsa/WyvBbFuCVx8/frame-00360.png)

- **Equivalence of two automata.** Run the *same* marking on the disjoint union of automata $A$ and $B$; they are equivalent iff their start states end up **not** marked non-equivalent. (Equivalently: minimize both and compare — minimal DFAs are unique.)

```cpp
#include <bits/stdc++.h>
using namespace std;

// DFA state-equivalence marking (board's O(n^2 * |Sigma|) algorithm).
// neq[u][v] = true once u and v are proven to accept different suffix-languages.
struct DFA {
    int n, sigma;
    vector<vector<int>> go;    // go[u][c] = target state (complete DFA)
    vector<char> term;         // terminal flag
};

vector<vector<char>> mark_neq(const DFA& A) {
    int n = A.n, S = A.sigma;
    // reverse edges: rev[c][u] = list of v with go[v][c] == u
    vector<vector<vector<int>>> rev(S, vector<vector<int>>(n));
    for (int v = 0; v < n; v++)
        for (int c = 0; c < S; c++) rev[c][A.go[v][c]].push_back(v);
    vector<vector<char>> neq(n, vector<char>(n, 0));
    queue<pair<int,int>> q;
    for (int u = 0; u < n; u++)                      // seed: terminal vs non-terminal
        for (int v = 0; v < n; v++)
            if (A.term[u] != A.term[v] && !neq[u][v]) { neq[u][v] = 1; q.push({u, v}); }
    while (!q.empty()) {                             // propagate backwards
        auto [u, v] = q.front(); q.pop();
        for (int c = 0; c < S; c++)
            for (int up : rev[c][u]) for (int vp : rev[c][v])
                if (!neq[up][vp]) { neq[up][vp] = 1; q.push({up, vp}); }
    }
    return neq;
}

int main() {
    // Language (a|b) b* a. States: 0 start, 3 terminal, 4 dead sink. [state][a,b]:
    DFA A;
    A.n = 5; A.sigma = 2;
    A.go = { {1,2}, {3,1}, {3,2}, {4,4}, {4,4} };
    A.term = {0, 0, 0, 1, 0};
    auto neq = mark_neq(A);
    cout << (!neq[1][2]) << "\n";   // 1: states 1 and 2 are equivalent -> merge
    cout << (neq[0][1])  << "\n";   // 1: states 0 and 1 are distinct
    return 0;
}
```

- Compile-tested: states 1 and 2 come out equivalent and 0 vs 1 distinct, so the 4 live states collapse to the expected 3.

[watch from 66:29](https://youtu.be/WyvBbFuCVx8?t=3989)

### Hopcroft: the same result in $\Theta(n\log n\cdot|\Sigma|)$

- Instead of chasing individual pairs, **refine a partition**. Start with two blocks — terminal $T$ and non-terminal — and repeatedly split.
- **Split step.** Take a block $A$. For each letter $c$, look at all in-edges into $A$. Any other block $B$ some of whose states go into $A$ on $c$ while others do not must split into $B_1$ (into $A$) and $B_2$ (not into $A$), because states inside $A$ are already known distinct from states outside $A$.
- **The $\log n$ trick.** When a block in the work queue splits, replace it by both halves; when a block already processed splits, enqueue only the **smaller** half. Each state's block then at least halves each time it re-enters the queue, so a state is reprocessed $O(\log n)$ times. Scanning all in-edges over all rounds is $\Theta(\text{edges}\cdot\log n) = \Theta(n\log n\cdot|\Sigma|)$.

![Hopcroft partition refinement: all states split into T and not-T blocks, then a block A and its in-edges by letter c split another block into the part reaching A and the part that does not](/img/dsa/WyvBbFuCVx8/frame-00380.png)

[watch from 87:29](https://youtu.be/WyvBbFuCVx8?t=5249)

---

## Complexity recap

| Task | Time | Space | Notes |
| --- | --- | --- | --- |
| Run automaton on text of length $L$ | $\Theta(L)$ | $\Theta(1)$ | one transition per character |
| Count accepted strings of length $m$ | $\Theta(m\cdot n\cdot\lvert\Sigma\rvert)$ | $\Theta(n)$ | DP on the transition graph |
| KMP automaton — naive build | $\Theta(n^2\cdot\lvert\Sigma\rvert)$ | $\Theta(n\cdot\lvert\Sigma\rvert)$ | re-walks fallback chain |
| KMP automaton — linear build | $\Theta(n\cdot\lvert\Sigma\rvert)$ | $\Theta(n\cdot\lvert\Sigma\rvert)$ | reuse $\delta[p[i]][c]$; also yields prefix fn |
| Trie of a string set | $\Theta\big(\sum_i \lvert s_i\rvert\big)$ | $\Theta\big(\sum_i \lvert s_i\rvert\big)$ | set / map over strings |
| DFA minimization — marking | $\Theta(n^2\cdot\lvert\Sigma\rvert)$ | $\Theta(n^2)$ | pairwise NEQ closure |
| DFA minimization — Hopcroft | $\Theta(n\log n\cdot\lvert\Sigma\rvert)$ | $\Theta(n)$ | partition refinement |
| DFA equivalence check | $\Theta(n^2\cdot\lvert\Sigma\rvert)$ | $\Theta(n^2)$ | mark on disjoint union, test start states |

---

## Practice problems

The board is a DFA workout: recognize a language as an automaton, then scan, count, or minimize. The interview payload is **DFA-style parsing** (validate a number / parse tokens by explicit states) and **pattern matching**; the competitive payload is **DP on the KMP matching automaton**.

**🎯 Interview (MAANG-style)**

- [Valid Number — LeetCode 65](https://leetcode.com/problems/valid-number/) — Hard — the canonical DFA problem: hand-build states for sign, digits, dot, and exponent.
- [String to Integer (atoi) — LeetCode 8](https://leetcode.com/problems/string-to-integer-atoi/) — Medium — a tiny explicit state machine over whitespace, sign, digits, overflow.
- [Regular Expression Matching — LeetCode 10](https://leetcode.com/problems/regular-expression-matching/) — Hard — regex-to-DP; the automaton view (Thompson NFA) is the theory behind it.
- [Wildcard Matching — LeetCode 44](https://leetcode.com/problems/wildcard-matching/) — Hard — question-mark and star matching as automaton-style DP.
- [Finite Automata algorithm for Pattern Searching — GeeksforGeeks](https://www.geeksforgeeks.org/finite-automata-algorithm-for-pattern-searching/) — Medium — builds and runs exactly the string-matching automaton from this lecture.

**🏆 Competitive**

- [String Matching — CSES 1753](https://cses.fi/problemset/task/1753) — Easy — count occurrences of a pattern; the direct KMP-automaton scan.
- [Finding Borders — CSES 1732](https://cses.fi/problemset/task/1732) — Easy — the prefix function itself, which the linear construction produces for free.
- **DP on the matching automaton** — using the KMP automaton to count texts of length $m$ that contain (or avoid) a pattern, as in the C++ `count_with_substring` above. Reference: the "matching automaton" section of the cp-algorithms prefix-function article below.

> Minimization and Hopcroft are past typical interview rounds; interviewers ask you to *design* a small DFA (LeetCode 65 / 8), not to minimize one. The nearest interview-relevant skill is writing an explicit state machine cleanly.

---

## Further reading

- [Prefix function and its automaton — cp-algorithms](https://cp-algorithms.com/string/prefix-function.html) — the linear KMP-automaton build and the DP-on-automaton counting trick.
- [Aho-Corasick automaton — cp-algorithms](https://cp-algorithms.com/string/aho_corasick.html) — the multi-pattern sequel: a trie with fallback links (the next lecture's topic).
- [Deterministic finite automaton — Wikipedia](https://en.wikipedia.org/wiki/Deterministic_finite_automaton) and [Powerset construction (NFA to DFA) — Wikipedia](https://en.wikipedia.org/wiki/Powerset_construction).
- [DFA minimization — Wikipedia](https://en.wikipedia.org/wiki/DFA_minimization) and [Thompson's construction (regex to NFA) — Wikipedia](https://en.wikipedia.org/wiki/Thompson%27s_construction).
- [Knuth–Morris–Pratt algorithm — Wikipedia](https://en.wikipedia.org/wiki/Knuth%E2%80%93Morris%E2%80%93Pratt_algorithm) and [Introduction to finite automata — GeeksforGeeks](https://www.geeksforgeeks.org/introduction-of-finite-automata/).

---

## Key takeaways

- Model a language as an automaton, then reuse graph and DP machinery: **counting strings = counting paths**.
- The string-matching automaton has $m+1$ states; build $\delta$ in $\Theta(m\cdot|\Sigma|)$ by setting $\delta[i][c] = \delta[p[i]][c]$ on a mismatch — and get the KMP prefix function in the same loop.
- A **trie** is the automaton of a finite string set, built in linear total length; it is a hashless set/map that also exposes every prefix.
- **Minimize** by marking non-equivalent pairs (seed terminal vs non-terminal, propagate over equal letters) in $\Theta(n^2\cdot|\Sigma|)$; **Hopcroft** refines partitions to $\Theta(n\log n\cdot|\Sigma|)$. The same marking decides automaton equivalence.

## Glossary

- **DFA / NFA** — deterministic (at most one transition per letter per state) / non-deterministic (possibly several) finite automaton.
- **Language** — the set of strings an automaton accepts; a *regular* language.
- **Terminal (accepting) state** — a state where the run ends in "accept".
- **Prefix function $p[i]$** — length of the longest proper prefix of $s_0\dots s_{i-1}$ that is also its suffix.
- **Trie** — prefix-tree automaton of a finite set of strings.
- **State equivalence** — states $u, v$ with the same set of accepted continuations $S(u) = S(v)$; equivalent states merge in the minimal DFA.
- **Partition refinement** — Hopcroft's technique of repeatedly splitting blocks of states until each block is one equivalence class.
