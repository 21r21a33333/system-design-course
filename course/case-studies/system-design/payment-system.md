---
title: "Design a Payment Processing System"
sidebar_position: 19
---

A payment system's defining property is that its failure modes are worse than almost any other kind of system in this course: a lost write is an inconvenience for a social feed and a financial incident for a payment, and a duplicated write isn't a rendering glitch, it's a customer charged twice. The entire design below is organized around one goal — make every payment happen exactly once from the customer's perspective, even though the underlying infrastructure can only ever promise at-least-once delivery and partial failure.

## Step 1: Outline use cases and constraints

### Use cases

#### We'll scope the problem to handle the following use cases

* **Merchant** (an online store, a platform, an app) submits a request to charge a customer's payment method for an order
* **Service** coordinates with an external **payment gateway/processor** to actually move funds, since this design does not move money itself — it orchestrates and records the transaction, generically, without depending on any specific external provider's API
* **Service** guarantees a given payment request is applied at most once, even if the merchant's client retries after a timeout or the request is redelivered internally
* **Service** records a durable, auditable ledger of every payment attempt and its outcome
* **Merchant** queries the status of a previously submitted payment
* **Service** supports refunds against a previously completed payment
* **Service** has very high availability and, above all, correctness — a payment that silently disappears or silently duplicates is a far worse outcome than a payment that's briefly slow

#### Out of scope

* The payment gateway/processor's own internals (card network communication, fraud scoring, funds settlement) — treated as an external dependency this design integrates with, not something designed here
* Recurring/subscription billing schedules (a related but distinct problem layered on top of the same core charge mechanism)
* Currency conversion and multi-currency settlement
* Chargebacks and dispute-resolution workflows beyond a brief mention

### Constraints and assumptions

#### State assumptions

* 5 million payment requests processed per day across all merchants using the service
* A payment request must never be double-charged, even under network retries, client bugs that resend a request, or internal message redelivery — this is a hard correctness requirement, not a best-effort goal
* A payment request must also never be silently lost — every accepted request eventually reaches a terminal state (succeeded, failed, or requires manual review), and that outcome is durably recorded and queryable
* Charging a payment method typically takes hundreds of milliseconds to a few seconds end to end, dominated by the external gateway/processor's own response time, not by this system's internal processing — this design is not attempting sub-100ms responses the way a caching-heavy read path might
* A merchant may reasonably retry a request that appears to have failed or timed out — the system must make that safe rather than relying on merchants never retrying
* Consistency of the payment's recorded outcome matters more than raw throughput or low latency; this is one of the few systems in this course where the right instinct is to trade some performance for stronger guarantees, not the reverse
* The ledger of payment records is append-heavy and essentially never has existing records overwritten in place — a payment's outcome is corrected, if ever, by recording a new, explicitly linked event (a refund, a reversal), never by mutating the original record

#### Calculate usage

* Request volume: 5,000,000 payments/day → 5,000,000 / 86,400 ≈ **~58 requests/sec average**, with real-world commerce traffic peaking heavily around specific windows (a flash sale, end-of-month billing runs) — design for **~10x average at peak**, so **~580 requests/sec** — a modest number by this course's standards, since payment systems are correctness-bound rather than volume-bound; the entire design below optimizes for guaranteed-correct processing of a comparatively low request rate, not for absorbing a huge one
* Ledger record size: a payment record (`payment_id`, `idempotency_key`, `merchant_id`, `amount`, `currency`, `status`, `gateway_reference_id`, `created_at`, `updated_at`, plus a small amount of metadata) ≈ **~300 bytes/record** → 5,000,000/day × 300 bytes ≈ **~1.5 GB/day**, **~550 GB/year** — small enough that storage volume is never this design's bottleneck; the design pressure is entirely on write correctness, not write capacity
* Idempotency key storage: every request (including retries) needs its idempotency key checked, but only unique logical requests need a stored record — assuming a generous 20% of requests are retries of an already-seen key, that's still only ~6,000,000 key lookups/day, at ~58-580 lookups/sec, comfortably low-volume for a lookup that needs to be fast and strongly consistent, not eventually consistent
* Gateway call latency budget: if the external payment gateway/processor call itself takes an average of 800ms and this design targets a 5-second worst-case response to the merchant before falling back to an asynchronous "pending, check back" response, that leaves roughly a 4-second margin for this system's own processing, retries, and ledger writes around that external call — a generous internal budget precisely because the external dependency's latency, not this system's own, dominates the total
* Refund volume: assume refunds run at roughly 2% of completed payments → 5,000,000 × 0.02 = 100,000 refunds/day → 100,000 / 86,400 ≈ **~1.2 refunds/sec average** — low enough that refunds are never a scaling concern, though they follow the same strict correctness path (a refund is itself an idempotent, auditable operation) as the original charge

## Step 2: Create a high-level design

![Payment System high-level architecture](/img/case-studies/payment-system-overview.svg)

A merchant submits a charge request, carrying a client-generated **idempotency key**, to a **payment service**. Before doing anything else, the payment service checks that key against a durable **idempotency store**: if the key has been seen before, it returns the previously recorded outcome instead of processing the request again — this check is the single most important step in the entire design, because it's what converts "the merchant retried a request that may or may not have already succeeded" into "the merchant safely gets back the one true answer for that request, whether this is the first attempt or the fifth." If the key is new, the payment service records the attempt in a durable **ledger** as "processing," then calls out to the external **payment gateway/processor** to actually move funds. Once the gateway responds (success or failure), the payment service updates the ledger to a terminal status and records the result against the idempotency key, so any future retry of the same key returns that recorded outcome directly, without a second gateway call.

The structural bet this design makes, more explicitly than almost any other system in this course, is that **durability and ordering of state transitions matter more than raw speed** — every step that changes a payment's status is written durably before the system acts on it or reports it externally, because a payment system that's fast but occasionally loses track of whether a charge actually happened isn't an acceptable tradeoff, whereas a payment system that's a few hundred milliseconds slower than it could be is a minor inconvenience. This inverts the read-heavy, cache-first instinct that shapes most of this course's other case studies.

## Step 3: Design core components

### Use case: Merchant submits a payment request, exactly once

The core problem here is that "exactly once" isn't a property the network gives you for free — a request can time out on the merchant's side after the payment service already successfully charged the gateway, and the merchant, seeing no response, has no way to know whether to retry or not. If retrying safely isn't built in, the merchant is forced to choose between "maybe double-charge the customer" and "maybe never actually charge them," and both are unacceptable outcomes for a payment system.

The fix is [Idempotency](/docs/patterns/reliability/idempotency), applied as the first thing that happens on every request, not as an afterthought: the merchant generates a unique idempotency key for each logical payment attempt (not per HTTP request — the *same* key is reused across retries of what the merchant considers the same logical charge) and includes it with the request. The payment service's very first action is a lookup against the durable idempotency store: `has this key been recorded before?`

* If no: the payment service atomically records the key as "in progress" (this atomicity matters — two concurrent requests with the same brand-new key must not both proceed to charge the gateway; the store needs to guarantee only one of them wins the insert, with the other blocking or reading the winner's eventual result), then proceeds to call the gateway
* If yes, and the prior attempt reached a terminal state (succeeded/failed): return the previously recorded outcome immediately, without calling the gateway again — this is what makes retrying always safe from the merchant's point of view, no matter how many times a request is resent
* If yes, but the prior attempt is still "in progress" (a genuinely concurrent retry racing the original, still-inflight request): the safest response is to have the caller wait or poll, since concluding failure and letting a second gateway call proceed reintroduces exactly the double-charge risk idempotency exists to prevent

This is the single most load-bearing mechanism in the whole design, and it's why Step 1 states correctness as more important than raw throughput: every other component in this system exists to support this guarantee reliably, not to make it faster at the expense of weakening it.

### Use case: Service coordinates with an external payment gateway/processor

The call to the external gateway is the one step in this workflow this system doesn't fully control — it can be slow, it can time out, and worst of all, a timeout is genuinely ambiguous: the gateway may have processed the charge successfully and the *response* was lost, or the charge may never have reached the gateway at all, and from the payment service's side these look identical. This ambiguity is exactly why the ledger write recording "processing" happens *before* the gateway call, not after: if the payment service crashes or the gateway call times out with no clear answer, there's a durable, already-committed record that a charge was attempted against this idempotency key, and a recovery process can follow up — querying the gateway for the actual outcome of that specific attempt (most gateways support exactly this kind of reconciliation query, keyed by a reference ID the payment service generates and passes along) rather than blindly retrying and risking a duplicate charge.

This reconciliation step is a small, deliberate exception to "always trust the idempotency store": on ambiguous gateway timeout, the system's next move is to *ask the gateway what actually happened* before deciding the outcome to record, rather than guessing. Only once that's resolved does the ledger transition to a terminal status and the idempotency store gets the outcome that future retries will be served.

### Use case: Multi-step payment workflow stays consistent (reserve, charge, record)

A payment often isn't a single atomic action even internally — a fuller workflow might validate the order, reserve the amount, call the gateway, and then update order status in a separate order-management system entirely. These steps can span services with their own databases, and holding a distributed lock across all of them for the duration of an external gateway call (which, per Step 1, can take seconds) is exactly the scenario [Two-Phase Commit](/docs/patterns/consistency/two-phase-commit) handles poorly — its blocking coordinator model assumes fast, tightly-coupled participants, not a slow external dependency this system doesn't control the latency of.

Instead, this workflow is a natural fit for the [Saga](/docs/patterns/consistency/saga) pattern: each step (reserve order amount, charge via gateway, mark order paid) is its own local transaction, committed independently, with an explicit compensating action defined for each — if the gateway charge fails after an order amount was reserved, the compensation releases that reservation, rather than leaving it held against a payment that never completed. This mirrors the checkout example [Saga](/docs/patterns/consistency/saga) itself uses, and the reason it fits payments specifically is the same reason it doesn't fit here as cleanly for the *idempotency* problem: a saga's compensations handle "how do we undo a partially-completed multi-step workflow," which is a different question from "how do we guarantee a single step, the gateway charge, only ever happens once" — idempotency and sagas solve adjacent but distinct problems, and this design needs both: idempotency to make the charge step itself safe to retry, and a saga to keep the surrounding multi-step workflow consistent when some later step fails after the charge already succeeded.

One step in this saga deserves special attention: **a successful gateway charge has no clean compensating action** in the way "release a reservation" does — refunding money is a real, externally visible, and sometimes non-instant action, not a silent internal rollback, and it may fail or be delayed itself. This is precisely the "no meaningful compensating action" edge case the saga pattern itself calls out, and it's why a completed charge that later needs to be undone (a downstream step failed, an order was fraudulent) is modeled as its own explicit, auditable **refund** operation — described next — rather than an automatic, invisible saga compensation.

### Use case: Merchant queries payment status

Because every payment's state transitions are written durably to the ledger before being acted on or reported (per the use cases above), answering "what's the status of payment X" is a simple, strongly-consistent read against the ledger keyed by `payment_id` or `idempotency_key` — there's no separate status-tracking subsystem to keep in sync, since the ledger *is* the source of truth for status by construction. This is worth contrasting with most other systems in this course, where the read path is heavily cached and only eventually consistent with the write path — here, a merchant checking payment status needs the actual current truth, not a recent approximation, since a stale "processing" status when the payment actually already failed could lead a merchant to ship an order that was never paid for.

### Use case: Service supports refunds against a completed payment

A refund is deliberately modeled as its own new, explicit, idempotent operation — not a mutation of the original payment record — for the same durability and auditability reasons the ledger never overwrites records in place. A refund request carries its own idempotency key (so a retried refund request doesn't double-refund the customer, exactly mirroring the original charge's idempotency handling), references the original `payment_id` it's refunding, and is recorded as a new ledger entry linked to that original payment, so the ledger's history reads as "charged, then refunded" rather than losing the fact that a charge ever happened. This also naturally supports partial refunds and multiple refund attempts against the same payment without ambiguity about what the "current" state of a payment even means — the ledger is a sequence of linked, immutable events, and current status is whatever's derived from reading that sequence, similar in spirit to how this course's Google Docs case study treats an edit history log, not the latest snapshot alone, as the authoritative record.

## Step 4: Scale the design

![Payment System scaled architecture](/img/case-studies/payment-system-scaled.svg)

**The idempotency store needs strong consistency, not just high availability, because its entire job is preventing a race between two concurrent attempts at the same logical charge.** A key-insertion check that can return "not found" to two simultaneous requests for the same new key, letting both proceed to charge the gateway, defeats the mechanism entirely — so this component is deliberately built for correctness under concurrent writes to the same key (a conditional, atomic insert) rather than optimized purely for horizontal read throughput the way this course's more read-heavy case studies' hot paths are. Given the comparatively low request volume Step 1 calculates (under a thousand/sec even at peak), this is a reasonable place to spend consistency budget that a much higher-throughput system couldn't as easily afford.

**The ledger scales by sharding on `payment_id` (or merchant_id), since almost every read and write is scoped to a single payment or a single merchant's payments, not queried across the whole dataset** — see [Sharding](/docs/patterns/storage/sharding). Because the ledger is append-heavy with no in-place mutation, this avoids the write-contention concerns a frequently-updated-in-place data model would introduce under sharding.

**The gateway integration is the natural place for [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) and [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff), applied carefully.** A struggling or unresponsive gateway shouldn't be hammered with retries that make its own recovery harder, and a circuit breaker that trips after repeated failures protects both sides — but retries against the gateway call specifically must never bypass the idempotency and reconciliation logic in Step 3, since a naive "retry the whole request" without checking the idempotency store first is exactly the double-charge bug this entire design exists to prevent. The retry target here is "retry checking what happened," not "retry blindly re-attempting the charge."

**Ledger writes and idempotency-key checks are on the critical path and are not deferred to an asynchronous queue the way, say, a click-count increment might be elsewhere in this course** — because the correctness guarantee this design makes depends on the ledger reflecting "processing" *before* the gateway is called, not eventually, that specific write cannot be made asynchronous without reopening the exact ambiguity window Step 3 works to close. This is a deliberate divergence from the "keep writes off the hot path" instinct that shows up in several other case studies in this course (WhatsApp's presence updates, TinyURL's click counts) — those are recoverable, best-effort counters; a payment's status transition is not.

**Read replicas serve the status-query use case at scale without touching the primary ledger's write path**, since status reads (Step 3) vastly outnumber the payment writes themselves in most systems (merchants and support tooling checking on a payment far more often than the payment itself is created) — see [Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication), with the caveat that a status check immediately following a just-submitted payment may need to read from the primary or tolerate a brief replication lag, since a merchant polling status right after submission is exactly the case where staleness is most visible and least acceptable.

## Additional talking points

* **Why idempotency and sagas are both necessary and neither is a substitute for the other.** It's tempting to think a saga's compensating actions handle "safety" broadly, but a saga only handles *undoing a multi-step workflow after a later step fails* — it says nothing about what happens if the same charge step is invoked twice due to a retry. Conversely, idempotency alone handles "this exact operation happens once" but says nothing about coordinating multiple different operations (reserve, charge, mark-paid) across services. This design needs idempotency *within* the charge step and a saga *around* the multi-step workflow the charge step is part of — they operate at different granularities and solve different problems.
* **Why this design doesn't reach for two-phase commit even though "exactly once" sounds like a strict-atomicity problem.** The instinct to reach for [Two-Phase Commit](/docs/patterns/consistency/two-phase-commit) when correctness matters this much is understandable, but 2PC's blocking coordinator model assumes participants that can hold locks for a bounded, short window — an external gateway call that can legitimately take seconds and that this system doesn't control the failure modes of is precisely the case 2PC's own "when not to use it" guidance rules out. Idempotency plus a saga achieves the needed correctness without requiring the gateway to participate in a distributed locking protocol it was never built to support.
* **Reconciliation as an ongoing background process, not just a failure-path afterthought.** Beyond handling ambiguous timeouts inline, a production payment system typically runs periodic reconciliation jobs that compare its own ledger against the gateway's own record of settled transactions, to catch any drift (a payment the ledger thinks failed that the gateway actually settled, or vice versa) that pure request-time handling might miss — a defense-in-depth layer on top of, not a replacement for, the request-time idempotency and reconciliation logic in Step 3.
* **Fraud detection and risk scoring** are a substantial system in their own right, deliberately out of scope here — but worth naming as a real component that would sit in front of or alongside the charge flow in a production system, typically evaluated before the gateway call is made so an obviously fraudulent request never reaches the point of moving money at all.
