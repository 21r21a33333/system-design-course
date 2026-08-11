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

## Technical architecture & implementation

**Semantic inverse, not rollback.** For each action that might need to
be undone after the fact, the design defines a corresponding
compensating action — chosen for its effect, not by mechanically
reversing the original operation. "Reserve 10 units of inventory" is
compensated by "release 10 units of inventory"; "charge $50 to a card"
is compensated by "refund $50 to that card." The compensating action
runs as its own transaction, independent of the original one, and is
triggered explicitly whenever the process decides the original step
needs to be undone. Crucially, this is a **semantic inverse**, not a
literal rollback: a rollback restores the exact prior state as if
nothing had ever happened, while a compensating transaction records a
new, additional operation whose net effect approximates that outcome
from the point of view that matters (the inventory count, the account
balance). The two can differ in ways that are usually acceptable but
occasionally aren't — a refund leaves a debit-then-credit pair in a
transaction history rather than no record at all.

**Backward recovery of only the completed steps.** When compensation is
used to undo a multi-step process, the discipline is precise: run the
compensating action for every step that **actually completed**, and run
them in **reverse order** of completion. The step whose failure
triggered the undo is *not* compensated — its effect never committed —
and steps after it never ran, so they're never compensated either.
Reverse order matters because later steps often depend on earlier ones:
you refund the charge before releasing the inventory the charge was
against, not the other way round. This "compensate completed steps
newest-first" behavior is the core of the
[Saga](/docs/patterns/consistency/saga) undo path, and the code example
below implements exactly that ordering. This backward recovery is one of
two responses to failure; the alternative, **forward recovery**, is
covered in the next section.

**Compensations must be idempotent and retryable.** A compensating
transaction is a network call to another service, and it can fail just
as the forward action can — a refund times out, a release-inventory call
404s because the record moved. The undo path therefore needs its own
retry and error handling (see
[Retry With Backoff](/docs/patterns/reliability/retry-with-backoff)),
which in turn means each compensation must be **idempotent**: running it
twice — once before a timeout was observed, once on retry — must leave
the same end state as running it once (see
[Idempotency](/docs/patterns/reliability/idempotency)). It also helps for
compensations to be robust to arriving in an unexpected order or against
partially-applied state, since the exact moment of failure is not always
knowable. A compensation that repeatedly fails is the pattern's worst
case — it leaves the system in exactly the inconsistent state the pattern
exists to prevent — so exhausted retries should surface the step for
manual intervention or a
[dead-letter queue](/docs/patterns/reliability/dead-letter-queue) rather
than being silently dropped.

**Lack of isolation is inherent.** Because the forward step committed
before the compensation runs, there is always a window in which the
original effect was *visible* to other processes — inventory looked
reserved, a balance looked debited — before it was undone. Compensation
cannot close that window; it is an after-the-fact correction, not an
atomic hide-and-reveal. Where that intermediate visibility is
unacceptable, an atomic-commit protocol like
[Two-Phase Commit](/docs/patterns/consistency/two-phase-commit) is the
right tool instead.

**Scope: one step or a whole saga.** Compensating transactions apply to
any single step in a larger process that needs an explicit undo path — a
single "cancel this already-provisioned resource" action is a
compensating transaction on its own, with no larger workflow required
around it. They become especially important, though, when a whole
sequence of steps needs a coordinated undo, which is exactly the
situation [Saga](/docs/patterns/consistency/saga) formalizes: a saga is a
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

## When you can't compensate: forward recovery and pivots

Some actions have no meaningful inverse. An email that already landed in
someone's inbox can't be un-sent, only followed up with a correction; a
physical shipment that already left the warehouse can't be un-shipped; an
SMS one-time code is already on its way. When a step like this sits in a
process that might need to abort, backward recovery is off the table, and
the design has to choose a different response.

**Forward recovery (retry-forward).** Instead of undoing completed work,
the process keeps trying to *complete* the remaining steps until it
succeeds — treating the transaction as one that must ultimately go
forward, not back. This is the right posture when the later steps are
retryable and completing them is more valuable (or more correct) than
unwinding everything already done. It leans hard on
[Retry With Backoff](/docs/patterns/reliability/retry-with-backoff) and
[Idempotency](/docs/patterns/reliability/idempotency): a step retried
forward many times must be safe to attempt repeatedly.

**Pivot steps.** A common structure places the hard-to-compensate action
carefully in the sequence relative to a **pivot** — the step after which
the process is committed to going forward. Steps *before* the pivot are
all compensatable (backward recovery is possible if something fails
early); the pivot is the point of no return; steps *after* it are
retryable-forward, not undoable. Ordering a saga so the irreversible
"send the shipment" step comes after a pivot means a failure before the
pivot cleanly unwinds, while a failure after it retries forward to
completion rather than attempting an impossible undo.

**Accept and mitigate.** Where neither undo nor retry-forward fully
resolves the situation, the honest fallback is detection and
mitigation — flag the inconsistency, notify a human or a downstream
correction process, issue a goodwill credit — rather than pretending the
step was reversed. Identifying which steps fall into this category *ahead
of time* is part of designing the process; discovering an
un-compensatable step during a live failure is how a partial,
inconsistent state gets stranded.

## Code example

The snippet below is a small executor that runs steps forward and, on
the first failure, performs **backward recovery**: it compensates every
step that actually completed, newest-first, and never touches the failed
step or the steps that never ran. Each compensation is retried a bounded
number of times, which is only safe because compensations are
idempotent — the two invariants this pattern lives on.

```rust
// A step pairs a forward action with its compensation. The compensation is a
// SEMANTIC inverse — a separate operation chosen for its business effect
// ("release the hold"), not a storage-level rollback of the forward action.
struct Step {
    name: &'static str,
    forward: fn() -> Result<(), String>,
    // A compensation can itself fail and will be retried, so it must be
    // idempotent — running it twice leaves the same end state as once.
    compensate: fn() -> Result<(), String>,
}

// Records what actually ran so compensation touches ONLY completed steps.
struct Executor {
    completed: Vec<&'static str>,
    // Ordered log of compensations actually performed — used to confirm
    // reverse order and only-completed-steps.
    compensated: Vec<&'static str>,
}

impl Executor {
    fn new() -> Self {
        Executor { completed: Vec::new(), compensated: Vec::new() }
    }

    // Runs steps in order. On the first forward failure, it stops and
    // compensates every already-completed step in REVERSE order — the step
    // that failed is never compensated (its effect never committed), and
    // steps after it never ran, so they're never compensated either.
    fn run(&mut self, steps: &[Step]) -> Result<(), String> {
        for step in steps {
            match (step.forward)() {
                Ok(()) => self.completed.push(step.name),
                Err(e) => {
                    self.unwind(steps);
                    return Err(format!("aborted at {}: {e}", step.name));
                }
            }
        }
        Ok(())
    }

    // Backward recovery: walk completed steps newest-first and run each
    // compensation. A compensation that fails is retried a bounded number of
    // times (it's idempotent, so a retry is safe); exhausting retries surfaces
    // the step as stuck rather than silently leaving it un-compensated.
    fn unwind(&mut self, steps: &[Step]) {
        for name in self.completed.iter().rev() {
            let step = steps.iter().find(|s| s.name == *name).unwrap();
            let mut attempts = 0;
            loop {
                attempts += 1;
                match (step.compensate)() {
                    Ok(()) => {
                        self.compensated.push(step.name);
                        break;
                    }
                    Err(_) if attempts < 3 => continue,
                    Err(_) => break, // exhausted: would be dead-lettered
                }
            }
        }
    }
}

fn ok() -> Result<(), String> { Ok(()) }
fn declined() -> Result<(), String> { Err("card_declined".into()) }
```

Running `[reserve(ok), charge(ok), ship(declined)]` commits the
reservation and the charge, then fails on the shipment. The executor
compensates only the two completed steps, newest-first — refunding the
`charge` before releasing the `reserve` — and never compensates `ship`,
because its forward effect never committed. That "reverse order, only
completed steps" behavior, with idempotent retries on each compensation,
is the exact guarantee a saga's undo path provides.

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

## Use-case scenarios

**Travel booking across independent providers.** A trip-booking flow
reserves a flight seat and then fails to reserve a hotel room. It doesn't
try to reach back into the airline's database and pretend the seat
reservation never happened — it calls the airline's *cancellation*
operation, a distinct, independent transaction that releases the seat.
The booking history still shows a reservation followed by a cancellation,
the honest record of what actually occurred, rather than the reservation
having been silently erased. If the cancellation call itself times out,
it's retried; because "cancel reservation R" is idempotent, a duplicate
cancel is harmless.

**Cloud resource provisioning.** Standing up a new environment
provisions a network, then a database, then a compute cluster, each via a
separate API. If the compute-cluster step fails, the process compensates
in reverse: delete the database it just created, then tear down the
network — newest-first, because the database lived inside the network. No
larger saga framework is required; each provisioning call simply has a
paired "delete" compensation, and the un-provisioning walks the completed
steps backward.

**Payment with a hard-to-compensate notification.** A checkout charges a
card, then emails a receipt, then attempts to schedule delivery. If
delivery scheduling fails, the charge is compensated with a refund — but
the already-sent receipt email can't be un-sent. This is the pattern's
honest limit: the design places the email *after a pivot* or accepts that
its compensation is a follow-up "your order was cancelled" email rather
than a true undo. The refund is a clean backward recovery; the email is a
forward-recovery/mitigation case, and recognizing that split up front is
what keeps the failure handling correct.

## Related patterns

- [Saga](/docs/patterns/consistency/saga) — the pattern that chains a
  sequence of compensating transactions together, one per step, to undo
  a multi-step workflow when a later step fails.
- [Choreography](/docs/patterns/consistency/choreography) — one way a
  saga triggers compensations: a failure event that upstream services
  react to by running their own compensating action, with no coordinator.
- [Two-Phase Commit](/docs/patterns/consistency/two-phase-commit) — the
  alternative to reach for when the requirement is true atomicity with
  no visible intermediate state, rather than an after-the-fact semantic
  undo.
- [Idempotency](/docs/patterns/reliability/idempotency) — the property a
  compensation must have so it can be safely retried when the undo call
  itself fails or times out.
- [Retry With Backoff](/docs/patterns/reliability/retry-with-backoff) —
  how a failed compensation (or a forward-recovery step) is re-attempted
  without hammering the downstream service.

## Further reading

- [Saga design pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/saga)
- [Compensating Transaction pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction)
- [Compensating transaction — Wikipedia](https://en.wikipedia.org/wiki/Compensating_transaction)
