---
title: "Design a High-Frequency Trading System"
sidebar_position: 2
---

A high-frequency trading system's defining property is that its correctness budget is spent almost entirely on *time*: the whole machine exists to turn a market-data event into a submitted order in a deterministic, repeatable handful of microseconds or less, because the profit on any single trade is often a fraction of a cent and it only exists for the brief window before the rest of the market reacts. Every other system in this course optimizes throughput or availability and treats latency as something to keep "low enough." Here latency *is* the product, and — just as important — so is *determinism*: a path that averages two microseconds but occasionally spikes to two hundred is worse than one that always takes five, because the spikes are exactly the moments the strategy loses money. The entire design below is organized around one goal: make the tick-to-trade path as short, as jitter-free, and as allocation-free as physically possible, while still passing every order through a mandatory pre-trade risk gate that the law requires and that no amount of speed pressure is allowed to bypass.

This case study designs a system with the shape of a real market-making or arbitrage HFT stack, grounding each component in how these systems are actually built — colocated at the exchange, ingesting binary multicast feeds, maintaining an in-memory limit order book, and speaking the exchange's native order-entry protocol.

## Step 1: Outline use cases and constraints

### Use cases

#### We'll scope the problem to handle the following use cases

* A **feed handler** ingests a raw **market-data multicast feed** from an exchange (for example NASDAQ's binary ITCH protocol), decodes it, and turns it into normalized internal events
* The system maintains an **in-memory limit order book** per traded symbol, updated on every message, ordered by **price-time priority** — the same priority rule the exchange's own matching engine uses
* A **strategy engine** consumes the stream of book updates and decides, in the moment, whether to place, modify, or cancel orders (for example a market maker continuously quoting a bid and an ask to capture the spread)
* Every outbound order passes through a **mandatory pre-trade risk gate** before it can reach the exchange — order-size caps, price sanity, and aggregate-position limits — the control a broker-dealer is required to enforce under SEC Rule 15c3-5, the "market access rule"
* An **order gateway** encodes cleared orders into the exchange's native order-entry protocol (for example NASDAQ's OUCH, or FIX for venues that use it) and submits them, choosing a venue where multiple are available (smart order routing)
* An **order management system (OMS)** tracks the lifecycle of every order (sent, acknowledged, partially filled, filled, cancelled, rejected) and the firm's current positions — but sits *off* the latency-critical path
* A **monitoring stack** captures tick-to-trade latency, queue depths, and component health with nanosecond-precision timestamps, for post-trade analysis and compliance

#### Out of scope

* The exchange's own matching engine internals (how it matches, prices, and clears) — treated as the external counterparty this system trades against, not something designed here
* Clearing and settlement (the T+1 post-trade money movement handled by a clearing house and custodians) — a real and separate system, named only in the talking points
* The economics and math of specific strategies (how a signal is derived, how a spread is priced) — this design concerns the *systems* that execute a strategy fast and safely, not the alpha itself
* Backtesting and research infrastructure — the offline pipeline where strategies are developed, distinct from the live trading path
* Regulatory registration, market-surveillance, and the exchange-side controls that complement the firm's own

### Constraints and assumptions

#### State assumptions

* The system is **colocated** in the exchange's data center — the servers physically sit in a cage feet away from the matching engine, because at these speeds the propagation delay of light over fiber is a material cost, and a competitor a few meters closer has a real edge
* Market data arrives as **UDP multicast**, not a request-response API — the exchange pushes every book event to every subscriber simultaneously, and the feed handler must keep up with the full message rate at all times, because there is no backpressure to the exchange and a dropped or lagged message means an incorrect book
* The tick-to-trade hot path must be **deterministic and allocation-free**: no heap allocation, no garbage collection, no locks, no system calls, and no disk or database access on the path from "market event arrived" to "order submitted"
* The pre-trade risk checks are **non-negotiable and always in-line** — they are a legal requirement, and even under maximum speed pressure an order that fails a check must be blocked *before* it reaches the exchange, not logged after the fact
* Availability matters, but it is a different kind of availability than a consumer system's: the failure mode to fear most is not "the service is briefly down" but "the service submitted a wrong or runaway order," so many risk controls are biased toward *stopping trading* on anomaly rather than continuing
* Wall-clock time is disciplined by a **PTP (Precision Time Protocol) grandmaster clock** so every event and every internal stage is timestamped to nanosecond resolution and to a common reference, which is what makes latency measurable and sequences reconstructable

#### Calculate usage

* Market-data rate: a busy US equity feed can burst to **millions of messages per second** across all symbols. Even at a sustained few million messages/sec, the feed handler has on the order of **hundreds of nanoseconds per message** of budget to decode and apply an update — which is why decode is hand-written against the binary layout, not a general parser, and why the book is a specialized in-memory structure rather than a database.
* Tick-to-trade budget: the competitive target for a software path is on the order of **single-digit microseconds** from the market-data packet arriving at the NIC to the order packet leaving it; FPGA "in-silicon" paths push the decisive slice into the **hundreds of nanoseconds**. The design's job is to spend that budget on decision-making, not on plumbing overhead (kernel network stack, allocation, locking) that can be engineered away.
* Wire latency: within a colocation facility, one-way network latency to the matching engine is on the order of **single-digit microseconds**, and shaving even fractions of a microsecond off it (via kernel bypass, tuned NICs, or FPGA) is worthwhile — which is the entire economic reason colocation exists.
* Order rate: a market maker quoting hundreds of symbols, each with a bid and an ask it constantly re-prices, can generate **tens to hundreds of thousands of order actions per second** (new orders, modifies, cancels) at peak; the great majority are cancels and re-quotes, not fills — cancel/replace traffic dominates.
* Risk-check cost: each pre-trade check is a handful of bounded integer comparisons against in-memory limits — call it **a few hundred nanoseconds total** — a deliberately fixed, tiny, and jitter-free cost, because a risk gate that occasionally stalls would itself become a source of the latency spikes the whole design fights.
* Timestamp precision: at nanosecond resolution, two events one microsecond apart are a thousand ticks apart — enough granularity to order every internal stage and to reconcile the firm's view of the book against the exchange's, which is why the clock discipline (PTP) is treated as core infrastructure, not an afterthought.

## Step 2: Create a high-level design

![Tick-to-trade path inside a colocated HFT stack: exchange multicast feed into a kernel-bypass feed handler, into an in-memory price-time-priority order book, into a strategy engine, through a mandatory pre-trade risk gate, out through an order gateway speaking OUCH or FIX back to the exchange matching engine, with the OMS and monitoring off the hot path](/img/case-studies/fintech/high-frequency-trading-overview.svg)

The pipeline is a straight line, and keeping it a straight line is the point. The **exchange** pushes market data as a binary **multicast** stream. A **feed handler**, reading directly from an ultra-low-latency NIC using **kernel bypass** (a mechanism such as DPDK or Solarflare's Onload that lets the application read packets from user space without going through the operating-system network stack), decodes the exchange's binary protocol into normalized internal events. Those events update an **in-memory limit order book** per symbol, kept in **price-time priority** so the firm's view of the market mirrors what the matching engine sees. Each book change is handed — over a **lock-free ring buffer**, not a locked queue — to the **strategy engine**, which decides whether to act. If it decides to send an order, that order goes through the **pre-trade risk gate**, and only if it clears does the **order gateway** encode it into the exchange's order-entry protocol and submit it. Fills and acknowledgements flow back and are recorded by the **OMS**, while a **monitoring** stack timestamps every stage.

Two structural facts make this different from every other system in this course. First, **the hot path deliberately avoids the tools most systems reach for**: no database on the path (the book lives in memory), no locks (stages communicate through lock-free ring buffers so a thread is never blocked waiting on another), no allocation or garbage collection (which is precisely why hot-path HFT code is written in C++, Rust, or straight onto an FPGA rather than a garbage-collected language — an unpredictable GC pause is exactly the multi-microsecond jitter the design exists to eliminate), and no kernel network stack (bypassed to save microseconds of per-packet overhead). Second, **the one thing that is never optimized away is the risk gate** — everything else on the path is subordinated to speed, but the mandatory pre-trade checks stay in-line on every order, because the cost of skipping them (a runaway algorithm firing thousands of erroneous orders in the milliseconds before a human can react) is catastrophic and legally prohibited. The design below builds up each of these stages and then shows how the platform scales by sharding symbols across colocated hosts while keeping the control plane off the hot path.

## Step 3: Design core components

### Use case: The in-memory limit order book with price-time priority

The order book is the heart of the system: a live, in-memory representation of every resting buy and sell order at every price, ordered so that the *best* prices and the *earliest* arrivals are matched first. This is [price-time priority](https://en.wikipedia.org/wiki/Order_matching_system) — the same rule the exchange's own matching engine applies — and the firm maintains its own copy so its strategy reasons about the same market state the exchange will act on. It lives entirely in memory because a database round-trip would blow the entire tick-to-trade budget many times over.

**Core spec: a price-time-priority book and how a marketable order crosses it**

```python
import heapq
import itertools
from dataclasses import dataclass

@dataclass
class Order:
    order_id: int
    side: str          # 'buy' or 'sell'
    price: int         # integer ticks (e.g. price in cents), never float
    qty: int
    seq: int           # monotonic arrival sequence -> enforces time priority

@dataclass
class Fill:
    taker_id: int
    maker_id: int
    price: int
    qty: int

class OrderBook:
    """Price-time-priority limit order book.

    Bids are ordered highest-price-first; asks lowest-price-first. Within a
    single price level the earliest arrival (smallest seq) has priority. A
    marketable incoming order walks the opposite side, filling against the
    best resting orders until it is exhausted or no price-compatible maker
    remains. Prices are integer ticks, never floats, so no rounding error can
    misprice a match.
    """
    def __init__(self):
        # Heaps hold (sort_key, seq, order_id). Bids negate price for max-first.
        self._bids = []                     # [(-price, seq, order_id)]
        self._asks = []                     # [( price, seq, order_id)]
        self._orders = {}                   # order_id -> resting Order
        self._seq = itertools.count()

    def _best_ask(self):
        while self._asks:
            _, _, oid = self._asks[0]
            if oid in self._orders:         # skip lazily-cancelled entries
                return self._orders[oid]
            heapq.heappop(self._asks)
        return None

    def _best_bid(self):
        while self._bids:
            _, _, oid = self._bids[0]
            if oid in self._orders:
                return self._orders[oid]
            heapq.heappop(self._bids)
        return None

    def _rest(self, order):
        self._orders[order.order_id] = order
        if order.side == "buy":
            heapq.heappush(self._bids, (-order.price, order.seq, order.order_id))
        else:
            heapq.heappush(self._asks, (order.price, order.seq, order.order_id))

    def submit(self, order_id, side, price, qty):
        incoming = Order(order_id, side, price, qty, next(self._seq))
        fills = []
        if side == "buy":
            # Cross while our bid meets or exceeds the best resting ask.
            while incoming.qty > 0:
                best = self._best_ask()
                if best is None or best.price > incoming.price:
                    break
                traded = min(incoming.qty, best.qty)
                fills.append(Fill(incoming.order_id, best.order_id, best.price, traded))
                incoming.qty -= traded
                best.qty -= traded
                if best.qty == 0:
                    del self._orders[best.order_id]
                    heapq.heappop(self._asks)
        else:
            while incoming.qty > 0:
                best = self._best_bid()
                if best is None or best.price < incoming.price:
                    break
                traded = min(incoming.qty, best.qty)
                fills.append(Fill(incoming.order_id, best.order_id, best.price, traded))
                incoming.qty -= traded
                best.qty -= traded
                if best.qty == 0:
                    del self._orders[best.order_id]
                    heapq.heappop(self._bids)
        if incoming.qty > 0:                # unfilled remainder rests
            self._rest(incoming)
        return fills

    def cancel(self, order_id):
        # Lazy cancel: drop from the index; the stale heap entry is skipped
        # when it next surfaces at the top. Cancels dominate HFT order flow,
        # so making them O(1) here rather than an O(n) heap removal matters.
        return self._orders.pop(order_id, None) is not None
```

**Data structures:** two priority structures per symbol — bids (max-price-first) and asks (min-price-first) — plus an `order_id`-keyed index for O(1) cancel. Real HFT books go further than these heaps: they use intrusive doubly-linked FIFO queues per price level with a flat array or map of price levels, so that inserting at a known price, cancelling a known order, and reading the best level are all O(1) with cache-friendly, allocation-free memory layout. The heap version above is the faithful, runnable illustration of the *priority rule*; production replaces the heaps with those flat, pre-allocated structures to kill both allocation and pointer-chasing.

**Trade-offs:**
* **The gotcha:** representing prices as floating-point numbers. Money and prices are integers (ticks, or cents) throughout, because floating point will eventually turn a price comparison or a partial fill into an off-by-a-fraction error, and at a match a fraction-of-a-cent discrepancy is a real mispricing, not a rounding footnote. The fix is that every price and quantity is an integer, and every comparison is exact integer comparison — the same discipline the payment and UPI case studies apply to money, applied here to prices.
* The book must be updated from the feed *in the exact sequence the exchange sent*, because it is a state machine over an ordered stream: applying message N+1 before N produces a book that silently disagrees with the exchange's. This is why the feed carries sequence numbers and why the ingestion path (next) is built around gap detection, not just raw speed.

### Use case: Ingesting the market-data multicast feed with kernel bypass

Market data does not arrive over a friendly websocket. The exchange multicasts a binary stream — for example NASDAQ's [TotalView-ITCH](https://www.nasdaqtrader.com/content/technicalsupport/specifications/dataproducts/NQTVITCHspecification.pdf) protocol, where every add, execute, cancel, and delete is a compact fixed-layout binary message — and the feed handler must decode millions of these per second while never falling behind, because there is no way to ask the exchange to slow down. Two techniques make this possible: **kernel bypass** (reading packets directly from the NIC in user space via a framework like [DPDK](https://www.dpdk.org/) or a vendor stack like Solarflare Onload, skipping the operating system's network stack and its per-packet overhead), and **busy-polling** (a core that spins reading the NIC rather than sleeping and being woken by an interrupt, trading a burned CPU core for the elimination of interrupt and scheduler latency).

**Core spec: decode-and-apply loop with sequence-gap detection**

```python
import struct

# ITCH-style messages are fixed-layout binary. This models the two that move
# the book: an Add Order and an Order Executed. Real ITCH has ~20 message
# types; the decode discipline -- fixed offsets, big-endian, no allocation of
# throwaway objects in the hot loop -- is identical across all of them.

def decode_message(buf, offset):
    """Decode one ITCH-style message from a packet buffer at `offset`.

    Returns (kind, fields, next_offset). Uses struct.unpack_from against a
    known binary layout rather than a general-purpose parser: at millions of
    messages/sec the decode itself must be a handful of pointer reads, not an
    object graph. Big-endian ('>') matches exchange network byte order.
    """
    msg_type = buf[offset:offset + 1]
    if msg_type == b"A":       # Add Order: type, seq(8), order_ref(8), side(1), qty(4), price(4)
        seq, ref, side, qty, price = struct.unpack_from(">Q Q c I I", buf, offset + 1)
        return ("add", (seq, ref, side.decode(), qty, price), offset + 26)
    if msg_type == b"E":       # Order Executed: type, seq(8), order_ref(8), exec_qty(4)
        seq, ref, exec_qty = struct.unpack_from(">Q Q I", buf, offset + 1)
        return ("exec", (seq, ref, exec_qty), offset + 21)
    raise ValueError(f"unknown ITCH message type {msg_type!r}")


def feed_handler_loop(packet_source, book, on_gap):
    """Busy-poll the NIC, decode each message, apply to the book in order.

    `packet_source.poll()` returns the next available packet buffer (from a
    kernel-bypass ring) or None if none is ready -- we spin rather than block.
    Sequence numbers are contiguous per feed; a jump means a dropped multicast
    packet, and the book is now UNTRUSTWORTHY until recovered, so we surface
    the gap rather than applying messages onto a corrupt book.
    """
    expected_seq = None
    while True:
        buf = packet_source.poll()
        if buf is None:
            continue                        # busy-poll: no packet yet, spin
        off = 0
        while off < len(buf):
            kind, fields, off = decode_message(buf, off)
            seq = fields[0]
            if expected_seq is not None and seq != expected_seq:
                on_gap(expected_seq, seq)   # trigger recovery / B-line failover
                expected_seq = seq          # resync to observed
            expected_seq = seq + 1
            apply_to_book(kind, fields, book)


def apply_to_book(kind, fields, book):
    if kind == "add":
        _seq, ref, side, qty, price = fields
        side_word = "buy" if side == "B" else "sell"
        # An ITCH "Add Order" is an order the exchange has ALREADY placed on
        # its book -- it never crosses (marketable flow surfaces later as
        # "Order Executed" messages against resting orders). We reuse submit()
        # for the price-time-priority insert; on a real ITCH stream the add is
        # non-marketable, so it always rests rather than crossing here.
        book.submit(ref, side_word, price, qty)
    elif kind == "exec":
        _seq, ref, exec_qty = fields
        # An execution reduces a resting order; if fully executed, it leaves.
        resting = book._orders.get(ref)
        if resting is not None:
            resting.qty -= exec_qty
            if resting.qty <= 0:
                book.cancel(ref)
```

**Data structures:** a **lock-free ring buffer** between the NIC-polling stage and the book-update stage, so the packet reader never blocks on the book writer. The ring is a pre-allocated array with a power-of-two capacity (so index wrap is a bitmask, not a modulo) and separate producer/consumer sequence counters — the mechanical core of the [LMAX Disruptor](https://lmax-exchange.github.io/disruptor/disruptor.html) design, which showed that a single well-laid-out ring buffer outperforms lock-based queues by orders of magnitude precisely because it eliminates lock contention and keeps the hot data in cache.

```python
class SpscRing:
    """Single-producer / single-consumer bounded ring buffer.

    Capacity is a power of two so index wrap is a bitmask. In production the
    two sequence counters are cache-line padded so the producer and consumer
    never contend on the same cache line (false sharing), and the buffer is
    pre-allocated so publishing an event allocates nothing.
    """
    def __init__(self, capacity_pow2):
        assert capacity_pow2 & (capacity_pow2 - 1) == 0, "capacity must be power of two"
        self._buf = [None] * capacity_pow2
        self._mask = capacity_pow2 - 1
        self._head = 0                       # next write slot (producer owns)
        self._tail = 0                       # next read slot (consumer owns)

    def try_publish(self, item):
        if self._head - self._tail == len(self._buf):
            return False                     # full: producer applies backpressure
        self._buf[self._head & self._mask] = item
        self._head += 1                      # single store publishes the slot
        return True

    def try_consume(self):
        if self._head == self._tail:
            return None                      # empty
        item = self._buf[self._tail & self._mask]
        self._tail += 1
        return item
```

**Trade-offs:**
* **The gotcha:** treating a dropped multicast packet as a performance problem when it is really a *correctness* problem. UDP multicast has no retransmission, so a lost packet means the book is now missing an update and silently disagrees with the exchange — and trading on a wrong book loses money confidently. The real fix is defense in depth: exchanges publish **two redundant feed lines (an A and a B feed)** so the handler can fill a gap on one from the other, plus a separate recovery/snapshot channel to rebuild the book after a larger gap. The sequence-number check above is what *detects* the gap; the A/B arbitration and snapshot recovery are what *repair* it, and until repaired the strategy must stop acting on that symbol.
* Kernel bypass and busy-polling trade CPU and power for latency: a busy-polling core runs at 100% forever doing nothing but reading the NIC. That is an acceptable trade here because the burned core buys the elimination of interrupt latency and scheduler jitter — but it is exactly the wrong trade for a general server, which is why this technique is specific to latency-critical systems and not a default.

### Use case: The strategy loop reacts to book changes

The strategy engine is where the trading decision is made. It consumes normalized book updates off the ring buffer and, for each one, decides whether the current market state warrants placing, re-pricing, or pulling orders. A market-making strategy, for instance, continuously quotes a bid slightly below and an ask slightly above the mid-price to capture the spread, and re-prices those quotes as the book moves and as its own inventory (net position) changes — widening or pulling quotes when it is holding too much risk. The systems constraint that dominates this component is not the sophistication of the logic but its **predictability**: the code runs on a core pinned so the operating-system scheduler never migrates it, on NUMA-local memory so every access hits the nearest memory bank, and it never allocates, so there is no garbage collector to pause it mid-decision.

**Core spec: a spread-quoting decision as a pure, allocation-free function**

```python
from dataclasses import dataclass

@dataclass
class Quote:
    bid_price: int
    ask_price: int
    size: int

def make_quotes(best_bid, best_ask, net_position, params):
    """Given the top of book and current inventory, return the bid/ask this
    market maker wants resting. Pure and allocation-free on the hot path:
    a few integer operations, no I/O, no locks, deterministic timing.

    Inventory skew: when we are long (net_position > 0) we shade both quotes
    down to encourage selling and discourage buying more, and vice versa,
    so the strategy actively manages risk instead of accumulating position.
    All prices are integer ticks.
    """
    mid = (best_bid + best_ask) // 2
    half_spread = max(params["min_half_spread_ticks"],
                      (best_ask - best_bid) // 2)
    # Skew is proportional to how far inventory is from flat, capped.
    skew = max(-params["max_skew_ticks"],
               min(params["max_skew_ticks"],
                   -net_position // params["skew_divisor"]))
    return Quote(bid_price=mid - half_spread + skew,
                 ask_price=mid + half_spread + skew,
                 size=params["quote_size"])
```

**Data structures:** the strategy's own compact, in-memory state — its current resting quotes, its net position (as a signed integer, kept in sync from OMS fills), and its parameters — all pre-allocated and updated in place, never rebuilt. The heavy, authoritative position and order records live in the OMS off the hot path; the strategy keeps only the small, fast-access copy it needs to decide.

**Trade-offs:**
* **The gotcha:** reaching for a garbage-collected, allocating language (or even careless allocation in a non-GC language) on this path. An allocation that triggers a garbage-collection pause introduces a multi-hundred-microsecond stall at an unpredictable moment — which is not just slow, it is *non-deterministic*, and it will happen during exactly the volatile burst when the strategy most needs to act. The fix is the discipline the whole hot path shares: write it in C++ or Rust (or push it into an FPGA), pre-allocate everything, and keep the per-event work to a bounded, branch-predictable set of integer operations so the latency distribution has a tight tail, not just a low average.
* Some firms push the most latency-sensitive slice of this logic — a simple, fully deterministic tick-to-trade rule — onto an **FPGA**, a reconfigurable chip that evaluates the incoming market event and emits an order in hardware, in hundreds of nanoseconds, before a CPU thread could even be scheduled. The trade-off is stark: FPGA logic (written in Verilog or VHDL) is far harder to develop and change than software, so firms reserve it for the few, stable, decisive paths and keep richer, evolving logic in software.

### Use case: The mandatory pre-trade risk gate

Before any order the strategy produces can reach the exchange, it passes through a pre-trade risk gate — and unlike everything else on this path, this component is not optional and cannot be optimized away. In the United States, [SEC Rule 15c3-5](https://www.ecfr.gov/current/title-17/chapter-II/part-240/subject-group-ECFRc8b5f3c2f4c88d1/section-240.15c3-5), the "market access rule," requires a broker-dealer providing market access to enforce risk-management controls — including limits that prevent the entry of orders exceeding preset capital or credit thresholds and that reject erroneous orders — *before* those orders route to an exchange. The purpose is to prevent a buggy or runaway algorithm from firing a flood of erroneous orders in the milliseconds before any human notices — the exact failure mode behind real market-disruption incidents.

**Core spec: the in-line risk gate**

```python
from dataclasses import dataclass

@dataclass
class RiskLimits:
    max_order_qty: int          # single-order fat-finger ceiling
    max_order_notional: int     # price*qty ceiling, in cents
    max_position: int           # net signed position ceiling (absolute)
    max_open_notional: int      # aggregate resting exposure ceiling, in cents

@dataclass
class RiskState:
    net_position: int = 0       # signed: +long, -short, in shares
    open_notional: int = 0      # sum of resting order notional, in cents

class RejectedOrder(Exception):
    pass

def pretrade_check(order_side, price, qty, limits, state):
    """Mandatory pre-trade risk gate, in-line ahead of the wire.

    Every check is a bounded integer comparison -- no allocation, no I/O, no
    lock -- so it adds a fixed, few-hundred-nanosecond, jitter-free cost to
    tick-to-trade. A single failed check rejects the order BEFORE it can reach
    the exchange, which is the control SEC Rule 15c3-5 requires the
    broker-dealer to enforce on every order.
    """
    if qty <= 0 or price <= 0:
        raise RejectedOrder("non-positive price or qty")
    notional = price * qty
    if qty > limits.max_order_qty:
        raise RejectedOrder("order qty exceeds per-order cap")
    if notional > limits.max_order_notional:
        raise RejectedOrder("order notional exceeds per-order cap")
    signed = qty if order_side == "buy" else -qty
    projected = state.net_position + signed
    if abs(projected) > limits.max_position:
        raise RejectedOrder("projected net position exceeds cap")
    if state.open_notional + notional > limits.max_open_notional:
        raise RejectedOrder("aggregate open exposure exceeds cap")
    return True
```

**Data structures:** a small, in-memory `RiskLimits` (static, set by the risk desk) and `RiskState` (the live net position and aggregate open exposure, updated from fills and acknowledgements). Both are kept hot and local to the gate so the check never reads from a database or crosses a network hop — a risk gate that added a network round-trip would defeat its own placement on the critical path.

**Trade-offs:**
* **The gotcha:** the tempting "optimization" of running risk checks asynchronously or sampling them to save latency — treating the gate as overhead to minimize rather than a hard barrier. That is precisely the design that lets a runaway algorithm reach the exchange in the window before the async check catches up, and it is what Rule 15c3-5 exists to forbid. The fix is that the gate is *synchronous and in-line on every order*, and it is engineered to be cheap and deterministic (bounded integer comparisons, all state in local memory) so that "always check" costs only a few hundred nanoseconds — the design makes the mandatory thing fast rather than making the fast thing skip the mandatory thing.
* A related control is the **kill switch**: a firm-level ability to instantly cancel all resting orders and stop new order entry when monitoring detects anomalous behavior. This complements the per-order gate — the gate stops individual bad orders, the kill switch stops a whole misbehaving strategy — and both bias the system toward *halting* over *continuing* when something looks wrong, the opposite of most systems' availability instinct.

### Use case: Encoding and submitting the order over the exchange protocol

Once an order clears risk, the order gateway encodes it into the exchange's native **order-entry protocol** and submits it. Where the market-data feed is a firehose the exchange pushes (ITCH), order entry is a request-response session the firm initiates — for NASDAQ that is [OUCH](https://www.nasdaqtrader.com/content/technicalsupport/specifications/TradingProducts/OUCH5.0.pdf), a lean binary protocol built for exactly this, and many other venues use [FIX](https://www.fixtrading.org/standards/) (often in a compact binary encoding, since text FIX is too slow for the hot path). The gateway also handles **smart order routing** when multiple venues are available: choosing where to send based on displayed liquidity, expected fill probability, latency to the venue, and fee/rebate structure.

**Core spec: a binary order-entry message (OUCH-style Enter Order)**

```python
import struct

def encode_enter_order(token, side, qty, symbol, price, time_in_force):
    """Encode an OUCH-style 'Enter Order' as a fixed-layout binary message.

    Fixed offsets, big-endian, fixed-width fields -- a binary order protocol,
    not text FIX, because encoding must be a handful of memory writes, not
    string formatting. `token` is a client-assigned order id the exchange
    echoes back on every ack/fill, which is how the OMS ties an execution to
    the order it came from.

    Layout (illustrative, OUCH-shaped):
      type(1)='O' | order_token(14) | side(1) | qty(4) | symbol(8) |
      price(4, in ticks) | time_in_force(4)
    """
    if side not in (b"B", b"S"):
        raise ValueError("side must be b'B' or b'S'")
    token_field = token.encode().ljust(14, b" ")[:14]
    symbol_field = symbol.encode().ljust(8, b" ")[:8]
    return struct.pack(
        ">c 14s c I 8s I I",
        b"O", token_field, side, qty, symbol_field, price, time_in_force,
    )

def decode_order_ack(buf):
    """Decode the exchange's accept for an order we sent, keyed by our token.
    Layout: type(1)='A' | order_token(14) | exchange_order_id(8) | ts_ns(8)
    """
    _type, token, exch_id, ts_ns = struct.unpack_from(">c 14s Q Q", buf, 0)
    return {"order_token": token.decode().strip(),
            "exchange_order_id": exch_id,
            "exchange_ts_ns": ts_ns}
```

**Data structures:** a per-session outbound sequence and a map from the client-assigned `order_token` to the internal order record, so that when an acknowledgement, fill, or reject comes back keyed by that token, the OMS can attribute it to the right order and update position. The token is the join key between the fast submission path and the OMS's authoritative record.

**Trade-offs:**
* **The gotcha:** using human-readable text FIX on the hot path because it is the well-known standard. Tag-value text FIX requires string parsing and formatting on every message, which is far too slow at HFT rates — so the hot path uses a binary order protocol (OUCH, or a binary FIX encoding such as [FAST](https://www.fixtrading.org/standards/fast/) or FIX SBE) with fixed-width fields decoded at fixed offsets. FIX still earns its place as the *interoperability* standard for connecting to the many venues that speak it; it is just encoded compactly rather than as text where latency rules.
* Smart order routing adds decision latency to a place where latency is scarce, so it is kept as lean as the strategy: the routing choice is a small, table-driven computation over pre-fetched venue state, not a live poll of every exchange at order time — the venue picture is maintained continuously off to the side and consulted in constant time when an order is ready to send.

### Use case: The OMS tracks order lifecycle and position off the hot path

Every order the gateway sends generates a stream of responses — accepted, partially filled, filled, cancelled, rejected — and something must keep the authoritative record of what is resting, what has traded, and what the firm's resulting position is. That is the **order management system**, and the key design decision is that it lives *off* the tick-to-trade path. The hot path submits an order and moves on; the OMS consumes the acknowledgements and fills asynchronously, updates the durable order and position records, and feeds a compact position summary back to the strategy and risk gate. Putting the OMS on the hot path would drag its bookkeeping and durability costs into the microsecond budget, so it is deliberately decoupled — the same "keep the heavyweight write off the latency-critical path" instinct, applied to a system where the latency budget is thousands of times tighter than usual.

**Data structures:** durable `orders` (client `order_token`, exchange order id, symbol, side, price, qty, `status`, timestamps) and `positions` (per symbol, net signed quantity and average price), updated from the fill/ack stream. Because these are off the hot path, they can use ordinary durable storage and normal consistency machinery; their job is to be the correct, auditable, queryable record, not to be microsecond-fast.

**Trade-offs:**
* **The gotcha:** letting the strategy's fast, local copy of its position drift from the OMS's authoritative record. The strategy keeps a lightweight net-position counter so it can skew quotes without a round-trip, but fills arrive asynchronously and the local copy can momentarily lag. The fix is that the OMS is the single source of truth and continuously reconciles the local copy back to it, and the risk gate's `max_position` check is enforced against a conservative view — so a brief lag can only ever make the strategy *more* cautious (quote less, reject sooner), never less, which is the safe direction to be wrong in.
* The OMS is also where **post-trade** obligations begin: it holds the auditable record that feeds compliance reporting and, downstream, the clearing and settlement process (the T+1 money-and-securities movement handled by a clearing house), both of which are deliberately out of scope here but hang off the OMS's records rather than the hot path.

## Step 4: Scale the design

![Scaled HFT platform: redundant multicast feeds arbitrated into symbol-sharded feed handlers, each with its own in-memory book, strategy, and per-shard pre-trade risk gate on pinned cores, an FPGA fast path, a PTP grandmaster clock timestamping every shard, order gateways speaking OUCH or FIX to the exchange, and an asynchronous control plane holding the OMS, monitoring, and audit log off the hot path](/img/case-studies/fintech/high-frequency-trading-scaled.svg)

* **The platform shards by symbol, not by request, so each symbol's book and strategy own a dedicated pinned core.** A single machine cannot keep the full market's book on one core within budget, so symbols are partitioned across cores and hosts; because a strategy decision for one symbol reads only that symbol's book, the shards are independent and share nothing on the hot path — the [Sharding](/docs/patterns/storage/sharding) idea applied with the shard key being the traded instrument. Scaling here is [vertical first](/docs/patterns/scaling/vertical-scaling) — the fastest CPU, the best NIC, the shortest cable — because within one symbol there is nothing to parallelize; you scale *out* only by adding independent symbol shards, not by splitting one symbol's path across cores.
* **Stages communicate through lock-free ring buffers, following the [LMAX Disruptor](https://martinfowler.com/articles/lmax.html) mechanical-sympathy design**, so the feed handler, strategy, and gateway hand work between each other with no locks and no allocation, keeping the hot data resident in cache. This is the same producer-consumer decoupling the [Backpressure](/docs/patterns/batch-streaming/backpressure) pattern describes, but implemented for nanosecond hand-offs rather than distributed queues: when a downstream stage falls behind, the bounded ring signals it directly rather than allowing unbounded buffering.
* **Market-data ingestion is a [Stream Processing](/docs/patterns/batch-streaming/stream-processing) problem at the extreme end**: an unbounded, ordered, high-rate event stream that must be processed in sequence with strict ordering guarantees. The sequence-number-and-gap discipline is the streaming world's ordered-delivery concern, and the A/B redundant feeds with snapshot recovery are how the pipeline tolerates loss on a transport (UDP multicast) that offers none — a domain-specific take on [Exactly-Once Semantics](/docs/patterns/batch-streaming/exactly-once-semantics) where the goal is an exactly-correct reconstructed book, not an exactly-once side effect.
* **Redundancy is failover-oriented, not load-balanced**: the exchange's dual A/B feeds and hot-standby book replicas mean that if a feed line drops packets or a book host dies, the system fails over to the redundant copy rather than degrading — see [Failover](/docs/patterns/reliability/failover). The distinction from a typical service is that the standby must already be *warm and in sync* (an in-memory replicated book), because there is no time to rebuild state from disk on the hot path.
* **A PTP grandmaster clock disciplines every host to a common nanosecond reference**, which is what makes cross-shard sequencing and latency measurement meaningful — see the [Sequencer](/docs/patterns/building-blocks/sequencer) building block for the general problem of assigning a consistent global order to events, here solved with hardware-timestamped time rather than a logical counter.
* **The OMS, monitoring, and audit log form an asynchronous control plane strictly off the hot path** — see [Distributed Monitoring](/docs/patterns/building-blocks/distributed-monitoring). Tick-to-trade latency histograms, queue depths, and per-component health are captured continuously with the same nanosecond timestamps, feeding the latency dashboards and the kill-switch logic, but every byte of that observability is emitted in a way (a separate ring, a separate core) that cannot add jitter to the trading path it observes.

## Additional talking points

* **The pre-trade risk gate is a legal control, not just an engineering safeguard.** SEC Rule 15c3-5 makes financial and regulatory pre-trade controls mandatory for any broker-dealer with market access, precisely so a runaway or erroneous algorithm cannot flood an exchange before a human can intervene. A practitioner designing on these rails must treat the risk gate as an invariant of the architecture — always in-line, always synchronous — and pair it with a firm-level kill switch, rather than as a latency cost to trim. History has real incidents where inadequate controls let a malfunctioning algorithm submit a torrent of erroneous orders in minutes, which is the concrete disaster these rules exist to prevent.
* **Determinism matters as much as raw speed — optimize the tail, not the average.** A path that averages two microseconds but occasionally spikes to two hundred is worse for a strategy than one that always takes five, because the spikes coincide with volatile moments when acting late is most costly. This is why the design fights *every* source of non-determinism — garbage-collection pauses, lock contention, interrupt latency, scheduler migration, NUMA-remote memory access, cache misses — and why success is measured by the 99th and 99.9th percentile of tick-to-trade latency, not the mean.
* **Why colocation and kernel bypass exist at all.** At these speeds, the propagation delay of light through fiber and the per-packet overhead of a general-purpose operating-system network stack are material costs. Colocation puts the servers meters from the matching engine; kernel bypass removes the OS from the packet path; busy-polling removes interrupt and scheduler latency. Each buys single-digit-microsecond or sub-microsecond improvements that are only worth the enormous engineering and hardware cost because being *first* to react is the entire economic basis of the strategy.
* **The feed is a correctness problem wearing a performance costume.** The most consequential failure in market-data ingestion is not being slow but being *wrong*: a silently dropped multicast packet leaves the firm's book disagreeing with the exchange's, and a strategy trading on a wrong book loses money with full confidence. The A/B redundant feeds, sequence-gap detection, and snapshot-based recovery are the real defenses, and the correct behavior on an unrecoverable gap is to *stop trading that symbol* until the book is rebuilt.
* **Where money movement actually happens — clearing and settlement — is deliberately downstream.** The hot path only *submits and matches* orders; the actual transfer of securities and cash happens later through a clearing house on a T+1 (trade date plus one business day) cycle, entirely off this system's critical path. The OMS's auditable records are the bridge to that post-trade world, which keeps the latency-critical trading system decoupled from the slower, correctness-and-reconciliation-driven settlement system — a separation of concerns worth naming even though settlement is out of scope here.

## Source(s) and further reading

* [NASDAQ TotalView-ITCH specification (PDF)](https://www.nasdaqtrader.com/content/technicalsupport/specifications/dataproducts/NQTVITCHspecification.pdf) — the real binary market-data protocol this design's feed handler decodes: fixed-layout add/execute/cancel/delete messages, exactly the shape modeled in Step 3
* [NASDAQ OUCH order-entry specification (PDF)](https://www.nasdaqtrader.com/content/technicalsupport/specifications/TradingProducts/OUCH5.0.pdf) — the lean binary order-entry protocol behind this design's order gateway, including the client order token used to tie fills back to orders
* [FIX Trading Community — standards](https://www.fixtrading.org/standards/) and [FAST (FIX Adapted for STreaming)](https://www.fixtrading.org/standards/fast/) — the interoperability standard for order entry across venues, and its compact binary encoding used where text FIX is too slow
* [SEC Rule 15c3-5 (Risk Management Controls for Brokers or Dealers with Market Access), eCFR](https://www.ecfr.gov/current/title-17/chapter-II/part-240/subject-group-ECFRc8b5f3c2f4c88d1/section-240.15c3-5) — the market-access rule that makes this design's mandatory, in-line pre-trade risk gate a legal requirement, not just good practice
* [LMAX Disruptor — technical paper](https://lmax-exchange.github.io/disruptor/disruptor.html) and [Martin Fowler's LMAX Architecture article](https://martinfowler.com/articles/lmax.html) — the lock-free ring-buffer design this system uses to hand events between stages without locks or allocation, and the mechanical-sympathy reasoning behind it
* [Order matching system — Wikipedia](https://en.wikipedia.org/wiki/Order_matching_system) and [Central limit order book — Wikipedia](https://en.wikipedia.org/wiki/Central_limit_order_book) — the price-time-priority matching rule this design's in-memory order book implements
* [DPDK (Data Plane Development Kit)](https://www.dpdk.org/) and its [architecture overview](https://doc.dpdk.org/guides/prog_guide/overview.html) — a real user-space, kernel-bypass packet-processing framework of the kind this design's feed handler relies on
* [High-frequency trading — Wikipedia](https://en.wikipedia.org/wiki/High-frequency_trading), [Colocation centre — Wikipedia](https://en.wikipedia.org/wiki/Colocation_centre), and [Precision Time Protocol — Wikipedia](https://en.wikipedia.org/wiki/Precision_Time_Protocol) — consolidated references for the strategy context, the colocation edge, and the nanosecond clock discipline this design assumes
* [Sharding](/docs/patterns/storage/sharding), [Vertical Scaling](/docs/patterns/scaling/vertical-scaling), [Stream Processing](/docs/patterns/batch-streaming/stream-processing), [Backpressure](/docs/patterns/batch-streaming/backpressure), [Failover](/docs/patterns/reliability/failover), [Sequencer](/docs/patterns/building-blocks/sequencer), and [Distributed Monitoring](/docs/patterns/building-blocks/distributed-monitoring) — the internal patterns this design applies to shard by symbol, scale the hot path, process the feed stream, isolate faults, order events in time, and observe latency off the critical path
