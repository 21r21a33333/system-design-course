---
title: "Connection Pooling"
sidebar_position: 4
supplementary: true
---

Connection pooling reuses a fixed set of already-open database
connections across many requests, instead of opening (and tearing down)
a brand-new connection for every request that needs one.

## Problem it solves

Opening a database connection isn't free: it involves a TCP handshake,
often a TLS negotiation, and an authentication round trip with the
database — overhead that's small once but adds up fast if it's paid on
every single query. Under load, opening and closing a connection per
request also churns through the database's own limited connection slots,
and each connection the database holds open costs it memory and
scheduling overhead regardless of whether it's actively running a query.
Connection pooling amortizes the expensive setup cost across many
requests by keeping a set of connections open and handing them out for
reuse.

## How it works

A pool of already-established connections is created and maintained,
either inside the application process (a pool library) or as a separate
proxy process sitting between the application and the database. When a
request needs to run a query, it borrows a connection from the pool,
uses it, and returns it to the pool when done — the connection itself
stays open and is handed to the next caller instead of being closed.
If every connection in the pool is currently in use, new requests
either wait for one to free up or fail fast, depending on configuration.

Pool size is the central tuning knob, and it's a genuine tradeoff in
both directions. Too small a pool means callers queue up waiting for a
connection even though the database has spare capacity, adding latency
under load for no good reason. Too large a pool does the opposite
damage: each open connection consumes memory and resources on the
database side, and because a database server has its own hard cap on
total concurrent connections (often in the low thousands, sometimes
much lower), an oversized pool — especially when multiplied across many
application instances — can exhaust that limit and start rejecting
connections from every client, not just the misconfigured one.

## When to use it

- The application makes frequent, short-lived database queries, where
  per-request connection setup would dominate total latency.
- Multiple application instances or processes need to share a database
  that has a hard limit on total concurrent connections.
- Connection establishment is expensive relative to query execution —
  true of most traditional RDBMS connections, especially over TLS or
  with SSO-based authentication.

## When not to use it

- The application already holds a small number of long-lived
  connections (e.g. a single background worker with one persistent
  connection) — there's no per-request setup cost to amortize.
- The database or driver already provides equivalent pooling
  transparently and adding a second pooling layer on top would only add
  complexity without benefit.

## Real-world example

PgBouncer is a lightweight connection pooler commonly placed in front of
PostgreSQL: applications connect to PgBouncer as if it were the database
itself, and PgBouncer maintains a smaller pool of real connections to
PostgreSQL underneath, multiplexing many client connections onto far
fewer actual database connections. This is especially valuable for
PostgreSQL specifically, since each PostgreSQL connection is a full
server-side process with meaningful memory overhead, making the
database's own connection ceiling reachable well before application
concurrency needs are met.

## Related patterns

- [Database](/docs/concepts/database) — the primer's broader treatment of
  database design, including the connection and throughput limits that
  make pooling necessary.

## Further reading

- [Connection pool — Wikipedia](https://en.wikipedia.org/wiki/Connection_pool)
- [Amazon RDS Proxy — AWS documentation](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html)
