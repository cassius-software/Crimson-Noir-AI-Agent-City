// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Stage 05: the eviction policies replayed against the same workloads (shared by `chaos --evictions` and
//! `tests/chaos.rs`).
//!
//! Why does this file exist? An eviction policy is only better if it keeps more of what is asked for again. This file
//! replays deterministic workloads through two page tables that differ only in their policy and counts the prompt
//! tokens each served from its cache (tokens a model would not compute again):
//! - `city`: the swarm as the city asks it. Every prompt opens with the base reality (22 pages), then the agent's
//!   identity and its sliding memory, then a question; the answer is appended token by token and the agent is released.
//!   Some agents are asked far more often than others (a Zipf law), up to 8 asks are in flight, and the pool holds a
//!   small part of what all the agents' prompts would need;
//! - `scan`: four prompt families asked again and again, cut by bursts of one-off prompts as long as the pool, the
//!   case that empties a least-recently-used cache;
//! - `chaos`: the fuzzer's own spawn / fork / append / despawn streams (core.rs), under the real chain key.
//!
//! The workloads are made up to resemble the city; the numbers are what the page table did with them, not a
//! measurement of a model.
//! What breaks if it is removed? The eviction comparison has no source; the default policy is chosen blind.

use kv_pager::{AgentId, Eviction, PageError, PageTable, Token, BLOCK_TOKENS};

/// splitmix64.
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
        self.next() % n.max(1)
    }
    /// A Zipf(1) draw over 0..n (rank 0 most frequent), by inverting the harmonic sum.
    fn zipf(&mut self, n: u64, harmonic: f64) -> u64 {
        let target = (self.next() >> 11) as f64 / (1u64 << 53) as f64 * harmonic;
        let mut acc = 0.0;
        for k in 0..n {
            acc += 1.0 / (k + 1) as f64;
            if acc >= target {
                return k;
            }
        }
        n - 1
    }
}

/// What a replay served.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Served {
    pub prompt_tokens: u64,
    pub cached_tokens: u64,
    /// Admissions the pool refused (retried later).
    pub refusals: u64,
}

impl Served {
    /// Share of prompt tokens served from the cache.
    pub fn hit_rate(&self) -> f64 {
        self.cached_tokens as f64 / self.prompt_tokens.max(1) as f64
    }
}

/// One ask in flight: an agent mapped, its answer still being written.
struct Ask {
    agent: AgentId,
    who: usize,
    left: usize,
}

const BASE_TOKENS: usize = 22 * BLOCK_TOKENS;
const IDENTITY_TOKENS: usize = 24;
const MEMORY_TOKENS: usize = 96;
const QUESTION_TOKENS: usize = 16;
const ANSWER_TOKENS: usize = 48;

/// The city workload: `agents` agents, `asks` asks, a pool of `pages`.
pub fn city(policy: Eviction, agents: u32, asks: usize, pages: usize, seed: u64) -> Served {
    let mut pt = PageTable::new(pages).with_eviction(policy);
    let mut rng = Rng(seed);
    let harmonic: f64 = (1..=agents).map(|k| 1.0 / f64::from(k)).sum();
    let base: Vec<Token> = (0..BASE_TOKENS as Token).collect();
    // Each agent's memory: a sliding window of answer digests, oldest first.
    let mut memory: Vec<Vec<Token>> = (0..agents).map(|a| (0..MEMORY_TOKENS as Token).map(|i| 1_000_000 + a * 10_000 + i).collect()).collect();
    let mut in_flight: Vec<Ask> = Vec::new();
    let mut busy = vec![false; agents as usize];
    let mut served = Served::default();
    let mut next_id: AgentId = 0;
    let mut started = 0;
    while started < asks || !in_flight.is_empty() {
        if started < asks && in_flight.len() < 8 && rng.below(2) == 0 {
            let who = rng.zipf(u64::from(agents), harmonic) as usize;
            if !busy[who] {
                let mut prompt = base.clone();
                prompt.extend((0..IDENTITY_TOKENS as Token).map(|i| 500_000 + who as Token * 100 + i));
                prompt.extend(&memory[who]);
                prompt.extend((0..QUESTION_TOKENS).map(|_| 2_000_000 + rng.below(50_000) as Token));
                match pt.admit(next_id, &prompt) {
                    Ok(adm) => {
                        served.prompt_tokens += prompt.len() as u64;
                        served.cached_tokens += adm.cached_tokens as u64;
                        in_flight.push(Ask { agent: next_id, who, left: ANSWER_TOKENS });
                        busy[who] = true;
                        // The agent remembers this ask: the window slides by one digest of 16 tokens.
                        let digest: Vec<Token> = (0..16).map(|_| 3_000_000 + rng.below(1 << 20) as Token).collect();
                        memory[who].drain(..16);
                        memory[who].extend(digest);
                        started += 1;
                        next_id += 1;
                    }
                    Err(PageError::OutOfBlocks { .. }) => served.refusals += 1,
                    Err(e) => panic!("{e:?}"),
                }
            }
        }
        if in_flight.is_empty() {
            continue;
        }
        let i = rng.below(in_flight.len() as u64) as usize;
        let ask = &mut in_flight[i];
        let ok = pt.append(ask.agent, 4_000_000 + rng.below(1 << 20) as Token).is_ok();
        if ok {
            ask.left -= 1;
        }
        if ask.left == 0 || !ok {
            let done = in_flight.swap_remove(i);
            pt.release(done.agent).unwrap();
            busy[done.who] = false;
        }
    }
    pt.check().unwrap();
    served
}

/// The scan workload: four families of 8 pages asked `asks` times, and every `burst_every` asks a burst of one-off
/// prompts of `pages` pages in total. With `drift_every` above 0 the four families asked change every that many asks
/// (yesterday's popular prompts are never asked again), the case that punishes evidence kept too long.
pub fn scan(policy: Eviction, asks: usize, pages: usize, burst_every: usize, drift_every: usize, seed: u64) -> Served {
    let mut pt = PageTable::new(pages).with_eviction(policy);
    let mut rng = Rng(seed);
    let mut served = Served::default();
    let mut id: AgentId = 0;
    for n in 0..asks {
        let era = n.checked_div(drift_every).unwrap_or(0) as Token;
        let family = era * 4 + rng.below(4) as Token;
        let mut prompt: Vec<Token> = (0..8 * BLOCK_TOKENS as Token).map(|i| family * 100_000 + i).collect();
        prompt.extend((0..5).map(|_| 9_000_000 + rng.below(1 << 20) as Token));
        let adm = pt.admit(id, &prompt).expect("one prompt always fits");
        served.prompt_tokens += prompt.len() as u64;
        served.cached_tokens += adm.cached_tokens as u64;
        pt.release(id).unwrap();
        id += 1;
        if n % burst_every == burst_every - 1 {
            for _ in 0..pages / 4 {
                let one_off: Vec<Token> = (0..4 * BLOCK_TOKENS).map(|_| 20_000_000 + rng.below(1 << 30) as Token).collect();
                match pt.admit(id, &one_off) {
                    Ok(_) => pt.release(id).unwrap(),
                    Err(_) => served.refusals += 1,
                }
                id += 1;
            }
        }
    }
    pt.check().unwrap();
    served
}
