---
title: "Consistent Hashing"
sidebar_position: 2
supplementary: true
---

Consistent hashing is a technique for mapping keys to nodes on a circular
hash space (a "ring") so that adding or removing a node only remaps the
keys immediately adjacent to it — roughly `K/N` of them — instead of
reshuffling nearly the entire keyspace the way `hash(key) % N` does.

![Consistent Hashing diagram](/img/patterns/consistent-hashing.svg)

## Problem it solves

The obvious way to spread `K` keys across `N` nodes is `hash(key) % N`.
It distributes evenly and is trivial to compute — until `N` changes.
Because the node index is derived from the *modulus*, changing `N` from
3 to 4 changes the remainder for almost every key, so almost every key
now belongs to a different node. In a sharded store that means migrating
nearly the whole dataset; in a distributed cache it means a near-total
cache-miss storm that stampedes the backing database at the worst
possible moment — right when you were scaling out because you were
already under load. Consistent hashing exists to make the cost of a
membership change proportional to the *size of the change* (one node's
worth of keys), not to the size of the dataset.

## Technical architecture & implementation

**The ring and clockwise ownership.** Both keys and nodes are hashed
into the same fixed circular space — imagine the output of a hash
function (0 to 2^32-1, say) bent into a circle. Each node lands at one
or more points on the ring; each key lands at one point. A key is owned
by the **first node encountered walking clockwise** from the key's
position, wrapping around past the top of the ring back to the smallest
position. Lookup is a "find the next node clockwise" operation, which a
sorted structure (a balanced tree or sorted array of node positions)
answers in `O(log N)` with a binary search.

**Minimal remap — the whole point.** When a node joins, it lands at some
point on the ring and takes over only the arc between itself and the
*previous* node counter-clockwise; every key outside that arc keeps its
owner. When a node leaves, only *its* arc falls to the next node
clockwise. So a membership change touches one node's share of keys,
about `K/N`, rather than all `K`. The intuition: ownership is defined by
*local* geometry (who is next clockwise), and inserting or deleting one
point on a circle only perturbs its immediate neighborhood. This is
measured directly in the code example below.

**Virtual nodes for load balance and heterogeneity.** With one point per
node, a few unlucky hash placements can give one node a huge arc and
another a sliver — load variance is high, especially with small `N`. The
fix is **virtual nodes (vnodes)**: hash each physical node onto the ring
at many points (commonly 100–200), so its total ownership is the sum of
many small arcs, which averages out close to a fair share. Vnodes also
give you **weighting for free** — a machine with twice the capacity gets
twice as many vnodes and therefore twice the keyspace. The
[key-value store](/docs/patterns/building-blocks/key-value-store) page
ships a complete FNV-plus-vnodes ring implementation; this page does not
repeat it and instead measures the remap property and contrasts the
alternatives.

**Bounded-load variant.** Plain consistent hashing bounds *movement* but
not *instantaneous load*: a viral key or a temporarily hot node can still
overflow. **Consistent hashing with bounded loads** caps each node at a
small factor (e.g. 1.25x) above the average; if the clockwise owner is
already at capacity, the key overflows to the next node clockwise. This
keeps the minimal-remap benefit while enforcing a hard ceiling on any one
node's share — the scheme Google described for load balancing.

**Replication by walking the ring.** Consistent hashing also gives a
natural home for replicas: to store a key on `R` nodes, place it on its
clockwise owner and the next `R-1` *distinct* physical nodes clockwise
(skipping additional vnodes of a node you already picked). This
"preference list" is exactly how Dynamo-style stores choose replicas, and
it composes cleanly with a [quorum](/docs/patterns/consistency/quorum) on
those `R` nodes.

**Failure mode — correlated placement.** If vnode positions are derived
from a weak hash or a small seed, physical nodes can cluster, undoing the
smoothing and re-creating hot arcs; a good avalanche hash (or explicitly
spread seeds) matters. And membership must be *agreed*: two clients with
divergent views of the ring route the same key to different nodes, so the
ring itself is typically distributed via gossip or a coordination service
and versioned.

**Where it sits among siblings.** Consistent hashing is the standard
key-placement algorithm *inside* [sharding](/docs/patterns/storage/sharding)
and inside a [distributed cache](/docs/patterns/building-blocks/distributed-cache);
sharding is the broader discipline (shard-key choice, cross-shard queries,
rebalancing), and consistent hashing is one specific, rebalance-friendly
way to do the placement step.

## Consistent hashing vs modulo-N vs rendezvous

Three ways to answer "which node owns this key," compared on the axes
that actually decide the choice:

| Property | `hash(key) % N` | Consistent hashing (with vnodes) | Rendezvous (HRW) hashing |
| --- | --- | --- | --- |
| Keys moved when `N` changes | ~all of them | ~`K/N` (only the changed node's arc) | ~`K/N` (only the changed node's keys) |
| Lookup cost | `O(1)` | `O(log V)` over `V` vnodes | `O(N)` — hash key against every node |
| Load evenness | excellent (perfect mod spread) | good with enough vnodes | excellent, no vnodes needed |
| Weighting / heterogeneity | awkward | via vnode count | via weighted score function |
| Extra state | none | the ring (all vnode positions) | none — just the node list |
| Ordered top-`R` replicas | no | next `R` clockwise | top `R` by score, for free |

**Modulo-N** wins only when `N` is fixed forever. **Rendezvous (highest
random weight) hashing** computes `score = hash(key, node)` for every node
and picks the highest-scoring one; it needs no ring and gives an ordered
preference list (2nd-highest is the natural replica), at the cost of an
`O(N)` scan per lookup — great for small-to-medium `N`, less so for
thousands of nodes. Consistent hashing trades that scan for a
logarithmic ring lookup and is the usual pick at large scale. The code
example implements rendezvous hashing so you can see the contrast
concretely.

## Code example

Two measurements. First, the minimal-remap property: with a 150-vnode
ring over three nodes, adding a fourth moves close to the ideal `1/4` of
keys, while `hash(key) % N` over the same keys moves about three
quarters. Second, rendezvous hashing as the contrasting placement rule.

```rust
use std::collections::BTreeMap;

pub struct HashRing {
    ring: BTreeMap<u64, String>, // ring position -> physical node id
    vnodes: u32,
}

fn hash(s: &str) -> u64 {
    // FNV-1a + a splitmix64 finalizer for avalanche, so near-identical
    // strings like "node#0"/"node#1" don't cluster on the ring.
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h = (h ^ (h >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    h = (h ^ (h >> 27)).wrapping_mul(0x94d049bb133111eb);
    h ^ (h >> 31)
}

impl HashRing {
    pub fn new(vnodes: u32) -> Self {
        HashRing { ring: BTreeMap::new(), vnodes }
    }
    pub fn add(&mut self, node: &str) {
        for v in 0..self.vnodes {
            self.ring.insert(hash(&format!("{node}#{v}")), node.to_string());
        }
    }
    // First vnode clockwise from the key, wrapping past the top of the ring.
    pub fn owner(&self, key: &str) -> Option<&str> {
        if self.ring.is_empty() {
            return None;
        }
        let pos = hash(key);
        self.ring
            .range(pos..)
            .next()
            .or_else(|| self.ring.iter().next())
            .map(|(_, n)| n.as_str())
    }
}

// Rendezvous (highest-random-weight) hashing: the contrasting rule. No ring —
// score the key against every node and take the max. The full sorted score
// list is a ready-made replica preference list.
fn rendezvous_owner<'a>(nodes: &'a [&str], key: &str) -> &'a str {
    nodes
        .iter()
        .max_by_key(|n| hash(&format!("{n}:{key}")))
        .copied()
        .unwrap()
}

fn main() {
    let keys: Vec<String> = (0..100_000).map(|i| format!("key-{i}")).collect();

    // Consistent hashing: 3 nodes, record owners, add a 4th, count what moved.
    let mut ring = HashRing::new(150);
    for n in ["A", "B", "C"] {
        ring.add(n);
    }
    let before: Vec<String> = keys.iter().map(|k| ring.owner(k).unwrap().to_string()).collect();
    ring.add("D");
    let ch_moved = keys
        .iter()
        .zip(&before)
        .filter(|(k, was)| ring.owner(k).unwrap() != was.as_str())
        .count();

    // Modulo-N baseline over the same keys: 3 buckets -> 4 buckets.
    let mod_moved = keys
        .iter()
        .filter(|k| (hash(k) % 3) as usize != (hash(k) % 4) as usize)
        .count();

    let n = keys.len() as f64;
    println!(
        "consistent hashing: {:.1}% of keys moved (ideal 1/4 = 25%)",
        100.0 * ch_moved as f64 / n
    );
    println!("modulo-N:           {:.1}% of keys moved", 100.0 * mod_moved as f64 / n);

    // Rendezvous placement, for contrast.
    println!("rendezvous owner of key-42: {}", rendezvous_owner(&["A", "B", "C"], "key-42"));
}
```

Running this reports roughly **24% of keys moved** for the consistent-
hashing ring versus about **75%** for modulo-N — a direct measurement of
why membership changes are cheap on a ring and catastrophic under `mod N`.

## When to use it

- Node membership changes with any regularity — autoscaling, rolling
  replacement, failures — and you need each change to move a small,
  bounded fraction of keys rather than the whole dataset.
- You're partitioning a distributed cache, DHT, sharded store, or a
  stateful load balancer and want key placement that survives resizing.
- You want cheap, deterministic replica placement (next `R` clockwise, or
  the top `R` rendezvous scores) without a central directory.

## When not to use it

- The node count is fixed and essentially never changes — plain
  `hash(key) % N` is simpler, distributes perfectly, and costs `O(1)`.
- You need explicit, human-controlled placement of specific keys onto
  specific nodes (compliance, data residency, manual hot-key isolation) —
  a directory/lookup table is more direct than a hash ring.
- `N` is small and an `O(N)` per-lookup scan is fine — rendezvous hashing
  gives you the same minimal-remap benefit with less machinery and no
  ring to keep in sync.

## Use-case scenarios

**Distributed cache cluster.** A cache tier of memcached-style nodes
routes each key to a node via a consistent-hashing ring in the client. A
node dies and another is added under autoscaling; only the keys owned by
the affected arcs are relocated, so the cache-miss storm and the load it
throws at the backing database stay proportional to one node, not the
whole cache — the original motivation in Karger et al.'s 1997 web-caching
work.

**Dynamo-style key-value store.** A store like Cassandra or Riak places
keys on a ring with virtual nodes, replicates each key to the next `N`
distinct physical nodes clockwise (the preference list), and serves reads
and writes against a [quorum](/docs/patterns/consistency/quorum) of them.
Adding capacity streams only the newly-owned ranges to the joining node
while the cluster stays online.

**Sticky load balancing for stateful sessions.** An L7 load balancer that
must pin a client (or a shard of work) to a specific backend uses
consistent hashing so that adding or draining a backend re-pins only the
clients on the affected arc, rather than reshuffling every session and
invalidating in-memory state cluster-wide.

## Related patterns

- [Sharding](/docs/patterns/storage/sharding) — the broader partitioning
  discipline; consistent hashing is its rebalance-friendly key-placement
  algorithm.
- [Key-Value Store](/docs/patterns/building-blocks/key-value-store) —
  ships the full FNV + virtual-node ring implementation this page builds
  on and deliberately does not duplicate.
- [Distributed Cache](/docs/patterns/building-blocks/distributed-cache) —
  cache clusters route keys with the same ring to bound miss storms when
  nodes scale.
- [Quorum](/docs/patterns/consistency/quorum) — the `R + W > N` mechanism
  applied to the `R` replicas the ring's preference list selects.
- [Failover](/docs/patterns/reliability/failover) — when a ring node
  fails, its arc is taken over by the clockwise neighbor, a lightweight
  form of the same substitution logic.

## Further reading

- [Consistent hashing — Wikipedia](https://en.wikipedia.org/wiki/Consistent_hashing)
- [Rendezvous (highest random weight) hashing — Wikipedia](https://en.wikipedia.org/wiki/Rendezvous_hashing)
- [Dynamo: Amazon's Highly Available Key-value Store (2007 paper)](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf)
- [Dynamo (storage system) — Wikipedia](https://en.wikipedia.org/wiki/Dynamo_(storage_system))
- [Consistent Hashing with Bounded Loads — Google Research blog](https://research.google/blog/consistent-hashing-with-bounded-loads/)
