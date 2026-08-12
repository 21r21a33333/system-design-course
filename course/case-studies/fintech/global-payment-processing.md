---
title: "Design Global Payment Processing (PayPal)"
sidebar_position: 4
---

The defining property of a PayPal-style platform, and the thing that separates it from the generic payment processor elsewhere in this course, is that it **holds a balance**. A pure processor only orchestrates: it moves money from a card to a merchant and records that it happened, but it never owns the funds in between. A digital wallet is stored value — a user tops up from a card or bank, that money sits as a spendable balance the platform is now custodian of, and later moves to another user or out to a bank. The hardest constraint that follows is that the platform's own books must be correct to the minor unit at all times: a user's balance is not a number the system is free to set, it is a value *derived* by summing an append-only double-entry ledger, and every top-up, send, payout, fee, hold, and currency conversion has to land in that ledger as a balanced set of entries or the platform is, quite literally, missing money it is legally on the hook for. Everything below is organized around keeping that ledger balanced, in integer minor units, across many currencies, exactly once, while risk and compliance decide whose money can move and when.

This case study designs a system with PayPal's shape — a stored-value multi-currency wallet sitting between funding sources and payees across countries — and grounds each component in how real ledger, currency, and money-movement systems work.

## Step 1: Outline use cases and constraints

### Use cases

#### We'll scope the problem to handle the following use cases

* A **consumer** funds their wallet from a **funding source** — a card, a bank account over ACH, or an existing wallet balance — creating spendable stored value the platform now holds on their behalf
* A consumer **sends money** to another wallet (a peer or a merchant), moving value between two internal accounts without touching an external rail at all
* A consumer or merchant **withdraws / gets paid out** from their wallet balance to an external bank account or card
* The platform maintains each user's balance as a **double-entry ledger** — balances are derived by summing immutable entries, never stored as a single mutable number
* The platform holds balances in **multiple currencies** per user (a USD sub-ledger, a EUR sub-ledger, and so on), each in that currency's integer **minor units**
* The platform performs **currency conversion** when a payment crosses currencies, at a rate that includes a **spread** over the market mid-rate, recorded as its own balanced ledger posting
* Every money movement is **idempotent**: a retried request for the same logical operation never moves money twice
* **Risk and fraud** controls can place a **hold** on funds (delaying availability) and later release or reverse them, and the balance the user can spend reflects those holds
* **Compliance** — KYC at onboarding and AML/sanctions screening on movement — gates whether a given user or transfer is allowed to proceed
* The platform records a durable, auditable, queryable history of every entry and its outcome

#### Out of scope

* The card networks' and banks' own internals (ISO 8583 authorization, interbank settlement, ACH batch mechanics) — treated as external rails the wallet integrates with, designed in the card/processor case studies, not here
* Buyer/seller **dispute and chargeback** adjudication workflows beyond noting where a reversal posts to the ledger
* Merchant onboarding, lending, credit, and interest-on-balance products layered on top of the wallet
* The machine-learning modeling behind fraud scores — treated as a scoring service the money-movement path calls, not designed here
* Tax reporting and regulatory filing pipelines

### Constraints and assumptions

#### State assumptions

* On the order of **30 million money-movement operations per day** across all users (top-ups, sends, payouts, conversions) — PayPal-scale consumer volume, higher than the correctness-bound-but-low-volume generic processor case study, lower than a national real-time rail like UPI
* A user's **balance is authoritative and must never be wrong**: it is the running sum of that account's ledger entries, and the ledger must stay balanced (total debits equal total credits, per currency) at all times
* No operation may **double-move money** under client retries, redelivered internal messages, or a timeout that hides whether the first attempt committed — this is a hard correctness requirement
* No accepted operation may be **silently lost**: every one reaches a terminal state (posted, declined, or held-for-review) that is durably recorded and queryable
* Money is represented **only in integer minor units** of a currency (cents for USD, so `$49.99` is `4999`; and note zero-decimal currencies like JPY where the minor unit *is* the major unit) — never floating point, so no rounding can create or destroy value
* **Holds** mean a user's *available* balance can be lower than their *total* balance; the system must track both and never let a user spend held funds
* **Consistency beats latency**: a wallet that is occasionally slow is a minor annoyance; a wallet whose balance is wrong is an incident. The whole design trades some performance for stronger guarantees
* Availability must be very high — a wallet users cannot pay from is a visible outage — but correctness comes first when the two conflict

#### Calculate usage

* Operation volume: 30,000,000 ops/day → 30,000,000 / 86,400 ≈ **~350 ops/sec average**. Consumer money movement peaks hard around paydays, sales events, and evenings — design for roughly **10x average at peak**, so on the order of **~3,500 ops/sec**. This is correctness-bound, not volume-bound: the pressure is on getting every posting balanced and exactly-once, not on absorbing a huge rate.
* Ledger write amplification: one user-visible operation is rarely one row. A simple send is a balanced pair (a debit and a credit); a send with a platform fee is two pairs; a cross-currency send adds a conversion posting. Budget **~2 to 6 ledger entries per operation** → at peak on the order of **~10,000–20,000 ledger-entry writes/sec**, all of which must land atomically per operation.
* Ledger storage: an entry (`entry_id`, `transfer_id`, `account_id`, `direction`, `amount_minor`, `currency`, `created_at`, small metadata) ≈ **~200 bytes** → 30,000,000 ops/day × ~4 entries × 200 bytes ≈ **~24 GB/day**, **~8.5 TB/year** of append-only ledger — large enough that the ledger shards and tiers old entries to cold storage, and reconciliation runs as a distributed job.
* Balance reads: users check balances and history far more than they move money — assume **~10x reads over writes**, on the order of **~3,500 reads/sec average, ~35,000/sec peak**. Because a balance is *derived* by summing entries, hot accounts keep a maintained running balance (a materialized total) so a read is a single lookup, not a full-history scan — with the ledger remaining the source of truth the materialized balance is reconciled against.
* Idempotency-key lookups: every operation, including retries, checks its key; assuming ~15% of requests are retries, that is roughly **~35,000,000 key checks/day**, a fast, strongly-consistent single-key lookup.
* FX: only cross-currency operations hit the rate engine; assume ~10% of sends cross currencies → **~3,000,000 conversions/day**, each a rate lookup plus one extra balanced posting. Rates refresh on the order of every few seconds to a minute, and the *rate used* is snapshotted onto the transfer so the posting is reproducible.

## Step 2: Create a high-level design

![Digital wallet platform: funding sources such as card, bank/ACH, and existing balance flow in through a wallet API that applies an idempotency key, a KYC/AML gate, risk scoring with holds, and FX at a spread, into a double-entry ledger of balanced debit and credit entries in per-currency sub-ledgers with balances derived by summing entries in integer minor units, and out to payout rails; a hold/release state machine and reconciliation run alongside](/img/case-studies/fintech/global-payment-processing-overview.svg)

The platform sits between **funding sources** on one side and **payees / payout rails** on the other, with a **double-entry ledger** in the middle as its authoritative book of record. A consumer funds their wallet: money comes in from a card or a bank rail, and the platform posts a balanced pair of ledger entries — a credit to the user's wallet account (their balance goes up) and a debit against a platform account that represents "money we are owed from / hold at the rail." From that moment the platform is custodian of stored value. When the user sends money to another wallet, no external rail is touched at all: it is a purely internal posting, a debit against the sender's account and a credit to the receiver's, and the money never leaves the platform's own books. When the user cashes out, the reverse happens — a debit against their wallet balance and a credit to a payout-clearing account, followed by an actual transfer out over a bank or card rail that settles on its own, slower clock.

Every request enters through a **wallet API** that does three things before any money moves. First it applies an **idempotency key**, so a retried request replays the original outcome instead of moving money again. Second it consults **compliance** — is this user KYC-verified to the tier this operation requires, and does the transfer clear AML and sanctions screening? Third it consults **risk**, which may allow the movement, decline it, or place a **hold**: the money posts to the ledger but is marked unavailable to spend until a condition clears. If the operation crosses currencies, the **FX rate engine** supplies a rate — the market mid-rate plus a **spread** the platform keeps — and the conversion is recorded as its own balanced posting in integer minor units, so the books stay exactly balanced across two currencies at once.

Two structural facts separate this from the generic payment-processor case study. First, **this platform holds a balance** and the processor does not — which is exactly why the double-entry ledger, per-currency sub-ledgers, and holds are first-class here and absent there: a processor orchestrates a single charge and forgets it, while a wallet is a standing custodian whose books must be provably correct at rest, not just at the moment of a charge. Second, **the user-visible balance and the external settlement run on different clocks**: the wallet balance updates the instant a ledger entry commits, but the actual funds behind a card top-up or a bank payout settle later, so the platform is always carrying some in-flight, not-yet-settled money it must reconcile against the rails' own statements.

## Step 3: Design core components

### Use case: The wallet balance is a double-entry ledger, per currency, in minor units

Before any specific operation, it is worth pinning down the single most important representation decision: a user's balance is **not a column you update**. It is derived by summing an append-only ledger of immutable entries. Every movement of money is recorded as at least two entries whose amounts net to zero — a debit somewhere and a matching credit somewhere else — so that money is only ever *moved* between named accounts, never created or destroyed. This is [double-entry bookkeeping](https://en.wikipedia.org/wiki/Double-entry_bookkeeping), and it is what makes the platform's books mechanically auditable rather than merely asserted.

**Core spec: multi-currency double-entry ledger schema**

```sql
-- One account per (user, currency). A user with USD and EUR balances
-- has two accounts; there is also a set of internal platform accounts
-- (fees earned, rail-clearing, FX position) that entries post against.
CREATE TABLE accounts (
    account_id    BIGINT       PRIMARY KEY,
    owner_id      BIGINT       NOT NULL,          -- the user, or a platform pseudo-user
    account_type  VARCHAR(24)  NOT NULL,          -- 'user_wallet','fee','rail_clearing','fx_position'
    currency      CHAR(3)      NOT NULL,          -- ISO 4217 alphabetic code, e.g. 'USD','EUR','JPY'
    UNIQUE (owner_id, account_type, currency)     -- at most one wallet per (user, currency)
);

-- The append-only ledger. Balances are DERIVED from this, never stored here.
CREATE TABLE ledger_entries (
    entry_id      BIGINT       PRIMARY KEY,
    transfer_id   BIGINT       NOT NULL,          -- groups all entries of one logical operation
    account_id    BIGINT       NOT NULL REFERENCES accounts(account_id),
    direction     CHAR(2)      NOT NULL,          -- 'DR' (debit) or 'CR' (credit)
    amount_minor  BIGINT       NOT NULL,          -- ALWAYS positive integer minor units
    currency      CHAR(3)      NOT NULL,          -- must equal accounts.currency for account_id
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT amount_positive CHECK (amount_minor > 0),
    CONSTRAINT direction_valid CHECK (direction IN ('DR','CR'))
);
CREATE INDEX idx_entries_transfer ON ledger_entries (transfer_id);
CREATE INDEX idx_entries_account  ON ledger_entries (account_id, created_at);
```

**Core algorithm: deriving a balance and checking the invariant**

```python
def account_balance_minor(entries):
    """A wallet balance is DERIVED, not stored: sum credits, subtract
    debits, over one account's entries. Everything is integer minor
    units, so the result is exact -- no float, no rounding.

    In production a hot account also keeps a maintained running total
    (a materialized balance) so this does not re-scan all history on
    every read; that materialized number is periodically reconciled
    against this exact sum, which stays the source of truth.
    """
    total = 0
    for e in entries:
        if e["direction"] == "CR":
            total += e["amount_minor"]
        else:                       # 'DR'
            total -= e["amount_minor"]
    return total


def transfer_is_balanced(entries):
    """The double-entry invariant, PER CURRENCY: within one logical
    transfer, total debits must equal total credits in each currency
    that appears. A cross-currency transfer has TWO currencies whose
    debit/credit sub-totals must each net to zero (see the FX use case).

    Reports rather than raises, so the caller decides how to react
    (refuse the write, alert an operator, freeze the account).
    Returns (is_balanced, per_currency) where per_currency maps a
    currency to (debits, credits).
    """
    per_currency = {}
    for e in entries:
        dr, cr = per_currency.get(e["currency"], (0, 0))
        if e["direction"] == "DR":
            dr += e["amount_minor"]
        else:
            cr += e["amount_minor"]
        per_currency[e["currency"]] = (dr, cr)
    is_balanced = all(dr == cr for dr, cr in per_currency.values())
    return is_balanced, per_currency
```

**Data structures:** `accounts` (one row per user-currency pair, plus internal platform accounts) and the append-only `ledger_entries`. A user's spendable position is derived by `account_balance_minor`; the running total is materialized for hot reads but the ledger remains the source of truth.

**Trade-offs:**
* **The gotcha:** the tempting shortcut is a single `balance` column per user that operations increment and decrement in place. That throws away the one property that makes a custodial platform auditable — that every unit of a user's balance traces to a specific, immutable, balanced entry — and it makes a lost or duplicated update silently corrupt a real person's money with no trail. The fix is that balances are *only ever derived* from an append-only ledger, the write path *only ever appends balanced entries*, and `transfer_is_balanced` is a load-bearing check, not decoration. A materialized running balance is an optimization layered on top, reconciled against the ledger, never the authority.
* Storing amounts as **integer minor units** rather than a decimal-of-rupees or dollars is not a stylistic choice: floating point will eventually turn `0.01` into a value that does not net to zero, and even fixed-point decimals invite unit confusion. Integers plus an explicit `currency` on every entry make cross-currency balance impossible to fake.
* Per-currency sub-ledgers (one account per user-currency) mean a user's "balance" is really several balances; the invariant is checked *within* each currency, and the only place two currencies legitimately meet in one transfer is an FX conversion, which posts a balanced pair in *each* currency.

### Use case: An idempotent transfer between two wallet accounts

A send is the platform's core internal operation: move value from one user's wallet to another's, entirely on the platform's own books. "Exactly once" is not free — a client that times out waiting for a response cannot tell whether the send committed, so it retries, and without a guard that retry is a second debit. The fix is [Idempotency](/docs/patterns/reliability/idempotency): the client generates one idempotency key per logical send and reuses it across every retry, and the platform makes the *first* thing it does an atomic claim on that key, the same discipline [Stripe's idempotent requests](https://docs.stripe.com/api/idempotent_requests) use in production.

**Core spec: atomic claim, then a single-transaction balanced posting**

```python
def transfer_between_wallets(store, key, from_acct, to_acct, amount_minor, currency):
    """Move `amount_minor` from one wallet to another, exactly once.

    Step 1 claims the idempotency key atomically: two concurrent
    retries race on the key's primary key and exactly one wins; the
    loser replays the stored outcome and never posts a second time.
    Step 2 does the whole balanced posting inside ONE database
    transaction, so either both entries commit or neither does.
    """
    # 1. Exactly-once guard.
    claim = store.claim_key(key)                 # INSERT ... ON CONFLICT DO NOTHING
    if claim.already_terminal:
        return claim.stored_response             # replay a finished result -- no second posting
    if not claim.won:
        # Lost the claim race but the winner is still in_progress: do NOT
        # post again. Return in-progress; the caller polls, and an
        # in_progress key older than a bounded window is handed to
        # reconciliation to drive to its true terminal state.
        return store.in_progress_response(key)

    # 2. Check spendable (available, not total) balance under the row lock.
    with store.transaction() as txn:
        available = txn.available_balance_minor(from_acct, currency)
        if available < amount_minor:
            return store.finalize(key, status="DECLINED_INSUFFICIENT_FUNDS")

        transfer_id = txn.next_transfer_id()
        entries = [
            {"transfer_id": transfer_id, "account_id": from_acct,
             "direction": "DR", "amount_minor": amount_minor, "currency": currency},
            {"transfer_id": transfer_id, "account_id": to_acct,
             "direction": "CR", "amount_minor": amount_minor, "currency": currency},
        ]
        balanced, _ = transfer_is_balanced(entries)
        if not balanced:
            raise ValueError("refusing to post an unbalanced transfer")
        txn.append_entries(entries)              # both rows in one commit
        # committing the txn is what makes the money move

    return store.finalize(key, status="POSTED", transfer_id=transfer_id)
```

**Data structures:** `idempotency_keys` — `key` (PK), `transfer_id`, `status` (`in_progress`/`posted`/`declined_*`), `response_snapshot` (the exact body to replay), `created_at`. Separate from `ledger_entries`: its only job is win-or-replay on the key under concurrency, so it is optimized for a strongly-consistent conditional insert.

**Trade-offs:**
* **The gotcha:** if the key claim and the ledger posting are two separate, non-atomic steps, a crash *between* them leaves a claimed-but-empty key — a retry reads `in_progress` and could wait forever, or worse, a naive recovery re-posts. The fix is that the balanced posting happens in a *single* database transaction, and the idempotency key is finalized to a terminal status as part of driving that transaction to completion; an `in_progress` key older than a bounded window is handed to reconciliation, which checks whether the `transfer_id`'s entries actually committed and drives the key to the true terminal state rather than guessing.
* A send checks **available** balance (total minus active holds), not total — this is why holds are first-class: a user with a $100 total balance and a $30 hold can only send $70, and the check must read the hold-adjusted figure under the same lock as the posting.
* This is distinct from double-entry: idempotency guarantees the *operation* happens once; double-entry guarantees that *whenever* it happens, the books balance. A custodial wallet needs both — a send posted exactly once, and posted as a balanced pair every time.

**REST API:**

```
$ curl -X POST https://wallet.example/api/v1/transfers \
    -H "Idempotency-Key: 8f3a1c90-send-order-44210" \
    -H "Authorization: Bearer <token>" \
    -d '{"from_account": "acct_usr_882_USD",
         "to_account":   "acct_usr_101_USD",
         "amount_minor": 4999,
         "currency":     "USD"}'
```

Response:

```json
{
  "transfer_id": "txf_77213",
  "status": "POSTED",
  "amount_minor": 4999,
  "currency": "USD",
  "entries": [
    {"account_id": "acct_usr_882_USD", "direction": "DR", "amount_minor": 4999},
    {"account_id": "acct_usr_101_USD", "direction": "CR", "amount_minor": 4999}
  ],
  "created_at": "2026-08-12T14:02:31Z"
}
```

### Use case: A cross-currency conversion posts as balanced integer minor units

When a payment crosses currencies — a user with a EUR balance pays a merchant in USD — the platform converts, and the rate it applies is not the raw market mid-rate: it is the mid-rate adjusted by a **spread** the platform keeps as its margin, exactly as PayPal and other wallets do. The correctness challenge is that a conversion touches *two* currencies at once, so the double-entry invariant must hold *within each currency separately*, and every amount is an integer in that currency's minor units — with the mid-rate, the spread, and the resulting amounts all snapshotted onto the transfer so the posting is exactly reproducible.

**Core spec: FX conversion in integer minor units, balanced per currency**

```python
from decimal import Decimal, ROUND_HALF_UP

def convert_minor(amount_minor_src, mid_rate, spread_bps):
    """Convert an integer minor-unit amount from one currency to
    another at (mid_rate applied to the customer WORSE by spread_bps).

    mid_rate is dst-per-src as a Decimal (e.g. 1.0850 USD per EUR).
    spread_bps is the platform's markup in basis points (100 bps = 1%);
    charging the customer a worse rate means giving them FEWER dst
    units, so we divide the mid-rate by (1 + spread).

    Decimal math for the rate, but the RESULT is rounded to an integer
    minor unit -- money never leaves the integer domain when stored.
    Returns (amount_minor_dst, customer_rate, fx_margin_minor_dst).
    """
    spread = Decimal(spread_bps) / Decimal(10000)          # 25 bps -> 0.0025
    customer_rate = (mid_rate / (Decimal(1) + spread))     # worse for the customer

    src = Decimal(amount_minor_src)
    dst_at_mid = (src * mid_rate).to_integral_value(rounding=ROUND_HALF_UP)
    dst_at_cust = (src * customer_rate).to_integral_value(rounding=ROUND_HALF_UP)

    amount_minor_dst = int(dst_at_cust)
    fx_margin_minor_dst = int(dst_at_mid) - amount_minor_dst   # what the platform keeps
    return amount_minor_dst, customer_rate, fx_margin_minor_dst


def build_fx_transfer(transfer_id, user_src_acct, user_dst_acct,
                      fx_position_src, fx_position_dst, fee_dst_acct,
                      amount_minor_src, src_ccy, dst_ccy, mid_rate, spread_bps):
    """A conversion is TWO balanced sub-postings, one per currency:
      - src leg: debit the user's src wallet, credit the platform's
        src-side FX position (the platform now holds the src currency)
      - dst leg: credit the user's dst wallet with the customer amount,
        credit the platform's fee account with the FX margin, and debit
        the platform's dst-side FX position for the mid-value total.
    Each currency's debits equal its credits, so transfer_is_balanced
    holds within BOTH currencies.
    """
    dst_amount, _rate, margin = convert_minor(amount_minor_src, mid_rate, spread_bps)
    dst_at_mid = dst_amount + margin
    entries = [
        # --- source currency leg ---
        {"transfer_id": transfer_id, "account_id": user_src_acct,
         "direction": "DR", "amount_minor": amount_minor_src, "currency": src_ccy},
        {"transfer_id": transfer_id, "account_id": fx_position_src,
         "direction": "CR", "amount_minor": amount_minor_src, "currency": src_ccy},
        # --- destination currency leg ---
        {"transfer_id": transfer_id, "account_id": fx_position_dst,
         "direction": "DR", "amount_minor": dst_at_mid, "currency": dst_ccy},
        {"transfer_id": transfer_id, "account_id": user_dst_acct,
         "direction": "CR", "amount_minor": dst_amount, "currency": dst_ccy},
        {"transfer_id": transfer_id, "account_id": fee_dst_acct,
         "direction": "CR", "amount_minor": margin, "currency": dst_ccy},
    ]
    return entries
```

**Data structures:** the same `ledger_entries`, plus an `fx_quotes` snapshot per conversion — `transfer_id`, `src_currency`, `dst_currency`, `mid_rate`, `spread_bps`, `customer_rate`, `amount_minor_src`, `amount_minor_dst`, `margin_minor`, `quoted_at`. Snapshotting the exact inputs makes the posting reproducible and the margin auditable.

**Trade-offs:**
* **The gotcha:** doing FX in floating point, or converting to a "major unit" decimal for the arithmetic and back, invites two failures at once — a rounding error that leaves the transfer not netting to zero, and a currency mix-up (adding a JPY amount, where the minor unit equals the major unit, to a USD amount as if both were cents). The fix is that the *rate* is `Decimal` and the *stored amounts* are always integer minor units of an explicit currency, the conversion result is rounded to an integer exactly once, and the difference between the mid-value and the customer value is posted explicitly as the platform's FX margin so nothing is silently absorbed.
* The rate the customer gets is deliberately *worse* than the mid-rate — that is the spread, and modeling it as an explicit `fee`/margin credit (rather than just quoting a marked-up number) keeps the books honest: the platform can reconcile exactly how much FX revenue it earned, and a customer statement can, in principle, show the mid-rate and the spread separately.
* Both currencies balance independently. This is why `transfer_is_balanced` groups by currency: a cross-currency transfer is correct only if the source currency's debits equal its credits *and* the destination currency's debits equal its credits.

### Use case: Risk places a hold, then releases or reverses it

Not all funds are immediately spendable. Risk and fraud controls, and compliance timers, routinely make money **land but not be available**: a large or unusual top-up may be held for a review window, a payment to a new counterparty may be held pending screening, a disputed receipt may be held until the dispute resolves. The platform therefore distinguishes a user's **total** balance from their **available** balance, and a hold is a first-class, auditable object with its own lifecycle — it either releases (funds become spendable) or reverses (funds go back where they came from), never silently vanishes.

**Core spec: hold/release/reverse state machine**

```
                         create hold
   (funds posted) ──────────────────────▶ ┌──────────┐
                                           │  HELD    │  available = total - held
                                           └────┬─────┘
                             review clears       │
                        ┌──────────────────────┐ │ ┌──────────────────────┐
                        │ risk / compliance OK │ │ │ risk / compliance BAD│
                        ▼                        ▼ ▼                        ▼
                  ┌──────────┐             ┌──────────────┐          ┌──────────┐
                  │ RELEASED │             │  (terminal)  │          │ REVERSED │
                  │ funds now│             │  no auto-    │          │ funds go │
                  │ spendable│             │  transition  │          │ back to  │
                  └──────────┘             │  out of HELD │          │ source   │
                                           │  without a   │          └──────────┘
                                           │  decision    │
                                           └──────────────┘

Rules:
  * HELD is never left forever: an expiry timer routes a stale hold
    to a mandatory review, which drives it to RELEASED or REVERSED.
  * RELEASED and REVERSED are terminal; a released hold cannot be
    re-held (a NEW hold is created instead), and a reversed hold
    posts a balanced reversing pair to the ledger.
```

```python
def available_balance_minor(store, account_id, currency):
    """Spendable balance = derived total balance minus the sum of all
    ACTIVE holds on that account. Holds in a terminal state (RELEASED
    or REVERSED) no longer subtract: a release simply stops reducing
    availability, while a reversal has already posted its own ledger
    entries that lowered the total.
    """
    total = account_balance_minor(store.entries_for(account_id, currency))
    held = sum(h["amount_minor"] for h in store.holds_for(account_id, currency)
               if h["status"] == "HELD")
    return total - held


def resolve_hold(store, hold_id, decision, now):
    """Drive a HELD hold to a terminal state. RELEASE just marks it
    released (availability rises, no ledger entry needed -- the funds
    were always in the total). REVERSE posts a balanced reversing pair
    that removes the funds from the user and returns them to the source
    account, then marks the hold reversed.
    """
    hold = store.get_hold(hold_id)
    if hold["status"] != "HELD":
        return hold                                  # idempotent: already terminal

    if decision == "RELEASE":
        return store.set_hold_status(hold_id, "RELEASED", at=now)

    if decision == "REVERSE":
        transfer_id = store.next_transfer_id()
        entries = [
            {"transfer_id": transfer_id, "account_id": hold["account_id"],
             "direction": "DR", "amount_minor": hold["amount_minor"],
             "currency": hold["currency"]},
            {"transfer_id": transfer_id, "account_id": hold["source_account_id"],
             "direction": "CR", "amount_minor": hold["amount_minor"],
             "currency": hold["currency"]},
        ]
        balanced, _ = transfer_is_balanced(entries)
        if not balanced:
            raise ValueError("refusing to post an unbalanced reversal")
        store.append_entries(entries)
        return store.set_hold_status(hold_id, "REVERSED", at=now)

    raise ValueError(f"unknown hold decision: {decision}")
```

**Data structures:** a `holds` table — `hold_id` (PK), `account_id`, `source_account_id`, `amount_minor`, `currency`, `reason` (`fraud_review`/`compliance`/`dispute`/`new_counterparty`), `status` (`HELD`/`RELEASED`/`REVERSED`), `expires_at`, `created_at`, `resolved_at`. Availability is computed by subtracting active holds from the derived total.

**Trade-offs:**
* **The gotcha:** the naive model bakes a hold straight into the balance by debiting the user immediately, so a "release" then has to re-credit them — and if the release message is lost or replayed, the user is over- or under-credited. The fix is that a plain hold moves *no* money: the funds stay in the user's total, availability is *computed* as total minus active holds, and only a **reversal** touches the ledger (as a balanced reversing pair). This keeps release cheap and idempotent (it just flips a status) and makes reversal auditable like every other posting.
* A hold must never be permanently stuck: an `expires_at` timer routes any stale `HELD` into a mandatory review that forces a `RELEASE` or `REVERSE` decision, so a user's money is never indefinitely frozen by a lost decision message.
* Why funds get held at all is worth stating plainly for a practitioner: holds are the mechanism behind "your payment is being reviewed" and new-seller reserves — they trade a little user friction for the platform's ability to claw back or block funds before they leave, which is central to how a custodial platform manages fraud and dispute liability.

### Use case: KYC and AML gate whether money can move

Because the platform holds and moves customer money across borders, it is a regulated financial institution, and two compliance checks sit on the money-movement path. **KYC** (know your customer) establishes and verifies who a user is at onboarding and at higher transaction tiers; **AML** (anti-money-laundering) screening evaluates a specific transfer against sanctions lists and suspicious-pattern rules before it is allowed to complete. These are not fraud scores (which estimate whether *this* payment is a scam); they are regulatory gates on *eligibility*, and they can block a transfer that is otherwise perfectly funded and non-fraudulent.

**Core spec: compliance gate ahead of any posting**

```python
def compliance_gate(user, counterparty, amount_minor, currency, kyc, screen):
    """Decide whether a movement is ALLOWED before any ledger posting.

    Two independent checks:
      1. KYC tier: the user's verified level must meet the tier this
         operation requires (larger amounts / payouts need higher tiers).
      2. AML/sanctions screening: the user, the counterparty, and the
         transfer are screened; a sanctions hit BLOCKS, a suspicious
         pattern routes to manual review (a compliance hold), and a
         clean result ALLOWS.
    Returns one of: ('ALLOW',), ('HOLD', reason), ('BLOCK', reason).
    """
    required_tier = kyc.required_tier(amount_minor, currency, is_payout=counterparty.is_external)
    if user.kyc_tier < required_tier:
        return ("BLOCK", f"kyc_tier_{user.kyc_tier}_below_required_{required_tier}")

    result = screen.evaluate(user, counterparty, amount_minor, currency)
    if result.sanctions_hit:
        return ("BLOCK", "sanctions_match")
    if result.needs_review:
        return ("HOLD", "aml_manual_review")
    return ("ALLOW",)
```

**Data structures:** a `kyc_profiles` record per user — `user_id`, `kyc_tier`, `verified_at`, `document_refs`, `residence_country`; and an `aml_screens` audit record per gated operation — `transfer_id`, `screened_at`, `result` (`clear`/`review`/`hit`), `matched_rule`, retained for regulatory audit. A `BLOCK` prevents any posting; a `HOLD` posts the funds but creates a compliance-reason hold (previous use case) so the money is landed-but-frozen pending review.

**Trade-offs:**
* **The gotcha:** treating compliance as an afterthought bolted on *after* the money posts means a sanctioned or under-verified transfer can complete before the check catches it, which is a regulatory violation, not a bug ticket. The fix is that the gate runs *before* the ledger posting, and its three outcomes map cleanly onto the money-movement machinery already built: `ALLOW` proceeds, `BLOCK` declines with an auditable reason, and `HOLD` reuses the hold state machine so the funds are frozen and reviewable rather than either fully moved or silently dropped.
* Compliance is distinct from fraud scoring and both run: fraud scoring protects the platform and users from theft (and may itself request a hold); compliance protects the platform's license to operate. A transfer must clear *both* — a fraud-clean transfer to a sanctioned party is still blocked, and a compliance-clear transfer that looks like account takeover is still held.

## Step 4: Scale the design

![Scaled wallet: clients reach an API edge with a load balancer, auth, rate limiting, and a strongly-consistent idempotency store; a ledger sharded by account_id where same-shard transfers are single-shard transactions and cross-shard transfers use a saga; read replicas serve balance and history reads; an FX rate engine applies mid-rate plus spread in minor units; funding and payout adapters wrap each rail with a circuit breaker and retry-with-backoff; a risk and compliance service handles fraud scoring, holds, KYC/AML, and sanctions; and a reconciliation job checks debits equal credits per currency and matches the ledger against rail statements](/img/case-studies/fintech/global-payment-processing-scaled.svg)

* **The ledger shards by `account_id`, so no single database is on the path of all money movement** — see [Sharding](/docs/patterns/storage/sharding). Both entries of a same-shard transfer commit in one local transaction, which is the common case for peer sends within a region. A transfer whose two accounts live on different shards cannot use one local transaction, and holding a distributed lock across shards for the duration is exactly what [Two-Phase Commit](/docs/patterns/consistency/two-phase-commit) handles poorly — so cross-shard transfers are coordinated as a [Saga](/docs/patterns/consistency/saga): a debit on the source shard and a credit on the destination shard as separate local commits, with a compensating reversal if the second leg fails, so a failed cross-shard transfer never leaves the payer debited and the payee uncredited.
* **The idempotency store needs strong consistency, not just availability, because its whole job is to stop two concurrent retries from both posting.** A conditional insert that could return "not found" to two simultaneous requests for the same key would reintroduce the double-spend, so this component spends consistency budget on an atomic conditional insert on the key rather than an eventually-consistent cache. The comparatively modest peak volume from Step 1 makes this affordable.
* **Balance and history reads are served from replicas** — see [Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication). Reads vastly outnumber money movements, and a maintained materialized balance turns a read into a single lookup; a read immediately after a just-committed transfer either reads the primary or tolerates brief replication lag, but the ledger on the primary stays the authority.
* **Each funding and payout rail gets a [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) and [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff), per rail.** A card processor, an ACH provider, and a card-push rail fail independently; a breaker that trips on a struggling rail fails its operations fast instead of holding threads, and retries against a rail must always carry the same idempotency key so a retry can never become a second real-world money movement. Bounding one rail's failures away from the rest is the [Bulkhead](/docs/patterns/reliability/bulkhead) idea applied to rail adapters.
* **External settlement runs off the hot path.** The wallet balance updates the instant the ledger entry commits, but the actual funds behind a card top-up or a bank payout settle on the rail's own clock. A settlement/reconciliation job continuously matches the ledger against each rail's statements, so the platform always knows how much in-flight, not-yet-settled money it is carrying — decoupling the instant user-visible balance from the slower real-world money movement.

## Additional talking points

* **Why holding a balance changes everything versus a pure processor.** The generic payment-processor case study orchestrates a single charge and never owns funds; this platform is a standing custodian of stored value. That single difference is why double-entry, per-currency sub-ledgers, holds, and reconciliation-against-rails are all first-class here and largely absent there — a processor's books are transient, a wallet's books *are* the product and must be provably correct at rest.
* **Balances are derived, never set.** The most common way a wallet corrupts money is a mutable `balance` column that some code path updates directly. Making the balance a *derived* sum of an append-only, balanced ledger — with a materialized total as a reconciled optimization, not the authority — is what lets a reconciliation job catch drift instead of trusting a number.
* **Money is integers, always.** Every amount is integer minor units of an explicit currency; the only place `Decimal` appears is an FX *rate*, and even then the *result* is rounded to an integer exactly once. This eliminates an entire class of rounding and currency-mixing bugs, and it is why ISO 4217 codes and per-currency accounting appear everywhere in the schema.
* **Reconciliation is a standing process, not a failure afterthought.** The platform continuously runs two checks: the internal invariant (`transfer_is_balanced` across the ledger, per currency, must net to zero) and the external one (the ledger's rail-clearing accounts must match each card/ACH provider's own settlement statements). A break in either — a payout the ledger thinks completed that the bank never settled, or an unbalanced set of entries from a bug — triggers an alert and can freeze the affected accounts. This is defense-in-depth on top of request-time idempotency and the balanced-write invariant.
* **Why sagas, not two-phase commit, for cross-shard and cross-rail movement.** Exactly-once sounds like a strict-atomicity problem, but a blocking coordinator assumes fast, tightly-coupled participants — not independently-sharded ledgers or external rails that can take seconds. Idempotency within each leg plus a saga around the multi-leg movement gets the correctness without a distributed lock the rails were never built to join.
* **Fraud, KYC, and AML are three different jobs.** Fraud scoring estimates whether a specific movement is theft; KYC verifies identity to a tier; AML screens against sanctions and suspicious patterns. All three can independently stop or hold a transfer, they run before money posts, and they map onto the same hold/decline machinery — but conflating them (for instance, treating a sanctions block as a fraud decline) loses the audit trail regulators require.

## Source(s) and further reading

* [Double-entry bookkeeping — Wikipedia](https://en.wikipedia.org/wiki/Double-entry_bookkeeping) — the accounting principle the wallet ledger is built on, including the balanced-invariant the reconciliation check implements
* [ISO 4217 — Wikipedia](https://en.wikipedia.org/wiki/ISO_4217) — the currency-code and minor-unit standard behind storing money as integer minor units per currency, including zero-decimal currencies
* [PayPal REST API currency codes — PayPal Developer](https://developer.paypal.com/api/rest/reference/currency-codes/) — PayPal's own list of supported currencies and which are decimal versus whole-unit, matching the minor-unit handling in the FX use case
* [Zero-decimal and supported currencies — Stripe docs](https://docs.stripe.com/currencies) — a production reference for representing amounts in the smallest currency unit and the zero-decimal special cases the schema must handle
* [Idempotent requests — Stripe API docs](https://docs.stripe.com/api/idempotent_requests) — the real idempotency-key protocol matching the exactly-once guard on wallet transfers
* [Accounting for Developers — Modern Treasury](https://www.moderntreasury.com/journal/accounting-for-developers-part-i) — an engineering-oriented walkthrough of double-entry ledgers, debits/credits, and derived balances as implemented in real money systems
* [Bid–ask spread — Wikipedia](https://en.wikipedia.org/wiki/Bid%E2%80%93ask_spread) — the market mechanism behind charging a customer a rate worse than the mid-rate, i.e. the FX spread the conversion use case keeps as margin
* [Know your customer — Wikipedia](https://en.wikipedia.org/wiki/Know_your_customer) — the identity-verification regime behind the KYC tiers gating money movement
* [Money laundering — Wikipedia](https://en.wikipedia.org/wiki/Money_laundering) — background on the AML screening the compliance gate performs before a transfer completes
* [Idempotency](/docs/patterns/reliability/idempotency) — the exactly-once guard applied to every wallet transfer
* [Saga](/docs/patterns/consistency/saga) — the coordination for cross-shard and cross-rail money movement with compensating reversals
* [Sharding](/docs/patterns/storage/sharding) — how the ledger partitions by account to scale past a single database
* [Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication) — how balance and history reads scale off replicas while the ledger primary stays authoritative
