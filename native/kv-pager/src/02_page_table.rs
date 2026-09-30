//! Stage 02: the rules of the pages (the block manager of PagedAttention).
//!
//! Why does this file exist? It decides which physical page every token of every agent lives in. The cache is a pool
//! of fixed-size physical blocks of `BLOCK_TOKENS` tokens, like the pages of virtual memory, and every agent (a
//! pedestrian number) has its own block table mapping its sequence's logical blocks to physical ones, which need not be
//! contiguous.
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

#[derive(Clone)]
struct Block {
    refs: u32,
    tokens: [Token; BLOCK_TOKENS],
    filled: usize,
    /// The physical block before it in the sequence it was written for, or `NO_BLOCK`.
    parent: BlockId,
    /// Its content key once full.
    key: Option<u64>,
    /// When it was left unreferenced while cached (its place in the eviction order).
    idle_since: u64,
}

const EMPTY: Block = Block { refs: 0, tokens: [0; BLOCK_TOKENS], filled: 0, parent: NO_BLOCK, key: None, idle_since: 0 };

#[derive(Clone)]
struct Sequence {
    blocks: Vec<BlockId>,
    len: usize,
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

pub struct PageTable {
    blocks: Vec<Block>,
    /// Blocks holding nothing, ready to use.
    free: Vec<BlockId>,
    /// Cached blocks no table maps, by when they were left: evicted oldest first.
    idle: BTreeMap<u64, BlockId>,
    /// The prefix cache: content key → the physical block that holds it.
    cache: HashMap<u64, BlockId>,
    agents: HashMap<AgentId, Sequence>,
    clock: u64,
    key: fn(u64, &[Token]) -> u64,
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
            blocks: vec![EMPTY; blocks],
            free: (0..blocks as BlockId).rev().collect(),
            idle: BTreeMap::new(),
            cache: HashMap::new(),
            agents: HashMap::new(),
            clock: 0,
            key,
            share: true,
        }
    }

    /// A pool that never shares a page on admission: every agent's prompt gets blocks of its own, as in a cache
    /// without prefix caching. (Forks still share; a host that wants no sharing does not fork.)
    pub fn without_sharing(blocks: usize) -> Self {
        Self { share: false, ..Self::new(blocks) }
    }

    pub fn capacity(&self) -> usize {
        self.blocks.len()
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

    pub fn blocks_of(&self, agent: AgentId) -> Option<&[BlockId]> {
        self.agents.get(&agent).map(|s| s.blocks.as_slice())
    }

    pub fn len_of(&self, agent: AgentId) -> Option<usize> {
        self.agents.get(&agent).map(|s| s.len)
    }

    /// How many tables map `block`.
    pub fn refs(&self, block: BlockId) -> u32 {
        self.blocks[block as usize].refs
    }

    /// The agent's tokens, read back through its table.
    pub fn tokens_of(&self, agent: AgentId) -> Option<Vec<Token>> {
        let s = self.agents.get(&agent)?;
        let mut out = Vec::with_capacity(s.len);
        for (i, &b) in s.blocks.iter().enumerate() {
            let n = (s.len - i * BLOCK_TOKENS).min(BLOCK_TOKENS);
            out.extend_from_slice(&self.blocks[b as usize].tokens[..n]);
        }
        Some(out)
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
            let k = (self.key)(key, chunk);
            match self.cache.get(&k) {
                Some(&b) if self.blocks[b as usize].tokens[..] == chunk[..] && self.blocks[b as usize].parent == parent => {
                    hits.push(b);
                    key = k;
                    parent = b;
                }
                _ => break,
            }
        }
        let needed = full - hits.len() + usize::from(!prompt.len().is_multiple_of(BLOCK_TOKENS));
        let reviving = hits.iter().filter(|&&b| self.blocks[b as usize].refs == 0).count();
        let available = self.available() - reviving;
        if needed > available {
            return Err(PageError::OutOfBlocks { needed, available });
        }
        for &b in &hits {
            self.hold(b);
        }
        let mut table = hits.clone();
        for chunk in prompt.chunks(BLOCK_TOKENS).skip(hits.len()) {
            let b = self.take().expect("counted before anything changed");
            let block = &mut self.blocks[b as usize];
            block.tokens[..chunk.len()].copy_from_slice(chunk);
            block.filled = chunk.len();
            block.parent = parent;
            block.refs = 1;
            if chunk.len() == BLOCK_TOKENS {
                let k = (self.key)(key, chunk);
                self.seal(b, k);
                key = k;
            }
            table.push(b);
            parent = b;
        }
        let blocks = table.len();
        self.agents.insert(agent, Sequence { blocks: table, len: prompt.len() });
        Ok(Admission { blocks, cached_blocks: hits.len(), cached_tokens: hits.len() * BLOCK_TOKENS })
    }

    /// Where the agent's next token goes: the next slot of its last block, a new block when that one is full, or a
    /// private copy of it when another table maps it too (copy-on-write).
    pub fn append(&mut self, agent: AgentId, token: Token) -> Result<Slot, PageError> {
        let seq = self.agents.get(&agent).ok_or(PageError::UnknownAgent(agent))?;
        let offset = seq.len % BLOCK_TOKENS;
        let last = seq.blocks.last().copied();
        let (block, copy_from) = match last {
            Some(b) if offset > 0 && self.blocks[b as usize].refs > 1 => {
                let copy = self.take().ok_or(PageError::OutOfBlocks { needed: 1, available: 0 })?;
                let src = self.blocks[b as usize].clone();
                let dst = &mut self.blocks[copy as usize];
                dst.tokens[..offset].copy_from_slice(&src.tokens[..offset]);
                dst.filled = offset;
                dst.parent = src.parent;
                dst.refs = 1;
                self.release_block(b);
                (copy, Some((b, offset)))
            }
            Some(b) if offset > 0 => (b, None),
            _ => {
                let fresh = self.take().ok_or(PageError::OutOfBlocks { needed: 1, available: 0 })?;
                let block = &mut self.blocks[fresh as usize];
                block.parent = last.unwrap_or(NO_BLOCK);
                block.refs = 1;
                (fresh, None)
            }
        };
        let before = {
            let seq = &self.agents[&agent];
            let n = seq.blocks.len();
            let prev = if offset == 0 { n } else { n - 1 };
            if prev == 0 { CHAIN_SEED } else { self.blocks[seq.blocks[prev - 1] as usize].key.expect("a block before another is full") }
        };
        let b = &mut self.blocks[block as usize];
        b.tokens[offset] = token;
        b.filled = offset + 1;
        let full = b.filled == BLOCK_TOKENS;
        let seq = self.agents.get_mut(&agent).expect("looked up above");
        if offset == 0 {
            seq.blocks.push(block);
        } else if copy_from.is_some() {
            *seq.blocks.last_mut().expect("offset > 0") = block;
        }
        seq.len += 1;
        if full {
            let k = (self.key)(before, &self.blocks[block as usize].tokens);
            self.seal(block, k);
        }
        Ok(Slot { block, offset, copy_from })
    }

    /// A new agent `child` that shares every page of `parent` (nothing is allocated) until one of them writes.
    pub fn fork(&mut self, parent: AgentId, child: AgentId) -> Result<(), PageError> {
        if self.agents.contains_key(&child) {
            return Err(PageError::AgentExists(child));
        }
        let seq = self.agents.get(&parent).ok_or(PageError::UnknownAgent(parent))?.clone();
        for &b in &seq.blocks {
            self.blocks[b as usize].refs += 1;
        }
        self.agents.insert(child, seq);
        Ok(())
    }

    /// Unmaps an agent: pages no other table maps are freed, or kept cached (full ones) until the pool needs them.
    pub fn release(&mut self, agent: AgentId) -> Result<(), PageError> {
        let seq = self.agents.remove(&agent).ok_or(PageError::UnknownAgent(agent))?;
        for b in seq.blocks {
            self.release_block(b);
        }
        Ok(())
    }

    /// The tables of `agents`, in that order, as the kernel reads them.
    pub fn gpu_tables(&self, agents: &[AgentId]) -> Result<GpuTables, PageError> {
        let mut seqs = Vec::with_capacity(agents.len());
        for &a in agents {
            seqs.push(self.agents.get(&a).ok_or(PageError::UnknownAgent(a))?);
        }
        let max_blocks = seqs.iter().map(|s| s.blocks.len()).max().unwrap_or(0).max(1);
        let mut block_table = vec![NO_BLOCK; seqs.len() * max_blocks];
        for (i, s) in seqs.iter().enumerate() {
            block_table[i * max_blocks..i * max_blocks + s.blocks.len()].copy_from_slice(&s.blocks);
        }
        Ok(GpuTables { max_blocks, block_table, seq_lens: seqs.iter().map(|s| s.len as u32).collect() })
    }

    /// Where every block is now (the fuzzer's fragmentation statistics).
    pub fn stats(&self) -> PoolStats {
        let mapped: Vec<&Block> = self.blocks.iter().filter(|b| b.refs > 0).collect();
        PoolStats {
            capacity: self.capacity(),
            free: self.free.len(),
            idle_cached: self.idle.len(),
            mapped: mapped.len(),
            shared: mapped.iter().filter(|b| b.refs > 1).count(),
            empty_slots: mapped.iter().map(|b| BLOCK_TOKENS - b.filled).sum(),
            cached_keys: self.cache.len(),
        }
    }

    /// Checks every invariant of the table; the error says which one broke.
    pub fn check(&self) -> Result<(), String> {
        let mut mapped = vec![0u32; self.blocks.len()];
        for (a, s) in &self.agents {
            if s.blocks.len() != s.len.div_ceil(BLOCK_TOKENS) {
                return Err(format!("agent {a}: {} blocks for {} tokens", s.blocks.len(), s.len));
            }
            for (i, &b) in s.blocks.iter().enumerate() {
                mapped[b as usize] += 1;
                let want = (s.len - i * BLOCK_TOKENS).min(BLOCK_TOKENS);
                let have = self.blocks[b as usize].filled;
                if have < want || (i + 1 < s.blocks.len() && have != BLOCK_TOKENS) {
                    return Err(format!("agent {a}: block {b} holds {have} tokens where {want} are read"));
                }
                // A page holds its tokens' keys and values only after the exact pages before it: every table that
                // maps it must map the same page before it.
                let parent = if i == 0 { NO_BLOCK } else { s.blocks[i - 1] };
                if self.blocks[b as usize].parent != parent {
                    return Err(format!("agent {a}: block {b} was written after block {}, but follows {parent}", self.blocks[b as usize].parent));
                }
            }
        }
        let mut seen = vec![false; self.blocks.len()];
        for &b in self.free.iter().chain(self.idle.values()) {
            if std::mem::replace(&mut seen[b as usize], true) {
                return Err(format!("block {b} is free twice"));
            }
        }
        for (b, block) in self.blocks.iter().enumerate() {
            if block.refs != mapped[b] {
                return Err(format!("block {b}: {} refs, {} tables map it", block.refs, mapped[b]));
            }
            if (block.refs == 0) != seen[b] {
                return Err(format!("block {b}: {} refs, yet {} free", block.refs, if seen[b] { "" } else { "not" }));
            }
        }
        for &b in self.idle.values() {
            let key = self.blocks[b as usize].key;
            if key.is_none() || self.cache.get(&key.unwrap()) != Some(&b) {
                return Err(format!("idle block {b} is not in the cache"));
            }
        }
        for (&k, &b) in &self.cache {
            let block = &self.blocks[b as usize];
            if block.key != Some(k) || block.filled != BLOCK_TOKENS {
                return Err(format!("the cache maps key {k:x} to block {b}, which does not hold it"));
            }
        }
        Ok(())
    }

    /// Takes a free block, or evicts the oldest idle cached one.
    fn take(&mut self) -> Option<BlockId> {
        let b = match self.free.pop() {
            Some(b) => b,
            None => {
                let (_, b) = self.idle.pop_first()?;
                let key = self.blocks[b as usize].key.expect("idle blocks are cached");
                self.cache.remove(&key);
                b
            }
        };
        self.blocks[b as usize] = EMPTY;
        Some(b)
    }

    /// Maps a cached block into one more table, reviving it if it was idle.
    fn hold(&mut self, b: BlockId) {
        let block = &mut self.blocks[b as usize];
        if block.refs == 0 {
            self.idle.remove(&block.idle_since);
        }
        block.refs += 1;
    }

    /// A block just filled: its key, and a place in the cache unless another block already holds that content.
    fn seal(&mut self, b: BlockId, key: u64) {
        self.blocks[b as usize].key = Some(key);
        if self.share {
            self.cache.entry(key).or_insert(b);
        }
    }

    fn release_block(&mut self, b: BlockId) {
        let block = &mut self.blocks[b as usize];
        block.refs -= 1;
        if block.refs > 0 {
            return;
        }
        let cached = block.key.is_some_and(|k| self.cache.get(&k) == Some(&b));
        if cached {
            self.clock += 1;
            block.idle_since = self.clock;
            self.idle.insert(self.clock, b);
        } else {
            *block = EMPTY;
            self.free.push(b);
        }
    }
}
