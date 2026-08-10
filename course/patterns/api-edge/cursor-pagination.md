---
title: "Cursor Pagination"
sidebar_position: 5
supplementary: true
---

Cursor pagination paginates a list by an opaque cursor — a token
pointing at "the item after this one" — instead of an offset and limit,
so each page is fetched relative to a specific row rather than a
position count.

## Problem it solves

Offset pagination (`LIMIT 20 OFFSET 100`) asks the database for the
n-th page by position, which breaks under concurrent writes: if a row
is inserted or deleted before the current offset while a client is
paging through results, every subsequent page shifts, causing rows to
be skipped or duplicated across pages. Offset pagination also performs
poorly at high offsets — the database still has to scan and discard all
the rows before the offset, so `OFFSET 1000000` is far slower than
`OFFSET 0` even though both return the same number of rows.

## How it works

Instead of a page number, the client sends a cursor — typically an
encoded value derived from the last item on the previous page (e.g. its
primary key or a composite of sort-key plus ID for stable ordering). The
server runs a query like `WHERE id > :cursor ORDER BY id LIMIT 20`,
which can use an index to jump directly to the right starting point
rather than scanning and discarding prior rows. The response includes a
new cursor pointing past the last row returned, which the client passes
back to fetch the next page. Because each query is anchored to a
specific row's key rather than a row count, rows inserted or deleted
elsewhere in the list don't shift what a given cursor points to.

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

## Real-world example

Stripe's list API endpoints use cursor-based pagination via
`starting_after` and `ending_before` parameters that reference an
existing object ID rather than a page number. GitHub's GraphQL API
similarly uses cursor-based pagination, with each page's response
including a cursor to fetch the next set of results.

## Related patterns

- [Database](/docs/concepts/database) — the primer's broader treatment
  of database query and indexing behavior that cursor pagination relies
  on for efficient lookups.

## Further reading

- [Pagination — Wikipedia](https://en.wikipedia.org/wiki/Pagination)
