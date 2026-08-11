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

## Technical architecture & implementation

**Declaration and code generation.** A bidirectional-streaming RPC is
declared in a `.proto` file with the `stream` keyword on both the
request and response types, e.g. `rpc Chat(stream ClientMessage)
returns (stream ServerMessage)`. The Protocol Buffers compiler
generates, for every target language, a typed client stub and a server
skeleton whose signatures expose two independent stream handles — one
to send, one to receive. The message shapes are fixed by the schema on
both ends, so a malformed or mistyped message is rejected by the
generated code rather than discovered as a runtime bug, and both sides
agree on field names, types, and structure with no runtime parsing or
shape negotiation.

**Stream lifecycle over one HTTP/2 stream.** When the client calls the
RPC, gRPC opens a single HTTP/2 *stream* for that call — not a new
connection, but one logical stream multiplexed over the underlying
HTTP/2 connection. The call begins with the client sending HTTP/2
HEADERS (method path, deadline, metadata); thereafter each side sends
any number of length-prefixed Protobuf messages as DATA frames,
interleaved in either order. Each side **half-closes independently**:
the client signals end-of-stream on its send half while still
receiving, and the server finishes by sending trailers carrying the
final gRPC status code. The call is complete only when both halves
close. This half-close asymmetry is what lets, say, a client stream an
entire audio file and *then* keep receiving transcription results after
it has stopped sending.

**Flow control and backpressure.** HTTP/2 applies flow control at both
the stream and the connection level via `WINDOW_UPDATE` frames: a
receiver advertises how many bytes it is willing to accept, and a
sender that exhausts that window must stop until the window is
replenished. Because gRPC rides on this, a fast producer cannot
unboundedly overrun a slow consumer — the transport itself applies
backpressure, surfaced in the language APIs as a `send` that blocks or
returns "not ready" until the peer drains. Correctly propagating that
signal (not buffering unboundedly in application code to "hide" it) is
what keeps a streaming service from running out of memory under load.

**Ordering, multiplexing, and head-of-line caveats.** Messages
*within a single stream* are delivered in the order they were sent —
gRPC does not reorder a stream. Across *different* streams there is no
ordering guarantee, which is fine because independent RPCs are
independent. HTTP/2 multiplexes many such streams over one TCP
connection, so a client can run several concurrent bidirectional RPCs
to the same server without a connection each. The known caveat is
TCP-level head-of-line blocking: because all HTTP/2 streams share one
TCP connection, a lost TCP segment stalls *every* stream on that
connection until retransmission — the problem HTTP/3 (QUIC) exists to
solve.

**Deadlines and cancellation.** A gRPC call carries a **deadline**
propagated in the request metadata; when it elapses, both client and
server observe the call as `DEADLINE_EXCEEDED` and can stop work,
which matters far more for a long-lived stream than for a fast unary
call. Either side can also **cancel** explicitly (the client drops the
call, or the server aborts), sending an HTTP/2 `RST_STREAM` that tears
down that one stream without disturbing others on the connection.
Well-behaved handlers watch for cancellation and stop producing rather
than filling a window nobody will ever read.

**Message and schema semantics.** Each message is a Protocol Buffers
message encoded from the same `.proto` schema on both ends, so both
sides agree on structure without runtime negotiation — the type safety
that distinguishes gRPC streaming from an opaque byte channel, detailed
in the sibling comparison below.

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

## Choosing among the four RPC types and duplex transports

Bidirectional streaming is one of gRPC's four call shapes; reaching for
it when a simpler one fits just adds concurrency you have to manage on
both sides. Pick the least-powerful shape that models the interaction:

| RPC type | Client sends | Server sends | Use it for |
| --- | --- | --- | --- |
| **Unary** | one | one | ordinary request/response — a plain method call |
| **Server streaming** | one | many | one request that yields a feed (results, live updates) |
| **Client streaming** | many | one | upload/aggregate a sequence, get one summary |
| **Bidirectional** | many | many | continuous duplex — chat, telemetry+acks, interactive sessions |

And against the non-gRPC duplex options a browser or generic client
might use instead:

| | gRPC bidi streaming | WebSocket | Server-Sent Events |
| --- | --- | --- | --- |
| **Direction** | full duplex | full duplex | server → client only |
| **Schema/codegen** | Protobuf, compiler-enforced | none (hand-rolled) | none (text events) |
| **Transport** | HTTP/2 stream (multiplexed) | dedicated TCP per channel | one HTTP response |
| **Flow control** | built into HTTP/2 | application must add | n/a |
| **Browser-native** | no (needs gRPC-Web/proxy) | yes | yes |
| **Best for** | typed service-to-service duplex | ad-hoc browser duplex | one-way live feeds |

The short version: choose **gRPC bidi** for typed, multiplexed,
flow-controlled duplex between services that can run a generated stub;
choose [WebSockets](/docs/patterns/communication/websockets) for
browser-native duplex with a loose message format; and choose
[Server-Sent Events](/docs/patterns/communication/server-sent-events)
when only the server needs to stream and a plain HTTP response suffices.

## Code example

The snippet below models the shape a generated bidirectional-streaming
service takes and demonstrates the property that matters: the read half
and the write half are **genuinely independent**. The server runs a
receive loop *and* an unprompted heartbeat sender on separate real
threads, and the `main` timing proves neither direction blocks the
other — the heartbeats keep flowing on their own schedule while
requests are still being received and echoed.

```rust
use std::sync::mpsc::{channel, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

struct ClientMessage {
    session_id: String,
    text: String,
}

struct ServerMessage {
    session_id: String,
    reply: String,
}

// The server-side handler for
// `rpc Chat(stream ClientMessage) returns (stream ServerMessage)`.
// `inbound` is the receive half; `outbound` is the send half. They run
// on separate threads so a server-initiated push (a heartbeat here) does
// not wait for, or block, the request-echo loop.
fn handle_chat(inbound: Receiver<ClientMessage>, outbound: Sender<ServerMessage>) {
    let hb_out = outbound.clone();
    let heartbeat = thread::spawn(move || {
        for _ in 0..3 {
            thread::sleep(Duration::from_millis(20));
            // Unprompted server->client message: not a reply to anything.
            if hb_out
                .send(ServerMessage {
                    session_id: "srv".into(),
                    reply: "heartbeat".into(),
                })
                .is_err()
            {
                return; // client half closed
            }
        }
    });

    // Echo loop: reads until the client half-closes (channel disconnects).
    for msg in inbound {
        outbound
            .send(ServerMessage {
                session_id: msg.session_id,
                reply: format!("echo: {}", msg.text),
            })
            .ok();
    }
    heartbeat.join().ok();
}

fn main() {
    let (to_server, from_client) = channel::<ClientMessage>();
    let (to_client, from_server) = channel::<ServerMessage>();

    let server = thread::spawn(move || handle_chat(from_client, to_client));

    // Client streams 3 requests, one every 30 ms, then half-closes.
    let start = Instant::now();
    let client = thread::spawn(move || {
        for i in 0..3 {
            thread::sleep(Duration::from_millis(30));
            to_server
                .send(ClientMessage {
                    session_id: "c1".into(),
                    text: format!("msg{i}"),
                })
                .ok();
        }
        // Dropping `to_server` half-closes the client's send stream.
    });

    // Drain everything the server sends until it closes its half.
    let mut echoes = 0;
    let mut heartbeats = 0;
    for m in from_server {
        match m.reply.as_str() {
            "heartbeat" => heartbeats += 1,
            _ => echoes += 1,
        }
    }

    client.join().unwrap();
    server.join().unwrap();
    let elapsed = start.elapsed();

    // If the halves were serialized, heartbeats couldn't interleave with
    // echoes and total time would be the SUM of both schedules. Instead
    // they overlap: ~90 ms of client sends run concurrently with the
    // heartbeat schedule, not after it.
    println!(
        "echoes={echoes} heartbeats={heartbeats} elapsed={}ms",
        elapsed.as_millis()
    );
}
```

Running it prints something like `echoes=3 heartbeats=3 elapsed=97ms`:
the three heartbeats (on a 20 ms cadence, ~60 ms total) interleave with
the three echoed requests (on a 30 ms cadence, ~90 ms total) rather
than running one schedule after the other — serialized, the two would
sum to ~150 ms. That overlap is the whole point of bidirectional
streaming: `inbound` and `outbound` are backed by the same HTTP/2
stream but neither direction waits on the other.

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

## Use-case scenarios

**Interactive container sessions.** `kubectl exec` and `kubectl attach`
carry interactive `stdin`/`stdout`/`stderr` between a client and a
running container in both directions at once — keystrokes flowing one
way while output streams back the other. A bidirectional stream models
this exactly: neither side takes turns, and the deadline/cancellation
machinery cleanly tears the session down when the client disconnects.

**Real-time telemetry with acknowledgments.** A fleet of edge devices
streams metrics to a collector service while the collector streams
back control messages — sampling-rate changes, backpressure signals,
config pushes — over the same call. HTTP/2 flow control keeps a chatty
device from overrunning the collector, and the typed schema means a new
telemetry field is a compiler-checked change, not a JSON parsing
surprise across hundreds of device builds.

**Speech transcription and live translation.** A client streams audio
frames continuously while the server streams back incremental
transcription (or translated) results, correcting earlier guesses as
more audio arrives. The half-close asymmetry is essential: the client
signals end-of-audio on its send half, then keeps receiving the final
tail of results after it has stopped sending. This is a canonical
public gRPC bidi use case in cloud speech APIs.

## Related patterns

- [WebSockets](/docs/patterns/communication/websockets) — the
  general-purpose, browser-native full-duplex alternative; gRPC
  bidirectional streaming trades browser-native support for compiler-
  enforced message schemas and HTTP/2 multiplexing.
- [Server-Sent Events](/docs/patterns/communication/server-sent-events) —
  the simpler one-directional (server → client) streaming choice when
  the client never needs to stream back over the same channel.
- [Timeout](/docs/patterns/reliability/timeout) — the deadline a gRPC
  call carries end-to-end is a propagated form of this, bounding how
  long a stream may run before both sides give up.

## Further reading

- [gRPC — official documentation](https://grpc.io/docs/what-is-grpc/core-concepts/)
- [gRPC over HTTP/2 protocol specification](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md)
- [RFC 7540: HTTP/2 (stream multiplexing and flow control)](https://www.rfc-editor.org/rfc/rfc7540)
- [gRPC — Wikipedia](https://en.wikipedia.org/wiki/GRPC)
- [Protocol Buffers — Wikipedia](https://en.wikipedia.org/wiki/Protocol_Buffers)
