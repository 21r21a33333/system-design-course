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

## Technical architecture & implementation

**Derived, disposable, never written directly.** A materialized view is
defined by a query — typically a join and/or aggregation across one or
more source tables — and its result is written out to a new physical
table rather than recomputed live. The view is never written to directly
by the application; it's derived data, and it can always be regenerated
from the source tables from scratch, which makes it disposable in a way
the source data isn't. That disposability is a real operational
property: a corrupted or schema-changed view can simply be dropped and
rebuilt, and the source of truth is never at risk, because the view
contributes no information the sources don't already hold.

**Refresh strategies — the freshness/cost dial.** What makes a
materialized view useful is precisely what also makes it a tradeoff: the
view is a snapshot, and the moment a source row changes, the view no
longer reflects current reality until something refreshes it. The
strategy chosen sets where the view sits on a freshness-vs-cost dial.
An **on-write (eager) refresh** updates the view synchronously as part
of the source write — the view is never stale, but every write now pays
the view-maintenance cost and the two updates must be coordinated. A
**scheduled refresh** reruns (or re-updates) the view on a timer —
hourly, nightly — which is simple and cheap but leaves the view stale by
up to the full interval, fine for a dashboard and unacceptable for an
inventory count. An **on-demand (lazy) refresh** recomputes only when a
reader asks and the view is judged too old, spending nothing while
nobody reads but making the triggering read pay the full recompute.

**Full vs. incremental refresh.** Orthogonal to *when* is *how much*. A
**full refresh** re-runs the defining query and replaces the entire view
— trivially correct and simple, but its cost scales with the whole
dataset every time, regardless of how little changed. An **incremental
refresh** applies only the delta implied by each source change, so cost
scales with the *change* rather than the data size — dramatically
cheaper at scale, but it requires the update logic to know how a single
source-row change maps into the already-aggregated view (adding a sale
increments one bucket's total; deleting one decrements it), which is
straightforward for sums and counts but genuinely hard for aggregations
like `MEDIAN` or `COUNT DISTINCT` that a delete can't cheaply reverse.
Systems that maintain views incrementally often feed the deltas through
[change data capture](/docs/patterns/batch-streaming/change-data-capture)
from the source's write-ahead log.

**Failure modes.** The hazards are staleness and drift. Any refresh
strategy other than eager leaves a **staleness window** in which the
view answers with data the source has already superseded — usually
acceptable by design, but a correctness bug if a caller mistakes the
view for authoritative. An incremental refresh that mis-derives a delta,
or drops one because a refresh job crashed mid-run, leaves the view
**drifted** — subtly wrong in a way a full recompute would have avoided.
Because the view is always rebuildable from source, the standard
safeguard is a periodic full rebuild (or reconciliation) that resets any
accumulated incremental drift, plus never treating the view as a system
of record for anything.

**Storage cost.** The view is a second physical copy of (a transform of)
the data, so it consumes storage proportional to its result size, and
several views over the same sources multiply that. This is usually a
worthwhile trade — storage is cheap relative to repeated expensive
computation — but it does mean a materialized view is not free the way a
plain query is, and indexing many wide aggregations can quietly become a
significant fraction of a database's footprint.

## Materialized view and CQRS

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

## Materialized view vs. cache vs. index table

A materialized view sits between two neighbours it's easily confused
with, and the distinctions are worth drawing sharply. Against a
[cache](/docs/patterns/building-blocks/distributed-cache): both avoid
recomputing an expensive result, but a cache is **volatile, opportunistic,
and keyed** — it holds whatever was recently asked for, can evict any
entry at any time, and misses fall back to the source; a materialized
view is **durable, exhaustive, and queryable** — it holds the *complete*
precomputed result set as a real table you can run further queries and
joins against, and it doesn't "miss." Reach for a cache when the hot set
is small and access is skewed; reach for a materialized view when reads
need the whole result set queryable and consistently fast, not just the
recently-touched slice. Against an
[index table](/docs/patterns/storage/index-table): an index table stores
*pointers* to source rows to make finding them fast and leaves the rows'
shape untouched, whereas a materialized view stores *computed results*
and reshapes the data entirely — the index tells you where the rows are,
the view has already turned them into the answer.

Several familiar structures are, viewed this way, specialized
materialized views. A [CQRS](/docs/patterns/storage/cqrs) read model is a
materialized view maintained specifically to serve the read side of a
read/write split. A
[distributed search index](/docs/patterns/building-blocks/distributed-search)
is a materialized view whose precomputed form is an inverted index,
built precisely because the source database can't answer full-text and
relevance queries efficiently. In each case the underlying move is
identical: precompute and store a form of the data the source can't serve
cheaply, and accept the staleness and storage that buys.

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

## Use-case scenarios

**Analytics dashboard over the order history.** An e-commerce reporting
dashboard that shows "total sales value by product category this week"
doesn't join the orders, order-line-items, and product tables live every
time someone opens it — that join over the full order history would be
far too slow on demand. A materialized view holding the precomputed
per-category totals is refreshed on a schedule (say, hourly), and the
dashboard simply reads the already-aggregated rows; a few minutes of
staleness on a business report is a non-issue.

**Social feed / leaderboard read model.** A social product needs each
user's home feed and a global leaderboard ranked by score. Recomputing
either from raw events on every page load would be ruinous under fan-out.
An incrementally-refreshed materialized view — updated from the activity
and score streams via change data capture — holds the ranked read model,
so a feed render or leaderboard fetch is a direct scan of precomputed
rows. This is a textbook [CQRS](/docs/patterns/storage/cqrs) read model:
writes append events, the view is the denormalized shape reads consume.

**Denormalized product-detail page.** A product page needs the product,
its current price, aggregate rating, and inventory status — normally a
join across four tables. A materialized view stitches these into one flat
row per product, refreshed incrementally as any contributing source
changes, so rendering the page is a single-row lookup. Where the page
also needs full-text discovery ("wireless headphones under \$100"), that
is served by a
[distributed search index](/docs/patterns/building-blocks/distributed-search) —
itself a specialized materialized view — sitting alongside the flat-row
view.

## Related patterns

- [CQRS](/docs/patterns/storage/cqrs) — the broader pattern of splitting
  read and write models; a materialized view is a common concrete
  implementation of the read side that split creates.
- [Index Table](/docs/patterns/storage/index-table) — the sibling derived
  structure that stores *pointers* to source rows rather than computed
  results; useful for finding rows fast, where a view reshapes them.
- [Distributed Search](/docs/patterns/building-blocks/distributed-search) —
  a search/inverted index is a specialized materialized view precomputing
  a form the source database can't query efficiently.
- [Change Data Capture](/docs/patterns/batch-streaming/change-data-capture) —
  the common mechanism for feeding source deltas into an incrementally
  refreshed view.
- [Distributed Cache](/docs/patterns/building-blocks/distributed-cache) —
  the volatile, keyed cousin of the durable, exhaustive materialized view;
  the two answer different read-acceleration needs.

## Further reading

- [Materialized View pattern — Azure Architecture Center (Microsoft)](https://learn.microsoft.com/en-us/azure/architecture/patterns/materialized-view)
- [Materialized views — PostgreSQL documentation](https://www.postgresql.org/docs/current/rules-materializedviews.html)
- [Materialized view — Wikipedia](https://en.wikipedia.org/wiki/Materialized_view)
- [Incremental view maintenance — Wikipedia](https://en.wikipedia.org/wiki/Materialized_view#Incremental_maintenance)
