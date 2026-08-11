---
title: "Design WhatsApp (or a Real-Time Messaging System)"
sidebar_position: 10
---

A messaging system's defining constraint is different from most of the other case studies in this course: the hard part isn't serving reads at scale, it's guaranteeing delivery to a specific device that might be offline right now, and doing it with latency low enough to feel like a conversation.

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

### Use case: User sends a message, recipient is online

* Sender's client sends the message over its open connection to the gateway it's connected to
* The gateway forwards it to the **message service**, which assigns a `message_id`, records it as "sent" durably (a write-ahead log entry, not yet the full history store — see below), and looks up the recipient's current connection in the **presence/session directory**
* If the recipient has an active connection — possibly on a *different* gateway node than the sender, since there's no reason the two are colocated — the message service pushes the message to that gateway node, which delivers it over the recipient's open connection
* The recipient's client acknowledges receipt; that acknowledgment flows back through the same path and updates the message's status to "delivered," which the sender's client shows as a receipt

Because a user can be connected from one gateway node out of a very large fleet, the presence/session directory is the piece of shared state that makes cross-node delivery possible at all — it's a fast key-value lookup of `user_id -> which gateway node holds this connection`, kept in memory since a stale entry just costs one delivery retry, not correctness. See [Key-Value Store](/docs/patterns/building-blocks/key-value-store) for the general shape and [WebSockets](/docs/patterns/communication/websockets) for the connection itself.

Writing the message durably *before* attempting delivery — rather than only after a failed delivery — matters: if delivery races the persistence write and the server crashes in between, "message accepted by the server but never actually recoverable" is exactly the silent-loss failure mode this system cannot tolerate. This durable-first ordering is the messaging-system analogue of a [Write-Ahead Log](/docs/patterns/storage/write-ahead-log).

### Use case: User sends a message, recipient is offline

* The flow is identical up through the durable write and status "sent"
* The presence/session directory lookup finds no active connection for the recipient
* The message is written to a **pending-delivery store** keyed by recipient, and delivery is deferred
* When the recipient's client reconnects, it registers with the presence/session directory, and the message service checks that user's pending-delivery queue and pushes everything through the newly-open connection, oldest first
* Once the client acknowledges each message, it's removed from the pending queue and the status transitions to "delivered"

The pending-delivery store is really a per-recipient queue, and it's worth explicitly calling out that this is a different access pattern than the message history store: it's read in full on reconnect, then drained, so it should stay small in the steady state — most messages spend seconds to minutes here, not days, since most offline periods are short. A user offline for an extended stretch (days, a new device) is better served by a full history sync than by an ever-growing pending queue, which is why a cap and fallback path matters: past some size or age, stop enqueueing individually and instead mark "this user needs a history catch-up" for the reconnect flow to resolve against the durable history store directly.

### Use case: Group chat message fan-out

A group message is a write to the group's member list plus an independent delivery attempt per member — conceptually the sender sends one message, but the system fans it out as N individual deliveries, each following the online/offline path above independently based on that specific recipient's connection state. This keeps the per-recipient delivery and receipt logic identical to 1:1 messaging rather than introducing a second delivery mechanism, at the cost of doing N times the delivery work per group message — acceptable at the "dozens of members" scale this design targets, but the reason large broadcast channels need a fundamentally different fan-out strategy (more like the feed fan-out problem covered in the Instagram and YouTube case studies) rather than this per-recipient approach.

Message ordering within a group is handled by having each message carry a per-conversation sequence number assigned at write time, so clients can detect gaps and reorder locally even if two members' deliveries race across different gateway nodes — this avoids needing a single global sequencer for all of WhatsApp's traffic, which would be an unnecessary bottleneck, in favor of ordering that's only meaningful, and only enforced, within one conversation at a time.

### Use case: Delivery and read receipts, presence

Receipts are themselves small messages traveling the reverse direction (recipient's client to sender's client), reusing the exact same online/offline delivery path rather than being a separate subsystem — which is a nice simplification: "deliver this event to this user's active connection or queue it" is the one mechanism the whole system is built around, and receipts, presence changes, and typing indicators are all just different event payloads riding it.

Presence ("online," "last seen 2 minutes ago") is intentionally treated as lower-durability than messages: a presence update that's lost or a few seconds stale is a cosmetic problem, not a correctness one, so it doesn't need the write-ahead durability messages get. A reasonable implementation just writes the current state into the same presence/session directory with a short expiry, refreshed on activity — if a client disconnects ungracefully (phone dies, connection drops without a clean close), the entry simply expires and the user is shown offline, no explicit cleanup required.

## Step 4: Scale the design

![WhatsApp scaled architecture](/img/case-studies/whatsapp-scaled.svg)

**The connection layer is the component with the most extreme scaling requirement** — holding on the order of 100 million concurrent persistent connections isn't solved by adding more application logic, it's solved by running a large horizontally-scaled fleet of gateway nodes, each holding a slice of the total connections, sitting behind [Load Balancing](/docs/patterns/api-edge/load-balancing) that's aware of connection count (not just request rate) when deciding where to route a new connection, since a new-connection request needs to land on a node with capacity, not just whichever node answers fastest.

**Cross-node delivery is the direct consequence of a connection fleet, and it's where the presence/session directory earns its keep.** Every message delivery to an online user is, from the message service's point of view, "find which of thousands of gateway nodes holds this user's connection, then hand it off" — an internal routing problem the directory solves as a fast lookup rather than a broadcast to every node, which would be enormously wasteful at this scale.

**The pending-delivery store needs to be sharded by recipient, not by time or by message**, since every read against it is "give me everything queued for user X" — sharding any other way would turn a single-user reconnect into a scatter-gather across many shards for no benefit. See [Sharding](/docs/patterns/storage/sharding).

**The durable write-ahead step on the send path is the other likely bottleneck**, since every single message — 500,000/sec at peak in this design's numbers — has to hit durable storage before the sender gets a "sent" acknowledgment. This is a natural fit for a [Distributed Message Queue](/docs/patterns/building-blocks/distributed-message-queue) as the durability layer: the message service appends to the queue (fast, sequential, durable) and returns "sent" immediately, while a pool of consumers handles the actual routing/delivery-or-enqueue logic asynchronously. This decouples "the message is safely persisted" from "the message has been routed to its destination," which is exactly the split this design needs, and it's the same [Queue-Based Load Leveling](/docs/patterns/batch-streaming/queue-based-load-leveling) idea used elsewhere in this course to absorb bursty write load without making the producer wait on the slowest downstream step.

**The message history store scales differently from the pending-delivery store** because its access pattern is different: infrequent, bulk, sequential reads (a device syncing everything since its last checkout) rather than frequent single-key reads. It's a good candidate for sharding by `user_id` combined with a storage layout optimized for sequential range scans by time, and — since most messages are read once by history sync and then rarely again — an equally good candidate for tiering older data onto cheaper storage the same way the Pastebin and Twitter case studies discuss for their own bulk-content stores.

**Multi-region placement follows the user, not a fixed topology.** A user's connection should land on the gateway region closest to them for latency, but their pending-delivery and history data need to be reachable regardless of which region they're currently connected from (a user traveling internationally shouldn't lose access to their message history) — this is the same tension between locality and global reachability that [Geode](/docs/patterns/observability/geode) is designed around.

## Additional talking points

* **Why not just have every client poll for new messages instead of holding a persistent connection?** Worth actually working through the arithmetic: even a generous 5-second poll interval across 100 million concurrent users is 20 million requests/sec of pure overhead, most of which return "nothing new" — orders of magnitude worse than the connection-holding approach, which is the strongest argument for push over poll in this specific system.
* **Exactly-once delivery is harder than it sounds, and this design leans on idempotency rather than promising it outright.** A client that sends an acknowledgment that gets lost on the way back will see the same message redelivered — the design's actual guarantee is at-least-once delivery with client-side deduplication by `message_id`, not true exactly-once, which is worth stating explicitly since interviewers often probe this distinction. See [Idempotency](/docs/patterns/reliability/idempotency) and [Exactly-Once Semantics](/docs/patterns/batch-streaming/exactly-once-semantics) for the general tradeoffs.
* **Multi-device support (same account, phone + desktop + web, simultaneously connected)** complicates the "one connection per user" assumption baked into this design's presence directory — a more complete design would key the directory by `(user_id, device_id)` and fan out sends to all of a user's active devices, which is a good natural extension to mention even though it isn't designed in depth here.
* **Group chat at very large scale (thousands of members) breaks the per-recipient fan-out model** used here on cost grounds, not correctness grounds — worth connecting this explicitly to how Instagram and YouTube's case studies handle fan-out for content with huge audiences, since it's the same underlying tension (push to everyone vs. let readers pull) showing up in a different system.
