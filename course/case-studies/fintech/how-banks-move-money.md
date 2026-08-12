---
title: "How Banks Move Money (ACH, Wire, Correspondent)"
sidebar_position: 13
---

The defining property of interbank money movement is that money almost never actually *travels*. When one bank pays another, no cash and no digital token leaves one institution and arrives at the other; instead each bank updates a record of who owes whom, and at scheduled moments the banking system settles only the *net* difference in one place both banks already trust. That one shared place is the central bank, where every bank holds a master account, and where interbank obligations ultimately become final by moving balances between those accounts. Everything below is organized around that single insight: designing "how banks move money" is really designing a set of rails that record obligations exactly once, net them safely, and settle them against central-bank balances with the finality guarantee each use case demands, while never losing or duplicating a payment when a rail, a batch, or a correspondent link fails partway through.

This case study designs a system with the shape of the US payment rails — book transfers, ACH, Fedwire, RTP and FedNow, and correspondent banking with nostro/vostro accounts — grounding each component in how those rails actually clear and settle.

## Step 1: Outline use cases and constraints

### Use cases

#### We'll scope the problem to handle the following use cases

* A customer of **Bank A** sends money to a customer of **Bank B**, and the system must record the obligation, choose the right rail, and drive the payment to a durable terminal state
* A **book transfer** moves money between two accounts *at the same bank* — no rail and no interbank settlement is involved, only two balanced ledger updates
* An **ACH** transfer batches many low-value credits and debits (payroll, bills, subscriptions), clears them together, and settles the **net** position between each pair of banks on a T+1 or same-day cycle, cheaply and reversibly-ish
* A **Fedwire / RTGS** transfer settles a single high-value payment in real time, gross (one payment at a time, not netted), and **irrevocably and finally** against the banks' Fed master accounts
* An **RTP or FedNow** transfer moves a lower-value payment instantly, 24×7, as an irrevocable credit-push — RTP settling out of a prefunded joint account the participating banks pool at the Fed, FedNow settling directly across each participant's own Fed master account
* A **correspondent-banking** transfer moves money between two banks with **no direct relationship** (typically cross-border) via an intermediary that holds a **nostro/vostro** account relationship, coordinated by SWIFT messaging while the money itself moves link by link
* The system computes **net versus gross settlement** correctly, in integer cents, and records every posting so that what left one bank provably equals what arrived at another
* Interbank settlement ultimately lands at the **central-bank master account**, and the system records the finality of each rail's settlement so downstream systems know when a payment is truly done

#### Out of scope

* Card-network authorization and clearing (a related netting rail designed in this course's credit-card case study, referenced but not redesigned here)
* The retail user experience, mobile app security, and account onboarding / KYC — treated as upstream concerns
* Fraud scoring, sanctions/AML screening, and dispute/return-reason taxonomies beyond a brief mention in the talking points
* The full ISO 20022 and NACHA record layouts field-by-field — this design shows representative, correct entries rather than the complete wire formats
* Foreign-exchange pricing and conversion mechanics inside a cross-border transfer (named, not designed)

### Constraints and assumptions

#### State assumptions

* Different rails make deliberately different **finality** promises: a Fedwire/RTGS payment is final and irrevocable the instant it settles; an ACH transfer is provisional until its settlement cycle completes and can be returned within defined windows; an instant-rail (RTP/FedNow) credit is irrevocable on acceptance — RTP settling against a prefunded joint account rather than gross per payment, while FedNow settles each payment in real time across participants' own Fed master accounts
* A payment must never be **double-counted** in settlement, even if a batch file is redelivered or a wire instruction is retried — a duplicated settlement posting is a real financial loss, not a rendering glitch
* A payment must never be **silently lost**: every accepted instruction reaches a terminal state (settled, returned, or rejected), durably recorded and reconcilable against the counterparty bank's own record
* **Net settlement** trades intraday credit exposure for enormous efficiency: banks pass millions of obligations and settle one net figure per pair per cycle, which introduces **settlement risk** (the risk a bank fails before its net position settles) that gross, real-time rails exist to eliminate for high-value payments
* All amounts are held as **integer minor units (cents)**, never floating point, so netting and balance invariants are exact
* The **Fed master account** is the ultimate settlement venue; a rail's job is to determine *how much* and *when* moves between those accounts, not to hold funds itself

#### Calculate usage

* Fedwire operates at large scale: the Fedwire Funds Service moves on the order of **hundreds of thousands of payments per day** with an average value in the millions of dollars, so the aggregate value settled is measured in **trillions of dollars per day** — this rail is value-dominated, not volume-dominated, and its design pressure is finality and certainty per payment, not throughput.
* ACH is volume-dominated: the network processes on the order of **hundreds of millions of payments per day** batched into files, but settles only a **small number of net positions per settlement cycle** — roughly on the order of the number of participating bank pairs per cycle, orders of magnitude fewer settlement postings than payments. That compression is the entire economic point of a net rail.
* Netting compression is dramatic: if two banks exchange, say, 200,000 payments in a day, they still settle **one** net figure between them for that cycle. Across N banks a cycle produces at most on the order of N settlement positions, not the millions of underlying payments.
* A settlement record (an entry keyed by `settlement_date`, `rail`, `debtor_bank`, `creditor_bank`, `net_amount_cents`, `status`, timestamps) is on the order of **~200 bytes**; even at hundreds of millions of underlying ACH entries per day the *settlement* ledger stays small because it stores net positions, while the *entry* ledger that stores every individual credit/debit is the large, shardable store.
* Latency budgets differ by rail by design: a book transfer is two local writes (sub-millisecond of real work); a Fedwire payment settles in **seconds** and is final; an ACH entry settles on a **T+1 or same-day** cycle boundary; an RTP/FedNow credit posts in **about one second**, any time of day; a correspondent cross-border transfer can take **a few days** because it is a relay across multiple bank-to-bank links and messaging hops.
* Per-rail value profile shapes the design: high-value payments prefer gross, irrevocable Fedwire (to avoid holding settlement risk on a huge sum across a netting window); high-volume low-value payments prefer ACH (to amortize cost across a batch); consumer instant payments prefer RTP/FedNow (for 24×7 immediacy on modest amounts).

## Step 2: Create a high-level design

![Money rarely moves between banks: each bank records who owes whom all day, the obligations are netted, and only the net difference settles once by moving balances between the banks' master accounts at the central bank, with side notes on same-bank book transfers and cross-border correspondent banking](/img/case-studies/fintech/how-banks-move-money-overview.svg)

The core mental model has three layers. On top, **banks record obligations** to one another continuously as their customers pay across institutions — Bank A notes it owes Bank B for some payments, Bank B notes it owes Bank A for others, and no money moves while these records accumulate. In the middle sits **netting**: at a scheduled moment the system nets the two-way (or multilateral) obligations down to a single figure per bank pair — if A owes B 100 and B owes A 90, the net is A owes B 10. At the bottom sits **settlement at the central bank**, where every bank holds a **master account**; final settlement is the central bank reducing the debtor bank's balance and increasing the creditor bank's balance by the net figure. The speed a customer *feels* is the speed of an obligation being recorded and, on instant rails, made irrevocable; the actual interbank money moves quietly later, when the net difference settles.

Three structural facts make this different from designing a single application's payment flow. First, **the rail is chosen per payment** to match a finality-versus-cost tradeoff: same-bank payments never leave the bank (a **book transfer**, just two ledger updates); high-value payments take **Fedwire (RTGS)**, settling one payment at a time, immediately and irrevocably against Fed master accounts, so no one holds settlement risk on a large sum; high-volume low-value payments take **ACH**, batched and net-settled cheaply; consumer instant payments take **RTP or FedNow**, irrevocable and 24×7 — RTP settling out of a prefunded joint account pooled at the Fed, FedNow settling each payment directly across participants' own Fed master accounts. Second, **net settlement creates settlement risk** — the exposure that a bank fails before its net position settles — which is precisely why the highest-value flows use gross, real-time settlement instead. Third, when two banks have **no direct relationship** (the common cross-border case), the payment relays through **correspondent** banks that do, using **nostro/vostro** accounts (a nostro is "our account at your bank," a vostro is "your account at our bank," two views of the same balance), with **SWIFT** carrying only the instruction, never the money. The design below builds each rail as a distinct settlement discipline over one shared, exactly-once obligation ledger.

## Step 3: Design core components

### Use case: Same-bank book transfer as two balanced ledger entries

The simplest money movement uses no rail at all. When the payer and payee both bank at the same institution, the bank moves money entirely on its own books: it debits one internal account and credits another. Nothing settles between banks because no second bank is involved; the only correctness requirement is that the two entries are written together and balance exactly, so money is neither created nor destroyed inside the bank's ledger.

**Core spec: balanced double-entry book transfer**

```python
from dataclasses import dataclass

@dataclass
class LedgerEntry:
    entry_id: int
    transfer_id: str
    account_id: str
    entry_type: str       # 'DEBIT' or 'CREDIT'
    amount_cents: int     # always positive; direction is in entry_type
    posted_at: str

def is_balanced(entries):
    """Total debits must equal total credits for a set of entries.
    Reports rather than raises so the caller decides how to react.
    """
    debits = sum(e.amount_cents for e in entries if e.entry_type == "DEBIT")
    credits = sum(e.amount_cents for e in entries if e.entry_type == "CREDIT")
    return debits == credits, debits, credits

def book_transfer(ledger, transfer_id, from_account, to_account, amount_cents, now):
    """Same-bank transfer: two internal ledger entries, no rail, no
    interbank settlement. The pair is written atomically or not at all.
    """
    if amount_cents <= 0:
        raise ValueError("amount must be a positive integer number of cents")
    entries = [
        LedgerEntry(ledger.next_id(), transfer_id, from_account, "DEBIT",  amount_cents, now),
        LedgerEntry(ledger.next_id(), transfer_id, to_account,   "CREDIT", amount_cents, now),
    ]
    balanced, debits, credits = is_balanced(entries)
    if not balanced:
        raise ValueError(f"refusing unbalanced book transfer: debits={debits} credits={credits}")
    ledger.write_atomic(entries)   # both rows commit together or neither does
    return entries
```

**Data structures:** a single `ledger_entries` table — `entry_id` (PK), `transfer_id` (groups the two legs), `account_id`, `entry_type` (`DEBIT`/`CREDIT`), `amount_cents` (integer, always positive), `posted_at`. A book transfer is exactly two rows sharing a `transfer_id`, and an account's balance is derived by summing its entries, never stored as a single mutable field that a partial write could corrupt.

**Trade-offs:**
* **The gotcha:** the tempting shortcut is to model a transfer as decrementing one balance field and incrementing another as two independent updates — but a crash between the two updates destroys or duplicates money, and there is no record of *where* it went. The fix is writing a **balanced pair of entries atomically**, so the double-entry invariant (`is_balanced`) is structurally enforced and a reconciliation job can prove the whole ledger nets to zero, catching any bug that writes a debit without its matching credit.
* Book transfers are the cheapest and most final movement in the whole system precisely because they involve one party: there is no counterparty bank, no rail, and no settlement risk, so the transfer is complete the instant the atomic write commits.

### Use case: ACH batch clearing and net settlement between banks

ACH is the batched, cheap rail behind payroll, bills, and subscriptions. Originating banks collect many low-value entries (each a credit or debit against a receiving bank's customer), package them into files, and submit them to the operator; entries are cleared together and the operator computes the **net** position each bank owes or is owed for the settlement cycle. Only those net figures settle against Fed master accounts, so millions of entries collapse into a handful of settlement postings.

**Core spec: multilateral netting over a batch of ACH entries**

```python
from collections import defaultdict

def net_positions(entries):
    """Compute each bank's net settlement position for one ACH cycle.

    Each entry moves amount_cents from an originating bank (debtor for a
    credit push) to a receiving bank (creditor). We accumulate signed
    positions per bank in integer cents: a bank that owes ends the cycle
    negative, a bank that is owed ends positive. Across all banks the
    positions MUST sum to zero -- that is the multilateral netting
    invariant, and it is what makes net settlement safe to post.
    """
    pos = defaultdict(int)                       # bank routing number -> signed cents
    for e in entries:
        pos[e["originating_rtn"]] -= e["amount_cents"]   # pays out: owes
        pos[e["receiving_rtn"]]   += e["amount_cents"]   # receives: is owed
    total = sum(pos.values())
    if total != 0:
        raise ValueError(f"netting invariant broken: positions sum to {total}, not 0")
    return dict(pos)

# Representative NACHA-style entries: an employer's payroll run.
# Amounts are integer cents. In a real Nacha file these are fixed-width
# records; here we show the fields that drive settlement.
ach_batch = [
    {"trace": "091000010000001", "originating_rtn": "091000019", "receiving_rtn": "021000021",
     "amount_cents": 250000, "sec": "PPD", "type": "CREDIT"},   # payroll to a worker at Bank X
    {"trace": "091000010000002", "originating_rtn": "091000019", "receiving_rtn": "021000021",
     "amount_cents": 180000, "sec": "PPD", "type": "CREDIT"},   # another worker, same bank
    {"trace": "021000020000003", "originating_rtn": "021000021", "receiving_rtn": "091000019",
     "amount_cents": 300000, "sec": "PPD", "type": "CREDIT"},   # a payment flowing the other way
]

positions = net_positions(ach_batch)
# originating_rtn 091000019 paid 250000+180000, received 300000 -> net -130000 (owes 130000)
# receiving_rtn   021000021 received 250000+180000, paid 300000 -> net +130000 (is owed 130000)
assert positions == {"091000019": -130000, "021000021": 130000}
```

**Data structures:** an `ach_entries` table storing every individual entry (`trace` number as the unique key, `originating_rtn`, `receiving_rtn`, `amount_cents`, `sec` code such as `PPD`/`CCD`/`WEB`, `type`, `status`, `settlement_date`); and a much smaller `net_settlement` table with one row per (`settlement_date`, `debtor_rtn`, `creditor_rtn`) holding the `net_amount_cents` that actually posts to Fed master accounts. The entry table is the large, shardable store; the settlement table is tiny by comparison.

**Trade-offs:**
* **The gotcha:** representing amounts as dollars in floating point makes the netting invariant (`positions sum to 0`) fail by fractions of a cent, so a cycle silently fails to balance and money appears created or destroyed. The fix is **integer cents everywhere** and an explicit assertion that positions sum to exactly zero before any net figure is allowed to settle — netting must be provably conservative or it does not post.
* ACH settles **net**, which is cheap and efficient but means a bank carries intraday exposure to its counterparties until the cycle settles — this is **settlement risk**, and it is the deliberate price ACH pays for batching. Same-day ACH shortens the window; high-value payments that cannot tolerate this exposure use a gross rail instead (next).
* ACH entries are **reversible within defined windows** (returns for insufficient funds, wrong account, unauthorized debit), so a receiving bank's credit is provisional until those windows pass — a property that makes ACH unsuitable for a final, irrevocable high-value payoff, and drives the existence of a gross rail. This batch-and-net shape is the same discipline as [Queue-based Load Leveling](/docs/patterns/batch-streaming/queue-based-load-leveling) applied to interbank settlement.

### Use case: Fedwire (RTGS) irrevocable single-payment settlement

Fedwire is the opposite of ACH by design. It settles each payment **individually (gross), in real time, and finally** — the moment the sending bank's Fed master account is debited and the receiving bank's is credited, the payment is settled and irrevocable, with no netting window and no return path. This is the rail for high-value payments where no one is willing to carry settlement risk across a batch cycle: the exposure exists only for the instant of the transfer, then it is final.

**Core spec: gross, irrevocable posting against Fed master accounts**

```python
def settle_fedwire(fed, wire_id, sender_rtn, receiver_rtn, amount_cents, dedup_store):
    """Real-time gross settlement of one payment against Fed master
    accounts. Gross = this single payment settles on its own, not netted
    with others. Final = once posted, it cannot be reversed on the rail.

    The Fed debits the sender's master account and credits the receiver's
    in one atomic step. The sender must have sufficient funds (or approved
    intraday credit); an RTGS system will not post a payment that would
    overdraw beyond the allowed limit, because a posted payment is final.
    """
    # Exactly-once guard: a retried wire instruction with the same id must
    # never post twice. A duplicate gross posting is an irreversible loss.
    if not dedup_store.claim(wire_id):
        return dedup_store.stored_result(wire_id)   # replay prior outcome

    sender_balance = fed.master_balance_cents(sender_rtn)
    if sender_balance + fed.intraday_credit_limit_cents(sender_rtn) < amount_cents:
        result = {"wire_id": wire_id, "status": "REJECTED_INSUFFICIENT_FUNDS"}
        dedup_store.finalize(wire_id, result)
        return result

    # Atomic gross settlement: debit sender, credit receiver, together.
    fed.post_atomic([
        {"rtn": sender_rtn,   "entry_type": "DEBIT",  "amount_cents": amount_cents},
        {"rtn": receiver_rtn, "entry_type": "CREDIT", "amount_cents": amount_cents},
    ])
    result = {"wire_id": wire_id, "status": "SETTLED_FINAL", "amount_cents": amount_cents}
    dedup_store.finalize(wire_id, result)          # settlement is irrevocable from here
    return result
```

**Data structures:** a `fedwire_payments` table — `wire_id` (PK, the exactly-once anchor), `sender_rtn`, `receiver_rtn`, `amount_cents`, `status` (`SETTLED_FINAL`/`REJECTED_*`), `settled_at`; plus the Fed's own `master_accounts` balances (`rtn`, `balance_cents`, `intraday_credit_limit_cents`) that the debit/credit posts against. There is no separate netting table because every wire settles gross on its own.

**Trade-offs:**
* **The gotcha:** because a settled wire is **final and irrevocable**, a duplicate posting from a retried instruction is an irreversible loss — there is no return window to claw it back. The fix is an exactly-once guard keyed by the wire's unique id (an atomic claim-or-replay, the same [Idempotency](/docs/patterns/reliability/idempotency) discipline used elsewhere in this course), so a retried instruction replays the prior outcome instead of settling a second time. Finality makes exactly-once non-negotiable, not merely nice.
* Gross settlement eliminates settlement risk (no exposure accumulates across a batch) at the cost of requiring the sender to have funds or approved intraday credit *at the moment of each payment*, which is why RTGS is reserved for high-value flows rather than everyday retail volume — settling every retail payment gross would be far more liquidity-intensive than netting them.
* Fedwire settles directly against **Fed master accounts**, which is why its finality is absolute: the central bank is the ultimate settlement venue, and once balances there move, the obligation between the two banks is discharged with nothing left to reconcile.

### Use case: Correspondent banking via nostro/vostro accounts

When two banks have no direct relationship — the typical cross-border case — the payment cannot settle between them directly because neither holds an account for the other. Instead it relays through a **correspondent** bank that both trust, using **nostro/vostro** accounts. A nostro account is "our money held at your bank"; the mirror-image vostro is "your money held at our bank" — two labels for the same balance seen from each side. SWIFT carries the payment *instruction* between institutions, but the money itself moves by debiting and crediting these correspondent accounts one link at a time, which is why a cross-border transfer can take days.

**Core spec: a correspondent leg posted across nostro/vostro accounts**

```python
def post_correspondent_leg(book, instruction):
    """Move money across one correspondent link by adjusting the
    nostro/vostro relationship. The intermediary debits the paying bank's
    vostro balance (the paying bank's money held here) and credits the
    receiving side, keeping the mirror nostro/vostro views consistent.

    A nostro (Bank A's account at Bank C) and the matching vostro (Bank C's
    record of Bank A's account) are the SAME balance from two viewpoints;
    every posting must keep them equal or the correspondent relationship
    has silently drifted.
    """
    debtor  = instruction["debtor_bank"]     # bank whose vostro is debited here
    creditor = instruction["creditor_bank"]  # bank whose balance is credited here
    amount  = instruction["amount_cents"]

    # Debit the debtor's vostro (their funds held at the correspondent),
    # credit the creditor. Both are integer-cents ledger moves.
    book.adjust_vostro(debtor,   -amount)
    book.adjust_vostro(creditor, +amount)

    # Invariant: the correspondent's own books stay balanced -- what left
    # one account arrived in another, no money created across the link.
    nostro_view = book.nostro_balance(debtor)     # as the debtor bank sees it
    vostro_view = book.vostro_balance(debtor)     # as the correspondent records it
    if nostro_view != vostro_view:
        raise ValueError(
            f"nostro/vostro drift for {debtor}: nostro={nostro_view} vostro={vostro_view}")
    return {"link": instruction["link_id"], "status": "POSTED", "amount_cents": amount}
```

**Data structures:** a `correspondent_accounts` table — (`owning_bank`, `holding_bank`, `balance_cents`, `currency`) — where the same relationship appears as a nostro to the owning bank and a vostro to the holding bank; and a `swift_messages` log recording each instruction (`uetr`/reference, `debtor_bank`, `creditor_bank`, `amount_cents`, `currency`, `status`) that carries the payment across the relay without carrying the money. A full cross-border transfer is a **chain** of such legs, each an independent posting.

**Trade-offs:**
* **The gotcha:** treating a cross-border transfer as a single atomic movement between the two end banks is wrong — it is a **relay of independent legs** across correspondent links, each of which can succeed, stall, or fail on its own, and SWIFT only moves the message, not the funds. The fix is to model each link as its own posting with its own status and to reconcile the nostro/vostro mirror after every leg, so a stalled or failed link is visible and recoverable rather than silently leaving money stranded in an intermediary.
* Because each correspondent charges fees and applies its own cut-off times and FX, a multi-hop cross-border payment accumulates cost and delay at each link, which is the structural reason these transfers take days — the finality is only as fast as the slowest bank-to-bank relationship in the chain.
* The relay depends entirely on **trust between correspondents**: each link trusts the instruction is genuine and that the counterparty will honor the posting, which is why identity, message authentication, and audit of who submitted each instruction matter as much as the accounting itself (see the talking points on access and provable audit).

### Use case: Recording every rail's settlement against a single obligation ledger

All four rails differ in speed, cost, and finality, but they share one requirement: every payment must leave an auditable record that reconciles against the counterparty bank's record, and every settlement — net or gross — must provably conserve money. A single obligation ledger, summed different ways per rail, is what makes this checkable rather than merely asserted.

**Core spec: settlement ledger and the conservation invariant**

```sql
CREATE TABLE settlement_postings (
    posting_id       BIGINT       PRIMARY KEY,
    rail             VARCHAR(12)  NOT NULL,   -- 'BOOK','ACH','FEDWIRE','RTP','FEDNOW','CORR'
    settlement_date  DATE         NOT NULL,
    debtor_rtn       VARCHAR(16)  NOT NULL,   -- bank whose balance decreases
    creditor_rtn     VARCHAR(16)  NOT NULL,   -- bank whose balance increases
    amount_cents     BIGINT       NOT NULL,   -- integer cents, always positive
    is_final         BOOLEAN      NOT NULL,   -- true once irrevocably settled
    posted_at        TIMESTAMPTZ  NOT NULL,
    CONSTRAINT rail_chk CHECK (rail IN ('BOOK','ACH','FEDWIRE','RTP','FEDNOW','CORR'))
);
CREATE INDEX idx_settle_cycle ON settlement_postings (rail, settlement_date);
CREATE INDEX idx_settle_bank  ON settlement_postings (debtor_rtn, settlement_date);
```

```python
def cycle_conserves_money(postings):
    """Across a settlement cycle, every debtor's outflow must be matched
    by a creditor's inflow: total debited equals total credited. Run per
    rail per settlement_date during reconciliation. A non-zero difference
    means a posting was lost, duplicated, or mis-netted.
    """
    debited  = sum(p["amount_cents"] for p in postings)   # each posting debits its debtor
    credited = sum(p["amount_cents"] for p in postings)   # and credits its creditor by the same
    # Money conserved iff the summed net across banks is zero:
    net_by_bank = {}
    for p in postings:
        net_by_bank[p["debtor_rtn"]]   = net_by_bank.get(p["debtor_rtn"], 0)   - p["amount_cents"]
        net_by_bank[p["creditor_rtn"]] = net_by_bank.get(p["creditor_rtn"], 0) + p["amount_cents"]
    residual = sum(net_by_bank.values())
    return residual == 0, debited, credited, residual
```

**Data structures:** `settlement_postings` above is the durable, rail-tagged record of what actually moved between Fed master accounts (or across correspondent books). `idx_settle_cycle` answers "show every posting for the ACH cycle on this date" (used to verify netting), and `idx_settle_bank` answers "sum this bank's settlement obligations for the day." The `is_final` flag records each rail's finality: `true` immediately for Fedwire and instant rails, `true` only after the return window for ACH.

**Trade-offs:**
* **The gotcha:** conflating "the payment was accepted" with "the payment is final" leads a downstream system to release goods or funds against a provisional ACH credit that can still be returned. The fix is the explicit `is_final` flag per posting, set according to each rail's actual finality rules, so no consumer of the ledger treats a still-reversible ACH credit as settled money.
* Because the ledger is append-only and reconciled by summing (`cycle_conserves_money`), a bug that loses or duplicates a settlement posting shows up as a non-zero residual against the counterparty bank's own record — the same defense-in-depth reconciliation that a net rail requires precisely because it settles far fewer postings than the payments they represent.

## Step 4: Scale the design

![The US rails compared: a sending bank picks a rail (book transfer for same-bank, ACH for batched net settlement, Fedwire for real-time gross settlement, RTP or FedNow for instant credit-push, correspondent plus SWIFT for cross-border), and net or gross positions settle against the banks' Fed master accounts before the receiving bank credits its customer](/img/case-studies/fintech/how-banks-move-money-scaled.svg)

* **The obligation/entry ledger shards by bank or by payment, while the settlement ledger stays small because it stores net positions, not individual payments** — see [Sharding](/docs/patterns/storage/sharding). Almost every read and write is scoped to one payment or one bank's activity, so the large `ach_entries`-style store partitions cleanly, and netting compresses millions of entries into a handful of settlement rows that never need sharding.
* **Net-settlement rails run as scheduled batch jobs off the hot path** — see [Queue-based Load Leveling](/docs/patterns/batch-streaming/queue-based-load-leveling). ACH accumulates entries into files and settles net positions per cycle, absorbing a flood of low-value payments and posting only the compressed net figures, which is the whole reason a batch rail is cheap.
* **Gross-settlement (Fedwire) and instant (RTP/FedNow) rails need strong exactly-once semantics because their postings are final and irrevocable** — see [Idempotency](/docs/patterns/reliability/idempotency) and [Exactly-once Semantics](/docs/patterns/batch-streaming/exactly-once-semantics). A retried wire instruction that settles twice cannot be clawed back, so the claim-or-replay guard on the wire id is not an optimization but a correctness requirement finality forces on the design.
* **A correspondent cross-border transfer is coordinated as a relay of independent legs with explicit per-link status, not a distributed lock across every bank in the chain** — see [Saga](/docs/patterns/consistency/saga) and [Compensating Transaction](/docs/patterns/consistency/compensating-transaction). Each leg is a local posting; a failed link is resolved by a compensating reversal on the completed legs rather than by holding a blocking lock across banks that never agreed to participate in one.
* **Reconciliation against each counterparty bank's own record runs continuously, not just on failure** — see [Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication) for serving the read-heavy status and reconciliation queries from replicas. Because net rails settle far fewer postings than the payments they represent, a lost or duplicated posting is caught by summing the ledger (`cycle_conserves_money`) and comparing against the other bank, not by inspecting every underlying payment.

## Additional talking points

* **Net versus gross, and why both exist.** Net settlement (ACH, and card rails) compresses millions of obligations into one figure per bank pair per cycle — hugely efficient, but it accumulates **settlement risk**: a bank could fail before its net position settles, leaving its counterparties short. Gross settlement (Fedwire/RTGS) removes that risk by settling each payment finally the instant it posts, at the cost of far more intraday liquidity. High-value payments take the gross rail precisely so no one holds settlement risk on a large sum across a netting window; high-volume low-value payments take the net rail because the efficiency is worth the bounded, managed exposure.
* **Herstatt risk and why finality is defined so carefully.** The classic settlement-risk failure is the 1974 collapse of Bankhaus Herstatt, which had received one leg of foreign-exchange trades but failed before settling the other, leaving counterparties exposed across time zones. That episode is why modern high-value systems settle gross and final, why cross-border settlement mechanisms try to make both legs settle together, and why every rail in this design records an explicit finality flag rather than treating "accepted" and "settled" as the same thing.
* **The Fed master account as the ultimate settlement venue.** Every rail's story ends at the central bank: interbank obligations become truly final only when balances move between banks' Fed master accounts. Book transfers never reach it (one bank), ACH reaches it as net positions per cycle, and Fedwire reaches it gross per payment — but in every case the master account is where "who owes whom" stops being a promise and becomes settled money.
* **Reversibility is a per-rail property, not a system-wide one.** ACH entries can be returned within defined windows (insufficient funds, unauthorized debit, wrong account), so an ACH credit is provisional; Fedwire and instant-rail credits are irrevocable on settlement. A practitioner must know which rail a payment took before deciding whether "the money is really there," which is exactly why the ledger tags finality per posting.
* **The real security risk is access, not encryption.** The rails run on **trust** — that an instruction is genuine and that the counterparty will honor it — and the systems that keep the record of who owes whom are operated by many engineers and, increasingly, automated agents. In practice, breaches of payment infrastructure usually exploit **long-lived credentials** (an SSH key, a database secret) that linger on laptops and in scripts, not broken cryptography. Regulatory regimes such as PCI-DSS therefore ask not only whether data is encrypted but *who accessed a system, when, and can you prove it*. The mitigation is **identity-based, short-lived access** (a certificate scoped to a verified identity, expiring on its own) with every session recorded — extending the same principle to machine identities and agents, so nothing durable is left lying around to steal.

## Source(s) and further reading

* [Fedwire Funds Service — Federal Reserve Financial Services](https://www.frbservices.org/financial-services/wires) — the real-time gross settlement rail this design's Fedwire component models, including its irrevocable, final, high-value single-payment settlement
* [Fedwire — Wikipedia](https://en.wikipedia.org/wiki/Fedwire) — consolidated reference for Fedwire as an RTGS system settling against Federal Reserve master accounts, with volume and average-value figures
* [Federal Reserve Banks and Fed funds / master accounts](https://www.federalreserve.gov/paymentsystems/fedfunds_about.htm) — the central-bank master accounts that are the ultimate interbank settlement venue in this design
* [Automated Clearing House (ACH) — Federal Reserve Financial Services](https://www.frbservices.org/financial-services/ach) — the batched, net-settled rail behind this design's ACH clearing and settlement component
* [The ACH Network — NACHA](https://www.nacha.org/content/ach-network) — the rules body and network for ACH, covering batching, SEC codes, T+1 and same-day settlement, and returns
* [NACHA Operating Rules](https://www.nacha.org/rules) — the authoritative ruleset governing ACH entries, return windows, and settlement this design's reversibility notes rely on
* [FedNow Service — Federal Reserve Financial Services](https://www.frbservices.org/financial-services/fednow) — the instant, 24×7, irrevocable credit-push rail this design's instant-rail component models
* [FedNow Service — Federal Reserve](https://www.federalreserve.gov/paymentsystems/fednow_about.htm) — central-bank overview of instant settlement directly across participants' Fed master accounts (contrasted with RTP's prefunded joint account)
* [RTP — The Clearing House](https://www.theclearinghouse.org/payment-systems/rtp) — the private-sector instant rail (Real-Time Payments) alongside FedNow, irrevocable credit-push, 24×7
* [Real-time gross settlement — Wikipedia](https://en.wikipedia.org/wiki/Real-time_gross_settlement) — the RTGS concept (gross, immediate, final) that separates Fedwire from net rails like ACH
* [Nostro and vostro accounts — Wikipedia](https://en.wikipedia.org/wiki/Nostro_and_vostro_accounts) — the correspondent-banking account relationship this design's cross-border component posts against
* [Settlement risk — Wikipedia](https://en.wikipedia.org/wiki/Settlement_risk) and [Bankhaus Herstatt — Wikipedia](https://en.wikipedia.org/wiki/Herstatt_Bank) — the risk net settlement introduces and the historical failure that shaped modern finality rules
* [Idempotency](/docs/patterns/reliability/idempotency) and [Exactly-once Semantics](/docs/patterns/batch-streaming/exactly-once-semantics) — the exactly-once guards that make a final, irrevocable wire safe to retry
* [Queue-based Load Leveling](/docs/patterns/batch-streaming/queue-based-load-leveling) — the batch-and-settle discipline behind a net rail like ACH
* [Saga](/docs/patterns/consistency/saga) and [Compensating Transaction](/docs/patterns/consistency/compensating-transaction) — coordinating a correspondent cross-border transfer as a relay of independent, compensable legs
* [Sharding](/docs/patterns/storage/sharding) and [Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication) — partitioning the large entry ledger and serving reconciliation reads at scale
