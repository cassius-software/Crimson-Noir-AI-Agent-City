# kv-pager: causal layout and the copy-on-write chain

Why does this file exist? The crate is organised by cause, like the web tree (01 → 07). This file names each stage,
and traces one copy-on-write divergence through them call by call, so a change at any link can be checked against
the ones after it.
What breaks if it is removed? Nothing compiles differently. A reader loses the one place where the whole chain is written
down in order.

## Stages

| Stage | File | Exists because | Removing it breaks |
|---|---|---|---|
| 01 | `src/01_geometry.rs` | A token has a size: `bytes_per_token` = layers × kv_heads × head_dim × 2 (K and V) × 2 B = 147,456 B for qwen3-vl:4b; a page is `BLOCK_TOKENS` = 16 tokens | Nothing can size a page, a pool or a dispatch |
| 02 | `src/02_page_table.rs` | Tokens must live in physical pages the pool can reuse | The pool has pages but no owner; a host reserves whole contexts (112.5 GiB for 100 × 8,192) |
| 03 | `src/03_gpu/kernel.rs` + `paged_attention.wgsl` | The pages are read by attention through the block tables | The tables have no reader; the page size can drift from the kernel unnoticed (a test pins both) |
| 03 | `src/03_gpu/pool.rs` (feature `gpu`) | The pages must exist on the device, and a copy-on-write must move bytes, not just ids | The table hands out ids of pages that hold nothing |
| 04 | `src/bin/stress.rs` | The claims need a run on real hardware | No VRAM telemetry |
| 04 | `src/bin/chaos/` + `tests/chaos.rs` | The table's promises are about sequences of operations | Regressions surface only as corrupt attention |

## The copy-on-write divergence, cause by cause

This is the case the stress run hits 90 times: a squad leader's prompt ends part-way into a page (114 tokens = 7 full
pages + 2 tokens), 9 members fork from it, and each member then writes its own first token.

1. **Fork shares, allocates nothing.** `PageTable::fork` (`02_page_table.rs:302`) clones the parent's block list and
   adds one reference to each block. The tail page (2 tokens filled) now has `refs = 10`. No page is taken, and no
   byte moves on the GPU. *Cause of the next step:* a page with `refs > 1` must never be written, or one agent's
   write would appear in nine other agents' context.
2. **The write finds the tail shared.** `PageTable::append` (`:252`) computes `offset = len % 16 = 2`. Because
   `offset > 0` and the last page's `refs > 1`, it takes the copy-on-write branch (`:257`).
3. **A private page, or a refusal whole.** `take()` (`:258`, defined at `:403`) pops a free page, or evicts the
   oldest idle cached page. If there is none, the append returns `OutOfBlocks { needed: 1, available: 0 }` *before
   anything changes*. The agent stalls; the pool is never overcommitted. That is the no-OOM guarantee.
4. **Token ids copied, the shared page released once.** The new page gets the first `offset` token ids and the same
   `parent` (so the chain check in `check()` still holds). `release_block(src)` (`:265`) drops `src` to `refs = 9`;
   the other nine agents still map it.
5. **The table is repointed.** The agent's last block entry becomes the new page (`:291`), and the token goes into slot
   `offset`. If that fills the page, `seal` (`:427`) keys it into the prefix cache (`:294`).
6. **The host is told what to move.** `append` returns `Slot { block: new, offset: 2, copy_from: Some((src, 2)) }`.
   The page table owns ids only; the bytes are the host's job.
7. **Bytes move on the GPU, through staging.** `Host::store` (`bin/stress.rs:182`) sees `copy_from` and calls
   `KvPool::encode_copy` (`03_gpu/pool.rs:164`). For each of 36 layers × {K, V}, it copies slots `0..offset` of `src`
   to the staging buffer, then from staging into `dst`. WebGPU forbids a buffer-to-itself copy, so the bytes can't
   go directly. The layout is slot-major (`[block][slot][kv_head][dim]`), so this is one contiguous range per buffer,
   and it never covers slot `offset`.
8. **The new token's K/V are queued.** `write_token` (`pool.rs:153`) queues slot `offset` of `dst`, for every layer.
9. **Order within the submit is safe by construction.** `flush` (`stress.rs:204`) submits. wgpu applies queued writes
   before the submit's commands. The copies still can't clobber the new token, because they only cover slots
   `< offset`. And `src` can't be freed and reused inside the same phase, because a copy-on-write leaves `src.refs ≥ 1`.
10. **Staging memory is returned.** `device.poll(Wait)` (`stress.rs:207`) runs after every submit. Without it, the
    queue's write staging grew 2050 → 3850 MiB over the run (measured with the DX12 allocator report). With it, the
    allocation stays flat at 2050 MiB.
11. **The kernel reads the diverged table.** `gpu_tables` (`02_page_table.rs:324`) lays out the rows. The kernel
    resolves each position through `block_table[seq * max_blocks + pos / 16]` (`paged_attention.wgsl:88`). The member
    now reads its private tail page, and the other nine still read the shared one.
12. **Proof both ways.** The stress run checks every agent's attention against a CPU reference that uses only that
    agent's own tokens: max error 4.1e-7. With `--skip-cow-copy` (step 7 removed), the new page's slots `0..offset` hold
    nothing and the error jumps to 1.0e-1 (FAIL). In the page table, making step 2 never fire (`refs > 999`) fails
    both the unit test for this case and the randomized invariant test.

## What the chain does not cover

- The page table isn't thread-safe by itself: every method takes `&mut self`. A host that shares it wraps it in a
  lock. The chaos run's shared-table mode does exactly that, with one op per lock hold.
- Idle cached pages are evicted oldest-first by release time, not by use frequency.
- The K/V in the stress run are synthetic: a hash of the token chain. The chain above is about where the bytes go,
  not what a model would put in them.
