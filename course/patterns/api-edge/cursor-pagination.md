---
title: "Cursor Pagination"
sidebar_position: 5
supplementary: true
---

Cursor pagination paginates a list by an opaque cursor — a token
pointing at "the item after this one" — instead of an offset and limit,
so each page is fetched relative to a specific row rather than a
position count.

![Cursor Pagination diagram](/img/patterns/cursor-pagination.svg)

## Problem it solves

Offset pagination (`LIMIT 20 OFFSET 100`) asks the database for the
n-th page by position, which breaks under concurrent writes: if a row
is inserted or deleted before the current offset while a client is
paging through results, every subsequent page shifts, causing rows to
be skipped or duplicated across pages. Offset pagination also performs
poorly at high offsets — the database still has to scan and discard all
the rows before the offset, so `OFFSET 1000000` is far slower than
`OFFSET 0` even though both return the same number of rows.

| Dimension | Offset pagination | Cursor pagination |
| --- | --- | --- |
| Deep-page cost | Scans and discards all prior rows | Index seek to the anchor row, roughly constant |
| Stability under inserts/deletes | Pages shift — rows skipped or duplicated | Anchored to a specific row, unaffected |
| Jump to arbitrary page N | Supported directly | Not supported — only forward/backward traversal |
| Total-count / page numbers | Natural to expose | Awkward — no notion of position |
| Implementation simplicity | Simplest to reason about | Needs a stable, unique sort key |

## Technical architecture & implementation

**Cursor construction.** A cursor is an opaque token the client treats
as a black box and passes back unmodified — typically an encoded
representation of the value(s) needed to resume the query exactly where
the previous page left off. For a single-column sort, that's just the
last row's key (e.g. its primary key or auto-incrementing ID); for a
sort on a non-unique column (e.g. "most recent first" by a timestamp
that isn't itself unique), the cursor has to be a **composite** of the
sort column plus a tiebreaker unique column (`(created_at, id)`),
because a cursor built from a non-unique value alone can't distinguish
between several rows sharing the same timestamp, and would either skip
some of them or return them twice across a page boundary. Encoding the
cursor (commonly base64 over a small serialized struct) rather than
exposing the raw key directly keeps the format free to change later and
avoids clients depending on or attempting to construct their own
cursors by hand.

**Query mechanics.** The server turns the cursor into a `WHERE`
predicate anchored to that row: `WHERE (created_at, id) < (:cursor_ts,
:cursor_id) ORDER BY created_at DESC, id DESC LIMIT 20` for a
descending-time feed, for example. Because the predicate matches the
same columns the query is sorted and indexed on, the database performs
an index seek directly to the correct starting point rather than
scanning every row before it — this is the mechanical reason cursor
pagination avoids offset pagination's "deeper pages get slower"
problem: seeking to a specific key by index lookup costs roughly the
same regardless of how far into the dataset that key sits, while
`OFFSET n` genuinely has to walk past `n` rows first under most
implementations. The response includes a new cursor derived from the
last row actually returned, ready to be sent back for the next page.

**Bidirectional and stable ordering.** Supporting "previous page" as
well as "next page" means running the equivalent reversed query (flip
the comparison operator and sort direction, then re-reverse the
returned rows before sending them to the client) rather than trying to
subtract from a position — cursors don't have a notion of position to
subtract from in the first place. Stable ordering is essential
throughout: if the sort column's values can tie and no unique
tiebreaker is included in the cursor, pages can silently reorder rows
across requests in a way that duplicates or skips entries, which is the
same class of bug offset pagination has, just triggered by a different
cause (ties in the sort key rather than concurrent writes).

**Failure modes.** The main correctness failure is a cursor built from
a non-unique, non-tiebroken sort key, which reproduces exactly the
skip/duplicate bug this pattern exists to avoid, just from tied sort
values rather than shifting offsets. A second, operational failure mode
is a cursor becoming invalid across a schema or index change — if the
column a cursor encodes gets removed or reindexed differently, a client
holding an old cursor (e.g. resuming an infinite scroll after being
backgrounded for hours) may find its cursor no longer resolves to a
sensible position, which the server has to detect and respond to
explicitly (an error, or a reset to the first page) rather than
silently returning an arbitrary result. A third is treating the cursor
as something a client is allowed to construct manually rather than an
opaque token — once clients start hand-building cursors, the server can
no longer freely change the cursor's internal format without breaking
them.

## Code example

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Cursor {
    // (sort_key, tiebreaker) — both needed because sort_key alone can
    // tie across multiple rows.
    created_at: u64,
    id: u64,
}

#[derive(Clone, Debug)]
struct Row {
    id: u64,
    created_at: u64,
}

struct Page {
    rows: Vec<Row>,
    next_cursor: Option<Cursor>,
}

// Simulates `WHERE (created_at, id) < (cursor.created_at, cursor.id)
// ORDER BY created_at DESC, id DESC LIMIT page_size`, anchored to a
// specific row rather than a row count.
fn fetch_page(all_rows: &[Row], cursor: Option<Cursor>, page_size: usize) -> Page {
    let mut sorted: Vec<Row> = all_rows.to_vec();
    sorted.sort_by(|a, b| (b.created_at, b.id).cmp(&(a.created_at, a.id)));

    let start = match cursor {
        Some(c) => sorted
            .iter()
            .position(|r| (r.created_at, r.id) < (c.created_at, c.id))
            .unwrap_or(sorted.len()),
        None => 0,
    };

    let page_rows: Vec<Row> = sorted.into_iter().skip(start).take(page_size).collect();
    let next_cursor = page_rows
        .last()
        .map(|r| Cursor { created_at: r.created_at, id: r.id });

    Page { rows: page_rows, next_cursor }
}
```

`fetch_page` anchors on the `(created_at, id)` pair, not a row count —
inserting a new row anywhere in `all_rows` shifts nothing about where
an existing cursor resumes, because the comparison is against a
specific row's key, never against a position.

## When to use it

- Lists that are read while concurrently being written to (feeds,
  activity streams, any live dataset) where offset-based paging would
  skip or duplicate rows.
- Very large or deep result sets, where offset pagination's cost of
  scanning-and-discarding prior rows becomes a real performance problem.
- APIs meant for programmatic/infinite-scroll consumption, where
  "next page" is a natural fit and jumping to an arbitrary page number
  isn't a real requirement.

## When not to use it

- The UI needs to jump to an arbitrary page number (e.g. "go to page
  47") or show a total page count — cursors don't support random
  access, only forward/backward traversal from a known point.
- The dataset is small and effectively static, where offset
  pagination's downsides never materialize in practice.
- Simplicity matters more than correctness at the edges — offset
  pagination is easier to reason about and implement for a low-traffic,
  low-write internal tool.

## Use-case scenarios

**Social media infinite-scroll feed.** A social app's home feed is
read continuously by millions of users while new posts are written
every second. Offset pagination would mean a user scrolling to "page
5" could see posts they already saw again, or miss posts entirely,
depending on exactly how many new posts landed above their current
position between requests. Cursor pagination anchored to each post's
`(created_at, id)` guarantees that "the next 20 posts after the one I
last saw" means the same thing regardless of how many new posts have
been written since, because the query is relative to a specific post,
not a shifting count.

**Payments API listing transactions for reconciliation.** A payments
platform's API lets merchants page through their full transaction
history, sometimes millions of rows deep, to reconcile against their
own accounting systems. A merchant fetching page 50,000 under offset
pagination would force the database to scan and discard 50,000 rows
before returning the next 20; a cursor anchored to the last transaction
ID lets the database seek directly to that point via an index lookup,
keeping page-fetch latency roughly constant regardless of how deep into
the history the merchant has paged.

**Log-search tool for on-call engineers.** An observability platform
lets engineers page through log lines during an incident, where new
log lines are actively being ingested while the engineer scrolls.
Cursor pagination anchored to each log line's ingestion timestamp plus
a unique sequence number ensures that paging "further back in time"
returns a consistent, non-overlapping sequence of lines even as new
lines continue arriving at the head of the stream — an offset-based
approach would have the engineer's page boundaries drift as new lines
shift every row's position underneath them.

## Related patterns

- [Database](/docs/concepts/database) — the primer's broader treatment
  of database query and indexing behavior that cursor pagination relies
  on for efficient lookups.

## Further reading

- [Pagination — Wikipedia](https://en.wikipedia.org/wiki/Pagination)
- [Pagination — GraphQL (cursor-based Connections model)](https://graphql.org/learn/pagination/)
