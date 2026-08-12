---
title: "Design Zelle (Real-Time Bank Transfers)"
sidebar_position: 10
---

Zelle's defining property is that it is a **directory-and-messaging network, not a wallet**: it never holds a dollar, it holds a mapping from a token (an email address or U.S. mobile number) to the recipient's enrolled bank account, and it uses that mapping to make two banks move money directly between themselves while the user sees the transfer complete in minutes. That shape produces the one property a practitioner must design around above all else — a Zelle transfer is **push, irrevocable, and near-instant**. Once money lands in an enrolled recipient's account it cannot be pulled back, which means the system has no equivalent of a card chargeback, and the entire risk model has to move *upstream* of the send, because there is nothing to undo *after* it. Everything below is organized around routing a transfer correctly and exactly once through a token directory, and around the consequences of a money movement that is final the moment it completes.

Zelle is operated by **Early Warning Services, LLC**, a company owned by seven large U.S. banks (Bank of America, Truist, Capital One, JPMorgan Chase, PNC Bank, U.S. Bank, and Wells Fargo). It launched under the Zelle name in June 2017 as the successor to the earlier clearXchange service. This case study designs a system with Zelle's shape — a bank-owned token directory that routes real-time bank-to-bank transfers — grounding each component in how Zelle actually works, and contrasting it throughout with the [UPI case study](/docs/case-studies/fintech/upi-real-time-payments), which solves a very similar routing problem under different settlement and governance.

## Step 1: Outline use cases and constraints

### Use cases

#### We'll scope the problem to handle the following use cases

* A **user enrolls a token** — an email address or U.S. mobile number — and binds it to one deposit account at one bank, so that money sent to that token lands in that account
* A **sender** initiates a transfer to a recipient identified only by a token, never by the recipient's account and routing number
* The network performs a **directory lookup**, resolving the recipient token to the bank that currently owns it, so the transfer can be routed without either party seeing the other's account number
* The **sender's bank debits** the sender, the network **routes** the instruction with fraud and anti-money-laundering screening, and the **recipient's bank credits** the recipient, with funds typically available **in minutes**
* The network guarantees each logical transfer moves money **exactly once** — a retried instruction for the same transfer never produces a second debit or a second credit
* A transfer to an **already-enrolled** recipient is **final and cannot be canceled**; the design treats irrevocability as a first-class property, not an incidental one
* The **actual interbank settlement** happens on a separate rail (ACH batch or a real-time rail such as RTP) on a netted basis, decoupled from the real-time experience the user sees
* The network records a durable, auditable log of every transfer and its terminal state, queryable by both banks

#### Out of scope

* The internal core-banking system of each bank (how a bank holds and updates a customer's balance) — treated as an external dependency the network calls
* Business/merchant Zelle acceptance and request-for-payment flows beyond a brief mention — the design focuses on person-to-person transfers
* The enrollment identity-proofing and know-your-customer process each bank runs on its own customers
* International transfers — Zelle is a U.S.-only network by design, and this is treated as a fixed constraint, not a feature to add
* Dispute and scam-reimbursement workflows beyond the risk discussion, since the defining constraint is precisely that there is no reversal to dispute against

### Constraints and assumptions

#### State assumptions

* Token to account binding is **unique per network at a point in time**: a given email or mobile number is enrolled and active at exactly one bank; to move it to a different bank the user must first deactivate it at the old one, so the directory never has two live answers for "where does this token land"
* A transfer must never be **double-debited or double-credited**, even if the sender's bank retries after a timeout, or an internal message is redelivered — a hard correctness requirement
* A transfer must never be **silently lost**: every accepted instruction reaches a terminal state (completed, failed, or held for review), and that state is durably recorded and queryable
* A completed transfer to an enrolled recipient is **irrevocable** — there is no reversal primitive the sender can invoke, which makes correct routing *before* the send far more important than any cleanup *after*
* The network **holds no funds**; it authorizes and records movement in real time, and the actual money settlement between banks happens later, netted, on a batch or real-time settlement rail
* User-visible funds availability is **within minutes**, dominated by the two banks' own debit/credit processing and notification, not by directory routing
* Availability must be effectively 24×7 — a national P2P rail that is down is a visible, newsworthy outage

#### Calculate usage

* By the end of 2024 the real Zelle network reported over **$1 trillion in annual payment volume**, across roughly **151 million enrolled accounts** and about **2,300 participating financial institutions**. Those figures anchor the numbers below.
* If a plausible model puts annual transaction *count* on the order of **3.5 billion transfers/year** (consistent with an average transfer in the low hundreds of dollars against a $1T+ volume), that is 3,500,000,000 / 365 ≈ **~9.6 million transfers/day** → 9,600,000 / 86,400 ≈ **~110 transfers/sec average**. U.S. P2P traffic is sharply peaked around paydays, rent day, weekends, and holidays — design for roughly **8–10x average at peak**, so on the order of **~1,000 transfers/sec** at the busiest minute.
* Each transfer is a handful of network-mediated messages — a directory resolve, a debit confirmation from the sender bank, a routed credit instruction to the recipient bank, and a status fan-out — so **one transfer is roughly 4–5 network messages** → on the order of **~4,000–5,000 internal messages/sec** at peak.
* Transfer record size: a network-side record (`transfer_id`, sender token, recipient token, `amount_cents`, `status`, sender/recipient routing numbers, timestamps, small metadata) ≈ **~350 bytes/record** → 9,600,000/day × 350 bytes ≈ **~3.4 GB/day**, **~1.2 TB/year** of transfer log — modest, so the design pressure is on correctness and directory freshness, not raw storage volume.
* Directory lookups: every transfer resolves at least the recipient token, and often re-checks the sender token → on the order of **~15–20 million lookups/day**. These are read-heavy and cacheable within a short validity window, but the binding is authoritative — a stale mapping that routes money to a token's *previous* bank is a correctness failure, not a latency one.
* Settlement: instead of settling every one of the ~9.6M daily transfers gross, banks settle **net positions per bank-pair** in periodic windows on the underlying rail, so the settlement engine posts orders of magnitude fewer entries than there are transfers.

## Step 2: Create a high-level design

![Zelle high-level design: sender to sender bank to Early Warning Services Zelle network to recipient bank to recipient, with the network resolving the recipient token to a bank via its directory and routing the transfer, and a separate interbank settlement rail (ACH batch or RTP) netting positions behind the scenes](/img/case-studies/fintech/zelle-real-time-transfers-overview.svg)

The core of Zelle is a **token directory plus a messaging network** sitting between banks. A sender opens their bank's app (or the standalone Zelle app, used by customers of smaller banks that do not embed it), enters a recipient's **token** — an email address or U.S. mobile number — and an amount. The sender's bank first does its own local work: it verifies the request, performs **funds control** to confirm the sender actually has the money, and books the debit internally. It then sends the instruction into the **Zelle network operated by Early Warning Services**, whose first job is the **directory lookup**: resolve the recipient token to the bank that currently owns that token's active binding. The network screens the transfer for fraud and anti-money-laundering signals, then routes a credit instruction to the **recipient's bank**, which credits the recipient's bound account and notifies them — typically within minutes. From the two users' perspective, the money has moved.

Two structural facts make this different from a card flow or the generic payment-processor case study in this course. First, **the network never holds funds** — it is a directory and a router, and the money moves directly between the two banks' books; the network's job is to make that movement correctly routed and recorded exactly once. Second, **"real time" describes the user experience and the credit, not the interbank settlement.** The actual money between banks is squared up later on a separate rail — historically ACH in scheduled batches, increasingly a real-time rail such as The Clearing House's RTP — on a *netted* basis, so a whole day of transfers between two banks collapses into a small number of settlement postings. That decoupling is exactly the same shape as [UPI's deferred net settlement](/docs/case-studies/fintech/upi-real-time-payments); the difference Zelle adds, and the thing the design must respect end to end, is that the user-facing leg is **irrevocable** the moment it completes.

## Step 3: Design core components

### Use case: The directory resolves a token to the bank that owns it

The token is the whole reason Zelle feels different from the traditional "give me your account and routing number" transfer. A token — an email or U.S. mobile number — is an alias the user enrolls; inside the owning bank it maps to a real deposit account, but that mapping is never exposed to the counterparty. Routing therefore starts with a resolution step: given a recipient token, which bank currently owns its active binding, and is the recipient already enrolled (so the credit can complete in minutes) or not-yet-enrolled (so the network must invite them first)?

**Core spec: token resolution at the network directory**

```python
from dataclasses import dataclass
from typing import Optional

@dataclass
class ResolvedRecipient:
    routing_number: str      # routes the credit leg to the owning bank
    masked_account: str      # e.g. "XXXXXX8830" -- never the full number
    account_name: str        # for the sender to visually confirm the recipient
    enrolled: bool           # False -> recipient must be invited to enroll first

def resolve_token(token: str, directory, bank_client) -> ResolvedRecipient:
    """Resolve a recipient token to the bank that currently owns it.

    The directory maps an active token to exactly one owning bank. It
    does NOT store customer account numbers; it delegates the final
    token -> account mapping to the owning bank, which returns only a
    MASKED account plus the account holder name for the sender to
    confirm. This keeps full account numbers out of the counterparty's
    hands end to end, the same trust-minimization the UPI case study
    applies to its VPA resolution.
    """
    normalized = normalize_token(token)
    binding = directory.lookup_active_binding(normalized)
    if binding is None:
        # No active binding: the recipient is not enrolled anywhere.
        # The network can still accept the send and notify the token to
        # invite enrollment, but the credit cannot complete until then.
        return ResolvedRecipient(routing_number="", masked_account="",
                                 account_name="", enrolled=False)
    resolved = bank_client.resolve(binding.owning_bank, normalized)
    return ResolvedRecipient(
        routing_number=binding.routing_number,
        masked_account=resolved.masked_account,
        account_name=resolved.account_name,
        enrolled=True,
    )

def normalize_token(token: str) -> str:
    """Tokens must resolve identically regardless of formatting, or two
    spellings of the same phone/email could bind to different rows.
    Emails lowercase; phone numbers reduce to E.164-style digits.
    """
    t = token.strip()
    if "@" in t:
        return t.lower()
    digits = "".join(ch for ch in t if ch.isdigit())
    if len(digits) == 10:          # bare US number -> prepend country code
        digits = "1" + digits
    return "+" + digits
```

**Data structures:** a `token_bindings` table (below) mapping a normalized token to its one active owning bank; the account-number ↔ token mapping itself lives inside each bank, not in the directory. The sender's app receives back only `account_name` and `masked_account` so the human can confirm "yes, that's the right person" before sending — the last line of defense before an irrevocable transfer.

**Trade-offs:**
* **The gotcha:** the tempting shortcut is to cache resolved token → account mappings aggressively to save a round-trip on every transfer. But a token can be **re-enrolled at a different bank** (a user switches banks and moves their phone number's Zelle binding), and a stale cached mapping would route money to the token's *previous* bank — an irreversible mis-delivery, since the transfer is final once it lands. The fix is that the directory holds the authoritative *current* binding, resolution is re-validated within a short validity window, and the final credit is named by the owning bank's own current mapping — a cached resolution is never treated as durable authority for where money lands.
* Not-enrolled recipients are a real branch, not an error: the network accepts the send and notifies the token to invite enrollment, and only completes the credit once the recipient enrolls and a binding exists — which is also why "sent to an unenrolled token" is one of the *few* states where a sender can still recover funds if the invite is never accepted, in contrast to the irreversibility of a send to an enrolled token.

**REST API:**

```
$ curl -X POST https://network.zelle.example/api/v1/directory/resolve \
    -H "X-Bank-Id: senderbank" \
    -H "Signature: <bank-request-signature>" \
    -d '{"token": "jordan@example.com"}'
```

Response:

```json
{
  "token": "jordan@example.com",
  "routing_number": "021000021",
  "masked_account": "XXXXXX8830",
  "account_name": "JORDAN P",
  "enrolled": true
}
```

### Use case: Enrollment binds one token to one bank, uniquely

Enrollment is where the directory's core invariant is established and defended: **a given token is active at exactly one bank at a time.** If the same email or phone number could be simultaneously live at two banks, a transfer to that token would have two equally valid destinations and the network could not route deterministically. So enrollment is not a plain insert — it is a uniqueness-guarded claim on the token.

**Core spec: enrollment uniqueness constraint**

```sql
CREATE TABLE token_bindings (
    token            VARCHAR(255) NOT NULL,   -- normalized email or +E.164 phone
    owning_bank      VARCHAR(32)  NOT NULL,   -- which bank currently owns the token
    routing_number   VARCHAR(9)   NOT NULL,   -- routes the credit leg
    status           VARCHAR(16)  NOT NULL,   -- 'ACTIVE' or 'DEACTIVATED'
    enrolled_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- The whole design rests on this: at most ONE active row per token.
    -- A partial unique index lets history rows stay as DEACTIVATED while
    -- guaranteeing a single live binding the directory can resolve.
    CONSTRAINT token_bindings_pk PRIMARY KEY (token, enrolled_at)
);

CREATE UNIQUE INDEX one_active_binding_per_token
    ON token_bindings (token)
    WHERE status = 'ACTIVE';
```

```python
def enroll_token(store, token: str, owning_bank: str, routing_number: str):
    """Bind a token to a bank, enforcing the one-active-binding rule.

    The partial unique index makes the claim atomic: if the token is
    already ACTIVE at another bank, this INSERT fails, and the caller
    must have the user deactivate the old binding first. Two banks
    racing to enroll the same token cannot both win -- exactly one
    INSERT survives the unique index.
    """
    normalized = normalize_token(token)
    try:
        store.execute(
            """
            INSERT INTO token_bindings (token, owning_bank, routing_number, status)
            VALUES (%s, %s, %s, 'ACTIVE')
            """,
            (normalized, owning_bank, routing_number),
        )
    except store.UniqueViolation:
        raise ValueError(
            f"token {normalized} is already active at another bank; "
            "deactivate the existing binding before re-enrolling"
        )

def move_token(store, token: str, new_bank: str, new_routing: str):
    """Move a token to a new bank as deactivate-then-enroll, never as a
    silent overwrite -- so the directory is never momentarily ambiguous
    and the old binding survives as an auditable history row.
    """
    normalized = normalize_token(token)
    store.execute(
        "UPDATE token_bindings SET status = 'DEACTIVATED' "
        "WHERE token = %s AND status = 'ACTIVE'",
        (normalized,),
    )
    enroll_token(store, normalized, new_bank, new_routing)
```

**Data structures:** `token_bindings` above is the durable directory. The `one_active_binding_per_token` partial unique index is the load-bearing constraint — it is what makes "one token, one bank" a database-enforced fact rather than an application-level hope. Deactivated rows are retained so the directory keeps an auditable history of where a token pointed over time.

**Trade-offs:**
* **The gotcha:** if the move were modeled as an in-place `UPDATE ... SET owning_bank = new` on a single row, a crash between "point token at new bank" and "confirm the old bank released it" could leave the token resolvable to a bank that no longer serves it, or make the token briefly resolve to *neither*. Modeling the move as **deactivate-then-enroll** with a unique index on active rows means the directory always has zero or one active binding, never two, and never a torn half-updated one.
* Token normalization (previous use case) has to run *before* the uniqueness check, or `Jordan@Example.com` and `jordan@example.com` would occupy two "distinct" active rows for what is the same token — a subtle way to defeat the very constraint this schema exists to enforce.

### Use case: A push transfer moves money as idempotent debit and credit legs

This is the everyday flow. Unlike a card transaction (which is a *pull* — the merchant's acquirer requests funds from the issuer) a Zelle transfer is a **push**: the sender's bank debits first, on the sender's own authority, and then the network routes a credit. That ordering is exactly what makes the transfer feel instant and also exactly why it is irrevocable — by the time the network is involved, the sender's bank has already committed the debit, and once the credit lands in an enrolled account there is no pull-back primitive. The design must therefore make each leg **exactly once**, because a duplicated leg cannot be cleaned up after the fact.

**Core spec: idempotent push transfer with debit and credit legs**

```python
def process_push_transfer(req, network, sender_bank, recipient_bank):
    """Orchestrate a push transfer as: claim id -> confirm sender debit
    -> route recipient credit -> record terminal state.

    `req` carries a `transfer_id` generated once per logical transfer by
    the sender's bank and reused across retries. The sender bank has
    already done funds control and booked the debit locally before
    calling the network; the network's job is correct, exactly-once
    routing of the credit and a durable record of both legs.
    """
    # 1. Exactly-once guard: claim the transfer id or replay a result.
    claim = network.claim_transfer_id(req.transfer_id)
    if claim.already_terminal:
        return claim.stored_response          # retry -> replay, no second credit

    # 2. Resolve the recipient token to its current owning bank.
    recipient = resolve_token(req.recipient_token, network.directory,
                              network.bank_client)
    if not recipient.enrolled:
        # Accept and invite; credit completes later, on enrollment.
        return network.finalize(req.transfer_id, status="PENDING_ENROLLMENT")

    # 3. Fraud / AML screening happens BEFORE the credit, because there
    #    is no post-hoc reversal to fall back on (see next use case).
    decision = network.screen(req)
    if decision.action == "BLOCK":
        sender_bank.reverse_debit(transfer_id=req.transfer_id)  # undo local debit
        return network.finalize(req.transfer_id, status="BLOCKED_RISK")
    if decision.action == "HOLD":
        return network.finalize(req.transfer_id, status="HELD_FOR_REVIEW")

    # 4. Credit leg: route to the recipient's bank, keyed by the same id
    #    so the recipient bank dedupes a redelivered credit instruction.
    credit = recipient_bank.credit(
        transfer_id=req.transfer_id,
        routing_number=recipient.routing_number,
        recipient_token=req.recipient_token,
        amount_cents=req.amount_cents,
    )
    if not credit.ok:
        # Debit already committed at sender bank but credit failed:
        # reverse the debit so money never vanishes. This reversal is an
        # INTERNAL failure-path unwind, NOT a user-invocable cancel.
        sender_bank.reverse_debit(transfer_id=req.transfer_id)
        return network.finalize(req.transfer_id, status="FAILED_REVERSED")

    return network.finalize(req.transfer_id, status="COMPLETED",
                            trace_number=credit.trace_number)
```

**Data structures:** a `transfers` row per transfer — `transfer_id` (PK), `sender_token`, `recipient_token`, `amount_cents` (integer cents, never floating point, so no rounding can create or destroy money), `status`, `sender_routing`, `recipient_routing`, `trace_number`, `created_at`, `updated_at`. The `trace_number` is the human-facing reference both banks and users can quote.

**Trade-offs:**
* **The gotcha:** the debit can succeed while the credit fails (the recipient bank times out or declines), which would leave the sender debited and the recipient not credited — money vanishing from the user's point of view. The fix is that a failed credit after a committed debit **must trigger a reversal of the debit** into an explicit `FAILED_REVERSED` state. Crucially, this reversal is an *internal failure-path unwind on the same transfer that never completed* — it is categorically different from "canceling a completed transfer," which the network does **not** support once the credit has landed in an enrolled account.
* Anchoring exactly-once on a **bank-generated `transfer_id` reused across retries** is what makes a sender-bank retry safe end to end: the retry carries the same id, so the network recognizes it as the same logical transfer and replays the recorded outcome rather than issuing a second credit — the same discipline this course's [Idempotency](/docs/patterns/reliability/idempotency) pattern describes, applied to a distributed money movement.

**REST API:**

```
$ curl -X POST https://network.zelle.example/api/v1/transfers \
    -H "X-Bank-Id: senderbank" \
    -H "Signature: <bank-request-signature>" \
    -d '{
          "transfer_id": "ZEL7f3a1c90-sam-to-jordan-44210",
          "sender_token": "+15551230000",
          "recipient_token": "jordan@example.com",
          "amount_cents": 8500
        }'
```

Response:

```json
{
  "transfer_id": "ZEL7f3a1c90-sam-to-jordan-44210",
  "trace_number": "091000019250812",
  "status": "COMPLETED",
  "amount_cents": 8500,
  "completed_at": "2026-08-12T15:41:22Z"
}
```

### Use case: The exactly-once guard on the transfer id

At peak a few thousand transfers a second cross an unreliable network, and retries are constant: a sender's bank that does not hear back within its timeout resends the instruction, not knowing whether the credit already went out. Without a guard, that retry is a second credit into an account that can never be pulled back. The network anchors exactly-once on a **transfer id** generated once per logical transfer and reused across every retry, and treats it as the deduplication key for the whole flow.

**Core spec: atomic claim-or-replay on the transfer id**

```sql
CREATE TABLE transfer_claims (
    transfer_id      VARCHAR(80) PRIMARY KEY,   -- generated once per logical transfer
    status           VARCHAR(24) NOT NULL,      -- 'IN_FLIGHT','COMPLETED','FAILED_REVERSED','BLOCKED_RISK','HELD_FOR_REVIEW','PENDING_ENROLLMENT'
    stored_response  JSONB,                     -- exact response to replay on a retry
    trace_number     VARCHAR(24),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

```python
def claim_transfer_id(store, transfer_id):
    """Atomically either claim a brand-new transfer id as IN_FLIGHT, or,
    if it already exists, return the current record so the caller can
    replay a terminal result instead of routing a second credit.

    INSERT ... ON CONFLICT DO NOTHING makes the claim a single atomic
    step: two concurrent retries with the same id race on the primary
    key and exactly one wins the insert. The loser reads the existing
    row and never gets to start a second credit.
    """
    inserted = store.execute(
        """
        INSERT INTO transfer_claims (transfer_id, status)
        VALUES (%s, 'IN_FLIGHT')
        ON CONFLICT (transfer_id) DO NOTHING
        RETURNING transfer_id
        """,
        (transfer_id,),
    )
    if inserted:
        return Claim(won=True, already_terminal=False, stored_response=None)

    row = store.fetch_one(
        "SELECT status, stored_response FROM transfer_claims WHERE transfer_id = %s",
        (transfer_id,),
    )
    terminal = row["status"] != "IN_FLIGHT"
    return Claim(won=False, already_terminal=terminal,
                 stored_response=row["stored_response"])
```

**Data structures:** `transfer_claims` above is the durable exactly-once anchor, deliberately separate from the fuller `transfers` record: its only job is to win-or-replay on the id under concurrency, so it is optimized for a strongly-consistent conditional insert on a single key.

**Trade-offs:**
* **The gotcha:** if the claim and the actual credit are two separate non-atomic steps, a crash *between* claiming the id and routing the credit leaves a dangling `IN_FLIGHT` row, and a retry that reads `IN_FLIGHT` might wait forever. The fix is a **timeout-and-reconcile rule**: an `IN_FLIGHT` claim older than a bounded window is handed to a reconciliation job that asks the recipient bank whether a credit for that `transfer_id` actually posted, and drives the row to a real terminal state — which is exactly why the credit is keyed by the same `transfer_id`, so the bank can answer "did this specific transfer post?" deterministically.
* Because the money movement is irrevocable, the exactly-once guard here is doing *more* work than in a system with reversals: in a card system a stray duplicate can be charged back, but a duplicate Zelle credit is permanent. That raises the stakes on the guard being a genuinely atomic conditional insert with strong consistency, never an eventually-consistent cache check.

### Use case: Irrevocability and the fraud hold — why there is no clawback

This is the property that most shapes a Zelle-like design and most surprises users. A completed transfer to an **enrolled** recipient is final: the money moved directly bank-to-bank, and the network has no primitive to pull it back without the recipient's cooperation. That is the same finality that makes the transfer feel instant, and it means the system's only real defense is to make the **accept/hold/block decision before the credit**, because there is nothing to undo after it. This is the opposite of a card network, where the chargeback mechanism lets a disputed charge be reversed weeks later.

**Core spec: pre-credit risk decision and why a completed transfer has no cancel**

```python
from enum import Enum

class Action(Enum):
    ALLOW = "ALLOW"
    HOLD  = "HOLD"    # pause for manual/step-up review, credit not yet sent
    BLOCK = "BLOCK"   # refuse and reverse the sender's local debit

def screen_transfer(req, risk):
    """Decide BEFORE the credit leg, because after it there is no
    reversal. This is where authorized-push-payment (APP) scam defenses
    have to live: once the credit lands in an enrolled account, the
    money is gone and there is no chargeback path.
    """
    score = risk.score(sender=req.sender_token, recipient=req.recipient_token,
                       amount_cents=req.amount_cents, signals=req.signals)
    if score.is_sanctions_or_mule_hit:
        return Action.BLOCK
    if score.value >= risk.hold_threshold or req.recipient_is_new_to_sender:
        # A first-ever, high-value send to a brand-new recipient is the
        # classic APP-scam shape; holding for step-up review is the only
        # intervention still possible while it is reversible.
        return Action.HOLD
    return Action.ALLOW

def attempt_clawback(transfer):
    """There is intentionally NO automatic clawback of a COMPLETED
    transfer. Recovery is a best-effort, out-of-band request to the
    RECEIVING bank to return funds the recipient still holds -- it is
    not a network primitive and it is not guaranteed.
    """
    if transfer.status != "COMPLETED":
        raise ValueError("only completed transfers reach this path")
    # Best-effort recovery is a manual bank-to-bank request, not an API.
    return "manual_recovery_request_submitted_no_guarantee"
```

**Data structures:** the risk decision is recorded on the `transfers` row (`status` transitions through `HELD_FOR_REVIEW` or `BLOCKED_RISK` before ever reaching `COMPLETED`), plus a `risk_events` log capturing the score and reason for audit. No `cancel` column exists on a completed transfer by design — the absence is the point.

**Trade-offs:**
* **The gotcha:** treating fraud handling like a card system — "let it through, reverse it if it's disputed" — is a category error here, because there is no reverse. An **authorized push payment (APP) scam**, where the victim is tricked into *authorizing* a real transfer to a fraudster, produces a transfer that is technically valid, correctly routed, and irreversible. The defense has to be *pre-send*: risk scoring, holds on first-time high-value recipients, step-up confirmation, and clear "only send to people you trust" warnings — because after the credit, the only recourse is a best-effort, non-guaranteed request to the receiving bank to return funds the recipient may already have moved.
* This finality is a deliberate trade for speed and cost, and it is the sharpest contrast with cards: card payments carry purchase protection and chargebacks precisely because the pull-and-settle model leaves a reversible window; Zelle's push-and-done model closes that window to buy minutes-not-days delivery and no interchange fees. A practitioner must design the risk system knowing the reversal escape hatch simply is not there.

### Use case: Behind-the-scenes interbank settlement by netting

The user sees funds in minutes, but the banks have not actually exchanged money at that instant — the recipient bank has credited its customer on the strength of the network's guarantee, and the two banks square up later. Settlement runs on a **separate rail** (ACH in scheduled batches, or a real-time rail such as RTP) and, critically, on a **netted** basis: rather than settling each of a day's transfers gross, the engine nets all transfers between each pair of banks into a small number of positions.

**Core spec: net settlement across a window of transfers**

```python
from collections import defaultdict

def net_settlement_positions(completed_transfers):
    """Collapse a window of completed transfers into net positions per
    ORDERED bank pair. Each transfer moved value from the sender's bank
    to the recipient's bank; netting sums those so banks settle a small
    number of positions on the underlying rail, not one per transfer.

    Returns {(from_bank, to_bank): net_cents} with only the surviving
    direction per pair (the larger side minus the smaller).
    """
    gross = defaultdict(int)
    for t in completed_transfers:
        # value flows from the sender's bank to the recipient's bank
        gross[(t["sender_routing"], t["recipient_routing"])] += t["amount_cents"]

    net = {}
    seen = set()
    for (a, b), amt_ab in gross.items():
        if (a, b) in seen or (b, a) in seen:
            continue
        amt_ba = gross.get((b, a), 0)
        if amt_ab >= amt_ba:
            net[(a, b)] = amt_ab - amt_ba      # a owes b, net
        else:
            net[(b, a)] = amt_ba - amt_ab      # b owes a, net
        seen.add((a, b)); seen.add((b, a))
    # Zero-net pairs settle to nothing and can be dropped.
    return {pair: cents for pair, cents in net.items() if cents != 0}
```

**Data structures:** the settlement engine reads `COMPLETED` rows from the `transfers` log over a window and writes `settlement_postings` — `window_id`, `from_routing`, `to_routing`, `net_cents`, `rail` (`ACH` or `RTP`), `posted_at`. Because the log is append-only and every transfer is exactly-once, the settlement total is a deterministic function of the log, which is what makes reconciliation possible.

**Trade-offs:**
* **The gotcha:** the recipient bank has already given its customer the money before settlement clears, so it carries **interbank credit and settlement risk** between the real-time credit and the deferred settlement. The mitigations are the same ones fast-payment systems use generally: net exposure caps per participant, prefunded or collateralized settlement positions, and moving settlement onto a faster rail (RTP settles with immediate finality 24/7, shrinking the risk window that ACH's next-business-day batch leaves open). The netting also has to be reconciled against the transfer log so that what the settlement engine says a bank owes exactly matches the sum of that bank's transfer legs.
* This is the same real-time-authorization-versus-deferred-settlement split as [UPI](/docs/case-studies/fintech/upi-real-time-payments), and it is a feature, not a gap: netting lets a real-time experience run at national volume without a real-time gross settlement per transfer, at the cost of a settlement-risk window the design must bound rather than eliminate.

## Step 4: Scale the design

![Zelle at scale: bank apps and a standalone Zelle app behind a network API gateway with per-transfer idempotency keys, a token directory enforcing one active binding per token, a token-sharded routing-and-risk core, an append-only transfer log with debit and credit legs, per-bank adapters with circuit breakers and retries, and a deferred settlement engine that nets each bank-pair position onto ACH or RTP off the hot path](/img/case-studies/fintech/zelle-real-time-transfers-scaled.svg)

* **The routing core shards by token so no single coordinator sits on the path of every transfer at peak** — see [Sharding](/docs/patterns/storage/sharding). A transfer's directory lookup, exactly-once claim, and legs are all scoped to the recipient token (and its `transfer_id`), so that is a natural shard key: all state for one transfer lives on one shard, and the hot claim-or-replay path never needs a cross-shard transaction.
* **The token directory and the exactly-once claim store need strong consistency, not just availability.** The directory must never return two live bindings for one token (or route to a stale one after re-enrollment), and the claim store must never return "not found" to two concurrent retries of the same `transfer_id`. Both are deliberate places to spend consistency budget — an atomic conditional insert and a partial unique index — because the money movement they gate is irrevocable, so a race here cannot be cleaned up later.
* **Each bank integration gets a [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) and [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff), applied per bank.** Banks fail independently, and one slow bank must not stall the whole network: a breaker that trips on a struggling bank fails its transfers fast (and reverses any dangling debit) instead of holding threads, while retries against that bank must always carry the same `transfer_id` so a retry can never become a second credit. Isolating one bank's failures from the rest is the [Bulkhead](/docs/patterns/reliability/bulkhead) idea applied to bank adapters.
* **The debit-then-credit flow is coordinated as a saga, not a distributed lock across both banks** — see [Saga](/docs/patterns/consistency/saga). Holding a two-phase lock across two independently-operated banks for the duration of their processing is exactly what [Two-Phase Commit](/docs/patterns/consistency/two-phase-commit) handles poorly; instead the debit and credit are separate local commits, with an explicit compensating **reversal of the debit** if the credit fails — but with the sharp caveat that a *successful* credit has no compensation, because the transfer is irrevocable.
* **Directory resolution scales as a read-mostly, cacheable lookup with a short validity window, served from replicas** — see [Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication). The tens of millions of daily resolutions vastly outnumber directory writes, but the final credit still names the recipient via the owning bank's current mapping, so a slightly stale replica can speed routing without ever becoming the authority for where money lands.
* **Settlement runs as an independent batch off the hot path**: the netting engine sums each bank-pair's completed transfers over a window and posts a small number of net positions onto ACH or RTP, decoupling the slow interbank money movement from the fast, irrevocable, user-visible credit.

## Additional talking points

* **Irrevocability is the whole risk model.** Because a completed transfer to an enrolled recipient cannot be canceled, there is no chargeback, and the defining fraud problem is the **authorized push payment (APP) scam** — the victim is manipulated into authorizing a genuine transfer to a fraudster. The CFPB's December 2024 lawsuit against Bank of America, JPMorgan Chase, and Wells Fargo alleged customers of those three banks lost over **$870 million to fraud** over Zelle's roughly seven-year history and that the banks were slow to investigate or reimburse; the CFPB dropped the suit in March 2025. Whatever one's view of the litigation, the engineering lesson is fixed: on an irrevocable rail, fraud defense must be *pre-send*, not *post-dispute*.
* **Real-time credit versus deferred net settlement.** The single most misunderstood thing about Zelle is that "instant" describes the user-facing credit, while the actual interbank money settles later, netted, on ACH or RTP. That decoupling lets a real-time experience run at national volume without real-time gross settlement per transfer, but it means the recipient's bank carries settlement risk in the interim — bounded by net exposure caps and increasingly shrunk by settling on RTP's immediate-finality rail rather than ACH's next-business-day batch.
* **Contrast with UPI: same shape, different governance and settlement.** Both Zelle and [UPI](/docs/case-studies/fintech/upi-real-time-payments) are real-time, directory-routed, bank-to-bank networks that hold no funds and settle net behind the scenes. The differences a practitioner should internalize: UPI is operated by NPCI under central-bank (RBI) regulation with an explicit MPIN second factor validated at the payer's bank and both push and pull (collect) flows on one switch; Zelle is operated by a **bank-owned consortium** (Early Warning Services), leans on each bank's own authentication, is push-first and U.S.-only, and rides existing ACH/RTP settlement rails rather than a purpose-built one. UPI's collect flow makes "approve to receive" phishing a first-class concern; Zelle's push-only, irrevocable model makes APP scams *its* first-class concern.
* **Enrollment uniqueness is a routing invariant, not a convenience.** The rule that a token is active at one bank at a time exists so the directory can route deterministically; a design that let a token live at two banks would have no correct answer for where a transfer lands. Modeling bank moves as deactivate-then-enroll, guarded by a partial unique index, keeps that invariant true even across failures.
* **No purchase protection is a deliberate scope choice.** Zelle is designed for P2P transfers between people who trust each other, and explicitly does not offer the goods-and-services purchase protection a card or a service like PayPal provides. That is not an oversight to fix in the design — it is a direct consequence of irrevocability, and the honest system-design stance is to build the pre-send risk controls and user warnings that the absence of protection demands, rather than to pretend a reversal path exists.

## Source(s) and further reading

* [Zelle — Wikipedia](https://en.wikipedia.org/wiki/Zelle) — consolidated reference for Zelle's operator (Early Warning Services), its seven bank owners, the 2017 launch as successor to clearXchange, funds moving directly bank-to-bank, the cannot-be-canceled property, the CFPB lawsuit and the roughly $870 million fraud figure, and 2024 volume of over $1 trillion across ~151 million accounts and ~2,300 institutions
* [Early Warning Services — Wikipedia](https://en.wikipedia.org/wiki/Early_Warning_Services) — the bank-owned consortium that operates the Zelle network
* [How Zelle works — zelle.com](https://www.zelle.com/how-it-works) — the operator's own description of enrolling an email or U.S. mobile number, sending to a recipient at a different bank, funds to enrolled users typically within minutes, and "only send money to those you trust"
* [Zelle FAQ — zelle.com](https://www.zelle.com/faq) — confirms that a payment sent to an already-enrolled recipient goes directly to their bank account and cannot be canceled, and the guidance to send only to people you know and trust
* [RTP network — The Clearing House](https://www.theclearinghouse.org/payment-systems/rtp) — the real-time interbank rail with instant, final, 24/7 settlement that increasingly carries fast-payment settlement, versus ACH's batch model
* [ACH Network — Nacha](https://www.nacha.org/content/ach-network) — the batch-based interbank rail historically used to settle Zelle transfers on a deferred basis
* [FedNow Service — Federal Reserve](https://www.federalreserve.gov/paymentsystems/fednow_about.htm) — the Federal Reserve's instant-payment rail, context for how U.S. real-time settlement infrastructure is evolving alongside RTP
* [The Clearing House — Wikipedia](https://en.wikipedia.org/wiki/The_Clearing_House) — background on the bank-owned operator of the RTP network
* [Automated clearing house — Wikipedia](https://en.wikipedia.org/wiki/Automated_clearing_house) — background on ACH batch processing and deferred settlement
* [Idempotency](/docs/patterns/reliability/idempotency) — the exactly-once guard the network applies to each `transfer_id`
* [Saga](/docs/patterns/consistency/saga) — the debit-then-credit-with-compensating-reversal coordination, with the caveat that a completed credit has no compensation
* [Sharding](/docs/patterns/storage/sharding) — how the routing core partitions state by token to scale past a single coordinator
* [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) and [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff) — per-bank fault isolation on the network's bank adapters
