---
title: "S03E13 · Suffix Tree & Ukkonen's Algorithm"
sidebar_position: 13
description: The suffix tree as a compressed trie of all suffixes with interval-labelled edges and suffix links, and Ukkonen's online linear-time construction — implicit trees, three extension rules, the active point, and the skip/count trick.
---

# S03E13 · Suffix Tree & Ukkonen's Algorithm

> **Source:** Pavel Mavrin, [_A&DS S03E13_](https://youtu.be/C10HoshM_DA) · 1h25m lecture → ~18 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- A **suffix tree** is a trie containing **all suffixes** of a string $s$. Every node is a prefix of some suffix, i.e. **every node is a substring** of $s$ and every substring is a node — so the tree encodes all substrings at once.
- The naive trie has $\Theta(n^2)$ nodes. **Two compressions** make it linear: (1) contract every non-branching chain into a single edge, and (2) store each edge label as an **interval $[l, r)$** into $s$ instead of the literal characters. Appending a sentinel `$` forces every suffix to end at its own leaf.
- **Suffix links** connect a node for string $v$ to the node for $v$ **with its first character removed**. In a suffix tree the link always lands exactly one character shorter, and links out of branching nodes always hit branching nodes.
- **Ukkonen's algorithm** builds the tree **online**, character by character, in $O(n)$ total time (constant alphabet). It maintains a single **active point** and, per new character, walks from the longest suffix toward the shortest applying **three extension rules**.
- The two optimizations that make it linear: **"once a leaf, always a leaf"** (leaf edges use a shared global end that auto-grows — rule 1 costs nothing) and the **skip/count trick** when re-descending after a suffix link. An amortization argument with potential $\varphi = -\,\text{depth}$ proves the linear bound.
- Suffix trees are **competitive / bioinformatics** tools; the interview-realistic substitute is the **suffix array**, and the modern equivalent is the **suffix automaton**.

---

## What a suffix tree is

- Take a string, e.g. $s = \texttt{ababa}$, and drop **all its suffixes** into a trie: `ababa`, `baba`, `aba`, `ba`, `a`, and (optionally) the empty suffix at the root.
- **Key property:** every vertex of that trie is a **prefix of some suffix**, and a prefix of a suffix is exactly a **substring**. So:
  - every node corresponds to some substring of $s$, and
  - every substring of $s$ is represented by some node.
- That makes the suffix tree a structure "containing all substrings" — so any question about all substrings can be answered by walking the tree.
- **Substring search** is immediate: to test whether query $q$ occurs in $s$, walk from the root spelling $q$. If you can spell all of $q$, it occurs (because it is then a prefix of some suffix); if you fall off, it does not.
- The problem of the lecture: build this tree in **linear time** $O(n)$, not the naive $\Theta(n^2)$.

![Suffix tree drawn as a trie of all suffixes of s = abbacaba, with terminal nodes circled](/img/dsa/C10HoshM_DA/frame-00035.png)

[watch from 2:09](https://youtu.be/C10HoshM_DA?t=129)

---

## Compressing the paths — making the tree linear

- The naive suffix trie has $\Theta(n^2)$ nodes, so we must shrink it before we can hope to build it in linear time.
- **Compression 1 — contract chains.** Any node with **exactly one child** carries no branching information; merge the incoming and outgoing edges into a **single edge** labelled with the concatenated characters. Keep only:
  - **leaves** (terminal nodes, one per suffix), and
  - **branching nodes** (at least two children).
- Why the result is linear: there are at most $n$ leaves (one per suffix), and every branching node creates at least one extra branch, so the number of branching nodes is also $O(n)$. Total edges $O(n)$.
- **Compression 2 — interval edge labels.** The concatenated strings on edges again total $\Theta(n^2)$ characters. But each label is a **substring of $s$**, so store two integers $[l, r)$ — "the characters $s[l\,..\,r)$" — instead of the literal text. Each edge is now $O(1)$ space.

![Compressed suffix tree of abbacaba with edges labelled by intervals like 4..6 and 2..6; annotated O(n) edges](/img/dsa/C10HoshM_DA/frame-00060.png)

- **The sentinel `$`.** Some terminal nodes still had a single child (a suffix that is a prefix of a longer suffix). Append a fresh character `$` that appears nowhere in $s$. Then **no suffix is a prefix of another**, so every suffix ends at its own leaf, and the tree has exactly two node kinds: **leaves** and **branching nodes**.
- Final size: $O(n)$ nodes, two integers per edge — a linear-size structure, so linear-time construction is at least possible.

[watch from 8:20](https://youtu.be/C10HoshM_DA?t=500)

---

## Suffix links

- As in Aho–Corasick, give every branching node $v$ a **suffix link** to the node whose string is the **longest proper suffix** of $v$'s string that is also present in the tree.
- **Special to suffix trees:** because the tree contains *every* substring of $s$, if $v$'s string has length $k$ then the string one character shorter (drop the **first** character) is also a substring, hence also in the tree. So the suffix link always lands **exactly one character shorter**:
  $$\text{link}(v) \;=\; v \text{ with its first character removed}.$$
  Moving along a suffix link = deleting the leading character of the current string.
- **Links stay among branching nodes.** If $v$ is branching it has two children on distinct characters $x$ and $y$, meaning both $v x$ and $v y$ are substrings of $s$. Dropping $v$'s first character keeps both $x$ and $y$ available, so $\text{link}(v)$ also branches. Hence we only ever build links for branching nodes; the topmost link points to the root.

![Compressed tree of abbacaba with dashed suffix links drawn back toward the root, and the alpha/beta edge-split sketch on the right](/img/dsa/C10HoshM_DA/frame-00090.png)

[watch from 16:20](https://youtu.be/C10HoshM_DA?t=980)

---

## The current position, and how to move it

The algorithm always carries **one position** in the (uncompressed) tree. That position is either a real branching node or a **virtual node** sitting in the middle of a compressed edge (it was a real trie node before the edge was contracted).

- **Move down by one character $c$.**
  - If you are in the middle of an edge: check the next character equals $c$ and step one position forward along the edge.
  - If you are on a branching node: pick the child whose edge starts with $c$ and step one position onto that edge.
- **Move along a suffix link** — the interesting case. You may be stranded in the middle of an edge, where there is no stored link. Do this:
  1. Go up to the **parent** (a real branching node) — call the string on the edge below it $\alpha$.
  2. Follow the parent's suffix link (which deletes one leading character).
  3. From there, **re-descend spelling $\alpha$**. The path may cross several short edges before you land back at the virtual position.
- If the **parent is the root**, there is no link to follow: drop the **first character of $\alpha$** and re-descend that shortened string from the root.
- This link-then-redescend is **not** $O(1)$ per call — it can traverse many edges. Its cheapness is only **amortized**.

[watch from 24:26](https://youtu.be/C10HoshM_DA?t=1466)

### The skip/count trick

- When re-descending with a known string $\alpha$, you already **know** each character is present, so you don't compare character by character. At each node compare only the **first** character of the current edge to pick the child, then **jump** by the whole edge length (skip/count), decrementing the remaining length of $\alpha$. That is what keeps the re-descent proportional to the number of edges crossed, not the number of characters.

---

## Why a sequence of operations is linear (amortization)

- Define the potential $\varphi = -\,\text{depth}(c)$, where $\text{depth}$ counts **edges** from the root to the current position $c$. (Equivalently use $n - \text{depth}$ to keep it non-negative; it never drops below $-n$, so amortized analysis is valid.)
- **Move down** costs $O(1)$ and increases depth by one, so $\Delta\varphi \le 0$. Amortized cost $O(1)$.
- **Suffix-link move** costs $1 + x$ where $x$ is the number of down-steps in the re-descent. Its effect on depth:
  - Going to the parent then across the link changes depth by at most $+1$ (the crucial claim below), then $x$ down-steps subtract $x$. So $\Delta\varphi \le 1 - x$.
  - Amortized cost $= (1 + x) + \Delta\varphi \le (1+x) + (1-x) = O(1)$.
- **The depth claim.** If the path to the current node has $k$ edges, the path reached through the suffix link has **at least $k-1$ edges**. Reason: each internal node on the original path is some prefix; its suffix link points to a node that is a prefix of the shorter string, i.e. onto the image path. So the image path has at least as many internal nodes minus one (the top one links to the root). Thus depth decreases by at most $1$, potential rises by at most $1$.
- Over the whole run the current position takes $O(n)$ down-steps and $O(n)$ link-moves, so **any sequence of these operations is $O(n)$ total**. This is the engine that makes the whole construction linear.

![Amortization board: potential phi equals minus depth, at least minus n; a link move costs 1 plus x with depth change bounded, giving O(n) total over n operations](/img/dsa/C10HoshM_DA/frame-00170.png)

[watch from 34:37](https://youtu.be/C10HoshM_DA?t=2077)

---

## Ukkonen's algorithm — online construction

- Start with the empty tree (just the root) and **add characters left to right**. After processing $s[0\,..\,i]$ the structure is the suffix tree of that prefix (an **implicit** tree until the sentinel is added).
- When a new character arrives, you must extend **every** current suffix by it — conceptually walking from the **longest** suffix down to the **shortest** and adding the character at each ending position.
- Split each extension into **three stages / rules**, applied at the ending position of the current suffix:

  1. **Rule 1 — the position ends at a leaf.** Just lengthen that leaf's edge by one character. This happens for a whole prefix of the suffix list.
  2. **Rule 2 — not a leaf, and no outgoing edge starts with the new character $c$.** Create a **new leaf edge** for $c$. If the position sat in the middle of an edge, first **split** that edge, inserting a new branching node.
  3. **Rule 3 — an edge starting with $c$ already exists.** Do nothing structural: just advance the active position one character along it. This is a **show-stopper** — once rule 3 fires, all remaining (shorter) suffixes are already present, so the phase ends.

- **Monotonicity that makes it cheap:** as you go from long to short suffixes you first hit a run of leaves (rule 1), then a run of rule-2 extensions, then the first rule-3 hit ends the phase. Once a suffix is a leaf it stays a leaf forever.

![The three stages on the board: leaves (rule 1), no transition with letter a create a new edge (rule 2), has a transition with letter a stop-test (rule 3)](/img/dsa/C10HoshM_DA/frame-00250.png)

### Optimization 1 — "once a leaf, always a leaf" + global end

- A leaf, once created, only ever grows by the remaining characters of $s$. So instead of touching every leaf every step, **create leaf edges with end = INF** and read them against a shared **global `leafEnd`** that you advance by one each phase. Rule 1 then costs **nothing** — it is applied to all leaves implicitly.

### Optimization 2 — the active point

- Track the whole "position + pending work" with four integers:
  - `activeNode` — the node we currently hang from,
  - `activeEdge` — index into $s$ of the first character of the active edge,
  - `activeLen` — how far down that edge we are,
  - `remaining` — how many suffixes still need inserting this phase.
- Rule 2 always creates an edge, and the tree ends with $O(n)$ edges, so **rule 2 fires $O(n)$ times total**. Each firing does $O(1)$ structural work plus one amortized-$O(1)$ suffix-link move. Total: **$O(n)$**.
- **The one special case:** after a split you create an internal node whose suffix link is not yet known. Resolve it by the link-then-redescend procedure; the node you land on **is** its suffix-link target, so set the link there. When the parent is the root, use the "drop first character, redescend from root" variant.

[watch from 45:14](https://youtu.be/C10HoshM_DA?t=2714)

### The implementation

Interval-labelled edges, global leaf end, active point, skip/count, and suffix-link resolution — the complete algorithm as developed on the board. Compiled with `c++ -std=c++17` and checked below.

```cpp
#include <bits/stdc++.h>
using namespace std;

// Ukkonen's online suffix-tree construction, O(n) for a constant alphabet.
// Edge labels are half-open intervals [start, end) into s. Leaf edges carry
// end = INF and are read against the shared global leafEnd, realising the
// "once a leaf, always a leaf" + global-end optimization (rule 1 is free).
struct SuffixTree {
    string s;
    static const int INF = INT_MAX;

    struct Node {
        int start, end;      // edge from parent: s[start .. end)
        int link;            // suffix link
        map<char,int> next;  // child indexed by first character of its edge
        Node(int st,int en): start(st), end(en), link(-1) {}
    };

    vector<Node> t;
    int root;
    int leafEnd;             // global end shared by every leaf

    // Active point (the single position the algorithm carries):
    int activeNode, activeEdge, activeLen, remaining;

    int newNode(int st,int en){ t.push_back(Node(st,en)); return (int)t.size()-1; }
    int edgeEnd(int v) const { return min(t[v].end, leafEnd+1); }
    int edgeLen(int v) const { return edgeEnd(v) - t[v].start; }

    SuffixTree(const string& str){
        s = str;
        root = newNode(-1,-1);
        t[root].link = root;
        leafEnd = -1;
        activeNode = root; activeEdge = 0; activeLen = 0; remaining = 0;
        for(int i=0;i<(int)s.size();++i) extend(i);
    }

    // Skip/count: if activeLen reaches past the active edge, hop to its child.
    bool walkDown(int child){
        if(activeLen >= edgeLen(child)){
            activeEdge += edgeLen(child);
            activeLen  -= edgeLen(child);
            activeNode  = child;
            return true;
        }
        return false;
    }

    void extend(int pos){
        leafEnd = pos;          // rule 1: all existing leaves grow, for free
        remaining++;
        int lastNew = -1;       // internal node from this phase awaiting a link

        while(remaining > 0){
            if(activeLen == 0) activeEdge = pos; // sit on the active node itself

            auto it = t[activeNode].next.find(s[activeEdge]);
            if(it == t[activeNode].next.end()){
                // Rule 2 (no matching edge): hang a fresh leaf off activeNode.
                int leaf = newNode(pos, INF);
                t[activeNode].next[s[activeEdge]] = leaf;
                if(lastNew != -1){ t[lastNew].link = activeNode; lastNew = -1; }
            } else {
                int nxt = it->second;
                if(walkDown(nxt)) continue;      // descend, then re-test

                if(s[t[nxt].start + activeLen] == s[pos]){
                    // Rule 3 (char already on the edge): advance and STOP phase.
                    if(lastNew != -1 && activeNode != root)
                        t[lastNew].link = activeNode;
                    activeLen++;
                    break;                        // show-stopper
                }
                // Rule 2 with a split: cut the edge, insert an internal node.
                int split = newNode(t[nxt].start, t[nxt].start + activeLen);
                t[split].link = root;             // provisional; corrected next iter
                t[activeNode].next[s[activeEdge]] = split;
                int leaf = newNode(pos, INF);
                t[split].next[s[pos]] = leaf;
                t[nxt].start += activeLen;
                t[split].next[s[t[nxt].start]] = nxt;
                if(lastNew != -1) t[lastNew].link = split;
                lastNew = split;                  // link resolved next iteration
            }

            remaining--;
            if(activeNode == root && activeLen > 0){
                activeLen--;
                activeEdge = pos - remaining + 1;  // re-anchor on the root edge
            } else if(activeNode != root){
                activeNode = t[activeNode].link;   // follow the suffix link
            }
        }
    }

    // Substring search: match p edge by edge. True iff p occurs in s.
    bool contains(const string& p) const {
        int v = root, i = 0;
        while(i < (int)p.size()){
            auto it = t[v].next.find(p[i]);
            if(it == t[v].next.end()) return false;
            int child = it->second, en = edgeEnd(child);
            for(int k = t[child].start; k < en && i < (int)p.size(); ++k, ++i)
                if(s[k] != p[i]) return false;
            v = child;
        }
        return true;
    }
};
```

**Driver used to verify** — every suffix must be present, every substring query must match `std::string::find`, and the sum of edge lengths must equal the number of distinct non-empty substrings:

```cpp
int main(){
    for(string base : {"abbacaba$","banana$","mississippi$","abababa$"}){
        SuffixTree st(base);
        int n = base.size();

        // (1) every suffix is present
        for(int i=0;i<n;++i) assert(st.contains(base.substr(i)));

        // (2) every substring present; random queries match brute force
        for(int i=0;i<n;++i) for(int j=i;j<=n;++j)
            assert(st.contains(base.substr(i,j-i)));
        string alpha = "abcmips$z";
        for(int trial=0;trial<600;++trial){
            int len = 1 + rand()%5; string q;
            for(int k=0;k<len;++k) q += alpha[rand()%alpha.size()];
            assert(st.contains(q) == (base.find(q)!=string::npos));
        }

        // (3) distinct non-empty substrings = sum of edge lengths
        long long distinct = 0;
        for(int v=0; v<(int)st.t.size(); ++v)
            if(v != st.root) distinct += st.edgeLen(v);
        cout << base << "  distinct-substrings = " << distinct << "\n";
    }
    cout << "ALL TESTS PASSED\n";
}
```

Output (matches a brute-force `set` of all substrings):

```text
abbacaba$  distinct-substrings = 38
banana$  distinct-substrings = 22
mississippi$  distinct-substrings = 65
abababa$  distinct-substrings = 21
ALL TESTS PASSED
```

---

## Alphabet and the sentinel-node trick

- The bound is $O(n)$ for a **constant-size alphabet**. For a general alphabet it is $O(n \log \sigma)$ with a `map` per node (as above), or $O(n)$ if you may sort characters in linear time, or expected $O(n)$ with hash maps — the algorithm never actually needs sorting, only a lookup "which edge starts with character $c$".
- A neat way to **eliminate the root special case**: add a fake node above the root with edges to the root for **every** character. Following a link into the fake node and re-descending automatically drops the first character of $\alpha$. It looks ugly but removes the branch.

[watch from 75:14](https://youtu.be/C10HoshM_DA?t=4514)

---

## What suffix trees are good for

- **Substring search** in a fixed text — build once, answer each query $q$ in $O(|q|)$.
- **Counting distinct substrings** — sum the edge lengths (each edge represents that many compressed intermediate nodes, i.e. that many distinct substrings). The driver above uses exactly this.
- **Longest common substring of several strings** — concatenate them with distinct separators, build one suffix tree, and find the deepest branching node whose subtree contains leaves from **both** strings. A plain DFS over the tree suffices, and all the tree techniques from earlier lectures (subtree DP, heavy-light, binary lifting) apply because it is "just a tree".

![Longest-common-substring setup: concatenate s and t, build one suffix tree, find a node whose subtree holds a blue suffix and a red suffix](/img/dsa/C10HoshM_DA/frame-00320.png)

[watch from 77:02](https://youtu.be/C10HoshM_DA?t=4622)

---

## Complexity recap

| Operation | Best | Average | Worst | Space |
| --- | --- | --- | --- | --- |
| Build (constant alphabet) | $\Theta(n)$ | $\Theta(n)$ | $\Theta(n)$ | $\Theta(n)$ |
| Build (general alphabet, `map`) | $\Theta(n)$ | $\Theta(n \log \sigma)$ | $\Theta(n \log \sigma)$ | $\Theta(n)$ |
| Substring query $q$ | $\Theta(1)$ | $\Theta(\lvert q\rvert)$ | $\Theta(\lvert q\rvert \log \sigma)$ | — |
| Count distinct substrings | $\Theta(n)$ | $\Theta(n)$ | $\Theta(n)$ | $\Theta(n)$ |
| Single amortized active-point step | $\Theta(1)$ | $\Theta(1)$ | $\Theta(1)$ amortized | — |

---

## Practice problems

Suffix **trees** themselves live in competitive programming and bioinformatics, and are rarely asked verbatim in interview rounds. The interview-realistic substitute is the **suffix array** (plus LCP); the modern, easier-to-code equivalent for most tree problems is the **suffix automaton**. Problems below are labelled honestly.

**🎯 Interview (MAANG-style) — the nearest realistic substitutes**

- [Longest Duplicate Substring](https://leetcode.com/problems/longest-duplicate-substring/) — Hard — the canonical "hardest string" interview question; textbook suffix-array / binary-search-plus-hashing, and the deepest branching node of a suffix tree solves it directly.
- [Number of Distinct Substrings in a String](https://leetcode.com/problems/number-of-distinct-substrings-in-a-string/) — Med/Hard — exactly the "sum of edge lengths" application from this lecture.
- [Implement Trie (Prefix Tree)](https://leetcode.com/problems/implement-trie-prefix-tree/) — Med — the trie foundation a suffix tree compresses.
- [Ukkonen's Suffix Tree Construction](https://www.geeksforgeeks.org/ukkonens-suffix-tree-construction-part-1/) — GfG walkthrough — the same algorithm, step by step, if you want a second exposition before coding it.

**🏆 Competitive**

- [CSES — Finding Patterns](https://cses.fi/problemset/task/2102) — Med — multiple substring-existence queries against one text; the substring-search use of the tree.
- [CSES — Counting Patterns](https://cses.fi/problemset/task/2103) — Med — count occurrences of each pattern (leaf-count in a subtree).
- [CSES — Distinct Substrings](https://cses.fi/problemset/task/2105) — Med — the distinct-substring count; suffix automaton or suffix tree.
- [Suffix Automaton (cp-algorithms)](https://cp-algorithms.com/string/suffix-automaton.html) — reference — the modern equivalent structure; smaller, easier to code, and the go-to for most of these problems today.
- Codeforces 1073G "Yet Another LCP Problem" — Hard — canonical suffix-structure problem (LCP over query sets); solvable with suffix array + LCP or a suffix automaton. (Codeforces blocks scripted link checks; search the problemset for `1073G`.)

There is **no official Codeforces home-task post** in this lecture's description, so none is linked.

---

## Further reading

- [cp-algorithms — Suffix Tree (Ukkonen)](https://cp-algorithms.com/string/suffix-tree-ukkonen.html) — a compact reference implementation.
- [cp-algorithms — Suffix Automaton](https://cp-algorithms.com/string/suffix-automaton.html) — the modern equivalent; usually preferred in contests.
- [cp-algorithms — Suffix Array](https://cp-algorithms.com/string/suffix-array.html) — the interview-realistic substitute structure.
- [Wikipedia — Ukkonen's algorithm](https://en.wikipedia.org/wiki/Ukkonen%27s_algorithm) — history and rule-by-rule description.
- [Wikipedia — Suffix tree](https://en.wikipedia.org/wiki/Suffix_tree) — definitions and application catalogue.
- [GeeksforGeeks — Generalized Suffix Tree](https://www.geeksforgeeks.org/generalized-suffix-tree-1/) — the multi-string / longest-common-substring construction.

---

## Key takeaways

- A suffix tree is a **trie of all suffixes**, compressed twice (chain contraction + interval edge labels) into $O(n)$ space; a sentinel `$` gives every suffix its own leaf.
- **Suffix links** shorten the current string by exactly one leading character and stay among branching nodes — the backbone of linear construction.
- **Ukkonen builds online** with three rules; **rule 1 is free** via the global leaf end ("once a leaf, always a leaf"), **rule 3 stops the phase**, and only **rule 2** does structural work — and it fires $O(n)$ times.
- The **active point** plus the **skip/count trick**, analysed with potential $\varphi = -\text{depth}$, give amortized $O(1)$ per operation and $O(n)$ overall for a constant alphabet.
- In practice reach for a **suffix array** (interviews) or a **suffix automaton** (contests) first; suffix trees shine when you genuinely need the tree shape (LCS of many strings, substring statistics).

---

## Glossary

- **Suffix tree** — compressed trie of all suffixes of $s$; every node is a substring, edge labels are intervals $[l, r)$ into $s$.
- **Implicit suffix tree** — the intermediate tree for a prefix of $s$ before the sentinel is added; some suffixes may not yet end at explicit leaves.
- **Suffix link** — edge from the node for string $v$ to the node for $v$ with its first character removed.
- **Active point** — the quadruple (`activeNode`, `activeEdge`, `activeLen`, `remaining`) that records where the next extension happens and how much work is pending.
- **Skip/count trick** — re-descending a known string by comparing only one character per edge and jumping whole edges, so cost is proportional to edges crossed.
- **Global end / "once a leaf, always a leaf"** — leaf edges share one end index that advances each phase, so all leaves grow implicitly (rule 1 is free).
- **Sentinel** — a unique terminator `$` appended to $s$ so that no suffix is a prefix of another.
