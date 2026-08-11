---
title: "Blob Store"
sidebar_position: 7
supplementary: true
---

A blob store (object storage) holds large, immutable-once-written
binary data — images, videos, backups, large files — addressed by a
flat key rather than a filesystem path, typically paired with a
separate metadata index for anything that needs to be queried.

## Problem it solves

Traditional filesystems and relational databases are built around
small, frequently mutated records and hierarchical directory
structures, neither of which fits large binary payloads well. Storing
multi-megabyte files directly in a database bloats rows, slows backups,
and wastes an engine optimized for structured queries on data it can't
meaningfully query anyway. A hierarchical filesystem, meanwhile, has
practical limits on directory size and doesn't scale horizontally
across machines the way a flat, key-addressed store can. A blob store
solves both problems: it's built specifically to store and serve large,
opaque byte payloads at scale, addressed by a simple key, with none of
the query or mutation machinery those payloads don't need.

## How it works

Every object is written as a whole, addressed by a unique key (often
just a string, sometimes hierarchical-looking but not actually a
directory tree), and retrieved as a whole — objects are treated as
immutable once written, so an "update" is really a full replace under
the same key, not an in-place partial write. Because objects carry no
queryable structure of their own, anything that needs to be searched or
filtered (owner, content type, tags, upload date) is kept in a separate
metadata index — typically a regular database — that stores the blob
store key alongside the queryable fields. Internally, blob stores
achieve durability and scale by splitting each object across multiple
physical disks or nodes with redundancy (erasure coding or replication)
and distributing objects across many storage nodes by key, similar in
spirit to sharding a database. Because objects are immutable and keyed,
caching and CDN distribution in front of a blob store are
straightforward — a given key always maps to the same bytes.

## When to use it

- Storing large binary payloads (images, video, backups, data lake
  files) that are written once and read many times, rather than
  frequently mutated in place.
- The data doesn't need to be queried by content — only fetched by a
  known key — with any filtering handled by a separate metadata index.
- You need storage capacity and throughput that scale horizontally well
  beyond what a single filesystem or database instance can provide.

## When not to use it

- The data is small, frequently updated in place, or needs to be
  queried by its own contents — a regular database is a better fit.
- Strong read-after-write consistency on every object, immediately
  after every write, is required and the chosen provider only offers
  eventual consistency for some operations — verify the specific
  provider's guarantees before relying on this.

## Real-world example

AWS S3 and Google Cloud Storage are the dominant managed blob stores,
both exposing a flat key-per-bucket model and both commonly paired with
a CDN in front for read-heavy public content.

## Related patterns

- [CDN](/docs/patterns/building-blocks/cdn) — the pattern covering caching and
  distributing static content at the edge, which blob stores are
  frequently placed behind.

## Further reading

- [Object storage — Wikipedia](https://en.wikipedia.org/wiki/Object_storage)
- [Cloud Object Storage — Amazon S3](https://aws.amazon.com/s3/)
