# Fintech case-study authoring spec

You are authoring ONE **fintech system-design case study** for the course, sourced
from a YouTube explainer video (via yt-notes) and grounded in **authoritative
research**. The reader works in fintech and wants complete, correct, end-to-end
intuition for actually building these systems — depth and accuracy matter more
than brevity.

**Match the locked exemplar EXACTLY in structure and depth:**
`course/case-studies/system-design/payment-system.md`

## Inputs

- yt-notes bundle at `~/yt-notes-library/bundles/<video-id>/` — read `meta.json`
  (title/description) and `transcript.clean.md` (the video's framing & intuition).
  The video is the SEED for scope and narrative, NOT the authority. Do NOT embed
  video frames (these are case studies with hand-authored SVG diagrams, not lecture notes).
- **Authoritative research (required):** verify every domain fact against primary
  sources and cite them. Depending on topic: NPCI/UPI product & circular docs,
  card-network specs (ISO 8583, EMV, PCI-DSS, tokenization/EMVCo), Fed/NACHA (ACH),
  RTP/FedNow, ISO 20022, SWIFT, PayPal/Stripe/Adyen engineering blogs, SEC/DTCC/NSCC
  (clearing & T+1 settlement), FIX protocol (trading), exchange/HFT references. If you
  cannot verify a specific mechanism, describe it at the level you CAN support and say so.

## Output

- Doc: `course/case-studies/fintech/<slug>.md` (slug given per assignment).
- Frontmatter:
  ```
  ---
  title: "<Design ... / descriptive title>"
  sidebar_position: <given integer>
  ---
  ```
- Two hand-authored SVG diagrams in the exemplar's visual style (plain SVG,
  `viewBox`, white `<rect>` bg, colored rounded-rect nodes `#1d4ed8`/`#0f766e`/`#b45309`/
  `#6d28d9`/`#be123c`, `<text>` labels, `<line>`/`<path>` with arrow `<marker>`s):
  - `static/img/case-studies/fintech/<slug>-overview.svg` (high-level design, ~820×400)
  - `static/img/case-studies/fintech/<slug>-scaled.svg` (scaled architecture)
  referenced as `/img/case-studies/fintech/<slug>-overview.svg` etc. Give each SVG a
  UNIQUE id prefix on its `<marker>`/`<defs>` ids (e.g. `upiArrowBlue`) so multiple
  diagrams on one page don't collide.

## Document structure (follow the exemplar section-for-section)

1. Frontmatter, then a 1-paragraph **intro** naming the system's *defining property /
   hardest constraint* (for payments: exactly-once money movement; for HFT: nanosecond
   latency; for settlement: finality & reconciliation).
2. `## Step 1: Outline use cases and constraints` → `### Use cases` →
   `#### We'll scope the problem to handle the following use cases` (bullets) →
   `#### Out of scope` → `### Constraints and assumptions` → `#### State assumptions` →
   `#### Calculate usage` (real back-of-envelope numbers: volumes, throughput, latency
   budgets, storage — use realistic fintech figures, e.g. UPI does ~500M txns/day).
3. `## Step 2: Create a high-level design` — embed the `-overview.svg`, then prose
   walking the end-to-end flow with the REAL participants (e.g. UPI: payer PSP app →
   NPCI switch → payee PSP → remitter/beneficiary banks; cards: merchant → acquirer →
   network → issuer).
4. `## Step 3: Design core components` — several `### Use case: ...` subsections. EACH:
   - `**Core spec:**` a fenced code block — real **Python** and/or **SQL** and/or a
     wire-format/state-machine/API-contract, correct and self-consistent (every function
     you call is defined). Prefer showing the ACTUAL domain artifact (an ISO 8583 message
     layout, a double-entry ledger schema, a UPI collect/pay request, a FIX order, an
     idempotency protocol, an HSM/tokenization flow).
   - `**Data structures:**` the durable schema/state each maintains.
   - `**Trade-offs:**` bullets, led by a bold **The gotcha:** naming the subtle failure
     mode and its real fix.
   - `**REST API:**` a `curl` example where an API boundary exists.
5. `## Step 4: Scale the design` — embed `-scaled.svg`, then bullets, each linking to a
   REAL pattern page (see cross-link rule).
6. `## Additional talking points` — regulatory/risk/reconciliation/failure topics a
   practitioner must know (PCI-DSS scope, fraud/AML, settlement risk, idempotency, etc.).
7. `## Source(s) and further reading` — **the payload for this user**: 6–12 verified,
   high-quality links (primary specs + top engineering blogs + relevant internal pattern
   pages). Every external link must return HTTP 200 (`curl -s -o /dev/null -w "%{http_code}"
   -L -A Mozilla/5.0 <url>`); drop non-200. Never invent a URL.

## Cross-linking to patterns (internal links)

Link to relevant existing pattern pages as `/docs/patterns/<group>/<name>` — but ONLY
if the file `course/patterns/<group>/<name>.md` actually exists (the site throws on broken
links). Groups available: caching, consistency, storage, reliability, scaling, api-edge,
communication, batch-streaming, building-blocks, observability, integration. Verify with
`ls course/patterns/<group>/` before linking. Good fits: reliability/idempotency,
consistency/saga, consistency/two-phase-commit, storage/sharding,
storage/primary-replica-replication, reliability/circuit-breaker, reliability/retry-with-backoff,
messaging/queues. If unsure a page exists, DON'T link it.

## Hard rules (build-breaking or quality-critical)

- Original prose only — the video/research inform you; never copy sentences. Every domain
  claim must be verifiable and correct (this reader will catch fintech errors).
- No `{#heading-id}` anchors; no bare `{`/`}`/`<`/`>` in prose or image alt-text
  (use words or `≤`/`≥`); balanced code fences; no literal `|` inside `$…$` in table cells.
- Internal `/docs/...` links must resolve to real pages (build throws otherwise).
- Python/SQL must be correct and self-consistent.

## Verification before finishing

1. Confirm both SVGs exist under `static/img/case-studies/fintech/` and are referenced.
2. Confirm every external link is 200 and every internal `/docs/...` link points to a real file.
3. Report: doc path, the two SVG paths, the use-case sections, the verified sources, and
   any domain claim you could not fully verify.
