---
title: "Materialized View"
sidebar_position: 7
supplementary: true
---

A materialized view precomputes and stores the result of a query — a
join, an aggregation, or a reshaping across one or more source tables —
as its own physical table, so reads hit the precomputed result directly
instead of recomputing the expensive query on every request.

![Materialized View diagram](/img/patterns/materialized-view.svg)

## Problem it solves

Data is usually stored in whatever shape is best for writes: normalized,
split across many tables, organized around how entities are created and
updated rather than how they're read. That shape is frequently a poor
fit for the queries an application actually needs to serve — "total
sales by product this month" or "this customer's order history with
product names and current stock" requires joining several tables and
aggregating across many rows, every single time the query runs. Running
that join-and-aggregate from scratch on every read is expensive, and the
cost is paid repeatedly for a result that, in many cases, didn't need to
change since the last time someone asked. A materialized view breaks
that cycle by computing the expensive query once and storing its output
as a plain table, so subsequent reads are a simple lookup against
already-computed data instead of a repeated recomputation.

## How it works

A materialized view is defined by a query — typically a join and/or
aggregation across one or more source tables — and its result is written
out to a new physical table rather than recomputed live. The view is
never written to directly by the application; it's derived data, and it
can always be regenerated from the source tables from scratch, which
makes it disposable in a way the source data isn't. What makes a
materialized view useful is precisely what also makes it a tradeoff: the
view is a snapshot, and the moment a source row changes, the view no
longer reflects current reality until something refreshes it. That
refresh has to happen somehow, and the two broad strategies trade
freshness against cost differently. A **scheduled refresh** reruns the
defining query on a timer (hourly, nightly) — simple to implement,
but the view can be stale by up to the full refresh interval, which is
fine for a dashboard and unacceptable for an inventory count.
An **incremental refresh** updates the view in response to each write to
a source table — closer to current, but requires the update logic to
know how a single source-row change maps to a change in the
already-aggregated view, which is nontrivial for anything beyond simple
joins. Either way, the view trades some amount of staleness for
avoiding repeated recomputation, and the acceptable staleness window is
the central design decision for any materialized view.

Materialized views pair naturally with [CQRS](/docs/patterns/storage/cqrs):
CQRS's core idea is separating the write model from the read model, and
a materialized view is one of the most common concrete implementations
of that read model. The write side keeps writing to its normalized,
transactional schema; a materialized view, refreshed asynchronously as
writes occur, is what CQRS's read side actually queries — the view *is*
the denormalized read model CQRS calls for, not a separate concept
layered on top of it. Framed that way, CQRS is the architectural
decision to split reads from writes, and a materialized view is one
concrete way to build the store that split creates on the read side.

## Code example

The snippet below models a materialized view as a precomputed table
that's explicitly rebuilt from source tables, rather than joined live on
every read.

```rust
struct Order {
    item_id: u32,
    qty: u32,
}

struct Item {
    id: u32,
    name: String,
}

// The materialized view: precomputed, not recalculated per read.
struct SalesSummaryView {
    rows: Vec<(u32, String, u32)>, // item_id, name, total_qty
}

impl SalesSummaryView {
    // Rebuilds the view from source tables — the expensive join +
    // aggregation, paid once here instead of on every read.
    fn refresh(orders: &[Order], items: &[Item]) -> Self {
        let mut totals: Vec<(u32, String, u32)> = Vec::new();
        for item in items {
            let total: u32 = orders
                .iter()
                .filter(|o| o.item_id == item.id)
                .map(|o| o.qty)
                .sum();
            if total > 0 {
                totals.push((item.id, item.name.clone(), total));
            }
        }
        SalesSummaryView { rows: totals }
    }

    // A read against the view: no join, no aggregation, just a lookup.
    fn total_for(&self, item_id: u32) -> Option<u32> {
        self.rows.iter().find(|(id, _, _)| *id == item_id).map(|(_, _, t)| t).copied()
    }
}
```

`refresh` is where the join-and-aggregate cost is paid; `total_for` is
the cheap read every caller actually performs, and it stays cheap no
matter how many times it's called between refreshes.

## When to use it

- A query requires an expensive join or aggregation across multiple
  tables that's run frequently relative to how often the underlying data
  changes.
- The application (often via CQRS) already separates its read and write
  paths, and the view is a natural fit for the read model.
- Some staleness — seconds, minutes, or longer, depending on refresh
  strategy — is acceptable for the use case, such as dashboards, reports,
  or search/browse pages.

## When not to use it

- The query is already cheap, or run rarely enough that precomputing it
  saves little — the view adds a refresh mechanism and storage cost for
  marginal benefit.
- The use case requires the absolute latest data on every read with zero
  tolerance for staleness, such as a live inventory count used to accept
  or reject a purchase.
- The source data changes so frequently that keeping the view current
  costs more (in refresh compute or write-side complexity) than simply
  running the query live would have.

## Real-world example

An e-commerce reporting dashboard that shows "total sales value by
product category this week" doesn't join the orders, order-line-items,
and product tables live every time someone opens the dashboard — that
join over the full order history would be far too slow to run on demand.
Instead, a materialized view holding the precomputed per-product totals
is refreshed on a schedule (say, hourly), and the dashboard simply reads
the already-aggregated rows from that view.

## Related patterns

- [CQRS](/docs/patterns/storage/cqrs) — the broader pattern of splitting
  read and write models; a materialized view is a common concrete
  implementation of the read side that split creates.
- [Semantic Caching](/docs/patterns/ai-infra/semantic-caching) — a
  different flavor of the same precomputation-to-avoid-recompute
  tradeoff, caching LLM responses by meaning instead of precomputing a
  query's result as a table.

## Further reading

- [Materialized View pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/materialized-view)
- [Materialized view — Wikipedia](https://en.wikipedia.org/wiki/Materialized_view)
