---
title: "Design Mobile Payment Security (Tokenization)"
sidebar_position: 3
---

The defining property of a mobile payment system like Apple Pay or Google Pay is that the merchant and the device never hold the real card number. When you add a card to a wallet, the wallet does not store your Primary Account Number (PAN) and hand it to shops on every tap. Instead a per-device **token** — a Device PAN, or DPAN — stands in for the real card, and each tap carries a fresh, single-use **cryptogram** that is worthless once used. That one design choice reorganizes the whole system: a breach of the merchant, the terminal, or even the phone yields data that cannot be replayed and cannot be used anywhere else. The hard part is not moving the money — the card networks already do that — it is arranging keys, tokens, and cryptograms so that the secret that authorizes a charge is never in a place where stealing it matters.

This case study designs a system with the shape of EMVCo payment tokenization as deployed by Apple Pay (on-device Secure Element) and Google Pay (cloud tokenization with Host Card Emulation), grounding each component in how the real schemes work.

## Step 1: Outline use cases and constraints

### Use cases

#### We'll scope the problem to handle the following use cases

* A **cardholder** adds a payment card to a **wallet app**; the system provisions a device-bound **token (DPAN)** instead of storing the real PAN on the device or with the merchant
* Provisioning requires **issuer or network approval** — the card must be verified as real and eligible for tokenization before a token is issued, and the issuer may require a step-up identity check
* At a terminal or in an app, the wallet presents the **DPAN plus a dynamic, single-use cryptogram** over NFC/EMV contactless, and the **merchant only ever sees the DPAN**, never the PAN
* The **card network / Token Service Provider (TSP)** de-tokenizes the DPAN back to the real PAN inside a protected boundary and forwards the authorization to the **issuing bank**, which decides on the real account
* Each transaction's cryptogram is **valid exactly once**, so a captured transaction cannot be replayed for a second charge
* The system supports the **token lifecycle**: suspend, resume, and delete a token (for a lost phone) without touching the underlying card
* The design keeps the merchant and most of the ecosystem **out of PCI-DSS cardholder-data scope**, because the PAN is confined to the token vault and the issuer

#### Out of scope

* The issuer's core-banking authorization logic (fraud scoring, credit-limit checks) — treated as an external dependency the network calls
* Clearing and settlement of the underlying funds between acquirer and issuer — a distinct system that runs after authorization (see the payment-system case studies elsewhere in this course)
* Card-not-present e-commerce tokenization for browser checkouts beyond a brief mention — the same token concept, different capture path
* Loyalty, rewards, and the wallet's non-payment features
* The cryptographic provisioning of the Secure Element at manufacture and its attestation chain — named, not designed

### Constraints and assumptions

#### State assumptions

* The real PAN is entered or imported **once**, at card-add time; after provisioning it is never sent from the device again — only the DPAN is
* A stolen DPAN must be **useless on its own**: without a valid, unused cryptogram bound to that specific transaction, it cannot authorize a charge
* A cryptogram is **single-use**: the network must reject a replay of a cryptogram it has already accepted, even if the DPAN and amount match
* Provisioning is a **security-sensitive, multi-party approval** flow that can legitimately be declined or sent to step-up verification; it must be safe to retry without issuing two tokens for one request
* The device credential (Secure Element key, or HCE limited-use key) is gated behind a **local user presence check** (biometric or passcode) so a locked phone cannot silently pay
* Two deployment models must both fit the design: **on-device tokenization** (Apple Pay: token and keys live in the Secure Element, works offline) and **cloud tokenization with HCE** (Google Pay: real card in Google's cloud, device fetches limited-use keys, assumes connectivity)
* Availability of the token vault and cryptogram-verification path is on the authorization critical path; if the network cannot de-tokenize, the transaction cannot be approved

#### Calculate usage

* Transaction volume: a large wallet network processes on the order of **billions of contactless transactions per month**. Take 3,000,000,000/month → 3,000,000,000 / (30 × 86,400) ≈ **~1,160 transactions/sec average**, and contactless retail is sharply peaked (lunch hours, weekends, holiday shopping) — design for roughly **8x average at peak**, so on the order of **~9,000 authorizations/sec** hitting the de-tokenization path.
* Latency budget: a contactless tap must feel instant. The **NFC/EMV exchange at the terminal targets well under a second** (a few hundred milliseconds), and the online authorization round-trip (de-tokenize, issuer decision) typically completes in **a couple of seconds**. On-device tokenization can complete the tap itself offline and defer the online authorization, which is why Apple Pay feels quicker in low-signal conditions.
* Token vault size: one mapping row per provisioned token (`dpan`, `pan_ref`, `device_id`, `token_requestor`, `status`, `par`, timestamps) ≈ **~300 bytes/row**. With, say, 500,000,000 active tokens that is 500,000,000 × 300 ≈ **~150 GB** of hot mapping data — small enough to shard by token across a strongly-consistent key-value tier, large enough that it is not a single box.
* Cryptogram verification state: the anti-replay check needs to remember recently-seen `(dpan, atc)` counters, not every historical one. A monotonically increasing **Application Transaction Counter (ATC)** per token means the vault stores one small "last accepted counter" per token rather than a growing log — bounded state regardless of transaction history.
* Provisioning volume: card adds are far rarer than payments — assume roughly **1 provisioning per 1,000 payments**, so on the order of **~1-10 provisions/sec**, but each is a heavier multi-party approval flow, so provisioning is latency-tolerant (seconds to tens of seconds, including step-up) where payment authorization is not.
* Key material: each token has associated cryptographic keys used to generate cryptograms; these live in **hardware** (device Secure Element, or the TSP's HSMs for cloud keys) and never appear in plaintext outside that boundary, so key storage is measured in tamper-resistant hardware capacity, not commodity disk.

## Step 2: Create a high-level design

![Tokenized mobile payment overview: at provisioning the wallet sends the encrypted real PAN once to the Token Service Provider, which checks issuer eligibility, gets approval, and provisions a DPAN into the device Secure Element; at payment the device sends only the DPAN plus a one-time cryptogram to the merchant and acquirer, the network and TSP de-tokenize the DPAN back to the real PAN and the issuer authorizes on the real account, so a merchant breach leaks only a useless device-bound DPAN](/img/case-studies/fintech/mobile-payment-security-overview.svg)

There are two distinct flows, and conflating them is the most common way to get this design wrong. The first is **provisioning**, which happens once when a card is added. The wallet takes the real PAN, encrypts it, and sends it to a **Token Service Provider** — a role defined by [EMVCo payment tokenization](https://www.emvco.com/emv-technologies/payment-tokenisation/) and played in practice by the card networks (Visa Token Service, Mastercard MDES). The TSP asks the issuer whether this card is real and eligible to be tokenized. This is the "Identification and Verification" (ID and V) decision, and the issuer can approve, decline, or require a step-up check (a one-time code, or an in-app confirmation). On approval, the TSP mints a **DPAN**, records the PAN-to-DPAN mapping in its **token vault**, and provisions the DPAN plus its cryptographic keys into the device. In on-device tokenization that means writing into the phone's **Secure Element**; in cloud tokenization the token lives in the cloud and the device uses **Host Card Emulation (HCE)** to fetch short-lived limited-use keys when it needs to pay.

The second flow is **payment**, and it repeats on every tap. The device presents the DPAN and a freshly generated, single-use **cryptogram** over **NFC/EMV contactless** to the terminal. The merchant and acquirer forward this exactly as they would a normal card transaction — except the number they carry is the DPAN, not the PAN. At the network, the TSP **de-tokenizes**: it looks up the DPAN in the vault, verifies the cryptogram, and swaps in the real PAN before sending the authorization to the issuer. The issuer decides on the real account and the approval flows back. The structural payoff is that the real PAN exists in only two places — the token vault and the issuer — and everywhere else, including the merchant and the phone, holds a DPAN that is bound to that specific device and made non-replayable by the per-transaction cryptogram. A breach of the merchant leaks a DPAN and some spent cryptograms, none of which can be reused.

## Step 3: Design core components

### Use case: Token vault maps PAN to DPAN without exposing the PAN

The token vault is the heart of the scheme: it is the one place that knows both the DPAN a merchant sees and the real PAN behind it. Its entire job is to hold that mapping securely, expose only the DPAN outward, and answer exactly one privileged question — "what real PAN does this DPAN stand for?" — and only to the network's authorization path, never to a merchant.

**Core spec: the vault schema and the tokenize/de-tokenize operations**

```sql
CREATE TABLE token_vault (
    dpan            CHAR(16)     PRIMARY KEY,   -- the device token the merchant sees
    pan_encrypted   BYTEA        NOT NULL,      -- real PAN, encrypted under an HSM-held key
    pan_last4       CHAR(4)      NOT NULL,      -- for display only ("card ending 4821")
    par             CHAR(29),                   -- Payment Account Reference: links tokens
                                                -- of the SAME card without revealing the PAN
    token_requestor VARCHAR(32)  NOT NULL,      -- e.g. 'apple-pay', 'google-pay'
    device_id       VARCHAR(64),                -- binds the token to one device
    status          VARCHAR(16)  NOT NULL,      -- 'ACTIVE','SUSPENDED','DELETED'
    domain          VARCHAR(16)  NOT NULL,      -- 'NFC_CONTACTLESS','ECOM' -- usage scope
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_vault_par ON token_vault (par);   -- "all tokens for this underlying card"
```

```python
import os

def tokenize(vault, hsm, pan: str, token_requestor: str, device_id: str, par: str):
    """Provision a new DPAN for a real PAN. The PAN is encrypted under an
    HSM-held key and never stored in plaintext. The DPAN is a fresh value
    that passes the same format checks (Luhn) as a real card number, so it
    flows through the existing card rails unchanged, but it is scoped to a
    device and a usage domain.
    """
    dpan = _mint_luhn_valid_token()                 # random, Luhn-valid, unused
    vault.insert(
        dpan=dpan,
        pan_encrypted=hsm.encrypt(pan.encode()),    # PAN protected inside HSM boundary
        pan_last4=pan[-4:],
        par=par,
        token_requestor=token_requestor,
        device_id=device_id,
        status="ACTIVE",
        domain="NFC_CONTACTLESS",
    )
    return dpan

def detokenize(vault, hsm, dpan: str) -> str:
    """Reverse a DPAN to its real PAN. This is the single privileged
    operation and it runs ONLY on the network's authorization path,
    inside the vault's trust boundary -- never exposed to a merchant.
    """
    row = vault.get(dpan)
    if row is None or row["status"] != "ACTIVE":
        raise LookupError(f"token {dpan[-4:]} not active")
    return hsm.decrypt(row["pan_encrypted"]).decode()

def _mint_luhn_valid_token() -> str:
    """Generate a random 16-digit value with a valid Luhn check digit, so
    a DPAN is syntactically indistinguishable from a real card number to
    every intermediary that only does format validation.
    """
    base = "".join(str(b % 10) for b in os.urandom(15))   # 15 random digits
    check = _luhn_check_digit(base)
    return base + str(check)

def _luhn_check_digit(number: str) -> int:
    digits = [int(d) for d in number]
    digits.reverse()
    total = 0
    for i, d in enumerate(digits):
        if i % 2 == 0:          # positions that get doubled for a 15->16 digit number
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return (10 - (total % 10)) % 10
```

**Data structures:** `token_vault` above is the durable core. The **PAR** (Payment Account Reference) deserves special note: it is a non-sensitive value that lets fraud, AML, and loyalty systems recognize that two different tokens belong to the same underlying card, without any of them ever holding the PAN — the same card provisioned to a phone and a watch shares a PAR but has two DPANs.

**Trade-offs:**
* **The gotcha:** it is tempting to make the DPAN a keyed hash of the PAN so the network can de-tokenize by recomputing rather than looking up. That reintroduces exactly the risk tokenization exists to remove — anyone who learns the hashing key (or brute-forces the small PAN space, which is far smaller than it looks once the BIN and Luhn digit are fixed) can reverse every token at once. The fix is that the DPAN is a **random, unlinkable value stored in a vault**, so de-tokenization requires access to the vault, not knowledge of an algorithm — a compromise of one token tells you nothing about any other.
* Keeping the PAN encrypted under an **HSM-held key** rather than an application-readable key means even a full read of the vault database yields ciphertext, not card numbers; de-tokenization must go through the HSM, which can rate-limit and audit every decryption.

### Use case: Dynamic single-use cryptogram makes a captured transaction non-replayable

The DPAN alone is a static identifier — if that were all a tap sent, a thief who captured one transaction could replay it. What makes a captured tap worthless is that each transaction also carries a **cryptogram**: a short authentication value computed over the transaction from a per-token key and a counter that only ever moves forward. The network verifies it and, critically, **rejects any cryptogram whose counter it has already accepted**, so a replay of a previously valid tap fails.

**Core spec: cryptogram generation on the device and verification at the network**

```python
import hmac
import hashlib

def generate_cryptogram(token_key: bytes, dpan: str, amount_cents: int,
                        currency: str, atc: int, unpredictable_number: int) -> str:
    """Device side: compute a single-use cryptogram for ONE transaction.

    Inputs that make it single-use and non-forgeable:
      - atc: Application Transaction Counter, incremented once per payment
             and never reused -- this is what makes each cryptogram unique
             and lets the network reject replays.
      - unpredictable_number: a nonce from the terminal, so the device
             cannot precompute cryptograms in advance.
      - token_key: per-token secret that never leaves the Secure Element
             (on-device) or the HSM-backed cloud (HCE limited-use key).

    This is a simplified HMAC stand-in for the scheme's real cryptogram
    algorithm (EMV Application Cryptograms), which uses the same shape:
    a secret key over transaction data plus a monotonic counter.
    """
    message = f"{dpan}|{amount_cents}|{currency}|{atc}|{unpredictable_number}".encode()
    mac = hmac.new(token_key, message, hashlib.sha256).hexdigest()
    return mac[:16]     # truncated to a card-sized cryptogram field


def verify_cryptogram(vault_keys, seen_counters, dpan: str, amount_cents: int,
                     currency: str, atc: int, unpredictable_number: int,
                     presented_cryptogram: str) -> bool:
    """Network side: recompute the expected cryptogram from the token key
    the TSP holds for this DPAN, and enforce single-use via the counter.

    seen_counters[dpan] holds the highest ATC already accepted for this
    token. A replay carries an ATC that is not strictly greater, so it is
    rejected even though the DPAN, amount, and cryptogram all match a
    previously valid transaction.
    """
    last_atc = seen_counters.get(dpan, 0)
    if atc <= last_atc:
        return False                      # replay or out-of-order: reject

    token_key = vault_keys.key_for(dpan)  # per-token key, HSM-held
    expected = generate_cryptogram(token_key, dpan, amount_cents,
                                   currency, atc, unpredictable_number)
    if not hmac.compare_digest(expected, presented_cryptogram):
        return False                      # forged or corrupted: reject

    seen_counters[dpan] = atc             # advance the watermark: this ATC is now spent
    return True
```

**Data structures:** the network keeps a small **anti-replay watermark** per token — the highest ATC accepted so far (`seen_counters` above) — not a log of every past transaction. Because the ATC only increases, storing one integer per token is sufficient to reject every replay, keeping the state bounded no matter how many payments a card makes.

**Trade-offs:**
* **The gotcha:** verifying that the cryptogram is cryptographically valid is necessary but not sufficient — a valid cryptogram that has *already been accepted* must still be rejected, or an attacker who records one legitimate tap can replay it. The fix is the **monotonic counter check** (`atc <= last_atc` rejects), which turns a valid-but-old cryptogram into a hard failure. Static verification without the counter is the classic replay hole.
* On-device tokenization can generate the cryptogram **offline** because the token key lives in the Secure Element; HCE fetches **limited-use keys** ahead of time so it can generate a bounded number of cryptograms before it must check back with the cloud. This is the concrete reason Apple Pay taps work with no signal while Google Pay leans on connectivity — the same cryptogram guarantee, a different place the key lives.
* Using `hmac.compare_digest` rather than `==` avoids a timing side channel on the comparison; the cryptogram check must not leak how many leading bytes matched.

### Use case: Provisioning a card as an idempotent, approvable state machine

Adding a card is not a single call — it is a multi-party approval that can pause for a step-up check and can be retried by a flaky mobile network. Modeling it as an explicit state machine, keyed by a client-generated request id, keeps a retried "add card" tap from minting two tokens for one card and makes the "issuer wants a one-time code" branch a first-class state rather than an error.

**Core spec: the provisioning state machine**

```
                    ┌──────────────┐
   user taps "add"  │  REQUESTED   │  client-generated provisioning_id;
   ────────────────▶│              │  encrypted PAN received, not yet a token
                    └──────┬───────┘
                           │ TSP asks issuer: is this card eligible? (ID and V)
                           ▼
                    ┌──────────────┐
                    │  ISSUER_     │
                    │  REVIEW      │
                    └──┬────────┬──┘
             approved  │        │ step-up required (OTP / in-app confirm)
                       │        ▼
                       │   ┌──────────────┐   user completes step-up
                       │   │ STEP_UP_     │──────────────┐
                       │   │ PENDING      │              │
                       │   └──────┬───────┘              │
                       │          │ step-up failed/expired
                       │          ▼                      │
                       │   ┌──────────────┐              │
                       │   │  DECLINED    │              │
                       │   └──────────────┘              │
                       ▼                                 ▼
                    ┌──────────────────────────────────────┐
                    │  PROVISIONED                          │
                    │  DPAN minted, vault row written,      │
                    │  token + keys pushed to device        │
                    └──────────────────────────────────────┘

Idempotency: a retry carrying the SAME provisioning_id resumes the
existing state machine -- it never starts a second one, so a card is
never double-provisioned by a retried request.
```

```python
def provision_card(store, tsp, req):
    """Drive one provisioning request through the state machine. Keyed by
    req.provisioning_id (client-generated, reused across retries) so a
    retried add never mints a second token.
    """
    state = store.claim_or_get(req.provisioning_id)   # atomic: create REQUESTED or read existing
    if state.status == "PROVISIONED":
        return state.result                            # replay: return the same DPAN
    if state.status in ("DECLINED",):
        return {"status": "DECLINED", "reason": state.reason}

    decision = tsp.identify_and_verify(req.encrypted_pan, req.device_id)
    if decision.outcome == "DECLINE":
        store.transition(req.provisioning_id, "DECLINED", reason=decision.reason)
        return {"status": "DECLINED", "reason": decision.reason}
    if decision.outcome == "STEP_UP":
        store.transition(req.provisioning_id, "STEP_UP_PENDING",
                         step_up_channel=decision.channel)
        return {"status": "STEP_UP_PENDING", "channel": decision.channel}

    # APPROVE: mint the token and push it to the device.
    dpan = tsp.mint_and_provision(req.encrypted_pan, req.token_requestor,
                                  req.device_id, decision.par)
    result = {"status": "PROVISIONED", "dpan_last4": dpan[-4:]}
    store.transition(req.provisioning_id, "PROVISIONED", result=result)
    return result
```

**Data structures:** a `provisioning_requests` row — `provisioning_id` (PK), `status` (`REQUESTED`/`ISSUER_REVIEW`/`STEP_UP_PENDING`/`DECLINED`/`PROVISIONED`), `token_requestor`, `device_id`, `reason`, `result`, `created_at`, `updated_at`. The encrypted PAN is held only for the duration of the flow and dropped once a token exists.

**Trade-offs:**
* **The gotcha:** treating "add card" as fire-and-forget lets a retried request (the user taps again after a spinner hangs) mint a second token for the same card, so a later "delete card" leaves a live orphan token still able to pay. The fix is the client-generated `provisioning_id` and an **atomic claim-or-resume** (`store.claim_or_get`), the same [Idempotency](/docs/patterns/reliability/idempotency) discipline the payment case studies apply to charges, so a retry always rejoins the one in-flight state machine.
* Making **STEP_UP_PENDING** an explicit state rather than a failure is what lets high-risk cards be added safely: the issuer's "prove it's really you" requirement becomes a normal branch the wallet UI can drive, not an error the user has to interpret.

**REST API:**

```
$ curl -X POST https://tsp.example/api/v1/provision \
    -H "X-Token-Requestor: apple-pay" \
    -H "Signature: <wallet-request-signature>" \
    -d '{
          "provisioning_id": "prov-7f3a1c90-device88-card44210",
          "encrypted_pan": "<PAN encrypted to the TSP public key>",
          "device_id": "SE-device-88",
          "token_requestor": "apple-pay"
        }'
```

Response (step-up required):

```json
{
  "provisioning_id": "prov-7f3a1c90-device88-card44210",
  "status": "STEP_UP_PENDING",
  "channel": "issuer-app-confirm"
}
```

### Use case: Network de-tokenizes and authorizes on the real account

At payment time the merchant and acquirer carry the DPAN through the ordinary card rails. The network's job is to verify the cryptogram, swap the DPAN back to the real PAN inside its trust boundary, forward the authorization to the issuer keyed by the real account, and then translate the issuer's answer back to the token world before it returns. The de-tokenized PAN never leaves the network's boundary — the acquirer that sent the request gets an approval, not a card number.

**Core spec: the de-tokenize-then-authorize path**

```python
def authorize_token_payment(network, req):
    """Handle one contactless authorization presented as a DPAN + cryptogram.

    Order matters: verify the single-use cryptogram FIRST (cheap, and it
    rejects replays and forgeries before any PAN is touched), then
    de-tokenize inside the boundary, then authorize on the real account.
    """
    # 1. Anti-replay + authenticity: reject replays and forgeries up front.
    ok = network.verify_cryptogram(
        dpan=req.dpan, amount_cents=req.amount_cents, currency=req.currency,
        atc=req.atc, unpredictable_number=req.unpredictable_number,
        presented_cryptogram=req.cryptogram,
    )
    if not ok:
        return {"result": "DECLINED", "reason": "CRYPTOGRAM_INVALID_OR_REPLAY"}

    # 2. De-tokenize inside the vault boundary; the real PAN never leaves here.
    pan = network.detokenize(req.dpan)

    # 3. Authorize on the REAL account at the issuer.
    auth = network.issuer_authorize(
        pan=pan, amount_cents=req.amount_cents, currency=req.currency,
    )

    # 4. Translate the issuer answer back to the token world before returning:
    #    the acquirer that called us gets an approval, never the PAN.
    return {"result": auth.result, "dpan": req.dpan,
            "auth_code": auth.code, "amount_cents": req.amount_cents}
```

**Data structures:** reuses `token_vault` (for the DPAN→PAN mapping) and the per-token anti-replay watermark from the cryptogram use case. The response carries the **DPAN**, not the PAN, so the record the acquirer and merchant keep is still tokenized end to end.

**Trade-offs:**
* **The gotcha:** if de-tokenization happened *before* cryptogram verification, a flood of forged or replayed DPANs would each trigger a real PAN decryption (an HSM operation) and an issuer call — a denial-of-service and privacy amplifier. The fix is ordering: **verify the cryptogram first** so forged and replayed requests are rejected before any PAN is decrypted, keeping the expensive, sensitive de-tokenization behind a cheap authenticity gate.
* The issuer sees the real PAN because it authorizes the real account — this is by design and is why the issuer is one of only two places the PAN legitimately lives. Everything the design does is to keep that set of two places (vault and issuer) as small as possible.

**REST API (network-internal de-tokenize + authorize, acquirer-facing):**

```
$ curl -X POST https://network.example/api/v1/authorize \
    -H "X-Acquirer-Id: acq-4417" \
    -H "Signature: <acquirer-request-signature>" \
    -d '{
          "dpan": "4000004821000019",
          "amount_cents": 4999,
          "currency": "USD",
          "atc": 231,
          "unpredictable_number": 884213771,
          "cryptogram": "9a3f21c0b7e44d19"
        }'
```

Response:

```json
{
  "result": "APPROVED",
  "dpan": "4000004821000019",
  "auth_code": "A17X4Q",
  "amount_cents": 4999
}
```

### Use case: Token lifecycle — suspend, resume, delete on a lost device

Because the token is separate from the card, a lost phone is a token problem, not a card problem: the user (or the issuer) suspends or deletes the DPAN, and the real card keeps working everywhere else. This is a decisive advantage over storing the PAN on the device — there is nothing to reissue, and the blast radius of a lost device is one scoped token.

**Core spec: lifecycle transitions on the vault row**

```python
def set_token_status(vault, dpan: str, new_status: str, actor: str):
    """Suspend / resume / delete a token. A SUSPENDED or DELETED token
    fails detokenize() (which requires status == 'ACTIVE'), so no
    authorization can complete against it -- the real PAN is untouched.

    'DELETED' is terminal: a deleted token cannot be resumed, only a
    fresh provisioning can issue a new one.
    """
    allowed = {
        "ACTIVE":    {"SUSPENDED", "DELETED"},
        "SUSPENDED": {"ACTIVE", "DELETED"},
        "DELETED":   set(),          # terminal
    }
    row = vault.get(dpan)
    if row is None:
        raise LookupError("no such token")
    if new_status not in allowed[row["status"]]:
        raise ValueError(f"illegal transition {row['status']} -> {new_status}")
    vault.update_status(dpan, new_status, changed_by=actor)
    return {"dpan_last4": dpan[-4:], "status": new_status}
```

**Data structures:** reuses `token_vault.status`. Because `detokenize` already refuses any status other than `ACTIVE`, suspending a token is enough to make every future authorization against it fail without touching the mapping or the PAN — the anti-replay watermark and keys can be retained in case the token is resumed.

**Trade-offs:**
* **The gotcha:** if "delete card" only removed the token from the phone's UI but left the vault row `ACTIVE`, a token extracted from a stolen-but-not-wiped device could still authorize. The fix is that lifecycle is enforced **at the vault** (`detokenize` checks `status`), not at the device — the authoritative kill switch is server-side, so it works even for a device that is offline or in an attacker's hands.
* Keeping `DELETED` terminal (no resume) avoids a reactivation path an attacker could exploit; recovering a wiped phone re-provisions a brand-new DPAN rather than reviving the old one.

## Step 4: Scale the design

![Scaled tokenization platform: a device tier of millions of Secure Elements and HCE clients gated by biometrics with server-side token lifecycle; a Token Service Provider tier with a sharded token vault, an idempotent provisioning state machine, cryptogram verification, and an HSM key store; and a network-and-issuer tier that de-tokenizes inside the vault boundary, authorizes on the real account, reconciles and settles, and confines PAN to the vault and issuer for PCI-DSS scope reduction](/img/case-studies/fintech/mobile-payment-security-scaled.svg)

* **The token vault shards by DPAN, so no single store is on the path of every de-tokenization at peak** — see [Sharding](/docs/patterns/storage/sharding). Every payment and lifecycle operation is scoped to one DPAN, making the token a natural shard key: all state for one token (mapping, status, anti-replay watermark) lives on one shard, and de-tokenization never needs a cross-shard read.
* **The DPAN→PAN mapping and the anti-replay watermark need strong consistency, not just availability** — see [Quorum](/docs/patterns/consistency/quorum). If two concurrent authorizations for the same token could both read the same "last accepted ATC," a race could let a replay through; the counter advance must be a strongly-consistent, serialized update per token, exactly the spot to spend consistency budget.
* **PAN encryption and cryptogram keys live in HSMs, and de-tokenization is rate-limited and audited at that boundary** — the HSM is the enforcement point that a compromised application server cannot bypass, so even a full application breach cannot bulk-export card numbers.
* **The issuer and network integrations get a [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) and [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff), applied per issuer** — issuers fail independently, and a slow issuer must fail its own authorizations fast rather than stalling the shared de-tokenization path; retries must always carry the same cryptogram and ATC so a retry can never be mistaken for a new, second transaction.
* **Provisioning runs off the payment hot path as its own idempotent service** — card adds are rare, latency-tolerant, and can pause for step-up, so they are isolated from the high-throughput authorization path and made safe to retry with the [Idempotency](/docs/patterns/reliability/idempotency) discipline from Step 3, keeping a flaky mobile network from double-provisioning a card.
* **On-device tokenization pushes the cryptogram generation to the edge (the Secure Element) so a tap works offline**, while cloud tokenization pre-distributes limited-use keys to HCE clients — the same guarantee (single-use cryptogram) delivered by either caching keys at the device edge or fetching them just-in-time, a deployment trade-off between offline capability and central control.

## Additional talking points

* **PCI-DSS scope reduction is the business case.** Because the merchant and its systems only ever handle a DPAN and spent cryptograms — never the PAN — most of the merchant environment falls outside the scope of controls that [PCI-DSS](https://en.wikipedia.org/wiki/Payment_Card_Industry_Data_Security_Standard) imposes on systems that store, process, or transmit cardholder data. Tokenization is one of the standard ways to shrink that scope, because "systems that no longer store or process sensitive data may have a reduction of applicable controls." The PAN is confined to the token vault and the issuer, which are the parties equipped to protect it.
* **On-device versus cloud tokenization is a real architectural fork, not a cosmetic one.** Apple Pay keeps the token and its keys in a hardware Secure Element and can therefore generate a valid cryptogram with no network — maximum privacy and offline capability, at the cost of being tightly bound to one device (losing the phone means full re-provisioning). Google Pay's cloud model with HCE keeps the real card in Google's cloud and hands the device limited-use keys, so it is flexible across devices and easier to manage centrally, at the cost of leaning on connectivity and defending a large server-side vault. Both satisfy the same invariant — merchant never sees the PAN, every tap is single-use — via different key-location choices.
* **The cryptogram is what defeats replay, and the counter is what defeats a valid-but-old cryptogram.** It is worth being precise: a static token plus a static "proof" would be replayable; a dynamic cryptogram plus a monotonic counter that the network watermarks per token is what makes a captured tap a dead end. Verifying the cryptogram's authenticity without also enforcing the counter is a subtle but complete failure of the anti-replay property.
* **Device binding and user presence are part of the security model, not the app's convenience.** The token key is gated behind a local biometric or passcode check, so a locked or stolen phone cannot silently authorize; this is the possession-plus-presence factor that complements the network-side cryptogram check. Neither the wallet vendor nor the merchant validates that gate — it is enforced on the device against hardware.
* **Fraud, PAR, and monitoring without the PAN.** Fraud and AML systems still need to reason across a cardholder's activity, and the Payment Account Reference lets them recognize that several tokens belong to one card without any of them holding the PAN — the same account can be watched across a phone, a watch, and an e-commerce token by PAR rather than by card number.
* **De-tokenization is a privileged, audited operation — treat it as one.** The single riskiest capability in the whole system is "turn this DPAN back into a PAN." It must be reachable only from the authorization path, rate-limited, logged, and gated by the cryptogram check, because an attacker who could call de-tokenize freely would have turned the vault back into a PAN database. Ordering the cryptogram check before de-tokenization, and keeping the HSM in the loop, are the concrete defenses.

## Source(s) and further reading

* [EMV Payment Tokenisation — EMVCo](https://www.emvco.com/emv-technologies/payment-tokenisation/) — the primary specification framework: the EMV Payment Token, the Token Service Provider role, Payment Account Reference (PAR), and how a token is constrained to a specific merchant, device, or scenario
* [Tokenization (data security) — Wikipedia](https://en.wikipedia.org/wiki/Tokenization_(data_security)) — token vault, de-tokenization as the reverse redemption of a token for its PAN, dynamic per-transaction cryptograms, and PCI-DSS scope reduction
* [Apple Pay security overview — Apple Platform Security](https://support.apple.com/guide/security/apple-pay-security-overview-sec0e090d40e/web) — the Device Account Number, Secure Element storage, and payment authorization model for on-device tokenization
* [Apple Pay component security — Apple Platform Security](https://support.apple.com/guide/security/apple-pay-component-security-sec2561eb018/web) — how the Secure Element, provisioning, and the dynamic security code work together on the device
* [Payment authorization with Apple Pay — Apple Platform Security](https://support.apple.com/guide/security/payment-authorization-with-apple-pay-secab5b481d5/web) — the per-transaction dynamic security code and how it is generated and verified
* [Google Pay for issuers — Google Pay developer docs](https://developers.google.com/pay/issuers) — the issuer side of cloud tokenization and push provisioning that Google Pay's HCE model relies on
* [Visa Token Service](https://usa.visa.com/products/visa-token-service.html) — a real network Token Service Provider: PAN-to-token mapping, network tokens, and lifecycle management
* [Host card emulation — Wikipedia](https://en.wikipedia.org/wiki/Host_card_emulation) — the software-based contactless model Google Pay uses to present a token without a physical Secure Element, with limited-use keys
* [EMV — Wikipedia](https://en.wikipedia.org/wiki/EMV) — the contactless card standard, the Application Transaction Counter, and application cryptograms this design's single-use cryptogram is modeled on
* [Contactless payment — Wikipedia](https://en.wikipedia.org/wiki/Contactless_payment) — the NFC tap-to-pay capture path at the terminal
* [Payment Card Industry Data Security Standard — Wikipedia](https://en.wikipedia.org/wiki/Payment_Card_Industry_Data_Security_Standard) — the control framework whose scope tokenization reduces by keeping the PAN out of the merchant environment
* [Idempotency](/docs/patterns/reliability/idempotency) — the retry-safety discipline behind the provisioning state machine
* [Sharding](/docs/patterns/storage/sharding) — how the token vault partitions by DPAN to scale de-tokenization
* [Quorum](/docs/patterns/consistency/quorum) — the strong-consistency mechanism the anti-replay counter and vault mapping need
* [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) and [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff) — per-issuer fault isolation on the authorization path
