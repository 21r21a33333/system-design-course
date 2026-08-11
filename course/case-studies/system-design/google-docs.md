---
title: "Design a Collaborative Document Editor (like Google Docs)"
sidebar_position: 18
---

Real-time messaging has to reliably deliver discrete messages to a specific recipient; a collaborative document editor has a different job entirely — many editors are mutating the *same* piece of shared, continuously-changing state at once, and every one of their screens has to converge on an identical result even though their edits arrive in different orders at different times. The hard problem here is conflict resolution and convergence, not delivery.

*Educative's Grokking Modern System Design Interview course covers this same system in its "Design a Collaborative Document Editing Service/Google Docs" module.*

## Step 1: Outline use cases and constraints

### Use cases

#### We'll scope the problem to handle the following use cases

* **User** opens a document and sees its current content along with other active editors' presence (who else is viewing/editing)
* **User** types, deletes, or otherwise edits text, and sees their own changes applied instantly, locally
* **User** sees other editors' concurrent changes appear in their own view within a short delay, converged into a single consistent document
* **User** sees other editors' live cursor positions and selections while co-editing
* **Service** persists the document durably so it survives a crash, a browser refresh, or all editors disconnecting
* **Service** lets a user view a document's edit history and revert to an earlier version
* **Service** has high availability; a brief network blip for one editor should not corrupt the document or block other editors from continuing to edit

#### Out of scope

* Rich formatting, embedded images/tables, and other non-plain-text content types (the design generalizes conceptually but is scoped to plain text editing for depth)
* Access control and sharing permissions beyond a passing mention
* Comments and suggestion-mode (track-changes) workflows
* Offline editing with extended, multi-day disconnection (this design assumes edits reconcile within a live or briefly-interrupted session, not after days offline)

### Constraints and assumptions

#### State assumptions

* 10 million documents actively edited (opened by at least one editor) on a given day
* A typical concurrent editing session has 2-5 simultaneous editors on the same document; a small number of documents (large team docs) may have dozens
* An active editor produces a keystroke-level edit roughly every 1-2 seconds while actively typing, not continuously across the whole session — most of a session's duration is reading, thinking, or idle, not typing
* Other editors' changes should be visible within a few hundred milliseconds under normal conditions — noticeably faster than "refresh to see updates," since the product's core value is *feeling* simultaneous, even though sub-100ms delivery (this course's WhatsApp case study's bar for message delivery) is not required for the editing experience itself to feel collaborative
* Every accepted edit must be preserved and must never be silently lost or silently overwritten by a concurrent edit — two editors typing in different parts of a document must both see their changes survive, not have one clobber the other
* All editors' clients must eventually converge on the exact same document content, even if edits from different editors arrive at the server (and at each other's clients) in different orders — this convergence guarantee, not raw delivery speed, is this design's central correctness requirement
* Document size is bounded to something a single editing session comfortably holds in memory client-side (comparable to a typical multi-page text document, not a book-length manuscript) — this design does not address documents too large to load in full

#### Calculate usage

* Edit-event volume: 10,000,000 documents/day × an average of 3 concurrent editors × assume an average active-editing duration of 10 minutes per editor per session with one edit roughly every 1.5 seconds while actively typing → 10,000,000 × 3 × (600s / 1.5s) = 10,000,000 × 3 × 400 = **12 billion edit events/day** → 12,000,000,000 / 86,400 ≈ **~140,000 edit events/sec average** — a large number, but each event is tiny (see below), which is the key sizing fact for this design: this is a high-*count*, low-*byte* write workload, structurally different from a system where the bottleneck is payload size
* Edit event size: a single edit operation (`doc_id`, `editor_id`, operation type — insert or delete —, position, character(s), a logical clock/version stamp) ≈ **~40-60 bytes** → at 140,000 events/sec average, that's roughly 140,000 × 50 bytes ≈ **~7 MB/sec average** of raw edit-event traffic system-wide — small in aggregate bandwidth terms; the challenge this design actually faces is event *ordering and merging* per document, not moving bytes
* Per-document edit rate: with an average of 3 concurrent editors each producing an edit roughly every 1.5 seconds, a single actively-edited document sees on the order of 2 edits/sec during active co-editing — a rate any single document's merge logic needs to handle comfortably, and one that stays low even generously multiplying by the dozens-of-editors case for a large team document, confirming that per-document conflict resolution, not aggregate system throughput, is the tighter constraint
* Document storage: assume an average document body of 20 KB of text, plus a retained edit history (needed for the version-history use case) of roughly 500 bytes/edit for a document with a typical lifetime edit count in the low thousands → 20 KB + (2,000 edits × 500 bytes) ≈ **~1 MB/document** including history → 10,000,000 active documents × 1 MB ≈ **~10 TB** for the actively-edited set — comfortably shardable, and not the pressure point this design centers on
* Presence/cursor updates: with 3 average concurrent editors per active document and cursor position changing far more often than actual text edits (roughly every few hundred milliseconds while a user is actively moving through the document), presence traffic can exceed edit-event volume several times over — but, like WhatsApp's presence data in this course's messaging case study, cursor position is inherently ephemeral and tolerates loss far better than an actual text edit does, so it's designed and scaled separately from the durability-critical edit path

## Step 2: Create a high-level design

![Google Docs high-level architecture](/img/case-studies/google-docs-overview.svg)

Each editing client holds a persistent connection to a **collaboration service**, since edits need to be pushed to every other active editor the moment they happen rather than polled for. When a client produces an edit, it applies that edit to its own local copy of the document immediately — the user sees their own typing with no round-trip latency at all — and asynchronously sends the edit to the collaboration service, which is responsible for the design's central job: taking edits that may have been produced concurrently, against different underlying document states, by different editors, and **transforming or merging them into one converged, consistent result** that every connected client ends up seeing identically, regardless of the order edits actually arrived in. Once an edit is merged, the service broadcasts it to every other active editor's client, which applies it to their local copy. A durable **document store** periodically persists the current merged state (and the edit history, for the version-history use case) so the document survives beyond any single session, and a **presence service** handles the much higher-volume, much lower-durability cursor and viewer-presence updates on a separate path.

This is the structural point where this design diverges most sharply from this course's WhatsApp case study, despite both being real-time, multi-client systems built on persistent connections. WhatsApp's collaboration service equivalent (its message service) never needs to *change* a message — it delivers an immutable payload to a specific recipient, and its hard problem is guaranteeing that delivery eventually happens even if the recipient is offline. This design's collaboration service actively transforms and reconciles the content of concurrent edits against each other before anyone sees them — there is no single "recipient," every connected editor is simultaneously a producer and a consumer of the same mutable shared state, and the correctness bar isn't "eventually delivered," it's "everyone's copy is byte-for-byte identical once all edits are accounted for."

## Step 3: Design core components

### Use case: User edits a document and sees others' edits converge into a single consistent state

This is the core problem the whole design exists to solve, so it's worth being explicit about why naively broadcasting raw edits doesn't work. Say two editors, both starting from the same document state, are looking at the string `"cat"`. Editor A inserts `"h"` after position 0 to spell `"chat"`. Concurrently, editor B — working from the same starting state, unaware of A's edit — deletes the character at position 2 (`"t"`) intending to turn `"cat"` into `"ca"`. If both edits are simply applied to each client in the order they happen to arrive, A's client (which sees its own edit first, then B's) and B's client (which sees its own edit first, then A's) can end up applying position-2-delete against *different* underlying strings — one against `"chat"`, one against `"cat"` — producing different final results on different screens. Naive last-write-wins or apply-in-receipt-order semantics don't just lose an edit here, they actively diverge the document.

**Core algorithm: operational transformation (OT)**

The fix is to make every edit position-aware relative to the state it was authored against, and to transform concurrent edits against each other so their positions stay correct no matter what order they're applied in — the general technique this design uses is known as **[operational transformation](https://en.wikipedia.org/wiki/Operational_transformation) (OT)**. This is a real, named design decision Google made publicly for Google Docs: rather than a peer-to-peer CRDT merge, Google Docs uses a server-authoritative OT model, where the collaboration service is the single point that transforms every incoming edit against whatever else has changed since that edit was authored, before applying it to the canonical document and broadcasting the transformed result. When the collaboration service receives an edit, it transforms that edit's position against every other edit that was concurrently accepted since the state the editor authored it against, adjusting (for example) "delete at position 2" to "delete at position 3" if a concurrent insert earlier in the document has since shifted what's actually at position 2.

```python
class InsertOp:
    def __init__(self, position, text, op_id):
        self.position = position
        self.text = text
        self.op_id = op_id  # tiebreak for equal-position concurrent inserts

    def __repr__(self):
        return f"InsertOp(pos={self.position}, text={self.text!r})"


def transform(op1, op2):
    """Classic OT transform: adjust op2's insertion position so that
    applying op1-then-transformed-op2 produces the same result as
    applying op2-then-transformed-op1 would, regardless of which
    order the two concurrent ops actually get applied in.

    Both op1 and op2 are assumed authored against the SAME base
    document state (i.e. genuinely concurrent, not sequential).
    Returns a new InsertOp equivalent to op2, with position adjusted
    for op1 having already been applied.
    """
    if op1.position < op2.position:
        # op1 inserted text strictly before op2's position -> op2 shifts right
        return InsertOp(op2.position + len(op1.text), op2.text, op2.op_id)
    if op1.position > op2.position:
        # op1 inserted after op2's position -> op2 is unaffected
        return InsertOp(op2.position, op2.text, op2.op_id)
    # Equal position: genuinely concurrent inserts at the same spot.
    # Break the tie deterministically (e.g. by op_id) so every client
    # picks the same ordering without needing to communicate further.
    if op1.op_id < op2.op_id:
        return InsertOp(op2.position + len(op1.text), op2.text, op2.op_id)
    return InsertOp(op2.position, op2.text, op2.op_id)


def apply_insert(document, op):
    return document[: op.position] + op.text + document[op.position :]
```

**Worked example — two concurrent inserts converging regardless of application order:**

```python
base = "The fox jumps."
# Editor A inserts "quick " at position 4 -> "The quick fox jumps."
op_a = InsertOp(position=4, text="quick ", op_id="A")
# Editor B, concurrently, inserts "lazy " at position 4 (same base doc)
# intending "The lazy fox jumps."
op_b = InsertOp(position=4, text="lazy ", op_id="B")

# Path 1: server applies A first, then transforms and applies B
doc1 = apply_insert(base, op_a)                 # "The quick fox jumps."
op_b_transformed = transform(op_a, op_b)        # shifted past "quick "
doc1 = apply_insert(doc1, op_b_transformed)     # "The quick lazy fox jumps."

# Path 2: server applies B first, then transforms and applies A
doc2 = apply_insert(base, op_b)                 # "The lazy fox jumps."
op_a_transformed = transform(op_b, op_a)        # op_b.pos(4) == op_a.pos(4);
                                                 # tiebreak by op_id: "A" < "B"
                                                 # so A is treated as "first"
                                                 # and NOT shifted here
doc2 = apply_insert(doc2, op_a_transformed)     # "The quick lazy fox jumps."

assert doc1 == doc2 == "The quick lazy fox jumps."
```

Both application orders converge on the identical final string, `"The quick lazy fox jumps."`, because `transform` makes each op's position self-consistent relative to whichever op is applied first, and the equal-position tiebreak (`op_id`) is deterministic and agreed on by every client — nobody has to communicate "which one went first," they just both compute the same answer independently. This convergence property (apply in any order, same result) is exactly what OT is required to guarantee, and it's what's being tested above, not just asserted in prose.

**Data structures:**
* `InsertOp` — `position` (int, offset into the document string), `text`, `op_id` (a per-op unique, totally-ordered identifier — e.g. `(logical_clock, editor_id)` — used only to break equal-position ties deterministically)
* An equivalent `DeleteOp` (`position`, `length`, `op_id`) exists for deletions, with its own transform rules (a concurrent insert before a delete's range shifts it forward; a concurrent delete overlapping another delete's range needs the overlap resolved so the same character isn't double-deleted) — omitted above for brevity, but following the identical shape: adjust position/length relative to whatever the other operation did

**Trade-offs:**
* **The gotcha — why OT over CRDT, specifically:** it's tempting to assume a CRDT (conflict-free replicated data type) is the more "modern" choice and stop there, but Google specifically chose server-authoritative OT for Google Docs, not a CRDT, and the reason is a real, load-bearing trade-off, not a historical accident. A CRDT approach assigns every individual character a stable, globally-comparable identifier (not just every edit — every character), so merging becomes fully commutative and associative without needing any central authority at all — real production systems like [Yjs](https://docs.yjs.dev/) and [Automerge](https://automerge.org/) do exactly this today. But that per-character metadata is a real, permanent memory and bandwidth cost that scales with document size, not edit count. OT keeps per-operation overhead small (an `InsertOp`/`DeleteOp` is a handful of fields, not a permanent per-character tag) and keeps client-side state simple (a client just needs the current text plus a version marker, not a full CRDT metadata structure) — at the cost of requiring a central transform authority, which this design already has in the collaboration service every client is connected to anyway for presence and broadcast. Given Step 1's document sizes and per-document edit rates, the "central authority" cost OT requires is cheaper to pay than the "per-character metadata forever" cost CRDTs require.
* Either way, the crucial design property is the same: an edit is never described as "delete the character at position 2" in a vacuum — it's always transformed and applied relative to a document state every party can agree on, which is what makes convergence provable (as demonstrated above) rather than merely likely.

### Use case: User's own edits appear instantly, before the round trip completes

Waiting for a server round trip before showing a user their own keystroke would make typing feel laggy in a way no amount of backend optimization can fix, since network latency is a hard floor. Instead, a client applies its own edit to its local document state immediately and optimistically, then sends it to the collaboration service asynchronously — the same **optimistic concurrency** shape used elsewhere in distributed systems, where a client proceeds as if its operation will succeed and reconciles after the fact if the server's transformed version differs from what the client assumed.

**Data structures:** no new server-side state; client holds its own local document copy plus a small outbound queue of not-yet-acknowledged `InsertOp`/`DeleteOp`s.

**Trade-offs:**
* Because OT guarantees the transformed edit converges to the same result the client already rendered (transformation only adjusts *position*, not the substance of what the user typed), reconciliation is rarely visible to the user — the local optimistic render and the eventually-confirmed server-transformed state agree in the overwhelming majority of cases, and only reconcile visibly on genuinely conflicting concurrent edits to the same region of text.

### Use case: User sees other editors' live cursor positions and selections

Cursor and selection state changes far more frequently than actual text content (Step 1's math puts it at several times the edit-event rate) and tolerates loss far better — a cursor position that's briefly stale or a dropped update is a cosmetic gap, not a correctness failure, unlike a lost text edit.

**Data structures:** presence entries keyed by `(doc_id, editor_id)` — `cursor_position`, `selection_range`, `updated_at` — held in-memory only, no durable log.

**Trade-offs:**
* This is handled on a separate path from document edits, through the same **presence service** shape this course's WhatsApp case study uses for online/last-seen state: no durable write-ahead requirement, a short-lived, frequently-overwritten value per editor rather than an accumulating log, broadcast to other active editors on the document over the same persistent connection used for edit delivery. Keeping this path structurally separate from the edit-merge path matters specifically because presence has no ordering or conflict-resolution requirement at all — the latest cursor position simply replaces the previous one — so routing it through the OT machinery built for text convergence would be needless overhead for data that doesn't need convergence guarantees, only recency.

### Use case: Service persists the document durably and supports version history

The collaboration service's in-memory, actively-converging document state is not itself the durability boundary — a **document store** periodically checkpoints the current merged state, and every accepted, transformed edit is also appended to a durable **edit history log** keyed by document.

**Data structures:** `edit_history` — `doc_id`, `op_id`, `op_type` (insert/delete), `position`, `payload`, `applied_at`, ordered by `op_id` within a document; `document_checkpoints` — `doc_id`, `snapshot_text`, `as_of_op_id`, `created_at`.

**Trade-offs:**
* The log serves two purposes: recovering the current state if the in-memory copy is lost (replay the log against the last checkpoint), and directly powering the version-history use case, since the log is already an ordered record of every change ever applied. This is the same append-then-checkpoint shape as [Write-Ahead Log](/docs/patterns/storage/write-ahead-log) and [Event Sourcing](/docs/patterns/storage/event-sourcing) — current state is a derived, periodically-materialized view over an authoritative log of changes, not the other way around, which is what lets "revert to an earlier version" be a read against history rather than a special-cased operation the rest of the system has to account for.

## Step 4: Scale the design

![Google Docs scaled architecture](/img/case-studies/google-docs-scaled.svg)

* **The collaboration service is naturally partitioned by document, and this is the single most important scaling decision in this design.** Every OT transformation for a given document only ever needs to consider other edits to that *same* document — edits to unrelated documents never conflict and never need to be transformed against each other — so the collaboration service shards by `doc_id`, with all active editors of a given document routed to the same shard for the duration of their session. See [Sharding](/docs/patterns/storage/sharding). This is a meaningfully different sharding rationale than this course's WhatsApp case study, which shards its pending-delivery store by recipient because every *read* is scoped to one user — here, the constraint is that every *transformation* is scoped to one document, and correctness (not just read efficiency) depends on all of a document's concurrent edits passing through the same transformation authority rather than being split across shards that would each only see a partial view of concurrent activity.
* **Because per-document edit rates are low even under Step 1's generous concurrent-editor assumptions (on the order of a few edits/sec per document), a single shard's transformation workload is cheap — the scaling challenge is the *number* of simultaneously active documents, not the throughput any one of them demands.** This means the collaboration tier scales primarily by running many shards in parallel across a large fleet, each handling a modest number of documents, rather than by optimizing any single shard's raw throughput.
* **The document store and edit history log scale by the same per-document sharding key**, keeping a document's full history and current state co-located with the shard doing its live transformation work, avoiding a cross-shard call on the hot edit path. Checkpointing (materializing current state from the log periodically, per Step 3) can run asynchronously and independently of the live editing path, playing the same "expensive aggregation work happens off the latency-critical path" role that [Materialized View](/docs/patterns/storage/materialized-view) plays in other read-heavy designs in this course, adapted here to a write-and-converge-heavy one.
* **Presence broadcast fans out to a small set of concurrently active editors per document (Step 1 assumes 2-5 typically), which is a trivially cheap fan-out compared to the large-audience fan-out problems this course's Instagram and YouTube case studies solve** — there's no push-versus-pull threshold decision needed here at all, since the audience for any single document's presence updates is always small by the nature of the product.
* **Reconnection after a network blip needs to resynchronize a client's document state against the server's, not just resume message delivery.** A client that reconnects sends the `op_id` of the last edit it successfully applied; the server responds with everything that's happened since, transformed relative to that baseline, letting the client catch up to the current converged state — a more involved handshake than WhatsApp's reconnect-and-drain-a-pending-queue flow, precisely because "what did I miss" here means "what transformations bring my state in line with everyone else's," not merely "what messages are waiting for me."

## Additional talking points

* **Why this design's hard problem is genuinely different from WhatsApp's, despite both looking like "real-time multi-client systems" at a glance.** WhatsApp's guarantee is about *delivery*: get this specific, immutable payload to this specific recipient, eventually, without loss. This design's guarantee is about *convergence*: many participants are concurrently mutating one shared piece of state, and the system has to make their independent, concurrently-authored changes compose into a single agreed-upon result — a problem WhatsApp never faces, because no two people are ever trying to modify the same message. The architectures share a persistent-connection transport, but the actual hard engineering problem underneath — transformation and merge logic versus queuing and retry logic — has almost nothing in common.
* **What happens when two editors edit the exact same character range simultaneously?** OT and CRDTs both guarantee *convergence* (everyone ends up seeing the same result), but convergence doesn't mean the result is what either user intended — a genuine same-position conflict resolves to some well-defined but essentially arbitrary outcome, exactly like the `op_id` tiebreak in `transform` above. This is worth stating honestly: the system's job is to guarantee everyone sees the *same* thing, not to guess the *right* thing when two people genuinely try to change the same word at the same instant.
* **Extending this design beyond plain text.** Structured content (formatting, embedded objects, tables) needs a much richer operation model than "insert/delete a character at a position" — the OT or CRDT machinery generalizes conceptually to richer document trees, but the transformation rules multiply in complexity with every new operation type that can conflict with every other type, which is exactly why this design scopes down to plain text for a tractable, complete treatment rather than a partial one.
* **Why not just lock the document (or a region of it) while one person edits, the way a traditional file lock would?** Locking sidesteps conflict resolution entirely, but it directly contradicts the product's core promise of simultaneous multi-editor collaboration — a lock that blocks a second editor from typing at all is a fundamentally different, more restrictive product than the one this design's use cases in Step 1 scope in.

## Source(s) and further reading

* [Operational transformation — Wikipedia](https://en.wikipedia.org/wiki/Operational_transformation) — the general technique this design's transform function implements
* [Conflict-free replicated data type — Wikipedia](https://en.wikipedia.org/wiki/Conflict-free_replicated_data_type) — the alternative approach this design explicitly weighs against and doesn't choose, and why
* [What's different about the new Google Docs: Conflict resolution — Google Drive Blog](https://drive.googleblog.com/2010/09/whats-different-about-new-google-docs.html) — Google's own real, public account of the OT-based conflict-resolution approach behind Google Docs
* [Yjs](https://docs.yjs.dev/) and [Automerge](https://automerge.org/) — real, production CRDT libraries implementing the alternative approach discussed above
* [Write-Ahead Log](/docs/patterns/storage/write-ahead-log) — the durable append-then-checkpoint pattern this design's edit history log follows
