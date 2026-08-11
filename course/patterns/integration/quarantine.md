---
title: "Quarantine"
sidebar_position: 5
supplementary: true
---

The Quarantine pattern isolates external assets — uploaded files,
third-party data, new dependencies — in a restricted area until
they've passed a quality or security check, rather than trusting them
and making them available to the rest of the system immediately.

![Quarantine diagram](/img/patterns/quarantine.svg)

## Problem it solves

Anything that enters a system from outside — a user-uploaded file, a
payload from a partner API, a new library version — carries risk until
it's been checked: it might contain malware, be malformed, or violate
an assumption the rest of the system relies on. If that asset is made
immediately available to other services or users (stored in the same
bucket production reads from, installed straight into the build), a
bad asset can cause damage before anyone has looked at it. The
Quarantine pattern accepts that some validation takes time — a virus
scan, a format check, a manual review — and keeps the asset fully
isolated for exactly that long, so nothing downstream can be affected
by something that hasn't been cleared yet.

## How it works

When an external asset arrives, it's written to a quarantine area —
typically a separate storage bucket, namespace, or filesystem path
with its own restricted access controls — instead of directly into the
location production code reads from. A scanning or verification step
(a virus scanner, a format validator, a checksum comparison, a manual
approval queue) runs against the asset while it sits in quarantine.
If the asset passes, it's moved or copied into the production
location where it becomes available for normal use. If it fails, it's
deleted or flagged and never reaches production at all. Nothing that
reads from the production location ever has to worry about
unscanned content, because unscanned content simply never gets there.

## Code example

The snippet below models the state an asset moves through and the
only legal transitions between those states.

```rust
#[derive(Debug, PartialEq)]
enum AssetState {
    Quarantined,
    Verified,
    Rejected,
}

struct Asset {
    id: String,
    state: AssetState,
}

enum ScanResult {
    Clean,
    Infected,
}

fn scan(asset: &Asset) -> ScanResult {
    // Stands in for a real virus/format scanner.
    if asset.id.starts_with("bad_") {
        ScanResult::Infected
    } else {
        ScanResult::Clean
    }
}

fn process(mut asset: Asset) -> Asset {
    assert_eq!(asset.state, AssetState::Quarantined, "only quarantined assets can be scanned");

    asset.state = match scan(&asset) {
        ScanResult::Clean => AssetState::Verified,
        ScanResult::Infected => AssetState::Rejected,
    };

    asset
}
```

Only assets in `AssetState::Verified` would ever be moved into a
location the rest of the system trusts; `Rejected` assets are deleted
and never promoted.

## Concrete flow: file uploads

A common instance of this pattern: a user uploads a file, which lands
in a quarantine bucket rather than the production assets bucket. An
asynchronous job picks it up, runs a virus scan and a format/size
check against it, and then either copies it into the production bucket
(on success) or deletes it and notifies the user of the rejection (on
failure). The application's normal read path never touches the
quarantine bucket at all — only the promoted, verified copy in
production storage.

## When to use it

- Accepting file uploads from users or external partners where malware
  or malformed content is a realistic risk.
- Ingesting third-party data feeds that need schema or integrity
  validation before other services consume them.
- Pulling in new software dependencies or container images that should
  pass a vulnerability scan before being used in a build.

## When not to use it

- The source is already fully trusted (e.g., internal service-to-service
  calls within a controlled network) — the isolation step adds latency
  without a real risk it's mitigating.
- The check that would run in quarantine is trivial and synchronous
  enough to run inline before accepting the asset at all, making a
  separate isolated area unnecessary.
- Extremely latency-sensitive ingestion paths where even a short
  quarantine delay is unacceptable and the risk is better mitigated
  another way (e.g., sandboxed execution instead of pre-scanning).

## Real-world example

Cloud storage platforms commonly offer managed malware scanning for
uploaded objects — for example, AWS GuardDuty's Malware Protection for
S3 scans newly uploaded objects in a bucket and tags them with a scan
result, which application code can use to gate whether an object is
served to users or moved to a trusted location.

## Related patterns

- [Blob Store](/docs/patterns/building-blocks/blob-store) — quarantine
  areas for file uploads are typically implemented as a separate blob
  store bucket/prefix with its own access policy from the production
  store.

## Further reading

- [Sandbox (computer security) — Wikipedia](https://en.wikipedia.org/wiki/Sandbox_(computer_security))
- [How Malware Protection for S3 works — Amazon GuardDuty docs](https://docs.aws.amazon.com/guardduty/latest/ug/how-malware-protection-for-s3-gdu-works.html)
