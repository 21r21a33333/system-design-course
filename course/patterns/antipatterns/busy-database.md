---
title: "Busy Database"
sidebar_position: 1
supplementary: true
---

The busy database antipattern is what happens when a database is asked
to do more than store, index, and retrieve data — it ends up running
business logic, orchestrating multi-step workflows, or performing heavy
computation that would be cheaper and easier to scale on the
application tier. The database becomes a bottleneck not because it's
storing too much data, but because it's doing too much work per query.

![Busy Database diagram](/img/patterns/busy-database.svg)

## How it manifests

The clearest symptom is stored procedures and triggers that have grown
well past "enforce a constraint" or "keep a derived column in sync"
into full workflow engines: a single stored procedure that validates an
order, checks inventory across several tables, applies a pricing rules
engine, writes an audit trail, and queues a notification, all inside one
transaction. Query plans for the "hot" endpoints show CPU-bound
execution — heavy `CASE` logic, string manipulation, recursive CTEs,
or scalar functions invoked per row — rather than simple index seeks.
Database CPU utilization tracks application request volume almost
one-to-one, and it's consistently the first resource to redline during
a traffic spike, well before disk I/O or network saturate.

Another common shape is business rules encoded as check constraints,
triggers, or views layered on views, where a single logical "get order
summary" read fans out into a cascade of trigger-fired side effects and
nested view materializations that the query planner struggles to
optimize. Because none of this logic is visible in application code, it
doesn't show up in code review, isn't covered by the application's unit
tests, and often isn't even known to the current team — someone finds
out a trigger exists by reading a slow query plan, not by reading the
schema. PostgreSQL and SQL Server both let a table dispatch arbitrary
procedural logic on every insert or update through triggers and
stored procedures — a genuinely useful capability for the narrow,
data-integrity cases described below, but the same capability makes it
just as easy to grow a trigger chain into an undocumented workflow
engine that only the database itself fully understands.

Scaling responses make the antipattern worse before anyone notices it's
the actual problem: the database gets a bigger instance, more read
replicas are added, connection pool limits are raised — all of which
buy time without addressing that the CPU cost per request is
fundamentally higher than it needs to be, because logic that should
scale horizontally with the application tier is instead scaling
vertically with a single database server (or a small number of
replicas, which only help reads, not the write-side computation). Cost
also compounds: a database instance sized to run business logic is
priced very differently from one sized to serve indexed reads and
writes, and it's a cost that shows up as one line item, making it
easy to underestimate relative to the many application servers it's
substituting for.

A related but distinct symptom is heavy computation embedded directly
in SQL — running aggregations, geospatial calculations, or JSON
transformations across large row sets inside the query itself,
because "the database is already touching every row anyway." This
computation competes for the same CPU and memory the database needs for
core query execution, connection handling, and lock management, so it
degrades performance for every other query running concurrently, not
just the one doing the heavy lifting.

## Why it happens

Putting logic in the database is rarely a mistake made all at once —
it accretes. A trigger that keeps one derived value in sync is a
reasonable, contained decision on its own; the tenth trigger added over
two years, each one reasonable in isolation, collectively becomes a
workflow engine nobody designed on purpose. Stored procedures are also
genuinely attractive for specific, narrow reasons: they run close to
the data, avoiding a round trip for logic that touches many rows; they
can be a way to enforce an invariant that must never be bypassed
regardless of which application (or which future application) writes to
the table; and for a team more fluent in SQL than in the application's
language, writing one more `CASE` clause in a procedure feels faster
than opening a pull request in an unfamiliar codebase.

It's also invisible in isolation. Each individual piece of logic pushed
into the database is small and looks like the pragmatic choice at the
time — the alternative (adding an application-tier service, deploying
it, versioning it) is a much bigger, more visible unit of work than
adding one more `WHEN` clause to an existing procedure. The cost of that
accumulated logic doesn't show up in a code review or a design doc; it
shows up months later as a CPU graph, at which point the logic is
tangled enough that pulling it back out feels riskier than leaving it.

## Code example (the antipattern)

```rust
// Application code that shells out almost all decision-making to the
// database via a single "do everything" stored procedure call. The
// procedure itself (not shown, since it lives in SQL) does inventory
// checks, pricing computation, and audit logging inside one
// transaction — CPU-bound business logic running on the DB server.
struct OrderRequest {
    customer_id: u64,
    sku: String,
    quantity: u32,
}

struct Database;

impl Database {
    // Stand-in for a call to `CALL process_order(...)`, a stored
    // procedure that computes pricing tiers, checks and decrements
    // inventory, and writes an audit row — all business logic that
    // has nothing to do with storage or retrieval.
    fn call_process_order_procedure(&self, _req: &OrderRequest) -> Result<f64, String> {
        Ok(42.0) // pretend total price returned by the procedure
    }
}

fn place_order(db: &Database, req: OrderRequest) -> Result<f64, String> {
    // The application tier is just a thin relay; every decision about
    // pricing, inventory, and validity happens inside the database.
    db.call_process_order_procedure(&req)
}
```

## The fix

```rust
// Business logic moved to the application tier. The database is asked
// only to read and write rows — pricing, inventory rules, and audit
// construction all run as ordinary application code that scales
// horizontally across app servers instead of vertically on one DB.
struct OrderRequest {
    customer_id: u64,
    sku: String,
    quantity: u32,
}

struct InventoryRepo;
impl InventoryRepo {
    fn get_stock(&self, _sku: &str) -> u32 {
        100
    }
    fn decrement_stock(&self, _sku: &str, _qty: u32) {}
}

struct PricingEngine;
impl PricingEngine {
    // Pure application-tier computation — no round trip to the
    // database required to evaluate a pricing rule.
    fn price_for(&self, sku: &str, quantity: u32) -> f64 {
        let unit_price = if sku.starts_with("BULK") { 8.0 } else { 12.0 };
        unit_price * quantity as f64
    }
}

fn place_order(
    inventory: &InventoryRepo,
    pricing: &PricingEngine,
    req: OrderRequest,
) -> Result<f64, String> {
    let available = inventory.get_stock(&req.sku);
    if available < req.quantity {
        return Err("insufficient stock".to_string());
    }
    let total = pricing.price_for(&req.sku, req.quantity);
    inventory.decrement_stock(&req.sku, req.quantity);
    // The database is now used for exactly two simple operations —
    // a read and a write — with all decision logic living, testable
    // and horizontally scalable, in the application layer.
    Ok(total)
}
```

The fix isn't "never use a stored procedure" — it's drawing the line at
data-integrity invariants (constraints, simple derived-column triggers)
versus actual business workflow, and keeping the latter in application
code where it can scale independently of the database, be unit tested
without a database connection, and be reviewed alongside the rest of
the feature it belongs to.

## How to detect it

Database CPU utilization that scales linearly (or worse) with request
volume, and redlines well before disk I/O, memory, or network do, is
the headline signal. A query-plan review that shows execution time
dominated by CPU-bound operations — scalar function calls per row,
nested loops over triggers, recursive CTEs — rather than index seeks or
simple joins points at the same thing. Database-side profiling tools
(query store, `pg_stat_statements`, slow-query logs) that surface stored
procedures or trigger chains among the top time consumers, rather than
raw table scans, is a direct signal that logic has migrated into the
data tier. Organizationally, a symptom worth taking seriously: if
understanding "what happens when an order is placed" requires reading
SQL DDL alongside application code, business logic has already leaked
into the database.

## When it's actually fine

Simple, narrowly scoped triggers and constraints that enforce data
integrity — a check constraint on a valid value range, a trigger that
maintains a `last_updated` timestamp, a foreign key that prevents
orphaned rows — are exactly what a database should do and aren't this
antipattern; the line is crossed when logic starts branching on
business rules rather than protecting data shape. Some computation is
also genuinely cheaper to run where the data already is: a single
aggregate query (`SUM`, `COUNT`) over a large table is far more
efficient evaluated by the database engine than by pulling every row
into the application tier and summing there — that's the database
doing what it's good at, not business logic. And for a small,
low-traffic internal tool where the database is never going to be the
bottleneck regardless of what runs on it, the operational simplicity of
one stored procedure over a separate deployed service can be the right
tradeoff.

## Libraries & tools that prevent this

These tools help move work off the database engine — offloading connection handling and read scaling to a proxy, shifting logic to the application tier, and surfacing which queries or procedures are actually CPU-bound so they can be pulled out.

| Library / Tool | Language | How it helps | Getting started |
| --- | --- | --- | --- |
| PgBouncer | PostgreSQL / any | Lightweight connection pooler that lets the app tier hold many cheap connections without each one consuming a heavy Postgres backend, so scaling logic outward doesn't overwhelm the DB. | [pgbouncer.org](https://www.pgbouncer.org/) |
| ProxySQL | MySQL / any | High-performance proxy for read/write splitting and query routing, letting reads fan out to replicas so the primary isn't the single CPU doing everything. | [proxysql.com docs](https://www.proxysql.com/documentation/) |
| pg_stat_statements | PostgreSQL | Aggregates execution stats per normalized query so you can see exactly which statements (including procedure-heavy ones) dominate CPU time and belong in the app tier. | [postgresql.org docs](https://www.postgresql.org/docs/current/pgstatstatements.html) |
| EXPLAIN | PostgreSQL | Shows the query plan so CPU-bound per-row functions, recursive CTEs, and trigger cascades are visible rather than hidden behind a slow endpoint. | [postgresql.org docs](https://www.postgresql.org/docs/current/sql-explain.html) |
| SQLAlchemy | Python | Application-tier ORM that keeps business logic in versioned, unit-testable Python instead of accreting stored procedures and triggers in the schema. | [sqlalchemy.org docs](https://docs.sqlalchemy.org/en/20/) |
| Prisma | JS / TS | Type-safe data-access layer that encourages expressing logic in the app instead of pushing it into database-side procedures. | [prisma.io docs](https://www.prisma.io/docs) |
| Debezium | JVM / any | Change-data-capture that streams row-level changes out to the app tier, replacing trigger-driven side effects (audit, notify, cascade) that would otherwise run inside the database. | [debezium.io docs](https://debezium.io/documentation/) |

**Example / reference:** [Busy Database antipattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/antipatterns/busy-database/)

## Related patterns

- [CQRS](/docs/patterns/storage/cqrs) — separates the write model from
  the read model so that read-shaping logic (the kind that tempts teams
  into complex views or stored procedures) lives in an application-tier
  read model built for that purpose, instead of being pushed onto the
  database at query time.
- [Materialized View](/docs/patterns/storage/materialized-view) —
  precomputes expensive derived data on a schedule or on write, rather
  than running the equivalent computation inline inside a busy stored
  procedure on every read.

## Further reading

- [Busy Database antipattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/antipatterns/busy-database/)
- [Stored procedure — Wikipedia](https://en.wikipedia.org/wiki/Stored_procedure)
- [System Design roadmap — roadmap.sh](https://roadmap.sh/system-design) — includes Busy Database as a named antipattern topic.
- [CQRS — Martin Fowler](https://martinfowler.com/bliki/CQRS.html)
