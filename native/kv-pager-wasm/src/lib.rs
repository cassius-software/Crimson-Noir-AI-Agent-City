//! kv-pager's page table (native/kv-pager/src/02_page_table.rs, the part with no GPU) behind a C ABI over linear
//! memory, built to WebAssembly for the cognition router (src/09_Cognition/prefixCache.ts): the prompt-prefix page
//! table that makes the prefix ordering of every system prompt explicit and measurable.
//!
//! Why does this file exist? The page table is the one place the product can count what a prompt cache would share:
//! the base reality every agent's prompt opens with is one page chain, forked per agent (nothing allocated until an
//! agent's own tokens are appended, when the shared tail page is copied once), and its statistics (prefix hits, pages
//! mapped, pages shared, copies) are what `ask` reports. The table owns token ids only; a model server's own KV
//! cache stays its own. Every table is a handle (a boxed `PageTable` with a token scratch and an output block);
//! tokens go in through the scratch, results come out through the block, and every error is a negative code.
//! What breaks if it is removed? The router has no prefix table to ask and `ask` has no cache line; nothing else.

use kv_pager::{PageError, PageTable, BLOCK_TOKENS, NO_BLOCK};

/// Error codes every call may return (never a positive result).
pub const ERR_OUT_OF_BLOCKS: i32 = -1;
pub const ERR_UNKNOWN_AGENT: i32 = -2;
pub const ERR_AGENT_EXISTS: i32 = -3;
pub const ERR_INVARIANT: i32 = -4;
pub const ERR_NO_TABLE: i32 = -5;
pub const ERR_SCRATCH: i32 = -6;

/// Words of a table's output block (`kv_out`).
pub const OUT_WORDS: usize = 8;

/// Where `kv_stats` puts each number in the output block.
pub const STAT_CAPACITY: usize = 0;
pub const STAT_FREE: usize = 1;
pub const STAT_IDLE_CACHED: usize = 2;
pub const STAT_MAPPED: usize = 3;
pub const STAT_SHARED: usize = 4;
pub const STAT_EMPTY_SLOTS: usize = 5;
pub const STAT_CACHED_KEYS: usize = 6;
pub const STAT_AGENTS: usize = 7;

/// Where `kv_append` puts the slot in the output block.
pub const SLOT_BLOCK: usize = 0;
pub const SLOT_OFFSET: usize = 1;
/// The block a copy-on-write copied from, or NO_BLOCK when nothing was copied.
pub const SLOT_COPY_FROM: usize = 2;
/// Token slots the copy-on-write copied (0 when nothing was).
pub const SLOT_COPIED: usize = 3;

/// One table and its buffers. The host holds its address as the handle (a `usize`: i32 in the wasm32 ABI, and the
/// whole pointer on the host, where `cargo test` runs the same functions).
pub struct Handle {
    table: PageTable,
    scratch: Vec<u32>,
    out: [u32; OUT_WORDS],
}

fn code(e: PageError) -> i32 {
    match e {
        PageError::OutOfBlocks { .. } => ERR_OUT_OF_BLOCKS,
        PageError::UnknownAgent(_) => ERR_UNKNOWN_AGENT,
        PageError::AgentExists(_) => ERR_AGENT_EXISTS,
    }
}

/// The handle behind `h`, or None for 0.
///
/// # Safety
/// `h` must be 0 or an address `kv_new` returned that `kv_free` has not taken back.
unsafe fn handle<'a>(h: usize) -> Option<&'a mut Handle> {
    if h == 0 {
        None
    } else {
        Some(&mut *(h as *mut Handle))
    }
}

/// Tokens per page.
#[no_mangle]
pub extern "C" fn kv_block_tokens() -> u32 {
    BLOCK_TOKENS as u32
}

/// The id that means no block (`SLOT_COPY_FROM` when nothing was copied).
#[no_mangle]
pub extern "C" fn kv_no_block() -> u32 {
    NO_BLOCK
}

/// A new table of `blocks` pages, all free, with a token scratch of `scratch` tokens; its handle (never 0).
#[no_mangle]
pub extern "C" fn kv_new(blocks: u32, scratch: u32) -> usize {
    let h = Box::new(Handle { table: PageTable::new(blocks as usize), scratch: vec![0; scratch as usize], out: [0; OUT_WORDS] });
    Box::into_raw(h) as usize
}

/// Frees a table; 0 is ignored.
#[no_mangle]
pub extern "C" fn kv_free(h: usize) {
    if h != 0 {
        // SAFETY: the host hands back what kv_new gave it, once.
        drop(unsafe { Box::from_raw(h as *mut Handle) });
    }
}

/// The address of the table's token scratch (`kv_scratch_len` tokens of u32), which the host fills before kv_spawn.
#[no_mangle]
pub extern "C" fn kv_scratch(h: usize) -> usize {
    match unsafe { handle(h) } {
        Some(t) => t.scratch.as_ptr() as usize,
        None => 0,
    }
}

#[no_mangle]
pub extern "C" fn kv_scratch_len(h: usize) -> u32 {
    match unsafe { handle(h) } {
        Some(t) => t.scratch.len() as u32,
        None => 0,
    }
}

/// The address of the table's output block (`OUT_WORDS` u32 words).
#[no_mangle]
pub extern "C" fn kv_out(h: usize) -> usize {
    match unsafe { handle(h) } {
        Some(t) => t.out.as_ptr() as usize,
        None => 0,
    }
}

/// Maps agent `agent`'s prompt: the first `len` tokens of the scratch, its leading full pages from the prefix cache
/// while they match. Returns the pages found in the cache (≥ 0), or an error code; all or nothing.
#[no_mangle]
pub extern "C" fn kv_spawn(h: usize, agent: u32, len: u32) -> i32 {
    let Some(t) = (unsafe { handle(h) }) else { return ERR_NO_TABLE };
    let n = len as usize;
    if n > t.scratch.len() {
        return ERR_SCRATCH;
    }
    match t.table.admit(agent, &t.scratch[..n]) {
        Ok(a) => a.cached_blocks as i32,
        Err(e) => code(e),
    }
}

/// A new agent `child` sharing every page of `parent` (nothing allocated) until one of them writes; 0 or an error.
#[no_mangle]
pub extern "C" fn kv_fork(h: usize, parent: u32, child: u32) -> i32 {
    let Some(t) = (unsafe { handle(h) }) else { return ERR_NO_TABLE };
    match t.table.fork(parent, child) {
        Ok(()) => 0,
        Err(e) => code(e),
    }
}

/// Appends one token to `agent`'s sequence; the slot goes to the output block (SLOT_*). 0 or an error.
#[no_mangle]
pub extern "C" fn kv_append(h: usize, agent: u32, token: u32) -> i32 {
    let Some(t) = (unsafe { handle(h) }) else { return ERR_NO_TABLE };
    match t.table.append(agent, token) {
        Ok(slot) => {
            t.out[SLOT_BLOCK] = slot.block;
            t.out[SLOT_OFFSET] = slot.offset as u32;
            let (from, copied) = slot.copy_from.map_or((NO_BLOCK, 0), |(b, n)| (b, n as u32));
            t.out[SLOT_COPY_FROM] = from;
            t.out[SLOT_COPIED] = copied;
            0
        }
        Err(e) => code(e),
    }
}

/// Unmaps an agent: its pages are freed, or kept cached (full ones) until the pool needs them. 0 or an error.
#[no_mangle]
pub extern "C" fn kv_despawn(h: usize, agent: u32) -> i32 {
    let Some(t) = (unsafe { handle(h) }) else { return ERR_NO_TABLE };
    match t.table.release(agent) {
        Ok(()) => 0,
        Err(e) => code(e),
    }
}

/// Tokens in `agent`'s sequence, or an error.
#[no_mangle]
pub extern "C" fn kv_len(h: usize, agent: u32) -> i32 {
    let Some(t) = (unsafe { handle(h) }) else { return ERR_NO_TABLE };
    t.table.len_of(agent).map_or(ERR_UNKNOWN_AGENT, |n| n as i32)
}

/// Writes the pool's statistics to the output block (STAT_*); 0 or an error.
#[no_mangle]
pub extern "C" fn kv_stats(h: usize) -> i32 {
    let Some(t) = (unsafe { handle(h) }) else { return ERR_NO_TABLE };
    let s = t.table.stats();
    t.out[STAT_CAPACITY] = s.capacity as u32;
    t.out[STAT_FREE] = s.free as u32;
    t.out[STAT_IDLE_CACHED] = s.idle_cached as u32;
    t.out[STAT_MAPPED] = s.mapped as u32;
    t.out[STAT_SHARED] = s.shared as u32;
    t.out[STAT_EMPTY_SLOTS] = s.empty_slots as u32;
    t.out[STAT_CACHED_KEYS] = s.cached_keys as u32;
    t.out[STAT_AGENTS] = t.table.agents() as u32;
    0
}

/// Checks every invariant of the table: 0, or ERR_INVARIANT.
#[no_mangle]
pub extern "C" fn kv_check(h: usize) -> i32 {
    let Some(t) = (unsafe { handle(h) }) else { return ERR_NO_TABLE };
    if t.table.check().is_ok() { 0 } else { ERR_INVARIANT }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out(h: usize) -> [u32; OUT_WORDS] {
        unsafe { handle(h) }.unwrap().out
    }

    fn fill(h: usize, tokens: &[u32]) -> u32 {
        let t = unsafe { handle(h) }.unwrap();
        t.scratch[..tokens.len()].copy_from_slice(tokens);
        tokens.len() as u32
    }

    #[test]
    fn a_prefix_chain_forked_per_agent_shares_until_the_first_write_then_copies_the_tail_once() {
        let h = kv_new(64, 256);
        assert_ne!(h, 0);
        assert_eq!(kv_block_tokens(), 16);
        // A 40-token prefix: two full pages and a tail of 8.
        let prefix: Vec<u32> = (100..140).collect();
        let n = fill(h, &prefix);
        assert_eq!(kv_spawn(h, 1, n), 0, "nothing cached yet");
        assert_eq!(kv_fork(h, 1, 2), 0);
        assert_eq!(kv_fork(h, 1, 3), 0);
        assert_eq!(kv_stats(h), 0);
        let s = out(h);
        assert_eq!((s[STAT_MAPPED], s[STAT_SHARED], s[STAT_AGENTS]), (3, 3, 3));
        // Agent 2's first own token copies the shared tail page (8 slots); its second does not.
        assert_eq!(kv_append(h, 2, 7), 0);
        let slot = out(h);
        assert_eq!(slot[SLOT_OFFSET], 8);
        assert_ne!(slot[SLOT_COPY_FROM], NO_BLOCK);
        assert_eq!(slot[SLOT_COPIED], 8);
        assert_eq!(kv_append(h, 2, 8), 0);
        assert_eq!(out(h)[SLOT_COPY_FROM], NO_BLOCK);
        assert_eq!(kv_len(h, 2), 42);
        assert_eq!(kv_len(h, 1), 40);
        assert_eq!(kv_check(h), 0);
        kv_stats(h);
        let s = out(h);
        // Agent 2 has a tail of its own; the two full pages and the old tail (agents 1 and 3) are still shared.
        assert_eq!((s[STAT_MAPPED], s[STAT_SHARED]), (4, 3));
        // The same prompt admitted afresh finds its two full pages in the prefix cache.
        let n = fill(h, &prefix);
        assert_eq!(kv_spawn(h, 9, n), 2);
        assert_eq!(kv_spawn(h, 9, n), ERR_AGENT_EXISTS);
        assert_eq!(kv_despawn(h, 9), 0);
        assert_eq!(kv_despawn(h, 9), ERR_UNKNOWN_AGENT);
        assert_eq!(kv_fork(h, 42, 43), ERR_UNKNOWN_AGENT);
        kv_free(h);
    }

    #[test]
    fn refusals_are_codes_and_change_nothing() {
        let h = kv_new(2, 64);
        let big: Vec<u32> = (0..48).collect();
        let n = fill(h, &big);
        assert_eq!(kv_spawn(h, 1, n), ERR_OUT_OF_BLOCKS, "three pages into a pool of two");
        kv_stats(h);
        assert_eq!(out(h)[STAT_MAPPED], 0);
        assert_eq!(kv_spawn(h, 1, 65), ERR_SCRATCH, "longer than the scratch");
        assert_eq!(kv_spawn(0, 1, 1), ERR_NO_TABLE);
        assert_eq!(kv_stats(0), ERR_NO_TABLE);
        assert_eq!(kv_scratch(0), 0);
        assert_eq!(kv_out(0), 0);
        assert_eq!(kv_scratch_len(h), 64);
        assert_eq!(kv_no_block(), NO_BLOCK);
        kv_free(h);
        kv_free(0);
    }
}
