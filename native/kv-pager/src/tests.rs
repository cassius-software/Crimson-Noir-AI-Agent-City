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
fn a_released_agents_full_blocks_stay_cached_until_needed_and_are_evicted_oldest_first() {
    let mut pt = PageTable::new(4);
    pt.admit(1, &toks(0, 2 * BLOCK_TOKENS)).unwrap();
    pt.release(1).unwrap();
    assert_eq!(pt.in_use(), 0);
    let again = pt.admit(3, &toks(0, 2 * BLOCK_TOKENS)).unwrap();
    assert_eq!(again.cached_blocks, 2, "revived from the cache");
    pt.release(3).unwrap();

    pt.admit(2, &toks(500, 3 * BLOCK_TOKENS)).unwrap(); // 2 free + the oldest idle one
    pt.check().unwrap();
    assert_eq!(pt.admit(4, &toks(0, 2 * BLOCK_TOKENS)).unwrap_err(), PageError::OutOfBlocks { needed: 2, available: 1 });
    assert_eq!(pt.admit(5, &toks(0, BLOCK_TOKENS)).unwrap().cached_blocks, 0, "the first block was the one evicted");
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
        let mut pt = PageTable::with_key(24, key);
        let mut shadow: HashMap<AgentId, Vec<Token>> = HashMap::new();
        let mut next_id = 0u32;
        for _ in 0..400 {
            let ids: Vec<AgentId> = shadow.keys().copied().collect();
            match rng.below(10) {
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
