---
title: "Extraneous Fetching"
sidebar_position: 4
supplementary: true
---

Extraneous fetching is retrieving more data than a request actually
needs — pulling every column when only two are displayed, loading an
entire object graph when one field of it is used, fetching a whole
collection to compute a count. It's the mirror image of chatty I/O:
instead of too many small requests, it's requests that are individually
too large for what they're used for.

![Extraneous Fetching diagram](/img/patterns/extraneous-fetching.svg)

## How it manifests

The canonical example is `SELECT *` (or an ORM's default "load the full
entity" behavior) used in a code path that only ever reads two or three
fields from the result — every other column still has to be read off
disk, deserialized, transferred over the network, and allocated in
memory, for data the caller immediately discards. This is easy to miss
because it's functionally correct: the code works, the right two fields
are in there somewhere, and nothing about the output is wrong, only the
cost of producing it. The tell is usually in the query's actual
execution and transfer size relative to its logical output — a query
that scans and returns megabytes of row data to ultimately render a
short summary line.

It also shows up as full object graphs loaded through ORM relationships
when only a leaf property is needed: fetching a `User` entity, which
eagerly loads that user's `Orders`, each of which eagerly loads its
`LineItems`, to display nothing more than the user's name on a
dashboard. The ORM did exactly what it was configured to do, but the
configuration (eager-loading depth, default fetch strategy) wasn't
matched to what any particular call site actually needs, so every call
site pays the cost of the most demanding one. A related shape is
fetching an entire collection into memory to compute something that
could have been computed by the data store itself — pulling every row
of a table into the application to count how many match a condition,
or to find a maximum value, instead of asking the database to compute
that aggregate and return one number.

Paginated or list-view endpoints are a frequent hotspot: a "recent
activity" feed that needs only an id, a timestamp, and a title per row
instead fetches the full record for every row, including large fields
(a full description, an embedded blob reference, nested associations)
never rendered in that view. Response payload size for such an endpoint
often reveals the gap directly — a feed endpoint returning 500KB of
JSON to render 20 rows of three-field summaries is extraneous fetching
made visible.

## Why it happens

Fetching the full entity is almost always the path of least resistance:
an ORM's default `find` or `get` method returns the whole row or the
whole object graph, and writing a query or projection that returns only
the two fields a view needs requires deliberately opting out of that
default — extra code, a separate DTO or projection type, sometimes a
hand-written query. Reusing one general-purpose "get user" function
across many call sites is also a very natural way to keep code DRY;
it just quietly assumes every caller needs the same shape of data,
which stops being true as the application grows more views with more
different, narrower needs.

Requirements also change underneath data-access code that was written
correctly for its original purpose: a detail page that legitimately
needed the full object graph gets a lightweight summary view added
later that reuses the same data-fetching function because it already
exists and already works, rather than writing a new, narrower query for
the new, narrower need. And in development, with small datasets and
low latency to the local database, extraneous fetching is essentially
free — the cost only becomes visible at production data volumes and
concurrent load, which is exactly the same "invisible until scale"
pattern that makes chatty I/O hard to catch early too.

## Code example (the antipattern)

```rust
// A full row type with every column the table has, fetched in full
// even though the call site below only ever reads two fields from it.
struct UserRow {
    id: u64,
    name: String,
    email: String,
    bio: String,
    address: String,
    preferences_json: String,
    last_login_history: Vec<String>,
}

trait Db {
    // Always returns the full row — every column, every time,
    // regardless of what the caller actually needs.
    fn get_user(&self, id: u64) -> UserRow;
}

// Only `id` and `name` are used, but the full row — including a
// history vector and a large JSON blob — was fetched to get them.
fn render_dashboard_greeting(db: &dyn Db, user_id: u64) -> String {
    let user = db.get_user(user_id);
    format!("Welcome back, {} (#{})", user.name, user.id)
}
```

## The fix

```rust
// A narrow projection carrying only the fields this call site needs —
// the query behind `get_user_summary` selects just these two columns
// instead of the whole row.
struct UserSummary {
    id: u64,
    name: String,
}

trait Db {
    // A separate, narrower fetch method for call sites that only need
    // a summary — the underlying query is `SELECT id, name FROM users
    // WHERE id = ?`, not `SELECT *`.
    fn get_user_summary(&self, id: u64) -> UserSummary;
}

fn render_dashboard_greeting(db: &dyn Db, user_id: u64) -> String {
    let user = db.get_user_summary(user_id);
    format!("Welcome back, {} (#{})", user.name, user.id)
}
```

The fix isn't a cleverer query optimizer — it's a second, narrower
data-access method whose selected columns match what this specific call
site consumes, alongside the original full-row method for call sites
(a profile edit page, say) that genuinely need every field. The
underlying principle is matching fetch shape to use, not eliminating
the full-row fetch everywhere.

## How to detect it

Comparing a query's or endpoint's response payload size against how
much of that payload actually renders or gets used in the caller is the
most direct check — a large gap between bytes transferred and bytes
displayed is the signature. Query-level profiling that shows wide
`SELECT *` queries (or ORM-generated queries selecting every mapped
column) on hot, high-frequency code paths is a strong structural
signal, especially against tables with large text, JSON, or blob
columns that inflate row size disproportionately. APM traces showing
database calls with unusually large result-set sizes or high
deserialization time relative to the rest of the request are worth
inspecting for whether all of that data is actually consumed downstream
in the same trace. At the object-graph level, ORM eager-loading logs
(most ORMs can log what gets loaded per request) that show relationships
several levels deep being materialized for a view that only renders a
top-level field are a direct sign the fetch strategy doesn't match the
call site's actual need.

## When it's actually fine

A single general-purpose fetch method that returns the full entity is
completely reasonable when most call sites for that entity genuinely do
need most of its fields — introducing a narrow projection for every
possible subset of fields is its own kind of overengineering if the
usage pattern doesn't actually justify it. It's also fine on low-volume,
low-frequency code paths — an admin tool hit a handful of times a day
fetching a slightly-too-wide row costs nothing measurable, and the
narrower query isn't worth the added code surface. And where a data
store or cache genuinely returns whole objects as its only interface
(no server-side projection support at all), the fix has to happen
elsewhere — trimming and shaping the object after retrieval, or caching
a pre-shaped version — rather than at the fetch call itself.

## Libraries & tools that prevent this

These tools let a call site request exactly the columns and rows it needs — column projection instead of full-entity loads, keyset pagination instead of unbounded scans, and query inspection to confirm the fetch shape matches the use.

| Library / Tool | Language | How it helps | Getting started |
| --- | --- | --- | --- |
| GraphQL | Spec / all | Clients request only the fields they render, so the server can resolve a narrow projection instead of returning whole objects. | [graphql.org — queries](https://graphql.org/learn/queries/) |
| Prisma (`select`) | JS / TS | `select` returns only the named columns rather than the full row, matching fetch width to what the caller uses. | [prisma.io docs](https://www.prisma.io/docs/orm/prisma-client/queries/select-fields) |
| SQLAlchemy (`load_only` / column loading) | Python | Loads only specified columns of an entity, avoiding a `SELECT *` when a view needs two fields. | [sqlalchemy.org docs](https://docs.sqlalchemy.org/en/20/orm/queryguide/columns.html) |
| Django ORM (`only` / `values`) | Python | `only()`/`values()` restrict a queryset to chosen fields instead of hydrating every column. | [docs.djangoproject.com](https://docs.djangoproject.com/en/stable/ref/models/querysets/#only) |
| EXPLAIN | PostgreSQL | Reveals how wide a query scans and returns, exposing extraneous columns and full-collection reads on hot paths. | [postgresql.org docs](https://www.postgresql.org/docs/current/sql-explain.html) |
| Keyset pagination (No Offset) | SQL / all | Fetches a bounded page by seeking on an indexed key instead of pulling and discarding large offset ranges. | [use-the-index-luke.com](https://use-the-index-luke.com/no-offset) |

**Example / reference:** [Extraneous Fetching antipattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/antipatterns/extraneous-fetching/)

## Related patterns

- [Materialized View](/docs/patterns/storage/materialized-view) —
  precomputes and stores exactly the shape a read needs, so the fetch
  itself returns only the relevant fields instead of a full object
  graph that then has to be trimmed by the caller.
- [CQRS](/docs/patterns/storage/cqrs) — separates read models from the
  write model, letting each read path be shaped to exactly what its
  callers need rather than reusing one general-purpose entity fetch
  everywhere.

## Further reading

- [Extraneous Fetching antipattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/antipatterns/extraneous-fetching/)
- [Database normalization — Wikipedia](https://en.wikipedia.org/wiki/Database_normalization)
- [EXPLAIN — PostgreSQL documentation](https://www.postgresql.org/docs/current/sql-explain.html)
