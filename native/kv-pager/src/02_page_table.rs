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
//! (`refs`, `filled`, `parent`, `key`, `sealed`, `idle_since`), indexed by the physical block number, and every
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
//! (copy-on-write), which is how a forked agent diverges (CAUSAL.md traces it step by step). A released agent's full
//! blocks stay cached until the pool needs them, and are evicted oldest first.
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
}

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
    /// When it was left unreferenced while cached (its place in the eviction order).
    idle_since: Vec<u64>,
    /// Every block's tokens, block `b` at `b * BLOCK_TOKENS`.
    tokens: Vec<Token>,
    /// Blocks holding nothing, ready to use.
    free: Vec<BlockId>,
    /// Cached blocks no table maps, by when they were left: evicted oldest first.
    idle: BTreeMap<u64, BlockId>,
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
    clock: u64,
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
            idle_since: vec![0; blocks],
            tokens: vec![0; blocks * BLOCK_TOKENS],
            free: (0..blocks as BlockId).rev().collect(),
            idle: BTreeMap::new(),
            cache: HashMap::new(),
            rows: Vec::new(),
            row_len: Vec::new(),
            row_agent: Vec::new(),
            free_rows: Vec::new(),
            agents: HashMap::new(),
            clock: 0,
            keyer: key,
            share: true,
        }
    }

    /// A pool that never shares a page on admission: every agent's prompt gets blocks of its own, as in a cache
    /// without prefix caching. (Forks still share; a host that wants no sharing does not fork.)
    pub fn without_sharing(blocks: usize) -> Self {
        Self { share: false, ..Self::new(blocks) }
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
        let cap = self.capacity();
        let row = match self.free_rows.pop() {
            Some(r) => r,
            None => {
                self.rows.extend(std::iter::repeat_n(NO_BLOCK, cap));
                self.row_len.push(0);
                self.row_agent.push(NO_ROW);
                (self.row_len.len() - 1) as u32
            }
        };
        self.row_agent[row as usize] = agent;
        self.row_len[row as usize] = 0;
        self.agents.insert(agent, row);
        row
    }

    /// Maps a new agent's prompt: its leading full blocks from the prefix cache while they match, the rest into new
    /// blocks (the full ones cached as they are written). All or nothing.
    pub fn admit(&mut self, agent: AgentId, prompt: &[Token]) -> Result<Admission, PageError> {
        if self.agents.contains_key(&agent) {
            return Err(PageError::AgentExists(agent));
        }
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
        }
        let row = self.take_row(agent);
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
                self.seal(b, k);
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
            self.seal(block, k);
        }
        Ok(Slot { block, offset, copy_from })
    }

    /// A new agent `child` that shares every page of `parent` (nothing is allocated) until one of them writes.
    pub fn fork(&mut self, parent: AgentId, child: AgentId) -> Result<(), PageError> {
        if self.agents.contains_key(&child) {
            return Err(PageError::AgentExists(child));
        }
        let &from = self.agents.get(&parent).ok_or(PageError::UnknownAgent(parent))?;
        let cap = self.capacity();
        let len = self.row_len[from as usize];
        let n = (len as usize).div_ceil(BLOCK_TOKENS);
        for k in 0..n {
            let b = self.rows[from as usize * cap + k];
            self.refs[b as usize] += 1;
        }
        let row = self.take_row(child);
        self.rows.copy_within(from as usize * cap..from as usize * cap + n, row as usize * cap);
        self.row_len[row as usize] = len;
        Ok(())
    }

    /// Unmaps an agent: pages no other table maps are freed, or kept cached (full ones) until the pool needs them.
    pub fn release(&mut self, agent: AgentId) -> Result<(), PageError> {
        let row = self.agents.remove(&agent).ok_or(PageError::UnknownAgent(agent))?;
        let cap = self.capacity();
        let at = row as usize * cap;
        let n = (self.row_len[row as usize] as usize).div_ceil(BLOCK_TOKENS);
        for k in 0..n {
            let b = self.rows[at + k];
            self.rows[at + k] = NO_BLOCK;
            self.release_block(b);
        }
        self.row_len[row as usize] = 0;
        self.row_agent[row as usize] = NO_ROW;
        self.free_rows.push(row);
        Ok(())
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
        for (&a, &row) in &self.agents {
            let r = row as usize;
            if self.row_agent[r] != a {
                return Err(format!("agent {a}: row {row} is {}'s", self.row_agent[r]));
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
            if self.row_agent[r as usize] != NO_ROW || self.rows[r as usize * cap..(r as usize + 1) * cap].iter().any(|&b| b != NO_BLOCK) {
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
        for &b in self.idle.values() {
            if !self.sealed[b as usize] || self.cache.get(&self.key[b as usize]) != Some(&b) {
                return Err(format!("idle block {b} is not in the cache"));
            }
        }
        for (&k, &b) in &self.cache {
            let b = b as usize;
            if !self.sealed[b] || self.key[b] != k || self.filled[b] as usize != BLOCK_TOKENS {
                return Err(format!("the cache maps key {k:x} to block {b}, which does not hold it"));
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
        self.idle_since[b] = 0;
        self.tokens[b * BLOCK_TOKENS..(b + 1) * BLOCK_TOKENS].fill(0);
    }

    /// Takes a free block, or evicts the oldest idle cached one.
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

    /// Maps a cached block into one more table, reviving it if it was idle.
    fn hold(&mut self, b: BlockId) {
        if self.refs[b as usize] == 0 {
            self.idle.remove(&self.idle_since[b as usize]);
        }
        self.refs[b as usize] += 1;
    }

    /// A block just filled: its key, and a place in the cache unless another block already holds that content.
    fn seal(&mut self, b: BlockId, key: u64) {
        self.key[b as usize] = key;
        self.sealed[b as usize] = true;
        if self.share {
            self.cache.entry(key).or_insert(b);
        }
    }

    fn release_block(&mut self, b: BlockId) {
        self.refs[b as usize] -= 1;
        if self.refs[b as usize] > 0 {
            return;
        }
        let cached = self.sealed[b as usize] && self.cache.get(&self.key[b as usize]) == Some(&b);
        if cached {
            self.clock += 1;
            self.idle_since[b as usize] = self.clock;
            self.idle.insert(self.clock, b);
        } else {
            self.clear_block(b);
            self.free.push(b);
        }
    }
}
