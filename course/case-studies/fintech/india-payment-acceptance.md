---
title: "Design Merchant Payment Acceptance (UPI QR & Soundbox)"
sidebar_position: 11
---

The defining property of merchant payment acceptance at the edge is that the acceptance device must cost almost nothing, work where the network barely works, and give the merchant a trustworthy confirmation without ever putting the merchant on the money path. A card terminal solves acceptance by being an expensive, always-online endpoint that both authorizes and confirms; India inverted that. A printed QR code and a small speaker replaced the terminal by pushing money movement onto the free, interoperable UPI rails and reducing the merchant's own device to a one-way audio confirmation channel. That split — money moves bank-to-bank over rails the merchant never touches, while a cheap box independently announces "you were paid" — is the constraint that shapes every decision below. The hard part is not moving the money (UPI already does that); it is delivering an audible, exactly-once, near-real-time confirmation to a battery-powered box on a patchy 2G link, at a scale of tens of millions of devices, without ever announcing a payment that did not actually settle.

This case study builds directly on top of [UPI — Real-Time Payments](/docs/case-studies/fintech/upi-real-time-payments). It does not re-derive how UPI moves money between banks — it treats the UPI switch as the rail underneath and designs the *acceptance edge*: the merchant QR that encodes where money should go, and the soundbox that tells the merchant it arrived.

## Step 1: Outline use cases and constraints

### Use cases

#### We'll scope the problem to handle the following use cases

* A **merchant** displays a **printed static QR code** that encodes their **VPA** (virtual payment address, e.g. `chaiwala123@paytm`), and a **customer** pays by scanning it with any UPI app, entering an amount, and approving with their UPI PIN
* The system also supports a **dynamic QR** for a specific bill, where the amount (and a per-order reference) are pre-encoded so the customer does not type the amount
* When the payment settles over UPI, the **acceptance platform** (an acquirer such as the one this device pioneered) receives a **paid event**, deduplicates it, resolves which merchant device should be told, and delivers an audible confirmation to the merchant's **soundbox**
* The **soundbox** — a cheap IoT device with a SIM (4G with 2G fallback), a speaker, a battery, and multi-language audio — announces the received amount within a couple of seconds, so the merchant need not watch a phone
* Notification delivery is **resilient to flaky networks**: a push that fails is retried, the device also **polls** as a fallback, and confirmations that could not be delivered while offline are **queued and spoken on reconnect**
* Each paid event is announced **exactly once** — a duplicated callback or a redelivered queue message never produces two audio confirmations for one payment
* A merchant is **onboarded** by binding a device to their VPA, and the merchant is **settled** the money into their bank account per the underlying UPI settlement
* The economics are near-zero: no card terminal, negligible per-transaction cost, so the design must scale acceptance to tens of millions of small merchants

#### Out of scope

* The internals of how UPI authorizes and settles a transfer between two banks — that is the [UPI case study](/docs/case-studies/fintech/upi-real-time-payments); here the UPI switch is an upstream dependency that emits a paid event
* The merchant's core banking / current account and how the bank posts the credit — an external dependency
* Merchant lending, insurance, and the broader "merchant operating system" built on top of the payment data — named in the talking points, not designed
* Consumer-side wallet balances and card-on-UPI rails — the design assumes a bank-account-backed UPI payment
* Fraud scoring and dispute resolution beyond a brief mention
* The device's electrical/firmware bring-up and OTA update mechanics beyond the notification and offline-queue behavior

### Constraints and assumptions

#### State assumptions

* On the order of **tens of millions of merchant devices** are deployed, collectively taking on the order of **billions of merchant transactions per month**
* A confirmation must be **audibly delivered exactly once**: never zero times for a real settled payment (the merchant would distrust the box), and never twice for one payment (a phantom second sale)
* A confirmation must **never be announced for a payment that did not actually settle** — the audio is downstream of a confirmed UPI paid event, never speculative
* End-to-end confirmation latency target is **a couple of seconds** from settlement to audio on a healthy network, degrading gracefully to "spoken on reconnect" on a broken one
* The merchant device is often on **2G / intermittent connectivity** and is **battery-powered**, so the delivery protocol must tolerate long gaps and minimize chatty polling
* The merchant is frequently **not online at all** on their own phone; the soundbox's SIM is the only connectivity that matters for confirmation
* Availability is effectively 24×7 nationally; a fleet-wide notification outage is a trust event across millions of small merchants at once
* The acceptance platform **does not hold or move the merchant's money** — settlement happens on the UPI rails to the merchant's bank; the platform's authoritative job is event ingest, device delivery, and reconciliation

#### Calculate usage

* Payment-event volume: assume **3,000,000,000 merchant payments/month** → 3,000,000,000 / 30 / 86,400 ≈ **~1,160 events/sec average**. Traffic is sharply peaked around mornings, evenings, and festival days — design for roughly **5x average at peak**, so on the order of **~5,800 paid events/sec** into the ingest tier.
* Notification fan-out is **one confirmation per paid event** (one merchant, one device), so the notification queue and IoT gateway carry the same ~1,160/sec average, ~5,800/sec peak — but each delivery may involve **several attempts** (push, retries, a poll response), so budget on the order of **2–4x** message operations, i.e. **~15,000–23,000 delivery operations/sec** at peak.
* Event record size: a paid-event record (`upi_txn_id`, `rrn`, merchant VPA, device id, `amount_paise`, `status`, `delivered_at`, timestamps) ≈ **~300 bytes/record** → 3,000,000,000/month × 300 bytes ≈ **~900 GB/month**, **~10.8 TB/year** of event log — large enough that the store shards and tiers to cold storage, and reconciliation runs as a distributed job.
* Device registry: **tens of millions of rows** (device id ↔ merchant VPA ↔ auth token ↔ preferred language), read on nearly every delivery to resolve VPA → device → language. This is read-heavy and cacheable within a validity window, but a stale binding must never route a confirmation to the wrong merchant's box.
* Poll fallback load: if a device polls every, say, 30 seconds when it suspects a missed push, tens of millions of devices polling would be **millions of polls/sec** if done naively — so polling must be **infrequent, jittered, and mostly suppressed** when push is healthy, or it becomes the dominant load rather than a fallback.
* Cost envelope: the whole point is near-zero acceptance cost. The device is on the order of a few hundred rupees (a few US dollars) of hardware, the QR is a few rupees of printing, and the per-transaction cost on UPI person-to-merchant rails has historically been effectively zero MDR (merchant discount rate) for the merchant — so the system is optimized for **cost-per-merchant at the edge**, not for extracting a per-transaction fee.

## Step 2: Create a high-level design

![Merchant payment acceptance overview: a customer scans a merchant QR that encodes the payee VPA, pays over UPI rails which credit the merchant bank, while the acquirer platform receives the paid event, dedupes it, resolves the device, and pushes a notification to the soundbox that speaks the confirmation](/img/case-studies/fintech/india-payment-acceptance-overview.svg)

The flow splits cleanly into two independent legs: a **money leg** the platform does not sit on, and a **confirmation leg** the platform owns entirely.

On the money leg, the merchant displays a **static QR** that encodes only their **VPA**. A customer opens any UPI app, scans it, types an amount, and approves with their UPI PIN. From there it is an ordinary UPI push transfer: the customer's app hands the request to the UPI switch, which orchestrates a debit at the customer's bank and a credit at the merchant's bank, exactly as the UPI case study describes. The merchant needs no smartphone, no card terminal, and does not even need to be online — the money moves bank-to-bank over rails the merchant's device never touches. This is why acceptance costs almost nothing: the expensive, always-online authorizing endpoint that a card terminal had to be simply does not exist here.

On the confirmation leg, once that UPI transfer settles, the **acquirer platform** learns of the paid event (as the merchant's payment service provider it receives a settlement callback for transactions landing on the VPAs it sponsors). The platform's job now is narrow and specific: verify the event is genuine, **deduplicate** it against the same `upi_txn_id` the switch used, look up which physical **soundbox** is bound to that merchant's VPA and in what language, and deliver an audible confirmation to that box within a couple of seconds. The **soundbox** receives the push over its own SIM (4G, falling back to 2G) and speaks the amount aloud. If the box was offline, the confirmation waits in a queue — on the platform side for redelivery, and in the device's own local buffer — so it is spoken as soon as the box reconnects, never dropped and never spoken twice.

Two structural facts drive the rest of the design. First, **the audio is strictly downstream of a real settlement** — the platform never announces a payment speculatively, because a soundbox that occasionally lies is worse than useless to a merchant who is using it *instead of* checking a phone. Second, **the confirmation channel is a separate, best-effort-but-exactly-once delivery problem layered on top of UPI's already-correct money movement** — the platform is not a payment processor here; it is an event-ingest-and-device-delivery system with hard exactly-once and freshness requirements at the edge.

## Step 3: Design core components

### Use case: The merchant QR encodes a payee VPA as a UPI deep link

The QR is the entire acceptance surface, and it is deliberately dumb: a static QR encodes a **UPI deep link** — a `upi://pay?...` URI carrying the payee's VPA and display name, and nothing that changes per transaction. Any UPI app knows how to parse this link (all PSP apps are required to handle `upi://` links), which is exactly why a QR printed once by one company can be paid by every other company's app. A dynamic QR is the same link with the amount and a per-order reference pre-filled, so the customer does not type the amount.

**Core spec: building and parsing the UPI deep link the QR encodes**

```python
from urllib.parse import urlencode, urlparse, parse_qs
from decimal import Decimal, ROUND_HALF_UP

def build_upi_qr_link(payee_vpa: str, payee_name: str,
                      amount_rupees: str | None = None,
                      txn_ref: str | None = None,
                      note: str | None = None) -> str:
    """Build the upi://pay deep link that a merchant QR encodes.

    A STATIC merchant QR passes only pa (payee address/VPA) and pn
    (payee name): the customer's app lets them type the amount. A
    DYNAMIC QR additionally fixes am (amount) and tr (a unique txn
    reference for that bill) so the customer confirms rather than
    types. cu is the currency, always INR on UPI. Per the NPCI UPI
    linking spec, am must be a decimal string with exactly two places.
    """
    if "@" not in payee_vpa:
        raise ValueError("malformed VPA: expected handle@psp")

    params = {"pa": payee_vpa, "pn": payee_name, "cu": "INR"}
    if amount_rupees is not None:
        # Force exactly two decimal places, e.g. "500" -> "500.00".
        amt = Decimal(amount_rupees).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        if amt <= 0:
            raise ValueError("amount must be positive")
        params["am"] = f"{amt}"
    if txn_ref is not None:
        params["tr"] = txn_ref          # unique per dynamic-QR bill
    if note is not None:
        params["tn"] = note             # short transaction note
    # urlencode keeps the payload compact so the QR stays low-density
    # and scannable on cheap cameras in poor light.
    return "upi://pay?" + urlencode(params)


def parse_upi_qr_link(link: str) -> dict:
    """Parse a scanned upi://pay link back into its fields. The paying
    app runs the equivalent locally: it validates pa, shows pn for the
    human to confirm, and only then collects the PIN -- so a malformed
    or tampered link fails before any money is staged.
    """
    parsed = urlparse(link)
    if parsed.scheme != "upi" or parsed.netloc != "pay":
        raise ValueError("not a UPI pay deep link")
    q = parse_qs(parsed.query)
    payee_vpa = q.get("pa", [""])[0]
    if "@" not in payee_vpa:
        raise ValueError("deep link missing a valid payee VPA")
    return {
        "payee_vpa": payee_vpa,
        "payee_name": q.get("pn", [""])[0],
        "amount_rupees": q.get("am", [None])[0],   # None for a static QR
        "txn_ref": q.get("tr", [None])[0],
        "currency": q.get("cu", ["INR"])[0],
        "note": q.get("tn", [None])[0],
    }
```

A static merchant QR therefore encodes something as small as `upi://pay?pa=chaiwala123@paytm&pn=Chai%20Point&cu=INR`, while a dynamic one for a ₹500 bill adds `&am=500.00&tr=BILL-4821`.

**Data structures:** the QR itself is stateless — it is just the encoded link. The durable state behind it is a `merchant_qr` row: `qr_id`, `payee_vpa`, `payee_name`, `qr_type` (`static`/`dynamic`), `created_at`, and (for dynamic) the `tr` to bill mapping. For a static QR that whole row is written once at onboarding and never changes.

**Trade-offs:**
* **The gotcha:** a static QR carries no amount, so the customer types it — and a mistyped or maliciously-overprinted QR (a fraudster pasting their own QR over the merchant's) sends money to the wrong VPA entirely, which no downstream check can undo because the payment was correct as instructed. The mitigations are that the paying app must **display the resolved payee name (`pn`) for the human to confirm before the PIN**, that merchant VPAs used for acceptance are verified-merchant handles (so the confirm screen shows a real business name, not a stranger), and that the merchant periodically checks the printed QR is still their own. The design keeps the QR dumb precisely so the *trust* is anchored in the app's confirm-the-payee step and the verified VPA, not in the paper.
* Keeping the amount off a static QR is what makes one printed sheet reusable forever; a dynamic QR trades that reusability for not having the customer type the amount, which matters for larger, error-prone bills. Both are the same deep link, so one code path builds and parses both.

### Use case: The platform ingests the UPI paid event exactly once

When the UPI transfer to a merchant VPA settles, the platform receives a **paid event** — a signed callback (a webhook from the switch/sponsor bank) carrying the same `upi_txn_id` and `rrn` the UPI switch used. At billions of events a month over an unreliable network, these callbacks **duplicate and reorder**: the switch retries a callback it did not get an ack for, so the platform must treat the paid event as at-least-once and make its own processing exactly-once. This is the same [Idempotency](/docs/patterns/reliability/idempotency) discipline the UPI switch applies to a transfer, now applied to the *confirmation* pipeline so one settlement yields exactly one audio announcement.

**Core spec: signature-verify then claim-or-replay on the transaction id**

```sql
CREATE TABLE paid_events (
    upi_txn_id     VARCHAR(64) PRIMARY KEY,   -- the switch's id; the dedupe key
    rrn            VARCHAR(24) NOT NULL,       -- retrieval reference number
    merchant_vpa   VARCHAR(255) NOT NULL,
    amount_paise   BIGINT      NOT NULL,       -- integer paise, never a float
    device_id      VARCHAR(64),                -- resolved bound device, if any
    status         VARCHAR(24) NOT NULL,       -- 'INGESTED','QUEUED','SPOKEN','UNDELIVERABLE'
    received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at   TIMESTAMPTZ
);
```

```python
import hmac, hashlib

def ingest_paid_event(raw_body: bytes, signature: str, signing_key: bytes,
                      event: dict, store, queue, registry) -> dict:
    """Verify a UPI paid-event callback, then claim-or-replay on its
    upi_txn_id so a duplicated callback never enqueues a second audio.

    Returns the action taken so the caller can ack the webhook either
    way -- a duplicate is a SUCCESS to the sender (please stop retrying),
    not an error.
    """
    # 1. Authenticity: reject anything not signed by the switch/sponsor.
    expected = hmac.new(signing_key, raw_body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise PermissionError("bad paid-event signature")

    txn_id = event["upi_txn_id"]

    # 2. Exactly-once claim: first writer wins the primary key; a
    #    duplicate callback loses the insert and replays the stored row.
    inserted = store.execute(
        """
        INSERT INTO paid_events (upi_txn_id, rrn, merchant_vpa, amount_paise, status)
        VALUES (%s, %s, %s, %s, 'INGESTED')
        ON CONFLICT (upi_txn_id) DO NOTHING
        RETURNING upi_txn_id
        """,
        (txn_id, event["rrn"], event["merchant_vpa"], event["amount_paise"]),
    )
    if not inserted:
        return {"action": "duplicate_ignored", "upi_txn_id": txn_id}

    # 3. Resolve the bound device and enqueue exactly one confirmation.
    binding = registry.resolve_device(event["merchant_vpa"])
    if binding is None:
        store.set_status(txn_id, "UNDELIVERABLE")
        return {"action": "no_device_bound", "upi_txn_id": txn_id}

    store.set_device(txn_id, binding.device_id)
    queue.publish(partition_key=binding.device_id, message={
        "upi_txn_id": txn_id,
        "device_id": binding.device_id,
        "amount_paise": event["amount_paise"],
        "language": binding.language,
    })
    store.set_status(txn_id, "QUEUED")
    return {"action": "queued", "upi_txn_id": txn_id, "device_id": binding.device_id}
```

**Data structures:** `paid_events` above is the durable exactly-once anchor for the confirmation pipeline, keyed by the switch's `upi_txn_id` so it deduplicates against the exact identity the money movement used. Amounts are **integer paise**, never floating point, so the announced figure can never drift from the settled figure.

**Trade-offs:**
* **The gotcha:** the tempting design is to speak the confirmation the moment the callback arrives, before any durable claim — but then a duplicated callback speaks twice, and a crash between "spoke" and "recorded" speaks again on retry. The fix is to make the **`upi_txn_id` the dedupe key and claim it atomically before enqueueing**, so the audio is driven off a durably-claimed event, and every later stage (queue, IoT gateway, device) also carries that id so it can dedupe again. Exactly-once audio at the edge is built from at-least-once delivery plus deduplication at every hop, never from assuming any single hop delivers once.
* Acking a duplicate as success (rather than erroring) is deliberate: the switch is doing the right thing by retrying an unacked callback, and the platform's job is to absorb that safely and tell it to stop, not to treat a healthy retry as a failure.

**REST API:**

```
$ curl -X POST https://acquirer.example/api/v1/upi/paid-events \
    -H "X-Signature: 4b1e...c9" \
    -H "Content-Type: application/json" \
    -d '{
          "upi_txn_id": "UPI9c2f10merch44821",
          "rrn": "551234567890",
          "merchant_vpa": "chaiwala123@paytm",
          "amount_paise": 50000
        }'
```

Response:

```json
{
  "action": "queued",
  "upi_txn_id": "UPI9c2f10merch44821",
  "device_id": "sb_5f21a8"
}
```

### Use case: A soundbox is bound to a merchant VPA at onboarding

Before any confirmation can be delivered, the platform must know which physical box speaks for which merchant. Onboarding **binds** a device to a merchant's VPA: the merchant registers, the device is activated with a one-time code, and the platform records a binding plus a per-device auth token the box will present on every poll. This binding is the routing table the ingest step consults, and getting it wrong routes a real merchant's confirmation to a stranger's box — so it is treated as security-sensitive, not mere configuration.

**Core spec: device binding and token issuance**

```python
import secrets

def bind_device(registry, merchant_vpa: str, device_serial: str,
                activation_code: str, language: str) -> dict:
    """Bind a physical soundbox to a merchant VPA and mint a device
    auth token. The activation code is a one-time secret printed on the
    box / shown in the merchant app, so possession of the box plus the
    merchant's authenticated session are both required to bind -- a
    device cannot be silently rebound to another merchant.
    """
    if not registry.verify_activation(device_serial, activation_code):
        raise PermissionError("invalid or already-used activation code")

    # One active binding per device: rebinding revokes the old token,
    # so a resold or reassigned box can never keep speaking for its
    # previous merchant.
    device_id = registry.device_id_for(device_serial)
    device_token = secrets.token_urlsafe(32)
    registry.upsert_binding(
        device_id=device_id,
        merchant_vpa=merchant_vpa,
        device_token_hash=_hash(device_token),
        language=language,
        status="ACTIVE",
    )
    registry.consume_activation(device_serial, activation_code)
    # Token is returned once, in plaintext, to be provisioned onto the
    # device; only its hash is stored, so a registry leak can't drive
    # the fleet.
    return {"device_id": device_id, "device_token": device_token}


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()
```

**Data structures:** a `device_bindings` row — `device_id` (PK), `merchant_vpa`, `device_token_hash`, `language`, `status` (`ACTIVE`/`REVOKED`), `bound_at`. The ingest step's `registry.resolve_device(merchant_vpa)` reads this (through a short-TTL cache) to find the target `device_id` and `language`; the IoT gateway checks `device_token_hash` to authenticate a polling box.

**Trade-offs:**
* **The gotcha:** if the VPA → device binding is cached aggressively for speed, a rebinding (merchant swaps a broken box, or a device is reassigned) can leave a stale mapping that keeps announcing the merchant's payments on the *old* box — which, if that box was resold, leaks the merchant's takings to someone else. The fix is a **short cache TTL plus explicit invalidation on rebind**, and treating the registry (not the cache) as authority: a rebind revokes the old token immediately, so even a briefly-stale route cannot authenticate the old device on its next poll.
* Storing only the token *hash* (never the plaintext) means a registry compromise cannot be replayed to impersonate the fleet — the same reasoning a password store uses, applied to device credentials.

### Use case: Deliver the confirmation with push, poll fallback, and dedupe

This is the heart of the edge problem. The platform has a durably-claimed paid event and a target device; it must get an audible confirmation onto a battery-powered box on a possibly-terrible link, within seconds when the link is healthy, and eventually-but-exactly-once when it is not. The design is **push-first with a poll fallback**, every message carries the `upi_txn_id` so the device can dedupe, and undelivered messages queue on both ends.

**Core spec: delivery with retry, poll fallback, and device-side dedupe**

```python
def deliver_confirmation(msg, iot_gateway, store, max_push_attempts=3):
    """Push a queued confirmation to a device with bounded retries.
    On exhausted push, leave it QUEUED so the device's own poll picks
    it up on reconnect -- delivery is never abandoned, only deferred.
    """
    for attempt in range(max_push_attempts):
        ack = iot_gateway.push(msg["device_id"], msg)   # over 4G/2G
        if ack.delivered:
            store.mark_spoken(msg["upi_txn_id"])
            return {"delivered": "push", "attempt": attempt + 1}
        iot_gateway.backoff_sleep(attempt)              # exp backoff + jitter
    # Push exhausted: the message stays QUEUED for this device. The box
    # will fetch it when it next polls (below); we do NOT drop it.
    return {"delivered": "deferred_to_poll", "upi_txn_id": msg["upi_txn_id"]}


def handle_device_poll(device_id, device_token, seen_ids, registry, store):
    """A soundbox polls when it reconnects or suspects a missed push.
    Returns any QUEUED confirmations the device has NOT already spoken.
    The device sends the ids it has already announced (seen_ids), so a
    confirmation delivered by BOTH a late push and a poll is spoken once.
    """
    binding = registry.authenticate(device_id, device_token)  # token hash check
    if binding is None:
        raise PermissionError("unknown or revoked device")

    pending = store.queued_for_device(device_id)  # status QUEUED, not yet spoken
    to_speak = [p for p in pending if p["upi_txn_id"] not in seen_ids]
    return {"confirmations": to_speak}


def on_device_spoke(store, upi_txn_id):
    """The device confirms it announced a payment. Idempotent: marking
    an already-SPOKEN event SPOKEN again is a no-op, so a retried ack
    never changes the outcome.
    """
    store.mark_spoken(upi_txn_id)   # UPDATE ... WHERE status != 'SPOKEN'
```

On the device itself, the box keeps a small **local queue** and a set of recently-spoken `upi_txn_id`s: it speaks a confirmation, records the id as spoken, and only then acks. If it receives the same id again (a late push after a poll already delivered it), it recognizes the id and stays silent. This is what turns "the network delivered this message one-or-more times" into "the merchant heard it exactly once."

**Data structures:** the platform reuses `paid_events.status` (`QUEUED` → `SPOKEN`) as the per-event delivery state, and the notification queue is **partitioned by `device_id`** so one merchant's confirmations stay ordered and a hot device cannot starve others. On the device, a bounded ring buffer of `(upi_txn_id, amount_paise, language)` plus a small set of spoken ids for dedupe.

**Trade-offs:**
* **The gotcha:** push and poll can *both* deliver the same confirmation (a push that actually arrived but whose ack was lost, then a poll that re-fetches the still-`QUEUED` event), which would announce one payment twice. The fix is **dedupe on `upi_txn_id` at the device**, not just at the platform: the box tracks spoken ids and the poll request sends `seen_ids` so the platform withholds anything already announced. Belt-and-suspenders on the same id at every hop is what makes exactly-once audio survive a network that delivers zero-or-many times per hop.
* Poll must be a **fallback, not a heartbeat**: with tens of millions of devices, naive frequent polling would dwarf the push load (see Step 1). So devices poll rarely and with jitter — mainly right after reconnecting or after a suspiciously long silence — and rely on push for the common case, which keeps both the network chatter and the battery drain low.
* Leaving an undelivered event `QUEUED` rather than failing it means a box that was off for hours still speaks every real payment on reconnect, in order — the merchant's trust depends on *no* real payment ever silently going unannounced, even if it is late.

**REST API (device poll):**

```
$ curl -X POST https://iot.acquirer.example/api/v1/devices/sb_5f21a8/poll \
    -H "X-Device-Token: <device-token>" \
    -H "Content-Type: application/json" \
    -d '{"seen_ids": ["UPI9c2f10merch44820"]}'
```

Response:

```json
{
  "confirmations": [
    {"upi_txn_id": "UPI9c2f10merch44821", "amount_paise": 50000, "language": "hi"}
  ]
}
```

### Use case: Reconcile spoken confirmations against bank settlement

The platform's audio path is downstream of a callback, and callbacks can be lost as well as duplicated. So the platform runs a standing **reconciliation** against the merchant bank's **settlement file** — the authoritative daily record of what actually credited each merchant — to catch any settled payment the platform never announced (a lost callback) or any announcement whose settlement it cannot find (which should never happen, and if it does, is a serious alert). This is the same reconcile-against-the-authoritative-record discipline the payment and UPI case studies use, applied to the confirmation pipeline.

**Core spec: settlement reconciliation**

```python
def reconcile_against_settlement(settlement_rows, store):
    """Compare the bank's settlement file (authoritative: money that
    actually credited each merchant) against the platform's paid_events.

    Two drift classes:
      * settled-but-never-spoken  -> a lost callback; enqueue a late
        confirmation so the merchant still hears it (better late than
        never), and record the recovery.
      * spoken-but-not-in-settlement -> the platform announced a payment
        the bank has no record of settling; this must never happen, so
        it is flagged for a human, not auto-resolved.
    """
    settled_ids = {r["upi_txn_id"] for r in settlement_rows}
    missing = []   # settled but the platform has no paid_event / never spoke
    phantom = []   # platform state exists for a txn not in settlement

    for r in settlement_rows:
        ev = store.get_event(r["upi_txn_id"])
        if ev is None or ev["status"] not in ("SPOKEN",):
            missing.append(r["upi_txn_id"])

    for ev in store.events_marked_spoken_on(day=settlement_rows_day(settlement_rows)):
        if ev["upi_txn_id"] not in settled_ids:
            phantom.append(ev["upi_txn_id"])

    for txn_id in missing:
        store.recover_and_requeue(txn_id)   # late but exactly-once (same id)
    return {"recovered": missing, "flagged_for_review": phantom}
```

**Data structures:** reuses `paid_events` plus an ingested `settlement` table (`upi_txn_id`, `merchant_vpa`, `amount_paise`, `settled_on`) loaded from the bank's daily file. Recovery re-enqueues on the *same* `upi_txn_id`, so a late confirmation still deduplicates against anything already delivered — reconciliation cannot itself cause a double announcement.

**Trade-offs:**
* **The gotcha:** a naive reconciler that re-sends every settlement row it cannot instantly match would spam merchants with duplicate late confirmations. Because recovery re-enqueues on the **same `upi_txn_id`**, the device's dedupe suppresses anything already spoken, so the reconciler is safe to run aggressively — it can only ever *add* a genuinely-missed announcement, never repeat a delivered one.
* Treating "spoken but not settled" as a hard human-review flag rather than an auto-fix is deliberate: it means the platform announced money that the bank did not settle, which is a correctness breach the whole design is built to make impossible, so it deserves an operator, not a silent retry.

## Step 4: Scale the design

![Merchant payment acceptance at scale: UPI paid callbacks enter an API gateway that verifies signatures and rate-limits, an ingest service claims each upi_txn_id exactly once and writes a sharded txn store, a notification queue partitioned by device feeds an IoT gateway that pushes over 4G and 2G with retries, a device registry resolves VPA to device bindings, the soundbox fleet keeps a local queue and poll fallback, and a reconciliation job checks against bank settlement files](/img/case-studies/fintech/india-payment-acceptance-scaled.svg)

* **The ingest tier shards by `upi_txn_id` (or device id) so no single node is on the path of all ~5,800 paid events/sec at peak** — see [Sharding](/docs/patterns/storage/sharding). Each event's exactly-once claim is scoped to one id, so that id is a natural shard key and the hot claim-or-replay path never needs a cross-shard transaction.
* **The exactly-once event store needs strong consistency, not just availability, because its whole job is to stop a duplicated callback from producing a second audio announcement** — a conditional insert that could return "not found" to two concurrent copies of the same callback would reintroduce the double-announce. This is a deliberate place to spend consistency budget, using an atomic conditional insert on `upi_txn_id` rather than an eventually-consistent cache. It is the [Exactly-Once Semantics](/docs/patterns/batch-streaming/exactly-once-semantics) problem, solved by dedup-on-a-stable-id rather than by trusting any hop to deliver once.
* **The paid-event callback is a [Webhook](/docs/patterns/communication/webhooks) the platform must treat as at-least-once**, so the ingest endpoint is idempotent and acks duplicates as success — see [Idempotency](/docs/patterns/reliability/idempotency). The API gateway in front verifies signatures, rate-limits, and sheds obvious abuse before it reaches ingest — see [API Gateway](/docs/patterns/api-edge/api-gateway).
* **Notification delivery is a queue-fed fan-out partitioned by device** — see [Distributed Message Queue](/docs/patterns/building-blocks/distributed-message-queue) and [Competing Consumers](/docs/patterns/batch-streaming/competing-consumers). Partitioning by `device_id` keeps one merchant's confirmations ordered while letting the IoT gateway scale horizontally across the fleet; [Queue-Based Load Leveling](/docs/patterns/batch-streaming/queue-based-load-leveling) absorbs the morning/festival peaks so a spike in settlements does not overwhelm the push tier.
* **Push to the device uses [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff), and a persistently unreachable device or a struggling regional link is isolated with a [Circuit Breaker](/docs/patterns/reliability/circuit-breaker)** so one dead cell tower's worth of boxes cannot tie up delivery threads for everyone else — the [Bulkhead](/docs/patterns/reliability/bulkhead) idea applied to device links. Confirmations that exhaust push are not dropped; they wait for the device's [poll fallback](/docs/patterns/communication/asynchronous-request-reply), an asynchronous request-reply the box initiates on reconnect.
* **The device registry (VPA → device binding) is a read-mostly lookup served from replicas with a short-TTL cache** — see [Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication). The tens-of-millions of daily resolutions vastly outnumber binding writes, but a rebind invalidates the cache and revokes the old token so a stale route can never authenticate a resold box.
* **Reconciliation runs as an independent batch off the hot path**, loading each merchant bank's daily settlement file and re-queuing any settled-but-unspoken event on its original id — a defense-in-depth layer that turns a lost callback into a late-but-exactly-once announcement without touching the real-time delivery path.

## Additional talking points

* **Why near-zero MDR is the whole reason this scaled.** A card terminal charged the merchant an upfront device cost plus a per-transaction merchant discount rate of a couple of percent; UPI person-to-merchant payments have historically carried effectively zero MDR for the merchant, so acceptance became a fixed, tiny hardware cost (a printed QR and an optional cheap box) rather than a running tax on every sale. A design built on paid rails would never have reached tens of millions of ₹500-a-day merchants — the economics, not the technology alone, are what made edge acceptance universal.
* **The soundbox exists to solve trust, not payment.** Money already moves correctly over UPI without the box; the box exists because a merchant serving a queue of customers cannot keep unlocking a phone to verify each SMS, and a missed or delayed SMS breaks trust in the whole system. The audio confirmation is a human-factors solution — an always-audible, hands-free, language-appropriate "you were paid" — layered on top of a payment rail that was already correct. Recognizing that the confirmation is a *separate delivery problem* from the money movement is the key architectural insight.
* **Exactly-once at the edge is built, never assumed.** No single hop — callback, queue, push, device — delivers exactly once. The system achieves exactly-once audio by carrying one stable identity (`upi_txn_id`) end to end and deduplicating on it at every hop, including on the battery-powered box itself. This is the [Exactly-Once Semantics](/docs/patterns/batch-streaming/exactly-once-semantics) pattern realized across an unreliable last mile, and it is why the device tracks spoken ids rather than trusting the network.
* **Static-QR fraud is a real threat with a product-level fix.** Because a static QR is just paper encoding a VPA, the attack is physical: paste your own QR over the merchant's, or trick a customer into a wrong VPA. No downstream ledger check can reverse a payment that was correct-as-instructed, so the defenses are upstream and human-visible — the paying app must show the verified merchant name before the PIN, acceptance VPAs are verified-merchant handles, and merchants are taught to spot a tampered QR. A practitioner must treat the paper as an untrusted input and anchor trust in the confirm-the-payee step.
* **Reconciliation is a standing process, not a failure afterthought.** Callbacks are lost as well as duplicated, so the platform continuously reconciles its spoken confirmations against the bank's authoritative settlement file — recovering late confirmations for lost callbacks (safely, on the same id) and hard-flagging any announcement it cannot tie to a real settlement. This is the same defense-in-depth the payment and UPI case studies apply, pointed at the confirmation pipeline rather than the money movement.
* **From acceptance device to merchant operating system.** Once a merchant relies on the box daily, the platform gains a trusted channel and a stream of transaction data, which is the foundation for merchant lending, working-capital, insurance, and analytics offered on top of the payment layer. That upsell is out of scope for the acceptance design here, but it is the reason the near-zero-margin device was worth deploying at all — the device is the wedge, the data and financial services are the business.

## Source(s) and further reading

* [Paytm — Wikipedia](https://en.wikipedia.org/wiki/Paytm) — company that pioneered the free static merchant QR and the soundbox for offline merchant acceptance in India, including the near-zero-cost onboarding model
* [Unified Payments Interface — Wikipedia](https://en.wikipedia.org/wiki/Unified_Payments_Interface) — the free, interoperable bank-to-bank rails the whole acceptance model is built on; operator (NPCI), VPA addressing, and person-to-merchant flow
* [NPCI UPI Linking Specifications v1.6 (PDF)](https://www.labnol.org/files/linking.pdf) — the UPI deep-link / `upi://pay` specification defining the `pa`, `pn`, `am`, `cu`, `tr`, `tn` parameters a merchant QR encodes, and the signing of intents (mirrored copy; NPCI's own site is bot-blocked, returning HTTP 403 to automated fetches)
* [BharatQR — Wikipedia](https://en.wikipedia.org/wiki/BharatQR) — the interoperable merchant QR standard context in which UPI QR acceptance sits
* [Paytm Soundbox — Paytm for Business](https://business.paytm.com/soundbox) — vendor description of the soundbox device: audio confirmation of received payments, SIM connectivity, battery, multi-language announcements
* [How does the Soundbox work — Paytm for Business support](https://business.paytm.com/support/how-does-the-soundbox-work) — vendor explanation of the QR-to-soundbox confirmation flow from the merchant's perspective
* [Merchant discount rate — Wikipedia](https://en.wikipedia.org/wiki/Merchant_discount_rate) — the per-transaction fee that card acceptance charged and that near-zero-MDR UPI acceptance displaced
* [Fast payments: design and adoption — BIS Quarterly Review, March 2024](https://www.bis.org/publ/qtrpdf/r_qt2403c.htm) — central-bank analysis situating UPI as a fast-payment system with alias-based addressing and its role in merchant adoption ([PDF](https://www.bis.org/publ/qtrpdf/r_qt2403c.pdf))
* [Design UPI — Real-Time Payments](/docs/case-studies/fintech/upi-real-time-payments) — the rail this acceptance edge is built on; how UPI moves money between banks exactly-once
* [Idempotency](/docs/patterns/reliability/idempotency) and [Exactly-Once Semantics](/docs/patterns/batch-streaming/exactly-once-semantics) — the dedupe-on-a-stable-id discipline that gives exactly-once audio at the edge
* [Webhooks](/docs/patterns/communication/webhooks) — the at-least-once paid-event callback the ingest tier consumes idempotently
* [Distributed Message Queue](/docs/patterns/building-blocks/distributed-message-queue) and [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff) — the device-partitioned notification fan-out and its bounded push retries
