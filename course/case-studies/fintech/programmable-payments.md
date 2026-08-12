---
title: "Design Programmable Card Transactions"
sidebar_position: 12
---

The defining property of a modern issuer-processor platform is that it puts *your code* on the critical path of a card authorization, inside a hard real-time budget it does not control. When a cardholder taps at a merchant, the card network sends an authorization request to the issuer and expects a yes-or-no answer within roughly two seconds; miss that window and the network applies a stand-in default and moves on. A programmable-card platform (Marqeta, Stripe Issuing, Lithic and peers) exposes that decision point as a synchronous webhook: it forwards the network's authorization request to the developer's endpoint, the developer's code runs a spend-control rule engine and *funds* the transaction on the fly — Just-In-Time (JIT) funding — and replies approve or decline before the clock runs out. Everything hard about this system flows from that one constraint: an arbitrary developer function must return a correct, funded, idempotent money-movement decision within a couple of hundred milliseconds of budget, and the platform must have a safe answer ready for the network the instant that function is late.

This case study designs a system with the shape of a JIT-funding issuer-processor. It is grounded in how Marqeta's Gateway JIT Funding, Stripe Issuing's real-time authorizations, and Lithic's Authorization Stream Access actually behave, and it keeps the two clocks that matter — the network's authorization timeout and the later clearing cycle — distinct throughout.

## Step 1: Outline use cases and constraints

### Use cases

#### We'll scope the problem to handle the following use cases

* A **developer** (the platform's customer — a fintech, a corporate-card startup, a marketplace) registers a **synchronous authorization webhook** and issues cards programmatically via an API
* When a cardholder transacts, the **card network** sends an ISO 8583 authorization request to the issuer-processor, which forwards it to the developer's webhook and expects an **approve or decline** decision within the network's authorization window
* On approval the developer's code performs **Just-In-Time funding**: it decides, at transaction time, whether and how much to fund, moving money from a funding source into the card's account only for the amount actually being spent
* Developers attach **spend controls** to a card or program — allowed merchant category codes (MCCs), specific merchant allow/deny lists, per-transaction and rolling amount caps, time-of-day rules — evaluated by a rule engine inside the webhook
* Developers issue **virtual cards** locked to a single merchant and/or a single amount (for a subscription, a vendor payout, or a one-time purchase), so a leaked card number is useless anywhere else
* The platform enforces a **stand-in default** when the webhook is slow, errors, or is unreachable, so the network always gets a timely answer
* Authorizations are **holds**, not debits; a later **clearing** (presentment) message settles the real amount, which can differ from the authorized amount, and the platform reconciles the two
* Every authorization decision is **idempotent** with respect to network retries, and the auth-to-clearing linkage is durable and auditable

#### Out of scope

* The card network's own routing and the acquirer/merchant side of the flow — treated as an external system that delivers ISO 8583 messages to the issuer-processor
* Card manufacturing, EMV chip personalization, and the physical/tokenized card provisioning into mobile wallets — named only in the talking points
* The developer's own end-user KYC, onboarding, and funding-account top-ups
* Dispute and chargeback lifecycle beyond a brief mention
* The BIN sponsorship and bank/network membership arrangements that let a processor issue at all

### Constraints and assumptions

#### State assumptions

* The **network authorization timeout** is the master constraint. In practice the developer-facing budget is on the order of **2 seconds** (Stripe auto-decides at 2 s; Marqeta's gateway budget is about 3 s; Lithic hard-declines at 6 s but recommends responding within 3 s). The design must treat the whole round-trip — network to processor to developer webhook and back — as fitting inside a single-digit-second envelope, with the developer's own compute measured in the low hundreds of milliseconds.
* A **late or failed webhook must not stall the network**: the platform must always emit a decision, falling back to a pre-configured **stand-in rule** (approve-by-default, decline-by-default, or a managed spend-control evaluation) rather than blocking.
* An **authorization is a hold**, reserving funds; the **clearing** message that arrives later (often the next day) is the real debit, and its amount can differ (tip added at a restaurant, fuel pump final amount, partial shipment). The system must reconcile clearing against the original authorization rather than assuming they are equal.
* Authorization decisions must be **idempotent**: the network may resend the same authorization (advice/repeat messages), and the same logical auth must never fund twice.
* **JIT funding** means an account need not carry a pre-loaded balance; funds move from a developer-owned funding source into the card account at transaction time, for exactly the approved amount.
* **PCI-DSS scope**: primary account numbers (PANs) live inside the processor's cardholder-data environment; the developer's webhook decides on transactions referenced by tokens and card ids, not raw PANs, keeping the developer largely out of PCI scope.

#### Calculate usage

* Assume a mid-size program at **2,000 authorizations/sec average**, peaking around **5x** on high-traffic days → design the auth path for roughly **~10,000 authorizations/sec** at peak. The auth path is latency-bound, not throughput-bound: the scarce resource is the milliseconds of budget per decision, not raw QPS.
* **Latency budget** for one authorization, working backward from a ~2 s network window: reserve roughly 400–600 ms for network and processor transport and ISO 8583 parsing/serialization on each side, leaving the developer webhook a practical target of **under ~300 ms**, with a hard internal deadline (say 1.5 s) after which the platform stops waiting and applies the stand-in. Lithic explicitly warns that responders slower than ~3 s see approvals get voided by the network — so the effective SLO is far tighter than the raw timeout.
* Each authorization spawns a small fan-out of durable writes: an auth record, one or more JIT funding-ledger entries (a debit against the funding source and a credit to the card account), and an idempotency claim → on the order of **3–5 writes per auth** → at peak ~**30,000–50,000 ledger/state writes/sec**, which must commit fast enough to stay inside the budget, so the hot auth store is optimized for low-latency single-key writes.
* **Clearing volume** trails authorizations: not every auth clears (some expire, some are reversed), and clearings arrive **batched, off the real-time path**, typically once or a few times per day, so the clearing/reconciliation engine is a high-throughput batch job, not a low-latency service.
* **Storage:** an auth record (auth id, card token, MCC, merchant id, amounts in minor units, decision, rule-trace, timestamps) plus its funding legs ≈ **~1 KB/auth** → at 2,000 auth/sec average that is ~**170 GB/day** of auth+ledger data, which shards and tiers to cold storage, and feeds reconciliation as a distributed job.
* **Virtual-card issuance** is a separate, lower-volume control-plane operation (create a card, attach constraints); the read-heavy work is loading a card's spend-control policy on every authorization, which is cached with tight invalidation because a stale policy is a correctness bug, not just a stale read.

## Step 2: Create a high-level design

![Programmable card authorization flow: cardholder taps at a merchant, the acquirer and card network deliver an ISO 8583 authorization request to the issuer-processor, which forwards it as a synchronous webhook to the developer service, whose rule engine and JIT funding decide approve or decline within the network timeout; on timeout the processor applies a stand-in default, and later a batched clearing message settles the real amount against the original hold](/img/case-studies/fintech/programmable-payments-overview.svg)

The system is a **five-party real-time loop** with a hard deadline. A cardholder transacts at a **merchant**; the merchant's **acquirer** and the **card network** (Visa, Mastercard) package the purchase as an ISO 8583 authorization request (message class 0x1xx — a 0100 authorization request) and route it to the **issuer-processor** identified by the card's BIN. Traditionally the issuer's mainframe would answer from static rules. The programmable-card twist is that the processor does not decide alone: it forwards the request as a **synchronous webhook** to the **developer service**, waits for a decision, and relays that decision back to the network as an authorization response (0110). Around this loop sits a **stand-in** safety net: if the developer service is slow, errors, or unreachable, the processor answers on its behalf from a pre-configured default so the network is never left waiting.

Two clocks run through this design and must never be conflated. The first is the **authorization clock** — the ~2 s window in which the developer's code must run its **spend-control rule engine** (does this MCC, this merchant, this amount, this time pass the card's rules?) and perform **Just-In-Time funding** (move exactly the approved amount from the developer's funding source into the card's account and reply approve, or reply decline). This leg is real-time, latency-critical, and idempotent. The second is the **clearing clock** — hours to a day later, the network sends a clearing/presentment message with the *final* amount, which the platform matches to the original authorization hold and posts as the real debit, releasing or adjusting the hold when the cleared amount differs. Getting the first leg fast and exactly-once, while letting the second leg run as a reconciled batch, is the whole architecture. The rest of this study designs each piece around those two clocks.

## Step 3: Design core components

### Use case: The processor forwards a network auth to the developer webhook and enforces the timeout

This is the heartbeat of the system. The processor receives an ISO 8583 authorization request from the network, must obtain a decision, and must respond to the network within the window — with or without the developer. The contract is: the processor calls the webhook with the transaction context, waits up to an internal deadline strictly shorter than the network timeout, and if no valid response arrives it applies the program's **stand-in rule** and answers the network anyway. The developer's slowness becomes the processor's decision, never the network's problem.

**Core spec: synchronous auth webhook with a deadline and stand-in fallback**

```python
import time
from dataclasses import dataclass

@dataclass
class AuthContext:
    auth_id: str          # processor-generated id for THIS authorization
    card_token: str       # tokenized card ref -- never the raw PAN
    amount_minor: int     # requested amount in minor units (e.g. cents)
    currency: str
    mcc: str              # merchant category code, e.g. "5814" (fast food)
    merchant_id: str
    merchant_name: str
    network_ref: str      # network's retrieval/trace ref, for idempotency
    is_amount_controllable: bool  # network allows a partial approval

@dataclass
class AuthDecision:
    approved: bool
    approved_amount_minor: int   # <= requested; equals amount when full approve
    decline_reason: str | None   # e.g. "SPEND_CONTROL", "INSUFFICIENT_FUNDS"
    rule_trace: list              # which rules fired, for audit/debugging

# Deadline is deliberately SHORTER than the network's ~2s window so the
# processor always has time to serialize a stand-in 0110 response.
WEBHOOK_DEADLINE_MS = 1500

def authorize(ctx, webhook_client, standin, ledger, idem):
    """Drive one authorization to a network response within the deadline.

    Order matters: claim idempotency first (network repeats must replay,
    not re-decide), then call the developer webhook with a hard timeout,
    then fall back to the program's stand-in if the webhook is late or
    returns an invalid body. The function ALWAYS returns a decision.
    """
    claim = idem.claim(ctx.auth_id, ctx.network_ref)
    if claim.already_decided:
        return claim.stored_decision           # network repeat -> replay

    started = time.monotonic()
    try:
        decision = webhook_client.call(
            ctx, timeout_ms=WEBHOOK_DEADLINE_MS
        )
        decision = _validate(decision, ctx)    # reject malformed responses
    except (TimeoutError, InvalidResponse) as exc:
        # The developer was late or wrong: the network still needs an
        # answer, so the processor decides via the configured stand-in.
        decision = standin.decide(ctx, reason=type(exc).__name__)

    if decision.approved:
        # JIT funding happens as part of committing an approval (below),
        # so a hold is never placed without funds actually moving.
        ledger.fund_and_hold(ctx.auth_id, ctx.card_token,
                             decision.approved_amount_minor, ctx.currency)

    idem.finalize(ctx.auth_id, decision)       # store for replay
    return decision

def _validate(decision, ctx):
    if decision is None:
        raise InvalidResponse("empty webhook body")
    if decision.approved:
        amt = decision.approved_amount_minor
        if amt <= 0 or (not ctx.is_amount_controllable and amt != ctx.amount_minor):
            raise InvalidResponse("bad approved amount")
    return decision

class TimeoutError(Exception): ...
class InvalidResponse(Exception): ...
```

**Data structures:** an `authorizations` row keyed by `auth_id` — `card_token`, `amount_minor`, `approved_amount_minor`, `currency`, `mcc`, `merchant_id`, `network_ref`, `decision`, `decided_by` (`WEBHOOK`/`STANDIN`), `rule_trace`, `created_at`. Amounts are always **integer minor units** (cents/paise), never floats. A separate stand-in configuration per program records the fallback mode (`APPROVE`, `DECLINE`, or `MANAGED` spend-control evaluation) and is loaded on the hot path.

**Trade-offs:**
* **The gotcha:** the naive design waits on the developer webhook up to the *network's* timeout, then discovers it has no time left to compose and send the response — so the network times out at *its* layer and applies *its own* stand-in, silently overriding the program's intended default. The fix is a **processor deadline strictly shorter than the network window** (`WEBHOOK_DEADLINE_MS` well under the ~2 s), reserving headroom to serialize and send the stand-in 0110. The processor, not the network, must be the one to fall back, because only the processor knows the program's chosen default. Lithic makes this concrete: it declines at 6 s but warns that responses slower than ~3 s get the approval voided by the network afterward — so the *effective* budget is much tighter than the hard timeout.
* Placing the funding-and-hold **inside** the approval commit (not as a later step) guarantees the invariant "no hold without funds moved," so an approval the network honors is always backed by a real ledger movement.

**REST API:** the webhook the *processor* sends to the *developer* (the developer's endpoint replies with the decision body):

```
$ curl -X POST https://dev.example.com/webhooks/authorize \
    -H "Content-Type: application/json" \
    -H "X-Processor-Signature: t=1755075247,v1=<hmac-sha256>" \
    -d '{
          "type": "authorization.request",
          "auth_id": "auth_1f3a9c",
          "card_token": "card_tok_9Qm2",
          "amount_minor": 1299,
          "currency": "usd",
          "mcc": "5814",
          "merchant_id": "mid_9931",
          "merchant_name": "COFFEE HOUSE 22",
          "network_ref": "042315678901",
          "is_amount_controllable": false
        }'
```

Developer's response (must return HTTP 200 within the deadline):

```json
{
  "approved": true,
  "approved_amount_minor": 1299,
  "metadata": {"budget": "coffee", "rule": "mcc_allow"}
}
```

### Use case: The spend-control rule engine decides approve or decline

Inside the webhook, the developer's code is a **deterministic rule engine** over the authorization context. This is where "block Amazon after 10 pm," "only Uber, capped at 200 dollars a month," and "decline any MCC not on the allow-list" live. It must be fast (it runs inside the budget), pure enough to be idempotent (the same context yields the same decision), and it must return a **trace** of which rules fired so a decline is explainable and auditable.

**Core spec: an ordered spend-control rule engine**

```python
from dataclasses import dataclass, field

@dataclass
class Card:
    card_token: str
    allowed_mccs: set          # empty set == allow all
    blocked_merchants: set
    per_txn_cap_minor: int
    monthly_cap_minor: int
    active: bool

@dataclass
class SpendState:
    month_spent_minor: int     # rolling total already authorized this cycle

def evaluate_controls(ctx, card: Card, state: SpendState) -> AuthDecision:
    """Return an AuthDecision by applying spend controls in a fixed order.

    Rules are evaluated most-restrictive-first and short-circuit on the
    first failure, so a decline names the SINGLE binding reason. The
    trace records every rule checked, which is what makes a decline
    explainable to the cardholder and auditable later.
    """
    trace = []

    def check(name, ok):
        trace.append({"rule": name, "passed": ok})
        return ok

    if not check("card_active", card.active):
        return AuthDecision(False, 0, "CARD_INACTIVE", trace)

    if not check("merchant_allowed", ctx.merchant_id not in card.blocked_merchants):
        return AuthDecision(False, 0, "MERCHANT_BLOCKED", trace)

    mcc_ok = (not card.allowed_mccs) or (ctx.mcc in card.allowed_mccs)
    if not check("mcc_allowed", mcc_ok):
        return AuthDecision(False, 0, "MCC_NOT_ALLOWED", trace)

    if not check("per_txn_cap", ctx.amount_minor <= card.per_txn_cap_minor):
        return AuthDecision(False, 0, "PER_TXN_CAP", trace)

    projected = state.month_spent_minor + ctx.amount_minor
    if not check("monthly_cap", projected <= card.monthly_cap_minor):
        return AuthDecision(False, 0, "MONTHLY_CAP", trace)

    return AuthDecision(True, ctx.amount_minor, None, trace)
```

**Data structures:** a `card_controls` policy per card token — `allowed_mccs`, `blocked_merchants`, `per_txn_cap_minor`, `monthly_cap_minor`, `active` — plus a `spend_state` counter of `month_spent_minor` per card per cycle. The policy is read on every authorization, so it is cached close to the webhook with **invalidation on any control update**, because approving against a stale (looser) policy is a real spend-control failure.

**Trade-offs:**
* **The gotcha:** rolling caps like a monthly limit are evaluated against **authorizations**, but the true spend is what eventually **clears**, and the two differ (an auth can expire uncaptured, or clear for less). If the monthly counter is only ever incremented on auth and never reconciled against clearing and reversals, it drifts — a card can be wrongly blocked because expired holds were never released from the counter, or wrongly allowed if reversals were double-counted. The fix is that `month_spent_minor` is a **derived, reconciled figure**: increment on approved auth for responsiveness, but correct it from the clearing/reversal stream so the counter converges to real settled spend, not the sum of every hold ever placed.
* Ordering rules most-restrictive-first and short-circuiting keeps the engine inside its millisecond budget and yields a single, explainable binding reason instead of an ambiguous multi-failure.

### Use case: Just-In-Time funding moves money at transaction time

JIT funding is what lets a card account carry **no pre-loaded balance**: instead of topping up every card in advance, the developer funds each transaction as it happens, moving exactly the approved amount from a funding source into the card's account at authorization time. Represented as double-entry ledger legs, this makes the money movement mechanically checkable: every approved authorization debits the funding source and credits the card account for the identical amount, so the hold placed on the card is always backed by a real movement.

**Core spec: double-entry JIT funding legs + the balance invariant**

```sql
CREATE TABLE funding_legs (
    leg_id        BIGINT      PRIMARY KEY,
    auth_id       VARCHAR(64) NOT NULL,      -- groups the legs of one auth
    account       VARCHAR(32) NOT NULL,      -- 'funding_source' or 'card:<token>'
    direction     VARCHAR(6)  NOT NULL,      -- 'DEBIT' or 'CREDIT'
    amount_minor  BIGINT      NOT NULL,      -- integer minor units, positive
    kind          VARCHAR(12) NOT NULL,      -- 'HOLD','CLEAR','REVERSE'
    posted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT dir_chk  CHECK (direction IN ('DEBIT','CREDIT')),
    CONSTRAINT kind_chk CHECK (kind IN ('HOLD','CLEAR','REVERSE'))
);
CREATE INDEX idx_legs_auth ON funding_legs (auth_id);
```

```python
def fund_and_hold(store, auth_id, card_token, amount_minor, currency):
    """Post the two JIT-funding legs for an approval as one transaction:
    DEBIT the funding source, CREDIT the card account, both for the same
    amount. Committing them together means a hold can never exist without
    the matching funds movement (and vice versa).
    """
    with store.transaction():
        store.insert_leg(auth_id, "funding_source",       "DEBIT",  amount_minor, "HOLD")
        store.insert_leg(auth_id, f"card:{card_token}",   "CREDIT", amount_minor, "HOLD")

def auth_is_balanced(legs):
    """Across the legs of one auth, total debits must equal total credits.
    Reports rather than raises so the caller decides whether to halt.
    """
    debits  = sum(l["amount_minor"] for l in legs if l["direction"] == "DEBIT")
    credits = sum(l["amount_minor"] for l in legs if l["direction"] == "CREDIT")
    return debits == credits, debits, credits
```

**Data structures:** `funding_legs` is the durable double-entry record; `idx_legs_auth` answers "show every leg of authorization X" (used by clearing, reversal, and reconciliation). `kind` distinguishes the original `HOLD` from a later `CLEAR` or `REVERSE`, so the lifecycle of one authorization is reconstructable from its legs alone.

**Trade-offs:**
* **The gotcha:** modeling JIT funding as a single "balance" field on the card account and mutating it in place loses the audit trail and makes concurrent auths race on the same row. The fix is **append-only double-entry legs**: every movement is a new immutable pair of rows, balances are *derived* by summing legs, and the balance invariant (debits equal credits per auth) is checkable at write time and during reconciliation. This is the same ledger discipline card processors use to keep JIT-funded accounts auditable without pre-funding.
* Because Managed-JIT programs let the platform run the spend-control evaluation itself (no developer call), the *same* leg model must serve both paths — a platform-decided approval funds identically to a developer-decided one, so there is one money-movement code path, tested once.

### Use case: Issue a virtual card locked to one merchant and amount

A virtual card is a card number minted programmatically and constrained so tightly that a leak is worthless: locked to a single merchant, a single amount or tight cap, and often single-use or short-lived. This is the mechanism behind per-subscription cards, per-vendor payout cards, and one-time checkout cards. The constraints are just spend controls set at issuance, enforced by the very same rule engine on every authorization.

**Core spec: mint a constrained virtual card**

```python
import secrets

def issue_virtual_card(store, program_id, constraints):
    """Create a virtual card and persist its spend controls atomically.
    The card is unusable outside its constraints because the SAME
    evaluate_controls() rules run on every authorization against them.
    `constraints` carries the merchant lock, amount cap, and MCC allow-list.
    """
    card_token = "card_tok_" + secrets.token_hex(8)
    card = Card(
        card_token=card_token,
        allowed_mccs=set(constraints.get("allowed_mccs", [])),
        blocked_merchants=set(),                    # allow-list style below
        per_txn_cap_minor=constraints["amount_cap_minor"],
        monthly_cap_minor=constraints["amount_cap_minor"],
        active=True,
    )
    # Merchant lock: an allow-list of one. Enforced by pinning the
    # merchant id the card may ever transact with, checked per auth.
    locked_merchant = constraints.get("locked_merchant_id")
    with store.transaction():
        store.save_card(program_id, card)
        if locked_merchant:
            store.pin_merchant(card_token, locked_merchant)
    return {"card_token": card_token, "last4": _mint_last4()}

def _mint_last4():
    return f"{secrets.randbelow(10000):04d}"
```

For a merchant-locked card, `evaluate_controls` is extended so any `merchant_id` other than the pinned one fails the `merchant_allowed` check — turning the block-list into an allow-list of exactly one merchant.

**Data structures:** the same `card_controls` policy row plus an optional `pinned_merchant_id`. A single-use card additionally carries a `max_auths` (often 1) enforced by the rule engine reading the card's auth count. The **raw PAN is generated and stored only inside the processor's PCI cardholder-data environment**; the developer works with `card_token` and `last4`, never the full number.

**Trade-offs:**
* **The gotcha:** locking a virtual card to an exact amount seems airtight until clearing arrives for a *different* amount — a merchant adds tax or a tip, or authorizes for an estimate and clears higher. A rigid exact-amount equality on the auth would decline legitimate transactions, and a rigid equality on clearing would break reconciliation. The fix is to constrain the **authorization** with a small tolerance band (or use the amount as a cap, not an equality) and let **clearing reconcile within tolerance**, so single-amount cards survive real-world tips and estimates without becoming useless.
* Minting the PAN inside the processor's PCI environment and exposing only a token is what keeps the developer **out of PCI-DSS scope for card data** while still letting them fully control authorization logic.

### Use case: Reconcile clearing against the authorization hold

Hours to a day after the authorization, the network sends a **clearing** (presentment) message — the real request for funds, carried in the ISO 8583 reconciliation/presentment class (the 0x5xx messages) versus the 0x1xx authorization class, precisely because this is a *dual-message* system where authorization and clearing are separate events. (The 0x2xx *financial* class is the opposite model — a single message that authorizes and posts at once, as an ATM withdrawal does — which is exactly the auth-and-clear-together shape this design deliberately does not use.) Its amount is the *final* amount and can differ from the hold. The platform must match the clearing to its original authorization, post the real debit, and release or adjust the hold. This is the settlement leg, and it runs as a batch off the real-time path.

**Core spec: match a clearing to its auth and post the settled amount**

```python
def apply_clearing(store, auth_id, cleared_amount_minor):
    """Settle a clearing against its original authorization hold.

    The auth placed a HOLD for the authorized amount; the clearing is the
    real debit for `cleared_amount_minor`, which may be less than, equal
    to, or (within tolerance) more than the hold. We post CLEAR legs for
    the true amount and REVERSE any surplus hold so funds don't stay
    trapped. Idempotent on auth_id: a repeated clearing is a no-op.
    """
    auth = store.get_auth(auth_id)
    if auth is None:
        # Clearing with no matching auth: a force-post. Route to
        # exceptions for manual/rule-based handling, never silently drop.
        store.record_exception("CLEARING_NO_AUTH", auth_id, cleared_amount_minor)
        return
    if store.already_cleared(auth_id):
        return                                   # idempotent replay

    held = auth["approved_amount_minor"]
    with store.transaction():
        # Post the real debit for the cleared amount.
        store.insert_leg(auth_id, "funding_source",              "DEBIT",  cleared_amount_minor, "CLEAR")
        store.insert_leg(auth_id, f"card:{auth['card_token']}",  "CREDIT", cleared_amount_minor, "CLEAR")
        # Release any surplus hold (auth was higher than clearing).
        surplus = held - cleared_amount_minor
        if surplus > 0:
            store.insert_leg(auth_id, "funding_source",             "CREDIT", surplus, "REVERSE")
            store.insert_leg(auth_id, f"card:{auth['card_token']}", "DEBIT",  surplus, "REVERSE")
        store.mark_cleared(auth_id, cleared_amount_minor)
```

**Data structures:** clearings append `CLEAR` (and `REVERSE`) legs to the same `funding_legs` table, keyed by the original `auth_id`, plus a `cleared_amount_minor` and `cleared_at` on the authorization. An `exceptions` table captures clearings with no matching authorization (force-posts) and clearings that exceed tolerance, for out-of-band handling.

**Trade-offs:**
* **The gotcha:** assuming clearing equals authorization double-books money. Restaurants clear higher (tip), fuel and hotels authorize an estimate and clear the real amount, partial shipments clear lower, and some clearings arrive with **no prior authorization** at all (a force-post after network stand-in). Treating clearing as the settlement of the *authorized* amount, rather than a fresh debit, would either trap the surplus hold forever or debit twice. The fix is explicit auth-to-clearing matching that posts the **cleared** amount and reverses the surplus hold, plus a first-class exceptions path for unmatched clearings — reconciliation is a designed subsystem, not an afterthought.
* Keying clearing on the original `auth_id` and making `apply_clearing` idempotent means a redelivered clearing batch is safe to replay, which matters because clearing files are reprocessed on failure.

## Step 4: Scale the design

![Programmable card platform at scale: many developer services behind an auth-gateway; a latency-sharded authorization core keyed by card token backed by a low-latency auth and idempotency store and a cached spend-control policy layer; per-developer circuit breakers and stand-in defaults guarding slow webhooks; an append-only funding ledger; and an off-path batched clearing and reconciliation engine that settles real amounts against holds](/img/case-studies/fintech/programmable-payments-scaled.svg)

* **The authorization core shards by card token so no single coordinator sits on the path of all ~10,000 auth/sec at peak** — see [Sharding](/docs/patterns/storage/sharding). A card's spend state, idempotency claim, and funding legs all key off the card token, so co-locating them on one shard keeps the hot decide-and-fund path free of cross-shard transactions inside the millisecond budget.
* **Every authorization is idempotent on a network reference so repeats and advices never fund twice** — see [Idempotency](/docs/patterns/reliability/idempotency). The same discipline the payment case studies apply to money movement, here applied to a decision: the first request decides and funds, and any network retry carrying the same reference replays the stored decision instead of re-evaluating.
* **Each developer webhook is guarded by a [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) and a hard [Timeout](/docs/patterns/reliability/timeout).** A developer whose endpoint is slow or erroring must not consume the whole network budget: the timeout caps the wait strictly below the network window, and a breaker that trips on a failing endpoint stops calling it and drops straight to the stand-in — failing fast to the program's default instead of burning milliseconds on every transaction.
* **The stand-in default is the [Graceful Degradation](/docs/patterns/reliability/graceful-degradation) of the auth path**: when the developer's code is unavailable, the platform still returns a correct-enough decision (approve-by-default, decline-by-default, or a managed spend-control evaluation) so the network is never left waiting and the program's intent is preserved rather than the network's generic fallback.
* **Spend-control policies are read on every auth and served from a cache with tight invalidation** — see [Cache-Aside](/docs/patterns/caching/cache-aside). Policies change rarely relative to how often they are read, so caching them next to the rule engine keeps evaluation fast, but any control update must invalidate immediately because approving against a stale, looser policy is a correctness failure, not a stale-read annoyance.
* **The synchronous auth webhook is a first-class integration contract** — see [Webhooks](/docs/patterns/communication/webhooks). Unlike a fire-and-forget notification, this webhook is on the critical path and its *response* is the product, so it needs signed payloads, a strict response schema, and monitored latency/error SLOs, with the stand-in as the answer to every failure mode.
* **Clearing and reconciliation run as an off-path batch**: the clearing engine ingests presentment files, matches each to its authorization, posts settled amounts, reverses surplus holds, and reconciles the derived spend counters — decoupling the slow, high-volume settlement leg from the fast real-time authorization the cardholder experiences.

## Additional talking points

* **The two clocks, restated.** The single most important thing to internalize is that authorization and clearing are different events on different clocks with different amounts. Authorization is a real-time hold decided in ~2 seconds; clearing is a batched debit that arrives later for the *final* amount. Every counter, cap, and balance in the system must distinguish "authorized" from "settled," or it will drift. Reconciliation against clearing is what keeps the fast path's approximations honest.
* **Stand-in and network STIP.** There are actually two layers of stand-in. The *processor's* stand-in answers when the developer webhook is late — and the processor must fall back before the *network's* own Stand-In Processing (STIP) kicks in, because once the network times out on the processor it applies its own generic rules and the program loses control of the decision. Designing the processor deadline strictly inside the network window is what keeps the program's chosen default authoritative.
* **PCI-DSS scope containment.** Programmable cards are attractive partly because they keep the developer out of the worst of PCI scope: the PAN is minted and held inside the processor's cardholder-data environment, and the developer's webhook decides on tokens and card ids. A practitioner must still treat the webhook endpoint, its signing secret, and any stored card metadata as security-sensitive, but the full-PAN compliance burden stays with the processor and its BIN-sponsor bank.
* **Idempotency of auth versus clearing.** Both legs need idempotency but for different reasons: the auth leg because the network resends the same authorization (repeat/advice messages) and a second evaluation could fund twice; the clearing leg because presentment files are reprocessed on failure and a redelivered clearing must not double-debit. The two use different keys — a network reference for auth, the original auth id for clearing — but the same rule: decide once, replay thereafter.
* **Fraud, velocity, and partial approvals.** Real spend controls include velocity rules (N transactions per hour, spend per rolling window) and fraud signals, and the network sometimes allows a **partial approval** (approve a lower amount than requested, common at fuel dispensers). The rule engine and the funding leg must both handle "approve for less than requested," which is why the decision carries an `approved_amount` distinct from the requested amount rather than a bare yes/no.
* **Reconciliation as a standing process.** Beyond matching each clearing to its auth, the platform continuously checks that funding legs net to zero per authorization via `auth_is_balanced`, that derived spend counters equal settled spend, and that no hold is left trapped after its clearing or expiry. This is defense-in-depth on top of the real-time exactly-once guard, and it is where slow drift between the fast path and the settled truth is caught.

## Source(s) and further reading

* [Stripe Issuing — Real-time authorizations](https://docs.stripe.com/issuing/controls/real-time-authorizations) — the synchronous `issuing_authorization.request` webhook, the `approved`/`amount` response body, signature verification, the **2-second** decision window, and Autopilot as the stand-in when the webhook is late or errs
* [Stripe Issuing — Authorizations](https://docs.stripe.com/issuing/purchases/authorizations) — the full authorization lifecycle: hold on approval, capture/clearing, void/reversal/expiry, partial and incremental authorizations, and the `webhook_timeout`/`network_fallback` outcomes
* [Stripe Issuing — Balance and funding](https://docs.stripe.com/issuing/funding/balance) — how the Issuing balance funds authorizations and why insufficient funds decline before the webhook fires
* [Marqeta — About Just-in-Time (JIT) Funding](https://www.marqeta.com/docs/developer-guides/about-jit-funding) — Gateway JIT vs Managed JIT, funding at transaction time so accounts need not carry a balance, partial approvals, and Commando Mode as the fallback
* [Marqeta — Configuring Gateway JIT Funding](https://www.marqeta.com/docs/developer-guides/configuring-gateway-jit-funding) — the gateway funding-source model and the approve/deny funding-request contract
* [Marqeta — Managing Timeouts](https://www.marqeta.com/docs/developer-guides/managing-timeouts) — the gateway response budget, the `gateway_log.timed_out` signal, and resolving out-of-sync transactions after a timeout
* [Marqeta — Ledger Management with JIT Funding](https://www.marqeta.com/docs/developer-guides/ledger-management-with-jit-funding) — how JIT-funded balances and ledger movements are tracked
* [Lithic — Authorization Stream Access (ASA)](https://docs.lithic.com/docs/auth-stream-access-asa) — real-time auth webhooks converted to/from ISO 8583, the `result` field, `approved_amount` partial approvals, the 6-second hard decline, the ~3-second recommended budget, and pre-authorization checks
* [ISO 8583 — Wikipedia](https://en.wikipedia.org/wiki/ISO_8583) — the message-type indicators, including the 0100/0110 authorization class (0x1xx), the 0x2xx single-message financial class, and the 0x5xx reconciliation/presentment class that carries clearing in a dual-message system — the classes underlying the auth-versus-clearing distinction
* [Marqeta reference-app (GitHub)](https://github.com/marqeta/reference-app) — a sample webserver implementing the two endpoints required to integrate with Marqeta JIT Funding
* [Idempotency](/docs/patterns/reliability/idempotency) — decide-once, replay-thereafter for both the auth and clearing legs
* [Webhooks](/docs/patterns/communication/webhooks) — the synchronous, on-critical-path webhook whose response is the product
* [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) and [Timeout](/docs/patterns/reliability/timeout) — bounding a slow developer webhook so the network budget is never blown
* [Graceful Degradation](/docs/patterns/reliability/graceful-degradation) — the stand-in default that answers the network when developer code is unavailable
* [Sharding](/docs/patterns/storage/sharding) and [Cache-Aside](/docs/patterns/caching/cache-aside) — partitioning the auth core by card token and serving spend-control policies from an invalidation-tight cache
