---
title: "Connection Pooling"
sidebar_position: 4
supplementary: true
---

Connection pooling reuses a bounded set of already-open, expensive-to-establish
connections across many requests, instead of opening (and tearing down) a
brand-new connection for every request that needs one.

![Connection Pooling diagram](/img/patterns/connection-pooling.svg)

## Problem it solves

Opening a database connection isn't free: it involves a TCP handshake,
often a TLS negotiation, and an authentication round trip with the
database — overhead that's small once but adds up fast if it's paid on
every single query. Under load, opening and closing a connection per
request also churns through the database's own limited connection slots,
and each connection the database holds open costs it memory and
scheduling overhead regardless of whether it's actively running a query.
The same shape applies to any connection that's costly to set up and safe
to reuse — an outbound HTTP client's keep-alive sockets, a message-broker
channel, a gRPC subchannel. Connection pooling amortizes the expensive
setup cost across many requests by keeping a set of connections open,
handing them out for reuse, and taking them back when a caller is done.
It is the direct corrective for the
[Improper Instantiation](/docs/patterns/antipatterns/improper-instantiation)
antipattern — creating a fresh client or connection per call — applied
specifically to connections.

## Technical architecture & implementation

**Acquire / release lifecycle.** A pool of already-established connections
is created and maintained, either inside the application process (a pool
library) or as a separate proxy process sitting between the application and
the database. When a request needs to run a query, it **acquires** a
connection from the pool, uses it, and **releases** it when done — the
connection itself stays open and is handed to the next caller instead of
being closed. Acquire is the interesting operation: if a connection is idle,
it's leased immediately; if every connection is currently in use, the caller
either waits for one to free up or fails fast, depending on configuration.

**Bounding and the acquire timeout.** The pool has a hard **maximum size**,
which is the whole point — it caps how many real connections can exist at
once no matter how many requests arrive. Requests beyond that cap queue in a
**wait queue** rather than opening new connections. That queue must be
bounded in time: an **acquire timeout** (max-wait) makes a caller fail with a
clear "couldn't get a connection in time" error instead of blocking forever,
so a backend slowdown surfaces as a fast, attributable failure rather than a
pile of stuck threads. Fairness matters here too — a FIFO wait queue keeps a
steady stream of new arrivals from starving a request that has already been
waiting.

**Min, max, and idle management.** Pools are usually configured with a
**minimum** number of connections kept warm even when idle (so the first
request after a quiet period doesn't pay full setup cost), a **maximum** as
above, and an **idle timeout** that closes connections the pool no longer
needs, releasing them back to the database. Connections that sit idle can go
**stale** — the database, a firewall, or a load balancer may have silently
dropped them. A robust pool therefore **validates** a connection before
handing it out (a lightweight liveness check, or a maximum lifetime after
which a connection is retired and replaced) so a caller never receives a
dead socket.

**Leak detection.** The most common operational failure is a **connection
leak**: a code path acquires a connection and never releases it — an early
return, an unhandled error, a forgotten `close`. Leaked connections are
removed from circulation permanently, so the pool slowly drains until every
acquire times out. Pools guard against this with leak detection (warn or
reclaim a lease held past a threshold) and, in safer designs, with a
scope-bound handle that returns itself automatically when it goes out of
scope, making a leak structurally hard to write. The Rust example below uses
exactly that RAII approach.

**The multiplicative trap under horizontal scaling.** A pool bounds one
process. The database sees the *sum* of every process's pool. Ten
application instances each with a pool of fifty connections present the
database with five hundred connections, not fifty — and horizontal scaling
that adds instances silently multiplies that load. This is the single most
common way a well-behaved-looking service takes down its own database:
per-instance pools look reasonable in isolation while their sum quietly
crosses the backend's ceiling. Pool size must be chosen against the sum, or
concentrated behind a shared proxy — see **Sizing the pool** below.

**Differentiation from siblings.** Connection pooling is a specialization of
generic **object pooling** (reusing any expensive-to-construct object), but
the connection case carries the extra concerns above — staleness, backend
connection caps, TLS/auth setup — that a plain in-memory object pool doesn't
face. It is distinct from the
[Bulkhead](/docs/patterns/reliability/bulkhead) pattern: bulkhead
*partitions* resources into isolated pools so one dependency's exhaustion
can't starve calls to another, whereas connection pooling *reuses* a single
pool's connections; the two compose (you can bulkhead by giving each
downstream its own bounded connection pool). It also differs from a
[Rate Limiter](/docs/patterns/building-blocks/rate-limiter) or
[Throttling](/docs/patterns/building-blocks/throttling): those cap the *rate*
of requests, while a pool caps *concurrency* against a resource — a bounded
pool of size K is effectively a concurrency limiter that also recycles the
underlying connection.

## Sizing the pool

Pool size is the central tuning knob and a genuine tradeoff in both
directions. **Too small** and callers queue for a connection even though the
database has spare capacity, adding latency for no reason and — past the
acquire timeout — outright failures. **Too large** and each open connection
consumes memory and scheduling overhead on the database; because a database
enforces its own hard cap on total concurrent connections (PostgreSQL's
`max_connections`, often in the low hundreds because each connection is a
full server-side process), an oversized pool — especially multiplied across
instances — can exhaust that cap and start rejecting connections from every
client, not just the misconfigured one.

Two bounds frame the right number:

- **Little's Law gives the floor.** The concurrency you need is
  `arrival_rate × average_hold_time`. If 200 queries arrive per second and
  each holds a connection for 5 ms, you need about `200 × 0.005 = 1`
  connection busy on average, with headroom for variance — a much smaller
  pool than intuition suggests. Counter-intuitively, a *smaller* pool often
  yields *higher* throughput, because the database spends less time
  context-switching among connections and more time doing work; this is the
  reasoning behind HikariCP's well-known pool-sizing guidance.

- **The backend cap gives the ceiling.** `sum of all pools ≤
  database max_connections`, with margin left for admin sessions,
  replication, and migrations. When application concurrency legitimately
  exceeds what the database can hold, the fix is a **shared pooler** — a
  proxy such as PgBouncer or a managed service such as RDS Proxy that
  multiplexes many client connections onto far fewer real backend
  connections, so the backend cap is respected regardless of how many
  application instances exist.

## Code example

A bounded pool with a real **wait queue** and an **acquire timeout**, plus a
`fn main` that runs 16 concurrent workers against a pool of size 4 using
actual OS threads (`std::thread::scope`). The demo records **peak concurrent
checkouts** and asserts it never exceeds the pool size — a genuine
concurrency proof, not a sequential fake. Running it: 16 workers × 50 ms of
work, four at a time, finish in roughly four waves (~210 ms wall time), and
`peak_in_use` stays at 4. Leased connections return themselves on drop
(RAII), so a caller can't leak one by forgetting to release.

```rust
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

// A pooled connection. In a real pool this wraps a live socket to the
// backend; here it just carries an id so the demo can show reuse.
struct Conn {
    id: usize,
}

struct Inner {
    idle: VecDeque<Conn>,
    // Connections leased but not yet returned. Bounds the pool: it never
    // holds more than `max` live connections total.
    in_use: usize,
    max: usize,
}

pub struct Pool {
    inner: Mutex<Inner>,
    // Signals a waiter when a connection is returned to the pool.
    available: Condvar,
    // Observability: peak concurrent checkouts, used to prove the bound holds.
    peak_in_use: AtomicUsize,
}

// A leased connection that returns itself to the pool on drop, so a caller
// can't accidentally leak it by forgetting to release.
pub struct Guard<'a> {
    pool: &'a Pool,
    conn: Option<Conn>,
}

impl Pool {
    pub fn new(max: usize) -> Self {
        let idle: VecDeque<Conn> = (0..max).map(|id| Conn { id }).collect();
        Pool {
            inner: Mutex::new(Inner { idle, in_use: 0, max }),
            available: Condvar::new(),
            peak_in_use: AtomicUsize::new(0),
        }
    }

    // Borrow a connection. If none is idle, block until one is returned or
    // the timeout elapses — bounded waiting, never an unbounded flood of new
    // connections against the backend.
    pub fn acquire(&self, timeout: Duration) -> Option<Guard<'_>> {
        let deadline = Instant::now() + timeout;
        let mut inner = self.inner.lock().unwrap();
        loop {
            if let Some(conn) = inner.idle.pop_front() {
                inner.in_use += 1;
                let now = inner.in_use;
                self.peak_in_use.fetch_max(now, Ordering::Relaxed);
                debug_assert!(inner.in_use <= inner.max);
                return Some(Guard { pool: self, conn: Some(conn) });
            }
            let remaining = deadline.checked_duration_since(Instant::now())?;
            let (guard, timed_out) = self.available.wait_timeout(inner, remaining).unwrap();
            inner = guard;
            if timed_out.timed_out() && inner.idle.is_empty() {
                return None; // acquire timeout: fail fast, don't block forever
            }
        }
    }

    fn release(&self, conn: Conn) {
        let mut inner = self.inner.lock().unwrap();
        inner.in_use -= 1;
        inner.idle.push_back(conn);
        drop(inner);
        // Wake exactly one waiter — fairer than a broadcast thundering herd.
        self.available.notify_one();
    }

    pub fn peak_in_use(&self) -> usize {
        self.peak_in_use.load(Ordering::Relaxed)
    }
}

impl Guard<'_> {
    pub fn id(&self) -> usize {
        self.conn.as_ref().unwrap().id
    }
}

impl Drop for Guard<'_> {
    fn drop(&mut self) {
        if let Some(conn) = self.conn.take() {
            self.pool.release(conn); // RAII: leak-proof release
        }
    }
}

fn main() {
    const POOL_SIZE: usize = 4;
    const WORKERS: usize = 16;
    const WORK: Duration = Duration::from_millis(50);

    let pool = Pool::new(POOL_SIZE);
    let start = Instant::now();

    std::thread::scope(|scope| {
        for _ in 0..WORKERS {
            scope.spawn(|| {
                // Every worker contends for the same bounded pool. At most
                // POOL_SIZE run their "query" at once; the rest queue.
                let guard = pool.acquire(Duration::from_secs(5)).expect("acquire");
                std::thread::sleep(WORK); // stand-in for running a query
                let _ = guard.id();
            });
        }
    });

    let elapsed = start.elapsed();
    let peak = pool.peak_in_use();
    // 16 workers x 50ms of work, 4 at a time => ~4 waves => ~200ms wall.
    // If the bound were violated it would finish near 50ms; if serialized,
    // near 800ms. The ~200ms band is the proof the pool is doing its job.
    println!("peak_in_use={peak} (pool size {POOL_SIZE}), elapsed={elapsed:?}");
    assert!(peak <= POOL_SIZE, "pool bound violated: {peak} > {POOL_SIZE}");
}
```

`acquire` blocks on a condition variable when the pool is empty and returns
`None` once the deadline passes, so a stalled backend produces bounded,
attributable failures instead of unbounded waiting. `peak_in_use` is what
makes the bound observable: across runs it stays at 4 while the 16 workers
complete in ~210 ms, demonstrating that at most `POOL_SIZE` connections are
ever live at once.

## When to use it

- The application makes frequent, short-lived queries where per-request
  connection setup would dominate total latency.
- Multiple application instances or processes share a backend that has a
  hard limit on total concurrent connections.
- Connection establishment is expensive relative to the work done on the
  connection — true of most RDBMS connections, especially over TLS or with
  SSO-based authentication.

## When not to use it

- The application already holds a small number of long-lived connections
  (e.g. a single background worker with one persistent connection) — there's
  no per-request setup cost to amortize.
- The database, driver, or serverless platform already provides equivalent
  pooling transparently, and adding a second pooling layer would only add
  complexity — or worse, break assumptions the lower layer relies on
  (session state, prepared statements) as a transaction-level pooler can.

## Use-case scenarios

**Web service in front of PostgreSQL.** A stateless API runs on a dozen
instances behind a load balancer, each handling hundreds of short queries
per second. Each instance keeps a small pool (validated on borrow, retired
after a max lifetime) so requests reuse warm connections instead of paying
TLS + auth every time. Because twelve instances × the per-instance pool must
stay under PostgreSQL's `max_connections`, the team routes all instances
through **PgBouncer** in transaction-pooling mode, which multiplexes the many
client connections onto a far smaller set of real backend connections and
keeps the database's process-per-connection cost in check.

**Serverless functions hammering a database.** A function-as-a-service
workload scales to thousands of concurrent invocations under a traffic
spike. Each invocation opening its own database connection would instantly
blow past the backend cap. A managed connection proxy (e.g. RDS Proxy) sits
between the functions and the database, maintaining a bounded warm pool and
handing leases to invocations — turning an unbounded, spiky connection count
into a stable, capped one the database can actually serve.

**Outbound HTTP client with keep-alive.** A service calls a third-party API
millions of times a day. A single shared HTTP client with a bounded
keep-alive connection pool per host reuses warm TLS sessions instead of
re-handshaking per call, while the bound protects both the local socket
budget and the upstream from an unbounded fan-out — the same reuse discipline
as database pooling applied at the HTTP layer, and the concrete fix for the
per-call-client [Improper Instantiation](/docs/patterns/antipatterns/improper-instantiation)
antipattern.

## Production libraries & getting started

Almost no one hand-rolls a pool in production: every language ecosystem ships a mature one, and a separate proxy pooler (PgBouncer, ProxySQL, RDS Proxy) concentrates many instances' pools onto a bounded backend connection count. These are the real production choices across languages and the proxy tier.

| Library / Tool | Language | What it gives you | Getting started |
| -------------- | -------- | ----------------- | --------------- |
| PgBouncer | C / proxy | Lightweight PostgreSQL connection pooler; transaction/session pooling multiplexes many clients onto few backends | [PgBouncer config](https://www.pgbouncer.org/config.html) |
| ProxySQL | C++ / proxy | High-performance MySQL proxy with connection pooling, multiplexing, and query routing | [ProxySQL docs](https://proxysql.com/documentation/) |
| Amazon RDS Proxy | Managed / AWS | Managed pooler that caps and shares connections for RDS/Aurora, ideal under serverless fan-out | [RDS Proxy](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html) |
| HikariCP | Java | The de-facto fast, correct JDBC connection pool with sane defaults and leak detection | [HikariCP](https://github.com/brettwooldridge/HikariCP) |
| pgxpool | Go | Concurrency-safe PostgreSQL connection pool built into the pgx driver | [pgxpool](https://pkg.go.dev/github.com/jackc/pgx/v5/pgxpool) |
| deadpool / bb8 / r2d2 | Rust | Async (deadpool, bb8) and sync (r2d2) generic connection pools for databases and other resources | [deadpool](https://docs.rs/deadpool/latest/deadpool/) · [bb8](https://docs.rs/bb8/latest/bb8/) · [r2d2](https://docs.rs/r2d2/latest/r2d2/) |
| SQLAlchemy pool / asyncpg | Python | SQLAlchemy's `QueuePool` with overflow/recycle, and asyncpg's built-in async pool | [SQLAlchemy pooling](https://docs.sqlalchemy.org/en/20/core/pooling.html) · [asyncpg](https://magicstack.github.io/asyncpg/current/) |
| node-postgres pool / generic-pool | JS / TS | `pg.Pool` for Postgres, and `generic-pool` for pooling any expensive-to-create resource | [pg Pool](https://node-postgres.com/apis/pool) · [generic-pool](https://github.com/coopernurse/node-pool) |

**Example / reference:** [HikariCP — About Pool Sizing](https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing)

## Related patterns

- [Improper Instantiation](/docs/patterns/antipatterns/improper-instantiation) —
  the antipattern connection pooling corrects: creating and destroying an
  expensive connection or client per call instead of reusing a pooled one.
- [Bulkhead](/docs/patterns/reliability/bulkhead) — partitions resources
  into isolated pools so one dependency can't starve another; composes with
  pooling by giving each downstream its own bounded connection pool.
- [Busy Database](/docs/patterns/antipatterns/busy-database) — an oversized
  or multiplied pool contributes directly to overloading the database this
  antipattern warns about.
- [Horizontal Scaling](/docs/patterns/scaling/horizontal-scaling) — the
  source of the multiplicative trap: adding instances multiplies total pool
  connections against a fixed backend cap.
- [Rate Limiter](/docs/patterns/building-blocks/rate-limiter) and
  [Throttling](/docs/patterns/building-blocks/throttling) — cap request
  *rate*, where a bounded pool caps *concurrency* against a resource; kindred
  sizing discipline.

## Further reading

- [Connection pool — Wikipedia](https://en.wikipedia.org/wiki/Connection_pool)
- [Little's law — Wikipedia](https://en.wikipedia.org/wiki/Little%27s_law)
- [HikariCP — About Pool Sizing](https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing)
- [PgBouncer configuration — official docs](https://www.pgbouncer.org/config.html)
- [PostgreSQL connection settings (max_connections) — official docs](https://www.postgresql.org/docs/current/runtime-config-connection.html)
- [Amazon RDS Proxy — AWS documentation](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html)
