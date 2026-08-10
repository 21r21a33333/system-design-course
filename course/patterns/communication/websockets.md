---
title: "WebSockets"
sidebar_position: 5
supplementary: true
---

WebSockets provide a full-duplex, persistent connection between client
and server, established by upgrading a single HTTP request, over which
either side can push messages to the other at any time.

## Problem it solves

Plain HTTP is request-response: the client always initiates, and the
server can only reply to a request that already arrived. That model
breaks down when the server needs to push data to the client without
the client asking first, and it especially breaks down when both sides
need to send frequent, low-latency messages to each other — repeatedly
opening new HTTP requests for every message adds connection-setup
overhead and latency that a real-time interaction can't tolerate.

## How it works

The client starts with a normal HTTP request carrying an `Upgrade:
websocket` header. If the server agrees, it responds with a `101
Switching Protocols` status, and the same underlying TCP connection is
then repurposed to carry the WebSocket framing protocol instead of
HTTP — this is the handshake. After that, either endpoint can send a
message frame at any time, without waiting for a request from the
other side, and the connection stays open until either side closes it.

Holding that connection open has an operational cost distinct from
stateless HTTP: the server must keep a live connection (and often
in-memory state, like "which chat room is this connection in") per
client for as long as they're connected, which limits how many
concurrent clients a single server process can hold and requires
capacity planning around concurrent connections rather than request
throughput. If clients are load-balanced across multiple server
instances, either the load balancer needs sticky sessions (routing a
given client back to the same instance) or the instances need a shared
pub-sub backplane so a message accepted on one instance can reach a
client connected to another.

## When to use it

- Both sides genuinely need to push messages to each other with low
  latency — not just the server pushing to the client.
- The interaction is highly interactive and the overhead of repeated
  HTTP requests (or SSE's one-way limitation) would be a poor fit.
- The team can operate stateful, long-lived server connections
  (connection limits, sticky sessions or a backplane, reconnect logic).

## When not to use it

- Only the server needs to push data and the client never needs to send
  anything back over the same channel — see
  [Server-Sent Events](/docs/patterns/communication/server-sent-events)
  for a simpler, HTTP-native alternative.
- The infrastructure between client and server doesn't reliably support
  protocol upgrades (some older proxies and middleboxes don't).
- The team isn't ready to operate the connection-scaling concerns
  (sticky sessions or a cross-instance backplane, per-connection memory)
  that come with holding many long-lived connections open.

## Real-world example

Chat applications and collaborative document editors are the canonical
WebSocket use case: every participant needs to both send and receive
updates with low latency, and the server typically fans a message from
one connected client out to every other connection in the same
room or document.

## Related patterns

- [Server-Sent Events](/docs/patterns/communication/server-sent-events) — the simpler, one-way alternative when the client never needs to push data back.
- [Online Chat](/docs/case-studies/object-oriented-design/online-chat) — the primer's case study on designing a real-time chat system.

## Further reading

- [WebSocket — Wikipedia](https://en.wikipedia.org/wiki/WebSocket)
