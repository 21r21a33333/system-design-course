---
title: "gRPC Bidirectional Streaming"
sidebar_position: 9
supplementary: true
---

gRPC bidirectional streaming is one of gRPC's four RPC types — the
other three being unary, server-streaming, and client-streaming — in
which client and server each open a stream of strongly-typed,
schema-defined messages over a single HTTP/2 connection and can read
and write independently, in either order, at the same time.

![gRPC Bidirectional Streaming diagram](/img/patterns/grpc-bidirectional-streaming.svg)

## Problem it solves

Some interactions need both sides to send an ongoing series of
messages to each other — live telemetry with acknowledgments, chat,
collaborative editing, or a client streaming audio while the server
streams back incremental transcriptions. A single request-response
call can't model that; a new unary call per message adds connection
and header overhead per exchange, and forces an artificial turn-taking
structure onto something that's naturally continuous in both
directions. What's needed is a single long-lived channel where either
side can push structured messages whenever it has one, without
re-establishing the connection or waiting for the other side to ask.

## How it works

A bidirectional-streaming RPC is declared in a `.proto` file with the
`stream` keyword on both the request and response types, e.g. `rpc
Chat(stream ClientMessage) returns (stream ServerMessage)`. When the
client calls it, gRPC opens a single HTTP/2 stream for that call — not
a new connection, but one logical stream multiplexed over the
underlying HTTP/2 connection — over which the client can send any
number of `ClientMessage`s and the server can send any number of
`ServerMessage`s, interleaved in either order, until either side
closes its half of the stream. Each message is a Protocol Buffers
message: encoded from the same `.proto` schema on both ends, so both
sides agree on field names, types, and structure without any runtime
parsing or shape negotiation — a malformed or mistyped message is
rejected by the generated code, not discovered as a bug in production.

This differs from a generic WebSocket connection in three concrete
ways, not just superficially:

- **Schema and type safety.** A WebSocket carries opaque frames — text
  or binary — with no built-in structure; the application has to agree
  on and hand-parse a message format (commonly JSON) itself, and
  nothing stops either side from sending a malformed or unexpected
  payload that's only caught at runtime, if at all. gRPC's messages are
  defined once in a `.proto` file and compiled into typed structs/
  classes on every language's client and server, so the message shape
  is enforced by the compiler, not by application-level parsing code.
- **HTTP/2 multiplexing.** A WebSocket connection is one dedicated TCP
  connection per logical channel — running many independent streams
  means running many WebSocket connections, each with its own TCP and
  TLS overhead. gRPC bidirectional streams run as HTTP/2 streams, and
  HTTP/2 multiplexes many streams over a single TCP connection; a
  client can have several independent bidirectional RPCs in flight to
  the same server concurrently without paying for a new connection per
  stream.
- **Built-in flow control.** HTTP/2 has flow control at both the
  stream and connection level, so a fast sender can't unboundedly
  overrun a slow receiver's buffer — the transport itself applies
  backpressure. A raw WebSocket has no equivalent; the application has
  to implement its own backpressure or accept unbounded buffering (or
  message loss) if one side produces faster than the other consumes.

## Code example

The snippet below models the shape a generated bidirectional-streaming
service takes: independent send and receive halves over one call.

```rust
struct ClientMessage {
    session_id: String,
    text: String,
}

struct ServerMessage {
    session_id: String,
    reply: String,
}

// Stand-ins for the generated stream handles gRPC provides per call.
trait InboundStream {
    fn recv(&mut self) -> Option<ClientMessage>; // None when client half-closes
}

trait OutboundStream {
    fn send(&mut self, msg: ServerMessage);
}

// The server-side handler for `rpc Chat(stream ClientMessage) returns (stream ServerMessage)`.
// Reading and writing are independent: nothing requires replying once per
// received message, or in the same order they arrived.
fn handle_chat(inbound: &mut dyn InboundStream, outbound: &mut dyn OutboundStream) {
    while let Some(msg) = inbound.recv() {
        let reply = ServerMessage {
            session_id: msg.session_id,
            reply: format!("echo: {}", msg.text),
        };
        outbound.send(reply);
    }
}
```

`inbound.recv()` and `outbound.send()` are backed by the same HTTP/2
stream but operate independently — a real implementation would often
run the read loop and any server-initiated sends (not just replies) on
separate tasks, since neither direction blocks the other.

## When to use it

- Both client and server need to send an ongoing series of typed
  messages to each other over one call, not just a single exchange.
- A strongly-typed, versioned schema for every message is valuable —
  multiple services or teams consuming the same stream benefit from
  compiler-enforced message shapes rather than hand-parsed JSON.
- The deployment already has HTTP/2 support end-to-end (including any
  proxies or load balancers in front), and clients are typically other
  backend services or apps that can use a generated gRPC client, not
  a browser needing a plain WebSocket.

## When not to use it

- The client is a browser and needs a connection type it can open
  natively — browsers can't originate raw HTTP/2 gRPC streams directly
  without a proxy layer (e.g. gRPC-Web), whereas WebSockets are a
  native browser API.
- The message format needs to stay loose or human-readable without a
  compiled schema (e.g. rapidly evolving, ad hoc JSON payloads) — the
  overhead of maintaining `.proto` definitions isn't worth it if
  message shape flexibility matters more than type safety.
- Only one side ever needs to stream and the other just issues a
  single request or reply — a unary or one-directional streaming RPC
  is simpler and makes the intent clearer than forcing everything
  through the bidirectional shape.

## Real-world example

Google's own internal services, which gRPC was originally built to
support, use bidirectional streaming extensively for things like
long-lived coordination and telemetry channels between services; more
publicly, tools like `kubectl exec` and `kubectl attach` use a
bidirectional-streaming-style channel (gRPC-based in modern
implementations) to carry interactive stdin/stdout/stderr between a
client and a running container in both directions simultaneously.

## Related patterns

- [WebSockets](/docs/patterns/communication/websockets) — the
  general-purpose, browser-native full-duplex alternative; gRPC
  bidirectional streaming trades browser-native support for compiler-
  enforced message schemas and HTTP/2 multiplexing.

## Further reading

- [gRPC — Wikipedia](https://en.wikipedia.org/wiki/GRPC)
- [HTTP/2 — Wikipedia](https://en.wikipedia.org/wiki/HTTP/2)
- [Protocol Buffers — Wikipedia](https://en.wikipedia.org/wiki/Protocol_Buffers)
