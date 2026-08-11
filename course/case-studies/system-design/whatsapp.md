---
title: "Design WhatsApp (or a Real-Time Messaging System)"
sidebar_position: 10
---

A messaging system's defining constraint is different from most of the other case studies in this course: the hard part isn't serving reads at scale, it's guaranteeing delivery to a specific device that might be offline right now, and doing it with latency low enough to feel like a conversation.

*Educative's Grokking Modern System Design Interview course covers this same system in its "Design WhatsApp" module, including a "Facebook Messenger System Design (Mock Interview)" sub-lesson.*

## Step 1: Outline use cases and constraints

### Use cases

#### We'll scope the problem to handle the following use cases

* **User** sends a 1:1 text message to another user
* **Service** delivers the message to the recipient if they're online, and holds it for delivery if they're not
* **User** sees delivery and read receipts (sent, delivered, read)
* **User** sees when a contact is online or was "last seen"
* **User** participates in a small group chat (message fans out to all group members)
* **Service** has high availability and does not lose messages

#### Out of scope

* Voice and video calls
* Media messages (photos, video, voice notes) beyond a brief mention of how they'd differ from text
* End-to-end encryption key exchange mechanics (worth naming as a requirement, not designing in depth)
* Large broadcast channels/communities (hundreds of thousands of recipients) — the design here targets 1:1 and small-group chat

### Constraints and assumptions

#### State assumptions

* 300 million daily active users
* Average of 40 messages sent per active user per day (a mix of individual taps and burst conversations)
* Average message body: 60 bytes of text
* 90% of users are on a mobile connection that regularly drops and reconnects (backgrounded app, subway, elevator) — the system must assume "recipient is unreachable right now" is the common case, not the exception
* Message delivery should feel instantaneous when both parties are online — under a few hundred milliseconds end to end
* A message must never be silently dropped: if the server accepted it, it must eventually reach the recipient (or be visibly queued), even across app restarts, device changes, or multi-day offline periods
* Ordering matters within a single conversation (messages should generally arrive in the order they were sent) but strict global ordering across all conversations is not required
* Group chats are small (dozens of members, not thousands) for this design's scope

#### Calculate usage

* Total messages/day: 300,000,000 users × 40 messages/day = **12 billion messages/day**
    * 12,000,000,000 / 86,400 sec ≈ **~140,000 messages/sec average**, with evening/weekend peaks reasonably assumed at 3-4x average, so design the ingest path for **~500,000 messages/sec at peak**
* Storage per message: `message_id` (8 bytes) + `sender_id`/`recipient_id` (8 bytes each) + `body` (60 bytes) + `timestamp` (8 bytes) + `status` (1 byte) + protocol overhead ≈ **~100 bytes**
    * 12 billion messages/day × 100 bytes ≈ **~1.2 TB/day** of new message data, **~440 TB/year**
    * Most of that volume is transient by nature (delivered-and-acknowledged messages don't need to stay hot), which is the strongest argument in this whole design for treating "recently sent, not yet delivered" and "delivered, kept for history" as two very differently-accessed datasets rather than one table
* Concurrent connections: with 300 million DAU and a generous assumption that a third are actively using the app at any given peak moment, that's **~100 million concurrent persistent connections** to hold open across the fleet at peak — this single number is the real scaling driver for the connection layer, more than message throughput itself
* Presence updates (online/offline/last-seen) are a further multiplier: if a meaningful fraction of 300 million users transitions state (app opened, backgrounded, connection dropped) even a few times per day, that's tens of millions of presence events/day layered on top of message traffic, and — being far less critical than message delivery — a good candidate for relaxed, best-effort handling rather than the durability guarantees messages need

## Step 2: Create a high-level design

![WhatsApp high-level architecture](/img/case-studies/whatsapp-overview.svg)

Every online client holds a long-lived connection to a **connection/gateway layer**, since a request-response model can't push a message to a recipient who didn't ask for it. When a message arrives, the gateway hands it to a **message service**, which looks up whether the recipient currently has an open connection anywhere in the fleet (via a **presence/session directory**) and either pushes it straight through or writes it durably to a **pending-delivery store** for the recipient to receive on reconnect. A separate, much larger **message history store** retains delivered messages for each user's device to sync against (new device login, app reinstall), and is optimized for bulk sequential reads rather than the millisecond-latency single-message lookups the delivery path needs.

The critical design fork this system faces, more than most others in this course, is that "deliver now" and "deliver eventually" are fundamentally different code paths with different consistency and latency needs, and the design below keeps them as separate concerns rather than forcing one storage system to serve both well.

## Step 3: Design core components

### Use case: User sends a message — storage schema and delivery state machine

The hard problem: store messages so a single conversation's history can be read back in order cheaply, and track each message through a delivery lifecycle that must never silently get stuck or go backwards, even across a recipient going offline mid-flight.

**Core spec: schema + indexing**

```sql
CREATE TABLE messages (
    conversation_id  BIGINT       NOT NULL,   -- shared by both/all participants
    message_id       BIGINT       NOT NULL,   -- sortable: high bits = timestamp, low bits = per-ms sequence
    sender_id        BIGINT       NOT NULL,
    body_ciphertext  VARBINARY(4096) NOT NULL, -- end-to-end encrypted; server cannot read this
    status           TINYINT      NOT NULL,   -- 0=sent 1=delivered 2=read (see state machine below)
    created_at       TIMESTAMP    NOT NULL,
    PRIMARY KEY (conversation_id, message_id),
    FOREIGN KEY (sender_id) REFERENCES users(user_id)
);

-- Partition the table by conversation_id (consistent-hash or range partitioning
-- across shards) so a single busy conversation's writes and reads stay local
-- to one partition instead of contending with every other conversation.

CREATE TABLE pending_delivery (
    recipient_id     BIGINT       NOT NULL,
    conversation_id  BIGINT       NOT NULL,
    message_id       BIGINT       NOT NULL,
    queued_at        TIMESTAMP    NOT NULL,
    PRIMARY KEY (recipient_id, message_id)
);
```

* `messages` is keyed `(conversation_id, message_id)` and *partitioned* by `conversation_id` — every real query this table serves ("give me this conversation's history, in order, possibly paginated") filters by `conversation_id` first, so partitioning any other way (say, by `sender_id`) would turn the single most common read into a scatter-gather across partitions for no benefit.
* `message_id` is a sortable identifier (a Snowflake-style ID with a timestamp in the high bits, same shape as the [TinyURL case study](/docs/case-studies/system-design/tinyurl)'s code generator) rather than a random UUID, specifically so `ORDER BY message_id` inside one partition is equivalent to chronological order without a separate `created_at` index or sort step.
* `pending_delivery` is keyed and partitioned by `recipient_id`, not `conversation_id` — its one query pattern is "give me everything queued for user X across *all* their conversations on reconnect," which is the opposite access pattern from `messages`, and is exactly why it's a separate table rather than a status flag on `messages` itself.

**Core spec: delivery state machine (the three-checkmark model)**

```
                    ┌─────────┐
     write succeeds │  SENT   │  <- server has durably persisted the message
     ───────────────▶         │     (sender sees one checkmark)
                    └────┬────┘
                         │ recipient's client ACKs receipt
                         │ over an open connection, OR
                         │ pulls it from pending_delivery on reconnect
                         ▼
                    ┌─────────┐
                    │DELIVERED│  <- message reached the recipient's device
                    │         │     (sender sees two checkmarks)
                    └────┬────┘
                         │ recipient opens the conversation
                         │ (client sends an explicit read event)
                         ▼
                    ┌─────────┐
                    │  READ   │  <- sender sees two BLUE checkmarks
                    └─────────┘

Failure / rollback branches:
  * SENT, recipient offline indefinitely -> stays SENT; retried on
    every reconnect attempt, never silently dropped (see pending_delivery)
  * DELIVERED ACK lost in transit -> server re-sends the message on the
    recipient's next reconnect; recipient's client deduplicates by
    message_id, so status still correctly reaches DELIVERED once, not twice
  * READ receipt disabled by recipient's privacy setting -> state
    machine halts at DELIVERED by design; sender never sees blue checks,
    which is a product rule layered on top of the mechanism, not a bug
```

* Status only ever moves forward (`sent -> delivered -> read`) — a client is never expected to move a message backward, so a state write can be a simple conditional "advance to at least this status" rather than needing to reconcile out-of-order status updates.
* Because delivery is push-based over an open connection, `sent -> delivered` for an online recipient typically happens within the same round trip that the WhatsApp connection layer (Step 2) already handles; the state machine's real value shows up in the offline branch, where `sent` can persist for hours or days without the message ever being at risk of loss.

**Data structures:** the `messages` and `pending_delivery` tables above are the durable core; the presence/session directory (`user_id -> gateway_node`, in-memory) from Step 2 is what the delivery path consults to decide whether to push immediately or fall into the `pending_delivery` branch.

**Trade-offs:**
* **The gotcha:** end-to-end encryption means `body_ciphertext` is opaque to the server by design — the server cannot run a content-based search, cannot do keyword-based spam filtering on message bodies, and cannot route or prioritize a message based on what it says, because it structurally cannot read it. This rules out designs that other messaging or feed systems might reach for (server-side full-text search over message history, content-based abuse detection at the transport layer) and pushes any such feature to the client (a device can search its own decrypted local copy) or to metadata-only signals the server *can* see (sender, recipient, timestamp, size) — see [End-to-end encryption](https://en.wikipedia.org/wiki/End-to-end_encryption) and the [Signal Protocol documentation](https://signal.org/docs/) for the real cryptographic scheme this kind of guarantee is typically built on.
* Writing the message durably *before* attempting delivery — rather than only after a failed delivery — matters: if delivery races the persistence write and the server crashes in between, "message accepted by the server but never actually recoverable" is exactly the silent-loss failure mode this system cannot tolerate. This durable-first ordering is the messaging-system analogue of a [Write-Ahead Log](/docs/patterns/storage/write-ahead-log).
* The `pending_delivery` table should stay small in steady state — most messages spend seconds to minutes there, not days, since most offline periods are short. A user offline for an extended stretch (days, a new device) is better served by a full history sync than by an ever-growing pending queue, which argues for a cap: past some size or age, stop enqueueing individually and mark "this user needs a history catch-up" for the reconnect flow to resolve against the durable history store directly instead.

**REST API:** message send/receive rides the persistent connection described in Step 2, not a REST endpoint — but a status query for a specific message (used by, e.g., a client reconciling state after reconnect) has the same shape as any other lookup:

```
$ curl https://whatsapp.example/api/v1/messages/8f3a1c9002/status \
    -H "Authorization: Bearer <token>"
```

Response:

```json
{
  "message_id": "8f3a1c9002",
  "conversation_id": "conv_44210",
  "status": "delivered",
  "updated_at": "2026-08-11T14:02:31Z"
}
```

### Use case: Group chat message fan-out

A group message is a write to the group's member list plus an independent delivery attempt per member — conceptually the sender sends one message, but the system fans it out as N individual deliveries, each following the state machine above independently based on that specific recipient's connection state. This keeps the per-recipient delivery and receipt logic identical to 1:1 messaging rather than introducing a second delivery mechanism, at the cost of doing N times the delivery work per group message — acceptable at the "dozens of members" scale this design targets, but the reason large broadcast channels need a fundamentally different fan-out strategy (more like the feed fan-out problem covered in the Instagram and YouTube case studies) rather than this per-recipient approach.

**Data structures:** `group_members` — `conversation_id`, `user_id`, `joined_at`, composite PK `(conversation_id, user_id)`; a group send iterates this list to create one `pending_delivery`/push attempt per member, each carrying the same `message_id` from the shared `messages` row.

**Trade-offs:**
* Message ordering within a group is handled by having each message carry a per-conversation sequence number assigned at write time (the `message_id`'s sortable structure from the schema above), so clients can detect gaps and reorder locally even if two members' deliveries race across different gateway nodes — this avoids needing a single global sequencer for all of WhatsApp's traffic, which would be an unnecessary bottleneck, in favor of ordering that's only meaningful, and only enforced, within one conversation at a time.
* Same end-to-end encryption constraint as 1:1 messages applies per-recipient in a group — the server still cannot read `body_ciphertext`, which means group membership changes (someone added or removed) have real cryptographic key-management implications out of scope here, not just an access-list update.

### Use case: Presence ("online" / "last seen")

Presence rides the same connection layer as message delivery and delivery/read receipts — it's just another small event type flowing over the already-open connection — but it has a meaningfully different durability requirement, so it's worth calling out on its own.

**Data structures:** presence lives in the same in-memory presence/session directory as the gateway routing table (`user_id -> gateway_node`), with an added `last_active_at` field and a short TTL refreshed on activity.

**Trade-offs:**
* Presence is intentionally treated as lower-durability than messages: a presence update that's lost or a few seconds stale is a cosmetic problem, not a correctness one, so it doesn't need the write-ahead durability messages get (no `sent`/`delivered`/`read` state machine, no durable table). If a client disconnects ungracefully (phone dies, connection drops without a clean close), the entry simply expires and the user is shown offline — no explicit cleanup required, which is a deliberately simpler mechanism than the message state machine above, not an oversight.

## Step 4: Scale the design

![WhatsApp scaled architecture](/img/case-studies/whatsapp-scaled.svg)

**The connection layer is the component with the most extreme scaling requirement** — holding on the order of 100 million concurrent persistent connections isn't solved by adding more application logic, it's solved by running a large horizontally-scaled fleet of gateway nodes, each holding a slice of the total connections, sitting behind [Load Balancing](/docs/patterns/api-edge/load-balancing) that's aware of connection count (not just request rate) when deciding where to route a new connection, since a new-connection request needs to land on a node with capacity, not just whichever node answers fastest.

**Cross-node delivery is the direct consequence of a connection fleet, and it's where the presence/session directory earns its keep.** Every message delivery to an online user is, from the message service's point of view, "find which of thousands of gateway nodes holds this user's connection, then hand it off" — an internal routing problem the directory solves as a fast lookup rather than a broadcast to every node, which would be enormously wasteful at this scale.

**The pending-delivery store needs to be sharded by recipient, not by time or by message**, since every read against it is "give me everything queued for user X" — sharding any other way would turn a single-user reconnect into a scatter-gather across many shards for no benefit. See [Sharding](/docs/patterns/storage/sharding).

**The durable write-ahead step on the send path is the other likely bottleneck**, since every single message — 500,000/sec at peak in this design's numbers — has to hit durable storage before the sender gets a "sent" acknowledgment. This is a natural fit for a [Distributed Message Queue](/docs/patterns/building-blocks/distributed-message-queue) as the durability layer (Kafka or a cloud-managed equivalent is a common real choice here): the message service appends to the queue (fast, sequential, durable) and returns "sent" immediately, while a pool of consumers handles the actual routing/delivery-or-enqueue logic asynchronously. This decouples "the message is safely persisted" from "the message has been routed to its destination," which is exactly the split this design needs, and it's the same [Queue-Based Load Leveling](/docs/patterns/batch-streaming/queue-based-load-leveling) idea used elsewhere in this course to absorb bursty write load without making the producer wait on the slowest downstream step.

**The message history store scales differently from the pending-delivery store** because its access pattern is different: infrequent, bulk, sequential reads (a device syncing everything since its last checkout) rather than frequent single-key reads. It's a good candidate for sharding by `user_id` combined with a storage layout optimized for sequential range scans by time, and — since most messages are read once by history sync and then rarely again — an equally good candidate for tiering older data onto cheaper storage the same way the Pastebin and Twitter case studies discuss for their own bulk-content stores.

**Multi-region placement follows the user, not a fixed topology.** A user's connection should land on the gateway region closest to them for latency, but their pending-delivery and history data need to be reachable regardless of which region they're currently connected from (a user traveling internationally shouldn't lose access to their message history) — this is the same tension between locality and global reachability that [Geode](/docs/patterns/observability/geode) is designed around.

## Additional talking points

* **Why not just have every client poll for new messages instead of holding a persistent connection?** Worth actually working through the arithmetic: even a generous 5-second poll interval across 100 million concurrent users is 20 million requests/sec of pure overhead, most of which return "nothing new" — orders of magnitude worse than the connection-holding approach, which is the strongest argument for push over poll in this specific system.
* **Exactly-once delivery is harder than it sounds, and this design leans on idempotency rather than promising it outright.** A client that sends an acknowledgment that gets lost on the way back will see the same message redelivered — the design's actual guarantee is at-least-once delivery with client-side deduplication by `message_id`, not true exactly-once, which is worth stating explicitly since interviewers often probe this distinction. See [Idempotency](/docs/patterns/reliability/idempotency) and [Exactly-Once Semantics](/docs/patterns/batch-streaming/exactly-once-semantics) for the general tradeoffs.
* **Multi-device support (same account, phone + desktop + web, simultaneously connected)** complicates the "one connection per user" assumption baked into this design's presence directory — a more complete design would key the directory by `(user_id, device_id)` and fan out sends to all of a user's active devices, which is a good natural extension to mention even though it isn't designed in depth here.
* **Group chat at very large scale (thousands of members) breaks the per-recipient fan-out model** used here on cost grounds, not correctness grounds — worth connecting this explicitly to how Instagram and YouTube's case studies handle fan-out for content with huge audiences, since it's the same underlying tension (push to everyone vs. let readers pull) showing up in a different system.

## Source(s) and further reading

* [End-to-end encryption — Wikipedia](https://en.wikipedia.org/wiki/End-to-end_encryption) — the property that shapes this design's "server cannot search or content-route" constraint
* [Signal Protocol documentation](https://signal.org/docs/) — the real, widely-adopted cryptographic protocol underlying end-to-end encrypted messaging of the kind this design assumes
* [1 million is so 2011 — WhatsApp Engineering](https://blog.whatsapp.com/1-million-is-so-2011) — WhatsApp's own real account of a single connection-layer server holding over a million concurrent connections, a useful data point for this design's connection-fleet scaling numbers
* [Erlang (programming language) — Wikipedia](https://en.wikipedia.org/wiki/Erlang_(programming_language)) — the lightweight-process concurrency model WhatsApp's real infrastructure was historically built on for exactly this connection-holding problem
* [Write-Ahead Log](/docs/patterns/storage/write-ahead-log) — the durable-first-write pattern this design's `messages` table write path follows
