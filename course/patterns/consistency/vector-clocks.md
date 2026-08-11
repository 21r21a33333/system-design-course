---
title: "Vector Clocks"
sidebar_position: 4
supplementary: true
---

A vector clock is a per-node counter vector — one counter per
participating node — attached to each update, used to determine the
causal order of events across a distributed system and to detect when
two updates happened concurrently, without relying on synchronized
wall-clock time.

![Vector Clocks diagram](/img/patterns/vector-clocks.svg)

## Problem it solves

In a distributed system, physical clocks on different machines are
never perfectly synchronized, so timestamping updates with wall-clock
time and comparing them to decide which is "newer" is unreliable —
clock drift or skew can make an update that actually happened later
appear to have an earlier timestamp. This matters a lot in systems that
allow writes to be accepted by multiple replicas (for availability),
because when those replicas' updates are later compared — say, during
a quorum read — the system needs a reliable way to tell whether one
update causally followed from (and should supersede) another, or
whether the two updates happened independently and now genuinely
conflict and need to be reconciled.

## Technical architecture & implementation

**Vector structure and updates.** Every node maintains a vector of
counters, one entry per node known to the system (e.g. `{A: 2, B: 1, C:
0}`). Two operations mutate it: producing a new local event increments
that node's own entry and attaches the resulting vector to the update
(`A` writing produces `{A: 3, B: 1, C: 0}`); receiving an update from
another node merges the incoming vector into the local one by taking
the entry-wise maximum across both, then increments the receiving
node's own entry once more. The increment-on-receive step matters:
without it, simply merging (taking the max of each entry) without
also recording "I have now observed this and produced my own
subsequent state" would make it impossible to distinguish "I've seen
this exact update" from "I've produced something new after seeing it."

**Comparing two vectors.** The comparison rule that recovers causal
order is: vector X happened-before vector Y if every entry in X is
less than or equal to the corresponding entry in Y, and at least one
entry is strictly less. In that case Y causally descends from X — it
was produced with knowledge of X's state, directly or transitively —
and safely supersedes it; a system can discard X and keep only Y with
no data loss, because whatever X represented is already incorporated
into Y's causal history. If neither vector is less-than-or-equal to the
other — each has at least one entry strictly greater than the other's
corresponding entry — the two updates are **concurrent**: each was
produced with no knowledge of the other, by definition, since neither
node had observed the other's increment before producing its own. This
is a fundamentally different situation from one update simply being
older; concurrency means a real conflict exists, and no amount of
additional information recovers which update is "right," because
neither one is wrong — they just didn't know about each other.

**What happens with a genuine conflict.** Vector clocks detect
concurrency; they don't resolve it. Once two updates are identified as
concurrent, the system has to fall back to something else: returning
both versions to the caller and letting application logic (or, as in
Amazon's original Dynamo design, the end user) merge them, applying a
domain-specific merge function (union-ing two concurrently modified
shopping carts, for instance), or picking a deterministic tiebreaker as
a last resort if the application genuinely doesn't care which one wins.
The key property vector clocks provide is that this fallback path is
only taken when a conflict is real — updates that have a genuine causal
order are still correctly and automatically resolved without ever
reaching the conflict-handling path at all.

**Vector clocks vs. Lamport clocks vs. version vectors.** These three
are frequently confused because they all timestamp events with logical
counters, but they answer different questions. A **Lamport clock** is a
single scalar counter per node: it guarantees that if event A causally
happened-before event B then A's timestamp is less than B's, which is
enough to build a total order but *cannot detect concurrency* — two
concurrent events can still get different scalar timestamps, so a
smaller Lamport timestamp does not imply a causal relationship. A
**vector clock** carries one counter *per node* precisely so that the
comparison rule can return "concurrent" as a distinct answer, which
scalar Lamport clocks structurally can't. A **version vector** is the
same data structure and comparison rule as a vector clock, but applied
to *replicas of a data item* to track which updates each replica has
seen (rather than to *events/processes* to order a computation) — the
distinction is one of purpose and what each entry counts, not of
mechanism. Rule of thumb: reach for a Lamport clock when you only need
a consistent total order and don't care about detecting conflicts;
reach for a vector clock or version vector when you must tell genuine
concurrency apart from causal succession, as leaderless replicas do.

**Failure modes.** The primary practical failure mode is **unbounded
vector growth**: the vector has one entry per node that has ever
produced an update, so in a system with many transient or frequently
replaced nodes, vectors accumulate stale entries for nodes that no
longer exist, growing the metadata attached to every single update
indefinitely unless entries are pruned — and pruning has to be done
carefully, since removing an entry too early can make two updates that
are actually causally ordered look concurrent instead, reintroducing
false conflicts the mechanism was supposed to eliminate. A second
failure mode is a node **skipping the increment-on-receive step** (a
correctness bug in the implementation, not a distributed-systems
inherent limitation): if a node merges an incoming vector but doesn't
increment its own entry before producing further updates, its
subsequent updates can be indistinguishable from the one it just merged
in, silently losing the causal distinction the whole mechanism exists
to preserve.

## Code example

```rust
use std::collections::HashMap;
use std::cmp::Ordering;

#[derive(Clone, Debug, PartialEq, Eq)]
struct VectorClock {
    counters: HashMap<String, u64>,
}

#[derive(Debug, PartialEq)]
enum CausalOrder {
    Before,
    After,
    Concurrent,
    Equal,
}

impl VectorClock {
    fn increment(&mut self, node: &str) {
        *self.counters.entry(node.to_string()).or_insert(0) += 1;
    }

    // Merges another vector in by entry-wise max, then increments this
    // node's own entry — the step that lets a subsequent update be
    // told apart from the one just merged.
    fn merge_and_increment(&mut self, other: &VectorClock, self_node: &str) {
        for (node, &count) in &other.counters {
            let entry = self.counters.entry(node.clone()).or_insert(0);
            *entry = (*entry).max(count);
        }
        self.increment(self_node);
    }

    fn compare(&self, other: &VectorClock) -> CausalOrder {
        let all_nodes: std::collections::HashSet<&String> =
            self.counters.keys().chain(other.counters.keys()).collect();

        let mut self_less = false;
        let mut other_less = false;

        for node in all_nodes {
            let a = self.counters.get(node).copied().unwrap_or(0);
            let b = other.counters.get(node).copied().unwrap_or(0);
            match a.cmp(&b) {
                Ordering::Less => self_less = true,
                Ordering::Greater => other_less = true,
                Ordering::Equal => {}
            }
        }

        match (self_less, other_less) {
            (false, false) => CausalOrder::Equal,
            (true, false) => CausalOrder::Before,
            (false, true) => CausalOrder::After,
            (true, true) => CausalOrder::Concurrent,
        }
    }
}
```

`compare` implements the happened-before rule directly: `self_less`
becomes true if any entry in `self` is strictly behind `other`, and
`other_less` becomes true if any entry in `other` is strictly behind
`self` — both being true simultaneously is exactly the concurrent case,
where neither vector's history contains the other's.

## When to use it

- Multiple replicas can accept writes independently (multi-master or
  leaderless replication) and the system needs to detect, rather than
  silently overwrite, conflicting concurrent updates.
- Causal ordering between events matters more than a total, globally
  agreed order — the system only needs to know "did A happen before B,
  after B, or independently of B."
- The application is willing to handle conflict resolution explicitly
  (last-writer-wins is not acceptable because it silently discards one
  of two legitimate concurrent updates).

## When not to use it

- The system already has a single leader per piece of data (single-
  writer replication), so writes are naturally totally ordered and
  there's no concurrent-write conflict to detect in the first place.
- The number of nodes that can independently write is large or grows
  frequently — vector clocks grow linearly with the number of distinct
  writers, and pruning stale entries safely is nontrivial engineering
  overhead.
- The application can tolerate simple last-writer-wins semantics — the
  extra complexity of tracking and reconciling concurrent versions
  isn't worth it if silently picking one write over another is fine.

## Use-case scenarios

**Shopping cart merging across disconnected replicas.** A retail
platform lets a customer add items to their cart from a mobile app that
briefly loses connectivity and syncs to a different replica than the
one their browser session is writing to. Each replica's cart update
carries a vector clock; when the two updates are later compared and
found to be concurrent (each added different items with no knowledge
of the other), the application merges both item sets into the final
cart rather than one write silently overwriting the other and losing
an item the customer genuinely added.

**Collaborative document-editing conflict detection.** A note-taking
app allows offline edits that sync once connectivity returns, and two
devices can each make edits to the same note while both are offline
from each other. Vector clocks attached to each device's edit let the
sync service tell a genuine editing conflict (both devices modified the
same note with no knowledge of the other's change) apart from a normal
sequential edit history, routing only real conflicts to a merge UI
instead of showing the user a merge prompt for every single sync.

**Distributed key-value store resolving replica divergence.** A
leaderless key-value store accepts writes on any of several replicas to
stay available during network partitions. When a client reads a key and
the quorum contacted returns responses from replicas that diverged
during a partition, the store's vector clocks distinguish a replica
that's simply behind (safely superseded, discarded) from two replicas
that accepted genuinely concurrent writes during the partition (both
returned to the client, since discarding either one would silently
lose a write that was valid when it was made).

## Related patterns

- [Quorum](/docs/patterns/consistency/quorum) — quorum reads are exactly
  the situation where multiple replica versions get compared, and
  vector clocks are what let that comparison detect real conflicts
  instead of assuming the most recent write always wins.

## Further reading

- [Vector clock — Wikipedia](https://en.wikipedia.org/wiki/Vector_clock)
- [Dynamo (storage system) — Wikipedia](https://en.wikipedia.org/wiki/Dynamo_(storage_system))
- [Time, Clocks, and the Ordering of Events in a Distributed System — Leslie Lamport (CACM 1978)](https://lamport.azurewebsites.net/pubs/time-clocks.pdf) — the foundational paper on logical clocks and the happened-before relation that vector clocks extend to detect concurrency.
