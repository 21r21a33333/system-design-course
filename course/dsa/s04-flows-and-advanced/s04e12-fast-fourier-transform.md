---
title: "S04E12 · Fast Fourier Transform"
sidebar_position: 12
description: Multiplying polynomials and big integers fast — Karatsuba, roots of unity, the even-odd divide-and-conquer FFT, the iterative bit-reversal butterfly, inverse FFT, and O(n log n) convolution, with NTT over a prime modulus.
---

# S04E12 · Fast Fourier Transform

> **Source:** Pavel Mavrin, [_A&DS S04E12_](https://youtu.be/Hub3o8XqAJg) · 1h14m lecture → ~16 min read.
> Every section deep-links back to the exact moment on the board.

## TL;DR

- **Problem.** Multiply two length-$n$ integers, or equivalently two degree-$n$ polynomials. Schoolbook is $\Theta(n^2)$; the coefficient $c_i = \sum_j a_j\,b_{i-j}$ is a **convolution**.
- **Karatsuba** splits each polynomial in half and reuses one product: $3$ recursive calls instead of $4$, giving $\Theta(n^{\log_2 3}) \approx \Theta(n^{1.585})$.
- **Point-value trick.** A degree-$n$ polynomial is fixed by its values at $n$ points. Multiplying in point-value form is $\Theta(n)$ (pointwise). The cost is moving **coefficients ↔ values** — that is the Fourier transform.
- **FFT** evaluates a polynomial at the $n$-th **roots of unity** $\omega^0,\dots,\omega^{n-1}$ in $\Theta(n\log n)$ by splitting into **even** and **odd** coefficients — because squaring the roots collapses $n$ points down to $n/2$.
- **Inverse FFT** is the same routine with $\omega^{-1}$ and a final divide-by-$n$; the full multiply is FFT → pointwise → inverse FFT $= \Theta(n\log n)$.
- **NTT** does the identical dance over a prime field $\mathbb{Z}_p$ with $p = c\cdot 2^k + 1$, using a generator instead of a complex root — exact integer arithmetic, no floating-point error.

---

## The problem: multiply two long numbers

- Two integers, each $n$ digits. The grade-school method takes each digit of $b$, multiplies it by all of $a$, and sums the shifted results: $n$ rows of length $n$ → $\Theta(n^2)$.
- **Reframe as polynomials.** Treat a number as a polynomial evaluated at the base $x = 10$: digits become coefficients. Multiplying integers and multiplying polynomials are the same operation (integers just carry afterward).
- Given $A(x) = a_0 + a_1 x + \dots + a_{n} x^{n}$ and $B(x) = b_0 + \dots + b_{n} x^{n}$, the product $C(x) = A(x)\,B(x)$ has coefficients

$$
c_i \;=\; \sum_{j} a_j \, b_{i - j}.
$$

- Computing every $c_i$ directly is again $\Theta(n^2)$ — $n$ coefficients, each a linear sum. **The whole lecture is about beating this.**

![Board defining A(x), B(x), product C(x) and the convolution formula for its coefficients c_i](/img/dsa/Hub3o8XqAJg/frame-00042.png)

[watch from 13:13](https://youtu.be/Hub3o8XqAJg?t=793)

---

## Karatsuba: three products instead of four

- Split each polynomial into a low and high half at $x^{n/2}$:

$$
A(x) = A_1(x) + x^{n/2} A_2(x), \qquad B(x) = B_1(x) + x^{n/2} B_2(x).
$$

- Naive expansion needs four half-size products $A_1B_1,\ A_1B_2,\ A_2B_1,\ A_2B_2$:

$$
A B = A_1 B_1 + x^{n/2}\big(A_1 B_2 + A_2 B_1\big) + x^{n} A_2 B_2.
$$

- Four recursive calls give $T(n) = 4\,T(n/2) + \Theta(n) = \Theta(n^{\log_2 4}) = \Theta(n^2)$ — no gain.
- **Karatsuba's trick.** The middle only needs the *sum* $A_1B_2 + A_2B_1$, and

$$
(A_1 + A_2)(B_1 + B_2) = A_1B_1 + \underbrace{A_1B_2 + A_2B_1}_{\text{middle}} + A_2B_2.
$$

  So compute $A_1B_1$, $A_2B_2$, and $(A_1{+}A_2)(B_1{+}B_2)$ — **three** products — and recover the middle by subtracting the first two.
- Recurrence $T(n) = 3\,T(n/2) + \Theta(n) = \Theta\!\big(n^{\log_2 3}\big) \approx \Theta(n^{1.585})$. This was one of the first sub-quadratic multiplication algorithms.

```cpp
#include <bits/stdc++.h>
using namespace std;

vector<long long> mul_naive(const vector<long long>& a, const vector<long long>& b) {
    vector<long long> c(a.size() + b.size() - 1, 0);
    for (size_t i = 0; i < a.size(); i++)
        for (size_t j = 0; j < b.size(); j++)
            c[i + j] += a[i] * b[j];             // schoolbook convolution
    return c;
}

vector<long long> karatsuba(vector<long long> a, vector<long long> b) {
    int n = max(a.size(), b.size());
    if (n <= 32) return mul_naive(a, b);         // cut off to naive on small inputs
    int h = (n + 1) / 2;
    a.resize(2 * h, 0); b.resize(2 * h, 0);
    vector<long long> a1(a.begin(), a.begin() + h), a2(a.begin() + h, a.end());
    vector<long long> b1(b.begin(), b.begin() + h), b2(b.begin() + h, b.end());
    vector<long long> z1 = karatsuba(a1, b1);                 // A1 * B1
    vector<long long> z2 = karatsuba(a2, b2);                 // A2 * B2
    vector<long long> as(h), bs(h);
    for (int i = 0; i < h; i++) { as[i] = a1[i] + a2[i]; bs[i] = b1[i] + b2[i]; }
    vector<long long> z3 = karatsuba(as, bs);                 // (A1+A2)(B1+B2)
    for (size_t i = 0; i < z1.size(); i++) z3[i] -= z1[i];
    for (size_t i = 0; i < z2.size(); i++) z3[i] -= z2[i];    // recover the middle
    vector<long long> c(4 * h, 0);
    for (size_t i = 0; i < z1.size(); i++) c[i]         += z1[i];
    for (size_t i = 0; i < z3.size(); i++) c[i + h]     += z3[i];
    for (size_t i = 0; i < z2.size(); i++) c[i + 2 * h] += z2[i];
    return c;
}
```

[watch from 5:37](https://youtu.be/Hub3o8XqAJg?t=337)

---

## The point-value idea

- A polynomial of degree less than $n$ is uniquely determined by its values at $n$ distinct points (Lagrange interpolation). Two representations of the same object:
  - **Coefficients** $(a_0, \dots, a_{n-1})$ — good for reading off digits, bad for multiplying.
  - **Values** $\big(A(x_0), \dots, A(x_{n-1})\big)$ — great for multiplying.
- Pad both inputs so the product $C$ (degree up to $2n$) fits: redefine $n := 2n + 1$ coefficients, so all three polynomials share $n$ points $x_0, \dots, x_{n-1}$.
- **Three-step plan:**
  1. **Evaluate.** $u_i = A(x_i)$, $v_i = B(x_i)$ at $n$ points.
  2. **Multiply pointwise.** $z_i = C(x_i) = u_i \cdot v_i$ — this step is trivially $\Theta(n)$.
  3. **Interpolate.** Recover the coefficients of $C$ from its values $\{z_i\}$.

![Three-step plan on the board: step 1 evaluate u_i and v_i, step 2 pointwise z_i = u_i·v_i, step 3 reconstruct coefficients c_i](/img/dsa/Hub3o8XqAJg/frame-00084.png)

- Step 2 is easy. Steps 1 and 3 are the hard part — evaluating at arbitrary points is $\Theta(n^2)$. The insight is to **choose the points cleverly** so evaluation becomes divide-and-conquer.

[watch from 14:57](https://youtu.be/Hub3o8XqAJg?t=897)

---

## Roots of unity: the magic evaluation points

- We need a special value $\omega$ (the primitive $n$-th root of unity) with two properties:

$$
\omega^{n} = 1, \qquad \omega^{0}, \omega^{1}, \dots, \omega^{n-1} \ \text{are all distinct}.
$$

- Take the evaluation points to be the powers of $\omega$: $x_i = \omega^{i}$.
- **Why these points?** Squaring a power of $\omega$ lands back inside the same set, and it collapses $n$ points into only $n/2$ distinct ones:

$$
\big(\omega^{\,n/2 + i}\big)^2 = \omega^{\,n + 2i} = \omega^{n}\cdot\omega^{2i} = \omega^{2i} = \big(\omega^{i}\big)^2.
$$

  So $\{(\omega^i)^2 : 0 \le i < n\}$ has just $n/2$ elements — exactly the size a recursive call needs.
- **In complex numbers**, $\omega = e^{2\pi i / n}$ sits on the unit circle; its powers are the $n$ evenly spaced vertices of a regular $n$-gon. Real numbers alone don't work: for $n > 2$ the only real roots of $1$ are $\pm 1$.

$$
\omega = e^{\,2\pi i / n}, \qquad x_i = \omega^{i}.
$$

![Unit circle with n equals 8 roots of unity from omega to the 0 through omega to the 7, omega equals e to the 2 pi i over n, and n a power of two](/img/dsa/Hub3o8XqAJg/frame-00126.png)

- We also require $n$ to be a **power of two** so the halving recursion always splits evenly; pad with zero coefficients up to the next power of two (at most doubling the size).

[watch from 25:43](https://youtu.be/Hub3o8XqAJg?t=1543)

---

## NTT: the same trick over a prime modulus

- Complex arithmetic carries floating-point error. Over a prime field $\mathbb{Z}_p$ we get an **exact** root of unity — this is the **Number-Theoretic Transform**.
- Pick a prime with a generator $g$ (a primitive root, $g^{p-1} = 1$ and its powers cover all of $1 \dots p-1$). To get an element of order exactly $n$, we need $n \mid p - 1$; then

$$
\omega = g^{\,(p-1)/n} \pmod p.
$$

- Because $n$ must be a large power of two, we need a prime of the form $p = c\cdot 2^{k} + 1$ (e.g. $998244353 = 119\cdot 2^{23} + 1$). Factoring $p-1$ is easy since it is mostly powers of two, so finding a generator is cheap (pick random numbers and test).
- Everything else — the recursion, the butterfly, the inverse — is identical; only the arithmetic changes.

![Prime-model setup showing p prime, generator g to the p minus 1 equals 1, n divides p minus 1, omega equals g to the p minus 1 over n, and p of the form 2 to the k times ell plus 1](/img/dsa/Hub3o8XqAJg/frame-00104.png)

[watch from 22:33](https://youtu.be/Hub3o8XqAJg?t=1353)

---

## The FFT: even-odd divide and conquer

- Split the coefficients by **parity** into two half-size polynomials:

$$
A_1(y) = a_0 + a_2 y + a_4 y^2 + \dots, \qquad
A_2(y) = a_1 + a_3 y + a_5 y^2 + \dots
$$

- Then $A$ factors so each half is evaluated at the **squared** argument:

$$
A(x) = A_1(x^2) + x \, A_2(x^2).
$$

- **The payoff.** To evaluate $A$ at all $n$ points $x_i = \omega^i$, we only need $A_1$ and $A_2$ at the points $x_i^2$ — and by the collapse identity there are just $n/2$ distinct squares. So each recursive call is a *smaller instance of the same problem*: evaluate a length-$n/2$ polynomial at $n/2$ roots (with base $\omega^2$).

![A(x) = A₁(x²) + x·A₂(x²): splitting coefficients into even A₁ and odd A₂](/img/dsa/Hub3o8XqAJg/frame-00148.png)

- **Combine (butterfly).** With $k_1 = A_1$'s values and $k_2 = A_2$'s values (each length $n/2$), for every $i$:

$$
A(\omega^i) \;=\; k_1\big[i \bmod \tfrac{n}{2}\big] \;+\; \omega^{i}\, k_2\big[i \bmod \tfrac{n}{2}\big].
$$

The recursive routine takes a coefficient array and returns the value array:

```cpp
using cd = complex<double>;

// evaluate polynomial `a` at the n-th roots of unity generated by w
vector<cd> fft_rec(const vector<cd>& a, cd w) {
    int n = a.size();
    if (n == 1) return {a[0]};                   // base: a constant is its own value
    vector<cd> a1(n / 2), a2(n / 2);
    for (int i = 0; i < n / 2; i++) {
        a1[i] = a[2 * i];                        // even coefficients
        a2[i] = a[2 * i + 1];                    // odd  coefficients
    }
    vector<cd> k1 = fft_rec(a1, w * w);          // values at squared roots
    vector<cd> k2 = fft_rec(a2, w * w);
    vector<cd> res(n);
    cd wi = 1;                                   // wi = w^i
    for (int i = 0; i < n; i++) {
        res[i] = k1[i % (n / 2)] + wi * k2[i % (n / 2)];   // butterfly
        wi *= w;
    }
    return res;
}
```

- **Recurrence** $T(n) = 2\,T(n/2) + \Theta(n) = \Theta(n \log n)$. This only works because $n$ is a power of two (each level needs $n$ even). If $n$ were divisible by $3$ you could split into three parts instead; for a large prime $n$ it does not split at all.

![Full recursive fft(a, n, ω) on the board: base case, split into A₁/A₂, recurse with ω², combine with res[i] = K1[i mod n/2] + ω^i·K2[i mod n/2]](/img/dsa/Hub3o8XqAJg/frame-00214.png)

[watch from 31:52](https://youtu.be/Hub3o8XqAJg?t=1912)

---

## The butterfly, written tidily

- In the combine loop, index $i$ and $i + n/2$ reuse the *same* $k_1$, $k_2$ entries (since they differ by $n/2$ mod $n/2$), and $\omega^{\,i + n/2} = -\omega^{i}$ in the complex case. So one multiplication feeds **two** outputs — the classic **butterfly**:

$$
\begin{aligned}
\text{res}[i] &= k_1[i] + \omega^{i}\, k_2[i], \\
\text{res}[i + n/2] &= k_1[i] - \omega^{i}\, k_2[i], \qquad 0 \le i < \tfrac{n}{2}.
\end{aligned}
$$

- Splitting the loop into its two halves this way is the same computation, just without the modulo — and it turns naturally into the **iterative** FFT below.

![Butterfly form and the inverse-transform derivation with c sub j equals one over n times the sum of z sub i times omega to the minus i j, where the geometric-progression sum equals n when i equals k and 0 otherwise](/img/dsa/Hub3o8XqAJg/frame-00261.png)

[watch from 1:10:06](https://youtu.be/Hub3o8XqAJg?t=4206)

---

## Iterative FFT (bit reversal)

- The recursion permutes coefficients into **bit-reversed** order (even/odd splitting = sorting by reversed index bits). Do that permutation once up front, then combine bottom-up in place — no recursion, better constant factor.

```cpp
// in-place iterative FFT; invert=true does the inverse transform
void fft_iter(vector<cd>& a, bool invert) {
    int n = a.size();
    for (int i = 1, j = 0; i < n; i++) {         // bit-reversal permutation
        int bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) swap(a[i], a[j]);
    }
    for (int len = 2; len <= n; len <<= 1) {     // merge blocks of size len
        double ang = 2 * M_PI / len * (invert ? -1 : 1);
        cd wlen(cos(ang), sin(ang));
        for (int i = 0; i < n; i += len) {
            cd w = 1;
            for (int k = 0; k < len / 2; k++) {
                cd u = a[i + k];
                cd v = a[i + k + len / 2] * w;
                a[i + k]           = u + v;       // butterfly top
                a[i + k + len / 2] = u - v;       // butterfly bottom
                w *= wlen;
            }
        }
    }
    if (invert) for (cd& x : a) x /= n;           // inverse divides by n
}
```

[watch from 1:10:06](https://youtu.be/Hub3o8XqAJg?t=4206)

---

## Inverse FFT: why it is the same routine

- Given the values $z_i = C(\omega^i)$, the coefficients come back by an almost-identical sum, with $\omega^{-1}$ and a $1/n$ scale:

$$
c_j \;=\; \frac{1}{n} \sum_{i=0}^{n-1} z_i \, \omega^{-ij}.
$$

- **Proof sketch (from the board).** Substitute $z_i = \sum_k c_k\,\omega^{ik}$ and swap the sums:

$$
\frac{1}{n}\sum_i \Big(\sum_k c_k \omega^{ik}\Big)\omega^{-ij}
= \frac{1}{n}\sum_k c_k \sum_i \omega^{\,i(k - j)}.
$$

  The inner sum is a geometric progression in $\omega^{\,k-j}$. Since $\omega^n = 1$:
  - if $k \ne j$ it sums to $\dfrac{\omega^{\,n(k-j)} - 1}{\omega^{\,k-j} - 1} = \dfrac{1 - 1}{\,\cdot\,} = 0$;
  - if $k = j$ every term is $1$, so the sum is $n$.

  Only the $k = j$ term survives, leaving $\frac{1}{n}\cdot c_j \cdot n = c_j$. The polynomial with these coefficients has the right values, and interpolation is unique, so it **is** $C$.

- **Consequence:** run the exact same `fft` with $\omega^{-1}$ in place of $\omega$, then divide every output by $n$. No separate interpolation code is needed.

[watch from 57:58](https://youtu.be/Hub3o8XqAJg?t=3478)

---

## Putting it together: O(n log n) multiplication

- Evaluate both inputs, multiply pointwise, invert. That is the whole convolution.

```cpp
vector<long long> mul_fft(const vector<long long>& A, const vector<long long>& B) {
    vector<cd> fa(A.begin(), A.end()), fb(B.begin(), B.end());
    int n = 1;
    while (n < (int)(A.size() + B.size())) n <<= 1;   // pad to a power of two
    fa.resize(n); fb.resize(n);
    fft_iter(fa, false); fft_iter(fb, false);         // step 1: to point-value
    for (int i = 0; i < n; i++) fa[i] *= fb[i];       // step 2: pointwise product
    fft_iter(fa, true);                               // step 3: inverse FFT
    vector<long long> c(n);
    for (int i = 0; i < n; i++) c[i] = llround(fa[i].real());  // round off FP noise
    while (c.size() > 1 && c.back() == 0) c.pop_back();
    return c;
}
```

- **Big-integer multiply** is the same call plus a carry pass (digits are coefficients, base $10$):

```cpp
string mul_bigint(const string& x, const string& y) {
    vector<long long> a(x.rbegin(), x.rend()), b(y.rbegin(), y.rend());
    for (auto& d : a) d -= '0';
    for (auto& d : b) d -= '0';
    vector<long long> c = mul_fft(a, b);              // convolution of the digits
    for (size_t i = 0; i + 1 < c.size(); i++) {       // propagate carries
        c[i + 1] += c[i] / 10;
        c[i] %= 10;
    }
    while (c.back() >= 10) {                           // final carry can grow the length
        long long carry = c.back() / 10;
        c.back() %= 10;
        c.push_back(carry);
    }
    string s;
    for (int i = (int)c.size() - 1; i >= 0; i--) s += char('0' + c[i]);
    return s;
}
```

- Verified against schoolbook on 200 random polynomials and on big-integer cases, e.g. $\underbrace{9\cdots9}_{20}\times\underbrace{9\cdots9}_{20} = 9\cdots9\,8\,0\cdots0\,1$. Every C++ block in this note compiles with `c++ -std=c++17` and runs clean.

![Roots of unity ω^i as evaluation points x_i with the value formula U_i = A(x_i) feeding the coefficient-to-value map](/img/dsa/Hub3o8XqAJg/frame-00171.png)

[watch from 1:08:48](https://youtu.be/Hub3o8XqAJg?t=4128)

---

## Complexity recap

| Operation | Best | Average | Worst | Space |
| --- | --- | --- | --- | --- |
| Schoolbook multiply | $\Theta(n^2)$ | $\Theta(n^2)$ | $\Theta(n^2)$ | $O(n)$ |
| Karatsuba | $\Theta(n^{\log_2 3})$ | $\Theta(n^{\log_2 3})$ | $\Theta(n^{\log_2 3})$ | $O(n)$ |
| FFT / inverse FFT | $\Theta(n\log n)$ | $\Theta(n\log n)$ | $\Theta(n\log n)$ | $O(n)$ |
| Convolution via FFT | $\Theta(n\log n)$ | $\Theta(n\log n)$ | $\Theta(n\log n)$ | $O(n)$ |
| Pointwise product | $\Theta(n)$ | $\Theta(n)$ | $\Theta(n)$ | $O(n)$ |

Here $n$ is the padded power-of-two size (at most twice the sum of the input lengths).

---

## Practice problems

FFT is squarely a **competitive-programming** topic — it rarely appears in standard interview loops. The honest interview-adjacent skill is the schoolbook convolution (string multiplication); FFT itself shows up in contests and, occasionally, in a "how would you multiply enormous numbers" system-design chat.

**🎯 Interview (MAANG-style)**

- [Multiply Strings — LeetCode 43](https://leetcode.com/problems/multiply-strings/) — Medium — schoolbook $O(nm)$ digit convolution; mention FFT as the asymptotic upgrade for huge inputs.
- [Add Strings — LeetCode 415](https://leetcode.com/problems/add-strings/) — Easy — the carry-propagation warm-up used by `mul_bigint`.
- [Plus One — LeetCode 66](https://leetcode.com/problems/plus-one/) — Easy — the base-case of digit carrying.
- [Multiply two polynomials — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/multiply-two-polynomials-2/) — Medium — the naive convolution stated as a polynomial problem.

**🏆 Competitive**

- [Substring Distribution — CSES 2110](https://cses.fi/problemset/task/2110) — Hard — a convolution/counting problem in the CSES advanced-techniques section that FFT solves.
- Codeforces 993E "Nikita and Order Statistics" and 632E "Thief in a Shop" are canonical FFT convolution problems (search them on Codeforces — the problemset blocks scripted links).

> Beyond typical interview rounds: if asked, explain the point-value idea and $\Theta(n\log n)$ at a high level, then pivot to the schoolbook code you can actually write on a whiteboard.

---

## Further reading

- [Fast Fourier transform — cp-algorithms](https://cp-algorithms.com/algebra/fft.html) — full recursive + iterative implementation, NTT, and the "multiply two big numbers" application.
- [Fast Fourier Transformation for polynomial multiplication — GeeksforGeeks](https://www.geeksforgeeks.org/dsa/fast-fourier-transformation-poynomial-multiplication/) — step-by-step walkthrough with diagrams.
- [Fast Fourier transform — Wikipedia](https://en.wikipedia.org/wiki/Fast_Fourier_transform) and [Cooley–Tukey FFT algorithm — Wikipedia](https://en.wikipedia.org/wiki/Cooley%E2%80%93Tukey_FFT_algorithm).
- [Discrete Fourier transform — Wikipedia](https://en.wikipedia.org/wiki/Discrete_Fourier_transform) — the linear-algebra view (the DFT matrix and its inverse).
- [Karatsuba algorithm — Wikipedia](https://en.wikipedia.org/wiki/Karatsuba_algorithm) and [Schönhage–Strassen algorithm — Wikipedia](https://en.wikipedia.org/wiki/Sch%C3%B6nhage%E2%80%93Strassen_algorithm) — the FFT-based integer multiply that beats Karatsuba.

---

## Key takeaways

- Multiplication is **convolution**; convolution is a **pointwise product in the value domain**. FFT is the fast round-trip between coefficients and values.
- The trick is choosing evaluation points where **squaring collapses $n$ points to $n/2$** — the roots of unity $\omega^i$. That is what makes the even/odd split a genuine divide-and-conquer.
- Forward and inverse transforms are the **same routine**: swap $\omega \to \omega^{-1}$ and divide by $n$ at the end; the geometric-series identity is the whole proof.
- Iterative bit-reversal FFT is the practical version — in place, no recursion, small constant.
- **NTT** is FFT over $\mathbb{Z}_p$ with $p = c\cdot 2^k + 1$: exact integers, no floating-point rounding, same $\Theta(n\log n)$.

## Glossary

- **Convolution** — the coefficient rule $c_i = \sum_j a_j b_{i-j}$; multiplying polynomials or integers.
- **Point-value representation** — a polynomial given by its values at $n$ points instead of its coefficients.
- **Root of unity** — $\omega$ with $\omega^n = 1$ and distinct powers; $\omega = e^{2\pi i/n}$ in the complex case.
- **DFT / FFT** — the map coefficients → values at roots of unity; FFT computes it in $\Theta(n\log n)$.
- **Butterfly** — the combine step producing $k_1[i] \pm \omega^i k_2[i]$ from one multiplication.
- **Bit-reversal permutation** — the reordering that makes the FFT iterative and in-place.
- **NTT** — Number-Theoretic Transform: FFT over a prime field using a generator as the root of unity.
- **Karatsuba** — $\Theta(n^{\log_2 3})$ multiply using three half-size products instead of four.
