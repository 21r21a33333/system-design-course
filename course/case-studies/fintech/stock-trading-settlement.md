---
title: "Design a Stock Trading & Settlement System"
sidebar_position: 9
---

A stock-trading system has two clocks running at once, and its defining property is the gap between them. The investor-facing clock is measured in milliseconds: tap "buy," and within a heartbeat an order is validated, routed, matched against a resting sell order, and reported back as "filled." But the money and the shares have not actually moved yet. The second clock runs for a full business day — the trade must be **cleared** (a central counterparty steps between the two sides, guarantees both, and nets the day's activity down) and then **settled** (the depository moves the shares against the cash in a single atomic step) on a **T+1** cycle, meaning one business day after the trade. The hard part of this design is not the fast matching engine that everyone pictures; it is making the slow post-trade pipeline correct, netted, guaranteed against a defaulting counterparty, and reconcilable to the cent, so that the "filled" the investor saw in a millisecond becomes a share they actually own a day later.

This case study designs a system with the shape of the US equities market — retail broker, smart order routing, exchange matching, and the NSCC/DTC clearing-and-settlement stack — grounding each component in how the real pipeline works.

## Step 1: Outline use cases and constraints

### Use cases

#### We'll scope the problem to handle the following use cases

* An **investor** places a **limit buy order** (for example, 100 shares of a stock at a price limit of 150.00) through a **broker** app, and the broker validates it against the account's buying power and trading permissions before it goes anywhere
* The broker performs **order routing** — a **smart order router** decides whether to send the order to a **market maker / wholesaler** (often compensated via **payment for order flow**) or to a **public exchange**, under a legal **best-execution** obligation to the investor
* An **exchange matching engine** maintains a **limit order book** and matches the order against resting orders by strict **price-time priority**, producing an **execution** (a fill) reported back through the exchange, the broker, and the app
* Every execution is submitted to a **central counterparty (CCP)** — in US equities, the **NSCC** — which **novates** the trade (interposing itself as buyer to every seller and seller to every buyer), guarantees completion, and computes each member's **multilateral net** obligation rather than settling every trade gross
* The trade **settles** on **T+1** via the depository (**DTC**): a **book-entry** transfer of the securities against the cash, executed as **delivery versus payment (DVP)** so neither leg can happen without the other
* The investor's ownership is recorded as a **book entry** — shares are held in **street name** at the depository under its nominee (**Cede and Co**), and the broker's sub-ledger records that this specific investor is the beneficial owner
* The system keeps a durable, reconcilable record at every layer, so a broker's client positions, the CCP's net obligations, and the depository's book-entry balances all agree at end of day

#### Out of scope

* The internal microstructure of a high-frequency market maker's own strategy engine (covered by this course's separate high-frequency-trading case study) — treated here only as a venue the router can send to
* Options, futures, and fixed-income clearing (which run through related but distinct CCPs such as OCC and FICC) — this study designs the cash-equities path
* Corporate actions (dividends, splits, proxy voting) that ride on top of the custody layer — named in talking points only
* Cross-border settlement and multi-currency FX legs — the design assumes a single-currency (USD) domestic market
* Market-data licensing, regulatory reporting (CAT), and tax-lot accounting beyond a brief mention

### Constraints and assumptions

#### State assumptions

* On the order of **hundreds of millions of order messages per day** hit the national market system across all venues (new orders, cancels, modifies, and the resulting executions) — the matching layer is genuinely high-throughput and latency-sensitive, unlike the correctness-bound-but-low-volume payment-processor case study elsewhere in this course
* A single logical order must be filled **at most once for its intended quantity** — a retried or redelivered order message must never produce a duplicate execution, and a cancel that races a fill must resolve to exactly one outcome
* **Best execution is a legal obligation**, not a preference: the routing decision must be defensible after the fact (price, speed, and likelihood of execution), which means routing decisions and the quotes they were made against are recorded, not just acted on
* Matching must be **deterministic and fair**: given the same sequence of orders, the book produces the same fills, and priority follows **price first, then time** — this determinism is what makes the market auditable and what lets the engine run as a single-writer, in-memory loop
* Settlement is **T+1** as of the US transition on **May 28, 2024** (Canada and Mexico moved a day earlier, on May 27) — the design must not assume the trade and the money movement happen at the same instant
* The CCP settles **net, not gross**: netting reduces the value of securities and payments that must actually be exchanged by roughly **98% on an average day**, so the settlement engine posts orders of magnitude fewer transfers than there were trades
* Money and shares are represented as **integers** (cents and whole shares, or integer sub-share units where fractional trading is supported) — never floating point — so netting and DVP can never create or destroy value through rounding

#### Calculate usage

* Order message volume: assume **300,000,000 order-book messages/day** (new orders, cancels, modifies, executions across venues) → 300,000,000 / 23,400 seconds in a 6.5-hour US trading session ≈ **~12,800 messages/sec average**, with bursts at the open and close an order of magnitude higher — design the matching path for **~100,000+ messages/sec peak per busy symbol cluster**, which is why the book lives in memory, not a database, on the hot path
* Matching latency budget: an exchange matching engine targets **single-digit to tens of microseconds** of internal matching latency per message; the broker-to-exchange-and-back round trip the investor perceives is dominated by network hops and risk checks, landing in the low **milliseconds** — the internal match is a rounding error next to the human-perceived "instant"
* Execution record size: an execution report (`exec_id`, `order_id`, `symbol`, `side`, `quantity`, `price_cents`, `venue`, `contra_broker`, `exec_time`, small metadata) ≈ **~200 bytes/record**; if 300M messages produce on the order of **50,000,000 executions/day**, that is 50,000,000 × 200 bytes ≈ **~10 GB/day**, **~2.5 TB/year** of execution log — large enough that the trade store shards and tiers to cold storage
* Clearing throughput: those 50M daily executions are submitted to the CCP, but after **multilateral netting** each clearing member ends the day with **one net position per security** (deliver N shares or receive N shares, and one net cash figure), so the number of actual settlement postings is on the order of **members × securities traded**, not trades — the ~98% netting figure is what turns tens of millions of trades into a manageable batch of net obligations
* Settlement cash movement: because only the **net** cash per member moves, a member that bought and sold heavily in the same names might have a net obligation that is a small fraction of its gross traded value — this is the entire economic point of a CCP, and the reason settlement risk is bounded to net exposures rather than gross
* Custody scale: the depository holds securities for essentially the whole market in **book-entry** form under a single nominee, so "moving shares" at settlement is a ledger update, not a physical certificate transfer — the volume constraint is on the ledger's write path during the settlement window, not on any physical logistics

## Step 2: Create a high-level design

![Tap to own: an investor's limit buy flows through the broker to a smart order router, which sends it to a market maker or a public exchange matching engine that matches by price-time priority and prints a fill in milliseconds; every execution is then submitted to a central counterparty (NSCC) that novates and multilaterally nets it, and settles on T+1 via the depository (DTC) as a delivery-versus-payment book-entry transfer, with the investor holding shares in street name under Cede and Co](/img/case-studies/fintech/stock-trading-settlement-overview.svg)

The flow splits cleanly into a **fast real-time leg** and a **slow post-trade leg**, and the whole design hinges on keeping them decoupled.

On the real-time leg, the investor places a limit order in the broker app. The broker's first job is **pre-trade risk**: is the account funded for this buy, is the account permitted to trade this security, does the order pass basic sanity and regulatory checks. Only then does the broker build a standardized order message — in practice a **FIX** new-order-single — and hand it to its **smart order router (SOR)**. The router makes the routing decision the video centers on: **internalize / send to a market maker, or route to a public exchange.** Big broker-dealers and wholesalers run private matching (a crossing engine or dark pool) and pay brokers for their retail flow (**payment for order flow**); public exchanges like Nasdaq or NYSE run open order books. Either way, the broker is bound by **best execution** — the routing choice must serve the investor on price, speed, and likelihood of fill, and it is a regulated, recordable decision, not a coin flip. Wherever the order lands, a **matching engine** slots it into a **limit order book** — bids sorted high-to-low, asks sorted low-to-high — and matches by **price-time priority**: better prices trade first, and among equal prices, the earlier order wins. When a resting sell at or below the buy limit exists, the engine executes a trade, updates the book, and emits an **execution report** that flows back to the exchange, the broker, and the app as "filled."

Here is the part people miss. That fill is a **contract**, not a completed transfer — no shares and no cash have moved. Every execution is submitted to a **central counterparty**. In US equities this is the **National Securities Clearing Corporation (NSCC)**, and it does two structurally critical things. First, **novation**: the NSCC legally interposes itself between the two original parties, becoming the buyer to every seller and the seller to every buyer, so each side now faces the CCP — a guaranteed counterparty backed by a clearing fund — instead of an anonymous stranger who might default. Second, **multilateral netting** via **Continuous Net Settlement (CNS)**: rather than settling all 50 million trades individually, the CCP nets each member down to a single position per security and a single net cash figure, collapsing the day's activity by roughly 98% of value. Those net obligations settle on **T+1** at the depository (**DTC**) as **book-entry** transfers under **delivery versus payment** — the shares move against the cash atomically, so it is impossible for one member to deliver shares and not get paid, or pay and not receive shares. Finally, **custody**: the investor does not receive a paper certificate. The shares sit at the depository in **street name** under its nominee, **Cede and Co**, and it is the broker's own sub-ledger that records which beneficial owner holds what. You own a book entry pointing at a book entry.

The structural bet this design makes is the mirror image of the payment-processor case study: on the matching leg it spends everything on **determinism and latency** (an in-memory, single-writer book), while on the settlement leg it spends everything on **finality, netting, and reconciliation**, accepting a full day of latency in exchange for guaranteed, capital-efficient, exactly-once money-and-share movement.

## Step 3: Design core components

### Use case: Broker validates and builds a routable order

Before any routing or matching, the broker turns a tap in an app into a standardized, risk-checked order. The two jobs here are **pre-trade risk** (never route an order the account cannot afford or is not allowed to place) and **normalization** into the wire format every venue understands — a **FIX new-order-single**. The order also gets a broker-generated **client order id** that will anchor exactly-once handling across retries, cancels, and fills.

**Core spec: pre-trade check plus a FIX new-order-single**

```python
from dataclasses import dataclass

@dataclass
class Order:
    cl_ord_id: str      # broker-generated, unique per logical order (FIX tag 11)
    account_id: str
    symbol: str         # e.g. "TSLA"
    side: str           # "BUY" or "SELL"
    quantity: int       # whole shares
    limit_price_cents: int  # integer cents; 15000 == $150.00
    time_in_force: str  # "DAY", "IOC", ...

def pretrade_check(order: Order, account) -> tuple[bool, str]:
    """Reject before routing anything. A buy must be covered by buying
    power; the account must be permitted to trade the symbol. Returns
    (ok, reason) rather than raising, so the caller records the rejection
    as a normal terminal outcome, not an exception.
    """
    if order.quantity <= 0 or order.limit_price_cents <= 0:
        return False, "INVALID_ORDER"
    if order.symbol not in account.permitted_symbols:
        return False, "SYMBOL_NOT_PERMITTED"
    if order.side == "BUY":
        max_cost_cents = order.quantity * order.limit_price_cents
        if max_cost_cents > account.buying_power_cents:
            return False, "INSUFFICIENT_BUYING_POWER"
    if order.side == "SELL" and account.shares_held(order.symbol) < order.quantity:
        return False, "INSUFFICIENT_SHARES"
    return True, "OK"

def to_fix_new_order_single(order: Order, sender: str, target: str, seq: int) -> str:
    """Build a FIX 4.4 NewOrderSingle (MsgType=D). Fields are tag=value
    pairs joined by SOH (0x01); shown here with '|' for readability only.
    Price is sent as a decimal string derived from integer cents so the
    broker's internal money math never touches a float.
    """
    price = f"{order.limit_price_cents // 100}.{order.limit_price_cents % 100:02d}"
    ord_type = "2"   # 2 = Limit
    side = "1" if order.side == "BUY" else "2"
    tif = {"DAY": "0", "IOC": "3"}[order.time_in_force]
    body = (
        f"35=D|49={sender}|56={target}|34={seq}|"
        f"11={order.cl_ord_id}|55={order.symbol}|54={side}|"
        f"38={order.quantity}|40={ord_type}|44={price}|59={tif}"
    )
    return body
```

**Data structures:** an `orders` row per logical order — `cl_ord_id` (PK), `account_id`, `symbol`, `side`, `quantity`, `limit_price_cents`, `status` (`new`/`routed`/`partially_filled`/`filled`/`cancelled`/`rejected`), `routed_venue`, `created_at`, `updated_at`. Prices and money are integer cents; quantities are integer shares.

**Trade-offs:**
* **The gotcha:** it is tempting to treat the order message as fire-and-forget once it passes risk — but a broker that resends an order after a network timeout, not knowing whether the venue received the first copy, can produce a **duplicate execution** (the investor buys 200 shares when they meant 100). The fix is that the `cl_ord_id` is the exactly-once anchor end to end: it is stable across retries, the venue deduplicates on it, and a cancel or status query references it, so a resend is recognized as the same logical order rather than a new one — the same [Idempotency](/docs/patterns/reliability/idempotency) discipline this course applies to payments, here applied to an order rather than a charge.
* Doing risk **before** normalization, not after, keeps a rejected order from ever occupying a sequence number on a venue session, which keeps the FIX session's monotonic sequence numbering clean for the orders that actually go out.

**REST API:**

```
$ curl -X POST https://broker.example/api/v1/orders \
    -H "Authorization: Bearer <token>" \
    -H "Idempotency-Key: cl-8f3a1c90-tsla-buy-44210" \
    -d '{
          "symbol": "TSLA",
          "side": "BUY",
          "quantity": 100,
          "limit_price_cents": 15000,
          "time_in_force": "DAY"
        }'
```

Response:

```json
{
  "cl_ord_id": "cl-8f3a1c90-tsla-buy-44210",
  "status": "routed",
  "routed_venue": "NASDAQ",
  "symbol": "TSLA",
  "side": "BUY",
  "quantity": 100,
  "limit_price_cents": 15000,
  "created_at": "2026-08-12T14:31:07Z"
}
```

### Use case: Smart order router picks a venue under best execution

Once an order is risk-checked, the router decides where it goes. This is a regulated decision: the broker owes the investor **best execution**, weighing price, speed, and likelihood of fill. In practice the choice is between **internalizing** to a market maker / wholesaler (which may pay the broker for the flow, subject to the constraint that the fill can be no worse than the public best quote) and routing to a **public exchange**. The router scores live venues against the **National Best Bid and Offer (NBBO)** and records the decision so it can be justified afterward.

**Core spec: venue scoring against the NBBO**

```python
from dataclasses import dataclass

@dataclass
class VenueQuote:
    venue: str
    bid_cents: int         # best price a buyer at this venue will pay
    ask_cents: int         # best price a seller at this venue will accept
    displayed_size: int    # shares available at that price
    is_internalizer: bool  # market maker / wholesaler vs public exchange
    pfof_rebate_cents: int # rebate the broker would receive (per share)

def national_best(quotes: list[VenueQuote]) -> tuple[int, int]:
    """The NBBO: the highest bid and lowest ask across all venues.
    A buy can never be filled worse (higher) than the national best ask.
    """
    best_bid = max(q.bid_cents for q in quotes)
    best_ask = min(q.ask_cents for q in quotes)
    return best_bid, best_ask

def route(order, quotes: list[VenueQuote]) -> tuple[str, str]:
    """Choose a venue under a best-execution rule. For a marketable BUY,
    only venues quoting at the national best ask are eligible; among those,
    prefer more displayed size (higher fill likelihood), and use the PFOF
    rebate only as a tie-breaker -- never to justify a worse price.
    Returns (venue, rationale) so the decision is auditable.
    """
    _, best_ask = national_best(quotes)
    if order.side == "BUY":
        if order.limit_price_cents < best_ask:
            return "REST_ON_BOOK", "limit below national best ask; post, do not cross"
        eligible = [q for q in quotes if q.ask_cents == best_ask]
    else:
        best_bid, _ = national_best(quotes)
        if order.limit_price_cents > best_bid:
            return "REST_ON_BOOK", "limit above national best bid; post, do not cross"
        eligible = [q for q in quotes if q.bid_cents == best_bid]

    # Best price is fixed at the national best; break ties by fill
    # likelihood first, then rebate. Price is never traded away for rebate.
    eligible.sort(key=lambda q: (q.displayed_size, q.pfof_rebate_cents), reverse=True)
    chosen = eligible[0]
    kind = "internalizer" if chosen.is_internalizer else "exchange"
    return chosen.venue, f"best price at {best_ask}c; chose {kind} by size then rebate"
```

**Data structures:** a `routing_decisions` audit row — `cl_ord_id`, `nbbo_bid_cents`, `nbbo_ask_cents`, `chosen_venue`, `rationale`, `decided_at`. This is what lets the broker demonstrate, after the fact, that the routing served the investor and did not chase a rebate at the customer's expense.

**Trade-offs:**
* **The gotcha:** payment for order flow creates a genuine conflict of interest — a rebate that scales with volume tempts a router toward the venue that pays most, not the one that fills best. The mitigation is baked into the ordering above: eligibility is gated on the **national best price first**, so a worse-priced venue is never even a candidate, and the rebate enters only as a tie-breaker among venues already at the best price. The routing rationale is recorded so a regulator or the broker's own surveillance can check the rule was followed, which is why best-execution reporting (order-routing disclosures) exists at all.
* Internalizing is not inherently worse for the investor — a wholesaler often fills **at or inside** the public quote and faster — but "at least as good as the public quote" is a floor the design must enforce mechanically, not assume.

### Use case: Matching engine matches by price-time priority

The order reaches a venue's **matching engine** — the brain of the exchange. It holds a **limit order book** per symbol: bids on one side (sorted highest price first), asks on the other (sorted lowest price first). A new order either **crosses** existing liquidity (executes immediately against the best resting orders) or **rests** on the book waiting. The rule is **price-time priority**: better prices match first, and among orders at the same price, the one that arrived earlier matches first. This determinism is the whole game — it makes the market fair and auditable, and it lets the engine run as a single-writer, in-memory loop with no locks.

**Core spec: a price-time-priority limit order book**

```python
from collections import deque
from dataclasses import dataclass, field

@dataclass
class BookOrder:
    order_id: str
    side: str          # "BUY" or "SELL"
    price_cents: int
    quantity: int      # remaining shares
    seq: int           # arrival sequence -> encodes time priority

@dataclass
class Fill:
    buy_id: str
    sell_id: str
    price_cents: int
    quantity: int

@dataclass
class OrderBook:
    # price -> FIFO queue of resting orders at that price (time priority)
    bids: dict = field(default_factory=dict)  # buyers
    asks: dict = field(default_factory=dict)  # sellers

    def _best_ask(self):
        return min(self.asks) if self.asks else None

    def _best_bid(self):
        return max(self.bids) if self.bids else None

    def submit(self, order: BookOrder) -> list[Fill]:
        """Match a marketable order against the opposite side by strict
        price-time priority, then rest any remainder. Returns the fills
        produced. Deterministic: the same input sequence always yields
        the same fills, which is what makes the tape auditable.
        """
        fills: list[Fill] = []
        if order.side == "BUY":
            # Cross while there is an ask at or below our limit.
            while order.quantity > 0 and self._best_ask() is not None \
                    and self._best_ask() <= order.price_cents:
                px = self._best_ask()
                queue = self.asks[px]
                resting = queue[0]
                traded = min(order.quantity, resting.quantity)
                # Trade at the RESTING order's price -- the maker set the
                # price first, so price-time priority fills at their level.
                fills.append(Fill(order.order_id, resting.order_id, px, traded))
                order.quantity -= traded
                resting.quantity -= traded
                if resting.quantity == 0:
                    queue.popleft()
                    if not queue:
                        del self.asks[px]
            if order.quantity > 0:
                self.bids.setdefault(order.price_cents, deque()).append(order)
        else:  # SELL, mirror image
            while order.quantity > 0 and self._best_bid() is not None \
                    and self._best_bid() >= order.price_cents:
                px = self._best_bid()
                queue = self.bids[px]
                resting = queue[0]
                traded = min(order.quantity, resting.quantity)
                fills.append(Fill(resting.order_id, order.order_id, px, traded))
                order.quantity -= traded
                resting.quantity -= traded
                if resting.quantity == 0:
                    queue.popleft()
                    if not queue:
                        del self.bids[px]
            if order.quantity > 0:
                self.asks.setdefault(order.price_cents, deque()).append(order)
        return fills
```

Worked example: the book holds a resting sell of 100 shares at 14990 cents (149.90). An investor's buy limit of 100 at 15000 cents arrives. Because the best ask (14990) is at or below the buy limit (15000), the engine crosses immediately and prints a fill of 100 shares **at 14990** — the resting maker's price, since price-time priority fills at the level that was posted first. The buyer pays 100 × 14990 = 1,499,000 cents ($14,990.00), better than their 150.00 limit.

**Data structures:** the book itself is **in memory** on the hot path (dictionaries keyed by price, FIFO queues per price level for time priority). Durably, each event is appended to a sequence-numbered `market_events` log — `seq` (monotonic), `symbol`, `event_type` (`new`/`cancel`/`trade`), `order_id`, `price_cents`, `quantity`, `ts` — which is the authoritative, replayable record the in-memory book is rebuilt from after any restart.

**Trade-offs:**
* **The gotcha:** the fill price. A naive engine that fills at the incoming (aggressor's) limit price overcharges the buyer — the buyer limited at 150.00 but the resting sell was 149.90, and price-time priority means the trade happens at **149.90**, the price the maker posted first. Filling at the taker's limit would silently pocket the difference and break the fairness guarantee the whole market depends on; the engine must fill at the resting order's price.
* Running the book as a **single writer per symbol** (no locks, one thread draining a queue) is what makes it both fast and deterministic — it is the same append-only-log-is-authoritative shape this course's Google Docs case study uses for edit history, applied to a market: the in-memory book is a materialized view of the `market_events` log, and correctness comes from the log's order, not from mutating shared state under contention.

### Use case: CCP novates the trade and computes multilateral net obligations

This is the step the video does not reach and the one practitioners must understand. An execution is a contract between two brokers who do not necessarily trust each other and will not exchange anything for a full day. The **central counterparty (NSCC)** removes that counterparty risk in two moves. **Novation** replaces the original bilateral contract with two new ones, each facing the CCP: the buyer now buys from the CCP, the seller now sells to the CCP. The CCP guarantees both, backed by a **clearing fund** and per-member **margin**. Then **multilateral netting** collapses the day: instead of settling every trade, the CCP sums each member's buys and sells per security into a single net share position and a single net cash figure.

**Core spec: novation plus multilateral netting**

```python
from dataclasses import dataclass
from collections import defaultdict

@dataclass
class Trade:
    exec_id: str
    symbol: str
    buyer_member: str    # clearing member on the buy side
    seller_member: str   # clearing member on the sell side
    quantity: int        # whole shares
    price_cents: int     # integer cents

@dataclass
class NetObligation:
    member: str
    symbol: str
    net_shares: int      # positive = receive shares, negative = deliver shares
    net_cash_cents: int  # positive = receive cash, negative = pay cash

def novate_and_net(trades: list[Trade]) -> list[NetObligation]:
    """Novate every trade to the CCP, then compute each member's net
    share and net cash position per symbol via multilateral netting.

    After novation each member faces only the CCP, so obligations are
    summed per (member, symbol) across ALL counterparties, not netted
    pairwise. The CCP's own book must balance: across all members, net
    shares per symbol sum to zero and net cash sums to zero -- the CCP
    creates and destroys nothing, it only interposes and nets.
    """
    net_shares: dict = defaultdict(int)  # (member, symbol) -> shares
    net_cash: dict = defaultdict(int)    # (member, symbol) -> cents

    for t in trades:
        cash = t.quantity * t.price_cents
        # Buyer: receives shares (+), pays cash (-).
        net_shares[(t.buyer_member, t.symbol)] += t.quantity
        net_cash[(t.buyer_member, t.symbol)] -= cash
        # Seller: delivers shares (-), receives cash (+).
        net_shares[(t.seller_member, t.symbol)] -= t.quantity
        net_cash[(t.seller_member, t.symbol)] += cash

    obligations = [
        NetObligation(member=m, symbol=s,
                      net_shares=net_shares[(m, s)],
                      net_cash_cents=net_cash[(m, s)])
        for (m, s) in net_shares
    ]
    return obligations

def ccp_book_balances(obligations: list[NetObligation]) -> bool:
    """CCP invariant: for each symbol, net shares across all members sum
    to zero, and net cash across all members sums to zero. If either is
    non-zero the netting is broken -- halt and reconcile, do not settle.
    """
    share_sum: dict = defaultdict(int)
    cash_sum = 0
    for o in obligations:
        share_sum[o.symbol] += o.net_shares
        cash_sum += o.net_cash_cents
    shares_ok = all(v == 0 for v in share_sum.values())
    return shares_ok and cash_sum == 0
```

Worked example (integer shares and cents). Three clearing members trade one symbol in a day:

* Member A buys 500 from B at 15000, and sells 200 to C at 15100.
* Member B sells 500 to A at 15000, and buys 300 from C at 14900.
* Member C sells 300 to B at 14900, and buys 200 from A at 15100.

Netting per member:

* **A**: shares +500 − 200 = **+300** (receive 300); cash −(500×15000) + (200×15100) = −7,500,000 + 3,020,000 = **−4,480,000** (pay $44,800.00)
* **B**: shares −500 + 300 = **−200** (deliver 200); cash +7,500,000 − (300×14900) = +7,500,000 − 4,470,000 = **+3,030,000** (receive $30,300.00)
* **C**: shares +300 − 200 = **−100**? Recompute: C sells 300 (−300) and buys 200 (+200) = **−100** (deliver 100); cash +(300×14900) − (200×15100) = +4,470,000 − 3,020,000 = **+1,450,000** (receive $14,500.00)

Check the CCP invariant: net shares +300 − 200 − 100 = **0**; net cash −4,480,000 + 3,030,000 + 1,450,000 = **0**. The six original trades collapse to three net share deliveries and three net cash movements, and the CCP's books balance to the cent — settle these nets, not the gross trades.

**Data structures:** a `net_obligations` table keyed by `(clearing_member, symbol, settlement_date)` — `net_shares`, `net_cash_cents`, `status` (`pending`/`settled`/`failed`). Alongside it, per-member **margin** and clearing-fund balances the CCP holds as the financial backing for its guarantee.

**Trade-offs:**
* **The gotcha:** netting concentrates risk even as it reduces settlement volume. Because the CCP guarantees every net obligation, a single member defaulting mid-cycle leaves the CCP owing the other side regardless — so the guarantee is only as good as the **margin and clearing fund** collected in advance. The fix is that novation is inseparable from **risk-based margining**: the CCP sizes each member's margin to cover the loss of closing out that member's positions under stress, which is why "the CCP guarantees the trade" is a capital-and-risk-management claim, not just a bookkeeping one.
* Multilateral netting is why settlement value drops ~98%: a member that bought and sold the same name all day settles only the small residual, dramatically shrinking both the cash that must move and the **settlement risk** exposed at any moment — the reason a CCP exists at all.

### Use case: Settlement transfers shares against cash on T+1 (DVP)

On **T+1**, the net obligations settle at the depository. The defining requirement is **delivery versus payment (DVP)**: the security leg and the cash leg happen **atomically**, so it is impossible to deliver shares without receiving cash or to pay cash without receiving shares. The transfer is **book-entry** — no certificates move, only ledger balances at the depository. Modeling this as an explicit state machine keeps a settlement from ever ending in a half-done state.

**Core spec: a DVP settlement state machine**

```python
from enum import Enum

class SettleState(str, Enum):
    PENDING = "PENDING"                 # net obligation known, T+1 not reached
    SHARES_EARMARKED = "SHARES_EARMARKED"  # deliverer's shares locked at depository
    CASH_EARMARKED = "CASH_EARMARKED"      # payer's cash locked
    SETTLED = "SETTLED"                 # both legs posted atomically -> final
    FAILED = "FAILED"                   # a leg could not be met -> fail process

def settle_dvp(obligation, depository, cash_agent) -> SettleState:
    """Settle one net obligation as delivery versus payment. Both legs
    are staged, then committed in a SINGLE atomic step; if either stage
    cannot be met the whole settlement fails cleanly and nothing moves.
    No path leaves shares moved but cash not, or vice versa.
    """
    if obligation.net_shares < 0:            # this member must DELIVER shares
        ok = depository.earmark_shares(obligation.member, obligation.symbol,
                                       abs(obligation.net_shares))
        if not ok:
            return depository.mark(obligation, SettleState.FAILED)  # delivery fail
    if obligation.net_cash_cents < 0:        # this member must PAY cash
        ok = cash_agent.earmark_cash(obligation.member, abs(obligation.net_cash_cents))
        if not ok:
            depository.release_earmarks(obligation.member)
            return depository.mark(obligation, SettleState.FAILED)

    # Atomic commit: post the share book-entry and the cash movement together.
    # In the real system this is the depository's DVP settlement batch, which
    # only finalizes a security leg against a confirmed cash leg.
    with depository.atomic() as txn:
        txn.post_share_transfer(obligation.member, obligation.symbol,
                                obligation.net_shares)   # signed: +receive / -deliver
        txn.post_cash_transfer(obligation.member,
                               obligation.net_cash_cents) # signed: +receive / -pay
    return depository.mark(obligation, SettleState.SETTLED)
```

State transitions in words:

* `PENDING` → (T+1 reached, shares locked) → `SHARES_EARMARKED`
* `SHARES_EARMARKED` → (cash locked) → `CASH_EARMARKED`
* `CASH_EARMARKED` → (atomic post of both legs) → `SETTLED` (final)
* any earmark leg unmet → `FAILED` → enters the fail-management process (buy-in / retry next cycle), never leaves one leg posted alone

**Data structures:** a `settlement_instructions` row per net obligation — `member`, `symbol`, `settlement_date`, `net_shares`, `net_cash_cents`, `state` (the enum above), `finalized_at`. The state column is the durable record that a settlement is atomic and never partially applied.

**Trade-offs:**
* **The gotcha:** settling the two legs independently — move the shares, then move the cash — reintroduces exactly the **settlement risk** (principal risk) that DVP exists to eliminate: a crash between the legs could deliver shares and never collect payment. The fix is that the security and cash legs commit in one atomic step (the depository only finalizes the share transfer against a confirmed cash transfer), so the terminal state is always both-or-neither. This mirrors the debit-then-credit reversal discipline in this course's UPI and payment-processor studies: a money movement that can leave one leg done and the other undone is a bug, not an edge case.
* Compressing settlement from T+2 to **T+1** shrinks the window in which unsettled trades sit exposed to a counterparty default, reducing systemic risk — but it also shrinks the time available to fix errors and fund accounts, which is why the industry effort to shorten the cycle was as much about operational readiness as about the rule change itself.

### Use case: Custody records ownership as a book entry in street name

The investor never holds a certificate. The depository holds the security in **book-entry** form under a single nominee, **Cede and Co**, and ownership flows down a chain: the depository's ledger says the broker (a participant) holds N shares, and the broker's **sub-ledger** says this specific investor is the beneficial owner of some of those. This is **street name** registration. The design's job is a clean two-level book-entry ledger where the broker's client positions always tie out to the broker's position at the depository.

**Core spec: a book-entry custody ledger**

```sql
-- Level 1: what the DEPOSITORY records -- each participant (broker) holds
-- a position in the omnibus account under the nominee (Cede and Co).
CREATE TABLE depository_positions (
    participant_id  VARCHAR(16)  NOT NULL,   -- the broker, a DTC participant
    symbol          VARCHAR(12)  NOT NULL,
    shares          BIGINT       NOT NULL,    -- whole shares held in street name
    PRIMARY KEY (participant_id, symbol)
);

-- Level 2: what the BROKER records -- which beneficial owner holds how many
-- of the broker's depository shares. Sum of client positions per symbol must
-- equal the broker's depository_positions.shares for that symbol.
CREATE TABLE client_positions (
    account_id      VARCHAR(24)  NOT NULL,
    participant_id  VARCHAR(16)  NOT NULL,   -- the broker holding at the depository
    symbol          VARCHAR(12)  NOT NULL,
    shares          BIGINT       NOT NULL,    -- beneficial ownership, whole shares
    PRIMARY KEY (account_id, symbol)
);

-- Supports the daily tie-out: sum a broker's client positions per symbol and
-- compare to its depository_positions row. A separate CREATE INDEX (rather
-- than an inline table constraint) is the portable, standard-SQL form.
CREATE INDEX idx_broker_symbol
    ON client_positions (participant_id, symbol);
```

```python
def custody_ties_out(depository_positions, client_positions, participant_id, symbol) -> bool:
    """Custody invariant: the sum of a broker's client beneficial positions
    in a symbol must exactly equal the broker's own position at the
    depository. If they diverge, the broker's books claim ownership the
    depository does not back -- a break to investigate, never to paper over.
    """
    broker_at_depository = depository_positions[(participant_id, symbol)]
    client_total = sum(
        p["shares"] for p in client_positions
        if p["participant_id"] == participant_id and p["symbol"] == symbol
    )
    return broker_at_depository == client_total
```

**Data structures:** the two tables above are the durable custody core; `idx_broker_symbol` supports the daily tie-out that reconciles the broker's client sub-ledger against its depository position. When settlement posts, the depository updates `depository_positions` and the broker updates the buyer's `client_positions` in the same reconciled batch.

**Trade-offs:**
* **The gotcha:** because ownership is a chain of book entries (investor → broker sub-ledger → depository omnibus under Cede and Co), the broker's records and the depository's records can silently drift — a bug that credits a client without a matching depository position makes the broker's books claim shares that are not actually held in street name for it. The fix is the daily **tie-out** (`custody_ties_out`): the sum of beneficial positions must equal the depository position, and a break halts and is investigated, not overwritten. This is the custody-layer analogue of the double-entry reconciliation invariant in this course's payment-processor study.
* Street-name custody is what makes trading fast and cheap (no certificate logistics, instant book-entry transfer at settlement), but it means the investor's direct legal relationship is with the broker, not the issuer — the reason corporate actions and proxy voting flow *down* the intermediary chain rather than directly to the beneficial owner.

## Step 4: Scale the design

![Scaled stock-trading architecture: a broker platform with API gateway, order queue, and pre-trade risk feeds a smart order router; matching venues shard the order book by symbol as an in-memory single-writer engine alongside market makers and dark pools; a market-data feed streams fills back to brokers; the central counterparty novates and runs continuous net settlement with a clearing fund and margin; the central depository settles delivery-versus-payment book-entry transfers on T+1; and a reconciliation layer ties broker sub-ledgers to the CCP net obligation and the depository balances daily](/img/case-studies/fintech/stock-trading-settlement-scaled.svg)

* **The order book shards by symbol so no single engine is on the path of every message** — see [Sharding](/docs/patterns/storage/sharding). Each symbol's book is independent, so it runs as a single-writer, lock-free, in-memory loop; distributing symbols across engines scales matching throughput horizontally while preserving strict price-time determinism within each symbol.
* **The matching engine is a materialized view over an append-only, sequence-numbered event log** — see [Event Sourcing](/docs/patterns/storage/event-sourcing). The in-memory book is fast but volatile; durability and crash recovery come from replaying the `market_events` log, which is also the authoritative audit trail regulators and surveillance replay, so the log — not the in-memory state — is the source of truth.
* **The broker decouples order intake from downstream routing and matching with a durable queue** — see [Distributed Message Queue](/docs/patterns/building-blocks/distributed-message-queue). A burst of orders at the open, or a momentarily slow venue, must not hang the investor's app; buffering intake on a log-structured queue absorbs bursts and lets routing and risk consume at their own pace, exactly the decoupling the video describes.
* **Each venue and each downstream integration gets a [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) and [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff), applied per venue.** One unresponsive exchange or wholesaler must not stall the router; a breaker fails that venue's routing fast and lets the SOR pick another eligible venue, while any retry of an order always carries the same `cl_ord_id` so a resend can never become a duplicate execution. Isolating one venue's failures from the rest is the [Bulkhead](/docs/patterns/reliability/bulkhead) idea applied to venue adapters.
* **Clearing and settlement run as a batched net job off the hot path**, decoupled from real-time matching. The CCP accumulates the day's executions and posts a small number of net obligations rather than settling gross, so the settlement engine's load is bounded by members-times-securities, not by trade count — the same deferred-net-settlement decoupling this course's UPI study relies on to run a real-time experience at national scale.
* **Reconciliation is a standing, strongly-consistent process, not a nightly afterthought** — the broker's client sub-ledger, the CCP's net obligations, and the depository's book-entry balances must tie out, and breaks are surfaced and investigated. Reads that must reflect true settled state (a client's current holdings, a member's net obligation) read the authoritative record rather than a cached approximation, trading a little latency for correctness — see [Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication) for how read-mostly views (positions, market data) scale off replicas while the settlement write path stays authoritative.

## Additional talking points

* **Why "filled" is not "settled," and why that gap is a feature.** The single most misunderstood thing about buying a stock is that the fast "filled" the app shows is a **contract**, not ownership — shares and cash actually change hands on T+1 via the CCP and depository. That decoupling is what lets the market run a millisecond-latency matching experience while settling on a netted, guaranteed, capital-efficient daily cycle. A practitioner must design the trade record to be correct and reconcilable *before* settlement has run, not assume trade and transfer are simultaneous.
* **The central counterparty is a risk system, not a router.** Novation plus multilateral netting is what removes counterparty risk from the market: each side faces a guaranteed CCP instead of an anonymous stranger, and the day's gross activity nets down ~98% before any money moves. But the guarantee is backed by **margin and a clearing fund**, sized to survive a member default — so the CCP's real engineering is risk-based margining and default management, and netting is as much about shrinking settlement risk as about shrinking settlement volume.
* **Best execution and the PFOF conflict of interest.** Routing is a legal duty to the investor, and payment for order flow sits in tension with it. The design must gate venue eligibility on the **national best price first** and treat any rebate strictly as a tie-breaker, recording the routing rationale so the duty is demonstrable — order-routing disclosure rules exist precisely because the conflict is real and must be surveilled, not assumed away.
* **T+1 shortened the risk window but tightened operations.** Moving from T+2 to T+1 (US effective May 28, 2024) halves the time unsettled trades sit exposed to a default, cutting systemic risk — but it compresses the time to fund accounts, resolve breaks, and process fails, so the transition was as much an operational-readiness program (allocations, affirmations, funding, and reconciliation all a day faster) as a rule change.
* **Custody is a chain of book entries, and its integrity is a daily tie-out.** You own a book entry at your broker, which owns a book entry at the depository under Cede and Co — street name registration. The correctness of that chain rests on reconciliation: the broker's beneficial positions must sum exactly to its depository position, and a break is a serious event. This is where corporate actions, proxy voting, and beneficial-owner reporting all attach, flowing down the intermediary chain rather than directly to the issuer.
* **Fail management and buy-ins.** Not every settlement completes on time — a member may fail to deliver shares. The system needs an explicit fail process (the obligation rolls, and a **buy-in** can force delivery), which is why the settlement state machine models `FAILED` as a first-class terminal state feeding a defined process, not as an exception that silently disappears.

## Source(s) and further reading

* [T+1 settlement cycle — Wikipedia](https://en.wikipedia.org/wiki/T%2B1) — the shortened settlement cycle, the US transition date (May 28, 2024), and which markets adopted it alongside Canada and Mexico
* [Shortening the Securities Transaction Settlement Cycle — Federal Register (SEC final rule)](https://www.federalregister.gov/documents/2023/03/06/2023-03566/shortening-the-securities-transaction-settlement-cycle) — the SEC rulemaking (amending Rule 15c6-1) that moved US securities to T+1
* [SEC Rule 15c6-1 — Electronic Code of Federal Regulations, 17 CFR 240.15c6-1](https://www.ecfr.gov/current/title-17/chapter-II/part-240/subject-group-ECFR6f2ddbaf07b6efe/section-240.15c6-1) — the live regulatory text setting the standard settlement cycle
* [National Securities Clearing Corporation — Wikipedia](https://en.wikipedia.org/wiki/National_Securities_Clearing_Corporation) — the US equities CCP: central counterparty services, the guarantee of completion, and the ~98% netting figure this design's clearing calculation reflects
* [Central counterparty clearing — Wikipedia](https://en.wikipedia.org/wiki/Central_counterparty_clearing) — novation, the CCP guarantee, and margin/default-fund backing behind the clearing use case
* [Novation — Wikipedia](https://en.wikipedia.org/wiki/Novation) — the legal substitution by which the CCP becomes buyer to every seller and seller to every buyer
* [Delivery versus payment — Wikipedia](https://en.wikipedia.org/wiki/Delivery_versus_payment) — the atomic security-versus-cash mechanism behind this design's settlement state machine
* [The Depository Trust Company — Wikipedia](https://en.wikipedia.org/wiki/Depository_Trust_Company) — book-entry custody at the depository and the omnibus-account model behind the custody ledger
* [Cede and Company — Wikipedia](https://en.wikipedia.org/wiki/Cede_and_Company) — the depository nominee that holds securities in street name, the top of the custody chain
* [Street name securities — Wikipedia](https://en.wikipedia.org/wiki/Street_name_securities) — how beneficial ownership is recorded down the broker-and-depository intermediary chain
* [Order matching system — Wikipedia](https://en.wikipedia.org/wiki/Order_matching_system) — the limit order book and price-time priority the matching engine implements
* [Best execution — Wikipedia](https://en.wikipedia.org/wiki/Best_execution) — the broker's routing obligation to the investor on price, speed, and likelihood of fill
* [Payment for order flow — Wikipedia](https://en.wikipedia.org/wiki/Payment_for_order_flow) — the wholesaler-broker rebate model and its conflict-of-interest tension with best execution
* [FIX Trading Community — standards](https://www.fixtrading.org/standards/) — the FIX protocol behind the new-order-single wire format in the broker use case
* [Idempotency](/docs/patterns/reliability/idempotency) — the exactly-once discipline the broker applies to each `cl_ord_id`
* [Event Sourcing](/docs/patterns/storage/event-sourcing) — the append-only market-event log the in-memory order book is a materialized view of
* [Sharding](/docs/patterns/storage/sharding) — partitioning the order book by symbol to scale matching past a single engine
* [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) and [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff) — per-venue fault isolation on the router's venue adapters
