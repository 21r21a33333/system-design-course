---
title: "Chatty I/O"
sidebar_position: 3
supplementary: true
---

Chatty I/O is a pattern of making many small, separate network or disk
requests to accomplish something that a single batched request could do
in one round trip. Each individual call may be fast, but the fixed
per-call overhead — latency, connection setup, serialization — is paid
once per call rather than once total, and that overhead dominates the
total time once the call count gets large.

![Chatty I/O diagram](/img/patterns/chatty-io.svg)

## How it manifests

The textbook version is the N+1 query problem: a list of parent records
is fetched with one query, and then, for every single item in that
list, a follow-up query fetches its related data — one query for the
order list, then one more query per order to fetch that order's line
items. A page showing 50 orders makes 51 database round trips instead
of 2. Each query individually looks fast in isolation (a few
milliseconds), which is exactly why it survives code review — the
problem only becomes visible at realistic list sizes and under
concurrent load, when 51 round trips multiplied across many simultaneous
requests saturates the connection pool and the database's ability to
context-switch between them.

The same shape shows up over the network between services: a
front-end or orchestrating service calling a downstream API once per
item in a collection — fetching a user's profile, then making a
separate call per friend to fetch each friend's profile — instead of a
single batched call that accepts a list of IDs and returns all the
results together. Each of those calls pays a full network round trip
(often tens of milliseconds even on a fast internal network) on top of
whatever the actual work takes, so total latency scales linearly with
item count in a way that's invisible with 3 items and crippling with
300. It also shows up in file and disk I/O: reading a file byte-by-byte
or line-by-line with an unbuffered reader that issues a separate system
call per read, instead of reading in larger chunks.

The diagnostic signature is consistent across all these forms: request
count scales with the size of a collection rather than staying
constant, and a trace or query log shows a burst of near-identical
calls clustered tightly in time, each fast on its own, with the total
wall-clock time dominated by the sum of per-call overhead rather than
by any single call's actual work. Database query logs are usually the
easiest place to spot it — a repeating query pattern with only the
bound parameter changing, executed dozens or hundreds of times per
logical request, is close to a smoking gun for N+1.

## Why it happens

Chatty I/O is very often the natural result of writing code the way you'd
think about the problem: "for each order, get its line items" reads as
a loop, and a loop over "fetch related data" naturally becomes a loop
over individual fetch calls, especially when using an ORM that makes
lazy-loading a related object look exactly like accessing a local field
— the fact that `order.line_items` triggers a network round trip is
invisible at the call site. Batching, by contrast, requires actively
restructuring the code: collecting all the IDs first, making one call
with the whole list, then re-associating results back with their
parent records — more code, and a less direct mapping from "what I want"
to "how I wrote it."

It's also close to free to introduce and invisible until scale exposes
it: with 3 test records in a local dev database, an N+1 query pattern
adds a few milliseconds nobody notices, and the code looks and reads
correctly — it produces the right answer, just via more round trips
than necessary. The cost only becomes visible when list sizes grow in
production, by which point the pattern is embedded across many call
sites built the same way, since the ORM or client library encourages
the same lazy-access idiom everywhere.

## Code example (the antipattern)

```rust
struct Order {
    id: u64,
}

struct LineItem {
    order_id: u64,
    sku: String,
}

trait Db {
    fn get_orders(&self) -> Vec<Order>;
    // One round trip per call — invoked once per order below.
    fn get_line_items(&self, order_id: u64) -> Vec<LineItem>;
}

// N+1: one query for the order list, then one additional query per
// order inside the loop — total round trips scale with order count.
fn load_orders_with_items(db: &dyn Db) -> Vec<(Order, Vec<LineItem>)> {
    let orders = db.get_orders();
    let mut result = Vec::new();
    for order in orders {
        let items = db.get_line_items(order.id);
        result.push((order, items));
    }
    result
}
```

## The fix

```rust
struct Order {
    id: u64,
}

struct LineItem {
    order_id: u64,
    sku: String,
}

trait Db {
    fn get_orders(&self) -> Vec<Order>;
    // A single batched call that accepts every order id at once and
    // returns all matching line items in one round trip.
    fn get_line_items_for(&self, order_ids: &[u64]) -> Vec<LineItem>;
}

fn load_orders_with_items(db: &dyn Db) -> Vec<(Order, Vec<LineItem>)> {
    let orders = db.get_orders();
    let ids: Vec<u64> = orders.iter().map(|o| o.id).collect();
    let all_items = db.get_line_items_for(&ids);

    // Re-associate the batched results with their parent order
    // in memory — no further round trips needed.
    let mut result = Vec::new();
    for order in orders {
        let items: Vec<LineItem> = all_items
            .iter()
            .filter(|item| item.order_id == order.id)
            .map(|item| LineItem {
                order_id: item.order_id,
                sku: item.sku.clone(),
            })
            .collect();
        result.push((order, items));
    }
    result
}
```

The fix collapses the loop-of-calls into two total round trips — one
for orders, one batched call for every order's line items — regardless
of whether the list has 5 orders or 5,000. The re-association work
(matching line items back to their order) moves from the database or
network into local memory, where it's orders of magnitude cheaper per
item than a round trip.

## How to detect it

A database query log or slow-query log showing the same query shape
repeated many times per request, with only a bound parameter changing,
is the single strongest signal — most ORMs also ship an N+1 detector
(query-count-per-request thresholds) specifically because this is such
a common regression. In a distributed trace, look for a burst of
sibling spans with near-identical names and short, similar durations,
clustered inside one parent request span, where the parent span's total
duration is close to the sum of the children rather than dominated by
one expensive child. At the metrics level, request count to a
downstream dependency scaling proportionally with the size of a
collection in the *upstream* request (twice the items in a list, twice
the downstream calls) is a strong structural signal independent of any
one trace.

## When it's actually fine

Not every loop that makes a call is this antipattern — if each
iteration's request depends on the result of the previous one (a
workflow with genuine sequential dependencies, not just independent
lookups), there's no batching opportunity because the calls can't
actually be parallelized or combined; the "problem" here is inherent to
the task, not a design mistake. For genuinely small, bounded collections
(a fixed set of 2-3 configuration lookups at startup, not a
data-dependent list that grows with user activity) the fixed overhead
of N small calls is trivial in absolute terms and not worth the
added code complexity of batching. And some backing stores or APIs
simply don't offer a batched equivalent of the operation — in that
case, the mitigation is architectural (caching, denormalization, a
different store) rather than a batching call that doesn't exist.

## Libraries & tools that prevent this

These tools collapse a loop of small calls into a single batched round trip — coalescing per-item lookups behind a batching layer, eager-loading related rows in one query, or exposing a batch API that accepts a list of IDs.

| Library / Tool | Language | How it helps | Getting started |
| --- | --- | --- | --- |
| DataLoader | JS / TS | Coalesces many individual load-by-key calls made within a tick into one batched fetch and caches results, the standard cure for GraphQL/API N+1. | [github.com/graphql/dataloader](https://github.com/graphql/dataloader) |
| Dataloader | Elixir | Batches and caches data-source loads (the Absinthe/GraphQL ecosystem's answer to N+1) so related records load in one round trip. | [hexdocs.pm/dataloader](https://hexdocs.pm/dataloader/Dataloader.html) |
| Prisma (relation queries) | JS / TS | `include`/nested reads fetch parent and related records together instead of a lazy load per parent. | [prisma.io docs](https://www.prisma.io/docs/orm/prisma-client/queries/relation-queries) |
| SQLAlchemy (eager loading) | Python | `joinedload`/`selectinload` fetch relationships in one (or a bounded number of) queries rather than one per parent row. | [sqlalchemy.org docs](https://docs.sqlalchemy.org/en/20/orm/queryguide/relationships.html) |
| Django ORM (`select_related` / `prefetch_related`) | Python | Pulls related objects in a single join or a small fixed number of queries, eliminating the per-object lazy fetch. | [docs.djangoproject.com](https://docs.djangoproject.com/en/stable/ref/models/querysets/#prefetch-related) |
| gRPC | Go / Java / Python / C++ / etc. | Supports batch-style RPCs and streaming, so a service can expose one call that accepts a list of IDs instead of forcing a call per item. | [grpc.io docs](https://grpc.io/docs/) |

**Example / reference:** [The N plus one problem — SQLAlchemy glossary](https://docs.sqlalchemy.org/en/20/glossary.html#term-N-plus-one-problem)

## Related patterns

- [Gateway Aggregation](/docs/patterns/api-edge/gateway-aggregation) —
  a gateway that combines several backend calls into a single
  client-facing response, directly addressing the network-hop form of
  chatty I/O between a client and multiple backend services.
- [Materialized View](/docs/patterns/storage/materialized-view) —
  precomputes and stores a joined or aggregated shape ahead of time, so
  a read that would otherwise require chatty follow-up queries per
  parent record becomes a single read against the precomputed result.

## Further reading

- [Chatty I/O antipattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/antipatterns/chatty-io/)
- [Thundering herd problem — Wikipedia](https://en.wikipedia.org/wiki/Thundering_herd_problem)
- [The N plus one problem — SQLAlchemy glossary](https://docs.sqlalchemy.org/en/20/glossary.html#term-N-plus-one-problem)
