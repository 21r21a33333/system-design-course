---
title: "Design UPI — Real-Time Payments"
sidebar_position: 1
---

UPI's defining property is that it is a real-time, interoperable payment *switch* that moves money between any two bank accounts in the country without ever holding a rupee itself, and without either party ever seeing the other's account number. That constraint — authorize and record a transfer between two independently-operated banks in a couple of seconds, correctly, at a volume now measured in hundreds of millions of transactions per day, while the actual interbank money settlement happens later in batched net cycles — is what shapes every decision below. The hard part is not moving the money; it is making a distributed authorization across four parties (payer app, central switch, payee app, and two banks) either fully happen or fully not happen, exactly once, even when any of those four parties times out mid-flow.

UPI (Unified Payments Interface) is operated by the National Payments Corporation of India (NPCI) and regulated by the Reserve Bank of India (RBI); it launched in 2016 and runs on top of the older IMPS (Immediate Payment Service) interbank rails. This case study designs a system with UPI's shape, grounding each component in how UPI actually works.

## Step 1: Outline use cases and constraints

### Use cases

#### We'll scope the problem to handle the following use cases

* A **payer** opens a **PSP app** (a payment service provider app, such as one of the popular UPI apps) and initiates a transfer to a **payee**, identified only by a **VPA** (virtual payment address, e.g. `alice@okbank`) or a mobile number — never a raw bank account number
* The system routes that request through a **central switch** (NPCI's role) that resolves the payee's VPA to their bank, orchestrates a debit at the payer's bank and a credit at the payee's bank, and returns a final status to both apps within a couple of seconds
* The system supports both **pay / push** (payer initiates and sends) and **collect / pull** (payee requests money and payer approves) flows over the same rails
* Every transfer is authorized by the payer with an **MPIN** (UPI PIN) as the second factor, on a device already bound to the payer during account linking
* The system guarantees each logical transfer moves money **exactly once** — a retried request for the same transaction reference never produces a second debit
* The system is **interoperable**: any PSP app can pay any other app's user, across any pair of member banks, because they all speak one common switch API
* The switch records a durable, auditable record of every transaction and its terminal status, queryable by both PSPs
* Interbank money **settlement** happens on the underlying rails on a deferred net basis, decoupled from the real-time user-facing authorization

#### Out of scope

* The internal core-banking systems of each bank (how a bank actually holds and updates a customer's balance) — treated as an external dependency the switch calls
* UPI mandates / **AutoPay** for recurring payments — mentioned as a real extension but not fully designed here
* Cross-border UPI interoperability (UPI linked to other countries' fast-payment systems) — a real and growing area, named only in the talking points
* Dispute resolution and chargeback workflows beyond a brief mention
* KYC and bank onboarding of end users

### Constraints and assumptions

#### State assumptions

* On the order of **500 million or more transactions per day** flow through the switch — UPI crossed this range in practice, so the design must be built for that scale from the start, unlike the correctness-bound-but-low-volume payment-processor case study elsewhere in this course
* A transfer must never be **double-debited**, even if the payer app retries after a timeout, or an internal message is redelivered — this is a hard correctness requirement
* A transfer must never be **silently lost**: every accepted request reaches a terminal state (success, failure, or a deemed/timed-out state resolved by reconciliation), and that state is durably recorded and queryable by both PSPs
* End-to-end user-visible latency target is **a few seconds**, dominated by the two banks' own debit/credit authorization round-trips, not by the switch's routing
* No bank account numbers are exposed to counterparties; the **VPA is the only routing handle** an app or user ever sees
* The switch **holds no funds** — it authorizes and records movement in real time; the actual money settlement between banks is **deferred net settlement** in scheduled cycles, a subtlety that matters enormously for how "real time" is defined here
* Availability must be effectively 24×7; a national payment rail that is down is a systemic event, not a degraded feature

#### Calculate usage

* Request volume: assume 500,000,000 transactions/day → 500,000,000 / 86,400 ≈ **~5,800 transactions/sec average**. Indian payment traffic is sharply peaked around salary days, festival sales, and evenings — design for roughly **5x average at peak**, so on the order of **~30,000 transactions/sec** at the switch. This is genuinely high-throughput, so the switch must shard, not run as a single coordinator.
* Each transfer involves multiple hops (payer PSP → switch → payee PSP resolve, then switch → remitter bank debit, then switch → beneficiary bank credit, then status fan-out), so **one user transfer is roughly 4–6 switch-mediated messages** → at peak the switch handles on the order of **~150,000–180,000 internal messages/sec**.
* Transaction record size: a switch-side record (`upi_txn_id`, `rrn`, payer VPA, payee VPA, `amount_paise`, `status`, remitter/beneficiary bank ids, timestamps, and small metadata) ≈ **~400 bytes/record** → 500,000,000/day × 400 bytes ≈ **~200 GB/day**, **~73 TB/year** of transaction log — large enough that the transaction store must shard and tier to cold storage, and that reconciliation runs as a distributed job.
* VPA resolution: every transfer resolves at least the payee VPA (and often the payer's) to a bank + masked account handle → on the order of **~1 billion resolution lookups/day**; these are read-heavy, cacheable within a validity window, and must be fast and consistent enough that a stale mapping never routes money to the wrong account.
* Per-transaction value limit: individual UPI transfers are capped (a common default on the order of ₹1 lakh, i.e. ₹100,000, with higher ceilings for specific categories such as verified merchants) — the design enforces limits at both PSP and switch, so a single request can never move an arbitrarily large sum.
* Settlement: instead of settling every one of the ~500M daily transfers gross, banks settle **net multilateral positions** in periodic cycles, so the settlement engine processes on the order of the number of bank-pairs per cycle, not the number of transactions — orders of magnitude fewer settlement postings than transfers.

## Step 2: Create a high-level design

![UPI four-party model around the NPCI central switch: payer to payer PSP app to central switch to payee PSP app to payee, with the switch orchestrating a debit at the remitter bank and a credit at the beneficiary bank, and interbank settlement handled as deferred net settlement](/img/case-studies/fintech/upi-real-time-payments-overview.svg)

The core of UPI is a **four-party model** with a central switch in the middle. A payer opens their **PSP app** and enters a payee's **VPA** (or picks a contact, or scans a QR that encodes the payee's VPA). The payer authorizes with their **MPIN**. The PSP app packages this as a request and sends it to the **central switch** (NPCI). The switch's first job is to **resolve the payee's VPA** to the payee's bank via the payee's PSP — this is what lets money route to the right account without the payer ever learning the payee's account number. Having resolved both ends, the switch orchestrates the actual money movement as two coordinated legs: it sends a **debit request** to the **remitter bank** (the payer's bank, also called the issuer), and on a successful debit confirmation, a **credit request** to the **beneficiary bank** (the payee's bank). Once both legs confirm, the switch records a terminal success and fans the status back out to both PSP apps, which show "paid" to their respective users.

Two structural facts make this different from a card-network flow or the generic payment-processor case study in this course. First, **the switch never holds funds** — it is pure orchestration and record-keeping. The money moves directly between the two banks' books; the switch's job is to make that movement atomic-enough and recorded exactly once. Second, **"real time" refers to the authorization, not the settlement.** The payer and payee see the transfer complete in seconds, but the banks square up the actual money between themselves later, in **deferred net settlement** cycles, netting all the transfers between each pair of banks into a much smaller number of settlement postings. That decoupling is what lets a real-time experience run at national scale without needing a real-time gross settlement per transfer. The design below is organized around making the fast, user-facing authorization leg correct and exactly-once, while letting the slow settlement leg run as an independent, reconciled batch.

## Step 3: Design core components

### Use case: Switch resolves a VPA to a bank without exposing account numbers

The VPA is the whole reason UPI feels different from the traditional "share your account number, IFSC, and branch" transfer. A VPA is an app-level alias of the form `handle@psp` (for example `alice@okbank`) that the user creates during account linking; it maps, inside the owning PSP and bank, to a real bank account, but that mapping is never exposed to the counterparty. Routing money therefore starts with a resolution step: given a payee VPA, which bank and which (masked) account should the credit leg target?

**Core spec: VPA resolution (address mapping) at the switch**

```python
from dataclasses import dataclass

@dataclass
class ResolvedPayee:
    psp_handle: str        # the PSP that owns the VPA suffix, e.g. "okbank"
    beneficiary_ifsc: str  # routes the credit leg to the right bank
    masked_account: str    # e.g. "XXXXXX4821" -- never the full number
    account_name: str      # for the payer to visually confirm the payee
    is_active: bool

def resolve_vpa(vpa: str, directory, psp_client) -> ResolvedPayee:
    """Resolve a payee VPA to a routable bank handle.

    The switch owns a directory of which PSP handle serves which VPA
    suffix. It does NOT store the payer/payee bank account numbers;
    it delegates the final handle -> account mapping to the owning
    PSP, which returns only a MASKED account plus the account holder
    name for the payer to confirm. This is what keeps account numbers
    out of the counterparty's hands end to end.
    """
    if "@" not in vpa:
        raise ValueError("malformed VPA: expected handle@psp")
    _, suffix = vpa.rsplit("@", 1)

    psp = directory.lookup_psp(suffix)          # which PSP serves "@okbank"
    if psp is None:
        raise LookupError(f"no PSP registered for suffix @{suffix}")

    # Ask the owning PSP to map its own VPA to a masked, routable handle.
    resolved = psp_client.resolve(psp, vpa)     # returns ResolvedPayee
    if not resolved.is_active:
        raise LookupError(f"VPA {vpa} is not active")
    return resolved
```

**Data structures:** a `psp_directory` mapping VPA suffix → PSP endpoint + status; the account-number ↔ VPA mapping itself lives inside each PSP/bank, not in the switch. The payer app receives back only `account_name` and `masked_account` so the human can confirm "yes, that's Alice" before authorizing.

**Trade-offs:**
* **The gotcha:** the tempting shortcut is to cache resolved VPA → account mappings aggressively at the switch to save a round-trip on every transfer. But a VPA can be reassigned or deactivated (a user changes their default bank, or closes an account), and a stale cached mapping would route money to the wrong or a closed account — a correctness failure, not a performance one. The fix is that resolution is **owned by the PSP that serves the suffix and re-validated within a short validity window**, and the final credit still names the beneficiary via the bank's own current mapping — the switch never treats a cached resolution as durable authority for where money lands.
* Keeping the account-number mapping inside the PSP/bank (rather than centralizing it in the switch) also shrinks the blast radius of a switch compromise: the central switch is a routing and record-keeping directory, not a national database of everyone's bank account numbers.

**REST API:**

```
$ curl -X POST https://switch.upi.example/api/v1/vpa/resolve \
    -H "X-PSP-Id: okbank-psp" \
    -H "Signature: <psp-request-signature>" \
    -d '{"vpa": "alice@okbank"}'
```

Response:

```json
{
  "vpa": "alice@okbank",
  "beneficiary_ifsc": "OKBK0001234",
  "masked_account": "XXXXXX4821",
  "account_name": "ALICE K",
  "is_active": true
}
```

### Use case: Payer authorizes a pay (push) transfer with an MPIN

This is the everyday flow: the payer sends money. The security model rests on **two factors bound together** — possession of a device that was registered to the payer during account linking (the first factor, established when the app captured a device fingerprint and the bank bound it to the account), and knowledge of the **MPIN / UPI PIN** (the second factor, a 4–6 digit code the user sets with their bank, never with the app). Critically, the MPIN is entered into a secure component and validated by the *payer's bank*, not by the PSP app or the switch — neither the app nor NPCI ever sees or stores the raw PIN.

**Core spec: pay-request authorization and the two coordinated legs**

```python
def process_pay_request(req, switch, remitter_bank, beneficiary_bank):
    """Orchestrate a push transfer as: reserve idempotency ->
    debit remitter -> credit beneficiary -> record terminal state.

    `req` carries a client-generated `upi_txn_id` (see the next use
    case for why that id is the exactly-once anchor). The MPIN is NOT
    in `req` in plaintext -- it was captured in a secure element and is
    validated by the remitter bank during the debit leg, so the switch
    orchestrates authorization without ever handling the PIN.
    """
    # 1. Exactly-once guard (detailed in the next use case).
    claim = switch.claim_txn_id(req.upi_txn_id)
    if claim.already_terminal:
        return claim.stored_response          # replay a finished result, no second debit
    if not claim.won:
        # We lost the claim race but the winner is still IN_FLIGHT: do NOT
        # start a second debit. Report in-progress and let the caller poll
        # status (or reconciliation, see the next use case) resolve the id.
        return switch.in_flight_response(req.upi_txn_id)

    # 2. Enforce value limit at the switch, defense-in-depth.
    if req.amount_paise > switch.per_txn_limit_paise:
        return switch.finalize(req.upi_txn_id, status="DECLINED_LIMIT")

    # 3. Debit leg: remitter bank validates MPIN + funds, then holds/debits.
    debit = remitter_bank.debit(
        txn_id=req.upi_txn_id, payer_vpa=req.payer_vpa,
        amount_paise=req.amount_paise, auth_token=req.secure_auth_token,
    )
    if not debit.ok:
        return switch.finalize(req.upi_txn_id, status="DECLINED_" + debit.reason)

    # 4. Credit leg: only after a confirmed debit.
    credit = beneficiary_bank.credit(
        txn_id=req.upi_txn_id, payee_vpa=req.payee_vpa,
        amount_paise=req.amount_paise,
    )
    if not credit.ok:
        # Debit succeeded but credit failed: do NOT silently keep the
        # payer's money. Emit a reversal for the debit and record a
        # failed-but-reversed terminal state (see trade-offs).
        remitter_bank.reverse(txn_id=req.upi_txn_id)
        return switch.finalize(req.upi_txn_id, status="FAILED_REVERSED")

    return switch.finalize(req.upi_txn_id, status="SUCCESS", rrn=debit.rrn)
```

**Data structures:** a `transactions` row per transfer — `upi_txn_id` (PK), `rrn` (retrieval reference number, the human-facing transaction id both banks and users quote), `payer_vpa`, `payee_vpa`, `amount_paise`, `status`, `remitter_ifsc`, `beneficiary_ifsc`, `created_at`, `updated_at`. Amounts are stored in **paise (integer)**, never floating point, so no rounding error can create or destroy money.

**Trade-offs:**
* **The gotcha:** the debit leg can succeed while the credit leg fails (the beneficiary bank times out or declines), which would leave the payer debited and the payee not credited — money vanishing from the user's point of view. The fix is that a failed credit after a successful debit **must trigger a reversal of the debit**, and the transaction lands in an explicit `FAILED_REVERSED` state, not a silent failure. This is why the debit is authorized in a way the bank can reverse, and why the switch's job isn't done until it has driven the transfer to a *balanced* terminal state — either both legs happened or neither did.
* Validating the MPIN at the payer's bank rather than at the app or switch is a deliberate trust-minimization: it keeps the credential inside the one party that must be trusted anyway (the account-holding bank) and keeps NPCI and the PSP out of PCI-like credential-handling scope for the PIN.

**REST API:**

```
$ curl -X POST https://switch.upi.example/api/v1/pay \
    -H "X-PSP-Id: gpay-psp" \
    -H "Signature: <psp-request-signature>" \
    -d '{
          "upi_txn_id": "UPI7f3a1c90bob2alice44210",
          "payer_vpa": "bob@axl",
          "payee_vpa": "alice@okbank",
          "amount_paise": 250000,
          "secure_auth_token": "<bank-bound-2fa-token>"
        }'
```

Response:

```json
{
  "upi_txn_id": "UPI7f3a1c90bob2alice44210",
  "rrn": "412345678901",
  "status": "SUCCESS",
  "amount_paise": 250000,
  "completed_at": "2026-08-12T09:14:07Z"
}
```

### Use case: The switch makes each transfer exactly-once via an idempotent transaction id

At ~30,000 transfers/sec across an unreliable network, retries are constant: a payer app that doesn't hear back within its timeout will resend the request, not knowing whether the first attempt debited the account. Without a guard, that retry is a second debit. UPI anchors exactly-once semantics on a **transaction id** (a `upi_txn_id`) that the initiating PSP generates once per logical transfer and reuses across every retry of that same transfer. The switch treats that id as the deduplication key for the whole four-party flow — the same discipline this course's [Idempotency](/docs/patterns/reliability/idempotency) pattern describes, applied to a distributed money movement rather than a single API call.

**Core spec: atomic claim-or-replay on the transaction id**

```sql
CREATE TABLE txn_claims (
    upi_txn_id        VARCHAR(64) PRIMARY KEY,   -- generated once per logical transfer
    status            VARCHAR(24) NOT NULL,      -- 'IN_FLIGHT','SUCCESS','FAILED_REVERSED','DECLINED_*'
    stored_response   JSONB,                     -- exact response to replay on a retry
    rrn               VARCHAR(24),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

```python
def claim_txn_id(store, upi_txn_id):
    """Atomically either claim a brand-new txn id as IN_FLIGHT, or, if
    it already exists, return the current record so the caller can
    replay a terminal result instead of processing a second time.

    The INSERT ... ON CONFLICT DO NOTHING makes the claim a single
    atomic step: two concurrent retries with the same id race on the
    primary key and exactly one wins the insert. The loser reads the
    existing row -- it never gets to start a second debit.
    """
    inserted = store.execute(
        """
        INSERT INTO txn_claims (upi_txn_id, status)
        VALUES (%s, 'IN_FLIGHT')
        ON CONFLICT (upi_txn_id) DO NOTHING
        RETURNING upi_txn_id
        """,
        (upi_txn_id,),
    )
    if inserted:
        return Claim(won=True, already_terminal=False, stored_response=None)

    row = store.fetch_one(
        "SELECT status, stored_response FROM txn_claims WHERE upi_txn_id = %s",
        (upi_txn_id,),
    )
    terminal = row["status"] != "IN_FLIGHT"
    return Claim(won=False, already_terminal=terminal,
                 stored_response=row["stored_response"])
```

**Data structures:** `txn_claims` above is the durable exactly-once anchor. It is deliberately separate from the fuller `transactions` record: this table's only job is to win-or-replay on the id under concurrency, so it is optimized for a strongly-consistent conditional insert on a single key.

**Trade-offs:**
* **The gotcha:** if the claim and the actual debit are two separate non-atomic steps, a crash *between* claiming the id and issuing the debit leaves a dangling `IN_FLIGHT` row with no money moved — and a retry that reads `IN_FLIGHT` might wait forever. The fix is a **timeout-and-reconcile rule**: an `IN_FLIGHT` claim older than a bounded window is handed to a reconciliation job that asks the remitter bank whether a debit for that `upi_txn_id` actually happened, and drives the row to a real terminal state (this is exactly why the debit is keyed by the same `upi_txn_id` — the bank can answer "did this specific transfer debit?" deterministically). A retry never *guesses* the outcome; it either replays a terminal result or waits for reconciliation to establish one.
* Anchoring on a client-generated id (rather than a switch-generated one) is what makes the payer app's retry safe end to end: the retry carries the *same* id, so the switch recognizes it as the same logical transfer rather than a new one.

### Use case: Payee requests money with a collect (pull) flow

Not every transfer is push. In a **collect** flow the payee initiates: a merchant or a friend sends a *request* for money to the payer's VPA, and the payer receives a notification, reviews it, and either approves it with their MPIN or declines. The money movement, once approved, is identical to the pay flow — the difference is purely in who initiates and the explicit approval step that must precede any debit.

**Core spec: collect-request lifecycle**

```python
def create_collect_request(req, switch, payer_psp_client):
    """Payee asks the switch to solicit a payment from a payer VPA.
    This creates a PENDING request and pushes a notification to the
    payer's PSP -- it does NOT move money. Money only moves if the
    payer later approves, at which point the flow becomes an ordinary
    idempotent pay request keyed by the SAME upi_txn_id.
    """
    txn_id = req.upi_txn_id                      # generated by payee PSP
    switch.claim_txn_id(txn_id)                  # reserve the id up front
    switch.record_collect(txn_id, status="PENDING_APPROVAL",
                          payer_vpa=req.payer_vpa, payee_vpa=req.payee_vpa,
                          amount_paise=req.amount_paise, expires_at=req.expires_at)
    payer_psp_client.notify_collect(req.payer_vpa, txn_id, req.payee_vpa,
                                    req.amount_paise, req.expires_at)
    return {"upi_txn_id": txn_id, "status": "PENDING_APPROVAL"}

def approve_collect(txn_id, secure_auth_token, switch, remitter_bank, beneficiary_bank):
    """Payer approved with MPIN. Re-enter the exact pay path, keyed by
    the same txn_id, so the debit/credit legs and their exactly-once
    guard are shared with the push flow -- no second code path for
    money movement, so no second place for a double-debit bug to hide.
    """
    collect = switch.get_collect(txn_id)
    if collect.status != "PENDING_APPROVAL" or collect.is_expired():
        return switch.finalize(txn_id, status="DECLINED_EXPIRED")
    req = PayRequest(upi_txn_id=txn_id, payer_vpa=collect.payer_vpa,
                     payee_vpa=collect.payee_vpa, amount_paise=collect.amount_paise,
                     secure_auth_token=secure_auth_token)
    return process_pay_request(req, switch, remitter_bank, beneficiary_bank)
```

**Data structures:** a `collect_requests` view over the transaction store — `upi_txn_id`, `payer_vpa`, `payee_vpa`, `amount_paise`, `status` (`PENDING_APPROVAL`/`SUCCESS`/`DECLINED_*`/`EXPIRED`), `expires_at`. It reuses the same `upi_txn_id` and the same money-movement path as pay, so a collect that is approved is just a pay request that happens to have started life as a request.

**Trade-offs:**
* **The gotcha:** collect requests are a phishing surface — a bad actor can send a collect request dressed up as a refund ("approve to receive your money") to trick a user into *paying*. The real mitigation is partly protocol and partly product: a collect request can never *pull* money without the payer's explicit MPIN approval (so no silent debit is possible), collect from unverified entities is rate-limited and increasingly restricted, and the approval screen must state plainly that approving *sends* money. The design keeps the debit strictly gated behind the payer's fresh 2FA approval, never behind mere receipt of the request.
* Reusing the identical debit/credit path for approved collects (rather than a parallel implementation) means the exactly-once guard, reversal logic, and reconciliation all apply uniformly — one money-movement path, tested once.

### Use case: Recording money movement as a balanced, reconcilable ledger

Because the switch orchestrates but does not hold funds, its authoritative record is not a balance — it is a log of *legs*: for each transfer, a debit leg against the remitter and a credit leg against the beneficiary. Representing this as double-entry rows makes the invariant mechanically checkable: across any correct transfer, total debits equal total credits, and across the whole switch log, what left one bank equals what arrived at another.

**Core spec: leg ledger + the balance invariant**

```sql
CREATE TABLE txn_legs (
    leg_id         BIGINT       PRIMARY KEY,
    upi_txn_id     VARCHAR(64)  NOT NULL,        -- groups the two legs of one transfer
    bank_ifsc      VARCHAR(16)  NOT NULL,        -- which bank this leg posts against
    leg_type       VARCHAR(6)   NOT NULL,        -- 'DEBIT' or 'CREDIT'
    amount_paise   BIGINT       NOT NULL,        -- integer paise, always positive
    posted_at      TIMESTAMPTZ  NOT NULL,
    CONSTRAINT leg_type_chk CHECK (leg_type IN ('DEBIT','CREDIT'))
);
CREATE INDEX idx_legs_txn  ON txn_legs (upi_txn_id);
CREATE INDEX idx_legs_bank ON txn_legs (bank_ifsc, posted_at);
```

```python
def transfer_is_balanced(legs):
    """For the two legs of one transfer, total debits must equal total
    credits. Run per-transfer at write time and across a bank's full
    day of legs during settlement reconciliation. Reports rather than
    raises, so the caller decides whether to halt and alert.
    """
    debits  = sum(l["amount_paise"] for l in legs if l["leg_type"] == "DEBIT")
    credits = sum(l["amount_paise"] for l in legs if l["leg_type"] == "CREDIT")
    return debits == credits, debits, credits
```

**Data structures:** `txn_legs` is the durable double-entry record; `idx_legs_txn` answers "show both legs of transfer X" (used by status queries and reconciliation) and `idx_legs_bank` answers "sum this bank's legs for the settlement cycle."

**Trade-offs:**
* **The gotcha:** it is tempting to store amounts as rupees in a floating-point column — and floating point will eventually turn ₹0.01 into a fraction of a paisa and make debits and credits fail to net to zero. The fix is that all amounts are **integer paise**, and the balance check is exact integer equality; money is never represented as a float anywhere in the system.
* This leg ledger is what the **settlement** engine sums: netting each bank's total debits against its total credits over a cycle yields the small number of net positions banks actually settle, rather than settling every transfer gross.

### Use case: Both PSPs query a transfer's status

Because every state transition is written durably to the transaction store before being reported, answering "what happened to `upi_txn_id` X" is a strongly-consistent read keyed by the id or the `rrn`. Both the payer's and payee's PSPs can query it, which matters because a payer app that timed out mid-flow uses exactly this to discover the real outcome rather than blindly retrying.

**REST API:**

```
$ curl https://switch.upi.example/api/v1/txn/UPI7f3a1c90bob2alice44210 \
    -H "X-PSP-Id: gpay-psp" \
    -H "Signature: <psp-request-signature>"
```

Response:

```json
{
  "upi_txn_id": "UPI7f3a1c90bob2alice44210",
  "rrn": "412345678901",
  "status": "SUCCESS",
  "amount_paise": 250000,
  "legs": [
    {"bank_ifsc": "AXLB0000045", "leg_type": "DEBIT",  "amount_paise": 250000},
    {"bank_ifsc": "OKBK0001234", "leg_type": "CREDIT", "amount_paise": 250000}
  ],
  "updated_at": "2026-08-12T09:14:07Z"
}
```

**Trade-offs:**
* A status read must reflect the true current state, not a cached approximation: a payer app deciding whether to retry must not be told "still pending" when the transfer already succeeded, or it may resend and rely on the exactly-once guard as a safety net that should never have been triggered in the first place. The status path therefore reads the authoritative record, tolerating a little more latency for correctness.

## Step 4: Scale the design

![UPI at scale: many interoperable PSP apps behind a switch API gateway, a transaction-id-sharded switch core backed by a strongly-consistent txn-id and VPA store, per-bank adapters with circuit breakers and retries, and a deferred net settlement engine that nets multilateral positions across banks in scheduled cycles](/img/case-studies/fintech/upi-real-time-payments-scaled.svg)

* **The switch shards by transaction id so no single coordinator is on the path of all ~30,000 transfers/sec at peak** — see [Sharding](/docs/patterns/storage/sharding). Because each transfer's exactly-once guard and legs are scoped to one `upi_txn_id`, that id is a natural shard key: all state for one transfer lives on one shard, so the hot claim-or-replay path never needs a cross-shard transaction.
* **The transaction-id (exactly-once) store needs strong consistency, not just availability, because its whole job is to prevent two concurrent retries from both starting a debit.** A conditional insert that could return "not found" to two simultaneous requests for the same id would reintroduce the double-debit. This is a deliberate place to spend consistency budget, using an atomic conditional insert on the id rather than an eventually-consistent cache.
* **Each bank integration gets a [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) and [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff), applied per bank.** Banks fail independently, and one slow bank must not stall the whole switch: a breaker that trips on a struggling bank fails its transfers fast (and reverses any dangling debit) instead of holding threads, while retries against that bank must always carry the same `upi_txn_id` so a retry can never become a second debit. Bounding one bank's failures away from the rest is the [Bulkhead](/docs/patterns/reliability/bulkhead) idea applied to bank adapters.
* **The two-leg debit-then-credit flow is coordinated as a saga, not a distributed lock across both banks** — see [Saga](/docs/patterns/consistency/saga). Holding a two-phase lock across two independently-operated banks for the duration of their authorization round-trips is exactly what [Two-Phase Commit](/docs/patterns/consistency/two-phase-commit) handles poorly; instead the debit and credit are separate local commits with an explicit compensating **reversal** of the debit if the credit fails.
* **VPA resolution scales as a read-mostly, cacheable lookup with a short validity window, served from replicas** — see [Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication). The ~1 billion daily resolutions vastly outnumber writes to the PSP directory, but the final credit still names the beneficiary via the owning bank's current mapping, so a slightly stale replica can speed up routing without ever becoming the authority for where money lands.
* **Settlement runs as an independent batch off the hot path**: the deferred net settlement engine sums each bank's legs over a cycle and posts a small number of net multilateral positions, decoupling the slow interbank money movement from the fast real-time authorization the user sees.

## Additional talking points

* **Real-time authorization versus deferred net settlement.** The single most misunderstood thing about UPI is that "instant" describes the *authorization and record*, while the actual interbank money settles on a **deferred net** basis in scheduled cycles. That decoupling is a feature, not a gap: it lets a real-time user experience run at national volume without a real-time gross settlement per transfer. It also means the switch must hold a correct, reconcilable record independent of whether a given settlement cycle has run yet.
* **Reconciliation as a standing process, not a failure afterthought.** Beyond resolving individual `IN_FLIGHT` timeouts inline, the switch runs periodic reconciliation that (a) checks the leg ledger nets to zero per transfer via `transfer_is_balanced`, and (b) compares the switch's record against each bank's own record of debits and credits, catching drift such as a transfer the switch thinks failed that the remitter actually debited. This is defense-in-depth on top of the request-time exactly-once guard.
* **The two-factor model and where the credential lives.** UPI's second factor is the MPIN, and its defining safety property is *where* it is validated: at the account-holding bank, never at the app or the switch. Combined with device binding established at account linking, this keeps a lost phone or a compromised app from being sufficient to move money, and keeps NPCI and PSPs out of scope for handling the PIN itself.
* **Collect-flow and social-engineering risk.** Because a collect request is a *request* to pay, it is a phishing vector — the mitigation is that no collect can ever debit without fresh MPIN approval, plus rate-limiting and tightening of collect from unverified parties. A practitioner designing on these rails must treat "approve to receive" scams as a first-class threat, not an edge case.
* **Interoperability as the product.** UPI's economic significance comes from every app being able to pay every other app's users across any pair of banks over one common switch API. That interoperability is a design constraint, not an afterthought: the switch API and VPA scheme must be uniform enough that no PSP has a private path, which is also why the exactly-once and reversal semantics have to live at the switch, where all apps meet.
* **Mandates and AutoPay, cross-border, and limits.** Recurring payments (UPI AutoPay via mandates) and cross-border UPI links to other countries' fast-payment systems extend the same rails; per-transaction value limits (a common default on the order of ₹1 lakh, higher for specific verified-merchant categories) are enforced at both PSP and switch as a containment control on any single transfer.

## Source(s) and further reading

* [Unified Payments Interface — Wikipedia](https://en.wikipedia.org/wiki/Unified_Payments_Interface) — consolidated reference for UPI's operator (NPCI), the four-party push-pull model, VPA addressing, MPIN 2FA, AutoPay/mandates, launch year, and current transaction-volume figures
* [Immediate Payment Service (IMPS) — Wikipedia](https://en.wikipedia.org/wiki/Immediate_Payment_Service) — the 24×7 interbank rails UPI is built on top of
* [National Payments Corporation of India — Wikipedia](https://en.wikipedia.org/wiki/National_Payments_Corporation_of_India) — the umbrella operator that runs UPI, IMPS, and India's other retail payment systems
* [Fast payments: design and adoption — BIS Quarterly Review, March 2024](https://www.bis.org/publ/qtrpdf/r_qt2403c.htm) — central-bank analysis situating UPI as a fast-payment system, its NPCI governance, alias-based addressing, deferred net settlement, and non-bank participation ([PDF](https://www.bis.org/publ/qtrpdf/r_qt2403c.pdf))
* [Committee on Payments and Market Infrastructures — fast payments and settlement, BIS](https://www.bis.org/publ/othp82.pdf) — reference on how fast-payment systems reconcile a real-time customer experience with deferred interbank settlement
* [Idempotency](/docs/patterns/reliability/idempotency) — the exactly-once guard the switch applies to each `upi_txn_id`
* [Saga](/docs/patterns/consistency/saga) — the debit-then-credit-with-compensating-reversal coordination across two banks
* [Two-Phase Commit](/docs/patterns/consistency/two-phase-commit) — the blocking alternative this design weighs and rejects for cross-bank coordination
* [Sharding](/docs/patterns/storage/sharding) — how the switch partitions state by transaction id to scale past a single coordinator
* [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) and [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff) — per-bank fault isolation on the switch's bank adapters
