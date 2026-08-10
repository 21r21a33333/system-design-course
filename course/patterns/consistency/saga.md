---
title: "Saga"
sidebar_position: 2
supplementary: true
---

A saga is a sequence of local transactions, each scoped to a single
service, where every step has a matching compensating action that
undoes it — used to keep a multi-step workflow consistent across
services without a single distributed transaction.

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

## How it works

Each step in the saga is a normal local transaction against a single
service's own database, immediately committed — no cross-service locks
are held. Alongside every step, the design defines a compensating
transaction that semantically reverses it (e.g. "release the reserved
inventory" undoes "reserve inventory"; a full monetary refund undoes a
charge). If a step fails, the saga runs the compensating actions for
every step that already succeeded, in reverse order, bringing the
system back to a consistent state — not necessarily the exact original
state, since compensations are business-level undo actions, not a
storage-level rollback.

There are two ways to sequence the steps. In **choreography**, there's
no central coordinator: each service publishes an event when it
finishes its step, and the next service in the workflow subscribes to
that event and reacts by performing its own step (and, on failure,
publishing a failure event that upstream services listen for to trigger
their own compensations). In **orchestration**, a central orchestrator
component explicitly calls each service in sequence, tracks the
saga's state, and — on failure — calls the compensating action on each
already-completed step itself. Choreography avoids a single point of
failure and extra infrastructure but becomes hard to follow as the
number of steps grows, since the workflow logic is implicit and spread
across every participant; orchestration keeps the workflow logic in one
place and easy to reason about, at the cost of that orchestrator being
a new component every step now depends on.

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

## Real-world example

A typical order-checkout saga: reserve inventory for the ordered items,
then charge the customer's payment method, then create the shipment.
If the payment charge fails after inventory was already reserved, the
saga runs the compensating action for that step — releasing the
reserved inventory — so the items become available to other customers
again instead of being held indefinitely against an order that never
completed; if inventory reservation itself fails, the saga simply stops
before any payment is attempted, since no compensating action is
needed for a step that never ran.

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
