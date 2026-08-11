---
title: "Quarantine"
sidebar_position: 5
supplementary: true
---

The Quarantine pattern isolates external artifacts — uploaded files,
third-party data feeds, build artifacts, ML training data — in a
restricted holding area and runs them through validation gates before
promoting them into a trusted zone, so nothing untrusted is ever
processed in the context that trusts it.

![Quarantine diagram](/img/patterns/quarantine.svg)

## Problem it solves

Anything that enters a system from outside — a user-uploaded file, a
payload from a partner API, a new dependency, a batch of training data —
carries risk until it's been checked: it might contain malware, be
malformed, or violate an assumption the rest of the system relies on. If
that artifact is made immediately available to other services or users
(stored in the same bucket production reads from, installed straight
into the build, fed directly to a training job), a bad artifact can
cause damage before anyone has looked at it — and the code that touches
it is the *trusted* code, operating with the very privileges an attacker
wants. The Quarantine pattern accepts that some validation takes time — a
virus scan, a schema check, a manual review — and keeps the artifact
fully isolated for exactly that long, so nothing downstream can be
affected by something that hasn't been cleared yet.

## Technical architecture & implementation

**The untrusted → validation → trusted pipeline.** The pattern is three
zones with one-way promotion between them. An arriving artifact is
written to a **quarantine area** — a separate storage bucket, namespace,
or filesystem path with its own restricted access controls — instead of
directly into the location production reads from. It runs a set of
**validation gates** while it sits there. Only if every gate passes is
it **promoted** into the trusted zone; otherwise it is **rejected**. The
essential property is directional: the production read path touches only
the trusted zone and *never* the quarantine area, so unscanned content
has no route to production code.

**Quarantine storage is isolated, not just a flag.** The distinguishing
feature versus a plain inline validation step is real isolation. A bad
artifact in quarantine sits in storage with its own access policy,
often in a different bucket or account, sometimes with execution
disabled — so even if validation is slow, buggy, or bypassed, the
artifact cannot be served or run from where it currently lives. A plain
"validate before use" check leaves the artifact in the trusted location
the whole time and merely gates *reading* it; quarantine gates its very
*location*. That physical/logical separation is what contains an
artifact that turns out to be actively malicious.

**Validation gates.** The gates are an ordered pipeline, cheapest and
most-likely-to-reject first so expensive work is skipped for artifacts
that will fail anyway. Common gates: a **size / rate limit** (reject
oversized or flooding input before spending resources on it), a
**format / schema validation** (the real bytes must match the declared
type — never trust an uploader's claimed content type), a **malware
scan**, and **policy checks** (licensing, provenance, allowed source).
The first failing gate short-circuits the rest; a rejected artifact is
not scanned further.

**Promote-or-reject, with audit.** Promotion is an explicit, atomic
step — a copy or move into the trusted store — that happens only after
all gates pass. Rejection deletes or archives the artifact and records
*why* it was rejected, and typically **notifies** the submitter and
writes an **audit** entry. That audit trail matters: a spike in
rejections is a security signal, and a promoted artifact should be
traceable back to the gates it cleared.

**Sync vs. async.** Fast, cheap validation can run inline before an
upload is even acknowledged. But real scanning (malware, deep format
inspection, manual review) is slow, so the common shape is
**asynchronous**: the artifact lands in quarantine, an out-of-band job
picks it up, and promotion happens later — which means consumers must
tolerate an artifact being "accepted but not yet available." This pairs
naturally with a work queue feeding the scanners.

**Failure modes.** The classic mistake is a **race**: production reads
from the quarantine location "just this once," or an artifact is
promoted before its async scan finishes — either lets unscanned content
through. **Gate bypass** (a code path that writes straight to the
trusted store, skipping quarantine) silently defeats the whole pattern,
so the trusted store must accept writes *only* from the promotion step.
**Trusting declared metadata** (accepting an uploader's content-type
instead of sniffing the real bytes) lets a mislabeled artifact slip a
format gate. And **stale scanners** — signatures or schema versions that
lag — promote artifacts that a current scanner would catch.

**Quarantine vs. a plain validation step vs. Bulkhead vs. Claim Check.**
A **plain validation step** checks input and rejects it, but leaves it
in place and provides no isolation while checking; quarantine
*physically or logically isolates* the artifact for the duration of an
often-slow check. [Bulkhead](/docs/patterns/reliability/bulkhead)
isolates *resources* (thread pools, connections) so one failing
dependency can't starve others — quarantine isolates *untrusted
content* so it can't reach trusted code; both are isolation, but along
different axes (runtime resources vs. data trust).
[Claim Check](/docs/patterns/communication/claim-check) keeps a *large*
payload off a message bus by passing a reference — orthogonal to trust,
but the two compose: a claim-check reference can point *into* a
quarantine area so a scanned-then-promoted artifact is what consumers
eventually fetch.

## The untrusted-to-trusted promotion pipeline

![Quarantine promotion pipeline](/img/patterns/quarantine-pipeline.svg)

The state an artifact moves through, and the guarantee at each step:

| Stage | Location | State | Reachable by production? |
| --- | --- | --- | --- |
| Submitted | Quarantine area | `Quarantined` | No |
| Under validation | Quarantine area | `Quarantined` | No |
| All gates pass | Trusted store | `Promoted` | Yes |
| Any gate fails | Deleted / archived | `Rejected` | No |

The single invariant that makes the pattern sound: an artifact reaches
the trusted store through **exactly one path** — the promotion step,
which runs only after every gate passes. There is no other way in, so a
`Quarantined` or `Rejected` artifact is unreachable from the trusted
context by construction.

## Code example

The snippet models the pipeline as a type-enforced invariant. An `Item`
is `submit`-ted into `Quarantined` state; a `Quarantine` runs an ordered
chain of gates (size, format-vs-declared-kind, malware) and the *only*
way an item reaches the `TrustedStore` is `promote`, which re-runs every
gate and inserts iff all pass. `TrustedStore::insert` is private, so the
promotion step is the sole writer — a failing item is left `Rejected`
and the store is never touched. The exercised invariant: a clean PNG is
promoted and appears in the store, while an infected, mislabeled,
oversized, or unsupported artifact is rejected and never reaches it.

```rust
// Quarantine: an untrusted-item pipeline. A submitted item lands in a holding
// area, runs an ordered set of validation gates, and is promoted to the trusted
// store only if EVERY gate passes. A failing item is rejected and can never be
// promoted — the trusted store only ever holds vetted items.

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum State {
    Quarantined,
    Promoted,
    Rejected,
}

/// An incoming artifact. `payload` and `declared_kind` are attacker-controlled.
pub struct Item {
    pub id: String,
    pub declared_kind: String, // e.g. "image/png" claimed by the uploader
    pub payload: Vec<u8>,
    pub state: State,
}

impl Item {
    pub fn submit(id: &str, declared_kind: &str, payload: Vec<u8>) -> Self {
        // Everything starts isolated, never trusted.
        Item { id: id.into(), declared_kind: declared_kind.into(), payload, state: State::Quarantined }
    }
}

/// A gate returns Ok(()) to pass or Err(reason) to fail. Gates run in order and
/// the first failure short-circuits: a rejected item is not scanned further.
type Gate = fn(&Item) -> Result<(), &'static str>;

/// Size gate: reject oversized artifacts before any expensive scan.
fn size_gate(item: &Item) -> Result<(), &'static str> {
    match item.payload.len() <= 8 * 1024 * 1024 {
        true => Ok(()),
        false => Err("payload too large"),
    }
}

/// Format gate: the real bytes must match the declared kind. Here, a PNG must
/// start with the PNG magic number — a stand-in for real content sniffing that
/// refuses to trust the uploader's declared type.
fn format_gate(item: &Item) -> Result<(), &'static str> {
    const PNG_MAGIC: [u8; 4] = [0x89, b'P', b'N', b'G'];
    match item.declared_kind.as_str() {
        "image/png" => match item.payload.starts_with(&PNG_MAGIC) {
            true => Ok(()),
            false => Err("declared PNG but bytes are not PNG"),
        },
        _ => Err("unsupported kind"),
    }
}

/// Malware gate: stands in for a real scanner. Any item carrying the known-bad
/// marker is treated as infected.
fn malware_gate(item: &Item) -> Result<(), &'static str> {
    match item.payload.windows(3).any(|w| w == b"EVL") {
        true => Err("malware signature detected"),
        false => Ok(()),
    }
}

/// The trusted store. Its `insert` is private to this module, and the only
/// caller is `Quarantine::promote`, which runs only after all gates pass. There
/// is no other path to it — a quarantined or rejected item cannot be inserted.
pub struct TrustedStore {
    items: Vec<String>,
}

impl TrustedStore {
    pub fn new() -> Self {
        TrustedStore { items: Vec::new() }
    }
    fn insert(&mut self, id: String) {
        self.items.push(id);
    }
    pub fn contains(&self, id: &str) -> bool {
        self.items.iter().any(|s| s == id)
    }
    pub fn len(&self) -> usize {
        self.items.len()
    }
}

pub struct Quarantine {
    gates: Vec<Gate>,
}

impl Quarantine {
    /// A quarantine with the standard gate chain. Order matters: cheap checks
    /// (size) run before expensive ones (scan).
    pub fn standard() -> Self {
        Quarantine { gates: vec![size_gate, format_gate, malware_gate] }
    }

    /// Run every gate. On the first failure, mark the item Rejected and stop.
    fn validate(&self, item: &mut Item) {
        for gate in &self.gates {
            if let Err(_reason) = gate(item) {
                item.state = State::Rejected;
                return;
            }
        }
        // All gates passed — eligible for promotion, but NOT yet in the trusted
        // store. Promotion is a separate, explicit step.
        item.state = State::Quarantined;
    }

    /// The only way an item reaches the trusted store. It re-runs validation and
    /// promotes iff every gate passes; a failing item is left Rejected and the
    /// store is never written. Returns the terminal state.
    pub fn promote(&self, mut item: Item, store: &mut TrustedStore) -> State {
        self.validate(&mut item);
        match item.state {
            State::Rejected => State::Rejected,
            _ => {
                store.insert(item.id.clone());
                State::Promoted
            }
        }
    }
}
```

Only items that clear every gate are inserted into the `TrustedStore`;
an infected, mislabeled, oversized, or unsupported-kind item is left in
`Rejected` state and the store is never written, so the trusted zone
holds only vetted artifacts — the invariant the whole pattern exists to
guarantee.

## Concrete flow: file uploads

A common instance: a user uploads a file, which lands in a quarantine
bucket rather than the production assets bucket. An asynchronous job
picks it up, runs a malware scan plus a format/size check against it,
and then either copies it into the production bucket (on success) or
deletes it and notifies the user of the rejection (on failure). The
application's normal read path never touches the quarantine bucket at
all — only the promoted, verified copy in production storage. The
quarantine bucket typically has a stricter access policy and, where
supported, disables serving or execution so a malicious file can't be
fetched even before it's scanned.

## When to use it

- Accepting file uploads from users or external partners where malware
  or malformed content is a realistic risk.
- Ingesting third-party data feeds that need schema or integrity
  validation before other services consume them.
- Pulling in new software dependencies or container images that should
  pass a vulnerability scan before being used in a build.
- Admitting external ML training data or model artifacts that must be
  screened (for poisoning, license, or format) before entering a
  pipeline that would otherwise trust them.

## When not to use it

- The source is already fully trusted (e.g., internal service-to-service
  calls within a controlled network) — the isolation step adds latency
  without a real risk it's mitigating.
- The check that would run is trivial and synchronous enough to run
  inline before accepting the artifact at all, making a separate
  isolated area unnecessary — a plain validation step suffices.
- Extremely latency-sensitive ingestion paths where even a short
  quarantine delay is unacceptable and the risk is better mitigated
  another way (e.g., sandboxed execution instead of pre-scanning).

## Use-case scenarios

**User-generated content uploads.** A social or productivity app lets
users upload avatars, documents, and attachments. Each upload lands in
a quarantine bucket with no public read access; an async worker runs a
malware scan and a real content-type sniff (rejecting a `.png` whose
bytes are actually an executable), then promotes clean files to the
CDN-backed production bucket and deletes the rest with a notification to
the uploader. The app's serving path reads only the production bucket,
so a malicious upload is never reachable by another user even in the
window before it's scanned.

**Third-party data-feed ingestion.** A pricing service ingests a daily
partner feed. Rather than loading it straight into the tables live
queries read from, each batch lands in a quarantine schema where it's
validated against the expected format, row counts, and integrity
checksums, and screened for anomalous values that would indicate a bad
export. Only a batch that passes every gate is promoted into the
production tables in one atomic swap; a failed batch is rejected and
paged, and yesterday's good data keeps serving.

**Build-artifact and dependency intake.** A CI system pulls in a new
container base image and third-party packages. They're first placed in a
quarantine registry and scanned for known CVEs, verified signatures, and
license policy before being promoted to the internal registry that
builds are allowed to pull from. A build can only reference the trusted
registry, so an artifact that fails the scan simply never becomes
available to a pipeline — the untrusted artifact is contained in
quarantine, exactly as an uploaded file would be.

## Production libraries & getting started

The validation gates in a quarantine pipeline are real scanners and
content-inspection services wired to a staging bucket: a malware scanner
runs against the isolated artifact, and only a promotion step copies clean
artifacts into the trusted store. These are the real tools teams build the
scan-then-promote pipeline from:

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| ClamAV | C | Open-source antivirus engine (`clamd`/`clamscan`) for the malware gate against quarantined uploads | [docs.clamav.net](https://docs.clamav.net/) |
| AWS GuardDuty Malware Protection for S3 | Managed (AWS) | Automatically scans newly uploaded S3 objects for malware, tagging clean-vs-infected to drive promotion | [docs.aws.amazon.com/guardduty](https://docs.aws.amazon.com/guardduty/latest/ug/gdu-malware-protection-s3.html) |
| VirusTotal API | REST (any language) | Multi-engine file/URL reputation lookup as an additional malware/policy gate in the pipeline | [docs.virustotal.com](https://docs.virustotal.com/reference/overview) |
| Amazon S3 (staging bucket) | Managed (AWS) | A separate quarantine bucket with its own restricted access policy — the isolated holding area artifacts land in first | [docs.aws.amazon.com/AmazonS3 — malware scan](https://docs.aws.amazon.com/AmazonS3/latest/userguide/scan-objects-for-malware.html) |

**Example / reference:** [How Malware Protection for S3 works — Amazon GuardDuty docs](https://docs.aws.amazon.com/guardduty/latest/ug/how-malware-protection-for-s3-gdu-works.html)

## Related patterns

- [Blob Store](/docs/patterns/building-blocks/blob-store) — quarantine
  areas for file uploads are typically implemented as a separate blob
  store bucket/prefix with its own restricted access policy from the
  production store.
- [Bulkhead](/docs/patterns/reliability/bulkhead) — the sibling
  isolation pattern: bulkhead isolates *resources* to contain a failure,
  quarantine isolates *untrusted content* to contain a threat.
- [Claim Check](/docs/patterns/communication/claim-check) — keeps large
  payloads off a message bus via a reference; a claim-check reference can
  point into a quarantine area so consumers fetch only the promoted copy.
- [Gatekeeper](/docs/patterns/integration/gatekeeper) — validates and
  sanitizes untrusted *requests* at a trust boundary in real time, the
  request-side complement to quarantine's artifact-side isolation.
- [Anti-Corruption Layer](/docs/patterns/integration/anti-corruption-layer) —
  guards a domain model from a foreign system's model; quarantine guards
  a trusted zone from foreign *artifacts*, a related boundary-defense
  instinct.

## Further reading

- [Sandbox (computer security) — Wikipedia](https://en.wikipedia.org/wiki/Sandbox_(computer_security))
- [How Malware Protection for S3 works — Amazon GuardDuty docs](https://docs.aws.amazon.com/guardduty/latest/ug/how-malware-protection-for-s3-gdu-works.html)
- [File upload — OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)
- [Data poisoning — Wikipedia](https://en.wikipedia.org/wiki/Data_poisoning)
