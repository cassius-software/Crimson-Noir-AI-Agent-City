// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
use super::*;
use std::collections::HashMap;

fn toks(from: u32, n: usize) -> Vec<Token> {
    (from..from + n as u32).collect()
}

#[test]
fn agents_with_the_same_prompt_start_share_its_full_blocks_and_part_where_their_tokens_do() {
    let mut pt = PageTable::new(64);
    let base = toks(1000, 3 * BLOCK_TOKENS + 5);
    let mut a = base.clone();
    a.extend(toks(1, 7));
    let mut b = base.clone();
    b.extend(toks(500, 7));
    let first = pt.admit(1, &a).unwrap();
    assert_eq!((first.blocks, first.cached_blocks), (4, 0));
    let second = pt.admit(2, &b).unwrap();
    assert_eq!((second.blocks, second.cached_blocks, second.cached_tokens), (4, 3, 3 * BLOCK_TOKENS));
    assert_eq!(pt.blocks_of(1).unwrap()[..3], pt.blocks_of(2).unwrap()[..3]);
    assert_ne!(pt.blocks_of(1).unwrap()[3], pt.blocks_of(2).unwrap()[3], "the partly filled block is never shared on admission");
    assert_eq!(pt.in_use(), 5);
    assert_eq!(pt.tokens_of(1).unwrap(), a);
    assert_eq!(pt.tokens_of(2).unwrap(), b);
    pt.check().unwrap();
}

#[test]
fn a_hash_collision_never_shares_a_page() {
    // Every block gets the same key: a hit must still match the tokens and the page before it.
    let mut pt = PageTable::with_key(64, |_, _| 7);
    pt.admit(1, &toks(0, 2 * BLOCK_TOKENS)).unwrap();
    let other = pt.admit(2, &toks(100, 2 * BLOCK_TOKENS)).unwrap();
    assert_eq!(other.cached_blocks, 0);
    let mut shifted = toks(100, BLOCK_TOKENS);
    shifted.extend(toks(0, BLOCK_TOKENS)); // agent 1's second block's tokens, after a different first block
    assert_eq!(pt.admit(3, &shifted).unwrap().cached_blocks, 0);
    assert_eq!(pt.tokens_of(3).unwrap(), shifted);
    pt.check().unwrap();
}

#[test]
fn a_fork_allocates_nothing_until_one_side_writes_then_copies_the_shared_partial_block() {
    let mut pt = PageTable::new(16);
    let prompt = toks(0, BLOCK_TOKENS + 4);
    pt.admit(1, &prompt).unwrap();
    let used = pt.in_use();
    pt.fork(1, 2).unwrap();
    assert_eq!(pt.in_use(), used, "a fork maps the same pages");
    let shared_tail = pt.blocks_of(1).unwrap()[1];
    assert_eq!(pt.refs(shared_tail), 2);

    let slot = pt.append(2, 9999).unwrap();
    assert_eq!(slot.copy_from, Some((shared_tail, 4)), "copy the 4 written slots first");
    assert_ne!(slot.block, shared_tail);
    assert_eq!(slot.offset, 4);
    assert_eq!(pt.refs(shared_tail), 1);
    assert_eq!(pt.blocks_of(1).unwrap()[0], pt.blocks_of(2).unwrap()[0], "the full block stays shared");
    let mut want = prompt.clone();
    assert_eq!(pt.tokens_of(1).unwrap(), want, "the parent never sees the child's write");
    want.push(9999);
    assert_eq!(pt.tokens_of(2).unwrap(), want);

    // The parent's own append now finds its tail private again: no copy.
    assert_eq!(pt.append(1, 1).unwrap().copy_from, None);
    pt.check().unwrap();
}

#[test]
fn a_request_the_pool_cannot_hold_is_refused_whole() {
    let mut pt = PageTable::new(4);
    pt.admit(1, &toks(0, 3 * BLOCK_TOKENS)).unwrap();
    let before = (pt.in_use(), pt.available());
    assert_eq!(pt.admit(2, &toks(100, 2 * BLOCK_TOKENS)), Err(PageError::OutOfBlocks { needed: 2, available: 1 }));
    assert_eq!((pt.in_use(), pt.available()), before);
    assert!(pt.blocks_of(2).is_none());
    pt.check().unwrap();

    pt.admit(2, &toks(100, BLOCK_TOKENS)).unwrap();
    assert_eq!(pt.append(2, 5), Err(PageError::OutOfBlocks { needed: 1, available: 0 }));
    assert_eq!(pt.len_of(2), Some(BLOCK_TOKENS), "a refused append changes nothing");
    pt.check().unwrap();
}

#[test]
fn a_released_agents_full_blocks_stay_cached_until_needed_and_are_evicted_oldest_first_tail_before_head() {
    let mut pt = PageTable::new(4);
    pt.admit(1, &toks(0, 2 * BLOCK_TOKENS)).unwrap();
    pt.release(1).unwrap();
    assert_eq!(pt.in_use(), 0);
    let again = pt.admit(3, &toks(0, 2 * BLOCK_TOKENS)).unwrap();
    assert_eq!(again.cached_blocks, 2, "revived from the cache");
    let chain = pt.blocks_of(3).unwrap().to_vec();
    pt.release(3).unwrap();
    assert_eq!(pt.eviction_order(), vec![chain[1], chain[0]], "a chain is left idle from its tail");

    pt.admit(2, &toks(500, 3 * BLOCK_TOKENS)).unwrap(); // 2 free + the oldest idle one: the chain's second block
    pt.check().unwrap();
    assert_eq!(pt.eviction_order(), vec![chain[0]]);
    // The first block is still cached and still reachable: the chain is cut at its tail, never in the middle.
    assert_eq!(pt.admit(4, &toks(0, 2 * BLOCK_TOKENS)).unwrap_err(), PageError::OutOfBlocks { needed: 1, available: 0 });
    assert_eq!(pt.admit(5, &toks(0, BLOCK_TOKENS)).unwrap().cached_blocks, 1, "the head survived its tail");
    pt.check().unwrap();
}

#[test]
fn an_evicted_tail_is_cached_again_when_recomputed_where_a_stale_orphan_used_to_hold_its_key() {
    // Before tail-first release, the head was evicted first and the orphaned tail kept its cache key, so the same
    // prompt admitted again found one cached block of two, every time.
    let mut pt = PageTable::new(8);
    let prompt = toks(0, 2 * BLOCK_TOKENS);
    pt.admit(1, &prompt).unwrap();
    pt.release(1).unwrap();
    pt.admit(2, &toks(900, 7 * BLOCK_TOKENS)).unwrap(); // 6 free + one idle: the tail
    pt.release(2).unwrap();
    for agent in 10..13 {
        let adm = pt.admit(agent, &prompt).unwrap();
        pt.check().unwrap();
        pt.release(agent).unwrap();
        if agent > 10 {
            assert_eq!(adm.cached_blocks, 2, "the recomputed tail is cached again");
        }
    }
}

#[test]
fn a_block_whose_parent_is_not_cached_is_never_cached() {
    // Agent 1 caches one block. Agent 2 writes the same block and then a second one through appends: its first block
    // is a duplicate the cache does not hold, so its second could never be hit, and is not cached. When agent 3 admits
    // both blocks, its second block (after agent 1's cached first) is the one cached, and agent 4 hits both.
    let mut pt = PageTable::new(8);
    pt.admit(1, &toks(0, BLOCK_TOKENS)).unwrap();
    pt.admit(2, &[]).unwrap();
    for t in toks(0, 2 * BLOCK_TOKENS) {
        pt.append(2, t).unwrap();
    }
    pt.check().unwrap();
    assert_eq!(pt.stats().cached_keys, 1, "agent 2's blocks follow an uncached duplicate");
    pt.release(2).unwrap();
    assert_eq!(pt.stats().idle_cached, 0, "nothing unreachable is kept");
    assert_eq!(pt.admit(3, &toks(0, 2 * BLOCK_TOKENS)).unwrap().cached_blocks, 1);
    assert_eq!(pt.admit(4, &toks(0, 2 * BLOCK_TOKENS)).unwrap().cached_blocks, 2);
    pt.check().unwrap();
}

#[test]
fn admission_counts_revived_idle_blocks_before_changing_anything() {
    // Three blocks: two idle cached ones (a prefix), one free. A prompt reusing the prefix and needing two new blocks
    // must be refused: the revived blocks are not available to it.
    let mut pt = PageTable::new(3);
    pt.admit(1, &toks(0, 2 * BLOCK_TOKENS)).unwrap();
    pt.release(1).unwrap();
    let mut p = toks(0, 2 * BLOCK_TOKENS);
    p.extend(toks(900, BLOCK_TOKENS + 1));
    assert_eq!(pt.admit(2, &p), Err(PageError::OutOfBlocks { needed: 2, available: 1 }));
    pt.check().unwrap();
}

#[test]
fn gpu_tables_are_rows_padded_with_no_block() {
    let mut pt = PageTable::new(16);
    pt.admit(1, &toks(0, 2 * BLOCK_TOKENS + 1)).unwrap();
    pt.admit(2, &toks(100, 3)).unwrap();
    let t = pt.gpu_tables(&[2, 1]).unwrap();
    assert_eq!(t.max_blocks, 3);
    assert_eq!(t.seq_lens, vec![3, 2 * BLOCK_TOKENS as u32 + 1]);
    assert_eq!(&t.block_table[..3], &[pt.blocks_of(2).unwrap()[0], NO_BLOCK, NO_BLOCK]);
    assert_eq!(&t.block_table[3..], pt.blocks_of(1).unwrap());
    assert_eq!(pt.gpu_tables(&[9]), Err(PageError::UnknownAgent(9)));
}

#[test]
fn the_kernel_is_built_for_this_page_size() {
    assert!(PAGED_ATTENTION_WGSL.contains(&format!("const BLOCK_TOKENS: u32 = {BLOCK_TOKENS}u;")));
    assert!(PAGED_ATTENTION_WGSL.contains(&format!("const HEAD_DIM: u32 = {}u;", DEFAULT_MODEL.head_dim)));
}

#[test]
fn the_default_models_kv_bytes() {
    assert_eq!(DEFAULT_MODEL.bytes_per_token(2), 147_456);
    // 100 agents reserving 8,192 tokens each: the 112 GiB the module doc quotes.
    assert_eq!(100 * 8192 * DEFAULT_MODEL.bytes_per_token(2), 112_u64 as usize * (1 << 30) + (1 << 29));
}

/// Every eviction policy the fuzz runs: LRU, the default log-odds, and a log-odds that forgets in a few ticks (so its
/// evidence is rescaled every few hundred).
const POLICIES: [Eviction; 3] = [
    Eviction::Lru,
    Eviction::LogOdds(LogOdds { alpha: 0.99, ln_bayes_factor: 1.098_612_288_668_109_8 }),
    Eviction::LogOdds(LogOdds { alpha: 0.5, ln_bayes_factor: 2.0 }),
];

/// A tiny deterministic generator for the fuzz.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

#[test]
fn random_admits_forks_appends_and_releases_keep_every_invariant_and_every_agents_tokens() {
    for seed in 0..40u64 {
        let mut rng = Rng(seed);
        let key: fn(u64, &[Token]) -> u64 = if seed % 4 == 0 { |_, t| u64::from(t[0] % 3) } else { chain_key };
        let mut pt = PageTable::with_key(24, key).with_eviction(POLICIES[seed as usize % POLICIES.len()]);
        let mut shadow: HashMap<AgentId, Vec<Token>> = HashMap::new();
        let mut pins: Vec<(PinId, Vec<Token>)> = Vec::new();
        let mut next_id = 0u32;
        for _ in 0..400 {
            let ids: Vec<AgentId> = shadow.keys().copied().collect();
            match rng.below(12) {
                0..=2 => {
                    // Prompts from a small alphabet over a common start, so prefixes repeat.
                    let n = rng.below(3 * BLOCK_TOKENS as u64) as usize + 1;
                    let p: Vec<Token> = (0..n).map(|i| if i < 20 { i as u32 } else { rng.below(3) as u32 }).collect();
                    let before = (pt.in_use(), pt.available());
                    match pt.admit(next_id, &p) {
                        Ok(_) => { shadow.insert(next_id, p); }
                        Err(PageError::OutOfBlocks { .. }) => assert_eq!((pt.in_use(), pt.available()), before),
                        Err(e) => panic!("{e:?}"),
                    }
                    next_id += 1;
                }
                3 if !ids.is_empty() => {
                    let parent = ids[rng.below(ids.len() as u64) as usize];
                    pt.fork(parent, next_id).unwrap();
                    shadow.insert(next_id, shadow[&parent].clone());
                    next_id += 1;
                }
                4..=7 if !ids.is_empty() => {
                    let a = ids[rng.below(ids.len() as u64) as usize];
                    let t = rng.below(3) as u32;
                    if pt.append(a, t).is_ok() {
                        shadow.get_mut(&a).unwrap().push(t);
                    }
                }
                8..=9 if !ids.is_empty() => {
                    let a = ids[rng.below(ids.len() as u64) as usize];
                    pt.release(a).unwrap();
                    shadow.remove(&a);
                }
                10 if pins.len() < 2 => {
                    let n = rng.below(2 * BLOCK_TOKENS as u64) as usize + 1;
                    let p: Vec<Token> = (0..n).map(|i| i as u32).collect();
                    if let Ok((id, _)) = pt.pin(&p) {
                        pins.push((id, p));
                    }
                }
                10 if !pins.is_empty() => {
                    let (id, _) = pins.remove(rng.below(pins.len() as u64) as usize);
                    pt.unpin(id).unwrap();
                }
                11 if !pins.is_empty() => {
                    let (id, p) = pins[rng.below(pins.len() as u64) as usize].clone();
                    pt.fork_pin(id, next_id).unwrap();
                    shadow.insert(next_id, p);
                    next_id += 1;
                }
                _ => {}
            }
            pt.check().unwrap_or_else(|e| panic!("seed {seed}: {e}"));
            for (a, t) in &shadow {
                assert_eq!(&pt.tokens_of(*a).unwrap(), t, "seed {seed}, agent {a}");
            }
        }
    }
}

#[test]
fn without_sharing_every_agent_gets_its_own_pages() {
    let mut pt = PageTable::without_sharing(16);
    let p = toks(0, 2 * BLOCK_TOKENS + 3);
    pt.admit(1, &p).unwrap();
    assert_eq!(pt.admit(2, &p).unwrap().cached_blocks, 0);
    assert_eq!(pt.in_use(), 6);
    pt.release(1).unwrap();
    assert_eq!(pt.in_use(), 3, "nothing is kept cached");
    pt.check().unwrap();
}

#[test]
fn a_pinned_prefix_stays_mapped_and_shared_while_agents_come_and_go_and_is_never_evicted() {
    let mut pt = PageTable::new(8);
    let prefix = toks(0, 2 * BLOCK_TOKENS + 5);
    let (pin, adm) = pt.pin(&prefix).unwrap();
    assert_eq!((adm.blocks, pt.pins(), pt.agents(), pt.in_use()), (3, 1, 0, 3));
    let pinned = pt.in_use();
    // An agent whose prompt starts with the prefix shares its full pages through the cache.
    let mut p = prefix.clone();
    p.extend(toks(500, 4));
    assert_eq!(pt.admit(1, &p).unwrap().cached_blocks, 2);
    // An agent forked from the pin shares every page, the partly filled third too, until it writes into it.
    pt.fork_pin(pin, 2).unwrap();
    assert_eq!(pt.in_use(), pinned + 1, "agent 1 took one page of its own; the fork took none");
    let tail = pt.blocks_of(2).unwrap()[2];
    let slot = pt.append(2, 77).unwrap();
    assert_eq!(slot.copy_from, Some((tail, 5)), "copy-on-write only for the agent's own delta");
    pt.check().unwrap();
    pt.release(1).unwrap();
    pt.release(2).unwrap();
    assert_eq!(pt.in_use(), pinned, "the pin holds its pages with no agent left");
    // A newcomer needing every other page cannot evict the pinned ones.
    assert_eq!(pt.admit(3, &toks(900, 5 * BLOCK_TOKENS)).unwrap().blocks, 5);
    assert_eq!(pt.admit(4, &toks(2000, 1)), Err(PageError::OutOfBlocks { needed: 1, available: 0 }));
    assert!(pt.gpu_tables(&[3]).is_ok());
    pt.release(3).unwrap();
    assert_eq!(pt.unpin(pin + 1), Err(PageError::UnknownPin(pin + 1)));
    assert_eq!(pt.fork_pin(pin + 1, 9), Err(PageError::UnknownPin(pin + 1)));
    pt.unpin(pin).unwrap();
    assert_eq!((pt.pins(), pt.in_use()), (0, 0));
    assert_eq!(pt.admit(5, &prefix).unwrap().cached_blocks, 2, "unpinned pages stay cached until needed");
    pt.check().unwrap();
}

/// Three agents share a prompt chain and leave first; one agent's generated chain is left after them.
fn prompt_then_generated(policy: Eviction) -> (PageTable, Vec<BlockId>, Vec<BlockId>) {
    let mut pt = PageTable::new(16).with_eviction(policy);
    let prompt = toks(0, 2 * BLOCK_TOKENS);
    for a in 1..=3 {
        pt.admit(a, &prompt).unwrap();
    }
    let shared = pt.blocks_of(1).unwrap().to_vec();
    for a in 1..=3 {
        pt.release(a).unwrap();
    }
    pt.admit(9, &[]).unwrap();
    for t in toks(5000, 2 * BLOCK_TOKENS) {
        pt.append(9, t).unwrap();
    }
    let generated = pt.blocks_of(9).unwrap().to_vec();
    pt.release(9).unwrap();
    pt.check().unwrap();
    (pt, shared, generated)
}

#[test]
fn lru_evicts_the_chain_left_first_and_log_odds_the_chain_least_likely_to_be_reused() {
    let (pt, shared, generated) = prompt_then_generated(Eviction::Lru);
    assert_eq!(pt.eviction_order(), vec![shared[1], shared[0], generated[1], generated[0]]);
    let (pt, shared, generated) = prompt_then_generated(Eviction::LogOdds(LogOdds::default()));
    assert_eq!(
        pt.eviction_order(),
        vec![generated[1], generated[0], shared[1], shared[0]],
        "a prompt chain three agents read outlives one agent's generated chain left after it"
    );
}

#[test]
fn log_odds_rise_with_every_reuse_hold_while_mapped_and_decay_toward_the_floor_while_idle() {
    let p = LogOdds { alpha: 0.9, ln_bayes_factor: 1.0 };
    let mut pt = PageTable::new(8).with_eviction(Eviction::LogOdds(p));
    let floor = (0.1f64 / 0.9).ln();
    let near = |a: f64, b: f64| (a - b).abs() < 1e-9;
    pt.admit(1, &toks(0, BLOCK_TOKENS)).unwrap(); // a prompt block: Pseudo, log-odds 0 (p = 0.5)
    let b = pt.blocks_of(1).unwrap()[0];
    assert!(near(pt.reuse_log_odds(b), 0.0), "{}", pt.reuse_log_odds(b));
    pt.admit(2, &toks(0, BLOCK_TOKENS)).unwrap(); // a cache hit: + ln b
    for a in 100..120 {
        pt.admit(a, &[1]).unwrap(); // ticks, while the block is mapped: no decay
        pt.release(a).unwrap();
    }
    assert!(near(pt.reuse_log_odds(b), 1.0), "in use, the evidence holds: {}", pt.reuse_log_odds(b));
    pt.release(1).unwrap();
    pt.release(2).unwrap(); // idle now; this release's tick is its first
    assert!(near(pt.reuse_log_odds(b), floor + 0.9 * (1.0 - floor)), "{}", pt.reuse_log_odds(b));
    pt.admit(3, &[2]).unwrap();
    assert!(near(pt.reuse_log_odds(b), floor + 0.81 * (1.0 - floor)), "{}", pt.reuse_log_odds(b));
    for a in 4..400 {
        pt.admit(a, &[1]).unwrap();
        pt.release(a).unwrap();
    }
    assert!(near(pt.reuse_log_odds(b), floor), "idle with no reuse, it relaxes to the Anecdotal floor");
    // A pin's own new block starts Empirical (p = 0.95, log-odds ln 19) and holds it while pinned.
    pt.pin(&toks(100, BLOCK_TOKENS)).unwrap();
    pt.admit(9999, &toks(100, BLOCK_TOKENS)).unwrap(); // finds the pinned block through the cache: a reuse
    let pinned = pt.blocks_of(9999).unwrap()[0];
    assert!(near(pt.reuse_log_odds(pinned), 19f64.ln() + 1.0), "{}", pt.reuse_log_odds(pinned));
    pt.check().unwrap();
}

#[test]
fn the_log_odds_eviction_order_is_the_same_on_every_run_and_survives_rescaling() {
    let run = |seed: u64| {
        let mut rng = Rng(seed);
        let mut pt = PageTable::new(48).with_eviction(Eviction::LogOdds(LogOdds { alpha: 0.6, ln_bayes_factor: 1.5 }));
        let mut live: Vec<AgentId> = Vec::new();
        let mut orders = Vec::new();
        for id in 0..3000u32 {
            if rng.below(3) == 0 || live.is_empty() {
                let n = 1 + rng.below(3 * BLOCK_TOKENS as u64) as usize;
                let family = rng.below(4) as u32;
                let p: Vec<Token> = (0..n).map(|i| if i < 24 { family * 1000 + i as u32 } else { rng.below(4) as u32 }).collect();
                if pt.admit(id, &p).is_ok() {
                    live.push(id);
                }
            } else {
                let a = live.swap_remove(rng.below(live.len() as u64) as usize);
                pt.release(a).unwrap();
            }
            pt.check().unwrap_or_else(|e| panic!("step {id}: {e}"));
            orders.push(pt.eviction_order());
        }
        orders
    };
    // α = 0.6 rescales the evidence every ~450 ticks: 3,000 operations cross several rescales.
    assert_eq!(run(5), run(5));
    assert_ne!(run(5), run(6));
}
