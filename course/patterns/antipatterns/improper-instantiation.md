---
title: "Improper Instantiation"
sidebar_position: 5
supplementary: true
---

Improper instantiation is repeatedly creating and destroying an object
that's expensive to construct — an HTTP client, a database connection,
a cryptographic context — instead of creating it once and reusing it
across many operations. Many such objects are deliberately designed to
be thread-safe and long-lived precisely so they can be shared; creating
a fresh one per request or per call throws that design away and pays
its construction cost over and over for no benefit.

![Improper Instantiation diagram](/img/patterns/improper-instantiation.svg)

## How it manifests

The most common concrete case is an HTTP client library instantiated
fresh inside a request handler or a per-call function — `new HttpClient()`
(or the equivalent constructor in whatever language) called on every
single outbound request instead of once at startup and reused. Many
HTTP client implementations maintain their own internal connection
pool, DNS cache, and TLS session cache across their lifetime; a client
created and immediately discarded per call never benefits from any of
that, and worse, under load can exhaust the OS's available ephemeral
ports or file descriptors, because each short-lived client opens (and
then closes) its own sockets rather than sharing a pool of already-warm
ones. Symptoms include intermittent connection-refused or
socket-exhaustion errors under load that don't reproduce in
low-concurrency testing, plus consistently higher per-request latency
than the same operation would take on a warm, reused connection. This
exact failure mode is well documented for .NET's `HttpClient`: each
instance owns its own connection pool, so disposing and recreating one
per request means every request opens fresh sockets instead of reusing
already-open ones, which is exactly what runs an application out of
available sockets under real load. Microsoft's own guidance is
explicit that reusing a single `HttpClient` (directly, or via
`IHttpClientFactory`) is what avoids the socket-exhaustion issue,
rather than constructing and disposing one per request.

The same shape recurs with database connections and clients — creating
a fresh connection (or a fresh connection pool) per request instead of
reusing a pool created once at application startup — and with
cryptographic primitives, where constructing a fresh keyed hash or
cipher context per operation instead of reusing one across many
operations pays repeated, avoidable setup cost. It also shows up
subtly with dependency-injection containers configured to construct a
"per-request" or "transient" lifetime for a service that's actually
stateless and safe to share, when a singleton lifetime would have been
both correct and cheaper — the container faithfully constructs a new
instance every time it's asked, exactly as configured, and nothing
about that looks wrong in code review because the lifetime
configuration is usually several files away from any call site.

Profiling a system with this antipattern typically shows a
disproportionate share of CPU time in constructor and destructor-like
code paths (setup, teardown, connection establishment) relative to the
time spent in the actual operation the object exists to perform — a lot
of overhead spent standing something up and tearing it back down around
a comparatively small amount of real work.

## Why it happens

Constructing an object exactly where it's used is the most locally
obvious way to write the code — `new HttpClient()` right next to the
`.get()` call that uses it reads clearly and doesn't require the reader
to trace where the client came from. Passing a shared, long-lived
instance in from outside requires either a dependency-injection setup
or explicitly threading a reference through function signatures, both
of which are more structure than a quick "just call the API" function
seems to need, especially early in a project when there's only one call
site and no load to speak of.

It's also often not obvious from the object's API surface that
construction is expensive — a constructor call looks identical whether
it's allocating a small struct or opening sockets and negotiating TLS,
so a reasonable-looking piece of code (`let client = HttpClient::new();`
at the top of a function) gives no visual signal that it shouldn't be
called from inside a loop or a hot path. Under light load or in local
testing, a fresh client per call is genuinely fine — the extra
milliseconds per construction don't register — so the cost is invisible
until concurrency and request volume both climb.

## Code example (the antipattern)

```rust
struct HttpClient {
    // Stand-in for real state: a connection pool, DNS cache, TLS
    // session cache — all expensive to establish and valuable to
    // reuse across many calls.
    connections_established: u32,
}

impl HttpClient {
    fn new() -> Self {
        // Represents genuinely expensive setup work in a real client:
        // opening sockets, negotiating TLS, warming a connection pool.
        HttpClient {
            connections_established: 1,
        }
    }

    fn get(&self, _url: &str) -> String {
        "response body".to_string()
    }
}

// A fresh client — and all the setup cost that implies — is created
// and then immediately discarded on every single call.
fn fetch_user_profile(user_id: u64) -> String {
    let client = HttpClient::new();
    client.get(&format!("/users/{user_id}"))
}

fn fetch_many(user_ids: &[u64]) -> Vec<String> {
    user_ids.iter().map(|id| fetch_user_profile(*id)).collect()
}
```

## The fix

```rust
struct HttpClient {
    connections_established: u32,
}

impl HttpClient {
    fn new() -> Self {
        HttpClient {
            connections_established: 1,
        }
    }

    fn get(&self, _url: &str) -> String {
        "response body".to_string()
    }
}

// The client is constructed once and shared by reference across every
// call — its internal connection pool and caches stay warm and are
// reused instead of being rebuilt from scratch each time.
fn fetch_user_profile(client: &HttpClient, user_id: u64) -> String {
    client.get(&format!("/users/{user_id}"))
}

fn fetch_many(client: &HttpClient, user_ids: &[u64]) -> Vec<String> {
    user_ids
        .iter()
        .map(|id| fetch_user_profile(client, *id))
        .collect()
}

fn app_startup() -> HttpClient {
    // Constructed exactly once, for the lifetime of the process (or
    // request-handling worker), and passed by reference to every call
    // site that needs it.
    HttpClient::new()
}
```

The fix moves construction out of the per-call path entirely: the
client is built once, during startup, and every call site receives a
shared reference to that single instance instead of building its own.
The setup cost is paid once total instead of once per call, and the
client's internal pooling and caching — the entire reason such clients
are usually built to be reusable — actually gets to do its job.

## How to detect it

Profiling that shows a disproportionate share of time in constructor,
connection-establishment, or teardown code relative to time spent in
the actual operation is the clearest signal — a flame graph where
"open connection" or "new client" frames are wide relative to the work
they wrap around points directly at this antipattern. Connection or
socket-count metrics that scale with request rate rather than staying
roughly flat (as they should for a shared, pooled resource) indicate
connections are being opened and closed per call instead of reused.
Intermittent `SocketException`, "too many open files," or ephemeral
port exhaustion errors that appear specifically under load and vanish
at low concurrency are a strong operational tell, since a properly
shared and pooled client wouldn't be opening enough concurrent raw
sockets to hit those limits in the first place.

## When it's actually fine

Not every object is expensive to construct — a small struct, a plain
value type, or anything whose constructor does no I/O and allocates
trivially costs essentially nothing to create fresh each time, and
forcing such objects to be shared and long-lived adds unnecessary
lifetime-management complexity for no real savings. Short-lived
scripts and one-shot CLI tools that make a handful of calls over their
entire lifetime and then exit don't have a hot path for the
construction cost to compound against — creating one client for one
script run is exactly what "expensive to construct" objects are fine
to do when there's no reuse opportunity to lose. And in some designs, a
fresh instance is actually required for correctness — a per-request
security context or a scoped transaction object that must not leak
state between callers is deliberately not meant to be shared, and reuse
there would be its own bug.

## Libraries & tools that prevent this

These tools make the expensive object reusable — a connection pool, a factory that hands back a shared long-lived client, or a session/agent that keeps sockets and TLS warm across calls instead of rebuilding them per request.

| Library / Tool | Language | How it helps | Getting started |
| --- | --- | --- | --- |
| HikariCP | JVM | Fast JDBC connection pool that maintains a fixed set of warm database connections handed out for reuse instead of opening one per request. | [github.com/brettwooldridge/HikariCP](https://github.com/brettwooldridge/HikariCP) |
| PgBouncer | PostgreSQL / any | External connection pooler so short-lived app calls share a warm pool rather than establishing a fresh backend each time. | [pgbouncer.org](https://www.pgbouncer.org/) |
| `IHttpClientFactory` | .NET | Manages the lifetime of `HttpClient` handlers so they're reused with pooled connections, avoiding both socket exhaustion and stale-DNS pitfalls of per-call construction. | [learn.microsoft.com](https://learn.microsoft.com/en-us/dotnet/core/extensions/httpclient-factory) |
| reqwest `Client` | Rust | Documented as a pool of connections meant to be created once and reused; cloning shares the pool rather than rebuilding it. | [docs.rs/reqwest](https://docs.rs/reqwest/latest/reqwest/struct.Client.html) |
| `requests.Session` | Python | Reuses the underlying TCP connection and TLS across requests to the same host instead of a fresh connection per call. | [requests.readthedocs.io](https://requests.readthedocs.io/en/latest/user/advanced/#session-objects) |
| `http.Agent` (keep-alive) | Node.js (JS/TS) | A shared agent with keep-alive pools sockets across requests so outbound HTTP reuses warm connections. | [nodejs.org docs](https://nodejs.org/api/http.html#class-httpagent) |

**Example / reference:** [HttpClient guidelines for .NET — Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/fundamentals/networking/http/httpclient-guidelines)

## Related patterns

- [Connection Pooling](/docs/patterns/scaling/connection-pooling) — the
  direct corrective pattern for database connections specifically:
  maintain a fixed set of already-open connections and hand them out
  for reuse instead of opening and closing one per request.

## Further reading

- [Improper Instantiation antipattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/antipatterns/improper-instantiation/)
- [Connection pool — Wikipedia](https://en.wikipedia.org/wiki/Connection_pool)
- [Guidelines for using HttpClient — .NET documentation, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/fundamentals/networking/http/httpclient-guidelines) — the canonical, well-documented real case of this exact antipattern and its fix.
- [System Design roadmap — roadmap.sh](https://roadmap.sh/system-design) — includes Improper Instantiation as a named antipattern topic.
- [HttpClient guidelines for .NET — Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/fundamentals/networking/http/httpclient-guidelines)
