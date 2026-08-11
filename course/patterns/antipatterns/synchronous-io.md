---
title: "Synchronous I/O"
sidebar_position: 10
supplementary: true
---

The synchronous I/O antipattern is blocking the calling thread while
waiting on an I/O operation — a network call, a disk read, a database
query — instead of using non-blocking or asynchronous I/O that frees
the thread to do other work while the operation is in flight. The
thread sits idle, holding its stack and any resources it owns, doing
nothing but waiting, when it could be serving another request during
that same wait.

![Synchronous I/O diagram](/img/patterns/synchronous-io.svg)

## How it manifests

The defining symptom is a request-handling thread that's measured as
"busy" by the runtime or OS scheduler while doing no actual CPU work —
it's parked in a blocking system call (a socket read, a file read,
waiting on a database driver) for the majority of the request's total
duration. In a threading model with a fixed-size pool serving requests,
this directly caps throughput at a number far below what the hardware
could otherwise sustain: if the average request spends 95% of its time
blocked waiting on a downstream call and only 5% doing actual CPU work,
a pool of 100 threads can have at most 100 requests in flight
simultaneously — including ones parked entirely on I/O — even though
the CPU itself is sitting almost completely idle and could easily
support far more concurrent requests if the wait time didn't consume a
whole thread.

Under load, this shows up as thread pool exhaustion and request
queueing well before CPU utilization looks high: monitoring shows CPU
at a modest percentage while thread pool utilization is pinned near
100%, and new requests queue waiting for a thread to free up — a thread
that's sitting there doing nothing but blocked on I/O, not actually
computing anything. Increasing the thread pool size is the common
first response, and it works, up to a point — each additional thread
has real memory cost (a full stack, typically a megabyte or more by
default in many runtimes) and real context-switching cost, so scaling
concurrency purely by adding blocked threads runs into memory and
scheduler-overhead limits long before it runs into genuine CPU limits.

It also shows up in code structure directly: a call chain making
several sequential blocking calls to independent downstream services —
fetch user profile, then (after that fully completes) fetch order
history, then (after that fully completes) fetch recommendations — when
those calls have no actual dependency on each other and could be
issued concurrently, with the thread blocked for the sum of all three
wait times instead of the maximum of the three.

## Why it happens

Synchronous code is simply easier to read and reason about — a
sequence of blocking calls, each one completing before the next line
runs, matches how most programmers instinctively think about a
sequence of steps far more directly than callback chains, futures, or
async/await syntax do, especially for anyone newer to a language's
concurrency model. Blocking I/O is very often the default a language or
framework hands you unless you deliberately reach for the async
alternative, so the path of least resistance produces blocking code
unless someone specifically chooses otherwise.

It's also invisible under light load: with few concurrent requests, a
blocked thread costs nothing observable — there's always another idle
thread in the pool ready to serve the next request, so the wasted
capacity doesn't show up as a symptom anyone notices. The cost only
materializes once concurrent request volume approaches the size of the
thread pool, which is a scale point that's easy to not have tested
against, especially if load testing happened early in a project's life
when traffic assumptions were much lower than what production
eventually sees.

## Code example (the antipattern)

```rust
struct UserProfile {
    name: String,
}
struct OrderHistory {
    count: u32,
}
struct Recommendations {
    items: Vec<String>,
}

struct Client;
impl Client {
    // Each of these represents a blocking network call — the calling
    // thread is parked, doing nothing, for the full round-trip time.
    fn fetch_profile_blocking(&self, _user_id: u64) -> UserProfile {
        UserProfile { name: "Ada".to_string() }
    }
    fn fetch_orders_blocking(&self, _user_id: u64) -> OrderHistory {
        OrderHistory { count: 3 }
    }
    fn fetch_recommendations_blocking(&self, _user_id: u64) -> Recommendations {
        Recommendations { items: vec!["widget".to_string()] }
    }
}

// Three independent calls issued strictly sequentially — the thread
// is blocked for the sum of all three wait times, even though none of
// these calls depends on either of the others' results.
fn build_dashboard(client: &Client, user_id: u64) -> (UserProfile, OrderHistory, Recommendations) {
    let profile = client.fetch_profile_blocking(user_id);
    let orders = client.fetch_orders_blocking(user_id);
    let recs = client.fetch_recommendations_blocking(user_id);
    (profile, orders, recs)
}
```

## The fix

```rust
use std::future::Future;
use std::pin::Pin;

struct UserProfile {
    name: String,
}
struct OrderHistory {
    count: u32,
}
struct Recommendations {
    items: Vec<String>,
}

struct Client;
impl Client {
    // Async equivalents — issuing the call no longer blocks the
    // calling task; it yields control while the I/O is in flight.
    fn fetch_profile(&self, _user_id: u64) -> Pin<Box<dyn Future<Output = UserProfile>>> {
        Box::pin(async { UserProfile { name: "Ada".to_string() } })
    }
    fn fetch_orders(&self, _user_id: u64) -> Pin<Box<dyn Future<Output = OrderHistory>>> {
        Box::pin(async { OrderHistory { count: 3 } })
    }
    fn fetch_recommendations(&self, _user_id: u64) -> Pin<Box<dyn Future<Output = Recommendations>>> {
        Box::pin(async { Recommendations { items: vec!["widget".to_string()] } })
    }
}

// All three independent calls are started concurrently and awaited
// together — total wait time is close to the slowest single call
// rather than the sum of all three, and no thread sits blocked while
// any one of them is in flight.
async fn build_dashboard(
    client: &Client,
    user_id: u64,
) -> (UserProfile, OrderHistory, Recommendations) {
    let profile_fut = client.fetch_profile(user_id);
    let orders_fut = client.fetch_orders(user_id);
    let recs_fut = client.fetch_recommendations(user_id);

    let profile = profile_fut.await;
    let orders = orders_fut.await;
    let recs = recs_fut.await;
    (profile, orders, recs)
}
```

The fix has two parts working together: switching from blocking calls
to `async` ones means the runtime can schedule other work on the same
thread while any one call is waiting on I/O, instead of parking the
thread; and starting all three futures before awaiting any of them
means the three independent calls actually run concurrently rather than
one after another, so total latency approaches the slowest single call
instead of the sum of all three.

## How to detect it

Thread pool or worker utilization pinned near capacity while CPU
utilization on the same host stays comparatively low is the clearest
structural signal — it means threads are occupied without doing actual
computation, which is exactly what a blocked-on-I/O thread looks like.
A profiler or thread dump showing a large share of threads parked in a
blocking I/O call (visible in the stack trace as a socket read, file
read, or database driver wait) rather than executing application code
confirms it directly. Request latency that scales with the *sum* of
several downstream call durations, when those downstream calls have no
actual dependency on each other and could in principle run
concurrently, indicates sequential blocking calls rather than
concurrent async ones. Throughput that fails to scale further as load
increases, plateauing at a ceiling that correlates suspiciously closely
with thread pool size rather than with any CPU or memory limit, is a
strong sign that thread-per-blocked-request is the actual bottleneck.

## When it's actually fine

Single-threaded batch scripts and command-line tools with no concurrent
load — a nightly job that processes one file, or a CLI tool a single
user runs interactively — have nothing else that thread could be doing
while it waits, so blocking I/O costs nothing relative to the async
alternative and adds no complexity for zero benefit. Low-concurrency
internal services, where the number of simultaneous requests will never
realistically approach the thread pool size, don't experience the
capacity ceiling this antipattern describes — the inefficiency exists
in principle but is never actually exercised. And synchronous I/O is
also simply easier to reason about and debug (stack traces are linear,
not scattered across callback or future continuations), which is a
real, legitimate reason to prefer it whenever the concurrency ceiling
it implies is comfortably above any load the system will actually see.

## Related patterns

- [Asynchronous Request-Reply](/docs/patterns/communication/asynchronous-request-reply) —
  applies the same non-blocking principle at the client-facing API
  level: acknowledge a request immediately and let the caller poll or
  be notified, rather than holding a connection open and a thread
  blocked for the full duration of the underlying work.
- [Connection Pooling](/docs/patterns/scaling/connection-pooling) — a
  complementary fix for one specific source of blocking wait
  (acquiring a database connection); reusing warm connections reduces
  how long a thread spends blocked before it even reaches the actual
  query.

## Further reading

- [Synchronous I/O antipattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/antipatterns/synchronous-io/)
- [Asynchronous I/O — Wikipedia](https://en.wikipedia.org/wiki/Asynchronous_I/O)
- [Blocking (computing) — Wikipedia](https://en.wikipedia.org/wiki/Blocking_(computing))
