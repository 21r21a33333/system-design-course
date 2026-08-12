---
title: "FPGA in HFT Systems"
sidebar_position: 6
---

An FPGA-based trading system's defining property is not raw speed in the abstract sense — it is **deterministic, jitter-free nanosecond latency** on the path from a market-data packet arriving to an order packet leaving. A general-purpose CPU can be *fast on average*, but its latency is a distribution with a long tail: an interrupt, a context switch, a cache miss, a TLB miss, a branch mispredict, or the kernel network stack can each add microseconds at unpredictable moments, and in high-frequency trading the *worst-case* response — the tick that happens to land during a garbage-collection pause or a scheduler preemption — is exactly the one that loses the trade. An FPGA removes the operating system and the von Neumann fetch-decode-execute loop from the hot path entirely: the trading logic is not *software running on* a chip, it *is* the chip, wired as a fixed dataflow pipeline where a packet flows through parse → book-update → strategy → risk → order-emit in a bounded, repeatable number of clock cycles every single time. This case study designs a system with that shape, grounding each component in how production FPGA trading stacks (AMD/Xilinx Alveo, Intel/Altera, and the specialist NIC vendors) actually work.

A note the rest of this document depends on: the "code" shown here is a **behavioral model**, not deployable firmware. Real fast-path logic is written in Verilog/VHDL (register-transfer level, "RTL") or in a high-level-synthesis (HLS) subset of C++, then synthesized to a bitstream. The Python and HLS-style pseudocode below exist to make the *pipeline structure and the arithmetic* legible to a software reader; they describe the hardware's behavior, they are not the artifact that runs on the FPGA. Every place that distinction matters, it is called out explicitly.

## Step 1: Outline use cases and constraints

### Use cases

#### We'll scope the problem to handle the following use cases

* An **exchange** streams raw **market data** (a UDP multicast feed such as an ITCH-style order-by-order feed) into the trading firm's network, and the system must **parse it in hardware** — Ethernet, IP, UDP, and the exchange's market-data protocol — with no kernel network stack in the path
* The system maintains an **order book** (the live set of resting bids and asks per instrument) by applying each incoming add/modify/delete/execute message, entirely on-chip
* A **strategy** evaluates each book update and decides, within nanoseconds, whether a **tradeable signal** exists (a price crosses a threshold, a spread opens, an imbalance appears)
* When the strategy fires, the system builds an **order message** in the exchange's order-entry protocol (an OUCH-style or FIX/binary format), computes the required checksums, and emits it onto the wire — the whole path from inbound packet to outbound packet is the **tick-to-trade** latency
* Every outbound order passes through **pre-trade risk checks in hardware** (fat-finger price bands, per-instrument size caps, kill-switch state, aggregate exposure) *before* it is allowed onto the wire — this is both a regulatory requirement and a firm-survival requirement
* The system runs as a **hybrid**: the FPGA owns the latency-critical fast path, while a **CPU/software** component owns everything that is complex, changes often, or is not latency-critical (strategy parameter updates, slow-path order types, position bookkeeping, logging, monitoring)
* The system captures a **timestamped audit trail** of every message in and every order out, for post-trade analysis and regulatory reconstruction, without adding latency to the fast path

#### Out of scope

* The trading *strategy's* alpha — what makes a signal profitable — which is the firm's proprietary edge, not a systems-design concern
* Exchange-side matching-engine internals (how the exchange itself pairs orders) — treated as the external counterparty this system talks to
* Colocation, cross-connects, and the physics of the wire (microwave vs fiber between venues) — real latency factors, but network/facilities engineering, not the on-chip design here
* The full FPGA toolchain flow (synthesis, place-and-route, timing closure) beyond what is needed to explain the RTL-vs-HLS trade-off
* Settlement, clearing, and post-trade lifecycle — a separate system entirely (see the payments and settlement case studies in this course)

### Constraints and assumptions

#### State assumptions

* **Latency is the product.** The design target is a **tick-to-trade** measured in *tens to a few hundred nanoseconds*, and — more importantly — a *tight* latency distribution: the p99.99 must be close to the median, because the tail is what actually gets arbitraged away by faster competitors. Determinism is a first-class requirement, not just low average latency.
* Market-data feeds arrive at **line rate on 10/25/100 GbE** links and can **microburst** — thousands of messages back-to-back with no gap — so the parser and book-builder must sustain worst-case message rate without buffering-induced jitter or drops.
* A dropped or reordered market-data packet corrupts the book; the feed handler must handle **gap detection and A/B feed arbitration** (exchanges publish two identical feeds precisely so a receiver can fill gaps from the other).
* The fast path is **fixed-function**: it does exactly what its bitstream encodes and nothing else. Anything requiring a decision the hardware wasn't built for must fall back to the CPU, accepting that fallback's higher latency.
* **Correctness of the risk layer is non-negotiable.** A fast path that can emit an order violating a size cap or a price band is worse than a slow one — an unchecked runaway can bankrupt a firm in milliseconds, so risk gating sits *inline*, in hardware, on the mandatory path to the wire.
* Hardware is **hard and slow to change.** A logic change means re-synthesizing and re-timing a bitstream (minutes to hours of compile, plus validation), not editing a script and restarting — this cost is why not everything is on the FPGA.

#### Calculate usage

* **Message rate:** a busy US equity feed can deliver on the order of **tens of millions of market-data messages per second** at peak across the consolidated tape, and single-venue order-by-order feeds routinely burst into the **millions of messages/sec**. At 10 million msgs/sec, that is a message every **100 ns** on average — and in a microburst, back-to-back at line rate. The parser cannot afford per-message software overhead measured in microseconds; at those rates a 1 µs/message handler falls behind by orders of magnitude.
* **Latency budget:** allocate the tick-to-trade budget across the pipeline stages. A representative on-chip breakdown: **MAC/PHY + parse ≈ tens of ns**, **book update ≈ tens of ns**, **strategy + risk ≈ tens of ns**, **order build + checksum + emit ≈ tens of ns** — summing to a whole-path figure that leading published FPGA stacks put in the **low hundreds of nanoseconds**, versus **~10–50 µs** for a well-tuned software (kernel-bypass) path. That is roughly a **100×** gap, which is the entire reason the fast path is in hardware.
* **Transceiver floor:** the wire-to-logic serial transceiver is itself part of the budget. Current purpose-built trading FPGAs push transceiver latency to **single-digit nanoseconds** (AMD's Alveo UL3524 advertises roughly **~3 ns** transceiver latency), so even the silicon I/O is co-designed for this workload.
* **Clock and pipelining:** an FPGA fabric clocked at, say, **300–400 MHz** has a clock period of **~2.5–3.3 ns**. A pipeline that is, e.g., 30 stages deep still emits one result per clock once full, so throughput is one message per cycle (**hundreds of millions of messages/sec**) even though any single message's *latency* is 30 cycles ≈ tens of ns. Parallelism plus pipelining is what buys both.
* **Book size:** a firm typically trades a bounded universe — hundreds to a few thousand instruments — each with a bounded price-level depth (often only the top N levels matter for the strategy). Keeping the hot book in on-chip block RAM (single-cycle access) rather than external DRAM (tens of ns + nondeterminism) is a deliberate choice, and it is feasible precisely because the working set is small.
* **Audit volume:** timestamping and mirroring every inbound message and outbound order to a capture path is high-bandwidth (potentially GB/sec of packet capture) but is a *parallel tap*, not inline — it must never sit on the tick-to-trade path.

## Step 2: Create a high-level design

![FPGA HFT fast path: exchange market-data feed enters the FPGA through the MAC and PHY, is parsed by a hardware feed handler, updates an on-chip order book, is evaluated by strategy logic, passes an inline pre-trade risk gate, and is emitted as an order; a CPU host runs slow-path software over PCIe, and a capture tap records an audit trail](/img/case-studies/fintech/fpga-in-hft-overview.svg)

The system is a **hybrid**: one FPGA carrying the entire latency-critical dataflow, and a host **CPU running software** for everything else, connected over PCIe. Follow a single market-data packet through it.

A UDP multicast packet from the exchange arrives on the physical link and hits the FPGA's **PHY and MAC** — the serial transceiver and Ethernet media-access logic, in hardware. There is no NIC-then-kernel-then-userspace hop; the bytes enter the fabric directly. The **feed handler** parses the frame inline as it streams in: it strips Ethernet, IP, and UDP headers, recognizes the exchange's market-data protocol, checks the sequence number for gaps (arbitrating the A/B feeds if one has dropped), and extracts the structured fields of each message (instrument, side, price, size, message type). Crucially this is *streaming* parsing — the FPGA begins acting on the front of the packet while its tail is still arriving on the wire ("cut-through"), which is impossible in a store-and-then-process software model.

Each parsed message flows into the **order-book engine**, which applies the update to the on-chip book held in block RAM: an add inserts a resting order at a price level, an execute or cancel removes or reduces one, and the engine keeps the best bid and offer immediately available. The updated book (or just the changed top-of-book) feeds the **strategy** logic, a fixed circuit that evaluates the firm's trading condition every cycle and asserts a "fire" signal with a target price and size when the condition is met. A fire does not go straight to the wire: it passes through the **pre-trade risk gate**, an inline hardware block that checks the proposed order against price bands, size limits, and a kill-switch, and either passes it or blocks it. Only a risk-approved order reaches the **order-entry builder**, which formats the exchange's order protocol, computes the UDP/IP and any protocol checksums in hardware, and drives the bytes back out through the MAC and PHY onto the wire. The elapsed time from the inbound packet's first byte to the outbound packet's first byte is the **tick-to-trade**.

Running alongside, over PCIe, is the **host CPU and its software**. It never sits on the fast path. It configures the FPGA (loads risk limits and strategy parameters into on-chip registers), handles order types and market conditions too complex or too rare to justify hardware, maintains authoritative position and P&L bookkeeping, and consumes the **capture/audit tap** — a parallel copy of every inbound message and outbound order, hardware-timestamped, streamed off-chip for logging, monitoring, and regulatory reconstruction. The structural bet is the inverse of most systems in this course: instead of pushing work off a hot path into asynchronous background workers to *scale throughput*, this design pushes work off the CPU into fixed hardware to *eliminate latency variance* — the fast path is deliberately rigid and does exactly one thing with no room for a scheduler, an allocator, or an OS to intervene.

## Step 3: Design core components

### Use case: FPGA vs CPU — parallel dataflow instead of a fetch-decode-execute loop

Before any specific pipeline stage, it is worth making precise *why* the hardware wins, because the whole architecture follows from it. A CPU is a [von Neumann machine](https://en.wikipedia.org/wiki/Von_Neumann_architecture): it fetches instructions from memory and executes them one stream at a time on a fixed set of ALUs, time-sharing that hardware across every task via the operating system. That sharing is the source of both its flexibility and its jitter — the same instant your market-data handler wants the core, the kernel might service a timer interrupt, the scheduler might preempt for another thread, or the needed data might not be in L1 cache and must be fetched from L3 or DRAM (tens to hundreds of nanoseconds, unpredictably). An FPGA is not a processor at all; it is a fabric of [lookup tables](https://en.wikipedia.org/wiki/Lookup_table) (LUTs), flip-flops, block RAM, and DSP slices that you wire into a *custom circuit*. There is no instruction stream and no OS. Each pipeline stage is physical logic that does its job every clock, so latency is counted in a fixed number of clock cycles, not in a probability distribution.

**Core spec: the same logic, as a CPU loop vs a hardware pipeline (behavioral model)**

The point of this pair is contrast, not deployment — the first is what a CPU actually does, the second is a *model* of what the fabric does spatially and in parallel.

```python
# CPU model: one instruction stream, time-shared, jitter-prone.
# Each message is processed to completion before the next begins,
# and any step may stall on a cache miss or be preempted by the OS.
def cpu_hot_loop(messages, book, risk, out_socket):
    for msg in messages:                 # sequential: one at a time
        parsed = parse(msg)              # may miss cache
        book.apply(parsed)               # may miss cache; branchy
        signal = strategy(book)          # branch mispredicts hurt
        if signal.fire:
            order = build_order(signal)
            if risk.check(order):        # all steps share one core
                out_socket.send(order)   # kernel stack: microseconds
        # <-- an interrupt or context switch can land ANYWHERE above,
        #     adding unpredictable microseconds to THIS message only
```

```text
# Hardware model (HLS/RTL-style pseudocode): a spatial pipeline.
# Every stage is its own physical circuit; all stages run EVERY clock
# on DIFFERENT messages at once. Latency = fixed cycle count. No OS.
#
#   msg_in ─▶[ parse ]─▶[ book ]─▶[ strategy ]─▶[ risk ]─▶[ emit ]─▶ order_out
#             stage0     stage1     stage2        stage3    stage4
#
# At clock T the pipeline holds five DIFFERENT messages simultaneously:
#   parse(msg[T]) ; book(msg[T-1]) ; strategy(msg[T-2]) ;
#   risk(msg[T-3]) ; emit(msg[T-4])
# Throughput  = 1 message / clock  (hundreds of millions / sec)
# Latency     = 5 clocks (fixed)   -> tens of ns, identical every time
```

**Data structures:** none are "stored" in the CPU sense — the pipeline's state is the registers *between* stages (the pipeline latches) plus the on-chip book RAM. The circuit's structure encodes the algorithm.

**Trade-offs:**
* **The gotcha:** the intuitive optimization for a CPU — *skip work when you can* (branch out early, cache the common case) — is often the *wrong* instinct in hardware, because a data-dependent branch that sometimes takes 2 cycles and sometimes 40 reintroduces exactly the latency variance the FPGA exists to remove. Fast-path hardware is frequently designed to do the *same fixed work every cycle regardless of input*, trading average-case efficiency for a flat, predictable latency. Determinism beats cleverness here.
* The FPGA's win is not that any single gate is faster than a CPU transistor — a modern CPU clocks 10× higher than FPGA fabric. The win is **spatial parallelism plus no OS**: dozens of stages compute at once, and nothing can preempt them.
* This is why GPUs, despite massive parallelism, do not win tick-to-trade: a GPU is a throughput engine with high per-launch latency and a fixed SIMD pipeline, excellent for batched machine learning but not for reacting to a single packet in nanoseconds.

### Use case: Parse the network stack and market-data feed in hardware

The feed handler is where FPGAs first beat software decisively, because in software the kernel network stack alone — interrupt, driver, protocol processing, socket copy into userspace — costs microseconds and adds jitter, before the application even sees a byte. Kernel-bypass libraries (DPDK, Solarflare/Onload) shrink this but do not eliminate the variance. On an FPGA the Ethernet/IP/UDP/market-data parse happens as the packet streams in off the wire.

**Core spec: streaming market-data parse (behavioral model)**

This models a fixed-layout, order-by-order add message. Real RTL parses the byte-stream as it arrives, one word per clock; the Python models the *result* of that parse and the gap check, not the cycle-by-cycle datapath.

```python
import struct

# Illustrative fixed layout for one "add order" market-data message,
# in the spirit of an ITCH-style order-by-order feed (real feeds define
# exact byte offsets and endianness in their published spec).
ADD_ORDER = struct.Struct(">c I Q c I I")  # type, seq, order_id, side, price, shares

def parse_add_order(raw: bytes):
    msg_type, seq, order_id, side, price, shares = ADD_ORDER.unpack(raw)
    return {
        "type": msg_type.decode(),   # 'A' = add order
        "seq": seq,                  # feed sequence number, for gap detection
        "order_id": order_id,
        "side": side.decode(),       # 'B' bid / 'S' ask
        "price": price,              # integer ticks; NEVER float in a book
        "shares": shares,
    }

class FeedGapDetector:
    """A/B feed arbitration: the exchange sends two identical feeds so a
    receiver can fill a gap on one from the other. In hardware this is a
    tiny state machine comparing sequence numbers at line rate."""
    def __init__(self):
        self.expected = 1

    def check(self, seq: int):
        if seq == self.expected:
            self.expected += 1
            return "in_order"
        if seq < self.expected:
            return "duplicate"     # already applied (e.g. from the other feed)
        return "gap"               # missing messages -> request/await recovery
```

**Data structures:** a per-feed `expected_sequence` counter (a single hardware register) and the fixed field-offset map baked into the parser circuit. There is no dynamic allocation — message layouts are fixed-width, which is *why* they can be parsed in hardware at line rate.

**Trade-offs:**
* **The gotcha:** market-data feeds carry prices as integers (ticks or fixed-point), never floating point, and a book must too — but a naive software port that reads a price into a `double` for convenience introduces rounding that can make two economically-identical prices compare unequal, corrupting price-level matching. The hardware has no FPU on the fast path anyway; integer/fixed-point is both faster and *correct*, and the software reference must match it exactly.
* Gap handling is mandatory, not optional: silently applying an out-of-order or missing message corrupts the book, and a corrupted book produces confidently-wrong trades. The A/B arbitration state machine is small but load-bearing.
* Streaming (cut-through) parse is the structural advantage — the FPGA acts on a packet's header while its payload is still arriving — and it is exactly what a store-and-process software model cannot do.

### Use case: Build the order book on-chip

The order book is the live, per-instrument set of resting bids and asks. Every market-data message mutates it, and the strategy reads it every cycle, so it must be **single-cycle-access** memory — which means on-chip block RAM, not external DRAM whose access latency (tens of ns) and nondeterminism would blow the budget. The engineering trick is that only a bounded slice of the book matters: for most strategies, the top few price levels per instrument, for a bounded instrument universe.

**Core spec: top-of-book maintenance (behavioral model)**

```python
class OrderBook:
    """Behavioral model of the on-chip book for ONE instrument. In RTL
    this is block-RAM-backed with the best bid/ask kept in registers so
    they are readable in a single clock; here it's plain dicts to show
    the update semantics, not the hardware layout."""
    def __init__(self):
        self.bids = {}   # price(int ticks) -> total resting shares
        self.asks = {}

    def apply(self, m):
        side = self.bids if m["side"] == "B" else self.asks
        if m["type"] == "A":                       # add
            side[m["price"]] = side.get(m["price"], 0) + m["shares"]
        elif m["type"] in ("E", "C", "D"):         # execute / cancel / delete
            if m["price"] in side:
                side[m["price"]] -= m["shares"]
                if side[m["price"]] <= 0:
                    del side[m["price"]]

    def best_bid(self):
        return max(self.bids) if self.bids else None   # highest price a buyer will pay

    def best_ask(self):
        return min(self.asks) if self.asks else None    # lowest price a seller will accept

    def spread(self):
        bb, ba = self.best_bid(), self.best_ask()
        return (ba - bb) if (bb is not None and ba is not None) else None
```

**Data structures:** per-instrument price-level arrays in block RAM (price is the index or a small hash), plus best-bid and best-ask held in dedicated registers so the strategy reads top-of-book in one cycle. The instrument universe and per-instrument depth are both bounded and known at synthesis time — that bound is what lets the whole hot book fit on-chip.

**Trade-offs:**
* **The gotcha:** software order books lean on dynamic data structures (balanced trees, hash maps that grow) that are natural in a language runtime but disastrous in hardware — you cannot `malloc` a tree node mid-pipeline. The hardware book is a *fixed-size* structure sized for the worst case at compile time; if the book depth exceeds that bound, the design must degrade gracefully (drop deep levels, or fall back to the CPU) rather than stall. Bounding the problem is the whole game.
* Keeping only top-of-book (or top-N) on-chip is a deliberate scope cut: the strategy rarely needs level 50, and paying DRAM latency to store it would compromise the levels it *does* need.
* The book and the strategy are separate stages so they pipeline: while the strategy evaluates message T-1's book, the book engine is already applying message T.

### Use case: Strategy plus inline pre-trade risk (tick-to-trade)

This is the stage that turns a book update into an order, and it is where the *risk* requirement becomes structural. The strategy is a fixed circuit that asserts "fire" when the firm's condition holds; the risk gate is a mandatory inline block every fire must pass before the order builder ever sees it. Putting risk *after* the strategy but *before* the wire — in hardware, not in a downstream software check — is what makes it impossible for the fast path to emit an order that violates a limit.

**Core spec: strategy fire plus mandatory risk gate (behavioral model)**

```python
def strategy_eval(book, params):
    """Fixed-function example: cross the spread when it is at least as
    wide as a configured threshold. Real alpha is proprietary; the SHAPE
    -- read top-of-book, compare to a register-loaded parameter, assert
    fire with a target price/size -- is what the hardware encodes."""
    spread = book.spread()
    if spread is None or spread < params["min_spread_ticks"]:
        return {"fire": False}
    return {
        "fire": True,
        "side": "B",                      # e.g. lift the offer
        "price": book.best_ask(),
        "shares": params["order_shares"],
        "instrument": params["instrument"],
    }

def risk_gate(order, limits, state):
    """Inline pre-trade risk. EVERY order crosses this before the wire.
    All checks are cheap integer comparisons -> single-cycle in hardware.
    Returns (approved, reason). A rejected order is dropped and logged,
    never sent."""
    if state["kill_switch"]:
        return False, "kill_switch_engaged"
    if not (limits["min_price"] <= order["price"] <= limits["max_price"]):
        return False, "price_band"          # fat-finger guard
    if order["shares"] > limits["max_order_shares"]:
        return False, "max_order_size"
    projected = state["net_position"] + order["shares"]
    if abs(projected) > limits["max_position"]:
        return False, "position_limit"      # aggregate exposure cap
    return True, "ok"

def tick_to_trade(book, params, limits, state):
    signal = strategy_eval(book, params)
    if not signal["fire"]:
        return None
    approved, reason = risk_gate(signal, limits, state)
    if not approved:
        return {"blocked": True, "reason": reason}   # audited, not sent
    return {"blocked": False, "order": signal}       # -> order builder -> wire
```

**Data structures:** the strategy's tunables (`min_spread_ticks`, `order_shares`) and the risk limits (`min_price`, `max_price`, `max_order_shares`, `max_position`, `kill_switch`) live in on-chip registers that the **host CPU writes over PCIe** — this is the seam between the fast path and the slow path: software *parameterizes* the hardware, the hardware *executes* every cycle. `net_position` is updated inline as orders are approved.

**Trade-offs:**
* **The gotcha:** it is tempting to leave risk checks in the (simpler to change) software slow path — but a fast path that can reach the wire *without* passing risk is a firm-ending bug, because a mispriced or runaway strategy can fire thousands of orders in the microseconds before any software notices. Risk must be *inline and in hardware*, on the only path to the wire, even though that makes the limits harder to change. Regulators (and the 2012 Knight Capital ~$440M loss from an unguarded runaway) enforce the same lesson.
* Keeping every risk check to cheap integer comparisons is deliberate: anything requiring division, floating point, or an unbounded loop would either blow the cycle budget or introduce variable latency. Complex risk (VaR-style portfolio checks) belongs in the slow path *in addition*, never *instead*.
* Strategy parameters change often; strategy *structure* changes rarely. Encoding structure in the bitstream and parameters in registers means a tuning change is a register write (instant), while a genuinely new strategy is a resynthesis (slow) — matching the change-frequency to the change-cost.

### Use case: The hybrid model — FPGA fast path plus CPU/software slow path

No serious system puts *everything* on the FPGA, because hardware is expensive to build and change and terrible at irregular, branchy, rarely-hit logic. The winning shape is a division of labor: the FPGA owns the narrow, hot, latency-critical path; the CPU owns the wide, cold, complex remainder. They communicate over PCIe with a strict rule — **the CPU never sits in the tick-to-trade loop.**

**Core spec: the fast/slow-path boundary (behavioral model)**

```python
# What lives WHERE, and the one rule that must never break.
FAST_PATH_ON_FPGA = [
    "PHY/MAC + Ethernet/IP/UDP parse",
    "market-data feed handler + gap detection",
    "order book (top-of-book) in block RAM",
    "strategy fire decision",
    "inline pre-trade risk gate",
    "order-entry build + checksum + emit",
]

SLOW_PATH_ON_CPU = [
    "load/update strategy params + risk limits (register writes over PCIe)",
    "rare/complex order types the hardware doesn't implement",
    "authoritative position & P&L bookkeeping",
    "portfolio-level risk (VaR, correlated exposure)",
    "logging, monitoring, alerting, kill-switch UI",
    "post-trade audit consumption from the capture tap",
]

INVARIANT = "The CPU parameterizes and observes the fast path; " \
            "it is NEVER a stage IN the tick-to-trade pipeline."

def host_configure(fpga_registers, new_limits, new_params):
    """Runs on the CPU. Pushes config INTO the hardware; does not process
    a single market-data message itself."""
    fpga_registers.write("risk_limits", new_limits)
    fpga_registers.write("strategy_params", new_params)
    # The FPGA now executes with the new values on the very next clock.
```

**Data structures:** a shared register/memory map exposed over PCIe (config in, telemetry out), plus a DMA'd **capture ring** the FPGA fills with timestamped copies of every message and order for the host to drain asynchronously.

**Trade-offs:**
* **The gotcha:** the tempting mistake is to let "just this one check" or "just this rare order type" call back into software mid-path for convenience — the instant the CPU is *in* the loop, the whole latency guarantee collapses to CPU-plus-PCIe-plus-OS jitter, i.e. microseconds with a fat tail. The boundary must be absolute: hardware handles a case entirely, or it defers the *whole* decision to software as an explicit, accepted slow-path fallback — never a hybrid per-message handoff.
* This split is why FPGAs coexist with, rather than replace, software: the CPU's flexibility (edit and redeploy in seconds, arbitrary logic, rich libraries) is exactly what the hardware lacks, and the hardware's determinism is exactly what the CPU lacks. Each does what it is good at.
* An [ASIC](https://en.wikipedia.org/wiki/Application-specific_integrated_circuit) would be faster still and lower-power, but it *cannot be reprogrammed after fabrication* — and trading logic, protocols, and venues change constantly, so the FPGA's reconfigurability is worth its latency premium over an ASIC. That reconfigurability is the whole reason FPGAs, not ASICs, dominate this niche.

### Use case: How the logic is authored — HLS vs RTL

Everything above is *behavioral pseudocode*; the real fast path is authored as a hardware design and synthesized to a bitstream. There are two ways in, and choosing between them is a real engineering trade-off in HFT shops.

**Core spec: the same XOR/parse intent, in RTL vs HLS (illustrative)**

```verilog
// RTL (Verilog): register-transfer level. You describe WHAT THE HARDWARE
// IS -- registers and the combinational logic between them -- not a
// sequence of steps. Maximum control over timing; more effort.
module tick_stage (
    input  wire        clk,
    input  wire [31:0] price_in,
    input  wire [31:0] threshold,
    output reg         fire
);
    always @(posedge clk) begin
        fire <= (price_in >= threshold);  // one comparator, one clock
    end
endmodule
```

```cpp
// HLS (C++ subset): you write algorithm-shaped C++ and the HLS tool
// (e.g. AMD Vitis HLS) synthesizes RTL from it. Faster to write and
// iterate; the tool decides the exact pipelining. Pragmas hint intent.
#include <ap_int.h>
void tick_stage(ap_uint<32> price_in, ap_uint<32> threshold, bool &fire) {
    #pragma HLS PIPELINE II=1        // 1 result per clock
    fire = (price_in >= threshold);  // tool infers the comparator + register
}
```

**Data structures:** in both cases the durable artifact is the **synthesized bitstream** — the netlist of LUTs, flip-flops, DSP slices, and routing that the toolchain (AMD Vivado/Vitis, Intel Quartus) produces and loads onto the fabric. The HDL/HLS source is the input; the bitstream is what actually runs.

**Trade-offs:**
* **The gotcha:** HLS is *not* "write C++ and get free hardware" — code that looks fine as software can synthesize to logic that fails timing closure (too slow to hit the target clock) or bloats resource usage, and hand-written RTL almost always achieves lower, tighter latency than HLS for the innermost tick-to-trade stages. The common pattern: RTL the last-nanosecond-critical core by hand, use HLS for the larger, less-critical surrounding blocks where developer velocity matters more than the final few nanoseconds.
* HLS dramatically lowers the barrier to entry (a firmware team can be smaller, iterate faster) and AMD/Xilinx explicitly market accelerated-algo frameworks to broaden FPGA access in trading — but the winningest latency numbers still come from expert RTL.
* Either way, the compile is slow: synthesis, place-and-route, and timing closure take minutes to hours, so hardware iteration is nothing like editing a script. This compile cost is the practical reason parameters live in registers (change instantly) and only *structure* lives in the bitstream (change slowly).

## Step 4: Scale the design

![Scaled FPGA HFT architecture: multiple exchange feeds arriving on redundant A/B links into a bank of FPGA trading cards colocated at the exchange, each card running an independent tick-to-trade pipeline, fronted by hardware risk gates, with a host fleet running slow-path software, capture/PTP-timestamping taps, and a separate reconfiguration/bitstream-management path](/img/case-studies/fintech/fpga-in-hft-scaled.svg)

* **Scale is not "more messages/sec on one path" — it is more *instruments, venues, and strategies*, each with its own bounded fast path.** A firm colocates FPGA cards at each exchange it trades and replicates the same tick-to-trade pipeline per venue/instrument-group, because the constraint is per-path latency, not aggregate throughput. This is the opposite of a load-balanced web fleet: you do not shard *one* logical stream across workers, you run *many* independent narrow pipelines. See [Horizontal Scaling](/docs/patterns/scaling/horizontal-scaling) for the general shape, applied here at the granularity of whole trading paths.
* **Redundant A/B feeds and gap recovery are a reliability requirement handled inline.** Because a corrupted book produces confidently-wrong trades, the feed handler arbitrates the exchange's two identical feeds and requests retransmission on an unrecoverable gap — an application-level [Failover](/docs/patterns/reliability/failover) between duplicate data sources, done in hardware at line rate rather than in a slow recovery routine.
* **The inline risk gate is the system's [Circuit Breaker](/docs/patterns/reliability/circuit-breaker), in the most literal sense.** A kill-switch register the host can set instantly halts all outbound orders in hardware, and per-order price/size/position gates trip the moment a limit is crossed — protecting the firm from its own runaway strategy exactly the way a circuit breaker protects a caller from a failing dependency, but on the microsecond timescale where software reaction is far too slow.
* **The capture/audit path must scale as a parallel tap, never inline.** Every message and order is hardware-timestamped (typically PTP-synchronized clocks for cross-system correlation) and DMA'd off-chip to a capture store; this is a high-bandwidth [Event-Driven Architecture](/docs/patterns/communication/event-driven-architecture) feeding post-trade analytics and regulatory reconstruction, and its entire design constraint is that it must add *zero* latency to the tick-to-trade path — it observes, it does not gate.
* **Reconfiguration is a first-class operational path.** Because a strategy or protocol change means a new bitstream (a slow synthesis + timing-closure + validation cycle), rolling a new bitstream across a fleet of cards is a deployment problem in its own right — staged, validated in a shadow/replay environment against captured market data before it ever touches a live venue, closer to a [Canary Deployment](/docs/patterns/observability/canary-deployment) of firmware than to a code push. Parameter changes (register writes) are the fast, everyday knob; bitstream changes are the rare, heavyweight release.

## Additional talking points

* **Why not everything is on the FPGA — the cost/complexity wall.** Purpose-built trading FPGAs and their tooling are expensive, firmware engineers are scarce and specialized, and the develop-synthesize-validate loop is orders of magnitude slower than software iteration. The rational architecture spends the hardware budget *only* on the nanosecond-critical path and leaves everything else — the vast majority of a trading system's code by line count — in software. FPGA acceleration is a scalpel, not a hammer.
* **Determinism is the real product, and it is measured, not assumed.** Firms characterize their tick-to-trade as a *distribution* and obsess over the tail (p99.9/p99.99), because a fast median with an ugly tail loses precisely the contested trades. Hardware timestamping on ingress and egress (often PTP-synchronized) is what makes this measurable; you cannot improve a latency you cannot see at nanosecond resolution.
* **Regulatory pre-trade risk (e.g. the SEC's Market Access Rule, Rule 15c3-5) is why inline hardware risk exists at all.** Firms with direct market access must have controls that prevent erroneous or limit-breaching orders *before* they reach the exchange — putting those controls in the fast-path hardware satisfies the requirement without adding a software hop, aligning the regulatory need with the latency need.
* **The FPGA is one link in a latency chain it does not fully control.** Colocation, cross-connects, microwave-vs-fiber inter-venue links, and the exchange's own matching-engine latency all sit outside the chip. The on-chip design minimizes the part the firm *can* control to nanoseconds; the rest is facilities and physics, which is why colocation at the exchange is table stakes before FPGA tick-to-trade even matters.
* **ASIC is the road not taken, deliberately.** An ASIC would be faster and more power-efficient, but its logic is frozen at fabrication — and trading strategies, exchange protocols, and venues change too often to bet on frozen silicon. The FPGA's reconfigurability is the feature that justifies its latency and power premium over an ASIC for this specific workload; that trade-off is the reason the whole field standardized on FPGAs rather than custom chips.

## Source(s) and further reading

* [AMD unveils the Alveo UL3524, a purpose-built FPGA accelerator for ultra-low-latency electronic trading](https://www.amd.com/en/newsroom/press-releases/2023-9-27-amd-unveils-purpose-built-fpga-based-accelerator-.html) — vendor announcement of a trading-specific FPGA card, the concrete hardware this design's fast path targets
* [AMD Alveo UL3524 product page](https://www.amd.com/en/products/accelerators/alveo/ul3524.html) — the card's specifications, including its trading-oriented transceiver and fabric resources
* [Alveo UL3524 product brief (PDF)](https://www.xilinx.com/content/dam/xilinx/publications/product-briefs/2233051_Product_Brief_UL3524_Alveo_Accelerator_Card.pdf) — states the single-digit-nanosecond (~3 ns) transceiver latency figure cited in Step 1
* [The Register: AMD's latest FPGA promises lower-latency stock trading](https://www.theregister.com/2023/09/29/amd_finance_fpga/) — independent reporting on the same card and the ~3 ns transceiver / 7× latency-reduction claims
* [A-Team Insight: AMD FPGA technology and ultra-low-latency trading](https://a-teaminsight.com/blog/as-the-latest-fpga-technology-from-amd-sets-the-gold-standard-where-next-for-ultra-low-latency-trading/) — industry analysis of FPGAs in the low-latency-trading arms race
* [Orthogone: high-frequency-trading engineering](https://orthogone.com/industries/high-frequency-trading-finance/) — a specialist FPGA-trading engineering firm describing feed handlers, book building, and tick-to-trade in hardware
* [Field-programmable gate array — Wikipedia](https://en.wikipedia.org/wiki/Field-programmable_gate_array) — LUTs, CLBs, block RAM, and the reconfigurable-fabric model this design is built on
* [Lookup table — Wikipedia](https://en.wikipedia.org/wiki/Lookup_table) — the truth-table primitive an FPGA uses to realize arbitrary logic, as described in Step 3
* [Von Neumann architecture — Wikipedia](https://en.wikipedia.org/wiki/Von_Neumann_architecture) — the fetch-decode-execute CPU model whose jitter the FPGA fast path avoids
* [High-level synthesis — Wikipedia](https://en.wikipedia.org/wiki/High-level_synthesis) — the C++-to-RTL flow weighed against hand-written Verilog in the HLS-vs-RTL use case
* [Verilog — Wikipedia](https://en.wikipedia.org/wiki/Verilog) — the register-transfer-level HDL the real fast-path logic is authored in
* [High-frequency trading — Wikipedia](https://en.wikipedia.org/wiki/High-frequency_trading) — background on the trading domain, latency arms race, and market-access risk controls
* [Nasdaq TotalView-ITCH specification (PDF)](https://www.nasdaqtrader.com/content/technicalsupport/specifications/dataproducts/NQTVITCHspecification.pdf) — a real order-by-order market-data protocol of the kind the hardware feed handler parses
* [FIX Trading Community standards](https://www.fixtrading.org/standards/) — the order-entry protocol family (and binary variants) the order builder formats onto the wire
