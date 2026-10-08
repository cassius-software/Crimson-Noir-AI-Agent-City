// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! A paged KV cache for a native host that runs the local model on the GPU itself: the page table of PagedAttention
//! with prefix caching and copy-on-write, and the WGSL attention kernel that reads it.
//!
//! Why does this file exist? It is the crate's door: it names the stages in causal order and re-exports what hosts
//! use, so `kv_pager::PageTable` and `kv_pager::gpu::KvPool` stay where callers expect them.
//! What breaks if it is removed? Nothing in the web build, whose local model server keeps its own cache. A native host
//! loses its page table.
//!
//! Causal order (each stage exists because of the one before it):
//! - 01 `01_geometry.rs`: what a token is and what its keys and values cost.
//! - 02 `02_page_table.rs`: which physical page each token lives in; prefix sharing; copy-on-write; refusal whole.
//! - 03 `03_gpu/`: the pages on the device. `kernel.rs` + `paged_attention.wgsl` read them (always compiled, so the
//!   page size is checked against the kernel without a GPU); `pool.rs` (feature `gpu`) allocates the fixed pool,
//!   runs the copies a copy-on-write asks for and binds the decode pipeline.
//! - 04 `src/bin/`: the runs that prove it: `stress` (100 agents on the 16 x 16 grid, real GPU) and `chaos` (the
//!   property fuzzer, CPU only).
//!
//! CAUSAL.md traces the copy-on-write divergence through these stages, call by call.

#[path = "01_geometry.rs"]
mod geometry;
#[path = "02_page_table.rs"]
mod page_table;
#[path = "03_gpu/kernel.rs"]
mod kernel;
#[cfg(feature = "gpu")]
#[path = "03_gpu/pool.rs"]
pub mod gpu;

pub use geometry::*;
pub use kernel::PAGED_ATTENTION_WGSL;
pub use page_table::*;

#[cfg(test)]
mod tests;
