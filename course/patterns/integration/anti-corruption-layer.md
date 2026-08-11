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

## How it works

All calls between the modern application and the legacy system pass
through the ACL. On the way in, the ACL takes the legacy system's raw
response — its field names, its status codes, its nulls-mean-something
conventions — and converts it into a clean type that matches the
modern domain model. On the way out, it does the reverse: it takes a
call expressed in modern domain terms and translates it into whatever
shape and protocol the legacy system expects. Neither side needs to
know about the other's internal representation; the ACL is the only
piece of code that understands both.

## Code example

The snippet below shows the translation half of an ACL: converting a
messy legacy record into a clean domain type the rest of the
application can rely on.

```rust
// What the legacy system actually returns.
struct LegacyCustomerRecord {
    cust_nm: String,      // "LAST, FIRST" — legacy naming convention
    stat_cd: i32,         // 1 = active, 2 = suspended, anything else = unknown
    bal_cents: i64,
}

// The clean type the modern domain works with.
#[derive(Debug, PartialEq)]
enum CustomerStatus {
    Active,
    Suspended,
    Unknown,
}

#[derive(Debug)]
struct Customer {
    first_name: String,
    last_name: String,
    status: CustomerStatus,
    balance_dollars: f64,
}

fn translate(record: LegacyCustomerRecord) -> Customer {
    let (last, first) = record
        .cust_nm
        .split_once(", ")
        .unwrap_or((&record.cust_nm, ""));

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
```

The rest of the application only ever sees `Customer` and
`CustomerStatus` — it never has to know that the legacy system encodes
names as `"LAST, FIRST"` or statuses as integer codes.

## When to use it

- Integrating with a legacy system or third-party API whose data model
  doesn't map cleanly onto the domain model you want the new
  application to have.
- Migrating incrementally (see Strangler Fig below) and you need a
  stable boundary so the new code doesn't get rewritten every time the
  legacy system's quirks are discovered.
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

## Real-world example

Organizations migrating off a mainframe or an old monolith commonly
build an ACL as part of that migration: new microservices talk to the
mainframe only through a translation service that converts fixed-width
COBOL-era records into JSON types the new services understand, so the
mainframe's record layout never appears in any new service's code.

## Related patterns

- [Strangler Fig](/docs/patterns/integration/strangler-fig) — the two patterns are frequently
  used together: the strangler fig facade routes traffic to old or new
  code, while the ACL keeps the new code's domain model clean when it
  still has to call the old system.

## Further reading

- [Anti-Corruption Layer pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/anti-corruption-layer)
- [Legacy Mimic — martinfowler.com](https://martinfowler.com/articles/patterns-legacy-displacement/legacy-mimic.html) (discusses the Anti-Corruption Layer pattern from Eric Evans's *Domain-Driven Design*)
