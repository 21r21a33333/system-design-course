---
title: "Payment Gateway, Processor & Security"
sidebar_position: 5
---

The defining property of a card payment is that a single tap at checkout is not one action but a relay across five independently-operated parties — cardholder, merchant, gateway, processor/acquirer, and issuer, with a card network in the middle — and no one party ever holds the whole picture at once. The roles most people conflate ("gateway" and "processor" get used interchangeably, and both get called "the payment company") do genuinely different jobs, in a genuinely different order, and the security model only makes sense once those jobs are pulled apart. This case study disambiguates the roles, traces the two-phase money flow (a real-time *authorization* hold that is deliberately separate from the *capture* and the deferred *clearing and settlement* that actually moves money), and shows where security lives at each hop — because getting the roles wrong is exactly how a merchant ends up storing card numbers it was never supposed to touch.

This design has the shape of what a modern gateway-plus-processor (Stripe and Adyen are two well-known real examples that provide both roles behind one API) does, grounded in how card authorization, PCI-DSS scope, 3-D Secure, and ISO 8583 messaging actually work.

## Step 1: Outline use cases and constraints

### Use cases

#### We'll scope the problem to handle the following use cases

* A **cardholder** enters a card at a **merchant's** checkout and expects a yes/no answer in a second or two
* The **merchant** never wants to touch, transmit, or store the raw card number if it can avoid it, because doing so drags its entire infrastructure into card-data compliance scope
* A **payment gateway** captures the card details securely, encrypts them in transit, replaces them with a **token**, runs initial validation and fraud pre-screening, and forwards a clean request onward — it is the merchant's single point of contact and the "traffic cop" that shapes the request
* A **payment processor / acquirer** takes that request, encodes it into the card-network wire format, routes it to the right **card network** (Visa, Mastercard), and ultimately moves money between the issuing and acquiring banks
* The **card network** relays the authorization request to the **issuer** (the cardholder's bank), which is the only party that actually checks funds/credit and approves or declines
* The system runs the payment as **two phases**: an **authorization** that places a hold, and a later **capture** that commits it — and separates both from the **clearing and settlement** batch that pays the merchant on a T+1/T+2 cycle
* The system triggers **3-D Secure (3DS)** cardholder authentication where the issuer or risk rules demand a step-up challenge
* Every hop is designed to keep the **PCI-DSS** blast radius small — tokenization and hosted fields exist specifically to remove card data from where it does not need to be

#### Out of scope

* The issuer's own core-banking funds check and credit-limit logic — treated as an external dependency the network calls
* Fraud/risk scoring internals (a substantial system of its own) — named as a real pre-authorization step, not designed here
* Chargebacks, disputes, and representment workflows beyond a brief mention
* Alternative rails (ACH, real-time bank transfers, wallets that are not card-backed) — this case study is specifically about a *card* payment
* Currency conversion and cross-border interchange nuance

### Constraints and assumptions

#### State assumptions

* A mid-to-large gateway/processor handles on the order of **hundreds of millions of card transactions per day** across all its merchants; the design must shard from the start, unlike the correctness-bound-but-low-volume generic payment-processor case study elsewhere in this course
* **Authorization is not settlement.** Approval places a hold on the cardholder's available credit; the money does not actually move at approval time. Capture commits the charge; clearing and settlement pay the merchant later, typically **T+1 or T+2**. Conflating these is the most common conceptual error a practitioner makes.
* An authorization must be **exactly-once from the cardholder's point of view** — a retried request after a timeout must never place a second hold or, worse, capture twice
* The raw **PAN** (primary account number) must exist in the clear on as few systems as possible; every hop that can operate on a **token** instead of a PAN does so, to shrink PCI-DSS scope
* Availability must be very high: an online store whose gateway is down cannot take money at all, which is a direct revenue outage
* Latency budget for the interactive authorization is a **couple of seconds**, dominated by the network-to-issuer round-trip, not by the gateway's own processing

#### Calculate usage

* Authorization volume: assume **300,000,000 authorizations/day** → 300,000,000 / 86,400 ≈ **~3,500 auths/sec average**. Card traffic is sharply peaked around retail hours, paydays, and sale events — design for roughly **8x average at peak**, so on the order of **~28,000 auths/sec** at the processor. This is high-throughput, so the processor core shards by merchant and cannot be a single coordinator.
* Message fan-out: one authorization is several messages (merchant → gateway, gateway → processor, processor → network → issuer, and the responses back), so **one auth is roughly 5–6 hops** → at peak the internal fabric carries on the order of **~150,000 messages/sec**.
* Transaction record size: an auth/capture record (`transaction_id`, `merchant_id`, token reference, `amount_minor`, `currency`, `state`, network `rrn`/`stan`, `auth_code`, timestamps, small metadata) ≈ **~400 bytes/record**. Auths plus captures plus refunds land in the low billions of rows/day → **on the order of ~150–250 GB/day** of transaction log — large enough that the ledger must shard and tier to cold storage, and reconciliation runs as a distributed job.
* Token vault lookups: every non-first transaction on a stored card resolves a token to a PAN inside the secure vault only at the last possible moment (network submission), while most of the pipeline carries only the token → on the order of **~1 token resolution per authorization**, served exclusively from the hardened PCI zone.
* Settlement compression: instead of settling every one of the ~300M daily auths individually against a bank, the processor batches captured transactions into **clearing files** and nets them, so settlement postings are orders of magnitude fewer than authorizations, and **interchange fees are deducted at settlement**, not at auth time.

## Step 2: Create a high-level design

![One card payment across five roles: cardholder to merchant to payment gateway which encrypts and tokenizes, to payment processor and acquirer which speaks ISO 8583 to the card network Visa or Mastercard, on to the issuing bank which approves or declines, with the approval flowing back and settlement handled as a separate deferred batch](/img/case-studies/fintech/payment-gateway-vs-processor-overview.svg)

Start with the roles, because everything else follows from getting them straight.

The **cardholder** enters a card at the **merchant's** checkout. The merchant is a store, not a bank — it wants the money and wants to touch the card as little as possible. The **payment gateway** is the merchant's first point of contact and the entity that actually receives the card details. Its jobs are front-of-house: validate that the card number, expiry, and card-verification value are well-formed, optionally run an address-verification and fraud pre-screen, **encrypt the data in transit**, **tokenize it** so downstream systems and the merchant's own records never carry the raw PAN, and **forward** the request. A useful mental model from the source material: the gateway is the *traffic cop* that decides the request is well-shaped and routes it onward — it does not itself check whether the cardholder has money.

The **payment processor** (working on behalf of the **acquiring bank**, the merchant's bank) is back-of-house. It takes the gateway's forwarded request, encodes it into the card networks' wire format (**ISO 8583**), and routes it to the correct **card network**. Crucially, Visa and Mastercard are *networks*, not banks and not processors: they do not check funds or issue cards themselves. They relay the authorization request from the processor to the **issuing bank** — the cardholder's bank — which is the *only* party that checks available funds or credit and returns an **approve or decline**. That approval travels back the way it came: issuer → network → processor → gateway → merchant → "payment successful."

Two structural facts make a card flow different from a bank-to-bank transfer like UPI. First, **the approval is only a hold, not a movement of money.** Authorization reserves funds against the cardholder's credit; the actual money is moved later, in **capture** and then in a **deferred clearing-and-settlement batch** where the processor nets the day's captured transactions, the networks deduct **interchange fees**, and the merchant is paid on a **T+1/T+2** cycle. Second, **security is layered by role**: encryption protects data *in transit* on the merchant-to-gateway leg; tokenization protects data *at rest* everywhere downstream; and the PAN is only ever de-tokenized inside a hardened vault at the last moment before the network call. The design below is organized around making the fast authorization leg correct and exactly-once, while keeping raw card data confined to the smallest possible set of systems.

## Step 3: Design core components

### Use case: Gateway tokenizes the card so the PAN leaves the merchant's scope

The single most consequential thing the gateway does for security is replace the card number with a **token** as early as possible. The distinction the source material draws is exact and worth preserving: **encryption** protects data *in transit* and is reversible with the key, so encrypted card data that leaks is still card data to anyone who obtains the key; **tokenization** replaces the PAN with a surrogate value that has no mathematical relationship to the card, so a leaked token is useless off the vault that maps it back. Encryption is for the journey; tokenization is for storage. A modern gateway does both — encrypts the collection leg, then tokenizes so nothing downstream (including the merchant's own database) ever persists a PAN.

**Core spec: gateway tokenization / vault call**

```python
import hashlib
import hmac
import secrets

class TokenVault:
    """The vault is the ONLY component that stores the PAN-to-token
    mapping, and it lives inside the hardened PCI-DSS zone (typically
    fronted by an HSM). Everything else in the pipeline carries the
    token, never the PAN. This function shows the tokenize path; the
    reverse (detokenize) is callable only by the processor's network
    submitter, at the last moment before an ISO 8583 message is built.
    """

    def __init__(self, store, pepper: bytes):
        self._store = store        # PAN-hash -> token record, inside the PCI zone
        self._pepper = pepper      # HSM-held secret; makes the hash non-reversible by brute force

    def _fingerprint(self, pan: str) -> str:
        # A keyed hash lets the vault recognise the SAME card again
        # (so one card gets one stable token) without storing the PAN
        # in a reversible form outside the encrypted record itself.
        return hmac.new(self._pepper, pan.encode(), hashlib.sha256).hexdigest()

    def tokenize(self, pan: str, expiry: str) -> str:
        if not _luhn_valid(pan):
            raise ValueError("card number fails Luhn check")
        fp = self._fingerprint(pan)
        existing = self._store.get_by_fingerprint(fp)
        if existing is not None:
            return existing.token          # stable token for a card already seen
        token = "tok_" + secrets.token_urlsafe(24)
        self._store.put(
            fingerprint=fp,
            token=token,
            encrypted_pan=self._store.encrypt(pan),   # AES via HSM key, at rest
            last4=pan[-4:],
            expiry=expiry,
        )
        return token


def _luhn_valid(pan: str) -> bool:
    """Luhn checksum -- the same mod-10 check a gateway runs to reject
    a mistyped card before it ever reaches the network.
    """
    digits = [int(c) for c in pan if c.isdigit()]
    if len(digits) < 12:
        return False
    checksum = 0
    parity = len(digits) % 2
    for i, d in enumerate(digits):
        if i % 2 == parity:
            d *= 2
            if d > 9:
                d -= 9
        checksum += d
    return checksum % 10 == 0
```

**Data structures:** a single `token_vault` record — `fingerprint` (keyed HMAC of the PAN, the dedup key), `token` (the surrogate handed out everywhere), `encrypted_pan` (AES-encrypted under an HSM-held key), `last4`, `expiry`. The merchant's own database stores **only** `token` and `last4`, never the PAN. This is the whole game for PCI-DSS scope reduction: the merchant persists a token that is worthless without the vault.

**Trade-offs:**
* **The gotcha:** it is tempting to treat "we encrypt the card number in our database" as equivalent to tokenization. It is not — encrypted card data is *recoverable* with the key, so the database, the key-management system, and every operator with access to both remain squarely in PCI-DSS scope, and a breach that grabs both ciphertext and key exposes real cards. Tokenization removes the PAN from those systems entirely: there is no key that turns a merchant-side token back into a card, because the mapping lives only in the vault the merchant never holds. The fix is to tokenize at the earliest hop and let the raw PAN exist only inside the vault/HSM zone.
* A stable token per card (via the fingerprint) is what makes card-on-file, recurring billing, and network tokenization possible without the merchant ever re-collecting the number — at the cost that the vault must treat the fingerprint index as sensitive, since it links repeat purchases by the same card.

**REST API:**

```
$ curl -X POST https://api.gateway.example/v1/tokens \
    -H "Authorization: Bearer sk_test_merchant_key" \
    -H "Idempotency-Key: tok-req-9f2a71c0" \
    -d "card[number]=4242424242424242" \
    -d "card[exp_month]=12" \
    -d "card[exp_year]=2028" \
    -d "card[cvc]=123"
```

Response:

```json
{
  "id": "tok_3PxQ1a9fKz7wLmN2",
  "type": "card",
  "card": {
    "brand": "visa",
    "last4": "4242",
    "exp_month": 12,
    "exp_year": 2028
  },
  "created": "2026-08-12T09:14:07Z"
}
```

In production the merchant's browser posts the card straight to the gateway's **hosted fields** or an iframe, so the PAN never transits the merchant's own server at all — the `curl` above stands in for that direct-to-gateway collection.

### Use case: Authorization request and response as an ISO 8583 field map

Once the processor has a request, it must speak the card networks' language. Card authorization messages are **ISO 8583** — a fixed message-type-indicator plus a bitmap that says which numbered data elements are present, followed by those elements. This is the actual wire artifact the processor builds; showing it makes concrete what "the processor talks to the networks" means.

**Core spec: authorization request/response (ISO 8583-style field map)**

```python
# ISO 8583 authorization REQUEST (MTI 0100) -- the processor builds this
# from the gateway's tokenized request, detokenizing the PAN (DE 2) only
# here, at network submission, inside the PCI zone.
auth_request = {
    "MTI": "0100",                       # Authorization Request
    "DE2":  "424242XXXXXX4242",          # Primary Account Number (PAN)
    "DE3":  "000000",                    # Processing code: 00 = purchase
    "DE4":  "000000004999",             # Amount, minor units: 4999 = $49.99
    "DE7":  "0812091407",                # Transmission date/time (MMDDhhmmss)
    "DE11": "004821",                    # STAN: systems trace audit number
    "DE14": "2812",                      # Card expiry (YYMM)
    "DE18": "5732",                      # Merchant category code (MCC)
    "DE22": "051",                       # POS entry mode: 05 = chip, 1 = PIN cap.
    "DE41": "TERM0007",                  # Card acceptor terminal id
    "DE42": "MERCHANT-ACME-000123",      # Card acceptor (merchant) id
    "DE49": "840",                       # Currency: 840 = USD
}

# ISO 8583 authorization RESPONSE (MTI 0110) -- issuer's answer, relayed
# back through the network and processor to the gateway.
auth_response = {
    "MTI": "0110",                       # Authorization Response
    "DE11": "004821",                    # STAN echoed back -> matches the request
    "DE38": "A1B2C3",                    # Authorization code (present when approved)
    "DE39": "00",                        # Response code: 00 = APPROVED
    "DE37": "412345678901",              # Retrieval reference number (RRN)
}

APPROVAL_CODES = {
    "00": "approved",
    "05": "do_not_honor",
    "51": "insufficient_funds",
    "54": "expired_card",
    "14": "invalid_card_number",
    "91": "issuer_unavailable",          # retry / stand-in territory
}

def interpret_auth(response: dict) -> tuple[bool, str]:
    """DE39 is the single field that says yes or no. DE38 (auth code)
    is only meaningful on an approval, and DE11 (STAN) MUST match the
    request so a response is never applied to the wrong transaction.
    """
    code = response["DE39"]
    approved = code == "00"
    return approved, APPROVAL_CODES.get(code, "declined_other")
```

**Data structures:** a `transactions` row keyed by an internal `transaction_id`, carrying the network's `stan` (DE11) and `rrn` (DE37) as the cross-party correlation ids, `auth_code` (DE38), `response_code` (DE39), `amount_minor`, `currency` (numeric, DE49), token reference, `merchant_id`, `state`, and timestamps. Amounts are stored in **minor units as integers** (cents), never floats, so rounding can never create or destroy money.

**Trade-offs:**
* **The gotcha:** the STAN (DE11) and RRN (DE37) are not decoration — they are how a response gets matched back to the exact request across parties that each keep their own records. If the processor applies an authorization response by amount-and-card alone rather than by matching the echoed STAN, two near-simultaneous auths for the same card can have their responses swapped, approving the wrong one. The fix is that the response's echoed trace fields must match the outstanding request before the outcome is recorded.
* DE39 is the ground truth for approve/decline, but a `91` (issuer unavailable) is categorically different from a `51` (insufficient funds): the former is a *retryable* infrastructure failure that networks sometimes cover with stand-in processing, the latter is a definitive decline that must never be silently retried. Treating all non-`00` codes as one bucket loses exactly the distinction that decides whether a retry is safe.

### Use case: Authorization, capture, and settlement as a state machine

The most important idea in a card flow, and the one most often misunderstood, is that **approval is not payment**. A card charge is a two-phase (often three-phase) money flow: **authorize** places a hold, **capture** commits the amount, and **clearing/settlement** actually moves money on a deferred cycle. Modeling this as an explicit state machine keeps the phases from being conflated — and makes the difference between "the customer's card was approved" and "the merchant has the money" legible.

**Core spec: auth-then-capture state machine**

```
                       ┌──────────────┐
   token + amount      │ AUTHORIZING  │  <- ISO 8583 0100 sent to issuer
   ───────────────────▶│              │     via network; awaiting 0110
                       └──────┬───────┘
              DE39 != 00      │      │  DE39 == 00
             (declined)       ▼      ▼
              ┌───────────┐        ┌──────────────┐
              │ DECLINED  │        │ AUTHORIZED   │  <- hold placed on card;
              │(terminal) │        │ (hold active)│     NO money moved yet
              └───────────┘        └──────┬───────┘
                                 capture  │      │  no capture before expiry
                                 request  ▼      ▼   (e.g. 7 days)
                              ┌───────────┐   ┌───────────────┐
                              │ CAPTURED  │   │ AUTH_EXPIRED  │
                              │ (queued   │   │ (hold dropped,│
                              │  for      │   │  terminal)    │
                              │  clearing)│   └───────────────┘
                              └─────┬─────┘
                    clearing/settlement batch (T+1 / T+2)
                                    ▼
                              ┌───────────┐
                              │ SETTLED   │  <- funds paid to merchant,
                              │ (terminal)│     interchange deducted
                              └─────┬─────┘
                          refund    │
                          request   ▼
                              ┌───────────┐
                              │ REFUNDED  │  <- new reverse entry,
                              │ (terminal)│     never an in-place edit
                              └───────────┘

Key transitions and why they exist:
  * AUTHORIZED -> CAPTURED: the merchant confirms the sale (e.g. goods
    shipped). Capture can be for the full amount or LESS (a partial
    capture); the leftover hold is released.
  * AUTHORIZED -> AUTH_EXPIRED: an uncaptured hold lapses on its own.
    This is why "card approved" is not "merchant paid".
  * CAPTURED -> SETTLED: happens in the deferred clearing batch, not
    inline -- this is where interchange is netted out.
  * SETTLED -> REFUNDED: a completed sale is undone with a new, linked
    reverse transaction, never by mutating the original record.
```

```python
VALID_TRANSITIONS = {
    "AUTHORIZING": {"AUTHORIZED", "DECLINED"},
    "AUTHORIZED":  {"CAPTURED", "AUTH_EXPIRED", "VOIDED"},
    "CAPTURED":    {"SETTLED"},
    "SETTLED":     {"REFUNDED"},
    # terminal states have no outgoing transitions
    "DECLINED": set(), "AUTH_EXPIRED": set(), "VOIDED": set(), "REFUNDED": set(),
}

def advance(transaction, new_state):
    """Enforce the auth/capture/settlement lifecycle. A transition that
    is not in the table is a bug (e.g. trying to CAPTURE a DECLINED
    auth, or SETTLE something that was never captured) and is refused
    rather than silently applied.
    """
    allowed = VALID_TRANSITIONS.get(transaction.state, set())
    if new_state not in allowed:
        raise ValueError(
            f"illegal transition {transaction.state} -> {new_state}"
        )
    transaction.state = new_state
    return transaction
```

**Data structures:** the `transactions` row's `state` column moves only along `VALID_TRANSITIONS`; a separate immutable `transaction_events` append-only log records every transition with its ISO 8583 correlation ids, so the current state is always *derivable* from the event history and never depends on a single mutable field being right.

**Trade-offs:**
* **The gotcha:** treating an approved authorization as "paid" is the classic error — it leads merchants to ship goods against a hold that later never gets captured, or to double-count revenue that has not settled. The machine makes `AUTHORIZED` and `SETTLED` distinct terminal-adjacent states precisely so "the issuer said yes" and "the money arrived, minus interchange, on T+1" cannot be confused.
* A hold consumes the cardholder's available credit until captured or expired, so an auth that is never captured or voided is not harmless — it strands the customer's funds. A disciplined flow **voids** an authorization it will not capture, rather than leaving it to expire on its own.

**REST API:**

```
$ curl -X POST https://api.gateway.example/v1/payment_intents \
    -H "Authorization: Bearer sk_test_merchant_key" \
    -H "Idempotency-Key: pay-order-44210" \
    -d "amount=4999" \
    -d "currency=usd" \
    -d "payment_method=tok_3PxQ1a9fKz7wLmN2" \
    -d "capture_method=manual" \
    -d "confirm=true"
```

Response:

```json
{
  "id": "pi_3PxR8b2gLm9qZ",
  "object": "payment_intent",
  "amount": 4999,
  "currency": "usd",
  "status": "requires_capture",
  "latest_charge": {
    "authorization_code": "A1B2C3",
    "network_rrn": "412345678901"
  }
}
```

The `capture_method: manual` plus a `requires_capture` status is exactly the auth-hold-then-capture-later split above: the issuer approved and placed a hold, but no money moves until a separate capture call commits it.

### Use case: 3-D Secure steps up cardholder authentication

For card-not-present (online) payments, the issuer often wants proof that the person entering the card *is* the cardholder, not just someone who has the number. **3-D Secure (3DS)**, governed by EMVCo, adds an authentication exchange across three domains — the acquirer's, the network's directory server, and the issuer's access control server — before or during authorization. When 3DS produces a successful authentication, liability for fraud typically shifts to the issuer, which is why gateways route eligible transactions through it.

**Core spec: 3DS authentication decision before authorization**

```python
def run_3ds(txn, threeds_server):
    """Decide whether a transaction needs a 3DS challenge, and gate the
    authorization on its outcome. Modern 3DS (2.x) is often FRICTIONLESS:
    the issuer's risk engine approves the authentication from device and
    transaction signals with no user interaction. A challenge (OTP,
    app approval) is only stepped up when the issuer wants it.
    """
    result = threeds_server.authenticate(
        pan_token=txn.token,
        amount_minor=txn.amount_minor,
        currency=txn.currency,
        device_data=txn.browser_fingerprint,   # 3DS2 risk signals
    )

    match result.status:
        case "frictionless_approved":
            # Issuer authenticated silently; carry the proof into auth.
            txn.threeds_cryptogram = result.cavv     # authentication value
            txn.eci = result.eci                     # e-commerce indicator
            return "PROCEED_TO_AUTH"
        case "challenge_required":
            # Issuer wants a step-up: OTP / biometric / app tap.
            return "CHALLENGE"                        # pause, collect, re-check
        case "authentication_failed":
            return "BLOCK"                            # do not authorize
        case _:
            # 3DS not available for this card/issuer -> proceed without
            # the liability shift, per the merchant's risk policy.
            return "PROCEED_TO_AUTH"
```

**Data structures:** the 3DS outcome adds `threeds_cryptogram` (the CAVV, the cryptographic proof of authentication) and `eci` (the e-commerce indicator, encoding whether and how 3DS ran) to the transaction; both are carried into the ISO 8583 authorization so the issuer sees that authentication already succeeded.

**Trade-offs:**
* **The gotcha:** older 3DS (1.0) redirected every eligible payment to a clunky full-page password challenge, and the friction measurably cost conversions. 3DS2's frictionless flow fixes this by letting the issuer authenticate from device and transaction risk signals with no user step in the common case — a challenge is stepped up only when risk warrants it. Blindly challenging every transaction trades fraud loss for cart abandonment; the point of 3DS2 is to challenge selectively.
* A successful 3DS authentication generally **shifts fraud-chargeback liability to the issuer**, which is a strong economic reason to route through it — but it is authentication, not authorization: 3DS answers "is this the real cardholder," while the subsequent ISO 8583 auth still answers "are there funds." Both must pass.

### Use case: Clearing, settlement, and interchange netting

Authorization is real-time; getting the merchant paid is not. After capture, transactions accumulate into **clearing files** the processor submits to the networks, and money is moved between the issuing and acquiring banks in a **deferred settlement** cycle (**T+1/T+2**). At settlement, **interchange fees** — set by the networks and paid to the issuer — are deducted, so the merchant receives the transaction amount *minus* interchange (and the acquirer's markup). This is why the amount authorized and the amount that lands in the merchant's bank differ.

**Core spec: settlement / interchange netting calc**

```python
from dataclasses import dataclass

@dataclass
class CapturedTxn:
    transaction_id: str
    amount_minor: int          # cents, what the cardholder was charged
    interchange_bps: int       # interchange rate in basis points (per network schedule)
    interchange_fixed_minor: int   # flat per-transaction interchange component

def interchange_for(txn: CapturedTxn) -> int:
    """Interchange is typically a percentage (basis points) PLUS a flat
    per-transaction fee -- e.g. 175 bps + 10c for a given card/MCC. All
    integer minor units; round half-up once, at the point of deduction.
    """
    variable = (txn.amount_minor * txn.interchange_bps + 5000) // 10000
    return variable + txn.interchange_fixed_minor

def settle_batch(captured, acquirer_markup_minor_per_txn: int):
    """Net a day's captured transactions into what the merchant is
    actually paid. Gross = sum charged; interchange + acquirer markup
    are deducted; the remainder is the merchant payout. Debits and
    credits must net exactly -- money is only moved, never created.
    """
    gross = sum(t.amount_minor for t in captured)
    total_interchange = sum(interchange_for(t) for t in captured)
    total_markup = acquirer_markup_minor_per_txn * len(captured)
    merchant_payout = gross - total_interchange - total_markup

    # Reconciliation invariant: every cent is accounted for.
    assert gross == merchant_payout + total_interchange + total_markup
    return {
        "gross_minor": gross,
        "interchange_minor": total_interchange,
        "acquirer_markup_minor": total_markup,
        "merchant_payout_minor": merchant_payout,
    }
```

**Data structures:** a `settlement_batch` record per cycle — `batch_id`, `merchant_id`, `gross_minor`, `interchange_minor`, `acquirer_markup_minor`, `merchant_payout_minor`, `network_clearing_file_ref`, `value_date` (the T+1/T+2 date funds land) — plus per-transaction `settlement_line` rows linking each captured transaction to its batch, so a payout is always traceable to the exact transactions that composed it.

**Trade-offs:**
* **The gotcha:** because settlement is deferred and netted, the merchant's bank deposit will not match the sum of the day's approvals — it is gross *minus* interchange and fees, and it lands a day or two later. A merchant reconciling "approvals today" against "deposit today" will always see a mismatch and may think money is missing. The fix is that reconciliation is done against the **network clearing file and the settlement batch**, by `value_date`, not against the real-time authorization stream.
* Representing amounts and fees as integer minor units with a single explicit rounding step (`+ 5000) // 10000` for half-up on basis points) is deliberate: doing interchange math in floating point accumulates fractions of a cent across millions of transactions until the batch fails to net, which is exactly the drift the reconciliation `assert` is there to catch.

## Step 4: Scale the design

![Gateway and processor at scale: merchant sites using hosted fields, a gateway edge doing TLS termination, tokenization to an HSM-backed vault, 3-D Secure step-up, idempotency and fraud pre-screen, a processor core doing ISO 8583 encoding, network routing, per-network circuit breakers and an auth/capture state machine sharded by merchant, the card networks and issuing banks, and a separate deferred settlement engine with a reconciled append-only transaction ledger](/img/case-studies/fintech/payment-gateway-vs-processor-scaled.svg)

* **The processor core shards by merchant so no single coordinator sits on the path of all ~28,000 auths/sec at peak** — see [Sharding](/docs/patterns/storage/sharding). Almost every read and write is scoped to one merchant's transactions, so `merchant_id` is a natural shard key that keeps the hot authorization path free of cross-shard transactions.
* **Idempotency lives at the gateway edge, keyed per logical payment attempt**, so a merchant's retry after a timeout replays the recorded outcome instead of placing a second hold or capturing twice — see [Idempotency](/docs/patterns/reliability/idempotency). This is the same discipline Stripe's idempotency-key protocol enforces in production, applied to a multi-hop card flow.
* **Each card-network integration gets a [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) and [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff), applied per network.** Networks and issuers fail independently; a breaker that trips on a struggling network fails those auths fast (surfacing a `91`-style issuer-unavailable rather than hanging) instead of holding threads, and retries must carry the same trace identity so a retry can never become a second authorization. Bounding one network's failures away from the rest is the [Bulkhead](/docs/patterns/reliability/bulkhead) idea applied to network adapters.
* **The auth-then-capture flow is coordinated as a saga, not a distributed lock across the merchant, processor, and issuer** — see [Saga](/docs/patterns/consistency/saga). Authorization, capture, and refund are independent local commits with explicit compensations (void an uncaptured hold; issue a reverse entry to undo a settled charge), which is why holding a blocking [Two-Phase Commit](/docs/patterns/consistency/two-phase-commit) across parties whose round-trips take seconds is the wrong tool here.
* **The token vault is isolated in its own hardened PCI zone, fronted by an HSM, and scaled independently of the rest of the pipeline** — because the whole pipeline carries tokens, the vault only participates at collection (tokenize) and network submission (detokenize), so it is a small, security-critical service, not a hot path component.
* **The transaction ledger is append-only and sharded, and reconciled against the network clearing files off the hot path** — see [Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication) for serving status reads from replicas, while settlement and reconciliation run as independent batch jobs that compare the ledger to the networks' own record of what cleared.

## Additional talking points

* **PCI-DSS scope is the reason the roles are split the way they are.** The Payment Card Industry Data Security Standard applies to every system that stores, processes, or transmits cardholder data. Tokenization and hosted fields (an iframe or gateway-hosted form so the PAN posts directly to the gateway, never to the merchant's server) exist specifically to *remove* the merchant's systems from that scope, shrinking the merchant from a full on-site assessment toward the lightest self-assessment tier. The design's insistence that only the gateway edge and the vault ever touch a PAN is a scope-minimization decision, not just a security nicety.
* **Encryption versus tokenization is a scope distinction, not just a security one.** Encrypted card data is still cardholder data for compliance purposes — the systems holding the ciphertext and the key are in scope. Tokenized data, where the merchant holds only a surrogate with no path back to the PAN, is designed to be *out* of scope. Conflating the two is how a team believes it has reduced its compliance burden when it has only added a decryptable copy of the card.
* **Authorization, capture, and settlement have genuinely different failure modes.** A failed authorization is a clean decline the customer sees immediately. A failed capture (of a valid auth) strands a hold on the customer's card. A settlement discrepancy is invisible at checkout and only surfaces in reconciliation days later. A practitioner must instrument all three, not just the interactive auth, because the money-actually-moved failures are the quiet ones.
* **Chargebacks and dispute liability ride on top of this flow.** A cardholder disputing a settled charge triggers a chargeback that reverses funds from the merchant, with the network as arbiter — and whether the merchant or the issuer eats the loss often depends on whether 3-D Secure authenticated the transaction. This is why the 3DS liability shift is an economic lever, not just a fraud control.
* **Fraud and risk scoring sit in front of authorization.** The gateway's pre-screen (address verification, velocity checks, device signals) and the issuer's own risk engine both run before money can move, so an obviously fraudulent request is declined before it consumes a hold. This is a substantial system of its own, deliberately out of scope here but named as a real pre-auth stage.
* **Reconciliation is a standing process, not a failure afterthought.** The processor continuously compares its ledger of authorizations and captures against the networks' clearing files and the acquirer's settlement records, catching drift — a capture the ledger shows that never appeared in a clearing file, or a settled amount that does not match interchange expectations. This is defense-in-depth on top of the request-time state machine.

## Source(s) and further reading

* [Payment gateway — Wikipedia](https://en.wikipedia.org/wiki/Payment_gateway) — consolidated reference for the gateway's front-of-house role: capturing and validating card details, encrypting in transit, and forwarding the authorization request
* [Payment processor — Wikipedia](https://en.wikipedia.org/wiki/Payment_processor) — the processor/acquirer role, its relationship to the acquiring bank, and how it relays authorization and settlement between the merchant and the card networks
* [ISO 8583 — Wikipedia](https://en.wikipedia.org/wiki/ISO_8583) — the message-type-indicator, bitmap, and numbered data elements (PAN, processing code, amount, STAN, RRN, response code) that make up a real card authorization message
* [Authorization hold — Wikipedia](https://en.wikipedia.org/wiki/Authorization_hold) — why an approved authorization is a hold on available credit, not a movement of money, and how capture commits it
* [Interchange fee — Wikipedia](https://en.wikipedia.org/wiki/Interchange_fee) — the network-set fee paid to the issuer that is deducted at settlement, explaining why a merchant's payout differs from the amount charged
* [3-D Secure — Wikipedia](https://en.wikipedia.org/wiki/3-D_Secure) — the three-domain cardholder-authentication protocol, its 2.x frictionless flow, and the fraud-liability shift
* [3-D Secure — EMVCo](https://www.emvco.com/emv-technologies/3-d-secure/) — the standards body's overview of the EMV 3-D Secure specification this design's 3DS step-up follows
* [Payment Card Industry Data Security Standard — Wikipedia](https://en.wikipedia.org/wiki/Payment_Card_Industry_Data_Security_Standard) — the standard whose scope tokenization and hosted fields are designed to reduce
* [PCI Security Standards Council — Document Library](https://www.pcisecuritystandards.org/document_library/) — the primary source for the current PCI-DSS requirements and self-assessment questionnaires referenced above
* [Stripe — Payment Intents API](https://docs.stripe.com/payments/payment-intents) — a production auth-then-capture model matching this design's state machine, including manual capture and the `requires_capture` status
* [Stripe — Place a hold on a payment method (capture later)](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method) — the real auth-hold-then-capture split this case study's state machine mirrors
* [Stripe — Tokens API](https://docs.stripe.com/api/tokens) — a real tokenization endpoint matching this design's gateway token call, where the card is exchanged for a surrogate the merchant can store
* [Idempotency](/docs/patterns/reliability/idempotency) — the exactly-once guard the gateway applies so a retried payment never double-authorizes
* [Saga](/docs/patterns/consistency/saga) — the authorize/capture/refund coordination with compensating voids and reversals
* [Two-Phase Commit](/docs/patterns/consistency/two-phase-commit) — the blocking alternative this design weighs and rejects for cross-party coordination
* [Sharding](/docs/patterns/storage/sharding) — how the processor partitions state by merchant to scale past a single coordinator
* [Circuit Breaker](/docs/patterns/reliability/circuit-breaker), [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff), and [Bulkhead](/docs/patterns/reliability/bulkhead) — per-network fault isolation on the processor's network adapters
* [Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication) — serving transaction-status reads from replicas while settlement reconciliation runs off the write path
