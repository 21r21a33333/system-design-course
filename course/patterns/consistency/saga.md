---
title: "Saga"
sidebar_position: 2
supplementary: true
---

A saga is a sequence of local transactions, each scoped to a single
service, where every step has a matching compensating action that
undoes it — used to keep a multi-step workflow consistent across
services without a single distributed transaction.

![Saga diagram](/img/patterns/saga.svg)

## Problem it solves

A workflow like checkout — reserve inventory, charge a payment, create a
shipment — usually touches several independently owned services, each
with its own database. [Two-Phase Commit](/docs/patterns/consistency/two-phase-commit)
could wrap all three steps in one atomic transaction, but that requires
a coordinator to hold locks across every participant for the whole
duration of the workflow, which doesn't scale to slow steps (a payment
gateway can take seconds) or to services that shouldn't be tightly
coupled to a shared coordinator. The saga pattern accepts that a
distributed workflow can't be atomic in the ACID sense, and instead
guarantees that if any step fails partway through, the steps that
already succeeded are explicitly undone, so the system never ends up
in a state where inventory was reserved but payment was never taken.

## Technical architecture & implementation

**Steps and compensations.** Each step in a saga is a normal local
transaction against a single service's own database, committed
immediately with no cross-service locks held — this is the structural
difference from [Two-Phase Commit](/docs/patterns/consistency/two-phase-commit),
which holds every participant's locks open for the whole transaction's
duration. Alongside every step, the saga's design defines a
[Compensating Transaction](/docs/patterns/consistency/compensating-transaction):
a separate operation, chosen for its business-level effect rather than
a mechanical reversal, that semantically undoes the step ("release the
reserved inventory" undoes "reserve inventory"; a refund undoes a
charge). If a step fails, the saga runs the compensating action for
every step that already succeeded, in reverse order, which is what
brings the system back to a consistent state — not necessarily the
exact original state, since a compensation is a new operation recorded
alongside the original one, not a storage-level rollback that erases it
ever happened.

**Sequencing: choreography or orchestration.** A saga's steps have to
be sequenced by something, and there are two established ways to do
that, covered in depth on their own pages. In
[Choreography](/docs/patterns/consistency/choreography), there's no
central coordinator: each service publishes an event when it finishes
its step, the next service subscribes to that event and reacts by
performing its own step, and a failure event triggers upstream services
to run their own compensations — the saga's progress emerges from
independent event handlers, with no single component holding the full
sequence. In orchestration, a central orchestrator component explicitly
calls each service in turn, tracks the saga's state, and — on
failure — calls the compensating action on each already-completed step
itself, keeping the workflow logic in one place at the cost of that
orchestrator being a new shared dependency every step now has. This
choice is genuinely orthogonal to what a saga *is*: the steps, their
compensations, and the reverse-order undo behavior on failure are the
same regardless of which sequencing style drives them.

The two styles trade central control against coupling:

| Aspect | Choreography | Orchestration |
| --- | --- | --- |
| Sequencing logic | Distributed across each service's event handlers | Centralized in one orchestrator component |
| Coupling | Services couple to events, not to each other directly | Every step couples to the orchestrator |
| Where the flow lives | Emergent — no single place shows the whole saga | Explicit — the full sequence is in one component |
| Adding or reordering a step | Touches the affected services' subscriptions | Changes the orchestrator's flow definition |
| Single point of failure | None specific to the saga | The orchestrator (must itself be made reliable) |
| Best fit | Few steps, loosely coupled event-driven services | Many steps, complex branching, or auditability needs |

**Failure modes.** The saga's honest limit is a step with **no
meaningful compensating action** — an already-sent notification or an
irreversible physical side effect can't be undone, only mitigated or
flagged after the fact, and a saga design has to identify these steps
ahead of time rather than discovering the gap during an actual failure.
A second failure mode is **compensation failure itself** — the undo
action can fail just as the forward action can (a refund call times
out, a release-inventory call 404s because the record was already
modified by something else), and a saga needs its own retry or
dead-letter handling for compensations, since a failed compensation
leaves the system in exactly the inconsistent state the pattern exists
to prevent. A third, more subtle failure mode is a **lack of
isolation**: because each step commits independently and immediately,
another process can observe an intermediate state partway through the
saga — for example, seeing inventory as reserved before payment has
actually been confirmed — which is a real, visible window a saga does
not close, unlike an atomic-commit protocol that hides intermediate
state entirely until the final decision.

## Code example

```rust
struct SagaStep {
    name: &'static str,
    forward: fn() -> Result<(), String>,
    compensate: fn() -> Result<(), String>,
}

// Runs each step in order; on the first failure, compensates every
// already-succeeded step in reverse order — the core saga guarantee,
// independent of whether a choreography or orchestration sequencer
// is what triggered each step in a real deployment.
fn run_saga(steps: &[SagaStep]) -> Result<(), String> {
    let mut completed: Vec<&SagaStep> = Vec::new();

    for step in steps {
        match (step.forward)() {
            Ok(()) => {
                println!("{}: committed", step.name);
                completed.push(step);
            }
            Err(e) => {
                println!("{}: failed ({e}), compensating", step.name);
                for done in completed.iter().rev() {
                    match (done.compensate)() {
                        Ok(()) => println!("{}: compensated", done.name),
                        Err(ce) => println!("{}: compensation FAILED ({ce})", done.name),
                    }
                }
                return Err(format!("saga aborted at {}: {e}", step.name));
            }
        }
    }
    Ok(())
}

fn reserve_inventory() -> Result<(), String> { Ok(()) }
fn release_inventory() -> Result<(), String> { Ok(()) }
fn charge_payment() -> Result<(), String> { Err("card_declined".into()) }
fn refund_payment() -> Result<(), String> { Ok(()) }
```

Calling `run_saga` on `[reserve_inventory/release_inventory,
charge_payment/refund_payment]` commits the inventory reservation, then
fails on the payment charge, then compensates in reverse order —
running `release_inventory`'s compensation, since it's the only step
that had already committed by the time the failure happened.

## When to use it

- A business workflow spans multiple services, each with its own
  database, and needs to stay consistent without a distributed
  transaction.
- Individual steps may be slow, unreliable, or long-running (a payment
  provider, a third-party shipping API), so holding locks across all of
  them for the workflow's duration is unacceptable.
- The steps have well-defined, meaningful compensating actions —
  releasing a reservation or issuing a refund make sense as explicit
  business operations.

## When not to use it

- A step has no reasonable compensating action (e.g. an email that's
  already been sent, or an irreversible external side effect) — the
  saga can't fully undo such a step, only ever mitigate or notify
  after the fact.
- The workflow genuinely needs strict atomicity and isolation — sagas
  are not isolated, so another process can observe intermediate states
  partway through a saga (e.g. inventory looking reserved before
  payment has actually been confirmed).
- The workflow is simple enough (single service, single database) that
  a normal local transaction already provides all the guarantees
  needed — a saga adds real complexity that isn't justified there.

## Use-case scenarios

**E-commerce checkout across independently owned services.** An
online retailer's checkout spans an inventory service, a payment
service, and a shipping service, each owned by a different team with
its own database. The saga reserves inventory, then charges the
customer's payment method, then creates a shipment; if the payment
charge fails after inventory was already reserved, the saga runs that
step's compensating action — releasing the reserved inventory — so the
items become available to other customers instead of being held
indefinitely against an order that never completed.

**Travel-booking flow spanning third-party providers.** A trip-booking
platform needs to reserve a flight seat with one airline's API and a
hotel room with a separate hotel-chain API as part of the same
booking. Because both are external systems the platform doesn't
control and can't lock across, a saga reserves the flight, then
attempts the hotel booking; if the hotel booking fails, the saga calls
the airline's own cancellation endpoint as the flight step's
compensation — a distinct, independent call the airline exposes for
exactly this purpose, not a rollback into the airline's own database.

**Multi-region account provisioning at a SaaS platform.** Provisioning
a new enterprise customer account touches a billing service, an
identity/access-management service, and a regional data-storage
allocation service, each of which may be deployed in a different
region with its own database. A saga runs each provisioning step as
its own local transaction; if regional storage allocation fails after
billing and identity setup already succeeded, the saga compensates by
deleting the identity records and voiding the billing setup, in reverse
order, rather than leaving a half-provisioned account that bills the
customer for infrastructure they can't actually use yet.

## Related patterns

- [Two-Phase Commit](/docs/patterns/consistency/two-phase-commit) — the
  strict-atomicity alternative a saga is usually chosen instead of, for
  workflows that are long-running or span independently owned services.
- [Event-Driven Architecture](/docs/patterns/communication/event-driven-architecture) —
  the usual transport for choreographed sagas, where each step reacts
  to the previous step's event.

## Further reading

- [Saga design pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/saga)
- [Long-running transaction and compensation — Wikipedia](https://en.wikipedia.org/wiki/Long-running_transaction)
- [Sagas — Hector Garcia-Molina & Kenneth Salem (SIGMOD 1987)](https://www.cs.cornell.edu/andru/cs711/2002fa/reading/sagas.pdf) — the original paper that introduced the saga concept and its compensating-transaction model.
