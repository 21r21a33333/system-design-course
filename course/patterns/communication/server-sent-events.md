---
title: "Server-Sent Events"
sidebar_position: 4
supplementary: true
---

Server-Sent Events (SSE) is a one-way, HTTP-native streaming protocol
that lets a server push a continuous stream of text updates to a
browser client over a single long-lived connection, with automatic
client-side reconnection built into the standard.

## Problem it solves

Polling for updates — the client repeatedly requesting "anything new?"
— wastes requests when nothing has changed and adds latency equal to
the poll interval when something has. A full bidirectional protocol is
often more than the problem needs: many use cases only ever need the
server to push data outward (price ticks, notifications, progress
updates) and never need the client to send anything back over the same
channel. SSE fills that gap with a mechanism that's just an HTTP
response the server never finishes.

## How it works

The client opens a connection to an SSE endpoint using the standard
`EventSource` browser API, which issues a normal HTTP GET request with
`Accept: text/event-stream`. The server responds with that content type
and keeps the connection open, writing newline-delimited `data: ...`
events to the response body as they occur instead of closing it. The
browser parses each event out of the stream and delivers it to the
page's event handlers as it arrives. Because it's plain HTTP, it works
through existing infrastructure (proxies, load balancers) without an
upgrade handshake, and if the connection drops, the browser's
`EventSource` automatically reconnects and can resume from the last
event ID the server sent, without any custom reconnect logic in
application code.

Contrasted with the alternatives: polling pays a fresh HTTP request
(and its overhead) every interval regardless of whether there's new
data; WebSockets (see [WebSockets](/docs/patterns/communication/websockets))
give a full-duplex channel where the client can also push data back
over the same connection, at the cost of a non-HTTP protocol upgrade and
more server-side connection bookkeeping.

## When to use it

- Updates only ever flow server-to-client — the client never needs to
  send data back over the same channel.
- The infrastructure between client and server is plain HTTP-friendly
  (proxies, CDNs, load balancers) and a protocol upgrade is undesirable.
- Automatic reconnection with minimal client code is valuable.

## When not to use it

- The client also needs to send frequent messages back to the server
  over the same channel — WebSockets avoid running two separate
  connections for that.
- Binary data needs to be streamed — SSE is defined for UTF-8 text only.
- Very old browsers or non-browser clients without an `EventSource`
  polyfill are a hard requirement.

## Real-world example

Live sports score updates and stock ticker widgets are common SSE use
cases: the server has a steady stream of one-directional updates to
push, the browser never needs to talk back over that connection, and
automatic reconnect means a flaky network doesn't require any special
handling in the page's code.

## Related patterns

- [WebSockets](/docs/patterns/communication/websockets) — the bidirectional alternative when the client also needs to push data back.

## Further reading

- [Server-sent events — Wikipedia](https://en.wikipedia.org/wiki/Server-sent_events)
