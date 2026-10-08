// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Stage 04: the property fuzzer's engine (shared by `cargo run --bin chaos` and `tests/chaos.rs`).
//!
//! Why does this file exist? The page table's promises (02_page_table.rs) are about sequences of operations, not single
//! calls: no page is ever lost or mapped twice, an agent always reads back exactly the tokens it wrote whatever its
//! neighbours did, a refusal changes nothing and is only given when the pool is truly short, and a pool emptied of
//! agents can hand out every one of its pages again. This engine generates chaotic spawn / fork / append / despawn
//! streams (mass despawn waves among them) against a shadow model, checks every promise after every operation, gathers
//! fragmentation statistics, and shrinks any failing stream to a minimal one.
//! What breaks if it is removed? The fuzz binary and the chaos tests; a regression in the page table would surface only
//! as corrupt attention on the GPU.

use kv_pager::{AgentId, PageError, PageTable, PoolStats, Token, BLOCK_TOKENS};
use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};

/// One operation. Agents are picked by index into the live list (modulo its length), so a stream stays meaningful
/// when the shrinker removes operations from it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    /// Admit a new agent: family `family`'s shared prefix, then `tail` tokens from `alphabet` symbols seeded by `salt`.
    Spawn { family: u8, tail: u16, alphabet: u8, salt: u32 },
    Fork { pick: u16 },
    /// `n` tokens, from `alphabet` symbols seeded by `salt`.
    Append { pick: u16, n: u8, alphabet: u8, salt: u32 },
    Despawn { pick: u16 },
    /// Mass despawn: every live agent except one in `keep_one_in`.
    Wave { keep_one_in: u8 },
    /// Lay out every live table for the GPU and check it.
    Tables,
}

/// How the table under test is built.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Keying {
    /// The real chain key.
    Chain,
    /// A key with constant collisions (`t[0] % 3`): only the token and parent checks keep pages apart.
    Colliding,
    /// No prefix cache (`without_sharing`).
    Private,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Stats {
    pub ops: u64,
    pub spawns: u64,
    pub forks: u64,
    pub appends: u64,
    pub despawns: u64,
    pub waves: u64,
    pub refusals: u64,
    pub cow_copies: u64,
    pub prefix_hit_tokens: u64,
    /// Peak of mapped + idle over capacity, per run (max over runs).
    pub peak_occupancy: f64,
    /// Sum over every op of empty slots / mapped slots (divide by `ops` for the mean internal fragmentation).
    pub frag_sum: f64,
    pub frag_max: f64,
    /// Sum over every op of idle cached / capacity.
    pub idle_sum: f64,
    /// Refusals given while free + idle blocks would have covered the request: must stay 0.
    pub false_refusals: u64,
    /// Blocks not reclaimable after all agents left (free + idle < capacity): must stay 0.
    pub orphaned_blocks: u64,
    pub reclaims: u64,
}

impl Stats {
    pub fn merge(&mut self, o: &Stats) {
        self.ops += o.ops;
        self.spawns += o.spawns;
        self.forks += o.forks;
        self.appends += o.appends;
        self.despawns += o.despawns;
        self.waves += o.waves;
        self.refusals += o.refusals;
        self.cow_copies += o.cow_copies;
        self.prefix_hit_tokens += o.prefix_hit_tokens;
        self.peak_occupancy = self.peak_occupancy.max(o.peak_occupancy);
        self.frag_sum += o.frag_sum;
        self.frag_max = self.frag_max.max(o.frag_max);
        self.idle_sum += o.idle_sum;
        self.false_refusals += o.false_refusals;
        self.orphaned_blocks += o.orphaned_blocks;
        self.reclaims += o.reclaims;
    }
}

pub struct Rng(pub u64);
impl Rng {
    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// Family prefixes: lengths chosen to end inside, at and across page boundaries.
const FAMILY_LEN: [usize; 5] = [5, BLOCK_TOKENS, 2 * BLOCK_TOKENS + 7, 3 * BLOCK_TOKENS, 0];

fn family_prefix(f: u8) -> Vec<Token> {
    let f = usize::from(f) % FAMILY_LEN.len();
    (0..FAMILY_LEN[f]).map(|i| 1000 + (f as Token) * 100 + i as Token).collect()
}

fn symbols(n: usize, alphabet: u8, salt: u32) -> Vec<Token> {
    let mut r = Rng(u64::from(salt) << 8 | u64::from(alphabet));
    // A small alphabet repeats content (cache hits, collisions); 0 means "any token".
    (0..n).map(|_| if alphabet == 0 { r.below(1 << 20) as Token } else { r.below(u64::from(alphabet)) as Token }).collect()
}

/// A random stream, chaotic by construction: spawns and despawns dominate, with bursts and waves.
pub fn generate(rng: &mut Rng, len: usize) -> Vec<Op> {
    let alphabet = |rng: &mut Rng| [0u8, 2, 3, 5][rng.below(4) as usize];
    (0..len)
        .map(|_| match rng.below(100) {
            0..=29 => Op::Spawn { family: rng.below(5) as u8, tail: rng.below(3 * BLOCK_TOKENS as u64) as u16, alphabet: alphabet(rng), salt: rng.next() as u32 },
            30..=39 => Op::Fork { pick: rng.next() as u16 },
            40..=69 => Op::Append { pick: rng.next() as u16, n: 1 + rng.below(2 * BLOCK_TOKENS as u64) as u8, alphabet: alphabet(rng), salt: rng.next() as u32 },
            70..=93 => Op::Despawn { pick: rng.next() as u16 },
            94..=96 => Op::Wave { keep_one_in: 1 + rng.below(8) as u8 },
            _ => Op::Tables,
        })
        .collect()
}

/// The table under test and its shadow: what each live agent must read back.
pub struct World {
    pub pt: PageTable,
    pub shadow: HashMap<AgentId, Vec<Token>>,
    /// Live agents in spawn order (the pick list).
    pub live: Vec<AgentId>,
    pub next_id: AgentId,
    pub stats: Stats,
}

impl World {
    pub fn new(capacity: usize, keying: Keying, first_id: AgentId) -> Self {
        let pt = match keying {
            Keying::Chain => PageTable::new(capacity),
            Keying::Colliding => PageTable::with_key(capacity, |_, t| u64::from(t[0] % 3)),
            Keying::Private => PageTable::without_sharing(capacity),
        };
        Self { pt, shadow: HashMap::new(), live: Vec::new(), next_id: first_id, stats: Stats::default() }
    }

    fn pick(&self, p: u16) -> Option<AgentId> {
        (!self.live.is_empty()).then(|| self.live[usize::from(p) % self.live.len()])
    }

    fn remove(&mut self, a: AgentId) {
        self.pt.release(a).unwrap_or_else(|e| panic!("release {a}: {e:?}"));
        self.shadow.remove(&a);
        self.live.retain(|&x| x != a);
        self.stats.despawns += 1;
    }

    /// A refusal must change nothing, and must be deserved. An admission reports what it could take for new blocks:
    /// free and idle blocks less the idle ones its own prefix hits would revive (those cannot also be evicted), so at
    /// most `available()`; an append takes one block from free or idle, so its refusal means both are empty.
    fn refused(&mut self, e: PageError, before: PoolStats, admission: bool) {
        let PageError::OutOfBlocks { needed, available } = e else { panic!("unexpected {e:?}") };
        self.stats.refusals += 1;
        assert_eq!(self.pt.stats(), before, "a refusal changed the pool");
        if admission {
            assert!(available <= self.pt.available(), "an admission reported more than the pool has");
        } else {
            assert_eq!((needed, available, self.pt.available()), (1, 0, 0), "an append refused with blocks left");
        }
        if needed <= available {
            self.stats.false_refusals += 1;
            panic!("refused {needed} blocks with {available} available");
        }
    }

    pub fn apply(&mut self, op: Op) {
        self.stats.ops += 1;
        let before = self.pt.stats();
        match op {
            Op::Spawn { family, tail, alphabet, salt } => {
                let mut p = family_prefix(family);
                p.extend(symbols(usize::from(tail), alphabet, salt));
                let id = self.next_id;
                self.next_id += 1;
                match self.pt.admit(id, &p) {
                    Ok(adm) => {
                        assert_eq!(adm.blocks, p.len().div_ceil(BLOCK_TOKENS));
                        self.stats.prefix_hit_tokens += adm.cached_tokens as u64;
                        self.shadow.insert(id, p);
                        self.live.push(id);
                        self.stats.spawns += 1;
                    }
                    Err(e) => self.refused(e, before, true),
                }
            }
            Op::Fork { pick } => {
                if let Some(parent) = self.pick(pick) {
                    let id = self.next_id;
                    self.next_id += 1;
                    self.pt.fork(parent, id).unwrap();
                    assert_eq!(self.pt.stats().mapped, before.mapped, "a fork allocated");
                    self.shadow.insert(id, self.shadow[&parent].clone());
                    self.live.push(id);
                    self.stats.forks += 1;
                }
            }
            Op::Append { pick, n, alphabet, salt } => {
                if let Some(a) = self.pick(pick) {
                    for t in symbols(usize::from(n), alphabet, salt) {
                        let snap = self.pt.stats();
                        match self.pt.append(a, t) {
                            Ok(slot) => {
                                if let Some((src, k)) = slot.copy_from {
                                    self.stats.cow_copies += 1;
                                    assert_eq!(k, slot.offset, "a copy covers exactly the slots before the write");
                                    assert_ne!(src, slot.block);
                                }
                                self.shadow.get_mut(&a).unwrap().push(t);
                                self.stats.appends += 1;
                            }
                            Err(e) => {
                                self.refused(e, snap, false);
                                break;
                            }
                        }
                    }
                }
            }
            Op::Despawn { pick } => {
                if let Some(a) = self.pick(pick) {
                    self.remove(a);
                }
            }
            Op::Wave { keep_one_in } => {
                self.stats.waves += 1;
                let gone: Vec<AgentId> = self.live.iter().enumerate().filter(|(i, _)| i % usize::from(keep_one_in) != 0).map(|(_, &a)| a).collect();
                for a in gone {
                    self.remove(a);
                }
            }
            Op::Tables => {
                let t = self.pt.gpu_tables(&self.live).unwrap();
                for (row, &a) in self.live.iter().enumerate() {
                    let blocks = self.pt.blocks_of(a).unwrap();
                    assert_eq!(t.seq_lens[row] as usize, self.shadow[&a].len());
                    assert_eq!(&t.block_table[row * t.max_blocks..][..blocks.len()], blocks);
                    assert!(t.block_table[row * t.max_blocks..][blocks.len()..t.max_blocks].iter().all(|&b| b == kv_pager::NO_BLOCK));
                }
            }
        }
        self.observe();
    }

    /// Every invariant, every agent's tokens, and the statistics.
    pub fn observe(&mut self) {
        self.pt.check().unwrap_or_else(|e| panic!("invariant: {e}"));
        for (&a, t) in &self.shadow {
            assert_eq!(&self.pt.tokens_of(a).unwrap(), t, "agent {a} reads back other tokens");
        }
        let s = self.pt.stats();
        assert_eq!(s.free + s.idle_cached + s.mapped, s.capacity, "a block is nowhere: orphaned");
        let slots = (s.mapped * BLOCK_TOKENS).max(1) as f64;
        let frag = s.empty_slots as f64 / slots;
        self.stats.frag_sum += frag;
        self.stats.frag_max = self.stats.frag_max.max(frag);
        self.stats.idle_sum += s.idle_cached as f64 / s.capacity as f64;
        self.stats.peak_occupancy = self.stats.peak_occupancy.max((s.mapped + s.idle_cached) as f64 / s.capacity as f64);
    }

    /// Everyone leaves; then one agent must be able to take every page (idle cached ones evicted).
    pub fn reclaim(&mut self) {
        for a in self.live.clone() {
            self.remove(a);
        }
        let s = self.pt.stats();
        if s.free + s.idle_cached != s.capacity {
            self.stats.orphaned_blocks += (s.capacity - s.free - s.idle_cached) as u64;
            panic!("{} blocks unreclaimable after every agent left", s.capacity - s.free - s.idle_cached);
        }
        let id = self.next_id;
        self.next_id += 1;
        let whole: Vec<Token> = (0..s.capacity * BLOCK_TOKENS).map(|i| (1 << 30) + i as Token).collect();
        self.pt.admit(id, &whole).unwrap_or_else(|e| panic!("the emptied pool refused a full-pool agent: {e:?}"));
        self.pt.check().unwrap();
        self.pt.release(id).unwrap();
        self.stats.reclaims += 1;
    }
}

/// Runs a stream; Err carries the panic message.
pub fn run(ops: &[Op], capacity: usize, keying: Keying) -> Result<Stats, String> {
    catch_unwind(AssertUnwindSafe(|| {
        let mut w = World::new(capacity, keying, 0);
        for &op in ops {
            w.apply(op);
        }
        w.reclaim();
        w.stats
    }))
    .map_err(|e| e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default())
}

/// Delta-debugging: the smallest stream (by removing chunks, then single ops) that still fails.
pub fn shrink(ops: &[Op], capacity: usize, keying: Keying) -> Vec<Op> {
    shrink_by(ops, |cand| run(cand, capacity, keying).is_err())
}

/// The same, for any failure predicate.
pub fn shrink_by(ops: &[Op], fails: impl Fn(&[Op]) -> bool) -> Vec<Op> {
    let mut cur = ops.to_vec();
    let mut chunk = cur.len() / 2;
    while chunk >= 1 {
        let mut i = 0;
        let mut progressed = false;
        while i < cur.len() {
            let mut cand = cur.clone();
            cand.drain(i..(i + chunk).min(cand.len()));
            if fails(&cand) {
                cur = cand;
                progressed = true;
            } else {
                i += chunk;
            }
        }
        if !progressed {
            chunk /= 2;
        }
    }
    cur
}
