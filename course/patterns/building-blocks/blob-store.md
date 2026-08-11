---
title: "Blob Store"
sidebar_position: 7
supplementary: true
---

A blob store (object storage) holds large, immutable-once-written
binary data — images, videos, backups, large files — addressed by a
flat key rather than a filesystem path, and internally split, replicated
or erasure-coded, and indexed by a separate metadata service so it can
scale durability and capacity independently of any single machine.

![Blob Store diagram](/img/patterns/blob-store.svg)

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
the query or mutation machinery those payloads don't need — and with a
durability model tuned for keeping bytes safe across disk and node
failures rather than for transactional updates.

## Technical architecture & implementation

**Flat namespace and immutable objects.** Every object is written as a
whole and addressed by a unique key — a plain string like
`photos/2024/cat.jpg`. The slashes *look* hierarchical but there is no
real directory tree; the key is opaque and the "folders" are a naming
convention plus a prefix-listing API. Objects are **immutable once
written**: an "update" is a full replace under the same key (often
producing a new *version*), never an in-place partial write. That single
constraint is what makes everything downstream simple — a given key
always maps to the same bytes, so caching, CDN distribution, and content
addressing are trivial, and concurrent readers never see a torn write.

**Metadata service vs data plane.** A blob store is really two systems.
The **data plane** stores the raw bytes across many storage nodes. The
**metadata service** — typically a
[key-value store](/docs/patterns/building-blocks/key-value-store) or a
sharded database — maps each object key to a *manifest*: where its
chunks live, its size, content type, version, checksums, and any
queryable tags. Because the blob itself has no queryable structure,
anything you need to *filter* on (owner, upload date, tags) lives here,
not in the object. Keeping metadata separate lets billions of objects be
indexed in a compact, fast store while the bytes sit on cheap,
high-capacity media.

**Chunking and striping.** Large objects are split into fixed-size
*chunks* (commonly a few MB each) and striped across many nodes. This
parallelizes both upload and download (chunks transfer concurrently),
bounds the blast radius of any one disk failure to a few chunks rather
than a whole object, and enables **multipart / resumable uploads** — a
failed transfer retries only the missing chunks. The manifest records
the chunk order so the object can be reassembled on read.

**Durability — replication vs erasure coding.** Two schemes protect
against disk and node loss. **N-way replication** stores N full copies:
simple, fast to repair, and cheap to read (any copy serves), but storage
overhead is N× (3× replication is common for hot data). **Erasure
coding** splits data into *k* data shards plus *m* parity shards
(Reed-Solomon RS(k, m)); any *k* of the *k + m* shards can reconstruct
the object, tolerating *m* failures with overhead of only `(k+m)/k`. For
the same two-failure tolerance, RS(4, 2) costs 1.5× storage where 3×
replication costs 3× — which is why cold and archival tiers lean heavily
on erasure coding, accepting its higher read/repair CPU cost in exchange
for far cheaper storage. Object checksums stored in the manifest let a
background scrubber detect and repair bit rot before both copies of a
chunk are lost.

**Consistency and the read-after-write question.** Distributing chunks
and manifests across nodes means writes take time to become globally
visible. Historically some object stores offered only **eventual
consistency** for overwrites and listings — a freshly written key could
briefly 404 or return a stale version from a replica. Modern services
(notably Amazon S3 since 2020) now provide **strong read-after-write
consistency** for new objects and overwrites, but list-after-write and
cross-region replication can still lag. This is the key operational
subtlety: verify the *specific* provider's guarantees before building
logic (like a job that writes then immediately reads a manifest) that
assumes them.

**Where it sits among siblings.** A blob store is a
[key-value store](/docs/patterns/building-blocks/key-value-store)
specialized for large, immutable payloads — same flat-key addressing,
but tuned for throughput and durability of big opaque blobs rather than
small mutable records. It is almost always placed behind a
[CDN](/docs/patterns/building-blocks/cdn): immutability means a key's
bytes never change, so edge caches can hold them indefinitely. And
unlike a [distributed search](/docs/patterns/building-blocks/distributed-search)
index — which exists to answer content queries — a blob store
deliberately can't look inside its objects; that job is delegated to the
metadata service or an external index.

## Code example

The write path in miniature: split an object into chunks, place each
deterministically on a node, and record a manifest for the metadata
service. The second test encodes the core durability tradeoff —
erasure coding achieves the same fault tolerance as replication at a
fraction of the storage overhead.

```rust
#[derive(Debug, Clone)]
pub struct ChunkRef {
    pub index: usize,
    pub node: String,
    pub len: usize,
}

#[derive(Debug)]
pub struct Manifest {
    pub key: String,
    pub size: usize,
    pub chunks: Vec<ChunkRef>,
}

// Deterministic placement so a given (key, index) always lands on the same node.
fn place(key: &str, index: usize, nodes: &[String]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in key.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h ^= index as u64;
    h = (h ^ (h >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    nodes[(h as usize) % nodes.len()].clone()
}

pub fn write_object(key: &str, data: &[u8], chunk_size: usize, nodes: &[String]) -> Manifest {
    let mut chunks = Vec::new();
    for (index, chunk) in data.chunks(chunk_size).enumerate() {
        chunks.push(ChunkRef { index, node: place(key, index, nodes), len: chunk.len() });
    }
    Manifest { key: key.to_string(), size: data.len(), chunks }
}

// Raw bytes stored per logical byte. Replication(n) stores n copies.
// Erasure coding(k data, m parity) stores (k+m)/k, tolerating m lost shards.
pub fn replication_overhead(n: u32) -> f64 {
    n as f64
}
pub fn erasure_overhead(k: u32, m: u32) -> f64 {
    (k + m) as f64 / k as f64
}
// For 2-failure tolerance: replication_overhead(3) == 3.0, erasure_overhead(4, 2) == 1.5.
```

## When to use it

- Storing large binary payloads (images, video, backups, data-lake
  files) that are written once and read many times, rather than
  frequently mutated in place.
- The data doesn't need to be queried by content — only fetched by a
  known key — with any filtering handled by a separate metadata index.
- You need storage capacity and durability that scale horizontally well
  beyond what a single filesystem or database instance can provide, at a
  cost per byte that erasure coding can drive down.

## When not to use it

- The data is small, frequently updated in place, or needs to be
  queried by its own contents — a regular database or
  [key-value store](/docs/patterns/building-blocks/key-value-store) is a
  better fit.
- The access pattern is many tiny random reads/writes with strict
  low-latency requirements — object-store per-request overhead and
  eventual-consistency edges make it a poor fit for hot transactional
  state.
- You require strong read-after-write and list-after-write consistency
  on every operation and the chosen provider only guarantees it for
  some — verify the provider's exact semantics before relying on them.

## Use-case scenarios

**User-generated media for a social platform.** Photos and videos are
written once on upload and read millions of times, unchanged. Each
upload streams as a multipart, chunked write; the metadata service
records the manifest plus tags (owner, album, EXIF), and the object sits
behind a [CDN](/docs/patterns/building-blocks/cdn) so its immutable bytes
are cached at the edge indefinitely. Hot content uses 3× replication for
fast repair; older, rarely-touched media is transparently re-encoded to
erasure coding to cut storage cost.

**Data-lake and analytics storage.** A company lands raw event files,
Parquet tables, and ML training sets as objects keyed by
`dataset/date/partition`. Query engines and training jobs read them by
key and prefix; nothing queries *inside* an object through the store
itself. Erasure coding keeps petabytes affordable, and immutability
means a snapshot of the lake at a point in time is just the set of keys
that existed then — no locking, no torn reads.

**Backup and disaster-recovery archive.** Nightly database and system
backups are written as large, immutable objects with versioning enabled,
often to a cheaper cold/archival storage class. The metadata service
tracks retention and lifecycle; a background scrubber verifies chunk
checksums to catch bit rot. Restore is a keyed fetch-and-reassemble, and
because each backup is a distinct immutable version, restoring to any
prior point is just choosing the right key.

## Production libraries & getting started

Blob storage is served by managed object stores and self-hostable servers rather than a single drop-in library; you talk to them through vendor SDKs (most speak the S3 API).

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| MinIO | Self-host (Go) | S3-compatible object store you run yourself | [MinIO docs](https://min.io/docs/minio/linux/index.html) |
| Ceph | Self-host (C++) | Distributed object/block/file storage with erasure coding | [Ceph getting started](https://docs.ceph.com/en/latest/start/) |
| AWS SDK for JavaScript v3 (S3) | JS/TS | S3 client for Node/browser | [Getting started](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/getting-started.html) |
| AWS SDK for Rust (S3) | Rust | Async S3 client | [Getting started](https://docs.aws.amazon.com/sdk-for-rust/latest/dg/getting-started.html) |
| AWS SDK for Go v2 (S3) | Go | S3 client for Go services | [aws-sdk-go-v2](https://github.com/aws/aws-sdk-go-v2) |
| Boto3 (S3) | Python | Idiomatic S3 client | [Quickstart](https://boto3.amazonaws.com/v1/documentation/api/latest/guide/quickstart.html) |
| Google Cloud Storage / Azure Blob | JS/Rust/Go/Python | Managed object stores with per-language SDKs | [GCS libraries](https://cloud.google.com/storage/docs/reference/libraries) · [Azure Blob quickstart](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-quickstart-blobs-nodejs) |

**Example / reference:** [aws-sdk-js-notes-app](https://github.com/aws-samples/aws-sdk-js-notes-app) — an official AWS sample using S3 from a JS app.

## Related patterns

- [CDN](/docs/patterns/building-blocks/cdn) — the edge-caching pattern
  blob stores are frequently placed behind; object immutability makes
  edge caching straightforward since a key's bytes never change.
- [Key-Value Store](/docs/patterns/building-blocks/key-value-store) — the
  general pattern a blob store specializes for large immutable payloads,
  and typically the engine behind its metadata service.
- [Consistent Hashing](/docs/patterns/storage/consistent-hashing) — the
  technique used to place object chunks across storage nodes so adding
  capacity moves minimal data.
- [Distributed Search](/docs/patterns/building-blocks/distributed-search) —
  the pattern to reach for when you need to query object *contents* or
  rich metadata, which a blob store deliberately cannot do itself.

## Further reading

- [Object storage — Wikipedia](https://en.wikipedia.org/wiki/Object_storage)
- [Erasure code — Wikipedia](https://en.wikipedia.org/wiki/Erasure_code)
- [Amazon S3 data consistency model](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html#ConsistencyModel)
- [Reed–Solomon error correction — Wikipedia](https://en.wikipedia.org/wiki/Reed%E2%80%93Solomon_error_correction)
- [Cloud Object Storage — Amazon S3](https://aws.amazon.com/s3/)
