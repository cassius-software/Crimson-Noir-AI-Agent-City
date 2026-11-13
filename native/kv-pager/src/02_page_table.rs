// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Stage 02: the rules of the pages (the block manager of PagedAttention).
//!
//! Why does this file exist? It decides which physical page every token of every agent lives in. The cache is a pool
//! of fixed-size physical blocks of `BLOCK_TOKENS` tokens, like the pages of virtual memory, and every agent (a
//! pedestrian number) has its own block table mapping its sequence's logical blocks to physical ones, which need not be
//! contiguous.
//!
//! The pool is laid out as a structure of arrays (data-oriented, no block object): one array per field of a block
//! (`refs`, `filled`, `parent`, `key`, `sealed`, `idle_key`, `credit`), indexed by the physical block number, and every
//! block's tokens side by side in one flat array (`tokens`, block `b` at `b * BLOCK_TOKENS`). The agents' block tables
//! are one flat table too: a row of `capacity` entries per agent slot (no agent can map more distinct blocks than the
//! pool has), padded with `NO_BLOCK`, which is the layout the GPU kernel reads, so `gpu_tables` is a row copy and
//! never a rebuild. An agent id maps to its row through one hash map; the prefix cache is another (content key to
//! physical block) and the eviction order an ordered map, the three associative structures the algorithm is.
//!
//! Full blocks are content-addressed (prefix caching): a block's key is its tokens and the key of the block before
//! it, and a hit is checked against the stored tokens and the physical block before it, so a hash collision can never
//! share a page. Agents whose prompts begin with the same tokens (the Agent City base reality) map those blocks to the
//! same physical pages, each page counted once per agent, up to the first block in which their tokens part. A page
//! mapped by more than one table is never written: appending into a shared, partly filled block copies it first
//! (copy-on-write), which is how a forked agent diverges (CAUSAL.md traces it step by step). A prefix every agent
//! shares (the base reality, the swarm's standing orders) can be pinned: its pages stay mapped by the pin, read-only and
//! shared, however many agents come and go, and an agent forked from the pin copies only the partly filled page its
//! own tokens start in.
//!
//! A released agent's full blocks stay cached until the pool needs them. Every cached block is reachable: its parent is
//! the cached holder of the parent's key (a block whose parent is not cached is never cached, it could never be hit),
//! and a chain is always evicted from its tail, so a cached block never outlives its parent. Which idle chain goes first
//! is the eviction policy (`Eviction`). The default, `LogOdds`, keeps for each block the log-odds that it will be
//! reused: a prior from where the block came from (a pinned prefix, a prompt, a generated token), raised by every cache
//! hit and fork (Bayes' rule with a fixed Bayes factor), decayed toward a floor while the block is idle; the block least
//! likely to be reused goes first. With no reuse seen, blocks of one provenance go in the order they were left, as
//! under `Lru` (which remains available), and generated blocks before prompt blocks before pinned ones. Replayed
//! against the same workloads (the `chaos` run), the default served as many cached prompt tokens as `Lru` or more in
//! every one, and about 60% more where bursts of one-off prompts flood the pool.
//!
//! Allocation never overcommits: a request the pool cannot hold is refused whole, with nothing changed, so the host
//! can wait or release instead of running out of memory in the middle of a step.
//! What breaks if it is removed? Everything after it: the GPU pool (03) has pages but no one to hand them out, and a
//! native host would have to reserve a whole context per agent (100 agents at 8,192 tokens are 112.5 GiB).

use crate::geometry::{AgentId, BlockId, Token, BLOCK_TOKENS, NO_BLOCK};
use std::collections::{BTreeMap, HashMap};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PageError {
    /// The pool has fewer free (or evictable) blocks than the request needs. Nothing was changed.
    OutOfBlocks { needed: usize, available: usize },
    UnknownAgent(AgentId),
    AgentExists(AgentId),
    UnknownPin(PinId),
}

/// A pinned prefix, as `pin` returned it.
pub type PinId = u32;

/// How much a block's provenance says about whether it will be read again, before any reuse is seen: the prior
/// probability of reuse of the log-odds policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    /// A pinned prefix: declared shared by the host (0.95).
    Empirical,
    /// A prompt's block: prompts repeat across agents more often than not (0.50).
    Pseudo,
    /// A generated token's block: one agent's own continuation (0.10). Also the floor every block decays toward.
    Anecdotal,
}

impl Tier {
    pub fn prior(self) -> f64 {
        match self {
            Tier::Empirical => 0.95,
            Tier::Pseudo => 0.50,
            Tier::Anecdotal => 0.10,
        }
    }

    /// The prior's log-odds above the floor's (ln(p / (1 − p)) − ln(0.1 / 0.9)), written out so every platform
    /// computes the same eviction order (no `ln` at run time).
    fn lift(self) -> f64 {
        match self {
            Tier::Empirical => 5.141_663_556_502_66,  // ln 19 + ln 9
            Tier::Pseudo => 2.197_224_577_336_219_6,  // ln 9
            Tier::Anecdotal => 0.0,
        }
    }
}

/// The parameters of the log-odds policy. With q a block's odds of reuse: a block starts at its tier's prior; every reuse
/// (a cache hit, or a fork sharing it) multiplies q by the Bayes factor b (log q ← log q + ln b); and while the block is
/// idle, every admission, fork or release (a tick) applies log q ← α · log q + c with c = (1 − α) · logit(0.1), so an
/// idle block nobody reuses relaxes to the floor, Anecdotal. (An idle block cannot be reused without being revived, so
/// this is the alpha law log q ← α · (log q + ln bₜ) + cₜ with bₜ = 1.) A mapped block is in use and does not decay: with
/// no reuse seen, blocks of a tier are evicted in the order they were left, exactly as by `Lru`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LogOdds {
    /// The share of a block's evidence kept per tick, in (0, 1].
    pub alpha: f64,
    /// ln b of one reuse (a cache hit on the block, or a fork that shares it), at least `MIN_LN_BAYES_FACTOR`.
    pub ln_bayes_factor: f64,
}

/// The least evidence a reuse may count for. A reuse must raise a block's figure by more than the rounding of the
/// figure's trip through the scale (and by more than nothing where the stored figure has decayed below the smallest
/// float): with ln b = 0 a chain's revived head could be filed below its idle tail, and evicted first.
pub const MIN_LN_BAYES_FACTOR: f64 = 1e-3;

impl Default for LogOdds {
    /// α = 0.99 a tick (idle evidence halves in about 69 agent arrivals and departures), b = 3 per reuse. Replayed over
    /// a grid (α 0.95 to 0.999, ln b 0.5 to 3, the `chaos` run's workloads), it kept within one point of the best value
    /// on every workload and stayed there when the popular prompts changed, where α = 0.999, best on the city's asks,
    /// lost half its hits; its neighbours (α 0.99 with ln b 2, α 0.995 with ln b 1.1) trade a few tenths of a point
    /// between the workloads.
    fn default() -> Self {
        LogOdds { alpha: 0.99, ln_bayes_factor: 1.098_612_288_668_109_8 }
    }
}

/// Which idle cached chain the pool evicts first.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Eviction {
    /// The one left longest ago (least recently released).
    Lru,
    /// The one least likely to be reused, by its log-odds (`LogOdds`); ties go to the one left longest ago. The default.
    LogOdds(LogOdds),
}

/// Rescale the stored evidence before the scale passes this (it grows by 1/α a tick).
const RESCALE_ABOVE: f64 = 1e100;

/// What admitting an agent's prompt did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Admission {
    /// Blocks in the agent's table.
    pub blocks: usize,
    /// Of them, found in the prefix cache: their keys and values are already in the pool.
    pub cached_blocks: usize,
    /// Tokens the model need not compute again (`cached_blocks · BLOCK_TOKENS`).
    pub cached_tokens: usize,
}

/// Where an appended token's key and value go.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Slot {
    pub block: BlockId,
    pub offset: usize,
    /// A copy-on-write the host does first: copy this many token slots of this block into `block`.
    pub copy_from: Option<(BlockId, usize)>,
}

/// A snapshot of how the pool is used: where every block is, and how full the mapped ones are.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PoolStats {
    pub capacity: usize,
    /// Holding nothing.
    pub free: usize,
    /// Cached full blocks no table maps (evictable).
    pub idle_cached: usize,
    /// Mapped by at least one table.
    pub mapped: usize,
    /// Mapped by more than one table.
    pub shared: usize,
    /// Token slots of mapped blocks that hold no token yet (the partly filled tails): internal fragmentation.
    pub empty_slots: usize,
    /// Entries in the prefix cache.
    pub cached_keys: usize,
}

/// Block tables laid out for the GPU: a row of `max_blocks` entries per agent (padded with `NO_BLOCK`), and lengths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GpuTables {
    pub max_blocks: usize,
    pub block_table: Vec<u32>,
    pub seq_lens: Vec<u32>,
}

/// The key a chain of blocks starts from.
const CHAIN_SEED: u64 = 0xcbf2_9ce4_8422_2325;

/// FNV-1a over the key of the block before and the block's tokens, finished with splitmix64's mixer.
pub fn chain_key(before: u64, tokens: &[Token]) -> u64 {
    let mut h = CHAIN_SEED;
    for byte in before.to_le_bytes().into_iter().chain(tokens.iter().flat_map(|t| t.to_le_bytes())) {
        h ^= u64::from(byte);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h ^= h >> 30;
    h = h.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    h ^= h >> 27;
    h = h.wrapping_mul(0x94d0_49bb_1331_11eb);
    h ^ (h >> 31)
}

/// An agent slot's row: no agent.
const NO_ROW: u32 = u32::MAX;

pub struct PageTable {
    // The physical blocks, one array per field, indexed by block number.
    /// How many tables map the block.
    refs: Vec<u32>,
    /// Token slots written.
    filled: Vec<u32>,
    /// The physical block before it in the sequence it was written for, or `NO_BLOCK`.
    parent: Vec<BlockId>,
    /// Its content key, meaningful where `sealed` is true (the block is full and keyed).
    key: Vec<u64>,
    sealed: Vec<bool>,
    /// Its place in the eviction order while idle: (evidence bits, the release stamp).
    idle_key: Vec<(u64, u64)>,
    /// Its reuse evidence under `Eviction::LogOdds`: log-odds above the floor. A mapped block is in use and does not
    /// decay, so it holds the plain figure; an idle one decays, and holds the figure at release times `scale` then, which
    /// stays put while every idle block decays alike. A block's is never above its parent's.
    credit: Vec<f64>,
    /// Every block's tokens, block `b` at `b * BLOCK_TOKENS`.
    tokens: Vec<Token>,
    /// Blocks holding nothing, ready to use.
    free: Vec<BlockId>,
    /// Cached blocks no table maps, in eviction order: least evidence first, then the one left longest ago.
    idle: BTreeMap<(u64, u64), BlockId>,
    /// The prefix cache: content key → the physical block that holds it.
    cache: HashMap<u64, BlockId>,
    // The agents' block tables: a row of `capacity` entries per slot, padded with NO_BLOCK, and a length each.
    rows: Vec<BlockId>,
    /// Tokens in the slot's sequence.
    row_len: Vec<u32>,
    /// The agent in each slot, or NO_ROW where the slot is free.
    row_agent: Vec<AgentId>,
    /// Free slots, ready to hold an agent.
    free_rows: Vec<u32>,
    /// Which slot an agent holds.
    agents: HashMap<AgentId, u32>,
    /// Which slot a pinned prefix holds (a row like an agent's, never written after it is pinned).
    pins: HashMap<PinId, u32>,
    /// Whether a slot holds a pin (its `row_agent` is then the pin's id).
    row_pinned: Vec<bool>,
    next_pin: PinId,
    /// Release stamps: one per block left idle.
    clock: u64,
    policy: Eviction,
    /// 1/α to the ticks since the evidence was last rescaled: the factor today's evidence is stored at.
    scale: f64,
    keyer: fn(u64, &[Token]) -> u64,
    /// Whether admission looks in the prefix cache (off only for the no-sharing baseline a stress run compares with).
    share: bool,
}

impl PageTable {
    /// A pool of `blocks` physical blocks, all free.
    pub fn new(blocks: usize) -> Self {
        Self::with_key(blocks, chain_key)
    }

    /// The same, keying blocks with `key` (tests force collisions with it).
    pub fn with_key(blocks: usize, key: fn(u64, &[Token]) -> u64) -> Self {
        assert!(blocks < NO_BLOCK as usize, "a block id must fit below NO_BLOCK");
        Self {
            refs: vec![0; blocks],
            filled: vec![0; blocks],
            parent: vec![NO_BLOCK; blocks],
            key: vec![0; blocks],
            sealed: vec![false; blocks],
            idle_key: vec![(0, 0); blocks],
            credit: vec![0.0; blocks],
            tokens: vec![0; blocks * BLOCK_TOKENS],
            free: (0..blocks as BlockId).rev().collect(),
            idle: BTreeMap::new(),
            cache: HashMap::new(),
            rows: Vec::new(),
            row_len: Vec::new(),
            row_agent: Vec::new(),
            free_rows: Vec::new(),
            agents: HashMap::new(),
            pins: HashMap::new(),
            row_pinned: Vec::new(),
            next_pin: 0,
            clock: 0,
            policy: Eviction::LogOdds(LogOdds::default()),
            scale: 1.0,
            keyer: key,
            share: true,
        }
    }

    /// A pool that never shares a page on admission: every agent's prompt gets blocks of its own, as in a cache
    /// without prefix caching. (Forks still share; a host that wants no sharing does not fork.)
    pub fn without_sharing(blocks: usize) -> Self {
        Self { share: false, ..Self::new(blocks) }
    }

    /// The same table with another eviction policy. Set it before any block is cached.
    pub fn with_eviction(mut self, policy: Eviction) -> Self {
        if let Eviction::LogOdds(p) = policy {
            assert!(p.alpha > 0.0 && p.alpha <= 1.0, "alpha is a share kept per tick, in (0, 1]");
            assert!(
                p.ln_bayes_factor >= MIN_LN_BAYES_FACTOR && p.ln_bayes_factor.is_finite(),
                "a reuse is evidence for reuse: ln b is at least MIN_LN_BAYES_FACTOR"
            );
        }
        assert!(self.cache.is_empty(), "the policy is chosen before anything is cached");
        self.policy = policy;
        self
    }

    pub fn eviction(&self) -> Eviction {
        self.policy
    }

    pub fn capacity(&self) -> usize {
        self.refs.len()
    }

    /// Blocks a request can have: free ones, and cached ones no table maps (evicted when taken).
    pub fn available(&self) -> usize {
        self.free.len() + self.idle.len()
    }

    /// Blocks some table maps.
    pub fn in_use(&self) -> usize {
        self.capacity() - self.available()
    }

    pub fn agents(&self) -> usize {
        self.agents.len()
    }

    /// The row's blocks (the mapped prefix of its row).
    fn row_blocks(&self, row: u32) -> &[BlockId] {
        let cap = self.capacity();
        let at = row as usize * cap;
        &self.rows[at..at + (self.row_len[row as usize] as usize).div_ceil(BLOCK_TOKENS)]
    }

    pub fn blocks_of(&self, agent: AgentId) -> Option<&[BlockId]> {
        self.agents.get(&agent).map(|&row| self.row_blocks(row))
    }

    pub fn len_of(&self, agent: AgentId) -> Option<usize> {
        self.agents.get(&agent).map(|&row| self.row_len[row as usize] as usize)
    }

    /// How many tables map `block`.
    pub fn refs(&self, block: BlockId) -> u32 {
        self.refs[block as usize]
    }

    /// Block `b`'s token slots.
    fn tokens_of_block(&self, b: BlockId) -> &[Token] {
        &self.tokens[b as usize * BLOCK_TOKENS..(b as usize + 1) * BLOCK_TOKENS]
    }

    /// The agent's tokens, read back through its table.
    pub fn tokens_of(&self, agent: AgentId) -> Option<Vec<Token>> {
        let &row = self.agents.get(&agent)?;
        let len = self.row_len[row as usize] as usize;
        let mut out = Vec::with_capacity(len);
        for (i, &b) in self.row_blocks(row).iter().enumerate() {
            let n = (len - i * BLOCK_TOKENS).min(BLOCK_TOKENS);
            out.extend_from_slice(&self.tokens_of_block(b)[..n]);
        }
        Some(out)
    }

    /// A slot for a new agent's table: a freed row, or a new row of `capacity` empty entries.
    fn take_row(&mut self, agent: AgentId) -> u32 {
        let row = self.claim_row(agent, false);
        self.agents.insert(agent, row);
        row
    }

    /// A slot for a table owned by `owner` (an agent, or a pin when `pinned`).
    fn claim_row(&mut self, owner: u32, pinned: bool) -> u32 {
        let cap = self.capacity();
        let row = match self.free_rows.pop() {
            Some(r) => r,
            None => {
                self.rows.extend(std::iter::repeat_n(NO_BLOCK, cap));
                self.row_len.push(0);
                self.row_agent.push(NO_ROW);
                self.row_pinned.push(false);
                (self.row_len.len() - 1) as u32
            }
        };
        self.row_agent[row as usize] = owner;
        self.row_pinned[row as usize] = pinned;
        self.row_len[row as usize] = 0;
        row
    }

    /// Maps a new agent's prompt: its leading full blocks from the prefix cache while they match, the rest into new
    /// blocks (the full ones cached as they are written). All or nothing.
    pub fn admit(&mut self, agent: AgentId, prompt: &[Token]) -> Result<Admission, PageError> {
        if self.agents.contains_key(&agent) {
            return Err(PageError::AgentExists(agent));
        }
        let adm = self.map_prompt(prompt, Tier::Pseudo, |pt| pt.take_row(agent))?;
        self.tick();
        Ok(adm)
    }

    /// Pins `prompt`: its pages are mapped by the pin until `unpin`, shared read-only with every agent whose prompt
    /// starts with the same tokens (their full pages, through the prefix cache) or that is forked from it with
    /// `fork_pin` (every page, the partly filled last one copied only when the agent writes into it). The pin's own new
    /// pages start Empirical. All or nothing, like `admit`.
    pub fn pin(&mut self, prompt: &[Token]) -> Result<(PinId, Admission), PageError> {
        let id = self.next_pin;
        let adm = self.map_prompt(prompt, Tier::Empirical, |pt| {
            let row = pt.claim_row(id, true);
            pt.pins.insert(id, row);
            row
        })?;
        self.next_pin = self.next_pin.wrapping_add(1);
        self.tick();
        Ok((id, adm))
    }

    /// Unpins a prefix: its pages are released as an agent's are (kept cached, evidence intact, until the pool needs them).
    pub fn unpin(&mut self, pin: PinId) -> Result<(), PageError> {
        let row = self.pins.remove(&pin).ok_or(PageError::UnknownPin(pin))?;
        self.release_row(row);
        self.tick();
        Ok(())
    }

    /// A new agent sharing every page of a pinned prefix (nothing allocated until it writes).
    pub fn fork_pin(&mut self, pin: PinId, child: AgentId) -> Result<(), PageError> {
        if self.agents.contains_key(&child) {
            return Err(PageError::AgentExists(child));
        }
        let &from = self.pins.get(&pin).ok_or(PageError::UnknownPin(pin))?;
        self.fork_row(from, child);
        Ok(())
    }

    pub fn pins(&self) -> usize {
        self.pins.len()
    }

    /// Maps a prompt into a fresh row (`row_for` claims it once the pool is known to hold the prompt): the cached
    /// prefix, then new blocks of tier `tier`.
    fn map_prompt(&mut self, prompt: &[Token], tier: Tier, row_for: impl FnOnce(&mut Self) -> u32) -> Result<Admission, PageError> {
        let full = prompt.len() / BLOCK_TOKENS;
        let mut hits: Vec<BlockId> = Vec::new();
        let (mut key, mut parent) = (CHAIN_SEED, NO_BLOCK);
        for chunk in prompt.as_chunks::<BLOCK_TOKENS>().0.iter().take_while(|_| self.share) {
            let k = (self.keyer)(key, chunk);
            match self.cache.get(&k) {
                Some(&b) if self.tokens_of_block(b) == &chunk[..] && self.parent[b as usize] == parent => {
                    hits.push(b);
                    key = k;
                    parent = b;
                }
                _ => break,
            }
        }
        let needed = full - hits.len() + usize::from(!prompt.len().is_multiple_of(BLOCK_TOKENS));
        let reviving = hits.iter().filter(|&&b| self.refs[b as usize] == 0).count();
        let available = self.available() - reviving;
        if needed > available {
            return Err(PageError::OutOfBlocks { needed, available });
        }
        for &b in &hits {
            self.hold(b);
            self.witness(b);
        }
        let row = row_for(self);
        let at = row as usize * self.capacity();
        let mut n = hits.len();
        self.rows[at..at + n].copy_from_slice(&hits);
        for chunk in prompt.chunks(BLOCK_TOKENS).skip(hits.len()) {
            let b = self.take().expect("counted before anything changed");
            self.tokens[b as usize * BLOCK_TOKENS..b as usize * BLOCK_TOKENS + chunk.len()].copy_from_slice(chunk);
            self.filled[b as usize] = chunk.len() as u32;
            self.parent[b as usize] = parent;
            self.refs[b as usize] = 1;
            if chunk.len() == BLOCK_TOKENS {
                let k = (self.keyer)(key, chunk);
                self.seal(b, k, tier);
                key = k;
            }
            self.rows[at + n] = b;
            n += 1;
            parent = b;
        }
        self.row_len[row as usize] = prompt.len() as u32;
        Ok(Admission { blocks: n, cached_blocks: hits.len(), cached_tokens: hits.len() * BLOCK_TOKENS })
    }

    /// Where the agent's next token goes: the next slot of its last block, a new block when that one is full, or a
    /// private copy of it when another table maps it too (copy-on-write).
    pub fn append(&mut self, agent: AgentId, token: Token) -> Result<Slot, PageError> {
        let &row = self.agents.get(&agent).ok_or(PageError::UnknownAgent(agent))?;
        let cap = self.capacity();
        let at = row as usize * cap;
        let len = self.row_len[row as usize] as usize;
        let n = len.div_ceil(BLOCK_TOKENS);
        let offset = len % BLOCK_TOKENS;
        let last = (n > 0).then(|| self.rows[at + n - 1]);
        let (block, copy_from) = match last {
            Some(b) if offset > 0 && self.refs[b as usize] > 1 => {
                let copy = self.take().ok_or(PageError::OutOfBlocks { needed: 1, available: 0 })?;
                let (src, dst) = (b as usize * BLOCK_TOKENS, copy as usize * BLOCK_TOKENS);
                self.tokens.copy_within(src..src + offset, dst);
                self.filled[copy as usize] = offset as u32;
                self.parent[copy as usize] = self.parent[b as usize];
                self.refs[copy as usize] = 1;
                self.release_block(b);
                (copy, Some((b, offset)))
            }
            Some(b) if offset > 0 => (b, None),
            _ => {
                let fresh = self.take().ok_or(PageError::OutOfBlocks { needed: 1, available: 0 })?;
                self.parent[fresh as usize] = last.unwrap_or(NO_BLOCK);
                self.refs[fresh as usize] = 1;
                (fresh, None)
            }
        };
        let before = {
            let prev = if offset == 0 { n } else { n - 1 };
            if prev == 0 {
                CHAIN_SEED
            } else {
                let b = self.rows[at + prev - 1] as usize;
                assert!(self.sealed[b], "a block before another is full");
                self.key[b]
            }
        };
        self.tokens[block as usize * BLOCK_TOKENS + offset] = token;
        self.filled[block as usize] = (offset + 1) as u32;
        let full = offset + 1 == BLOCK_TOKENS;
        if offset == 0 {
            self.rows[at + n] = block;
        } else if copy_from.is_some() {
            self.rows[at + n - 1] = block;
        }
        self.row_len[row as usize] = (len + 1) as u32;
        if full {
            let k = (self.keyer)(before, self.tokens_of_block(block));
            self.seal(block, k, Tier::Anecdotal);
        }
        Ok(Slot { block, offset, copy_from })
    }

    /// A new agent `child` that shares every page of `parent` (nothing is allocated) until one of them writes.
    pub fn fork(&mut self, parent: AgentId, child: AgentId) -> Result<(), PageError> {
        if self.agents.contains_key(&child) {
            return Err(PageError::AgentExists(child));
        }
        let &from = self.agents.get(&parent).ok_or(PageError::UnknownAgent(parent))?;
        self.fork_row(from, child);
        Ok(())
    }

    /// `child` maps every block of row `from`; each shared block is a reuse seen.
    fn fork_row(&mut self, from: u32, child: AgentId) {
        let cap = self.capacity();
        let len = self.row_len[from as usize];
        let n = (len as usize).div_ceil(BLOCK_TOKENS);
        for k in 0..n {
            let b = self.rows[from as usize * cap + k];
            self.refs[b as usize] += 1;
            self.witness(b);
        }
        let row = self.take_row(child);
        self.rows.copy_within(from as usize * cap..from as usize * cap + n, row as usize * cap);
        self.row_len[row as usize] = len;
        self.tick();
    }

    /// Unmaps an agent: pages no other table maps are freed, or kept cached (full ones) until the pool needs them.
    pub fn release(&mut self, agent: AgentId) -> Result<(), PageError> {
        let row = self.agents.remove(&agent).ok_or(PageError::UnknownAgent(agent))?;
        self.release_row(row);
        self.tick();
        Ok(())
    }

    /// Releases a row's blocks from its tail to its head, so a chain's later blocks are left idle (and evicted) before
    /// the blocks they follow, and frees the row.
    fn release_row(&mut self, row: u32) {
        let cap = self.capacity();
        let at = row as usize * cap;
        let n = (self.row_len[row as usize] as usize).div_ceil(BLOCK_TOKENS);
        for k in (0..n).rev() {
            let b = self.rows[at + k];
            self.rows[at + k] = NO_BLOCK;
            self.release_block(b);
        }
        self.row_len[row as usize] = 0;
        self.row_agent[row as usize] = NO_ROW;
        self.row_pinned[row as usize] = false;
        self.free_rows.push(row);
    }

    /// Idle cached blocks in the order they would be evicted.
    pub fn eviction_order(&self) -> Vec<BlockId> {
        self.idle.values().copied().collect()
    }

    /// A block's log-odds of reuse now (0 where the policy keeps no evidence: LRU, or a block never sealed).
    pub fn reuse_log_odds(&self, block: BlockId) -> f64 {
        const FLOOR: f64 = -2.197_224_577_336_219_6; // ln(0.1 / 0.9)
        let b = block as usize;
        match self.policy {
            Eviction::LogOdds(_) if self.sealed[b] && self.refs[b] > 0 => FLOOR + self.credit[b],
            Eviction::LogOdds(_) if self.sealed[b] => FLOOR + self.credit[b] / self.scale,
            _ => 0.0,
        }
    }

    /// The tables of `agents`, in that order, as the kernel reads them.
    pub fn gpu_tables(&self, agents: &[AgentId]) -> Result<GpuTables, PageError> {
        let cap = self.capacity();
        let mut rows = Vec::with_capacity(agents.len());
        for &a in agents {
            rows.push(*self.agents.get(&a).ok_or(PageError::UnknownAgent(a))?);
        }
        let blocks = |row: u32| (self.row_len[row as usize] as usize).div_ceil(BLOCK_TOKENS);
        let max_blocks = rows.iter().map(|&r| blocks(r)).max().unwrap_or(0).max(1);
        let mut block_table = vec![NO_BLOCK; rows.len() * max_blocks];
        for (i, &r) in rows.iter().enumerate() {
            let n = blocks(r);
            block_table[i * max_blocks..i * max_blocks + n].copy_from_slice(&self.rows[r as usize * cap..r as usize * cap + n]);
        }
        Ok(GpuTables { max_blocks, block_table, seq_lens: rows.iter().map(|&r| self.row_len[r as usize]).collect() })
    }

    /// Where every block is now (the fuzzer's fragmentation statistics).
    pub fn stats(&self) -> PoolStats {
        let mapped = (0..self.capacity()).filter(|&b| self.refs[b] > 0);
        let (mut count, mut shared, mut empty) = (0, 0, 0);
        for b in mapped {
            count += 1;
            shared += usize::from(self.refs[b] > 1);
            empty += BLOCK_TOKENS - self.filled[b] as usize;
        }
        PoolStats {
            capacity: self.capacity(),
            free: self.free.len(),
            idle_cached: self.idle.len(),
            mapped: count,
            shared,
            empty_slots: empty,
            cached_keys: self.cache.len(),
        }
    }

    /// Checks every invariant of the table; the error says which one broke.
    pub fn check(&self) -> Result<(), String> {
        let cap = self.capacity();
        let mut mapped = vec![0u32; cap];
        let mut slots_held = 0;
        let tables = self.agents.iter().map(|(&a, &r)| (a, r, false)).chain(self.pins.iter().map(|(&p, &r)| (p, r, true)));
        for (a, row, pinned) in tables {
            let r = row as usize;
            if self.row_agent[r] != a || self.row_pinned[r] != pinned {
                return Err(format!("{} {a}: row {row} is {}'s", if pinned { "pin" } else { "agent" }, self.row_agent[r]));
            }
            slots_held += 1;
            let len = self.row_len[r] as usize;
            let n = len.div_ceil(BLOCK_TOKENS);
            let blocks = &self.rows[r * cap..(r + 1) * cap];
            if blocks[n..].iter().any(|&b| b != NO_BLOCK) {
                return Err(format!("agent {a}: a block past its {n} blocks is mapped"));
            }
            for (i, &b) in blocks[..n].iter().enumerate() {
                if b as usize >= cap {
                    return Err(format!("agent {a}: block {b} is outside the pool"));
                }
                mapped[b as usize] += 1;
                let want = (len - i * BLOCK_TOKENS).min(BLOCK_TOKENS);
                let have = self.filled[b as usize] as usize;
                if have < want || (i + 1 < n && have != BLOCK_TOKENS) {
                    return Err(format!("agent {a}: block {b} holds {have} tokens where {want} are read"));
                }
                // A page holds its tokens' keys and values only after the exact pages before it: every table that
                // maps it must map the same page before it.
                let parent = if i == 0 { NO_BLOCK } else { blocks[i - 1] };
                if self.parent[b as usize] != parent {
                    return Err(format!("agent {a}: block {b} was written after block {}, but follows {parent}", self.parent[b as usize]));
                }
            }
        }
        let rows = self.row_len.len();
        if slots_held + self.free_rows.len() != rows {
            return Err(format!("{rows} rows, {slots_held} held and {} free", self.free_rows.len()));
        }
        for &r in &self.free_rows {
            if self.row_agent[r as usize] != NO_ROW
                || self.row_pinned[r as usize]
                || self.rows[r as usize * cap..(r as usize + 1) * cap].iter().any(|&b| b != NO_BLOCK)
            {
                return Err(format!("free row {r} is not empty"));
            }
        }
        let mut seen = vec![false; cap];
        for &b in self.free.iter().chain(self.idle.values()) {
            if std::mem::replace(&mut seen[b as usize], true) {
                return Err(format!("block {b} is free twice"));
            }
        }
        for b in 0..cap {
            if self.refs[b] != mapped[b] {
                return Err(format!("block {b}: {} refs, {} tables map it", self.refs[b], mapped[b]));
            }
            if (self.refs[b] == 0) != seen[b] {
                return Err(format!("block {b}: {} refs, yet {} free", self.refs[b], if seen[b] { "" } else { "not" }));
            }
        }
        for (&k, &b) in &self.idle {
            if !self.sealed[b as usize] || self.cache.get(&self.key[b as usize]) != Some(&b) {
                return Err(format!("idle block {b} is not in the cache"));
            }
            if self.idle_key[b as usize] != k {
                return Err(format!("idle block {b} is filed under {k:?}, not its key {:?}", self.idle_key[b as usize]));
            }
        }
        for (&k, &b) in &self.cache {
            let b = b as usize;
            if !self.sealed[b] || self.key[b] != k || self.filled[b] as usize != BLOCK_TOKENS {
                return Err(format!("the cache maps key {k:x} to block {b}, which does not hold it"));
            }
            // Reachable: an admission walking the chain from its first block can hit it.
            let p = self.parent[b];
            if p != NO_BLOCK {
                let pu = p as usize;
                if !self.sealed[pu] || self.cache.get(&self.key[pu]) != Some(&p) {
                    return Err(format!("cached block {b} follows block {p}, which is not cached: it can never be hit"));
                }
                // Mapped blocks hold plain evidence, idle ones scaled: compare like with like. No float in the message:
                // formatting one would add 30 KB to the WebAssembly page table.
                if self.refs[b] > 0 && self.refs[pu] > 0 && self.credit[b] > self.credit[pu] {
                    return Err(format!("cached block {b} has more evidence than block {p} before it"));
                }
                if self.refs[b] == 0 && self.refs[pu] == 0 && self.idle_key[b] >= self.idle_key[pu] {
                    return Err(format!("idle block {b} would be evicted after block {p}, which it follows"));
                }
            }
            // The block before it is still the one it was written after (not a recycled id holding other content).
            let before = if p == NO_BLOCK { CHAIN_SEED } else { self.key[p as usize] };
            if (self.keyer)(before, self.tokens_of_block(b as BlockId)) != k {
                return Err(format!("cached block {b} is keyed for another block before it than block {p}"));
            }
        }
        Ok(())
    }

    /// Empties block `b`'s fields (its tokens too).
    fn clear_block(&mut self, b: BlockId) {
        let b = b as usize;
        self.refs[b] = 0;
        self.filled[b] = 0;
        self.parent[b] = NO_BLOCK;
        self.key[b] = 0;
        self.sealed[b] = false;
        self.idle_key[b] = (0, 0);
        self.credit[b] = 0.0;
        self.tokens[b * BLOCK_TOKENS..(b + 1) * BLOCK_TOKENS].fill(0);
    }

    /// Takes a free block, or evicts the idle cached one first in the eviction order.
    fn take(&mut self) -> Option<BlockId> {
        let b = match self.free.pop() {
            Some(b) => b,
            None => {
                let (_, b) = self.idle.pop_first()?;
                assert!(self.sealed[b as usize], "idle blocks are cached");
                self.cache.remove(&self.key[b as usize]);
                b
            }
        };
        self.clear_block(b);
        Some(b)
    }

    /// Maps a cached block into one more table, reviving it if it was idle (its evidence, decayed while it was, is in use
    /// again and stops decaying).
    fn hold(&mut self, b: BlockId) {
        if self.refs[b as usize] == 0 {
            self.idle.remove(&self.idle_key[b as usize]);
            if let Eviction::LogOdds(_) = self.policy {
                self.credit[b as usize] /= self.scale;
            }
        }
        self.refs[b as usize] += 1;
    }

    /// Whether `b` is the block the cache would hand out for its content.
    fn is_cached(&self, b: BlockId) -> bool {
        self.sealed[b as usize] && self.cache.get(&self.key[b as usize]) == Some(&b)
    }

    /// A block just filled: its key, its prior evidence (never above its parent's), and a place in the cache unless
    /// another block already holds that content or the block before it is not cached (it could never be hit).
    fn seal(&mut self, b: BlockId, key: u64, tier: Tier) {
        self.key[b as usize] = key;
        self.sealed[b as usize] = true;
        let parent = self.parent[b as usize];
        if let Eviction::LogOdds(_) = self.policy {
            // The parent is mapped (by the table writing this block), so both figures are plain.
            let prior = tier.lift();
            self.credit[b as usize] = if parent == NO_BLOCK { prior } else { prior.min(self.credit[parent as usize]) };
        }
        if self.share && (parent == NO_BLOCK || self.is_cached(parent)) {
            self.cache.entry(key).or_insert(b);
        }
    }

    /// A reuse of `b` seen (a cache hit or a fork; `b` is mapped): ln b more evidence.
    fn witness(&mut self, b: BlockId) {
        if let Eviction::LogOdds(p) = self.policy {
            if self.sealed[b as usize] {
                self.credit[b as usize] += p.ln_bayes_factor;
            }
        }
    }

    /// One admission, fork or release: every idle block's evidence decays by α, which is the scale growing by 1/α
    /// (stored evidence stays put, and so does the eviction order). Idle evidence is rescaled before the scale
    /// overflows.
    fn tick(&mut self) {
        let Eviction::LogOdds(p) = self.policy else { return };
        self.scale /= p.alpha;
        if self.scale <= RESCALE_ABOVE {
            return;
        }
        let f = 1.0 / self.scale;
        for &b in self.idle.values() {
            self.credit[b as usize] *= f;
        }
        self.scale = 1.0;
        let idle = std::mem::take(&mut self.idle);
        for ((_, stamp), b) in idle {
            let k = (Self::credit_bits(self.credit[b as usize]), stamp);
            self.idle_key[b as usize] = k;
            self.idle.insert(k, b);
        }
    }

    /// Evidence as an order key: non-negative floats order as their bits do.
    fn credit_bits(c: f64) -> u64 {
        if c > 0.0 {
            c.to_bits()
        } else {
            0
        }
    }

    fn release_block(&mut self, b: BlockId) {
        self.refs[b as usize] -= 1;
        if self.refs[b as usize] > 0 {
            return;
        }
        if self.is_cached(b) {
            self.clock += 1;
            if let Eviction::LogOdds(_) = self.policy {
                self.credit[b as usize] *= self.scale;
            }
            let k = (Self::credit_bits(self.credit[b as usize]), self.clock);
            self.idle_key[b as usize] = k;
            self.idle.insert(k, b);
        } else {
            self.clear_block(b);
            self.free.push(b);
        }
    }
}
