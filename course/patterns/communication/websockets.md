---
title: "WebSockets"
sidebar_position: 5
supplementary: true
---

WebSockets provide a full-duplex, persistent connection between a client
and a server, established by upgrading a single HTTP request, over which
either side can push messages to the other at any time without the
overhead of a new request per message.

![WebSockets diagram](/img/patterns/websockets.svg)

## Problem it solves

Plain HTTP is request-response: the client always initiates, and the
server can only reply to a request that already arrived. That model
breaks down when the server needs to push data to the client without
being asked, and it breaks down harder when *both* sides need to
exchange frequent, low-latency messages — opening a fresh HTTP request
for every message pays connection-setup and header overhead on each one,
and a request the server is holding open waiting for data (long-polling)
still costs a round trip to re-establish after every response. A chat
message, a cursor move in a shared document, or a fill on a trading order
needs to travel in single-digit milliseconds in *either* direction over a
channel that is already open. WebSockets give exactly that: one connection,
opened once, that stays live and carries messages both ways.

## Technical architecture & implementation

**The upgrade handshake.** A WebSocket connection begins life as an
ordinary HTTP/1.1 GET request carrying `Connection: Upgrade` and
`Upgrade: websocket` headers, plus a random `Sec-WebSocket-Key`. If the
server agrees, it replies `101 Switching Protocols` and echoes back a
derived `Sec-WebSocket-Accept` value proving it understood the request.
From that instant the same underlying TCP connection stops speaking HTTP
and starts speaking the WebSocket framing protocol defined in RFC 6455.
Reusing an HTTP request for the handshake is deliberate: it travels over
the same ports (80/443) and through the same proxies as normal web
traffic, so it usually gets through infrastructure that would block a
brand-new protocol on a novel port.

**Frames, text and binary.** After the handshake, data moves as *frames*,
each tagged with an opcode. Text frames carry UTF-8, binary frames carry
arbitrary bytes (protobuf, images, custom encodings), and either side can
send at any moment — that is what "full-duplex" means. This is the sharp
line against [Server-Sent Events](/docs/patterns/communication/server-sent-events),
which stream text *only from server to client*: with WebSockets the
client pushes over the same socket, so a collaborative editor or a
multiplayer game — where the client is constantly sending as well as
receiving — needs WebSockets, not SSE.

**Heartbeats and idle timeouts.** A TCP connection can sit silently
"open" long after the peer or an intermediary has actually dropped it.
Ping and Pong control frames are the fix: one side periodically sends a
Ping, the other must answer with a Pong, and a missed Pong within a
deadline marks the connection dead so it can be torn down and
re-established. Heartbeats also keep proxies and load balancers from
closing a connection they consider idle.

**Backpressure.** Because either side can send freely, a fast producer
can outrun a slow consumer and pile up unsent bytes in memory. Robust
implementations watch the outbound buffer and slow, drop, or coalesce
messages when it grows — the same concern the
[Backpressure](/docs/patterns/batch-streaming/backpressure) pattern
addresses for streaming pipelines generally.

**Scaling across instances.** A WebSocket is *stateful*: the server holds
a live connection, and usually per-connection memory ("which room is this
socket in"), for the entire session, so capacity is planned around
concurrent connections rather than request throughput. When clients are
spread across many server instances behind a load balancer, a message
accepted on one instance must still reach a client connected to another.
Two approaches solve this: **sticky sessions**, which pin a given client
to the same instance for the life of the connection, or — more commonly
at scale — a shared **pub/sub backplane** (Redis, NATS, a message broker)
that every instance subscribes to, so a broadcast published on one
instance fans out to sockets held by all of them. That backplane is the
same [Publish-Subscribe](/docs/patterns/communication/pub-sub) mechanism
used elsewhere, here repurposed to glue horizontally-scaled socket
servers together.

**Auth and fallbacks.** Since the handshake is an HTTP request, the usual
authentication rides along on it — a token in a query parameter, a cookie,
or (for non-browser clients) an `Authorization` header — validated once
before the upgrade is accepted; the browser `WebSocket` API can't set
arbitrary headers, so a short-lived token in the URL is the common
browser pattern. Where protocol upgrades are unreliable (old corporate
proxies, restrictive middleboxes), libraries fall back to long-polling,
which emulates a bidirectional channel over ordinary HTTP requests at
higher latency and overhead.

## Choosing between WebSockets, SSE, and polling

| Property | WebSockets | Server-Sent Events | Long-polling |
| --- | --- | --- | --- |
| Direction | Full-duplex (both ways) | Server → client only | Client-initiated |
| Transport | Upgraded TCP (RFC 6455) | Plain HTTP response | Plain HTTP requests |
| Payload | Text and binary | UTF-8 text only | Text and binary |
| Auto-reconnect | Manual (app or library) | Built into `EventSource` | Inherent (new request) |
| Proxy friendliness | Needs upgrade support | Passes as normal HTTP | Passes as normal HTTP |
| Server state | Per-connection, stateful | Per-connection, stateful | Mostly stateless |
| Best fit | Chat, games, trading, live collaboration | Feeds, notifications, progress | Fallback when nothing else works |

The rule of thumb: if the client only *receives*, prefer SSE for its
simplicity and free reconnection; reach for WebSockets specifically when
the client must also *send* frequently over the same channel.

## Code example

The heart of a real-time WebSocket service is the routing logic that
turns an inbound frame into an action — answer a heartbeat, fan a
message out to peers, or close the connection. This models the opcodes
and a broadcast hub without any networking, so the decision logic is
inspectable on its own.

```rust
use std::collections::HashMap;

/// A WebSocket frame carries an opcode identifying what it is. These are the
/// four an application interacts with directly (RFC 6455 also defines
/// continuation frames for fragmentation). Control frames — Ping, Pong, Close —
/// are how the connection stays alive and shuts down cleanly.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum OpCode {
    Text,
    Binary,
    Ping,
    Pong,
    Close,
}

/// One decoded frame handed to the application layer.
pub struct Frame {
    pub opcode: OpCode,
    pub payload: Vec<u8>,
}

/// Actions the hub tells the caller to perform in response to an inbound frame.
pub enum Action {
    /// Reply on the same connection (a Pong answering a Ping).
    Reply(Frame),
    /// Deliver this text/binary payload to every *other* subscriber.
    Broadcast { from: u64, payload: Vec<u8> },
    /// Drop this connection.
    Disconnect,
    /// Nothing to do (e.g. an unsolicited Pong).
    Ignore,
}

/// A broadcast hub tracks connected subscribers by id and routes messages
/// between them — the fan-out core of a chat room or collaborative session.
/// Because a WebSocket is full-duplex, the same connection both sends the frame
/// that triggers a broadcast and receives frames broadcast by others; a
/// one-way channel like SSE could not model the inbound half.
#[derive(Default)]
pub struct Hub {
    subscribers: HashMap<u64, String>, // connection id -> room
}

impl Hub {
    pub fn join(&mut self, conn: u64, room: &str) {
        self.subscribers.insert(conn, room.to_string());
    }

    pub fn leave(&mut self, conn: u64) {
        self.subscribers.remove(&conn);
    }

    /// Every peer in the same room as `from`, excluding `from` itself.
    pub fn peers(&self, from: u64) -> Vec<u64> {
        let room = match self.subscribers.get(&from) {
            Some(r) => r,
            None => return Vec::new(),
        };
        let mut out: Vec<u64> = self
            .subscribers
            .iter()
            .filter(|(id, r)| **id != from && *r == room)
            .map(|(id, _)| *id)
            .collect();
        out.sort_unstable();
        out
    }

    /// Map an inbound frame to the action the connection handler should take.
    /// A Ping is answered with a Pong carrying the same payload (the heartbeat
    /// that distinguishes a live-but-idle connection from a dead one); a Close
    /// tears the connection down; data frames fan out to peers.
    pub fn handle(&self, from: u64, frame: Frame) -> Action {
        match frame.opcode {
            OpCode::Ping => Action::Reply(Frame {
                opcode: OpCode::Pong,
                payload: frame.payload,
            }),
            OpCode::Pong => Action::Ignore,
            OpCode::Close => Action::Disconnect,
            OpCode::Text | OpCode::Binary => Action::Broadcast {
                from,
                payload: frame.payload,
            },
        }
    }
}
```

Exercised directly, `handle` answers a Ping with a Pong echoing the same
payload, turns a Text frame into a `Broadcast` tagged with its sender, and
`peers` returns exactly the other connections sharing a room — so a
message from connection 2 in `lobby` routes to 1 and 3 but never to a
connection in a different room or back to the sender.

## When to use it

- Both sides genuinely need to push messages with low latency — not just
  the server pushing to the client.
- The interaction is highly interactive, and the overhead of repeated HTTP
  requests (or SSE's one-way limitation) would be a poor fit.
- The team can operate stateful, long-lived connections: connection
  limits, sticky sessions or a backplane, heartbeats, and reconnect logic.

## When not to use it

- Only the server needs to push data and the client never sends anything
  back over the same channel — use
  [Server-Sent Events](/docs/patterns/communication/server-sent-events)
  for a simpler, HTTP-native, auto-reconnecting alternative.
- The infrastructure between client and server doesn't reliably support
  protocol upgrades (some older proxies and middleboxes don't), and a
  long-polling fallback is unacceptable.
- The team isn't ready to operate connection-scaling concerns — sticky
  sessions or a cross-instance backplane, per-connection memory — that
  come with holding many long-lived connections open.

## Use-case scenarios

**Team chat and presence.** Every participant both sends and receives
messages, and the server fans one client's message out to every other
socket in the same room — often through a pub/sub backplane so the room's
members can be spread across many server instances. Presence ("who is
online, who is typing") rides the same socket as ephemeral events.

**Collaborative document editing.** In a shared editor, each keystroke or
cursor move is a small message the client sends *and* receives many times
a second. The bidirectional, low-latency channel is essential — a one-way
stream could deliver others' edits but not carry the local user's, so
this is a case WebSockets fit and SSE does not.

**Live trading and dashboards.** A trading client streams market ticks
inbound while sending orders and cancellations outbound over the same
connection, with binary frames keeping each message compact. Heartbeats
detect a silently-dropped connection quickly so the client can reconnect
before it misses fills.

## Production libraries & getting started

Production WebSocket work is rarely raw RFC 6455 framing — these libraries handle the handshake, control frames, and reconnection so you build on the routing logic, not the wire format.

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| Socket.IO | JS/TS | Higher-level real-time engine over WebSocket with rooms, auto-reconnect, and long-polling fallback | [Socket.IO docs](https://socket.io/docs/v4/) |
| `ws` | JS/TS | Fast, spec-compliant bare WebSocket client and server for Node.js | [ws usage examples](https://github.com/websockets/ws#usage-examples) |
| tokio-tungstenite | Rust | Async WebSocket client/server on Tokio (the tungstenite protocol impl) | [tokio-tungstenite README](https://github.com/snapview/tokio-tungstenite) |
| axum (WebSocket extractor) | Rust | WebSocket upgrade handling built into the axum web framework | [axum::extract::ws docs](https://docs.rs/axum/latest/axum/extract/ws/index.html) |
| gorilla/websocket | Go | Widely-used, low-level WebSocket implementation for Go servers and clients | [gorilla/websocket reference](https://pkg.go.dev/github.com/gorilla/websocket) |
| coder/websocket | Go | Minimal, modern WebSocket library (formerly nhooyr.io/websocket) with a small API | [coder/websocket README](https://github.com/coder/websocket) |
| `websockets` | Python | asyncio-native WebSocket client and server with correct control-frame handling | [websockets docs](https://websockets.readthedocs.io/en/stable/) |
| Django Channels | Python | Adds WebSocket (and other async protocols) to Django with consumers and a channel layer | [Channels docs](https://channels.readthedocs.io/en/latest/) |

## Related patterns

- [Server-Sent Events](/docs/patterns/communication/server-sent-events) —
  the simpler, one-way, HTTP-native alternative when the client never
  needs to push data back over the channel.
- [gRPC Bidirectional Streaming](/docs/patterns/communication/grpc-bidirectional-streaming) —
  a full-duplex streaming channel like WebSockets but over HTTP/2 with
  typed messages, common for service-to-service rather than browser links.
- [Publish-Subscribe](/docs/patterns/communication/pub-sub) — the backplane
  that lets a message accepted on one socket server reach clients connected
  to another instance.
- [Backpressure](/docs/patterns/batch-streaming/backpressure) — how a
  server copes when a producer outruns a slow WebSocket consumer's ability
  to drain its buffer.
- [Load Balancing](/docs/patterns/api-edge/load-balancing) — sticky
  sessions here are what keep a client pinned to the instance holding its
  connection.

## Visual references

- [WebSockets explained with handshake and message-flow diagrams — Ably](https://ably.com/topic/websockets) — © Ably

## Further reading

- [The WebSocket API — MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API)
- [WebSocket interface reference — MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)
- [RFC 6455: The WebSocket Protocol — IETF](https://www.rfc-editor.org/rfc/rfc6455)
