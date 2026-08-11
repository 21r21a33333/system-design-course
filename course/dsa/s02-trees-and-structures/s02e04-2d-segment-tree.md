---
title: "S02E04 · 2D Segment Tree Problems"
sidebar_position: 4
description: Sweep line reduces 2D queries to 1D; a segment tree of segment trees, a 2D Fenwick tree, a 2D sparse table, and merge-sort trees answer rectangle queries in O(log squared n).
---

# S02E04 · 2D Segment Tree Problems

> **Source:** Pavel Mavrin, [_A&DS S02E04_](https://youtu.be/_zYMsx4iOSc) · 1h40m lecture → ~15 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- **Two orthogonal techniques** for 2D queries: (1) **sweep line** — reduce the plane to a moving 1D segment tree; (2) **layered structures** — put a whole data structure inside every node of an outer one.
- **Sweep line** sorts events by $x$ and maintains the vertical slice in a 1D tree: *rectangle-covers-point count*, *area of a union of rectangles*, and *online point queries* (via a persistent tree) all fall out.
- The **union-of-rectangles** trick: track $(\min, \text{length of leaves equal to }\min)$ per node; the covered length is total length minus the length where coverage is $0$.
- A **2D segment tree** is a segment tree over rows whose every node holds a segment tree over columns. Point update and rectangle query are both $O(\log^2 n)$; memory is $O(n^2)$.
- The **same layering** builds a 2D Fenwick tree ($O(\log^2 n)$ update/query) and a 2D sparse table ($O(n^2 \log^2 n)$ build, $O(1)$ min query).
- A **merge-sort tree** (segment tree whose nodes store sorted $y$-lists) counts points in a rectangle in $O(\log^2 n)$ offline; **fractional cascading** shaves it to $O(\log n)$.

---

## Sweep line: reducing 2D to 1D

- **Problem.** Given $n$ axis-aligned rectangles and a set of query points, for each point report **how many rectangles cover it**.
- **Key idea — the sweep line.** Slide a vertical line from far left to right. At any $x$ we only track the **state inside the line**, not the whole plane. That state is a 1D problem.
- Project every rectangle onto the vertical line: it becomes a **segment** $[y_1, y_2)$. A query point becomes a single $y$. "How many rectangles cover this point" is now "how many segments cover this $y$" — a classic 1D segment-tree question.
- **Coordinate compression.** Only the $y$-borders of rectangles matter. With $n$ rectangles there are at most $2n$ distinct borders, splitting the line into $\le 2n$ **elementary segments**. Coordinate magnitude is irrelevant — even non-integer $y$ works.

![Rectangles on a plane projected onto a vertical sweep line, with per-segment coverage counts down the left edge](/img/dsa/_zYMsx4iOSc/frame-00048.png)

- **Events.** Each rectangle contributes two events sorted by $x$: at its **left border** add $+1$ to all elementary segments it spans; at its **right border** add $-1$. A query point at $x$ reads the current value of the elementary segment containing its $y$.
- **1D structure needed:** range $\pm 1$ on a segment plus point value read. A segment tree with lazy add — or a Fenwick tree — does this in $O(\log n)$.
- **Complexity.** Sort $y$'s and $x$-events in $O(n \log n)$; process $2n$ updates and $q$ queries, each $O(\log n)$ → total $O\big((n + q)\log n\big)$.

```cpp
#include <bits/stdc++.h>
using namespace std;

// 1D range-add / point-query segment tree (iterative, lazy sums on segments).
struct RangeAddPointQuery {
    int n; vector<long long> t;
    RangeAddPointQuery(int n): n(max(1,n)), t(2*max(1,n), 0) {}
    void add(int l, int r, long long v) {        // add v on [l, r)
        for (l += n, r += n; l < r; l >>= 1, r >>= 1) {
            if (l & 1) t[l++] += v;
            if (r & 1) t[--r] += v;
        }
    }
    long long query(int i) {                      // value at index i
        long long s = 0;
        for (i += n; i > 0; i >>= 1) s += t[i];
        return s;
    }
};

// rectangles as [x1,y1,x2,y2) half-open. Return coverage count per query point.
vector<int> coverCounts(vector<array<int,4>> rects, vector<pair<int,int>> pts) {
    vector<int> ys;                                       // compress y-borders
    for (auto& r : rects) { ys.push_back(r[1]); ys.push_back(r[3]); }
    sort(ys.begin(), ys.end()); ys.erase(unique(ys.begin(), ys.end()), ys.end());
    int segs = max(1, (int)ys.size() - 1);                // elementary y-segments
    auto yidx = [&](int y){ return int(lower_bound(ys.begin(), ys.end(), y) - ys.begin()); };
    RangeAddPointQuery st(segs);

    struct Ev { int x, type, a, b, idx; };                // type: 0 add, 1 remove, 2 query
    vector<Ev> evs;
    for (auto& r : rects) {
        evs.push_back({r[0], 0, yidx(r[1]), yidx(r[3]), -1});   // left border  -> +1
        evs.push_back({r[2], 1, yidx(r[1]), yidx(r[3]), -1});   // right border -> -1
    }
    for (int i = 0; i < (int)pts.size(); i++) {
        int py = pts[i].second;                           // elementary segment holding py
        int k = int(upper_bound(ys.begin(), ys.end(), py) - ys.begin()) - 1;
        evs.push_back({pts[i].first, 2, k, 0, i});
    }
    sort(evs.begin(), evs.end(), [](const Ev& a, const Ev& b){
        if (a.x != b.x) return a.x < b.x;
        return a.type < b.type;                           // both borders at x, then query
    });

    vector<int> res(pts.size(), 0);
    for (auto& e : evs) {
        if (e.type == 0) st.add(e.a, e.b, +1);
        else if (e.type == 1) st.add(e.a, e.b, -1);
        else if (e.a >= 0 && e.a < segs) res[e.idx] = (int)st.query(e.a);
    }
    return res;
}
```

- Sanity check: two $4\times 4$ squares at $(0,0)$ and $(2,2)$ overlapping in a $2\times2$ core, queried at $(1,1),(3,3),(5,5),(7,7)$, return $1\ 2\ 1\ 0$.

[watch from 3:25](https://youtu.be/_zYMsx4iOSc?t=205)

---

## Area of a union of rectangles

- **Problem.** Given $n$ rectangles, compute the **total area of their union** (overlaps counted once).
- **The naive 1D idea fails in 2D.** In one dimension you could `assign 1` to covered segments and sum, but when the sweep line passes a rectangle's **right border** you must set some cells back to $0$ — and which cells become $0$ is not a contiguous range. That is not a segment operation, so it cannot be done fast.
- **Fix — count coverage, not a flag.** Keep, per elementary $y$-segment, the **number of rectangles covering it** (an integer $\ge 0$). Left border adds $+1$, right border adds $-1$ on a range. This *is* a segment operation.
- **Covered length via min-count.** The value we need each step is "physical length of segments with coverage $\ge 1$" $=$ total length $-$ "length with coverage $= 0$". Since all values are $\ge 0$, the value $0$ occurs iff the segment attains the **minimum** and that minimum is $0$. So store per node:
  - $\text{mn}$ — the minimum coverage in the subtree,
  - $\text{cnt}$ — the total physical length of leaves whose coverage equals $\text{mn}$.
- **Merge rule (associative).** Parent $\text{mn} = \min(\text{mn}_L, \text{mn}_R)$; $\text{cnt}$ sums the children whose $\text{mn}$ equals the parent's. A range $\pm 1$ shifts $\text{mn}$ and leaves $\text{cnt}$ unchanged — exactly the lazy tag we can push.

![Union-area derivation: the min plus count-of-min pair, with covered length = total minus length where value equals 0](/img/dsa/_zYMsx4iOSc/frame-00146.png)

- **Assembling the answer.** Between consecutive $x$-events the slice is constant; add $\text{covered length} \times \Delta x$ to the running area, then apply the event.

```cpp
#include <bits/stdc++.h>
using namespace std;

// Segment tree over elementary y-segments of physical lengths len[k].
// Node = (mn = min coverage, cnt = physical length of leaves at that min).
struct AreaTree {
    int n; vector<long long> mn, cnt, lazy, len;
    AreaTree(const vector<long long>& L) {
        int sz = 1; while (sz < (int)L.size()) sz <<= 1;
        n = sz;
        mn.assign(2*n, 0); cnt.assign(2*n, 0); lazy.assign(2*n, 0); len.assign(2*n, 0);
        for (int i = 0; i < (int)L.size(); i++) cnt[n+i] = len[n+i] = L[i];
        for (int i = n-1; i >= 1; i--) pull(i);
    }
    void apply(int v, long long add){ mn[v] += add; lazy[v] += add; }
    void push(int v){ if (lazy[v]) { apply(2*v,lazy[v]); apply(2*v+1,lazy[v]); lazy[v]=0; } }
    void pull(int v){
        mn[v] = min(mn[2*v], mn[2*v+1]);
        cnt[v] = (mn[2*v]==mn[v]? cnt[2*v]:0) + (mn[2*v+1]==mn[v]? cnt[2*v+1]:0);
    }
    void add(int l, int r, long long val, int v, int lo, int hi){   // [l,r) on segments
        if (r <= lo || hi <= l) return;
        if (l <= lo && hi <= r) { apply(v, val); return; }
        push(v); int mid = (lo+hi)/2;
        add(l,r,val,2*v,lo,mid); add(l,r,val,2*v+1,mid,hi); pull(v);
    }
    void add(int l, int r, long long val){ add(l, r, val, 1, 0, n); }
    long long covered(){                                  // physical length with coverage >= 1
        long long total = 0; for (int i = 0; i < n; i++) total += len[n+i];
        long long zero = (mn[1] == 0 ? cnt[1] : 0);
        return total - zero;
    }
};

long long unionArea(vector<array<long long,4>> rects){
    vector<long long> ys;
    for (auto& r : rects){ ys.push_back(r[1]); ys.push_back(r[3]); }
    sort(ys.begin(), ys.end()); ys.erase(unique(ys.begin(), ys.end()), ys.end());
    int segs = (int)ys.size() - 1;
    if (segs <= 0) return 0;
    vector<long long> L(segs);
    for (int k = 0; k < segs; k++) L[k] = ys[k+1] - ys[k];
    auto yidx = [&](long long y){ return int(lower_bound(ys.begin(), ys.end(), y) - ys.begin()); };
    AreaTree st(L);

    struct Ev{ long long x; int type, a, b; };
    vector<Ev> evs;
    for (auto& r : rects){
        evs.push_back({r[0], +1, yidx(r[1]), yidx(r[3])});   // left  border
        evs.push_back({r[2], -1, yidx(r[1]), yidx(r[3])});   // right border
    }
    sort(evs.begin(), evs.end(), [](const Ev& a, const Ev& b){ return a.x < b.x; });

    long long area = 0, prevx = evs.front().x;
    for (auto& e : evs){
        area += st.covered() * (e.x - prevx);             // slice is constant between events
        st.add(e.a, e.b, e.type);
        prevx = e.x;
    }
    return area;
}
```

- Sanity check: two $4\times4$ squares overlapping in a $2\times2$ core give $16 + 16 - 4 = 28$; two disjoint unit squares give $2$.
- **Complexity.** $O(n \log n)$ — two events per rectangle, each an $O(\log n)$ range update.

[watch from 24:04](https://youtu.be/_zYMsx4iOSc?t=1444)

---

## Online queries via a persistent segment tree

- **Problem variant.** Same "how many rectangles cover this point", but the query points arrive **online**, one at a time, and each must be answered immediately.
- **Idea.** Run the sweep as a precomputation, but make the 1D tree **persistent**: every event produces a new version, so all intermediate slice-states are retained.
- To answer a point $(x, y)$, find the tree **version whose $x$ is the largest $\le x$** and read the value at $y$ in that version. One of the two spatial dimensions ($x$) plays the role of "time" for the persistent structure.
- This is the archetypal use of persistence: **freeze the sweep line at every $x$, then random-access any frozen state** in $O(\log n)$. Build is $O(n \log n)$ time and memory; each online query is $O(\log n)$.

[watch from 39:41](https://youtu.be/_zYMsx4iOSc?t=2381)

---

## The 2D segment tree: a tree of trees

- **Operations wanted.** On an $n \times m$ grid: `inc(i, j, v)` adds $v$ to cell $(i, j)$; `sum(rl, rr, cl, cr)` returns the sum over rows $[rl, rr)$ and columns $[cl, cr)$ — a **rectangle sum with point updates**.

![The 2D operations: 1D inc and sum next to their 2D rectangle-sum generalization, with the 4 by 4 example matrix](/img/dsa/_zYMsx4iOSc/frame-00276.png)

- **Construction — layering.** Build a segment tree over the **rows**. Each node of that outer tree owns a **strip** of rows. Inside every outer node, store an entire **segment tree over the columns** of that strip. An inner node then corresponds to a rectangle = (its column range) $\times$ (its owner's row strip), and stores the sum over that rectangle.
- **Storage.** Both trees live in flat arrays, so the whole structure is one $2n \times 2m$ array — a 2D segment tree is literally a 2D array of node-sums.

![A 4 by 4 matrix, the outer segment tree over rows, and one inner segment tree over columns hanging off an outer node](/img/dsa/_zYMsx4iOSc/frame-00236.png)

- **Update $(i, j)$.** In the outer tree, walk the $O(\log n)$ nodes on the root-to-leaf path for row $i$ — those are exactly the strips containing row $i$. In each such node's inner tree, walk the $O(\log m)$ nodes on the path to column $j$ and add $v$. Total $O(\log n \cdot \log m)$.
- **Query rectangle.** In the outer tree, decompose the row range $[rl, rr)$ into $O(\log n)$ canonical nodes (standard segment-tree query). For each, query its inner tree over the column range $[cl, cr)$ in $O(\log m)$. Sum the partials. Total $O(\log n \cdot \log m) = O(\log^2 n)$.

```cpp
#include <bits/stdc++.h>
using namespace std;

// Segment tree (over rows) whose every node holds a segment tree (over columns).
// Point update + rectangle sum, each O(log^2 n). Backed by one 2R x 2C array.
struct SegTree2D {
    int R, C;
    vector<vector<long long>> t;                  // t[outer node][inner node]
    SegTree2D(int R, int C): R(R), C(C), t(2*R, vector<long long>(2*C, 0)) {}

    void innerAdd(int xr, int c, long long v){     // add v at column c in inner tree xr
        for (c += C; c > 0; c >>= 1) t[xr][c] += v;
    }
    void add(int r, int c, long long v){           // update cell (r, c)
        for (r += R; r > 0; r >>= 1) innerAdd(r, c, v);   // every strip containing row r
    }
    long long innerSum(int xr, int cl, int cr){    // sum columns [cl, cr) in inner tree xr
        long long s = 0;
        for (cl += C, cr += C; cl < cr; cl >>= 1, cr >>= 1){
            if (cl & 1) s += t[xr][cl++];
            if (cr & 1) s += t[xr][--cr];
        }
        return s;
    }
    long long sum(int rl, int rr, int cl, int cr){ // rows [rl,rr) x cols [cl,cr)
        long long s = 0;
        for (rl += R, rr += R; rl < rr; rl >>= 1, rr >>= 1){
            if (rl & 1) s += innerSum(rl++, cl, cr);
            if (rr & 1) s += innerSum(--rr, cl, cr);
        }
        return s;
    }
};
```

- **Higher dimensions.** The layering is general: put a 2D structure inside every node of a $z$-axis segment tree to get a 3D tree with $O(\log^3 n)$ operations.

[watch from 47:07](https://youtu.be/_zYMsx4iOSc?t=2827)

---

## Same recipe: 2D Fenwick and 2D sparse table

**2D Fenwick tree (BIT).** A 1D Fenwick keeps prefix sums via the low-bit jump. In 2D, nest the jump: $f[i][j]$ aggregates a rectangle governed by $p(i) \dots i$ and $p(j) \dots j$. Update and prefix-rectangle query each do a double low-bit loop → $O(\log^2 n)$. This is the **common interview form** of 2D range-sum-with-updates.

![2D Fenwick relation f[i][j] as a double sum over the p(i)..i by p(j)..j rectangle](/img/dsa/_zYMsx4iOSc/frame-00276.png)

```cpp
#include <bits/stdc++.h>
using namespace std;

// 2D Fenwick tree: point add, prefix / rectangle sum, both O(log^2 n).
struct BIT2D {
    int n, m; vector<vector<long long>> f;
    BIT2D(int n, int m): n(n), m(m), f(n+1, vector<long long>(m+1, 0)) {}
    void add(int x, int y, long long v){                  // 0-indexed cell
        for (int i = x+1; i <= n; i += i & -i)
            for (int j = y+1; j <= m; j += j & -j)
                f[i][j] += v;
    }
    long long pref(int x, int y){                         // sum of [0..x] x [0..y]
        long long s = 0;
        for (int i = x+1; i > 0; i -= i & -i)
            for (int j = y+1; j > 0; j -= j & -j)
                s += f[i][j];
        return s;
    }
    long long sum(int x1,int y1,int x2,int y2){           // inclusive rectangle
        return pref(x2,y2) - pref(x1-1,y2) - pref(x2,y1-1) + pref(x1-1,y1-1);
    }
};
```

**2D sparse table.** A 1D sparse table stores $m[i][j] = \min$ of the segment $[i,\ i + 2^{j} - 1]$; a query splits the range into two overlapping powers of two. In 2D use a 4-index table $m[i][j][k][l]$ over a row power $2^j$ and a column power $2^l$; a query covers the target rectangle with **four** overlapping power-of-two rectangles and takes their min. Build is $O(n^2 \log^2 n)$ time and memory; each min query is $O(1)$.

![2D sparse table entry m[i][j] as min over a fixed row length, with precalc O(n log n) and query O(1)](/img/dsa/_zYMsx4iOSc/frame-00302.png)

```cpp
#include <bits/stdc++.h>
using namespace std;

// 2D sparse table for idempotent range-min. Build O(n^2 log^2 n), query O(1).
struct Sparse2D {
    int n, m, LN, LM;
    vector<vector<vector<vector<int>>>> sp;               // sp[j][l][i][k]
    Sparse2D(const vector<vector<int>>& a){
        n = a.size(); m = a[0].size();
        LN = 1; while ((1<<LN) <= n) LN++;
        LM = 1; while ((1<<LM) <= m) LM++;
        sp.assign(LN, vector<vector<vector<int>>>(LM,
                  vector<vector<int>>(n, vector<int>(m, INT_MAX))));
        for (int i=0;i<n;i++) for (int k=0;k<m;k++) sp[0][0][i][k] = a[i][k];
        for (int l=1; l<LM; l++)                          // extend along columns
            for (int i=0;i<n;i++)
                for (int k=0; k+(1<<l)<=m; k++)
                    sp[0][l][i][k] = min(sp[0][l-1][i][k], sp[0][l-1][i][k+(1<<(l-1))]);
        for (int j=1; j<LN; j++)                          // then along rows
            for (int l=0; l<LM; l++)
                for (int i=0; i+(1<<j)<=n; i++)
                    for (int k=0;k<m;k++)
                        sp[j][l][i][k] = min(sp[j-1][l][i][k], sp[j-1][l][i+(1<<(j-1))][k]);
    }
    int query(int r1,int c1,int r2,int c2){               // inclusive min over rectangle
        int j = 31 - __builtin_clz(r2-r1+1);
        int l = 31 - __builtin_clz(c2-c1+1);
        int a1 = sp[j][l][r1][c1];
        int a2 = sp[j][l][r2-(1<<j)+1][c1];
        int a3 = sp[j][l][r1][c2-(1<<l)+1];
        int a4 = sp[j][l][r2-(1<<j)+1][c2-(1<<l)+1];
        return min(min(a1,a2), min(a3,a4));
    }
};
```

- **Trade-off.** The sparse table answers static min in $O(1)$ but does not support updates; the Fenwick tree supports updates but only invertible aggregates (sum), not min.

[watch from 1:04:13](https://youtu.be/_zYMsx4iOSc?t=3853)

---

## Merge-sort tree: offline points-in-rectangle

- **Problem.** Fixed set of $n$ points; answer many queries of the form "how many points lie in the rectangle $[x_1, x_2] \times [y_1, y_2]$" (the "select donuts with size and price in given ranges" example).
- **Structure.** Build a segment tree over the points **sorted by $x$**. In each node, store the **sorted list of the $y$-coordinates** of the points in its $x$-range. Because each level merges its children's lists, this is exactly a **merge sort** frozen as a tree — hence the name. Total size and build time are $O(n \log n)$.

![Merge-sort tree: sorted y-lists merging up the tree from single elements, exactly like merge sort](/img/dsa/_zYMsx4iOSc/frame-00366.png)

- **Query.** Decompose the $x$-range $[x_1, x_2]$ into $O(\log n)$ canonical nodes. In each node's sorted $y$-list, **binary search** the count of $y$ in $[y_1, y_2]$. Sum the counts. Each node costs $O(\log n)$ → total $O(\log^2 n)$.

```cpp
#include <bits/stdc++.h>
using namespace std;

// Merge-sort tree: segment tree over points sorted by x; each node stores the
// sorted y's of its x-range. Count points in [xlo,xhi] x [yl,yr] in O(log^2 n).
struct MergeSortTree {
    int n;
    vector<int> xs;                     // point x's, sorted (leaf order)
    vector<vector<int>> ys;             // ys[node] = sorted y's of that x-range
    MergeSortTree(vector<pair<int,int>> pts){
        sort(pts.begin(), pts.end());   // by x
        n = pts.size();
        xs.resize(n);
        for (int i=0;i<n;i++) xs[i] = pts[i].first;
        ys.assign(2*n, {});
        for (int i=0;i<n;i++) ys[n+i] = { pts[i].second };
        for (int i=n-1;i>=1;i--)                          // merge children, like merge sort
            merge(ys[2*i].begin(), ys[2*i].end(),
                  ys[2*i+1].begin(), ys[2*i+1].end(),
                  back_inserter(ys[i]));
    }
    int cntY(int node, int yl, int yr){                   // y in [yl,yr] within node's list
        auto& v = ys[node];
        return int(upper_bound(v.begin(), v.end(), yr) - lower_bound(v.begin(), v.end(), yl));
    }
    int query(int l, int r, int yl, int yr){              // leaf-index range [l,r)
        int s = 0;
        for (l += n, r += n; l < r; l >>= 1, r >>= 1){
            if (l & 1) s += cntY(l++, yl, yr);
            if (r & 1) s += cntY(--r, yl, yr);
        }
        return s;
    }
    int countInRect(int xlo, int xhi, int yl, int yr){    // map x-values to leaves, then count
        int l = int(lower_bound(xs.begin(), xs.end(), xlo) - xs.begin());
        int r = int(upper_bound(xs.begin(), xs.end(), xhi) - xs.begin());
        if (l >= r) return 0;
        return query(l, r, yl, yr);
    }
};
```

- **Fractional cascading → $O(\log n)$.** The $O(\log n)$ binary searches (one per node) are redundant: they all look for the same $y_1, y_2$. Store in each parent list, for every element, its **precomputed position** in the left child's list and in the right child's list. Then binary search **only once**, in the root list, and follow the precomputed pointers down the tree in $O(1)$ per step. Query drops to a single $O(\log n)$ search plus $O(\log n)$ constant-time descents.

![Fractional cascading: one binary search in the root list, then follow precomputed left/right positions down in constant time](/img/dsa/_zYMsx4iOSc/frame-00366.png)

- **Mutability.** This structure is essentially static — inserting a point rebuilds many sorted lists. To allow $y$-updates, replace each sorted array by a **balanced BST**, giving $O(\log^2 n)$ updates (covered in later lectures).

[watch from 1:17:57](https://youtu.be/_zYMsx4iOSc?t=4677)

---

## Complexity recap

| Structure / query | Build | Update | Query | Space |
| --- | --- | --- | --- | --- |
| Sweep line + 1D tree (offline) | $O(n\log n)$ | — | $O(\log n)$ per event | $O(n)$ |
| Union of rectangles (min-count) | — | $O(\log n)$ | $O(1)$ (read root) | $O(n)$ |
| Persistent sweep (online points) | $O(n\log n)$ | — | $O(\log n)$ | $O(n\log n)$ |
| 2D segment tree | $O(n^2)$ | $O(\log^2 n)$ | $O(\log^2 n)$ | $O(n^2)$ |
| 2D Fenwick tree | $O(n^2)$ | $O(\log^2 n)$ | $O(\log^2 n)$ | $O(n^2)$ |
| 2D sparse table (min) | $O(n^2\log^2 n)$ | — | $O(1)$ | $O(n^2\log^2 n)$ |
| Merge-sort tree | $O(n\log n)$ | — | $O(\log^2 n)$ | $O(n\log n)$ |
| Merge-sort tree + fractional cascading | $O(n\log n)$ | — | $O(\log n)$ | $O(n\log n)$ |

---

## Practice problems

Honest framing: **full 2D segment trees and merge-sort trees are competitive-programming material**, rarely asked verbatim in interviews. The **2D Fenwick tree** is the interview-realistic form of "mutable 2D range sum", and the 1D sweep-line / inversion ideas show up as hard interview problems. Links below are curated and difficulty-labelled honestly.

**🎯 Interview (MAANG-style)**

- [Range Sum Query 2D - Mutable — LeetCode 308](https://leetcode.com/problems/range-sum-query-2d-mutable/) — Hard — the canonical 2D Fenwick tree: point update, rectangle sum.
- [Count of Smaller Numbers After Self — LeetCode 315](https://leetcode.com/problems/count-of-smaller-numbers-after-self/) — Hard — offline 2D counting; a BIT over compressed values or a merge-sort count.
- [The Skyline Problem — LeetCode 218](https://leetcode.com/problems/the-skyline-problem/) — Hard — the sweep-line archetype; events sorted by $x$ with a max-structure over $y$.
- [Two-Dimensional Segment Tree (Sub-Matrix Sum) — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/two-dimensional-segment-tree-sub-matrix-sum/) — Hard — the exact tree-of-trees built above.
- [Two-Dimensional Binary Indexed Tree — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/binary-indexed-tree-or-fenwick-tree-2/) — Medium — reference implementation of the interview-common 2D BIT.

**🏆 Competitive**

- [Forest Queries — CSES 1652](https://cses.fi/problemset/task/1652) — Easy — static 2D prefix sums; the warm-up before mutability.
- [Forest Queries II — CSES 1739](https://cses.fi/problemset/task/1739) — Medium — 2D Fenwick tree with point updates and rectangle sums.

> No official Codeforces home-task link is attached to this lecture's description, so none is fabricated here; the CSES pair above is the closest verified equivalent for the exact operations Pavel builds.

---

## Further reading

- [Segment tree (2D section) — cp-algorithms](https://cp-algorithms.com/data_structures/segment_tree.html) — the tree-of-trees and its complexity, worked out.
- [Segment tree — Wikipedia](https://en.wikipedia.org/wiki/Segment_tree) and [Range tree — Wikipedia](https://en.wikipedia.org/wiki/Range_tree) — the merge-sort tree is a range tree in disguise.
- [Fenwick tree — Wikipedia](https://en.wikipedia.org/wiki/Fenwick_tree) — the low-bit trick that the 2D version nests.
- [Fractional cascading — Wikipedia](https://en.wikipedia.org/wiki/Fractional_cascading) — how the extra logarithm disappears.

---

## Key takeaways

- **Sweep line** is the first thing to try for a 2D query: if you can solve the problem inside one vertical slice with a segment tree, and each border event is a segment operation, you are done.
- The **union-area min-count trick** turns a non-range "set some cells to zero" into a clean $\pm1$ range update plus a $(\min, \text{count})$ read.
- **Layering** — a data structure in every node of another — mechanically lifts segment trees, Fenwick trees, and sparse tables into 2D (and beyond), at one extra $\log$ per dimension.
- The **merge-sort tree** stores sorted $y$-lists in a segment tree over $x$; **fractional cascading** removes its second logarithm.
- Persistence lets a precomputed sweep answer **online** point queries by treating one axis as time.

## Glossary

- **Sweep line** — a moving vertical line that reduces a 2D problem to a sequence of 1D states processed in $x$-order.
- **Elementary segment** — one gap between consecutive compressed coordinates; the atomic unit a sweep-line tree indexes.
- **Tree of trees** — an outer segment tree whose every node stores a full inner segment tree over the other axis.
- **Merge-sort tree** — a segment tree whose nodes hold the sorted values of their range, built by merging children like merge sort.
- **Fractional cascading** — precomputed cross-references between related sorted lists that replace repeated binary searches with $O(1)$ pointer follows.
- **Persistent structure** — one that retains all past versions, so any earlier state can be queried in $O(\log n)$.
