---
title: "Anti-Corruption Layer"
sidebar_position: 2
supplementary: true
---

An Anti-Corruption Layer (ACL) is a translation layer placed between a
modern application and a legacy or external system whose data model
and semantics don't match the modern codebase, so the legacy system's
quirks never leak into — and "corrupt" — the modern domain model.

![Anti-Corruption Layer diagram](/img/patterns/anti-corruption-layer.svg)

## Problem it solves

Legacy systems and third-party APIs are often built around data
models, naming conventions, and business rules from a different era of
the product — flat tables instead of aggregates, status codes with
implicit meaning, fields that were repurposed over the years. If a
modern application calls that legacy system directly and passes its
raw shapes around internally, those old assumptions spread through the
new codebase: every new feature has to understand the legacy quirks,
and the new domain model slowly bends to match the old one instead of
reflecting what the business actually needs today. An ACL contains
that damage to a single, well-defined boundary.

## Technical architecture & implementation

**The boundary and its direction.** An ACL is placed exactly on the
seam between two [bounded contexts](https://martinfowler.com/bliki/BoundedContext.html):
the modern one being protected and the legacy or external one whose
model it must not adopt. Every call that crosses that seam passes
through the ACL, and the ACL translates in *both* directions.
**Inbound** (legacy → modern), it takes the legacy system's raw
response — its field names, its status codes, its nulls-mean-something
conventions — and produces a clean type that matches the modern domain
model. **Outbound** (modern → legacy), it takes a request expressed in
modern domain terms and renders it in whatever shape and protocol the
legacy system expects. Neither side ever holds a reference to the
other's representation; the ACL is the only code that understands both.

**What the layer is made of.** Internally an ACL is usually a small
collection of collaborating pieces rather than one function: a
**facade** presenting the clean interface the modern code calls, an
**adapter** speaking the legacy protocol (SOAP, fixed-width records,
a proprietary RPC), and one or more **translators** that map data
structures and semantics between the two models. It commonly also owns
concerns that arise precisely because the other system is foreign —
mapping the legacy system's error codes into the domain's own error
types, converting units and encodings, and normalizing the legacy
system's idea of "missing" or "invalid" into explicit modern variants
(an `Unknown` enum case rather than a magic integer). Modeling the
unknown *explicitly* is one of the most valuable things an ACL does:
the legacy quirk stops at the boundary and the domain downstream never
has to special-case it.

**Where to place it.** There are three common placements, with
different trade-offs. Building the ACL *inside the modern service* is
simplest and keeps the translation close to the code that depends on
it, but it means every service that talks to the legacy system carries
its own copy. Standing the ACL up as a *separate shared service* writes
the translation once for many consumers and lets it scale and deploy
independently, at the cost of an extra network hop and another
deployable to operate. Placing it as a *sidecar or adapter component
alongside* the legacy system suits cases where you can't touch the
legacy system but can co-locate a translator with it. The right choice
turns mostly on how many modern services need the same translation.

**The maintenance cost.** An ACL is deliberately *extra* code that
exists only to absorb a mismatch, and that has an ongoing price: every
time the legacy system changes a field or the domain model evolves, the
translation has to be updated, and a subtle mistranslation can be worse
than no ACL at all because it silently produces plausible-but-wrong
domain objects. This cost is the pattern's central trade-off — it is
justified when the mismatch is real and the protection is worth
maintaining, and it is pure overhead when the two models already align.
An ACL is also frequently *temporary*: during a
[strangler-fig](/docs/patterns/integration/strangler-fig) migration it
protects the new system while the legacy one is being retired, and it
can be deleted once the legacy system is gone.

**Failure modes.** Beyond mistranslation, the recurring failure is the
**leaky ACL** — the translation is incomplete, so a legacy-shaped field
(a raw status code, a `"LAST, FIRST"` name string) slips through into
the domain model, and the corruption the layer was built to prevent
happens anyway, now disguised as if it were clean. A related trap is
the ACL that *grows business logic*: because it sits at a convenient
choke point, teams are tempted to add domain rules to it, until the
translation layer quietly becomes a second, hidden domain model that
must itself be kept consistent with the real one. Performance is the
third: an ACL adds a translation step (and often a network hop) to
every cross-boundary call, which is usually negligible but occasionally
matters on a hot path.

**ACL vs. a plain adapter or gateway.** A generic
[adapter](/docs/patterns/api-edge/reverse-proxy) or protocol gateway
makes two systems able to *talk* — it reconciles transport and
serialization so bytes flow. An ACL does that too but goes further: its
purpose is *semantic isolation*, deliberately refusing to let the other
system's **domain model** cross the boundary even when it technically
could. A plain adapter is happy to hand the legacy DTO straight through
once the wire format is sorted; an ACL exists precisely to stop that,
producing a distinct clean type instead. The distinction is intent — an
adapter connects, an ACL *protects a model*.

## What the translation layer isolates

An ACL earns its keep by absorbing specific kinds of mismatch so the
modern domain never has to. The common ones:

| Legacy / external side | Modern domain side (what the ACL produces) |
| --- | --- |
| Cryptic field names (`cust_nm`, `stat_cd`) | Meaningful domain names (`first_name`, `status`) |
| Magic status integers, sentinel values | Explicit enums, including an `Unknown` variant |
| Nulls or blanks that "mean something" | Modeled optionality / explicit domain states |
| Cents-as-integer, packed dates, units | Domain value types (money, dates) in domain units |
| Composite strings (`"LAST, FIRST"`) | Structured fields (`last_name`, `first_name`) |
| Legacy error/return codes | Domain error types the caller can match on |
| Legacy protocol (SOAP, fixed-width, RPC) | The modern service's native call interface |

Everything in the left column stops at the boundary. Nothing in it
should ever appear in a type the domain code handles — that is exactly
the invariant the code example below enforces.

## Code example

The snippet below shows both halves of an ACL: `to_domain` converts a
messy legacy record into a clean domain type, and `to_legacy` converts
back for outbound calls. The domain `Customer` shares no field name,
type, or convention with `LegacyCustomerRecord` — that separation is
the point, and the round-trip proves the layer owns both directions.

```rust
/// What the legacy system actually returns: cryptic field names, an
/// integer status code, cents as an integer, "LAST, FIRST" name order.
struct LegacyCustomerRecord {
    cust_nm: String,
    stat_cd: i32,
    bal_cents: i64,
}

/// The clean domain model. Note it shares *no* field name, type, or
/// convention with the legacy record — that separation is the whole point.
#[derive(Debug, Clone, PartialEq)]
enum CustomerStatus {
    Active,
    Suspended,
    Unknown,
}

#[derive(Debug, Clone, PartialEq)]
struct Customer {
    first_name: String,
    last_name: String,
    status: CustomerStatus,
    balance_dollars: f64,
}

/// Inbound translation: legacy record -> clean domain type.
fn to_domain(record: LegacyCustomerRecord) -> Customer {
    let (last, first) = record
        .cust_nm
        .split_once(", ")
        .unwrap_or((record.cust_nm.as_str(), ""));

    let status = match record.stat_cd {
        1 => CustomerStatus::Active,
        2 => CustomerStatus::Suspended,
        _ => CustomerStatus::Unknown,
    };

    Customer {
        first_name: first.to_string(),
        last_name: last.to_string(),
        status,
        balance_dollars: record.bal_cents as f64 / 100.0,
    }
}

/// Outbound translation: domain type -> the shape the legacy system
/// expects. The ACL owns both directions so neither side learns the
/// other's model.
fn to_legacy(customer: &Customer) -> LegacyCustomerRecord {
    let stat_cd = match customer.status {
        CustomerStatus::Active => 1,
        CustomerStatus::Suspended => 2,
        CustomerStatus::Unknown => 0,
    };
    LegacyCustomerRecord {
        cust_nm: format!("{}, {}", customer.last_name, customer.first_name),
        stat_cd,
        bal_cents: (customer.balance_dollars * 100.0).round() as i64,
    }
}
```

The rest of the application only ever sees `Customer` and
`CustomerStatus`. A legacy `stat_cd` of `99` becomes the explicit
`CustomerStatus::Unknown` rather than leaking an unhandled integer, and
translating a `Customer` back out reproduces the legacy encoding
(`"DOE, JANE"`, `stat_cd` `2`, `bal_cents` `12345`) — so the legacy
system's `"LAST, FIRST"` names and integer codes never appear anywhere
in the modern domain.

## When to use it

- Integrating with a legacy system or third-party API whose data model
  doesn't map cleanly onto the domain model you want the new
  application to have.
- Migrating incrementally (see Strangler Fig) and you need a stable
  boundary so the new code doesn't get rewritten every time the legacy
  system's quirks are discovered.
- Multiple new services need to talk to the same legacy system and you
  want the translation logic written once, not duplicated.

## When not to use it

- The legacy or external system's data model already matches the
  modern domain reasonably well — a translation layer adds indirection
  for no real benefit.
- A one-off, throwaway integration where the cost of building and
  maintaining a dedicated layer outweighs the risk of some model
  leakage.
- Performance-critical paths where an extra translation step adds
  latency that the system genuinely cannot absorb.

## Use-case scenarios

**Mainframe integration during a modernization program.** New
microservices need customer and account data that still lives on a
COBOL mainframe returning fixed-width, EBCDIC-encoded records with
packed decimals and status bytes. A shared ACL service is the only
thing that speaks the mainframe's protocol: it parses the fixed-width
layout, decodes the packed fields, maps status bytes to domain enums,
and exposes a clean JSON/gRPC interface. No new service ever sees a
column offset or a packed decimal, and when a mainframe copybook
changes, exactly one place is updated.

**Wrapping a messy third-party payments API.** A commerce platform
integrates a payment provider whose API uses inconsistent field names
across endpoints, encodes amounts as strings in minor units, and
signals errors through a mix of HTTP codes and body fields. An ACL in
the payments service translates these into the platform's own `Money`
value type and a domain `PaymentError` enum, so the checkout code
reasons in clean domain terms. When the provider ships a breaking API
change, the ACL absorbs it and the domain logic is untouched.

**Bridging two merged companies' order models.** After an acquisition,
a company must let its modern order-management system read and write
orders that still live in the acquired company's legacy ERP, whose
notion of an "order" differs substantially (different line-item
structure, different tax handling, different state machine). Rather
than contaminate the modern order aggregate with the ERP's model, an
ACL translates between the two in both directions, and it's slated for
deletion once the ERP orders are fully migrated under a parallel
strangler-fig effort.

## Production libraries & getting started

An ACL is built from ordinary translation building blocks — object-mapping
libraries for the field-by-field conversion, an API gateway for transport
and shape translation at the edge, and DDD frameworks that make the
bounded-context boundary explicit. These are the real tools teams assemble
an ACL from:

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| MapStruct | Java | Compile-time bean mapper for the translators that convert legacy DTOs to clean domain types | [mapstruct.org/documentation](https://mapstruct.org/documentation/stable/reference/html/) |
| AutoMapper | .NET / C# | Convention-based object-to-object mapper for the inbound/outbound translation layer | [docs.automapper.org](https://docs.automapper.org/en/stable/) |
| Kong Gateway | Lua / config | API gateway with request/response transformer plugins that reshape a legacy API's payloads at the boundary | [docs.konghq.com](https://docs.konghq.com/) |
| Amazon API Gateway | Managed (AWS) | Mapping templates and integration transforms that translate an external/legacy contract into the modern service's shape | [docs.aws.amazon.com/apigateway](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-aws-services.html) |
| Axon Framework | Java | DDD/CQRS framework that makes bounded contexts and their anti-corruption boundaries first-class in the code | [docs.axoniq.io/reference-guide](https://docs.axoniq.io/reference-guide/) |
| JHipster | Java (generator) | Scaffolds DDD-style microservices with clean domain models, giving each service a natural place for its ACL | [jhipster.tech](https://www.jhipster.tech/) |

**Example / reference:** [Anti-corruption Layer pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/anti-corruption-layer)

## Related patterns

- [Strangler Fig](/docs/patterns/integration/strangler-fig) — the two
  patterns are frequently used together: the strangler fig facade
  routes traffic to old or new code, while the ACL keeps the new code's
  domain model clean when it still has to call the old system during
  the migration.
- [Sidecar](/docs/patterns/api-edge/sidecar) — one placement option for
  an ACL is a co-located adapter alongside the legacy system, using the
  sidecar mechanism to translate without modifying it.
- [Reverse Proxy](/docs/patterns/api-edge/reverse-proxy) — a plain
  adapter/proxy reconciles *transport*; an ACL goes further and refuses
  to let the other system's *domain model* cross the boundary.
- [Messaging Bridge](/docs/patterns/communication/messaging-bridge) — a
  related translation role for asynchronous messaging: bridging two
  messaging systems, where an ACL-style translation of message shapes
  often lives alongside it.

## Further reading

- [Anti-Corruption Layer pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/anti-corruption-layer)
- [Legacy Mimic — martinfowler.com](https://martinfowler.com/articles/patterns-legacy-displacement/legacy-mimic.html) (discusses the Anti-Corruption Layer pattern from Eric Evans's *Domain-Driven Design*)
- [BoundedContext — martinfowler.com](https://martinfowler.com/bliki/BoundedContext.html) (the DDD concept an ACL protects)
