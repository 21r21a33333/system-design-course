---
title: "S04E11 · Basic Cryptography Algorithms"
sidebar_position: 11
description: How number theory becomes cryptography — the XOR one-time pad, one-way functions, RSA key generation and its Euler-theorem correctness proof, Diffie-Hellman and ElGamal over the discrete log, digital signatures, and modular exponentiation as the shared workhorse.
---

# S04E11 · Basic Cryptography Algorithms

> **Source:** Pavel Mavrin, [_A&DS S04E11_](https://youtu.be/cMoVVK8Aw0I) · 1h20m lecture → ~16 min read.
> Every section deep-links back to the exact moment on the board. This is an *applied* lecture: it shows how last week's number theory (primes, Euler's $\varphi$, modular inverses, fast exponentiation) turns into real ciphers.

## TL;DR

- **Symmetric baseline:** if Alice and Bob share a random key $k$ as long as the message, then $m' = m \oplus k$ is a **one-time pad** — perfectly secret, but the key is single-use and must be shared in advance.
- **Public-key crypto** replaces the shared secret with a **pair** of keys: encrypt with the public key, decrypt with the private one. It rests on a **one-way function** — easy to compute, infeasible to invert.
- Two one-way functions power this lecture: **integer multiplication** ($p,q \mapsto n = pq$, inverting means factoring) and **modular exponentiation** ($x \mapsto g^x \bmod p$, inverting means the discrete logarithm).
- **RSA:** pick primes $p,q$, set $n = pq$ and $\varphi(n) = (p-1)(q-1)$, choose $e \perp \varphi(n)$, compute $d = e^{-1} \bmod \varphi(n)$. Encrypt $c = m^e \bmod n$, decrypt $m = c^d \bmod n$. Correctness is **Euler's theorem**.
- **Diffie-Hellman** builds a shared key with two messages: $A = g^x$, $B = g^y$, both sides reach $g^{xy}$. **ElGamal** turns the same idea into an encryption scheme. **Digital signatures** run RSA "backwards": sign with the private key, verify with the public one.
- **Modular exponentiation** (binary exponentiation) is the workhorse under all of it — and its *timing* leaks bits of the private key, a real **side-channel attack**.

---

## Cryptography: the setup and the one-time pad

- Two people — **Alice** ($A$) and **Bob** ($B$) — exchange messages over a public network (the internet). The message hops through intermediate nodes where an **attacker** $M$ (traditionally "Eve" or "Mallory") can read everything.
- Plain HTTP is plaintext: anyone sniffing packets on the path sees the content. To stop this you **encrypt**.
- **The simplest cipher (XOR one-time pad).** A message is a bit string $m$. Suppose $A$ and $B$ both hold the same secret random key $k$ of the **same length** $n$ as the message.
  - Encrypt: $m' = m \oplus k$ (bitwise XOR), send $m'$ over the open network.
  - Decrypt: $m = m' \oplus k$, because $(m \oplus k) \oplus k = m$.

![XOR one-time pad on the board: message m, key k, cipher m prime equals m XOR k](/img/dsa/cMoVVK8Aw0I/frame-00024.png)

- **Why it is secure (for one use).** If $k$ is uniformly random, then $m \oplus k$ is a uniformly random bit string: every bit is $0$ or $1$ with equal probability regardless of $m$. The attacker learns *nothing*.

```cpp
#include <bits/stdc++.h>
using namespace std;

// one-time pad: encrypt and decrypt are the SAME operation (XOR with k)
vector<uint8_t> xor_pad(const vector<uint8_t>& data, const vector<uint8_t>& key) {
    // key must be at least as long as data (one-time pad requirement)
    vector<uint8_t> out(data.size());
    for (size_t i = 0; i < data.size(); i++) out[i] = data[i] ^ key[i];
    return out;
}
```

- **Two fatal problems.**
  1. **Key distribution.** $A$ and $B$ must already share $k$ over a *secure* channel — but if they had one, they would not need the cipher. This is the problem public-key crypto solves.
  2. **Single use.** Reusing $k$ leaks information. Send $m_1' = m_1 \oplus k$ and $m_2' = m_2 \oplus k$, and the attacker computes $m_1' \oplus m_2' = m_1 \oplus m_2$ — the key cancels, leaving a *relation between the plaintexts*. Frequency analysis then peels them apart. (Historically, spies who reused pads got caught exactly this way.)

[watch from 3:40](https://youtu.be/cMoVVK8Aw0I?t=220)

---

## Keystreams, generators, and block ciphers

- **Many keys.** To send many messages, share many keys $k_1, k_2, \dots, k_N$ — but this is finite; you eventually run out.
- **Infinite keystream.** Let $A$ and $B$ share the same **pseudo-random generator** (same seed, same recurrence). It emits an unbounded bit stream used as the pad. Now the pad is effectively infinite.
- **Generator flaw.** A *non-cryptographic* PRNG (seed $\to$ next value by a simple formula) is predictable: if the attacker learns a prefix of the stream — e.g. from a known file header that is always the same — they can recover the **seed** and then predict **all** future bits.
- **Fix:** use a **cryptographically secure** generator (a stream cipher), where knowing a prefix does not reveal future output.
- **Block ciphers** (AES-style) are the practical alternative: given a shared key they scramble data so no pattern survives. They are **fast** and **secure**, which is why they encrypt whole file systems, VPN tunnels, and video streams (YouTube, Twitch).
- **The remaining hard part** is not the bulk encryption — block ciphers handle that. It is **how to agree on the shared key** in the first place. That is what the rest of the lecture solves.

[watch from 12:15](https://youtu.be/cMoVVK8Aw0I?t=735)

---

## Public-key encryption and one-way functions

- **Idea.** Instead of one shared key, use a **pair**: a **public** key $k_{pub}$ and a **secret** key $k_{sec}$. Encryption and decryption are asymmetric:
  - $m' = \operatorname{encrypt}(m, k_{pub})$ — anyone can encrypt.
  - $m = \operatorname{decrypt}(m', k_{sec})$ — only the holder of $k_{sec}$ can decrypt.
- **Protocol.** Alice wants to send $m$ to Bob. Bob generates $(k_{pub}, k_{sec})$ and publishes $k_{pub}$. Alice sends $\operatorname{encrypt}(m, k_{pub})$. Bob decrypts with $k_{sec}$. The attacker sees only $k_{pub}$ and $m'$ — not enough to recover $m$.

![Open-key encryption: k_pub and k_secret, encrypt with public key, decrypt with secret key](/img/dsa/cMoVVK8Aw0I/frame-00089.png)

- **What makes it work: a one-way function** $f$ — easy to evaluate, infeasible to invert.
  - Formally, computing $f(x)$ is fast (in $P$); finding $y$ with $f(y) = x$ is hard. Note inversion is *always in $NP$* — you can guess $y$ and check $f(y) = x$ — so a true one-way function needs $P \neq NP$ (and even then, "polynomial" must not mean "fast enough to break").
  - You can never make inversion *impossible* (brute force over all inputs always works); you only make it **impractically slow**.

![One-way function f(x) easy in P, inverse hard in NP; the two examples n=pq and x maps to g^x mod p](/img/dsa/cMoVVK8Aw0I/frame-00107.png)

- **Two concrete one-way functions:**

| One-way function | Forward (easy) | Inverse (hard) |
| --- | --- | --- |
| Multiplication | $p, q \mapsto n = pq$ | factor $n$ into $p, q$ |
| Modular exponentiation | $x \mapsto g^x \bmod p$ | discrete log: recover $x$ |

  - RSA is built on the **factoring** function; Diffie-Hellman and ElGamal on the **discrete log**.

[watch from 17:59](https://youtu.be/cMoVVK8Aw0I?t=1079)

---

## RSA: key generation

The number-theory machinery from the previous lecture (primes, Euler's $\varphi$, extended Euclid for inverses) assembles directly into RSA.

1. Pick two **big random primes** $p$ and $q$ (generate a random number, test primality, repeat).
2. Compute the modulus $n = p \cdot q$.
3. Compute Euler's totient:
   $$\varphi(n) = (p-1)(q-1).$$
   - **Why:** $\varphi(n)$ counts integers in $1 \dots n$ coprime to $n$. The non-coprime ones are the multiples of $p$ (there are $q$ of them) and multiples of $q$ (there are $p$), overlapping only at $n$; inclusion-exclusion gives $n - p - q + 1 = (p-1)(q-1)$.
4. Pick a public exponent $e$ **coprime to** $\varphi(n)$ (written $e \perp \varphi(n)$). Small values like $3$ or $5$ usually work.
5. Compute the private exponent $d = e^{-1} \bmod \varphi(n)$ — the modular inverse of $e$. Solve $de \equiv 1 \pmod{\varphi(n)}$, i.e. $de + k\,\varphi(n) = 1$, with the **extended Euclidean algorithm**.
6. Publish $k_{pub} = (n, e)$; keep $k_{sec} = (n, d)$.

![RSA key generation: p,q big random primes, n=pq, phi(n)=(p-1)(q-1)](/img/dsa/cMoVVK8Aw0I/frame-00133.png)

```cpp
#include <bits/stdc++.h>
using namespace std;

// extended Euclid: returns gcd(a,b), sets x,y so that a*x + b*y = gcd
long long ext_gcd(long long a, long long b, long long &x, long long &y) {
    if (b == 0) { x = 1; y = 0; return a; }
    long long x1, y1;
    long long g = ext_gcd(b, a % b, x1, y1);
    x = y1;
    y = x1 - (a / b) * y1;
    return g;
}

// modular inverse of e mod m, assuming gcd(e,m) = 1
long long inv_mod(long long e, long long m) {
    long long x, y;
    ext_gcd(e, m, x, y);
    return ((x % m) + m) % m;   // normalize into [0, m)
}
```

- **Why keeping $d$ secret is enough.** To decrypt you need $d$. To get $d = e^{-1} \bmod \varphi(n)$ you need $\varphi(n)$. To get $\varphi(n) = (p-1)(q-1)$ you need the **factorization** of $n$. The attacker knows only $n$ and $e$ — factoring $n$ is the hard direction, so $d$ stays out of reach.

[watch from 29:48](https://youtu.be/cMoVVK8Aw0I?t=1788)

---

## RSA: encrypt, decrypt, and why it works

- A message is an integer $m \in \{1, \dots, n-1\}$ (and coprime to $n$ — almost all $m$ are, since $n$ has only two large prime factors).
- **Encrypt:** $c = m^e \bmod n$.
- **Decrypt:** $m = c^d \bmod n$.
- Both are just **modular exponentiation**, so both are fast.

**Correctness proof (Euler's theorem).** Decryption applies the two exponents in sequence:
$$
(m^e)^d = m^{ed} \pmod n.
$$
By construction $ed \equiv 1 \pmod{\varphi(n)}$, so $ed = 1 + k\,\varphi(n)$ for some integer $k$. Therefore
$$
m^{ed} = m^{\,1 + k\varphi(n)} = m \cdot \left(m^{\varphi(n)}\right)^{k}.
$$
**Euler's theorem** states $m^{\varphi(n)} \equiv 1 \pmod n$ whenever $\gcd(m, n) = 1$. Hence
$$
m^{ed} \equiv m \cdot 1^{k} \equiv m \pmod n. \qquad \blacksquare
$$

![RSA full derivation: encrypt m^e, decrypt (m^e)^d = m^(1+k phi(n)) = m times (m^phi(n))^k = m](/img/dsa/cMoVVK8Aw0I/frame-00143.png)

```cpp
#include <bits/stdc++.h>
using namespace std;

long long pow_mod(long long a, long long b, long long n);   // defined below
long long inv_mod(long long e, long long m);                // from the keygen block

struct RSA { long long n, e, d; };

RSA rsa_keygen(long long p, long long q, long long e) {
    long long n = p * q;
    long long phi = (p - 1) * (q - 1);
    long long d = inv_mod(e, phi);      // requires gcd(e, phi) = 1
    return {n, e, d};
}

long long rsa_encrypt(const RSA& k, long long m) { return pow_mod(m, k.e, k.n); }
long long rsa_decrypt(const RSA& k, long long c) { return pow_mod(c, k.d, k.n); }
```

- **Worked toy example (small primes).** $p = 61,\ q = 53 \Rightarrow n = 3233,\ \varphi(n) = 3120$. Take $e = 17 \Rightarrow d = 2753$ (since $17 \cdot 2753 = 46801 = 1 + 15 \cdot 3120$). Encrypting $m = 65$ gives $c = 65^{17} \bmod 3233 = 2790$; decrypting $2790^{2753} \bmod 3233 = 65$. Round-trip verified in C++ for every $m$ in $1 \dots 199$.

[watch from 33:04](https://youtu.be/cMoVVK8Aw0I?t=1984)

---

## Modular exponentiation: the workhorse

Every scheme above evaluates $a^b \bmod n$ for huge $b$. Naive multiplication would take $b$ steps; **binary exponentiation** takes $O(\log b)$ by squaring the base and consuming one bit of the exponent per step.

![Board code for pow(a,b): c=1, while b greater than 0, if b odd multiply c by a, halve b, square a mod n](/img/dsa/cMoVVK8Aw0I/frame-00302.png)

```cpp
#include <bits/stdc++.h>
using namespace std;

// a^b mod n, iterative binary exponentiation (the board version)
long long pow_mod(long long a, long long b, long long n) {
    long long c = 1;
    a %= n;
    while (b > 0) {
        if (b % 2 == 1) c = (c * a) % n;   // this bit of b is set
        b /= 2;                            // shift to next bit
        a = (a * a) % n;                   // square the base
    }
    return c;
}
```

- **Invariant:** at the top of each iteration, $c \cdot a^{\,b} \equiv (\text{original } a)^{\,(\text{original } b)} \pmod n$. When $b$ reaches $0$, $c$ holds the answer.
- **Cost:** $\Theta(\log b)$ modular multiplications. With big integers each multiply is itself $O((\log n)^2)$ (or better with fast multiplication), but the exponent loop is logarithmic — that is what makes RSA practical.
- **Side-channel warning (real attack).** The `if (b % 2 == 1)` branch runs **only on set bits of $b$**. So the *number of operations* — and hence the *wall-clock time* and *power draw* — depends on the private exponent $d$. By feeding a server many ciphertexts and **timing** each decryption (or measuring a smart-card's power consumption), an attacker recovers $d$ bit by bit, without ever factoring $n$. This has appeared on ICPC-style contests and is defeated in practice with **constant-time** exponentiation.

[watch from 66:38](https://youtu.be/cMoVVK8Aw0I?t=3998)

---

## Diffie-Hellman key exchange

The goal is narrower than encryption: let $A$ and $B$ agree on a **shared secret key** $k$ over an open channel, using the **discrete-log** one-way function.

- Public parameters: a large prime $p$ and a **generator** $g$ of the multiplicative group mod $p$ (its powers cover all of $1 \dots p-1$). These can be **fixed constants** reused for every conversation — only the per-session secrets must be random.
- Protocol (a single round, both messages sent simultaneously):
  1. $A$ picks random $x$, sends $A_{\text{pub}} = g^x \bmod p$.
  2. $B$ picks random $y$, sends $B_{\text{pub}} = g^y \bmod p$.
  3. $A$ computes $(g^y)^x = g^{xy}$; $B$ computes $(g^x)^y = g^{xy}$.
- Both arrive at the **same** number $k = g^{xy} \bmod p$.

![Diffie-Hellman: A sends g^x, B sends g^y, both compute (g^x)^y = (g^y)^x = g^xy = shared key k](/img/dsa/cMoVVK8Aw0I/frame-00161.png)

- **Security.** The attacker sees $g^x$ and $g^y$ but cannot get $g^{xy}$ without solving a discrete log to recover $x$ or $y$. Even knowing $p$ and $g$ does not help.
- **Why it is nice:** just **one message each way**, sent at once — no multi-round handshake, so latency is tiny.

```cpp
#include <bits/stdc++.h>
using namespace std;
long long pow_mod(long long a, long long b, long long n);   // as above

// each party keeps its secret; both derive the same key from the peer's public value
long long dh_public(long long g, long long secret, long long p) {
    return pow_mod(g, secret, p);
}
long long dh_shared(long long peer_pub, long long my_secret, long long p) {
    return pow_mod(peer_pub, my_secret, p);
}
// e.g. p=23, g=5, x=6, y=15  ->  A=8, B=19, shared key = 2 on both sides
```

[watch from 37:52](https://youtu.be/cMoVVK8Aw0I?t=2272)

---

## ElGamal encryption

The same discrete-log trapdoor becomes a full public-key **encryption** scheme.

- **Keys.** Bob picks secret $x$, publishes $y = g^x \bmod p$. Public key: $(p, g, y)$; secret key: $x$.
- **Encrypt** $m$ (Alice): pick a random **session key** $s$, send the pair
  $$a = g^s \bmod p, \qquad b = m \cdot y^s \bmod p.$$

![ElGamal encryption: s random, a = g^s, b = m times y^s](/img/dsa/cMoVVK8Aw0I/frame-00185.png)

- **Decrypt** (Bob). Note $y^s = (g^x)^s = g^{xs}$, and Bob can rebuild $g^{xs}$ from $a$ because $a^x = (g^s)^x = g^{xs}$. So
  $$m = b \cdot (a^x)^{-1} \bmod p.$$

![ElGamal decryption: b = m g^xs, recover g^xs as a^x, then m = b times (a^x)^-1](/img/dsa/cMoVVK8Aw0I/frame-00210.png)

- **Security.** The attacker sees $y = g^x$, $a = g^s$, and $b = m\,g^{xs}$. Recovering $m$ needs $g^{xs}$ from $g^x$ and $g^s$ — the **computational Diffie-Hellman** problem, as hard as discrete log.
- **Fresh randomness per message.** The random $s$ makes encrypting the same $m$ twice produce different ciphertexts — the property the reused one-time pad lacked.

[watch from 43:25](https://youtu.be/cMoVVK8Aw0I?t=2605)

---

## Digital signatures

Encryption hides content; a **signature** proves the message came from a specific person. Run RSA in the opposite direction.

- Alice holds RSA keys $(n, e)$ public and $d$ secret. Only she knows $d$.
- **Sign.** Alice computes $m' = m^d \bmod n$ with her **secret** key and sends both $m$ and the signature $m'$.
- **Verify.** Bob computes $(m')^e \bmod n$ with Alice's **public** key and checks it equals $m$:
  $$(m')^e = (m^d)^e = m^{de} \equiv m \pmod n.$$
- Since only the holder of $d$ could have produced an $m'$ that raises back to $m$ under $e$, a valid signature proves authorship.

![Digital signature: A sends m and m' where m' = m^d, verifier checks (m')^e = m](/img/dsa/cMoVVK8Aw0I/frame-00107.png)

- **In practice** you sign a **hash** of the message, not the message itself: it is shorter, and it binds the whole document. A good hash is one-way and collision-resistant, so no one can forge a different message with the same hash.

```cpp
#include <bits/stdc++.h>
using namespace std;
long long pow_mod(long long a, long long b, long long n);   // as above

long long rsa_sign(long long m, long long d, long long n)   { return pow_mod(m, d, n); }
bool rsa_verify(long long m, long long sig, long long e, long long n) {
    return pow_mod(sig, e, n) == m % n;   // (m^d)^e == m
}
```

[watch from 49:42](https://youtu.be/cMoVVK8Aw0I?t=2982)

---

## Public keys, MITM, and certificates

- Signatures only help if Bob **already has Alice's real public key**. Getting that key over the same open network invites a **man-in-the-middle**: Mallory sits between Alice and Bob, holds a secure channel with each, and relays traffic while reading it. Each side believes it talks to the other; both actually talk to Mallory.
- With **no prior knowledge** of your peer, you cannot detect this — you might publish the hash of your key somewhere only you control (a Codeforces profile), which works among people who already know each other, but not at internet scale.
- **How HTTPS solves it.** A site presents a **certificate** binding its public key to its identity, **signed by a Certificate Authority (CA)**. You verify the CA's signature to trust the site's key — pushing the trust problem up one level.
- **Where trust bottoms out.** Verifying a CA needs the CA's public key — but a set of **root CA keys ships pre-installed** in your OS/browser. Those you trust by assumption, so the chain terminates locally without any network round-trip.

[watch from 54:00](https://youtu.be/cMoVVK8Aw0I?t=3240)

---

## Attacks in practice: theory is not enough

Even when the underlying math is sound, implementations leak.

- **Timing / power side channels.** As shown above, `pow_mod`'s running time depends on the bits of $d$. Measuring decryption time or a smart-card's power consumption recovers the private key — no factoring needed. Credit cards, which run crypto internally, are a classic target.
- **Small-exponent broadcast (Håstad's attack).** For speed, many deployments use tiny $e$, commonly $e = 3$ (safe, because recovering $d$ still needs $\varphi(n)$). But if Alice sends the **same** $m$ to three recipients with moduli $n_1, n_2, n_3$ and all use $e = 3$, the attacker sees
  $$m^3 \bmod n_1,\quad m^3 \bmod n_2,\quad m^3 \bmod n_3.$$
  By the **Chinese Remainder Theorem** these combine to $m^3 \bmod (n_1 n_2 n_3)$. Since $m < \min(n_i)$, we have $m^3 < n_1 n_2 n_3$, so the CRT value *is* $m^3$ exactly — take the integer **cube root** to get $m$.
- **The fix: randomized padding.** Never encrypt raw structured plaintext. Prepend random bits (OAEP-style padding) so identical messages encrypt to different ciphertexts and the algebraic relations that CRT exploits disappear.
- **Takeaway:** real attacks usually bypass the hard math entirely and hit the implementation. Which is why the golden rule is: **never roll your own crypto — use vetted, audited libraries** (OpenSSL/BoringSSL, libsodium, your platform's TLS stack). The toy code here is for understanding, not deployment.

[watch from 66:13](https://youtu.be/cMoVVK8Aw0I?t=3973)

---

## Complexity recap

| Operation | Cost | Space | Notes |
| --- | --- | --- | --- |
| XOR one-time pad (enc/dec) | $\Theta(n)$ bits | $\Theta(n)$ key | perfectly secret for one use |
| Modular exponentiation $a^b \bmod n$ | $\Theta(\log b)$ mults | $O(1)$ | each mult $O((\log n)^2)$ on big ints |
| Extended Euclid / mod inverse | $O(\log n)$ | $O(\log n)$ rec. | yields $d$ from $e, \varphi(n)$ |
| RSA keygen | primality-test cost $+\ O(\log \varphi)$ | $O(1)$ | dominated by prime search |
| RSA / ElGamal enc + dec | $O(\log \text{exp})$ mults | $O(1)$ | one or two modpows |
| Diffie-Hellman exchange | $O(\log \text{exp})$ mults, 2 messages | $O(1)$ | single round trip |
| Factor $n$ / discrete log (attacker) | sub-exponential, infeasible | — | the security assumption |

---

## Practice problems

Cryptography is an **applied/theory** topic, not a standard interview-coding subject — you will almost never implement RSA in an interview loop. But the **modular-exponentiation** and **number-theory** primitives underneath it are very much fair game, and they are the honest interview payload of this lecture.

**🎯 Interview (MAANG-style) — the modpow / number-theory core**

- [Pow(x, n) — LeetCode 50](https://leetcode.com/problems/powx-n/) — Medium — binary exponentiation, the exact `pow_mod` loop (over doubles).
- [Super Pow — LeetCode 372](https://leetcode.com/problems/super-pow/) — Medium — modular exponentiation with the exponent given as a digit array; leans on $a^{1+k\varphi}$-style reasoning.
- [Count Primes — LeetCode 204](https://leetcode.com/problems/count-primes/) — Medium — sieve; prime generation underpins RSA keygen.
- [Modular Exponentiation — GeeksforGeeks](https://www.geeksforgeeks.org/modular-exponentiation-power-in-modular-arithmetic/) — Easy — the canonical `pow_mod` drill.
- [RSA Algorithm — GeeksforGeeks](https://www.geeksforgeeks.org/rsa-algorithm-cryptography/) — Medium — a full worked RSA keygen/encrypt/decrypt to check your implementation against.

**🏆 Competitive — discrete log, inverses, exponentiation**

- [Exponentiation — CSES 1095](https://cses.fi/problemset/task/1095) — Easy — plain $a^b \bmod 10^9+7$, the primitive itself.
- [Exponentiation II — CSES 1712](https://cses.fi/problemset/task/1712) — Medium — nested $a^{b^c}$, which forces the exponent mod $\varphi$ (Euler/Fermat) — the same identity RSA relies on.
- [Discrete Logarithm — cp-algorithms](https://cp-algorithms.com/algebra/discrete-log.html) — Hard — baby-step giant-step, the "how hard is inverting $g^x$" question made concrete.

> Because attacks in the wild target implementations (timing, padding, broadcast) rather than the math, the practically useful skill is not "break RSA" but "wield modpow, inverses, and $\varphi$ fluently" — exactly what these problems train.

---

## Further reading

- [RSA (cryptosystem) — Wikipedia](https://en.wikipedia.org/wiki/RSA_(cryptosystem)) and [Euler's theorem — Wikipedia](https://en.wikipedia.org/wiki/Euler%27s_theorem) — the correctness proof in full.
- [Diffie-Hellman key exchange — Wikipedia](https://en.wikipedia.org/wiki/Diffie%E2%80%93Hellman_key_exchange) and [ElGamal encryption — Wikipedia](https://en.wikipedia.org/wiki/ElGamal_encryption).
- [Discrete logarithm — Wikipedia](https://en.wikipedia.org/wiki/Discrete_logarithm) and [Digital signature — Wikipedia](https://en.wikipedia.org/wiki/Digital_signature).
- [Binary exponentiation — cp-algorithms](https://cp-algorithms.com/algebra/binary-exp.html), [Modular inverse — cp-algorithms](https://cp-algorithms.com/algebra/module-inverse.html), [Euler's totient — cp-algorithms](https://cp-algorithms.com/algebra/phi-function.html).
- [Modular exponentiation — Wikipedia](https://en.wikipedia.org/wiki/Modular_exponentiation).

---

## Key takeaways

- Symmetric encryption (one-time pad, block ciphers) is fast and solid; the hard, interesting problem is **agreeing on a key** over an open channel.
- **Public-key crypto** solves that with a **one-way function**: easy forward, infeasible to invert. Multiplication (invert = factor) gives RSA; modular exponentiation (invert = discrete log) gives Diffie-Hellman and ElGamal.
- RSA's correctness is one line of number theory: $ed \equiv 1 \pmod{\varphi(n)}$ plus **Euler's theorem** yields $(m^e)^d \equiv m$.
- **Modular exponentiation** is the single primitive every scheme leans on — learn its $O(\log b)$ structure cold, and know its **timing leaks the key**.
- Security proofs assume ideal machines. Real breaks come from **side channels, padding mistakes, and MITM**, which is why you **use vetted libraries and never roll your own crypto**.

## Glossary

- **One-time pad** — XOR a message with a random key of equal length; perfectly secret but single-use.
- **One-way function** — easy to compute, infeasible to invert; the foundation of public-key crypto.
- **$\varphi(n)$ (Euler's totient)** — count of integers in $1 \dots n$ coprime to $n$; equals $(p-1)(q-1)$ for $n = pq$.
- **Euler's theorem** — $m^{\varphi(n)} \equiv 1 \pmod n$ when $\gcd(m, n) = 1$; makes RSA decryption invert encryption.
- **Discrete logarithm** — recovering $x$ from $g^x \bmod p$; believed hard, secures Diffie-Hellman and ElGamal.
- **Binary exponentiation (modpow)** — compute $a^b \bmod n$ in $O(\log b)$ multiplications by squaring.
- **Man-in-the-middle (MITM)** — attacker relays and reads traffic between two parties who each think they talk directly.
- **Certificate / CA** — a signed binding of a public key to an identity; trust chains up to pre-installed root keys.
- **Side channel** — leakage through timing, power, or other physical observables rather than the ciphertext itself.
