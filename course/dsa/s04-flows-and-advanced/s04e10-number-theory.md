---
title: "S04E10 · Number Theory Algorithms"
sidebar_position: 10
description: Euclid and extended Euclid, Diophantine equations and modular inverse, fast modular exponentiation, the sieve, Euler's totient with Fermat/Euler theorems, CRT, Miller-Rabin primality, generators, and Pollard-rho factorization.
---

# S04E10 · Number Theory Algorithms

> **Source:** Pavel Mavrin, [_A&DS S04E10_](https://youtu.be/B--VP2MLI5s) · 1h48m lecture → ~18 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- **Euclid's algorithm** replaces the pair $(a,b)$ with $(b, a \bmod b)$ because both pairs share the same set of common divisors; it terminates in $O(\log(a+b))$ steps since each two steps at least halve $a$.
- **Extended Euclid** returns not only $d=\gcd(a,b)$ but integers $x,y$ with $ax+by=d$ — this solves **Diophantine equations** $ax+by=c$ (solvable exactly when $d \mid c$) and gives the **modular inverse** $b^{-1} \bmod n$ (exists exactly when $\gcd(b,n)=1$).
- **Fast modular exponentiation** computes $a^e \bmod m$ in $O(\log e)$ multiplications by repeated squaring.
- The **sieve of Eratosthenes** lists all primes up to $n$ in $O(n \log\log n)$; the **linear sieve** does it in $O(n)$ and yields each number's smallest prime factor.
- **Euler's totient** $\varphi(n)$ counts integers coprime to $n$; **Euler's theorem** says $a^{\varphi(n)} \equiv 1 \pmod n$ when $\gcd(a,n)=1$, and **Fermat's little theorem** is the prime case $a^{p-1}\equiv 1\pmod p$.
- **CRT** reconstructs a number from its remainders modulo coprime $n,m$ by solving one Diophantine equation; **Miller-Rabin** is a fast randomized primality test; **Pollard's rho** factors in about $O(n^{1/4})$ using a birthday-paradox cycle.

---

## Greatest common divisor: Euclid's algorithm

- **Definition.** $\gcd(a,b)$ is the largest integer dividing both $a$ and $b$. Example: $\gcd(20,64)=4$.
- **Key lemma.** If $d \mid a$ and $d \mid b$, then $d \mid (a-b)$. Conversely if $d \mid (a-b)$ and $d \mid b$, then $d \mid a$ (since $a = (a-b)+b$). So the pairs $(a,b)$ and $(a-b,b)$ have **exactly the same set of common divisors**, hence the same gcd.
- **Naive subtraction is too slow.** Repeatedly doing $a \leftarrow a-b$ takes $a/b$ steps — for $(1000, 1)$ that is 1000 steps.
- **Fix: subtract as many copies of $b$ as fit at once.** That is exactly the remainder: $a \bmod b = a - \lfloor a/b \rfloor \cdot b$. The formula is symmetric, so we may always keep $a \ge b$.

```cpp
#include <bits/stdc++.h>
using namespace std;
typedef long long ll;

// gcd(a,b): recurse on (b, a mod b). The swap happens automatically:
// if a < b then a mod b == a, so gcd(a,b) calls gcd(b,a).
ll gcd_rec(ll a, ll b) {
    if (b == 0) return a;          // gcd(a,0) = a
    return gcd_rec(b, a % b);
}
```

- **Trace** $\gcd(64,20)$: $\to (20, 64\bmod 20=4) \to (4, 20\bmod 4=0) \to 4$. Two steps.

![Euclid gcd code with base case b=0 returning a, the recursive call gcd(b, a mod b), the 64,20,4,0 trace, and O(log n) complexity](/img/dsa/B--VP2MLI5s/frame-00060.png)

- **Why $O(\log)$ steps.** Claim: $a \bmod b \le a/2$ always. Two cases:
  - If $b \le a/2$, then $a \bmod b < b \le a/2$.
  - If $b > a/2$, then exactly one copy of $b$ fits, so $a \bmod b = a-b < a/2$.
- Each recursion at least halves one argument, so there are at most $\log_2 a$ steps. Since inputs can be huge (cryptography uses 500-plus-bit numbers), we measure cost in the **number of digits** $= \log n$: this is a **polynomial-in-input-size** algorithm.

[watch from 1:35](https://youtu.be/B--VP2MLI5s?t=95)

---

## Binary (Stein's) gcd — no division

- **Motivation.** For big integers, computing $a \bmod b$ (long division of one big number by another) is expensive. The binary gcd replaces every division with a division **by 2**, which is just a bit shift.
- **Four cases** (each strips a factor of 2, so still $O(\log n)$ steps):
  - $a$ even, $b$ odd: $2 \nmid \gcd$, so $\gcd(a,b)=\gcd(a/2,\,b)$.
  - $a,b$ both even: $\gcd(a,b)=2\cdot\gcd(a/2,\,b/2)$.
  - $a,b$ both odd: $a-b$ is even, so $\gcd(a,b)=\gcd\!\big((a-b)/2,\,b\big)$.

```cpp
// Binary GCD: replaces "a mod b" with shifts (÷2) and subtraction only.
ll gcd_bin(ll a, ll b) {
    if (a == 0) return b;
    if (b == 0) return a;
    int shift = __builtin_ctzll(a | b);   // 2^shift is common to both
    a >>= __builtin_ctzll(a);             // make a odd
    do {
        b >>= __builtin_ctzll(b);         // make b odd
        if (a > b) swap(a, b);            // keep a <= b
        b -= a;                           // b-a is even
    } while (b != 0);
    return a << shift;
}
```

- **Cost.** $O(\log^2 n)$ bit operations on big integers, but every inner operation (shift, subtract) is cheap compared to a full remainder.

![Board showing the four gcd cases: a even/b odd gives gcd(a/2,b); both even gives 2·gcd(a/2,b/2); both odd reduces to gcd((a-b)/2,b); plus the Diophantine setup ax+by=c with d=gcd(a,b)](/img/dsa/B--VP2MLI5s/frame-00100.png)

[watch from 15:49](https://youtu.be/B--VP2MLI5s?t=949)

---

## Extended Euclid and Diophantine equations

- **Diophantine equation.** Solve $ax+by=c$ in **integers** $x,y$. Let $d=\gcd(a,b)$.
  - Since $d \mid a$ and $d \mid b$, the left side is always divisible by $d$; hence a solution exists **iff $d \mid c$**.
  - Example: $2x+3y=5$ has $d=1$, $1 \mid 5$, solvable. But $2x+4y=7$ is unsolvable (left side even, 7 odd).
- **Strategy.** First solve $ax+by=d$; if $c=c' \cdot d$, multiply that solution by $c'$.
- **Extended Euclid** carries the linear combination through the recursion. At the base $b=0$: $\gcd=a$ and $a\cdot 1 + 0\cdot 0 = a$, so return $(a,1,0)$.
- **Recursive step.** Suppose the call on $(b,\,a\bmod b)$ returns $(d,x',y')$ with

$$
x'\,b + y'\,(a \bmod b) = d.
$$

Substitute $a\bmod b = a - \lfloor a/b\rfloor\,b$:

$$
x'\,b + y'\Big(a - \big\lfloor a/b\big\rfloor\,b\Big) = y'\,a + \Big(x' - \big\lfloor a/b\big\rfloor\,y'\Big)\,b = d.
$$

So for the original $(a,b)$ the coefficients are $x = y'$ and $y = x' - \lfloor a/b\rfloor\,y'$.

```cpp
// Returns g = gcd(a,b) and sets x,y so that a*x + b*y = g.
ll extgcd(ll a, ll b, ll &x, ll &y) {
    if (b == 0) { x = 1; y = 0; return a; }   // a*1 + 0*0 = a
    ll x1, y1;
    ll d = extgcd(b, a % b, x1, y1);          // x1*b + y1*(a%b) = d
    x = y1;
    y = x1 - (a / b) * y1;
    return d;
}
```

![Extended Euclid on the board: gcd(a,b) returns d, x, y with a·x+b·y=d; base case returns a,1,0; recursive line returns d, y, x - y·(a/b)](/img/dsa/B--VP2MLI5s/frame-00125.png)

- **Full solution set.** $ax+by=c$ has infinitely many solutions: if $(x_0,y_0)$ works, so does $(x_0 + t\,b/d,\ y_0 - t\,a/d)$ for every integer $t$.

[watch from 20:52](https://youtu.be/B--VP2MLI5s?t=1252)

---

## Modular arithmetic and the modular inverse

- **Setting.** Work only with the integers $0 \ldots n-1$; after every $+$, $-$, $\times$ take the result $\bmod n$. This keeps you inside the small set while preserving **associativity, commutativity, and distributivity**: $(a+b)+c=a+(b+c)$, $a+b=b+a$, $(a+b)c=ac+bc$, and $a+b-b=a$ all still hold.
- **Division is the hard part.** Define $b^{-1}$ as the number with $b\cdot b^{-1} \equiv 1 \pmod n$. Then $a/b$ means $a\cdot b^{-1}$.
- **When does $b^{-1}$ exist?** $b\cdot b^{-1} \equiv 1 \pmod n$ means $b\cdot b^{-1} - x\,n = 1$ for some integer $x$ — a Diophantine equation $b\cdot b^{-1} + (-x)\,n = 1$. It is solvable **iff $\gcd(b,n)=1$**, i.e. $b$ is coprime to $n$.
- Solve it with extended Euclid in **polynomial time**. If $n$ is prime, every $b$ in $1 \ldots n-1$ is coprime to $n$, so you can divide by anything except zero.

```cpp
// Modular inverse of a mod m via extended Euclid.
// Returns -1 if gcd(a,m) != 1 (no inverse exists).
ll modinv(ll a, ll m) {
    ll x, y;
    a = ((a % m) + m) % m;
    ll g = extgcd(a, m, x, y);          // a*x + m*y = g
    if (g != 1) return -1;              // not invertible
    return ((x % m) + m) % m;           // normalise into 0..m-1
}
```

![Modular arithmetic laws on the board and the definition 1/b = b^-1 with b·b^-1 = 1, reducing the inverse to a Diophantine equation](/img/dsa/B--VP2MLI5s/frame-00185.png)

[watch from 40:24](https://youtu.be/B--VP2MLI5s?t=2424)

---

## Fast modular exponentiation

- Not on this board explicitly, but it powers Fermat/Euler tests and inverses (Fermat's inverse $a^{p-2}$). Compute $a^e \bmod m$ in $O(\log e)$ multiplications by squaring: $a^e = (a^{e/2})^2$ when $e$ is even, $a\cdot a^{e-1}$ when odd.

```cpp
typedef __int128 lll;   // 128-bit product to avoid overflow on the multiply

ll modpow(ll a, ll e, ll m) {
    a %= m; if (a < 0) a += m;
    ll r = 1 % m;
    while (e > 0) {
        if (e & 1) r = (lll)r * a % m;
        a = (lll)a * a % m;
        e >>= 1;
    }
    return r;
}
```

- **Cross-check.** $2^{10}\bmod 1000 = 1024\bmod 1000 = 24$; and Fermat's little theorem gives $2^{10}\bmod 11 = 1$.

[watch from 47:37](https://youtu.be/B--VP2MLI5s?t=2857)

---

## Chinese Remainder Theorem

- **Setup.** Take coprime moduli $n,m$ (so $\gcd(n,m)=1$). Any $a \in \{0,\ldots,nm-1\}$ maps to the pair $(a_1,a_2)=(a\bmod n,\ a\bmod m)$. There are $nm$ values of $a$ and $nm$ possible pairs, and the map is a **bijection**: every pair comes from exactly one $a$.
- **Forward** ($a \to$ pair) is trivial. **Backward** (pair $\to a$) is the algorithm.
- **Reconstruction.** From $a_1 = a - x\,n$ and $a_2 = a - y\,m$ we get $a = a_1 + x n = a_2 + y m$, hence

$$
x\,n - y\,m = a_2 - a_1.
$$

This is a Diophantine equation in $x,y$; because $\gcd(n,m)=1$ it is always solvable. Solve for $x$, then $a = a_1 + x\,n$ (taken mod $nm$).

```cpp
// Solve x ≡ a1 (mod n), x ≡ a2 (mod m) with gcd(n,m)=1.
// Returns the unique x in [0, n*m).
ll crt2(ll a1, ll n, ll a2, ll m) {
    ll p, q;
    extgcd(n, m, p, q);                 // n*p + m*q = 1, so n*p ≡ 1 (mod m)
    lll mod = (lll)n * m;
    ll t = (((a2 - a1) % m) * p) % m;   // solve x ≡ (a2-a1)*p (mod m)
    lll x = a1 + (lll)n * t;
    x %= mod; if (x < 0) x += mod;
    return (ll)x;
}
```

![CRT worked with n=2, m=3: the table of (a, a1, a2) triples shows every pair is distinct; the reconstruction reduces to the Diophantine equation xn − ym = a2 − a1](/img/dsa/B--VP2MLI5s/frame-00150.png)

- **Non-coprime moduli.** If $\gcd(n,m)=g > 1$ the map is no longer a bijection: the equation is solvable only when $g \mid (a_2-a_1)$, and the answer is unique only modulo $\operatorname{lcm}(n,m)$, not $nm$.

![Non-coprime case n=2, m=4: the (a, a1, a2) table shows collisions — several a values share the same pair of remainders, so uniqueness holds only up to lcm](/img/dsa/B--VP2MLI5s/frame-00160.png)

[watch from 31:14](https://youtu.be/B--VP2MLI5s?t=1874)

---

## Primes, the sieve, and Euler's totient

- **Simplest primality test:** trial-divide by every candidate up to $\sqrt n$. If $n=p\cdot q$ is composite, at least one factor is $\le \sqrt n$. Cost $O(\sqrt n)$ — but that is **exponential** in the input size $\log n$, so useless for 1000-bit numbers.
- **Sieve of Eratosthenes** — all primes up to $n$ at once:

```cpp
vector<int> sieve(int n) {
    vector<bool> comp(n + 1, false);
    vector<int> primes;
    for (int i = 2; i <= n; i++) {
        if (!comp[i]) {
            primes.push_back(i);
            for (ll j = (ll)i * i; j <= n; j += i) comp[j] = true;
        }
    }
    return primes;                      // O(n log log n)
}
```

- **Linear sieve** — $O(n)$, and records each number's **smallest prime factor** (spf), which gives factorization in $O(\log n)$ per query:

```cpp
// linear_sieve: every composite is marked exactly once, by its smallest prime.
vector<int> linear_sieve(int n, vector<int>& spf) {
    spf.assign(n + 1, 0);
    vector<int> primes;
    for (int i = 2; i <= n; i++) {
        if (spf[i] == 0) { spf[i] = i; primes.push_back(i); }
        for (int p : primes) {
            if (p > spf[i] || (ll)i * p > n) break;
            spf[i * p] = p;             // p is the smallest prime factor of i*p
        }
    }
    return primes;
}
```

- **Euler's totient** $\varphi(n)$ = count of integers in $0 \ldots n-1$ coprime to $n$. If $n=p_1^{a_1}\cdots p_k^{a_k}$ then $\varphi(n) = n\prod_{p \mid n}\big(1-\tfrac1p\big)$. For prime $p$, $\varphi(p)=p-1$.

```cpp
ll phi(ll n) {
    ll result = n;
    for (ll p = 2; p * p <= n; p++)
        if (n % p == 0) {
            while (n % p == 0) n /= p;
            result -= result / p;       // multiply by (1 - 1/p)
        }
    if (n > 1) result -= result / n;    // a leftover prime factor
    return result;
}
```

- **Euler's theorem.** If $\gcd(a,n)=1$ then $a^{\varphi(n)} \equiv 1 \pmod n$.
  - **Proof (board).** Let $x_1,\ldots,x_{\varphi(n)}$ be all residues coprime to $n$. Multiply each by $a$: the $y_i = a\,x_i$ are again coprime to $n$ and all distinct (divide by $a$ to recover $x_i$), so $\{y_i\}=\{x_i\}$ as sets. Taking the product of each set: $\prod x_i \equiv \prod y_i = a^{\varphi(n)}\prod x_i \pmod n$. Cancel the (invertible) product to get $1 \equiv a^{\varphi(n)}$.
- **Fermat's little theorem** is the prime special case: $\varphi(p)=p-1$, so $a^{p-1}\equiv 1 \pmod p$ for $p \nmid a$.

![Euler's theorem on the board: phi(n) counts residues coprime to n; the sets x_i and y_i = a·x_i are equal; taking products gives 1 = a^phi(n)](/img/dsa/B--VP2MLI5s/frame-00230.png)

[watch from 52:25](https://youtu.be/B--VP2MLI5s?t=3145)

---

## Primality testing: Fermat and Miller-Rabin

- **Fermat test.** Pick a random $a$. If $\gcd(a,n)\neq 1$, or $a^{n-1}\not\equiv 1\pmod n$, then $n$ is **definitely composite**. Otherwise report "probably prime."

```cpp
// Fermat test: returns false ⇒ n is composite. true ⇒ probably prime.
bool fermat_test(ll n, ll a) {
    if (gcd_rec(a, n) != 1) return false;
    if (modpow(a, n - 1, n) != 1) return false;
    return true;
}
```

![Fermat test pseudocode: pick random a; if gcd(a,n)≠1 return False; if a^(n-1)≠1 return False; else return True — with the euler-function context](/img/dsa/B--VP2MLI5s/frame-00245.png)

- **Weakness: Carmichael numbers.** For some composites (e.g. 561) every coprime $a$ satisfies $a^{n-1}\equiv 1$, so Fermat is fooled. This happens when $\varphi(n) \mid (n-1)$.
- **Miller-Rabin** adds one check. Write $n-1 = 2^x \cdot y$ with $y$ odd. Then

$$
a^{n-1} = \Big(\big(\cdots(a^{y})^2\big)^2\cdots\Big)^2 \quad (x \text{ squarings}).
$$

Compute the sequence $a^y, a^{2y}, a^{4y}, \ldots, a^{2^x y}=a^{n-1}$. The last term must be 1 (if it is not, $n$ is composite by Fermat). Walking back from the end, find the **first entry $k$ that is not 1**.

![Miller-Rabin split: n−1 = 2^x·y with y odd; the chain a^y, a^2y, …, a^(2^x·y) each squared from the previous, all trailing entries equal 1](/img/dsa/B--VP2MLI5s/frame-00262.png)

- **The extra check.** The entry right after $k$ equals $k^2 \equiv 1 \pmod n$. So $k^2-1=(k-1)(k+1)\equiv 0\pmod n$. If $k \neq \pm 1$, then neither factor is $\equiv 0$, yet their product is — impossible mod a prime. Hence **if $k\neq \pm 1$, $n$ is composite** (and $\gcd(k-1,n)$ even hands you a factor).

![Miller-Rabin conclusion on the board: from the chain of squarings, k ≠ ±1 implies n is composite because k²−1 = (k−1)(k+1) ≡ 0 forces a zero-divisor](/img/dsa/B--VP2MLI5s/frame-00270.png)

```cpp
// Deterministic Miller-Rabin for 64-bit n using a fixed witness set.
bool miller_rabin(ll n) {
    if (n < 2) return false;
    for (ll p : {2,3,5,7,11,13,17,19,23,29,31,37})
        if (n % p == 0) return n == p;
    ll d = n - 1; int r = 0;
    while ((d & 1) == 0) { d >>= 1; r++; }        // n-1 = 2^r * d
    for (ll a : {2,3,5,7,11,13,17,19,23,29,31,37}) {
        ll x = modpow(a, d, n);                   // a^d
        if (x == 1 || x == n - 1) continue;
        bool composite = true;
        for (int i = 0; i < r - 1; i++) {
            x = (lll)x * x % n;                    // square up the chain
            if (x == n - 1) { composite = false; break; }
        }
        if (composite) return false;              // found k ≠ ±1
    }
    return true;
}
```

- **Error bound.** For a composite $n$, at most $n/4$ of the residues are "liars." One random witness fails with probability $\le 1/4$; running $t$ independent rounds drops it to $\le 4^{-t}$. (The 12 fixed small-prime witnesses above are provably enough for all $n < 2^{64}$.)

[watch from 62:52](https://youtu.be/B--VP2MLI5s?t=3772)

---

## Generators (primitive roots)

- For a prime $p$, the powers $g^0, g^1, g^2, \ldots$ mod $p$ are periodic with period dividing $p-1$ (since $g^{p-1}\equiv 1$). A **generator** (primitive root) is a $g$ whose powers $g^0,\ldots,g^{p-2}$ are **all distinct** — they hit every nonzero residue $1,\ldots,p-1$.

![Generator example: p=11, g=2 produces powers 1,2,4,8,5,10,9,7,3,6 — all ten nonzero residues appear, so 2 is a generator mod 11](/img/dsa/B--VP2MLI5s/frame-00310.png)

- **Not every number qualifies:** mod 7, $g=2$ gives $1,2,4,1,\ldots$ — period 3, not 6. So 2 is not a generator mod 7.
- **Finding one:** generators are plentiful, but there is no known efficient constructive formula — pick random $g$ and **test** it; with good probability it works.
- **Fast test.** Checking all $p-1$ powers is too slow. A shorter period must be a proper divisor of $p-1$, and every such divisor divides $(p-1)/q$ for some **prime** factor $q$ of $p-1$. So $g$ is a generator **iff** for every prime factor $q$ of $p-1$:

$$
g^{(p-1)/q} \not\equiv 1 \pmod p.
$$

Since $p-1$ has at most $\log_2 p$ distinct prime factors, this is only $O(\log p)$ exponentiations.

```cpp
// Test whether g is a primitive root mod prime p.
// prime_factors = the DISTINCT prime factors of p-1.
bool is_generator(ll g, ll p, const vector<ll>& prime_factors) {
    for (ll q : prime_factors)
        if (modpow(g, (p - 1) / q, p) == 1) return false;  // period too short
    return true;
}
```

![Generator check for p=61 (p−1=60 = 2²·3·5): it suffices to test the powers (p−1)/q for the prime factors q of 2, 3, 5, i.e. exponents 30, 20, 12](/img/dsa/B--VP2MLI5s/frame-00350.png)

- **Catch.** You must know the prime factorization of $p-1$ — which needs factorization, itself hard. So this works cleanly only for primes $p$ where $p-1$ factors nicely.

[watch from 73:46](https://youtu.be/B--VP2MLI5s?t=4426)

---

## Factorization: trial division and Pollard's rho

- **Problem.** Given composite $n$, find any nontrivial divisor (then recurse). No polynomial-time algorithm is known — modern cryptography relies on this being hard.
- **Trial division.** Test divisors up to $\sqrt n$: $O(\sqrt n)$.
- **Pollard's rho** does it in about $O(n^{1/4})$. Iterate a pseudo-random map $f(x) = (x^2 + 1) \bmod n$ from a seed $x_0$, producing $x_0, x_1=f(x_0), x_2=f(x_1),\ldots$ Being effectively random, this sequence enters a cycle after about $\sqrt n$ steps (**birthday paradox**: $\sqrt n$ values give $\approx n$ pairs, so a collision is likely).

![Pollard-rho setup: target O(fourth root of n); the map f(x)=(x²+1) mod n; the iterate sequence forms a rho-shaped cycle of length about √n; y_i = x_i mod p](/img/dsa/B--VP2MLI5s/frame-00395.png)

- **The trick.** Let $p \le \sqrt n$ be an unknown prime factor. The values $y_i = x_i \bmod p$ cycle after only $\approx \sqrt p \le n^{1/4}$ steps. So there exist $i,j$ with $x_i \equiv x_j \pmod p$, i.e. $p \mid (x_i - x_j)$ while (usually) $x_i \neq x_j$ mod $n$. Then $\gcd(x_i - x_j,\ n)$ is a nontrivial factor of $n$.
- **Finding the collision without knowing $p$:** Floyd's two-pointer — advance one pointer by one step and the other by two ($x_i$ vs $x_{2i}$). When the index gap becomes a multiple of the hidden period, $\gcd(\lvert x_i - x_{2i}\rvert, n)$ reveals a factor.

![Pollard-rho detection: x_i ≡ x_j (mod p) gives (x_i − x_j) ≡ 0 (mod p); computing gcd(x_i − x_j, n) yields a factor; the cycle length ~√p ≤ ⁴√n](/img/dsa/B--VP2MLI5s/frame-00415.png)

```cpp
// Pollard's rho: returns a nontrivial divisor of n (n composite, odd).
// Returns -1 on the unlucky case gcd = n (retry with new seed/constant).
ll pollard(ll n) {
    if (n % 2 == 0) return 2;
    ll x = rand() % (n - 2) + 2, y = x, c = rand() % (n - 1) + 1, d = 1;
    while (d == 1) {
        x = ((lll)x * x + c) % n;              // one step
        y = ((lll)y * y + c) % n;              // two steps
        y = ((lll)y * y + c) % n;
        d = gcd_rec(llabs(x - y), n);          // shared factor with n?
    }
    return d == n ? -1 : d;
}
```

- **Bad case.** If the sequence cycles mod $n$ itself, $\gcd$ returns $n$ — restart with a different seed or constant $c$.

[watch from 90:49](https://youtu.be/B--VP2MLI5s?t=5449)

---

## Complexity recap

| Operation | Time | Space | Notes |
| --- | --- | --- | --- |
| Euclid gcd | $O(\log(a+b))$ big-int ops | $O(\log)$ stack | each 2 steps halve $a$ |
| Binary gcd | $O(\log^2 n)$ bit ops | $O(1)$ | shifts instead of remainder |
| Extended Euclid | $O(\log(a+b))$ | $O(\log)$ | gives $ax+by=\gcd$ |
| Modular inverse | $O(\log n)$ | $O(1)$ | needs $\gcd(a,n)=1$ |
| Modular exponentiation | $O(\log e)$ mults | $O(1)$ | repeated squaring |
| Sieve of Eratosthenes | $O(n\log\log n)$ | $O(n)$ | all primes $\le n$ |
| Linear sieve | $O(n)$ | $O(n)$ | smallest-prime-factor table |
| Euler totient (one $n$) | $O(\sqrt n)$ | $O(1)$ | trial-factor $n$ |
| CRT (two moduli) | $O(\log)$ | $O(1)$ | one Diophantine solve |
| Miller-Rabin ($t$ rounds) | $O(t\log^3 n)$ | $O(1)$ | error $\le 4^{-t}$ |
| Pollard's rho | $\approx O(n^{1/4})$ expected | $O(1)$ | randomized |

---

## Practice problems

Number theory is interview-relevant (gcd, sieve, modpow) and a competitive-programming staple.

**🎯 Interview (MAANG-style)**

- [Greatest Common Divisor of Strings — LeetCode 1071](https://leetcode.com/problems/greatest-common-divisor-of-strings/) — Easy — gcd of lengths tells you the repeating unit.
- [Super Pow — LeetCode 372](https://leetcode.com/problems/super-pow/) — Medium — fast modular exponentiation with the exponent given as digits.
- [Count Primes — LeetCode 204](https://leetcode.com/problems/count-primes/) — Medium — direct sieve of Eratosthenes.
- [Check If It Is a Good Array — LeetCode 1250](https://leetcode.com/problems/check-if-it-is-a-good-array/) — Hard — Bezout: a subset sums to 1 iff the overall gcd is 1.
- [Number of Subarrays With GCD Equal to K — LeetCode 2447](https://leetcode.com/problems/number-of-subarrays-with-gcd-equal-to-k/) — Medium — rolling gcd over subarrays.
- [Modular Exponentiation — GeeksforGeeks](https://www.geeksforgeeks.org/modular-exponentiation-power-in-modular-arithmetic/) — Easy — the repeated-squaring primitive.
- [Sieve of Eratosthenes — GeeksforGeeks](https://www.geeksforgeeks.org/sieve-of-eratosthenes/) — Easy — canonical prime-listing.

**🏆 Competitive**

- [Exponentiation — CSES 1095](https://cses.fi/problemset/task/1095) — Easy — modpow, the $10^9+7$ warm-up.
- [Exponentiation II — CSES 1712](https://cses.fi/problemset/task/1712) — Medium — tower $a^{b^c}$; reduce the exponent mod $p-1$ via Fermat.
- [Common Divisors — CSES 1081](https://cses.fi/problemset/task/1081) — Medium — largest gcd over all pairs, via divisor counting.
- [Counting Divisors — CSES 1713](https://cses.fi/problemset/task/1713) — Easy — factorize each query with a precomputed prime list.
- [Divisor Analysis — CSES 2182](https://cses.fi/problemset/task/2182) — Medium — number/sum/product of divisors from a prime factorization, all mod $p$ (needs modular inverse).

---

## Further reading

- [Euclidean algorithm — cp-algorithms](https://cp-algorithms.com/algebra/euclid-algorithm.html) and [Extended Euclid](https://cp-algorithms.com/algebra/extended-euclid-algorithm.html).
- [Binary exponentiation — cp-algorithms](https://cp-algorithms.com/algebra/binary-exp.html) and [Modular inverse](https://cp-algorithms.com/algebra/module-inverse.html).
- [Sieve of Eratosthenes — cp-algorithms](https://cp-algorithms.com/algebra/sieve-of-eratosthenes.html) and [Euler's totient](https://cp-algorithms.com/algebra/phi-function.html).
- [Chinese Remainder Theorem — cp-algorithms](https://cp-algorithms.com/algebra/chinese-remainder-theorem.html), [Primality tests](https://cp-algorithms.com/algebra/primality_tests.html), [Integer factorization](https://cp-algorithms.com/algebra/factorization.html).
- [Euclidean algorithm — Wikipedia](https://en.wikipedia.org/wiki/Euclidean_algorithm), [Chinese remainder theorem](https://en.wikipedia.org/wiki/Chinese_remainder_theorem), [Euler's theorem](https://en.wikipedia.org/wiki/Euler%27s_theorem), [Miller-Rabin test](https://en.wikipedia.org/wiki/Miller%E2%80%93Rabin_primality_test).
- [Euclidean algorithms — GeeksforGeeks](https://www.geeksforgeeks.org/euclidean-algorithms-basic-and-extended/), [Euler's totient](https://www.geeksforgeeks.org/eulers-totient-function/), [Chinese Remainder Theorem](https://www.geeksforgeeks.org/chinese-remainder-theorem-set-1-introduction/).

---

## Key takeaways

- **One lemma powers everything:** $(a,b)$ and $(b, a\bmod b)$ share their common divisors — that is Euclid, and its extended form threads a linear combination through the recursion to solve $ax+by=d$.
- **Diophantine solvability rule:** $ax+by=c$ is solvable iff $\gcd(a,b)\mid c$; the same rule tells you when a modular inverse exists ($\gcd(b,n)=1$) and when CRT reconstruction works.
- **Complexity in number theory is measured in $\log n$ (bit length), not $n$** — so $O(\sqrt n)$ trial division is exponential and unusable for big cryptographic numbers.
- **Euler/Fermat** ($a^{\varphi(n)}\equiv 1$, $a^{p-1}\equiv 1$) underlie the Fermat test; **Miller-Rabin** patches its Carmichael blind spot with the square-root-of-1 check.
- **Randomization is normal here:** Miller-Rabin, generator search, and Pollard's rho all "pick random and hope," with provable success probabilities.

## Glossary

- **gcd** — greatest common divisor; the largest integer dividing both inputs.
- **Diophantine equation** — a polynomial equation solved over the integers; here linear, $ax+by=c$.
- **Modular inverse** — $b^{-1}$ with $b\,b^{-1}\equiv 1 \pmod n$; exists iff $\gcd(b,n)=1$.
- **Euler's totient $\varphi(n)$** — count of integers in $0\ldots n-1$ coprime to $n$.
- **Coprime** — two numbers with $\gcd=1$ (no common factor besides 1).
- **Carmichael number** — a composite that passes the Fermat test for every coprime base.
- **Generator / primitive root** — a residue whose powers cover all nonzero residues mod a prime.
- **Witness / liar** — a base that (respectively) proves compositeness or fails to in Miller-Rabin.
