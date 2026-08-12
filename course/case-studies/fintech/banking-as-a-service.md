---
title: "Design Banking-as-a-Service (Fintech + Sponsor Banks)"
sidebar_position: 8
---

Banking-as-a-Service has one defining property, and every design decision below follows from it: the fintech is only a user-experience and ledger layer, while the money actually lives at a chartered **sponsor bank**, usually pooled into a single **FBO ("for benefit of") account**, with the fintech or a BaaS middleware keeping the **sub-ledger** of which end customer owns what slice of that pool. The bank sees one big balance; the sub-ledger sees thousands of individual owners. Nothing about that arrangement is safe unless one invariant holds continuously: the sub-ledger's balances must sum to exactly the bank's balance for that pool. When those two records are owned by different companies and are allowed to drift apart without a hard reconciliation, the question "whose money is this?" becomes genuinely unanswerable — which is precisely what froze roughly 85 million dollars of end-user funds in the 2024 Synapse collapse. This case study is organized around making that reconciliation invariant load-bearing rather than aspirational.

## Step 1: Outline use cases and constraints

### Use cases

#### We'll scope the problem to handle the following use cases

* A **fintech app** offers a "bank account" experience — deposits, a balance, card payments, transfers between users — without holding a bank charter itself
* An end-user **deposit** lands not in a fintech-owned vault but in a pooled **FBO account** at a chartered **sponsor bank**, and the fintech (or a **BaaS middleware** sitting between them) records the depositor's ownership in a **sub-ledger**
* The system maintains a **double-entry sub-ledger** so that every movement of value is recorded as balanced debit and credit rows against named sub-accounts inside the pool
* A **transfer** between two users of the same fintech debits one sub-account and credits another **within the same FBO account** — no money leaves the bank, only the sub-ledger changes
* A **reconciliation job** continuously proves the core invariant: the sum of all sub-ledger balances for a program equals the sponsor bank's recorded balance for that program's FBO account
* The system detects, alarms on, and contains **drift** between the sub-ledger and the bank balance before it becomes an unrecoverable discrepancy
* End users are covered by **FDIC pass-through deposit insurance** only if the account is titled and recorded in the specific way the FDIC requires — the design must preserve those conditions, not just assume coverage
* The design survives, and correctly attributes ownership through, a **failure of the middleware or the fintech**, so that a bankruptcy trustee can reconstruct who owns what from durable records

#### Out of scope

* The sponsor bank's own core-banking internals (how it posts to the general ledger, its own regulatory capital) — treated as an external system this design integrates with and reconciles against
* Card authorization and settlement mechanics end to end (the authorization-versus-settlement timing gap is described only where it complicates reconciliation)
* KYC/AML identity verification and sanctions screening as engineered subsystems — named as required BaaS responsibilities, not designed here
* Lending, interest accrual, and interchange-revenue accounting layered on top of the same deposit substrate
* Cross-border and multi-currency pooling

### Constraints and assumptions

#### State assumptions

* A single BaaS program may serve **several million end users** whose funds are commingled in **one pooled FBO account per sponsor bank**, so the sub-ledger, not the bank statement, is the only record of individual ownership
* The **sub-ledger and the bank balance are owned by different legal entities** (fintech or middleware versus sponsor bank), which is the structural root of the reconciliation risk — neither party unilaterally holds the complete truth
* Every value movement must be recorded as **balanced double-entry rows**; money is never created or destroyed in the sub-ledger, only moved between named sub-accounts
* The reconciliation invariant `sum(sub_ledger) == bank_balance` must hold at least at **daily close**, and any drift beyond a tiny tolerance is a correctness incident that halts distributions, not a metric to watch passively
* Amounts are stored as **integer minor units (cents)**, never floating point, so summing millions of sub-balances can never introduce rounding drift that looks like a real discrepancy
* **FDIC pass-through insurance** is contingent, not automatic: the FBO account must disclose its agency/custodial nature in the bank's own account records, and records revealing the identities and ownership interests of the underlying principals must exist and be accurate — a broken sub-ledger can therefore also break insurance eligibility
* Availability matters, but **correctness of ownership attribution dominates** — a program that is briefly slow is an inconvenience; a program whose sub-ledger cannot be reconciled to the pool is an existential event for its users

#### Calculate usage

* Program size: assume **3,000,000 end users** on one BaaS program, average balance 500 dollars → pooled FBO balance ≈ **1.5 billion dollars** sitting in a single bank account whose only per-user breakdown is the middleware's sub-ledger. The entire risk surface is that this one number and the sub-ledger's three-million-row sum must agree.
* Sub-ledger write volume: if each user averages **3 balance-affecting events/day** (a card purchase, a transfer, an interest or fee posting), that is 9,000,000 events/day → 9,000,000 / 86,400 ≈ **~105 postings/sec average**, with card traffic peaking maybe **10x** around midday and paydays → **~1,000 postings/sec peak**. Each posting is at least two rows (double-entry), so **~2,000 ledger rows/sec** at peak.
* Sub-ledger storage: a ledger row (`entry_id`, `posting_id`, `sub_account_id`, `direction`, `amount_cents`, `currency`, `created_at`, small metadata) ≈ **~250 bytes** → 18,000,000 rows/day × 250 bytes ≈ **~4.5 GB/day**, **~1.6 TB/year** — modest; this is a correctness problem, not a volume problem. The append-only, never-updated-in-place shape means the store grows monotonically and reconciles against a point-in-time snapshot.
* Reconciliation cost: the daily job sums the sub-ledger for a program (3,000,000 sub-accounts) and compares one number to the bank's end-of-day FBO balance. Summing a partitioned, indexed integer column over a few million rows is seconds-to-minutes, cheap enough to run **per program, per sponsor bank, every business day**, and cheap enough to run intraday for high-value programs.
* Insurance ceiling arithmetic: FDIC pass-through coverage is per end user up to the standard **250,000 dollar** limit, computed on each principal's interest — which is only knowable if the sub-ledger accurately states each principal's interest, tying the insurance math directly to sub-ledger integrity.
* Blast radius: with only about a dozen sponsor banks doing BaaS at scale and some middleware providers serving **100-plus fintech programs**, a single middleware or sponsor-bank failure is not one program's outage but a systemic **concentration-risk** event across every program on that layer.

## Step 2: Create a high-level design

![Banking-as-a-Service stack: a fintech UX layer on top, a BaaS middleware maintaining a per-customer sub-ledger, a chartered sponsor bank holding one pooled FBO account, and payment networks underneath, with a reconciliation link asserting that the sum of the sub-ledger equals the bank balance](/img/case-studies/fintech/banking-as-a-service-overview.svg)

A Banking-as-a-Service arrangement is a **four-layer stack**, and the whole point is that responsibility is rented rather than owned. At the top sits the **fintech app** — the brand and user experience the customer actually sees (a Cash App, a Chime, a Mercury). It owns the customer relationship but holds no bank charter. Below it sits a **BaaS middleware** (a Marqeta, a Galileo, a Unit, or historically a Synapse), a technology company that exposes APIs for card issuing, transaction processing, KYC/AML, and — most importantly for this design — **ledger management**. Below that sits the **sponsor bank** (an Evolve, a Cross River, a Sutton), a real chartered bank that is legally authorized to hold deposits and connect to the card networks. Underneath everything are the **payment networks** — Visa and Mastercard for cards, ACH for bank transfers, Fedwire for wires, RTP and FedNow for real-time — which the sponsor bank, not the fintech, has direct membership in.

The single structural fact that makes this design hard is where the money and the record of ownership live. When a user deposits money into the fintech app, the funds do not sit in a fintech vault; they land at the sponsor bank in a pooled **FBO account** — one bank account holding the commingled deposits of every customer of the program, titled "for benefit of" those customers. The sponsor bank, looking at that account, sees a single large balance. It does **not** natively know that of a 1.5-billion-dollar pool, Alice owns 420 dollars and Bob owns 315. That per-customer breakdown lives only in the **sub-ledger** maintained one layer up, in the middleware. So the authoritative record of *how much money exists* (the bank balance) and the authoritative record of *who owns it* (the sub-ledger) are held by two different companies. The bet of this entire design is that those two records are kept provably equal at all times through continuous reconciliation — because the moment they can silently diverge, and the company holding the sub-ledger stops maintaining it, nobody can prove who owns what. That is not a hypothetical; it is exactly the mechanism by which the Synapse failure froze customer funds, and it is the invariant every component below exists to protect.

## Step 3: Design core components

### Use case: The pooled FBO account and the double-entry sub-ledger

Before any transfer or reconciliation, the representation has to be right. The bank holds one **FBO deposit account** per program; inside it, the middleware carves the pool into **sub-accounts**, one per end user, and records every movement as balanced double-entry rows. The pool total is never stored as a single mutable number in the sub-ledger — it is *derived* by summing the rows, which is exactly what makes the reconciliation against the bank's balance meaningful rather than circular.

**Core spec: FBO pool, sub-accounts, and the double-entry sub-ledger**

```sql
-- One row per pooled bank account the program holds at a sponsor bank.
CREATE TABLE fbo_accounts (
    fbo_account_id   BIGINT       PRIMARY KEY,
    program_id       BIGINT       NOT NULL,
    sponsor_bank     VARCHAR(64)  NOT NULL,   -- e.g. 'evolve', 'cross_river'
    bank_account_ref VARCHAR(64)  NOT NULL,   -- the bank's own account number for the FBO
    currency         CHAR(3)      NOT NULL,
    -- The account title the BANK records must disclose the custodial/agency
    -- nature ('... for benefit of customers'); this is an FDIC pass-through
    -- condition, tracked here so it is never silently lost.
    account_title    VARCHAR(255) NOT NULL
);

-- One sub-account per end user within a pooled FBO account.
CREATE TABLE sub_accounts (
    sub_account_id   BIGINT       PRIMARY KEY,
    fbo_account_id   BIGINT       NOT NULL REFERENCES fbo_accounts(fbo_account_id),
    end_user_id      BIGINT       NOT NULL,   -- the actual principal / beneficial owner
    currency         CHAR(3)      NOT NULL,
    UNIQUE (fbo_account_id, end_user_id)
);

-- Append-only double-entry rows. A single logical event ("posting") writes
-- >= 2 rows that MUST net to zero: total debits equal total credits.
CREATE TABLE sub_ledger_entries (
    entry_id         BIGINT       PRIMARY KEY,
    posting_id       BIGINT       NOT NULL,   -- groups the entries of one event
    sub_account_id   BIGINT       NOT NULL REFERENCES sub_accounts(sub_account_id),
    fbo_account_id   BIGINT       NOT NULL REFERENCES fbo_accounts(fbo_account_id),
    direction        VARCHAR(6)   NOT NULL,   -- 'DEBIT' or 'CREDIT'
    amount_cents     BIGINT       NOT NULL,   -- integer minor units, always positive
    currency         CHAR(3)      NOT NULL,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT dir_chk CHECK (direction IN ('DEBIT','CREDIT'))
);
CREATE INDEX idx_entries_posting ON sub_ledger_entries (posting_id);
CREATE INDEX idx_entries_subacct ON sub_ledger_entries (sub_account_id, created_at);
CREATE INDEX idx_entries_fbo     ON sub_ledger_entries (fbo_account_id);
```

**Data structures:** `fbo_accounts` (the pooled bank accounts and their FDIC-relevant titles), `sub_accounts` (per-principal ownership slots), and the append-only `sub_ledger_entries` (the double-entry money-movement record). A sub-account's balance is `sum(CREDIT) - sum(DEBIT)` over its entries — a derived value, never a stored mutable field. Note the sign convention here: from the pool's point of view a user deposit *credits* their sub-account (the pool owes them more), so a user's balance is credits minus debits.

**Trade-offs:**
* **The gotcha:** the tempting shortcut is to store each user's balance as a single mutable `balance_cents` column and update it in place on every event. That throws away the one property that makes the pool reconcilable and auditable — that value is only ever *moved* between named sub-accounts, never conjured, and that this is mechanically checkable by summing rows rather than trusting a counter. A corrupted or half-applied in-place update produces a wrong balance with no trail; a broken double-entry posting is caught the instant its rows fail to net to zero. The fix is that the sub-ledger is append-only and every posting is balanced by construction, so the pool total is always a reproducible sum, which is exactly what the reconciliation job compares against the bank.
* Integer cents everywhere is not a stylistic choice: summing three million sub-balances in floating point would eventually produce a fractional-cent drift that is indistinguishable, at the reconciliation step, from a real missing-money discrepancy. Exact integer arithmetic keeps "the sums don't match" meaning "money is actually unaccounted for," never "floating point rounded."

### Use case: A transfer debits one sub-account and credits another within the same FBO

The everyday internal transfer — Alice pays Bob, both customers of the same fintech — is the case that most clearly shows why the pool works. No money leaves the sponsor bank. The FBO account's bank balance does not change at all. Only the *sub-ledger* changes: Alice's sub-account is debited and Bob's is credited, by equal amounts, in one atomic balanced posting. The bank balance and the sub-ledger sum both stay put, so the reconciliation invariant is preserved by construction.

**Core spec: an atomic, balanced intra-pool transfer**

```python
from dataclasses import dataclass

@dataclass
class Posting:
    posting_id: int
    entries: list          # list of dicts, each a DEBIT or CREDIT row

def build_transfer_posting(db, from_sub_account, to_sub_account, amount_cents, now):
    """Move `amount_cents` from one sub-account to another INSIDE the same
    FBO pool. Writes a balanced double-entry posting: one DEBIT, one CREDIT,
    equal amounts, same currency. The bank balance is untouched -- money did
    not leave the pool, so this transfer cannot, by construction, change
    sum(sub_ledger) and therefore cannot break reconciliation.
    """
    if amount_cents <= 0:
        raise ValueError("amount must be positive")

    src = db.get_sub_account(from_sub_account)
    dst = db.get_sub_account(to_sub_account)
    if src.fbo_account_id != dst.fbo_account_id:
        # A cross-pool transfer is NOT an internal book entry; it is real money
        # movement between two bank accounts and must go through settlement,
        # not this path. Refusing here keeps the invariant local to one pool.
        raise ValueError("cross-FBO transfers must use the settlement path, not a book entry")
    if src.currency != dst.currency:
        raise ValueError("currency mismatch")
    if db.sub_account_balance(from_sub_account) < amount_cents:
        raise ValueError("insufficient sub-account balance")

    posting_id = db.next_posting_id()
    entries = [
        {"entry_id": db.next_entry_id(), "posting_id": posting_id,
         "sub_account_id": from_sub_account, "fbo_account_id": src.fbo_account_id,
         "direction": "DEBIT", "amount_cents": amount_cents,
         "currency": src.currency, "created_at": now},
        {"entry_id": db.next_entry_id(), "posting_id": posting_id,
         "sub_account_id": to_sub_account, "fbo_account_id": dst.fbo_account_id,
         "direction": "CREDIT", "amount_cents": amount_cents,
         "currency": dst.currency, "created_at": now},
    ]
    return Posting(posting_id=posting_id, entries=entries)

def posting_is_balanced(entries):
    """A posting is valid only if total debits equal total credits.
    Returns (is_balanced, debits, credits) so the caller decides how to react.
    """
    debits  = sum(e["amount_cents"] for e in entries if e["direction"] == "DEBIT")
    credits = sum(e["amount_cents"] for e in entries if e["direction"] == "CREDIT")
    return debits == credits, debits, credits

def commit_transfer(db, from_sub_account, to_sub_account, amount_cents, now):
    posting = build_transfer_posting(db, from_sub_account, to_sub_account, amount_cents, now)
    balanced, debits, credits = posting_is_balanced(posting.entries)
    if not balanced:
        # Never persist a known-unbalanced posting: it would silently corrupt
        # the pool sum and surface later as an unexplained reconciliation gap.
        raise ValueError(f"refusing unbalanced posting: debits={debits} credits={credits}")
    db.write_all_atomic(posting.entries)   # single transaction: all rows or none
    return posting
```

**Data structures:** reuses `sub_ledger_entries` — a transfer is just one `posting_id` with a matched DEBIT/CREDIT pair. There is deliberately no separate "transfers" table, because a transfer is structurally nothing more than a balanced pair of ledger rows, the same way a deposit, a card purchase, or a fee is.

**Trade-offs:**
* **The gotcha:** an intra-pool transfer feels like it should touch the bank, and a naive implementation might issue an actual bank instruction for every user-to-user payment. That is both unnecessary (the money never leaves the pool) and dangerous (it introduces a bank-side movement that the sub-ledger must now chase and reconcile, opening a drift window for a transfer that should have been a pure book entry). The fix is the guard above: same-FBO transfers are internal book entries that leave `sum(sub_ledger)` and `bank_balance` both unchanged, while genuine cross-pool or external movement is routed through the settlement path where a real bank transaction is expected and reconciled.
* Writing the DEBIT and CREDIT in one atomic transaction is non-negotiable. If a crash could leave the debit persisted without its credit, the pool sum would drop by the transfer amount with no offsetting row — a self-inflicted reconciliation discrepancy indistinguishable from missing money. Atomicity is what keeps the invariant true through partial failure.

**REST API:**

```
$ curl -X POST https://baas.example/api/v1/programs/prog_88/transfers \
    -H "Authorization: Bearer <program-token>" \
    -H "Idempotency-Key: 3f1a-alice-to-bob-0007" \
    -d '{
          "from_sub_account": "sub_alice_0420",
          "to_sub_account":   "sub_bob_0315",
          "amount_cents": 5000,
          "currency": "USD"
        }'
```

Response:

```json
{
  "posting_id": "post_99120",
  "status": "POSTED",
  "from_sub_account": "sub_alice_0420",
  "to_sub_account": "sub_bob_0315",
  "amount_cents": 5000,
  "currency": "USD",
  "pool_balance_unchanged": true,
  "created_at": "2026-08-12T10:41:22Z"
}
```

### Use case: The fintech-to-bank reconciliation job

This is the component the whole case study exists for. The sub-ledger says who owns what; the sponsor bank says how much is actually in the pool. The reconciliation job's single responsibility is to prove those two numbers equal for every program and every FBO account, on every business day, and to *stop the bleeding* the instant they are not — because an undetected discrepancy that is allowed to grow is exactly how a recoverable bookkeeping error becomes an unrecoverable "nobody can prove who owns what."

**Core spec: the reconciliation invariant and its enforcement**

```python
def sub_ledger_total_cents(db, fbo_account_id, as_of):
    """Authoritative pool total as recorded by the sub-ledger: sum of all
    CREDITs minus all DEBITs across every sub-account in this FBO, up to the
    reconciliation cut-off time. Integer arithmetic only.
    """
    credits = db.sum_entries(fbo_account_id, direction="CREDIT", until=as_of)
    debits  = db.sum_entries(fbo_account_id, direction="DEBIT",  until=as_of)
    return credits - debits

def reconcile_fbo(db, bank, fbo_account_id, as_of, tolerance_cents=0):
    """The core BaaS invariant:  sum(sub_ledger) must equal bank_balance.

    Pulls the sponsor bank's own end-of-day balance for the FBO account and
    compares it to the sub-ledger total. Any drift beyond `tolerance_cents`
    (normally 0 -- money does not have a rounding budget) is a correctness
    INCIDENT: the program is frozen for new debits/distributions and an
    operator is paged, rather than letting the gap grow silently.

    Returns a ReconResult the caller records durably as an audit artifact.
    """
    ledger_total = sub_ledger_total_cents(db, fbo_account_id, as_of)
    bank_balance = bank.get_fbo_balance(fbo_account_id, as_of)   # from the bank's statement/API

    drift = ledger_total - bank_balance
    reconciled = abs(drift) <= tolerance_cents

    result = {
        "fbo_account_id": fbo_account_id,
        "as_of": as_of,
        "sub_ledger_total_cents": ledger_total,
        "bank_balance_cents": bank_balance,
        "drift_cents": drift,               # +ve: ledger claims more than the bank holds
        "reconciled": reconciled,
    }
    db.record_recon_result(result)          # durable, immutable audit row

    if not reconciled:
        # Freeze BEFORE the gap can widen. Distributions and new debits against
        # this pool are blocked until a human resolves the discrepancy, because
        # paying anyone out of a pool that does not sum correctly risks paying
        # them with another customer's money.
        db.freeze_program(fbo_account_id, reason="reconciliation_drift", drift_cents=drift)
        raise ReconciliationError(
            f"FBO {fbo_account_id} drift {drift} cents "
            f"(ledger={ledger_total}, bank={bank_balance})"
        )
    return result

class ReconciliationError(Exception):
    pass
```

**Data structures:** an immutable `reconciliation_results` table — `fbo_account_id`, `as_of`, `sub_ledger_total_cents`, `bank_balance_cents`, `drift_cents`, `reconciled`, `created_at` — one row per program per bank per cycle. Because it is append-only, it is itself an audit trail: a trustee or examiner can read the exact day drift first appeared and how it evolved. A `program_freezes` table records active freezes with their triggering drift.

**Trade-offs:**
* **The gotcha:** the catastrophic failure mode is not that a discrepancy occurs — small timing gaps between authorization and settlement produce transient, explainable differences all the time. The catastrophe is that the discrepancy is *tolerated and allowed to grow* because the two records live in different companies and no owner treats reconciliation as a hard gate. In the Synapse collapse the trustee reported an roughly 85-million-dollar shortfall between what the partner banks held and what the sub-ledgers said customers were owed, and Evolve Bank reportedly could not reconcile its deposits against Synapse's ledgers at all — the proprietary ledger system was too difficult to interpret without Synapse's own people, who were gone. The fix embodied above is to make reconciliation a *blocking daily gate with an immutable audit trail and an automatic freeze on drift*, run by a party that can read both sides, so a gap is caught at cents-scale on day one instead of discovered at tens-of-millions-scale in a bankruptcy.
* Setting `tolerance_cents = 0` for the true book invariant, while modeling the authorization-versus-settlement timing gap as *explicitly enumerated in-flight items* rather than as a slop tolerance, is deliberate. A nonzero tolerance is a place for real discrepancies to hide; instead, known pending card authorizations and unsettled ACH are reconciled as named line items (a three-way match of sub-ledger, network, and bank), so the residual that must be exactly zero really is exactly zero.

### Use case: The failure mode — sub-ledger and bank balance drift apart

It is worth designing the failure explicitly, because "what happens when the invariant breaks" is the difference between a contained incident and a Synapse. Drift has a small number of root causes, and each has a specific detection and containment response; the shared principle is that the sub-ledger is never blindly trusted once it disagrees with the bank, and no customer is paid out of a pool that does not sum.

**Core spec: classifying and containing drift**

```python
def classify_drift(db, network, bank, fbo_account_id, as_of):
    """When reconcile_fbo reports drift, decompose it before reacting. Most
    real drift is timing (in-flight authorizations/settlement) and resolves
    itself; a residual that is NOT explained by in-flight items is true,
    unaccounted drift -- the dangerous kind that must freeze the program.
    """
    drift = (sub_ledger_total_cents(db, fbo_account_id, as_of)
             - bank.get_fbo_balance(fbo_account_id, as_of))

    # Timing component: card auths approved but not yet settled, ACH in flight.
    pending_auths   = network.sum_pending_authorizations(fbo_account_id, as_of)
    unsettled_ach   = network.sum_unsettled_ach(fbo_account_id, as_of)
    explained = pending_auths + unsettled_ach

    residual = drift - explained          # what remains after timing is accounted for
    if residual == 0:
        return {"status": "TIMING_ONLY", "explained_cents": explained}

    # A nonzero residual is real: money the sub-ledger claims exists but the
    # bank does not hold (or vice versa). Freeze and escalate -- do NOT let a
    # distribution proceed against an unbalanced pool.
    db.freeze_program(fbo_account_id, reason="unexplained_drift", drift_cents=residual)
    return {"status": "UNEXPLAINED_DRIFT", "residual_cents": residual,
            "explained_cents": explained, "action": "FROZEN"}
```

**Data structures:** reuses `reconciliation_results` and `program_freezes`; adds a `drift_investigations` record linking a residual to its eventual root cause (a dropped posting, a mis-booked settlement, a double-counted authorization) so the resolution is auditable and the same class of bug can be prevented from recurring.

**Trade-offs:**
* **The gotcha:** a residual drift is genuinely ambiguous about *direction of harm* — if the sub-ledger claims more than the bank holds, paying everyone their sub-ledger balance would overdraw the pool and pay some users with other users' money; if the bank holds more than the sub-ledger claims, some customer's ownership was dropped from the record entirely. Both are unacceptable to "resolve" by guessing. The only safe move is to freeze distributions and reconstruct ownership from the immutable posting history and the bank's transaction record, three-way-matched against the network — which is precisely the months-long forensic exercise a bankruptcy trustee is forced into when reconciliation was not a standing gate. Designing the freeze-and-reconstruct path *before* it is needed is what keeps a drift incident recoverable.
* This is also why the append-only, integer-cent, double-entry sub-ledger from the first use case is load-bearing rather than pedantic: reconstruction is only possible if every historical movement is a durable, balanced, replayable row. A mutable-balance design offers nothing to reconstruct from.

### Use case: Preserving FDIC pass-through insurance eligibility

End users assume their fintech balance is FDIC-insured. It can be — through **pass-through** coverage — but only if specific conditions hold, and those conditions are a direct function of the same ledger integrity the rest of this design protects. Coverage is not a property of the app's marketing; it is a property of how the FBO account is titled and how accurately the underlying ownership is recorded.

**Core spec: the pass-through eligibility checks**

```python
def pass_through_eligible(db, fbo_account_id, as_of):
    """FDIC pass-through coverage flows to each end user (up to the standard
    per-depositor limit) ONLY if the custodial arrangement meets its
    conditions. This encodes the two that this system controls:

      1. The BANK's account records disclose the agency/custodial ('FBO')
         nature of the account -- the pool is titled as held for the benefit
         of the underlying customers, not owned by the fintech.
      2. Records exist that reveal the identities of the principals and their
         ownership interests -- i.e. the sub-ledger is accurate and reconciles.

    If either fails, deposits may be treated as the named account holder's own
    funds, and coverage does not pass through to end users.
    """
    fbo = db.get_fbo_account(fbo_account_id)

    titled_as_custodial = "for benefit of" in fbo.account_title.lower() \
                          or "fbo" in fbo.account_title.lower()

    latest = db.latest_reconciliation(fbo_account_id, as_of)
    ownership_records_accurate = latest is not None and latest["reconciled"]

    eligible = titled_as_custodial and ownership_records_accurate
    return {
        "fbo_account_id": fbo_account_id,
        "titled_as_custodial": titled_as_custodial,
        "ownership_records_accurate": ownership_records_accurate,
        "pass_through_eligible": eligible,
    }

def insured_amount_cents(sub_account_balance_cents, per_depositor_limit_cents=250_000 * 100):
    """Per-principal coverage is computed on that principal's ownership
    interest, capped at the standard limit. This is only correct if the
    sub-ledger's statement of the interest is correct -- coverage math and
    ledger integrity are the same problem.
    """
    return min(sub_account_balance_cents, per_depositor_limit_cents)
```

**Data structures:** reuses `fbo_accounts.account_title` (the bank-side titling condition) and the `reconciliation_results` history (evidence the ownership records are accurate). No new durable structure is required, which is the point: insurance eligibility is derived from artifacts the design already maintains for correctness.

**Trade-offs:**
* **The gotcha:** it is easy to assume pass-through insurance is automatic because the money "is at an FDIC-insured bank." It is not — if the FBO account is not titled to disclose its custodial nature, or the records identifying each principal's interest are inaccurate, coverage can fail to pass through and the whole pool may be treated as the account holder's own funds. A broken sub-ledger therefore does not merely make ownership unprovable; it can also void the very insurance customers were counting on. The fix is to treat titling and reconciliation status as insurance-relevant invariants and monitor them as such, not as back-office paperwork.
* Pass-through coverage protects against the *bank* failing; it does nothing about the *middleware or fintech* failing with an irreconcilable ledger, which is the Synapse scenario. Practitioners must be clear-eyed that FDIC insurance and reconciliation integrity cover different risks, and that the latter is the one BaaS-specific failure the insurance was never designed to address.

## Step 4: Scale the design

![Scaled Banking-as-a-Service: multiple fintech programs feeding a BaaS middleware whose sub-ledger is sharded per program, several sponsor banks each holding a pooled FBO account, a daily reconciliation job asserting the sub-ledger sum equals each bank balance and freezing on drift, and concentration risk when a shared middleware or bank fails](/img/case-studies/fintech/banking-as-a-service-scaled.svg)

* **The sub-ledger shards by program (and by FBO account within a program), because the reconciliation invariant is naturally scoped to one pool** — see [Sharding](/docs/patterns/storage/sharding). Every posting, sum, and reconciliation for a pool lives on one shard, so the daily `sum(sub_ledger) == bank_balance` check never needs a cross-shard transaction, and one program's write load never contends with another's. Because the sub-ledger is append-only with no in-place mutation, sharding introduces none of the write-contention pain a frequently-updated-balance model would.
* **The reconciliation job runs as an independent scheduled batch, off the hot posting path** — see [Change Data Capture](/docs/patterns/batch-streaming/change-data-capture) as the mechanism for streaming committed ledger postings into the reconciliation and reporting store without slowing the write path. Reconciliation reads a point-in-time snapshot of the sub-ledger and the bank's end-of-day balance; it is defense-in-depth run continuously, not a step in the critical path of a transfer.
* **Each internal transfer is made safe to retry with an idempotency key, exactly as a payment is** — see [Idempotency](/docs/patterns/reliability/idempotency). A program's client that times out and resends a transfer must not produce a second balanced posting; the same idempotency-key discipline the payment-processor case study uses converts a retry into a replay of the one true outcome, so retries can never inflate the sub-ledger and manufacture drift.
* **Movement that genuinely crosses banks — funding the pool, sweeping between sponsor banks, external ACH — is coordinated as a saga with explicit compensation, not a distributed lock across the fintech and the bank** — see [Saga](/docs/patterns/consistency/saga). Holding a two-phase lock across an independently-operated sponsor bank for the duration of a settlement round-trip is what [Two-Phase Commit](/docs/patterns/consistency/two-phase-commit) handles poorly; instead each leg is a local commit with a compensating reversal, and the reconciliation job is the backstop that catches any leg that committed on one side but not the other.
* **Each sponsor-bank integration gets a [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) and per-bank isolation** — see [Bulkhead](/docs/patterns/reliability/bulkhead). Banks fail independently, and this is where **concentration risk** bites: a middleware serving 100-plus programs, or a sponsor bank serving dozens, is a single point whose failure freezes every program on it. Bulkheading bank and program adapters bounds one failing dependency away from the rest, and a program that cannot reach its sponsor bank fails its distributions fast and visibly rather than silently drifting.
* **The reconciliation-results and posting history are the audit substrate, stored append-only and retained** — see [Event Sourcing](/docs/patterns/storage/event-sourcing). Ownership at any past instant is reconstructable by replaying postings, which is exactly what a trustee needs when a middleware fails; the immutable event log, not a latest-balance snapshot, is the authoritative record, mirroring how this course's ledger designs treat the log as truth.

## Additional talking points

* **Why "the money is at an FDIC-insured bank" is not the same as "your money is safe."** Pass-through insurance protects depositors if the *sponsor bank* fails, subject to correct titling and accurate ownership records. It does nothing when the *middleware* fails with an irreconcilable ledger — the funds may still be sitting at a perfectly solvent bank, but if nobody can prove whose they are, they are frozen all the same. The Synapse collapse froze customer funds not because a bank went insolvent but because the record of ownership and the record of funds were held by different companies and could not be reconciled. Ledger integrity and deposit insurance are orthogonal protections; conflating them is the industry's most dangerous simplification.
* **Reconciliation must be a hard gate owned by a party that can read both sides.** The structural weakness of BaaS is that the sub-ledger and the bank balance are owned by different entities, each with an incomplete view. If reconciliation is left to whichever party is least incentivized to surface a gap, drift grows unobserved. Post-Synapse, regulators and the FDIC have moved toward requiring banks in these arrangements to maintain records of the end-user beneficial owners and to reconcile pooled custodial accounts at the close of each business day — codifying as a rule what this design treats as the core invariant.
* **Authorization-versus-settlement timing is a reconciliation complication, not an excuse for a slop tolerance.** A card is authorized in about 100 to 300 milliseconds, but the money settles one to three days later, so the sub-ledger, the network, and the bank are transiently out of step by design. The correct handling is a three-way match that enumerates in-flight authorizations and unsettled transfers as named line items, driving the residual that must be exactly zero to exactly zero — rather than reconciling with a fuzzy tolerance in which real losses can hide.
* **Concentration risk is a systemic property, not a per-program bug.** With roughly a dozen sponsor banks and a handful of middleware providers carrying much of the ecosystem, a single failure at those layers is not one outage but a correlated event across every program riding on it — as when a 2024 consent order against a sponsor bank forced every fintech on it to scramble at once. Designing a program to be portable across sponsor banks, and to hold reconciled records independent of any one middleware, is the practitioner's hedge against a dependency they do not control.
* **KYC, AML, and the compliance "game of telephone."** The sponsor bank holds the charter and is legally liable for the program's conduct, yet does not run the fintech's day-to-day operations — it trusts the middleware, which trusts the fintech, to enforce KYC, AML monitoring, sanctions screening, and suspicious-activity reporting. Compliance obligations can be dropped across those three organizational boundaries, which is why regulators increasingly demand the bank retain direct oversight and direct records rather than delegating them opaquely.
* **The contrast with UPI.** India's model routes fintechs (as third-party app providers) directly onto a public real-time rail operated by NPCI, where the switch holds no funds and money moves directly between the two banks' own accounts — see this course's [UPI case study](/docs/case-studies/fintech/upi-real-time-payments). That structurally avoids the pooled-FBO-plus-private-sub-ledger arrangement whose reconciliation risk this design spends all its effort containing: there is no middleware sub-ledger standing between the customer and their bank account that can drift out of sync in the first place.

## Source(s) and further reading

* [Pass-through Deposit Insurance Coverage — FDIC](https://www.fdic.gov/financial-institution-employees-guide-deposit-insurance/pass-through-deposit-insurance-coverage) — the primary source for the two conditions this design encodes: the account records must disclose the agency/custodial (FBO) nature, and records must reveal the identities and ownership interests of the principals
* [Notice of Proposed Rulemaking on Custodial Deposit Accounts with Transaction Features — FDIC](https://www.fdic.gov/news/speeches/2024/notice-proposed-rulemaking-custodial-deposit-accounts-transaction-features-and) — the FDIC's post-Synapse move to require banks to keep records of end-user beneficial owners and reconcile pooled custodial accounts at each business-day close, matching this design's daily reconciliation gate
* [FDIC proposes to strengthen custodial deposit account recordkeeping in bank-fintech partnerships — Davis Polk](https://www.davispolk.com/insights/client-update/fdic-proposes-strengthen-custodial-deposit-account-recordkeeping-bank) — practitioner analysis of that proposed rule and the daily-reconciliation and beneficial-owner-recordkeeping requirements it imposes
* [Synapse bankruptcy trustee says 85 million dollars of customer savings is missing — CNBC](https://www.cnbc.com/2024/06/07/synapse-bankruptcy-trustee-85-million-of-customer-savings-is-missing.html) — the trustee's finding of the roughly 85-million-dollar shortfall between what the partner banks held and what the sub-ledgers said customers were owed
* [Synapse trustee finds 85 million dollar gap in frozen funds — Banking Dive](https://www.bankingdive.com/news/synapse-85-million-shortfall-partner-banks-mcwilliams/718796/) — reporting the specific reconciliation failure, including that Evolve could not reconcile its deposits against Synapse's ledgers because the proprietary ledger system was hard to interpret without Synapse's own expertise
* [The spectacular Synapse collapse — Fortune](https://fortune.com/2025/03/07/synapse-evolve-mercury-bankruptcy-lawsuits/) — a longer retrospective on how separating funds from records without bulletproof reconciliation froze customer money across multiple fintechs
* [Banking as a service — Wikipedia](https://en.wikipedia.org/wiki/Banking_as_a_service) — consolidated reference for the fintech / middleware / sponsor-bank stack, the rent-not-build model, and the role of chartered partner banks
* [UPI — Real-Time Payments](/docs/case-studies/fintech/upi-real-time-payments) — the contrasting model where a public switch holds no funds and there is no middleware sub-ledger to drift out of sync
* [Idempotency](/docs/patterns/reliability/idempotency) — makes each internal transfer safe to retry so a resend can never inflate the sub-ledger
* [Saga](/docs/patterns/consistency/saga) and [Two-Phase Commit](/docs/patterns/consistency/two-phase-commit) — the coordination pattern used for genuine cross-bank movement, and the blocking alternative it is preferred over
* [Sharding](/docs/patterns/storage/sharding) and [Event Sourcing](/docs/patterns/storage/event-sourcing) — how the per-pool sub-ledger partitions and stays reconstructable for audit
