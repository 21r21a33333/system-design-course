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

Node.js's own documentation makes the rationale for avoiding this
explicit, since it's baked directly into the runtime's design: Node.js
executes JavaScript on a single thread, so any blocking call would stall
every other request that thread could otherwise be servicing during an
I/O wait — the runtime's non-blocking, event-loop model exists
specifically so that a request spending most of its time waiting on
database or network I/O doesn't cost a dedicated, otherwise-idle thread
for that entire wait.

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
use std::thread;

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
    // Same blocking calls as before — the fix isn't making the I/O
    // itself non-blocking, it's making sure the three independent
    // calls don't block *each other* by serializing on one thread.
    fn fetch_profile(&self, _user_id: u64) -> UserProfile {
        UserProfile { name: "Ada".to_string() }
    }
    fn fetch_orders(&self, _user_id: u64) -> OrderHistory {
        OrderHistory { count: 3 }
    }
    fn fetch_recommendations(&self, _user_id: u64) -> Recommendations {
        Recommendations { items: vec!["widget".to_string()] }
    }
}

// Each independent call is handed to its own OS thread, so all three
// are in flight at once; the calling thread then blocks on `join`,
// which only waits for the *slowest* of the three rather than the sum
// of all three. This is genuine concurrency (three threads actually
// running/waiting at the same time), not just async syntax that never
// gets polled concurrently.
fn build_dashboard(
    client: &'static Client,
    user_id: u64,
) -> (UserProfile, OrderHistory, Recommendations) {
    let profile_handle = thread::spawn(move || client.fetch_profile(user_id));
    let orders_handle = thread::spawn(move || client.fetch_orders(user_id));
    let recs_handle = thread::spawn(move || client.fetch_recommendations(user_id));

    let profile = profile_handle.join().expect("profile thread panicked");
    let orders = orders_handle.join().expect("orders thread panicked");
    let recs = recs_handle.join().expect("recommendations thread panicked");
    (profile, orders, recs)
}
```

The fix's core move is starting all three calls before waiting on any
of them: `thread::spawn` returns immediately and the call actually
begins running on its own thread, so by the time the first `.join()`
runs, all three are already in flight concurrently. Total wait time
approaches the slowest single call rather than the sum of all three,
and — just as importantly — the calling thread is never the one doing
the blocking wait for all three in sequence, which is the specific
defect the original code had. (A production system would more likely
use an async runtime's task-based concurrency here instead of raw
OS threads, for lower per-call overhead at high fan-out; the structural
fix is the same either way — stop awaiting each call before starting
the next one.)

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
- [Overview of Blocking vs. Non-Blocking — Node.js documentation](https://nodejs.org/en/learn/asynchronous-work/overview-of-blocking-vs-non-blocking) — a widely used runtime's own documented rationale for its non-blocking I/O model.
- [System Design roadmap — roadmap.sh](https://roadmap.sh/system-design) — includes Synchronous I/O as a named antipattern topic.
