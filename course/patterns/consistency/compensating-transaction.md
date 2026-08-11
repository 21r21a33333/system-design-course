---
title: "Compensating Transaction"
sidebar_position: 6
supplementary: true
---

A compensating transaction is an operation that semantically undoes
the effect of a previously completed step by applying its logical
inverse, used when a true rollback isn't possible because the original
step has already committed and other work may depend on it.

![Compensating Transaction diagram](/img/patterns/compensating-transaction.svg)

## Problem it solves

A single-database transaction can always be rolled back cleanly:
nothing outside the transaction ever observed the uncommitted change,
so undoing it means the change simply never existed. Once a step has
already committed — because it's one of several independent steps in a
multi-step process, each against its own service or database — that
option disappears. The step's effects are real, durable, and possibly
already visible to (or acted on by) other parts of the system. If a
later step in the same process then fails, there's no database-level
"undo" available for the step that already succeeded. A compensating
transaction is how that step gets undone anyway: not by erasing that it
happened, but by performing a second operation, defined ahead of time,
whose effect cancels out the first one's consequences.

## How it works

For each action that might need to be undone after the fact, the
design defines a corresponding compensating action — chosen for its
effect, not by mechanically reversing the original operation. "Reserve
10 units of inventory" is compensated by "release 10 units of
inventory"; "charge $50 to a card" is compensated by "refund $50 to
that card." The compensating action runs as its own transaction,
independent of the original one, and is triggered explicitly whenever
the process decides the original step needs to be undone. Crucially,
this is a **semantic inverse**, not a literal rollback: a rollback
restores the exact prior state as if nothing had ever happened, while
a compensating transaction records a new, additional operation whose
net effect approximates that outcome from the point of view that
matters (the inventory count, the account balance). The two can differ
in ways that are usually acceptable but occasionally aren't — a refund
leaves a debit-then-credit pair in a transaction history rather than no
record at all, and some actions have no meaningful inverse at all: an
email that already landed in someone's inbox can't be un-sent, only
followed up with a correction. Where compensation genuinely cannot
restore the desired state, the pattern's honest limit is reached, and
the design has to fall back to detection and mitigation rather than
true undo.

Compensating transactions apply to any single step in a larger process
that needs an explicit undo path — a single "cancel this
already-provisioned resource" action is a compensating transaction on
its own, with no larger workflow required around it. They become
especially important, though, when a whole sequence of steps needs a
coordinated undo, which is exactly the situation
[Saga](/docs/patterns/consistency/saga) formalizes: a saga is a
sequence of local transactions where every step has one of these
compensating actions attached, run in reverse order if a later step
fails.

> **Relationship to `saga.md`.** [Saga](/docs/patterns/consistency/saga)
> uses compensating transactions as its undo mechanism for a
> multi-step workflow — when a step fails, the saga runs every
> already-completed step's compensating action, in reverse order. This
> page covers the compensating-transaction pattern itself: what makes
> an action a valid compensation, and why it's a semantic inverse
> rather than a literal one. That applies equally to a single isolated
> step that needs an undo path outside of any full saga workflow — for
> example, cancelling one provisioned cloud resource when a later,
> unrelated setup step fails, with no multi-step saga involved at all.

## Code example

The snippet below models registering a compensating action alongside a
forward action and running the compensation on demand — independent of
any larger saga machinery.

```rust
struct CompensatableStep {
    name: String,
    // The forward action's effect, already applied and committed.
    forward: fn() -> Result<(), String>,
    // The semantic inverse — not a rollback, a separate operation.
    compensate: fn() -> Result<(), String>,
}

impl CompensatableStep {
    fn run(&self) -> Result<(), String> {
        (self.forward)()?;
        println!("{}: committed", self.name);
        Ok(())
    }

    // Called explicitly, any time after `run` has committed, to
    // semantically undo this step's effect.
    fn undo(&self) -> Result<(), String> {
        (self.compensate)()?;
        println!("{}: compensated", self.name);
        Ok(())
    }
}

fn reserve_inventory() -> Result<(), String> {
    Ok(()) // decrement stock count
}

fn release_inventory() -> Result<(), String> {
    Ok(()) // increment stock count back — not "as if never reserved"
}

fn build_reservation_step() -> CompensatableStep {
    CompensatableStep {
        name: "reserve-inventory".into(),
        forward: reserve_inventory,
        compensate: release_inventory,
    }
}
```

`build_reservation_step().run()` commits the reservation immediately;
calling `.undo()` on that same step later — whenever the surrounding
process decides it needs to — runs `release_inventory` as its own
independent transaction, rather than reverting any prior transaction
log.

## When to use it

- A step's effect has already committed and is potentially visible to
  or depended on by other parts of the system, so a storage-level
  rollback isn't available.
- The action has a well-defined, meaningful business-level inverse —
  releasing a hold, cancelling a booking, issuing a refund — that
  restores the property that actually matters (an available count, a
  balance) even if not the exact byte-for-byte prior state.
- The step is part of a longer process (with or without a full saga)
  where failure of a later step should trigger undoing this one.

## When not to use it

- The action has no meaningful inverse at all — an irreversible
  physical side effect, or a notification that's already been
  delivered — in which case compensation can only mitigate or notify
  after the fact, not truly undo.
- True atomicity is required, where intermediate, partially-applied
  states must never be observable by anything else — compensation
  always leaves a window where the original effect was visible before
  the compensating action ran; [Two-Phase Commit](/docs/patterns/consistency/two-phase-commit)
  or an equivalent atomic-commit protocol is the right tool when that
  visibility is unacceptable.
- The step hasn't committed anything yet — an in-flight, uncommitted
  local transaction should simply be aborted or rolled back normally;
  compensation is specifically for undoing what's already durable.

## Real-world example

A travel-booking flow that reserves a flight seat and then fails to
reserve a hotel room doesn't try to reach back into the airline's
database and pretend the seat reservation never happened — it calls the
airline's cancellation operation, which is a distinct, independent
transaction that releases the seat. The booking history still shows a
reservation followed by a cancellation, which is the honest record of
what actually occurred, rather than the reservation having been
silently erased.

## Related patterns

- [Saga](/docs/patterns/consistency/saga) — the pattern that chains a
  sequence of compensating transactions together, one per step, to undo
  a multi-step workflow when a later step fails.
- [Two-Phase Commit](/docs/patterns/consistency/two-phase-commit) — the
  alternative to reach for when the requirement is true atomicity with
  no visible intermediate state, rather than an after-the-fact semantic
  undo.

## Further reading

- [Saga design pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/saga)
- [Compensating transaction — Wikipedia](https://en.wikipedia.org/wiki/Compensating_transaction)
