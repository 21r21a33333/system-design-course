---
title: "Server-Sent Events"
sidebar_position: 4
supplementary: true
---

Server-Sent Events (SSE) is a one-way, HTTP-native streaming protocol in
which a server holds a single HTTP response open and pushes a continuous
stream of text events to a client over it, with automatic client-side
reconnection and event-id resumption built into the browser standard.

![Server-Sent Events diagram](/img/patterns/server-sent-events.svg)

## Problem it solves

Polling for updates — the client repeatedly asking "anything new?" —
wastes a request every interval when nothing has changed and adds latency
equal to the poll interval when something has. A full bidirectional
protocol is often more than the problem needs: a great many use cases only
ever require the server to push data *outward* — price ticks, notifications,
a progress bar, a live feed — and never require the client to send anything
back over the same channel. SSE fills exactly that gap with a mechanism
that is, at bottom, just an HTTP response the server never finishes:
cheaper than [WebSockets](/docs/patterns/communication/websockets) to
operate, and far more efficient than polling.

## Technical architecture & implementation

**One long-lived HTTP response.** The client opens a stream with the
browser `EventSource` API (or any HTTP client), issuing an ordinary GET
with `Accept: text/event-stream`. The server responds with
`Content-Type: text/event-stream`, keeps the connection open, and writes
events into the response body as they occur instead of ending it. Because
this is plain HTTP over the same connection model as any other request, it
passes through proxies, CDNs, and load balancers with no upgrade
handshake — the operational simplicity that most distinguishes it from
WebSockets, which must negotiate a `101 Switching Protocols` upgrade the
surrounding infrastructure has to permit.

**Event framing.** The wire format is line-oriented and human-readable.
Each event is a group of `field: value` lines terminated by a blank line,
which is what tells the parser the event is complete and can be
dispatched. The fields are `data:` (the payload — repeat it for a
multi-line message), `event:` (a named type the client can listen for
selectively), `id:` (a cursor the client remembers), and `retry:` (a
hint, in milliseconds, for how long to wait before reconnecting). A
`data:`-only event goes to the generic `message` handler; naming an
`event:` routes it to a specific listener instead.

**Automatic reconnection and `Last-Event-ID`.** This is SSE's quiet
superpower. If the connection drops, `EventSource` reconnects on its own —
no reconnect code in the application at all. Better, it sends the id of
the last event it received back in a `Last-Event-ID` request header, so
the server can resume the stream from the next event rather than replaying
from the start or silently losing whatever happened during the gap. A
server that assigns monotonically increasing ids and keeps a short backlog
turns a flaky network into a non-event. WebSockets, by contrast, leave
reconnection and resumption entirely to application code.

**Proxy and buffering pitfalls.** The most common way an SSE deployment
fails in production is a proxy or gateway that *buffers* the response
instead of streaming it — collecting bytes and forwarding them only when
the response ends, which for a never-ending response means the client
receives nothing. The fixes are to disable response buffering on the
intermediary for that route (for example, the `X-Accel-Buffering: no`
hint some proxies honor) and to ensure compression that buffers the whole
body isn't applied to the stream. Long-lived idle streams can also be cut
by aggressive idle timeouts, so servers commonly emit a periodic comment
line (a line beginning `:`) as a keep-alive.

**Connection limits per host.** Under HTTP/1.1, browsers cap concurrent
connections to a single origin at around six, and each open SSE stream
consumes one of those slots for its whole lifetime — a handful of streams
plus normal page requests can starve the origin. HTTP/2 removes this
constraint by multiplexing many streams over one connection, so serving
SSE over HTTP/2 is strongly preferred when many concurrent streams per
client are expected.

**Text only.** SSE is defined for UTF-8 text. Binary payloads must be
encoded (for example base64), which adds overhead — a case where
WebSockets' native binary frames are the better tool.

## Choosing between SSE, WebSockets, and polling

| Property | Server-Sent Events | WebSockets | Polling |
| --- | --- | --- | --- |
| Direction | Server → client only | Full-duplex | Client-initiated |
| Transport | Plain HTTP response | Upgraded TCP (RFC 6455) | Repeated HTTP requests |
| Payload | UTF-8 text only | Text and binary | Text and binary |
| Reconnect / resume | Automatic + `Last-Event-ID` | App-managed | Inherent per request |
| Proxy friendliness | High (may need buffering off) | Needs upgrade support | Highest |
| Client complexity | Minimal (`EventSource`) | Higher | Low but wasteful |
| Best fit | Feeds, notifications, progress | Chat, games, collaboration | Infrequent or simple polling |

Prefer SSE whenever the data flows one way (server to client) and you want
free reconnection with the least client code; step up to WebSockets only
when the client must also *send* frequently over the same channel.

## Code example

The core of SSE is the `text/event-stream` framing and the resume logic
that makes reconnection lossless. This serializes an event to the wire
format and, given a client's `Last-Event-ID`, selects exactly the backlog
events it hasn't seen yet.

```rust
/// One server-sent event: an optional id, an optional event type, and one or
/// more data lines. The wire format is line-oriented and terminated by a blank
/// line, which is what tells the browser's parser the event is complete.
pub struct Event {
    pub id: Option<String>,
    pub event: Option<String>,
    pub data: String,
}

impl Event {
    /// Serialize to the `text/event-stream` framing. Every field becomes a
    /// `field: value` line; multi-line data is split into one `data:` line per
    /// physical line (the spec concatenates them back with `\n` on the client).
    /// A trailing blank line dispatches the event.
    pub fn to_wire(&self) -> String {
        let mut out = String::new();
        if let Some(id) = &self.id {
            out.push_str("id: ");
            out.push_str(id);
            out.push('\n');
        }
        if let Some(event) = &self.event {
            out.push_str("event: ");
            out.push_str(event);
            out.push('\n');
        }
        for line in self.data.split('\n') {
            out.push_str("data: ");
            out.push_str(line);
            out.push('\n');
        }
        out.push('\n');
        out
    }
}

/// On reconnect the browser replays the last id it saw in a `Last-Event-ID`
/// request header. The server uses it to resume: skip everything already
/// delivered and stream only events with a newer id. Modeling ids as ordered
/// integers keeps the resume comparison exact.
pub fn resume_after(last_event_id: Option<u64>, backlog: &[(u64, Event)]) -> Vec<&Event> {
    let cutoff = last_event_id.unwrap_or(0);
    backlog
        .iter()
        .filter(|(id, _)| *id > cutoff)
        .map(|(_, ev)| ev)
        .collect()
}
```

Serializing an event with id `42`, type `price`, and two data lines
produces exactly `id: 42\nevent: price\ndata: line1\ndata: line2\n\n` —
the blank line at the end being the dispatch boundary. Given a
`Last-Event-ID` of `11` against a backlog of ids 10–12, `resume_after`
returns only event 12, and with no id supplied it replays the whole
backlog — precisely the resumption a reconnecting `EventSource` needs.

## When to use it

- Updates only ever flow server-to-client, and the client never needs to
  send data back over the same channel.
- Automatic reconnection with lossless resumption, and minimal client
  code, are valuable — live feeds, dashboards, notifications, progress.
- The path between client and server is plain-HTTP-friendly and you can
  ensure intermediaries stream rather than buffer the response.

## When not to use it

- The client also needs to send frequent messages back over the same
  channel — [WebSockets](/docs/patterns/communication/websockets) avoid
  running a second connection alongside the stream for that.
- Binary data must be streamed efficiently — SSE is UTF-8 text only, and
  base64-encoding binary wastes bandwidth.
- A proxy or gateway on the path insists on buffering responses and can't
  be configured to stream, which silently breaks the whole mechanism.

## Use-case scenarios

**Live financial or sports feed.** A server has a steady one-directional
stream of ticks or scores to push; the browser never talks back over the
connection, and automatic reconnection with `Last-Event-ID` means a brief
network drop resumes without a visible gap or any reconnect code in the
page. The event-id backlog guarantees no tick between drop and reconnect
is lost.

**Server-driven progress and notifications.** A long-running job — a
video encode, a report build, an import — streams progress percentages and
a final "done" event to the browser as `event:`-typed messages, and an
in-app notification center subscribes to a stream that pushes alerts the
instant they occur, replacing a polling loop that would either lag or
hammer the server.

**Streaming LLM tokens to a UI.** A model server emits generated tokens
as they are produced; SSE's incremental, one-way, text-native stream is a
natural fit, and the browser renders each token on arrival with no
bidirectional channel needed — one reason SSE is a common transport for
chat-style AI responses.

## Related patterns

- [WebSockets](/docs/patterns/communication/websockets) — the
  bidirectional alternative for when the client must also push data back;
  SSE is the simpler choice whenever the flow is one-way.
- [Publish-Subscribe](/docs/patterns/communication/pub-sub) — the server
  side of an SSE endpoint often subscribes to a pub/sub topic and relays
  each message onto the open stream.
- [Event-Driven Architecture](/docs/patterns/communication/event-driven-architecture) —
  SSE is a common last-mile delivery of domain events to a browser.
- [Webhooks](/docs/patterns/communication/webhooks) — the server-to-server
  cousin: where SSE streams events to a connected browser, webhooks POST
  them to another server's callback URL.

## Further reading

- [Using server-sent events — MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
- [Server-sent events — HTML Living Standard (WHATWG)](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- [EventSource interface reference — MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)
