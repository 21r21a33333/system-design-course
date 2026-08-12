---
title: "Design Cross-Border Payments & FX"
sidebar_position: 14
---

A cross-border payment's defining property is that it is really two problems welded together: moving value between two independently-operated banking systems that do not share a ledger, and converting between two currencies whose price against each other is constantly moving. The traditional way to do both at once — hand a message down a chain of correspondent banks, each of which touches the money, takes a cut, and applies its own exchange rate — is slow, opaque, and expensive precisely because every hop is a separate institution reconciling its own books on its own schedule. The entire design below is organized around one insight that modern providers exploit: if you already hold money in both countries, you never actually have to send money across the border at all. You accept a local payment on one side, make a local payout on the other, and settle the currency difference internally as a position on your own FX book — turning a multi-bank international wire into two domestic transfers plus one bookkeeping entry.

This case study designs a system with the shape of what providers like Wise and Airwallex operate, grounding each component in how correspondent banking, FX pricing, and settlement risk actually work.

## Step 1: Outline use cases and constraints

### Use cases

#### We'll scope the problem to handle the following use cases

* A **payer** in one country (paying in their local currency, say GBP) wants a **beneficiary** in another country to receive funds in *their* local currency (say USD), and the system quotes an exchange rate and a fee before the payer commits
* The system exposes an explicit **FX quote** — a mid-market rate plus a stated spread — so the fee is a visible, auditable margin, not a number hidden inside a deliberately bad rate
* The system executes the transfer over **local rails on both ends**: it accepts the payer's money via a domestic transfer in the source country and pays the beneficiary via a domestic transfer in the destination country, from **pre-funded local accounts** it already holds in each country
* The system records the currency conversion as a movement on an internal **FX position book**, so that across the whole system what was taken in one currency equals what was paid out in another *at the mid-rate*, with the spread booked separately as margin
* The system supports the **traditional correspondent-banking path** as the fallback for corridors where it has no local presence, and models its cost and delay honestly
* The system guarantees each logical transfer moves money **exactly once** and reaches a durable terminal state that both ends can query
* The system **reconciles** its internal ledger against the real bank statements of its local accounts, and manages **settlement risk** on the FX leg (the two currency legs do not settle at the same instant)

#### Out of scope

* The internal core-banking systems of the underlying local banks (how a bank posts a domestic transfer) — treated as an external rail the system integrates with
* Card acquiring and the card-network authorization flow (covered in this course's credit-card and payment-gateway case studies) — this design assumes funds arrive by bank transfer or a local payment method, then focuses on the cross-currency movement
* Fraud scoring and KYC onboarding as full subsystems — named in the talking points, not designed here
* The trading desk that actually sources liquidity and hedges the provider's net currency exposure — a real system, mentioned but not designed
* Stablecoin and blockchain settlement rails beyond an honest mention as an alternative to correspondent banking

### Constraints and assumptions

#### State assumptions

* The provider operates in **tens of currency corridors**; for the busy ones it holds a **pre-funded local account** in each country, and for the long-tail ones it falls back to correspondent banking
* Every transfer must convert at a rate the payer saw and agreed to — a **rate lock** for a bounded window — so the payer is never surprised by a worse rate at execution than at quote time
* Money and rates are represented in **integer minor units** (pence, cents) and integer rate fractions, never floating point, so no rounding step can silently create or destroy value or hide a fee
* A transfer must never be **double-paid** (the payer's local collection or the beneficiary's local payout applied twice) even under client retries or internal redelivery
* A transfer must never be **silently lost**: every accepted transfer reaches a terminal state (paid out, refunded, or held for review) that is durably recorded and queryable
* The two currency legs of the FX conversion do **not** settle at the same moment; the design must treat this timing gap as **settlement risk** and mitigate it, rather than assume simultaneity
* End-to-end user-visible time targets **same-day** for local-rail corridors, versus **multiple days** for the correspondent-banking fallback — the difference is the whole point of the local-rails model

#### Calculate usage

* Transfer volume: assume **2 million cross-border transfers/day** → 2,000,000 / 86,400 ≈ **~23 transfers/sec average**. Cross-border retail flow is peaked around business hours across overlapping time zones and around payroll dates; design for roughly **8x average at peak**, so on the order of **~185 transfers/sec**. Like the payment-processor case study, this is correctness-bound and FX-risk-bound, not raw-throughput-bound.
* Quote volume massively exceeds transfer volume, because users and integrations poll rates without committing: assume **~30 quotes issued per executed transfer** → ~60,000,000 quotes/day → ~700 quotes/sec average, ~5,600/sec at peak. Quotes are cheap, read-mostly, and short-lived (a rate lock of, say, 30–60 seconds), so they are cache-friendly in a way the money-movement path is not.
* Transfer record size: a record (`transfer_id`, `idempotency_key`, source and destination currency, `source_minor` and `dest_minor` amounts, `mid_rate_ppm`, `spread_bps`, `quote_id`, `status`, the two local-rail references, timestamps, plus small metadata) ≈ **~450 bytes/record** → 2,000,000/day × 450 bytes ≈ **~0.9 GB/day**, **~330 GB/year** — storage is never the bottleneck; the pressure is on FX-book correctness and reconciliation, not write capacity.
* FX book postings: each executed transfer writes a small, fixed set of ledger entries (collect leg, payout leg, and the FX position pair), so postings scale linearly with transfers — on the order of **~8–10 million ledger rows/day**, well within a single sharded ledger's capacity.
* Local-account float: because payouts come from pre-funded pools, each active corridor must hold enough working balance to cover a payout wave before the collect side replenishes it — a treasury constraint (how much capital is parked in each currency) rather than a compute one, and the reason rebalancing is a first-class background job.
* Reconciliation load: the system pulls the **bank statement** of each local account (hourly or intraday) and matches every line against its internal ledger — on the order of the daily transfer count in statement lines to match, run as a batch, not on the hot path.

## Step 2: Create a high-level design

![Two ways to move money across a currency border: the traditional SWIFT and correspondent-banking chain where each hop takes a fee and FX spread, versus the modern local-rails model where the provider collects locally on one side, pays out locally on the other from pre-funded in-country accounts, and settles the currency difference as an internal FX book entry so money never actually crosses the border](/img/case-studies/fintech/cross-border-payments-fx-overview.svg)

Start with the traditional path, because the modern model is defined by what it removes from it. When a UK bank sends money to a US beneficiary, the two banks usually have no direct relationship, so the payment instruction travels as a **SWIFT message** (the interbank messaging network — historically the `MT103` customer-credit-transfer format, now migrating to the richer **ISO 20022** `pacs.008` standard) down a chain of **correspondent banks**. Each correspondent maintains **nostro and vostro accounts** with the next (a nostro is "our money held at your bank"; a vostro is "your money held at our bank"), and the payment is settled hop by hop by adjusting those account balances. Somewhere along that chain the currency conversion happens, at whatever rate the converting bank chooses. Every hop is a distinct institution that charges a fee and may shave the FX rate, and each reconciles on its own timetable, which is why a correspondent-chain payment can take several days and why the total cost is hard to see in advance: much of it is buried in the exchange rate rather than shown as a line-item fee.

The modern model keeps the two endpoints and deletes the chain in between. The provider **pre-funds a local account in each country** it operates in — a GBP account inside the UK's domestic payment system, a USD account inside the US's. A UK payer's money is collected by an ordinary **domestic transfer** into the provider's UK account; the US beneficiary is paid by an ordinary **domestic transfer** out of the provider's US account. No money crosses the border on that transfer at all. What crosses is *information*: the provider decrements its internal record of the payer's GBP and increments the beneficiary's USD, converting between them on its own **FX book**. The two currency pools drift as a result — the UK pool grows, the US pool shrinks — and the provider periodically **rebalances** them (its treasury moves or buys currency in bulk, amortized across many transfers, at wholesale rates). The payer sees a same-day transfer at a near-mid-market rate; the border-crossing complexity has been replaced by two local transfers plus internal bookkeeping.

The structural bet, more explicit here than in the domestic payment case studies, is that **holding inventory in both currencies lets you decouple the customer-visible transfer from the actual cross-currency settlement**. The fast leg (two local transfers, one book entry) is what the user experiences; the slow, wholesale leg (rebalancing the pools, hedging the net position) runs independently as treasury and is where the provider's real FX cost lives. The design below makes the fast leg correct and exactly-once, prices the FX honestly with a visible spread, and keeps the internal FX book reconcilable against real bank statements.

## Step 3: Design core components

### Use case: Quote an FX conversion with an explicit mid-rate and spread

The single most important artifact in this whole system is the **quote**, because it is where the fee lives. A provider makes money on FX by taking the **mid-market rate** (the midpoint between the wholesale buy and sell prices, the "real" rate you would see on a market data feed) and moving it slightly against the customer — that difference is the **spread**, and it is the true fee whether or not it is also shown as an explicit charge. An honest design surfaces both numbers so the margin is a visible, auditable quantity rather than a rounding trick; the arithmetic below is done entirely in **integer minor units and integer rate fractions**, so the spread is a deliberate, inspectable amount and not an artifact of floating-point drift.

**Core spec: quote arithmetic in integer minor units**

```python
from dataclasses import dataclass

# Rates are expressed in parts-per-million (ppm) of destination minor
# units per one source minor unit, as an INTEGER, so no float ever
# touches money. A GBP->USD mid-rate of 1.270000 is 1_270_000 ppm:
# 1 pence buys 1.27 cents at mid.
RATE_SCALE = 1_000_000  # ppm

@dataclass(frozen=True)
class Quote:
    quote_id: str
    src_ccy: str
    dst_ccy: str
    mid_rate_ppm: int      # integer ppm, the honest market midpoint
    spread_bps: int        # provider margin in basis points (1 bps = 0.01%)
    src_minor: int         # amount the payer sends, in source minor units
    dst_minor: int         # amount the beneficiary receives, in dest minor units
    fee_minor: int         # the spread expressed back in source minor units
    expires_at: str        # rate-lock window; execution past this re-quotes

def apply_spread(mid_rate_ppm: int, spread_bps: int) -> int:
    """Move the mid-rate AGAINST the customer by the spread. For a payer
    converting src->dst, a worse rate means fewer dst units per src unit,
    so we shave the rate down. Pure integer math: multiply then divide,
    with the division last to keep precision. 10_000 bps = 100%.
    """
    # customer_rate = mid_rate * (1 - spread_bps / 10_000)
    return (mid_rate_ppm * (10_000 - spread_bps)) // 10_000

def build_quote(quote_id, src_ccy, dst_ccy, mid_rate_ppm, spread_bps,
                src_minor, expires_at) -> Quote:
    """Given how much the payer wants to send, compute what the
    beneficiary receives at the customer rate, and report the spread
    back as an explicit fee in source minor units so it is visible.
    """
    customer_rate = apply_spread(mid_rate_ppm, spread_bps)

    # Beneficiary receives src_minor converted at the CUSTOMER rate.
    dst_minor = (src_minor * customer_rate) // RATE_SCALE

    # What the beneficiary WOULD have received at the honest mid-rate:
    dst_at_mid = (src_minor * mid_rate_ppm) // RATE_SCALE

    # The provider's margin, measured in destination units, then
    # converted back to source units at mid so the payer sees the fee
    # in the currency they actually paid.
    margin_dst = dst_at_mid - dst_minor
    fee_minor = (margin_dst * RATE_SCALE) // mid_rate_ppm

    return Quote(quote_id, src_ccy, dst_ccy, mid_rate_ppm, spread_bps,
                 src_minor, dst_minor, fee_minor, expires_at)

# Worked example: send GBP 1,000.00 = 100_000 pence, GBP->USD.
# Mid 1.270000 (1_270_000 ppm), spread 50 bps (0.50%).
q = build_quote("q_5f21", "GBP", "USD", 1_270_000, 50, 100_000,
                "2026-08-12T09:15:30Z")
# customer_rate = 1_270_000 * 9_950 // 10_000 = 1_263_650 ppm
# dst_minor  = 100_000 * 1_263_650 // 1_000_000 = 126_365 cents = USD 1,263.65
# dst_at_mid = 100_000 * 1_270_000 // 1_000_000 = 127_000 cents = USD 1,270.00
# margin_dst = 127_000 - 126_365 = 635 cents
# fee_minor  = 635 * 1_000_000 // 1_270_000 = 500 pence = GBP 5.00 (the 0.50% spread)
assert q.dst_minor == 126_365
assert q.fee_minor == 500
```

**Data structures:** a `quotes` row — `quote_id` (PK), `src_ccy`, `dst_ccy`, `mid_rate_ppm`, `spread_bps`, `src_minor`, `dst_minor`, `fee_minor`, `expires_at`, `status` (`locked`/`consumed`/`expired`). The mid-rate is snapshotted onto the quote at issue time so the rate the payer agreed to is the rate that executes, even if the live market moves before they commit.

**Trade-offs:**
* **The gotcha:** the tempting shortcut is to skip storing the mid-rate and only keep the single customer-facing rate — but then the spread is no longer a distinct, auditable quantity, and neither the customer nor the provider's own reconciliation can tell margin apart from market movement. Worse, doing the conversion in floating point lets fractions of a cent accumulate until the internal FX book stops netting to zero at the mid-rate. The fix is to store the **mid-rate and the spread as separate integers** and derive the customer rate from them, so the fee is always exactly the spread applied to the honest midpoint, checkable by the reconciliation job below.
* A **rate lock** (`expires_at`) is what makes a quote honest to the payer: they commit against the rate they saw. But holding a lock is the provider taking on market risk for that window — if the market gaps before execution, the provider eats the difference. That is why locks are short, and why a stale quote must re-price rather than execute at a rate the provider can no longer source.

**REST API:**

```
$ curl -X POST https://fx.example/api/v1/quotes \
    -H "Authorization: Bearer <token>" \
    -H "Idempotency-Key: quote-order-5f21" \
    -d '{"src_ccy": "GBP", "dst_ccy": "USD", "src_minor": 100000}'
```

Response:

```json
{
  "quote_id": "q_5f21",
  "src_ccy": "GBP",
  "dst_ccy": "USD",
  "mid_rate_ppm": 1270000,
  "spread_bps": 50,
  "src_minor": 100000,
  "dst_minor": 126365,
  "fee_minor": 500,
  "expires_at": "2026-08-12T09:15:30Z"
}
```

### Use case: The traditional correspondent-banking hop chain (the fallback)

For a corridor where the provider has no local presence, or as the baseline it is improving on, the money genuinely has to traverse a chain of correspondent banks. Modeling this path explicitly matters for two reasons: it is the honest fallback the system still needs, and its cost and delay structure is exactly what the local-rails model exists to avoid. Each hop is a bank that holds a **nostro/vostro** relationship with the next, adjusts those account balances to move the value one step along, and takes a fee (and possibly an FX cut) for doing so. (The nostro/vostro relay and the domestic rails the local legs settle on are designed in detail in the [How Banks Move Money case study](/docs/case-studies/fintech/how-banks-move-money).)

**Core spec: routing a SWIFT-style payment down the correspondent chain**

```python
from dataclasses import dataclass

@dataclass
class Hop:
    bank_bic: str          # the SWIFT BIC of this correspondent
    fee_minor: int         # flat fee this hop deducts, in the in-flight currency
    does_fx: bool          # whether this hop performs the currency conversion
    fx_spread_bps: int     # spread this hop applies if it does the FX (else 0)

def route_correspondent_chain(src_minor: int, mid_rate_ppm: int, hops):
    """Walk a SWIFT/MT103-style payment down a correspondent chain.

    The amount starts in the source currency. Each hop deducts a flat
    fee. Exactly one hop performs the FX conversion, at the mid-rate
    moved against the customer by that hop's own spread. The point of
    the function is to make the cumulative, mostly-hidden cost explicit:
    the beneficiary receives whatever survives all the hops.

    Returns (dst_minor_received, total_fee_src_equiv, converted_at_hop).
    """
    RATE_SCALE = 1_000_000
    amount = src_minor
    converted = False
    dst_minor = 0
    converted_at = None
    total_fee_src = 0

    for hop in hops:
        # Every hop deducts its flat fee from the in-flight amount.
        amount -= hop.fee_minor
        if amount <= 0:
            raise ValueError(f"payment consumed by fees at {hop.bank_bic}")

        if hop.does_fx and not converted:
            # Convert src->dst at this hop, spread moved against customer.
            hop_rate = (mid_rate_ppm * (10_000 - hop.fx_spread_bps)) // 10_000
            dst_minor = (amount * hop_rate) // RATE_SCALE
            amount = dst_minor           # now in destination currency
            converted = True
            converted_at = hop.bank_bic

    if not converted:
        raise ValueError("no hop in the chain performed the FX conversion")

    # Fees charged after conversion were in dst units; for a simple
    # headline number we report fees in source-equivalent at mid-rate.
    dst_at_mid = (src_minor * mid_rate_ppm) // RATE_SCALE
    total_fee_src = ((dst_at_mid - amount) * RATE_SCALE) // mid_rate_ppm
    return amount, total_fee_src, converted_at

# Three-hop chain, GBP->USD, same 1.270000 mid as the quote above.
hops = [
    Hop("SENDGB2L", fee_minor=1500, does_fx=False, fx_spread_bps=0),     # sender's bank: GBP 15.00
    Hop("CORRUS33", fee_minor=2000, does_fx=True,  fx_spread_bps=200),   # intermediary does FX at 2.00%
    Hop("BENEUS44", fee_minor=1000, does_fx=False, fx_spread_bps=0),     # beneficiary bank lifting fee: USD 10.00
]
recv, fee_src, at = route_correspondent_chain(100_000, 1_270_000, hops)
# GBP 1,000 (100_000p) - GBP 15 - GBP 20 = 96_500p in flight -> FX at 1.24460
# -> USD 1,201.03 (120_103c) - USD 10 = USD 1,191.03 (119_103c) received.
# Total cost GBP 62.18 vs GBP 5.00 on local rails -- most of it hidden in the FX spread.
assert at == "CORRUS33"
assert recv == 119_103
assert fee_src == 6_218
```

**Data structures:** a `correspondent_route` record per corridor — an ordered list of `Hop` rows (BIC, fee, FX role) plus the resolved SWIFT message type (`MT103` today, `pacs.008` under ISO 20022). The route is data, so a corridor can be re-priced or re-routed without code changes.

**Trade-offs:**
* **The gotcha:** with a flat-fee-plus-hidden-spread chain, no single number tells the payer the true cost. On this example the flat lifting fees add up to about GBP 43 and the intermediary's 2% FX spread adds roughly another GBP 19 — a total near GBP 62, versus GBP 5 for the same transfer at one honest 50 bps spread on local rails. The flat fees are at least visible; the FX spread is the part the payer only discovers by comparing what actually arrived against the mid-rate. Modeling the chain in integer minor units makes that *total* computable, which is exactly the transparency the local-rails model competes on: one stated spread versus a chain of stacked, partly-hidden cuts.
* ISO 20022 migration matters here beyond formatting: the richer structured data (clean party identifiers, purpose codes, remittance info) reduces the manual repair and compliance friction that made correspondent hops slow, which is one reason the industry is moving off `MT103`. It does not, by itself, remove the hops or the stacked fees — only holding local accounts does that.

### Use case: Execute a transfer as two local legs plus an internal FX position

This is the heart of the modern model. An executed transfer is **collect locally, convert on the book, pay out locally** — three ledger movements that must together be balanced and exactly-once. The currency conversion is *not* a wire; it is a pair of entries on the provider's internal **FX position book**, which tracks how much of each currency the provider is long or short. Across the whole system, everything collected in one currency must equal everything paid out in another *at the mid-rate*, with the spread accumulating as margin — that invariant is what makes the book reconcilable.

**Core spec: double-entry execution against the FX book**

```sql
CREATE TABLE fx_ledger_entries (
    entry_id      BIGINT       PRIMARY KEY,
    transfer_id   BIGINT       NOT NULL,          -- groups one transfer's entries
    account       VARCHAR(40)  NOT NULL,          -- e.g. 'gbp_pool','usd_pool','fx_position_gbp','fx_position_usd','fx_margin'
    ccy           CHAR(3)      NOT NULL,
    entry_type    VARCHAR(6)   NOT NULL,          -- 'DEBIT' or 'CREDIT'
    amount_minor  BIGINT       NOT NULL,          -- integer minor units, always positive
    created_at    TIMESTAMPTZ  NOT NULL,
    CONSTRAINT entry_type_chk CHECK (entry_type IN ('DEBIT','CREDIT'))
);
CREATE INDEX idx_fx_transfer ON fx_ledger_entries (transfer_id);
CREATE INDEX idx_fx_account  ON fx_ledger_entries (account, created_at);
```

```python
def per_currency_balanced(entries):
    """Within EACH currency, total debits must equal total credits.
    Money is never converted by a single-column write; a conversion is
    modelled as a debit in one currency's FX-position account and a
    credit in the other's, so the check runs per-currency. Reports
    rather than raises; the caller halts and alerts on imbalance.
    """
    by_ccy = {}
    for e in entries:
        d, c = by_ccy.get(e["ccy"], (0, 0))
        if e["entry_type"] == "DEBIT":
            d += e["amount_minor"]
        else:
            c += e["amount_minor"]
        by_ccy[e["ccy"]] = (d, c)
    imbalances = {ccy: (d, c) for ccy, (d, c) in by_ccy.items() if d != c}
    return (len(imbalances) == 0), by_ccy, imbalances

def execute_transfer(ledger, transfer_id, quote, now):
    """Book the three movements of one transfer against the FX ledger:
      1. collect: payer's source funds land in the source local pool
      2. FX:      convert on the position book at mid + spread->margin
      3. payout:  beneficiary is paid from the destination local pool
    Written as one balanced set so per-currency debits == credits.
    """
    RATE_SCALE = 1_000_000
    src, dst = quote.src_minor, quote.dst_minor
    # dst the beneficiary would get at the honest mid-rate; the gap is margin.
    dst_at_mid = (src * quote.mid_rate_ppm) // RATE_SCALE
    margin_dst = dst_at_mid - dst          # provider keeps this in dst units

    e = ledger.next_id
    entries = [
        # 1. Collect: source pool receives payer's money (credit), FX
        #    position in source currency takes the offsetting debit.
        {"entry_id": e(), "transfer_id": transfer_id, "account": quote.src_ccy.lower() + "_pool",
         "ccy": quote.src_ccy, "entry_type": "CREDIT", "amount_minor": src, "created_at": now},
        {"entry_id": e(), "transfer_id": transfer_id, "account": "fx_position_" + quote.src_ccy.lower(),
         "ccy": quote.src_ccy, "entry_type": "DEBIT",  "amount_minor": src, "created_at": now},

        # 2+3. Destination side: position credits the full mid-value,
        #      split into what the beneficiary receives (payout) and the
        #      provider's margin. Payout pool is debited to pay out.
        {"entry_id": e(), "transfer_id": transfer_id, "account": "fx_position_" + quote.dst_ccy.lower(),
         "ccy": quote.dst_ccy, "entry_type": "CREDIT", "amount_minor": dst_at_mid, "created_at": now},
        {"entry_id": e(), "transfer_id": transfer_id, "account": quote.dst_ccy.lower() + "_pool",
         "ccy": quote.dst_ccy, "entry_type": "DEBIT",  "amount_minor": dst, "created_at": now},
        {"entry_id": e(), "transfer_id": transfer_id, "account": "fx_margin",
         "ccy": quote.dst_ccy, "entry_type": "DEBIT",  "amount_minor": margin_dst, "created_at": now},
    ]
    balanced, by_ccy, imbalances = per_currency_balanced(entries)
    if not balanced:
        raise ValueError(f"refusing to book unbalanced transfer: {imbalances}")
    ledger.write_all(entries)
    return entries

# With quote q from the first use case (src 100_000, dst 126_365, mid 1_270_000):
# GBP: pool CREDIT 100_000 == position DEBIT 100_000  -> balanced
# USD: position CREDIT 127_000 == pool DEBIT 126_365 + margin DEBIT 635 -> balanced
```

**Data structures:** `fx_ledger_entries` is the durable double-entry core; `idx_fx_transfer` answers "show every leg of transfer X" (status queries, reconciliation) and `idx_fx_account` answers "sum this pool's or this position's movements over a window" (treasury and reconciliation). A separate `transfers` row holds the workflow status and the two local-rail references (the domestic-transfer ids on each end).

**Trade-offs:**
* **The gotcha:** representing the conversion as a single mutable "balance += converted amount" write throws away the invariant that makes the FX book auditable — that within each currency debits equal credits, and that the two currencies are linked only through the position and margin accounts. A bug that credits the destination pool without the matching position debit would silently mint money, and nothing would catch it. The fix is the per-currency balanced write above, verified at write time and again by the reconciliation job across the whole book.
* Splitting the destination side into a **payout** to the beneficiary and a **margin** entry is what keeps the spread from being invisible: at the mid-rate the two currency positions net to zero, and the margin account is exactly the accumulated spread — a number the finance team can reconcile against the sum of `fee_minor` across all quotes.

### Use case: Move each local leg exactly-once with an idempotency key

Each domestic leg — collecting the payer's funds and paying out the beneficiary — is a call to an external local rail that can time out ambiguously: the payout may have succeeded while the response was lost. Without a guard, a retry pays the beneficiary twice. The system anchors exactly-once on a **client-generated idempotency key** per logical transfer, reused across every retry, exactly the discipline this course's [Idempotency](/docs/patterns/reliability/idempotency) pattern describes, applied to a two-legged cross-currency movement.

**Core spec: atomic claim-or-replay on the transfer key**

```sql
CREATE TABLE transfer_claims (
    idempotency_key  VARCHAR(64) PRIMARY KEY,   -- one per logical transfer, reused on retry
    transfer_id      BIGINT,
    status           VARCHAR(24) NOT NULL,      -- 'IN_FLIGHT','PAID_OUT','REFUNDED','DECLINED_*'
    stored_response  JSONB,                     -- exact response replayed on a retry
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

```python
def claim_transfer(store, idempotency_key):
    """Atomically claim a brand-new transfer key as IN_FLIGHT, or, if it
    already exists, return the current row so the caller replays the
    terminal outcome instead of paying out a second time. The
    INSERT ... ON CONFLICT DO NOTHING makes the claim one atomic step:
    two concurrent retries race on the primary key, exactly one wins,
    and the loser reads the winner's row -- it never starts a second
    payout.
    """
    inserted = store.execute(
        """
        INSERT INTO transfer_claims (idempotency_key, status)
        VALUES (%s, 'IN_FLIGHT')
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING idempotency_key
        """,
        (idempotency_key,),
    )
    if inserted:
        return {"won": True, "terminal": False, "stored_response": None}
    row = store.fetch_one(
        "SELECT status, stored_response FROM transfer_claims WHERE idempotency_key = %s",
        (idempotency_key,),
    )
    return {"won": False, "terminal": row["status"] != "IN_FLIGHT",
            "stored_response": row["stored_response"]}
```

**Data structures:** `transfer_claims` above is the durable exactly-once anchor, deliberately separate from `fx_ledger_entries` and `transfers`: its only job is win-or-replay under concurrency on a single key, so it is optimized for a strongly-consistent conditional insert.

**Trade-offs:**
* **The gotcha:** a crash *between* claiming the key and completing the payout leg leaves a dangling `IN_FLIGHT` row while a retry that reads `IN_FLIGHT` might wait forever. The fix is a **timeout-and-reconcile** rule: an `IN_FLIGHT` claim older than a bounded window is handed to a reconciler that asks the local rail whether a payout for this transfer actually landed (keyed by the same idempotency reference the rail was given), then drives the row to a real terminal state — a retry never guesses, it replays a terminal result or waits for reconciliation.
* Because the collect and payout legs hit *different* rails in *different* countries, the exactly-once guard must cover the whole transfer, not each leg in isolation: the key gates the entire collect-convert-payout sequence so a retry re-enters at the right point rather than re-running a leg that already succeeded.

### Use case: Reconcile the internal FX book against real bank statements

The internal ledger is the provider's belief about where money is; the **bank statements** of its local accounts are the ground truth. Reconciliation is the standing process that matches the two and surfaces drift — a payout the ledger thinks failed that the bank actually made, a collect the bank received that the ledger never booked. It also re-checks the FX invariant: across the whole book, each currency's debits equal its credits, and the two currency positions net to zero at the mid-rate, leaving exactly the accumulated margin.

**Core spec: statement-to-ledger matching and the book invariant**

```python
def reconcile_pool(statement_lines, ledger_entries):
    """Match a local account's bank statement against the ledger's
    entries for that pool. A statement line and a ledger entry match
    when the rail reference and the integer minor amount agree. Anything
    unmatched on either side is drift a human must resolve.

    Returns (matched, only_in_bank, only_in_ledger).
    """
    bank = {(l["rail_ref"], l["amount_minor"]) for l in statement_lines}
    book = {(e["rail_ref"], e["amount_minor"]) for e in ledger_entries}
    matched       = bank & book
    only_in_bank  = bank - book   # money moved that the ledger missed
    only_in_ledger = book - bank  # ledger claims a move the bank did not make
    return matched, only_in_bank, only_in_ledger

def fx_book_nets_to_zero(entries, mid_rates_ppm):
    """Across the whole book, revalue every currency's net FX position
    into a common base currency at the mid-rate; the positions must sum
    to zero (what was taken in one currency equals what was paid in the
    other AT MID), and the residual is the margin account -- never a
    mystery imbalance. mid_rates_ppm maps ccy -> ppm-per-base.
    """
    net = {}  # ccy -> signed minor units on fx_position_* accounts
    for e in entries:
        if not e["account"].startswith("fx_position_"):
            continue
        sign = 1 if e["entry_type"] == "CREDIT" else -1
        net[e["ccy"]] = net.get(e["ccy"], 0) + sign * e["amount_minor"]
    base_total = 0
    for ccy, amount in net.items():
        base_total += (amount * mid_rates_ppm[ccy]) // 1_000_000
    return base_total == 0, net
```

**Data structures:** a `reconciliation_run` record per pool per cycle — `pool_account`, `cycle_start`, `cycle_end`, counts of `matched`, `only_in_bank`, `only_in_ledger`, and a `status` (`clean`/`breaks_found`). Breaks are queued to an operations tool, never auto-resolved, because a break is by definition a place where the ledger and reality disagree.

**Trade-offs:**
* **The gotcha:** because the payout pool is *pre-funded*, a duplicate or spurious payout does not bounce for insufficient funds the way it might in a just-in-time model — the money is really there and really leaves. That makes reconciliation the primary detective control, not a nicety: the exactly-once guard is the preventive control, and statement matching is what catches anything that slips past it. Running both is defense in depth.
* Revaluing positions at the **mid-rate** (not the customer rate) for the net-to-zero check is deliberate: it separates genuine market exposure (the provider's net long/short position, which treasury hedges) from margin (the accumulated spread). Mixing them would make it impossible to tell a hedging gap from an accounting error.

## Step 4: Scale the design

![Cross-border FX platform at scale: many local-rail adapters each backed by a pre-funded in-country account (GBP over UK Faster Payments, USD over ACH or RTP, EUR over SEPA), an API gateway issuing idempotent quotes, a quote and FX service pricing off a mid-rate feed with a spread and rate lock, a double-entry ledger and FX position book in integer minor units, a compliance and AML screening service, a treasury rebalancing service topping up drifting local pools, and a reconciliation layer matching bank statements against the internal ledger and running CLS-style PvP settlement-risk checks](/img/case-studies/fintech/cross-border-payments-fx-scaled.svg)

* **Quotes are read-mostly and short-lived, so the quote path is cache-and-replica friendly, while the money-movement path is not** — see [Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication). The mid-rate feed and current spread can be served from replicas and cached within the rate-lock window, absorbing the ~5,600 quotes/sec peak, but the execution path reads and writes the authoritative FX book and cannot be served stale.
* **The ledger and transfer claims shard by `transfer_id`, since every exactly-once guard and every transfer's legs are scoped to one transfer** — see [Sharding](/docs/patterns/storage/sharding). That keeps the hot claim-or-replay path free of cross-shard transactions, exactly as the payment-processor and UPI case studies shard their idempotency stores.
* **Each local rail gets its own adapter with a [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) and [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff), isolated per corridor** — a struggling US rail must not stall GBP or EUR payouts. Isolating one rail's failures from the rest is the [Bulkhead](/docs/patterns/reliability/bulkhead) idea applied to country rails, and retries against a rail must always carry the same idempotency key so a retry can never become a second payout.
* **The collect-convert-payout sequence is coordinated as a [Saga](/docs/patterns/consistency/saga), not a distributed lock across two national rails** — holding a two-phase lock across two independently-operated banking systems for the duration of their domestic-transfer round-trips is exactly what [Two-Phase Commit](/docs/patterns/consistency/two-phase-commit) handles poorly. Instead each leg is a local commit with an explicit compensating action: if the payout leg fails after collection, the compensation refunds the payer rather than leaving their money stranded in the source pool.
* **Treasury rebalancing runs as an independent background job off the hot path**, topping up pools that drift as transfers flow one direction, buying and moving currency in bulk at wholesale rates. This is the slow, real-cost leg the fast customer-facing transfer is deliberately decoupled from.
* **Reconciliation runs as a distributed batch**, pulling each pool's bank statement intraday and matching it against the sharded ledger, then re-checking the whole-book FX invariant — a defense-in-depth detective layer on top of the request-time exactly-once guard.

## Additional talking points

* **The spread is the fee, and honesty about it is the product.** The mid-market rate is a real, observable reference; the money a provider makes is the gap between it and the rate the customer gets. Legacy correspondent chains bury that gap across multiple hops so the total is hard to see, which is precisely the opacity modern providers compete against by quoting a single explicit spread on the honest midpoint. A practitioner must be able to compute the all-in cost in integer minor units, as the quote and correspondent-chain code above do, rather than trust a headline flat fee.
* **Settlement risk and PvP: the two legs do not settle at the same instant.** When a provider (or a bank) converts currency, it typically pays out one currency before it has finally received the other, and if the counterparty fails in that gap it can lose the full principal — this is **Herstatt risk**, named for a 1974 bank failure where exactly this time-zone gap caused losses. The mitigation is **payment-versus-payment (PvP)**: settle both currency legs only if both will settle, which is what **CLS (Continuous Linked Settlement)** provides for interbank FX. In this design the analogue is that the internal FX book and the treasury hedging must account for the window between collecting on one rail and paying out (or rebalancing) on the other, rather than assuming the two legs are simultaneous.
* **Pre-funding is a capital cost, and it is the real trade-off of the local-rails model.** Same-day local payouts are only possible because the provider already holds money in the destination country — which means capital sits idle in every corridor's pool, and pools drift and must be rebalanced. The model trades correspondent-banking fees and delay for treasury complexity and locked-up working capital; that is why rebalancing, liquidity forecasting, and hedging are first-class systems, not afterthoughts.
* **Compliance is per-corridor and non-negotiable.** Cross-border flows trigger AML screening, sanctions checks, and jurisdiction-specific fund-flow rules on both ends. Screening typically sits before the payout leg so a flagged transfer is held before money leaves a pool, and the richer structured data of **ISO 20022** exists partly to make this screening cleaner than the free-text fields of legacy `MT103` messages allowed.
* **Stablecoin rails are the other way to skip correspondents, honestly noted.** Instead of pre-funding local accounts, some providers move value as a dollar-referenced stablecoin on a blockchain and convert to local currency at each end. It removes the correspondent chain much as local rails do, but substitutes a different set of risks — on-chain settlement finality, the stablecoin issuer's own reserve backing, and on/off-ramp liquidity — so it is a genuine alternative, not a strict upgrade, and belongs in the design space rather than presented as a finished answer.
* **This shares its exactly-once and double-entry spine with the domestic cases.** The [UPI case study](/docs/case-studies/fintech/upi-real-time-payments) and the [Design Global Payment Processing (PayPal) case study](/docs/case-studies/fintech/global-payment-processing) both anchor on an idempotent transaction id and a balanced ledger; what makes cross-border distinct is the added axis of currency — the FX book, the spread, and the settlement-timing risk between two currency legs — layered on top of that same correctness core. The correspondent-banking fallback here is the same nostro/vostro relay designed in the [How Banks Move Money case study](/docs/case-studies/fintech/how-banks-move-money), which covers the domestic rails (book transfer, ACH, Fedwire, RTP/FedNow) this design's local legs actually run on.

## Source(s) and further reading

* [SWIFT — Wikipedia](https://en.wikipedia.org/wiki/SWIFT) — the interbank messaging network that carries cross-border payment instructions, including the MT message families and the ISO 20022 migration
* [MT103 — Wikipedia](https://en.wikipedia.org/wiki/MT103) — the legacy single customer credit transfer message format this design models in the correspondent-chain fallback
* [ISO 20022 — Wikipedia](https://en.wikipedia.org/wiki/ISO_20022) — the richer, structured messaging standard SWIFT and the wider industry are migrating to, referenced throughout Step 3
* [Correspondent account — Wikipedia](https://en.wikipedia.org/wiki/Correspondent_account) and [Nostro and vostro accounts — Wikipedia](https://en.wikipedia.org/wiki/Nostro_and_vostro_accounts) — how the traditional hop chain settles value one bank at a time
* [Correspondent banking — final report, BIS CPMI](https://www.bis.org/cpmi/publ/d147.htm) — primary central-bank reference on how correspondent chains work, their costs, and their decline
* [On the global retreat of correspondent banks — BIS Quarterly Review](https://www.bis.org/publ/qtrpdf/r_qt2003g.htm) — data on why intermediary hops add cost and delay and why corridors are consolidating
* [Bid–ask spread — Wikipedia](https://en.wikipedia.org/wiki/Bid%E2%80%93ask_spread) and [Foreign exchange market — Wikipedia](https://en.wikipedia.org/wiki/Foreign_exchange_market) — the market mechanics behind mid-rate versus spread, the true-fee argument in the quote use case
* [What is the mid-market exchange rate — Wise](https://wise.com/help/articles/2932693/what-is-the-mid-market-exchange-rate) and [How does Wise work — Wise](https://wise.com/gb/blog/how-does-wise-work) — the local-rails, mid-market-plus-spread model this design is shaped after
* [Airwallex — Wikipedia](https://en.wikipedia.org/wiki/Airwallex) — the API-first cross-border provider named in the source video, operating the local-account and like-for-like settlement model
* [Settlement risk — Wikipedia](https://en.wikipedia.org/wiki/Settlement_risk), [Herstatt Bank — Wikipedia](https://en.wikipedia.org/wiki/Herstatt_Bank), and [Continuous Linked Settlement — Wikipedia](https://en.wikipedia.org/wiki/Continuous_Linked_Settlement) — the time-zone-gap FX settlement risk and the PvP mitigation discussed in the talking points
* [FX settlement risk remains significant — BIS Quarterly Review](https://www.bis.org/publ/qtrpdf/r_qt1912x.htm) — central-bank analysis quantifying how much FX still settles without PvP protection
* [Idempotency](/docs/patterns/reliability/idempotency) — the exactly-once guard applied to each transfer's local legs
* [Saga](/docs/patterns/consistency/saga) and [Two-Phase Commit](/docs/patterns/consistency/two-phase-commit) — the compensating-transaction coordination across two national rails, and the blocking alternative this design rejects
* [Sharding](/docs/patterns/storage/sharding), [Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication), [Circuit Breaker](/docs/patterns/reliability/circuit-breaker), [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff), and [Bulkhead](/docs/patterns/reliability/bulkhead) — the scaling and fault-isolation patterns behind Step 4
