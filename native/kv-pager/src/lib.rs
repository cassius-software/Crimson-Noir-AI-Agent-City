// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! A paged KV cache for a native host that runs the local model on the GPU itself: the page table of PagedAttention
//! with prefix caching and copy-on-write, the WGSL attention kernel that reads it, and the disk side of a model larger
//! than memory (a GGUF file's layers and experts streamed sector-aligned, planned per step of the whole swarm).
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
//! - 04 `04_weights/` (feature `weights`, on by default, off in the WebAssembly build): `gguf.rs` indexes a GGUF file's
//!   layers and experts as byte ranges, `stream.rs` reads them sector-aligned and unbuffered into a ring of buffers one
//!   unit ahead of the caller, `swarm.rs` plans what one step of the whole swarm reads (layer-major; per mixture-of-
//!   experts layer, the whole layer or only the routed experts, whichever the drive reads faster).
//! - 05 `src/bin/`: the runs that prove it: `stress` (100 agents on the 16 x 16 grid, real GPU), `chaos` (the
//!   property fuzzer, CPU only) and `stream` (a GGUF file read in swarm steps, the drive measured).
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
#[cfg(feature = "weights")]
#[path = "04_weights/mod.rs"]
pub mod weights;

pub use geometry::*;
pub use kernel::PAGED_ATTENTION_WGSL;
pub use page_table::*;

#[cfg(test)]
mod tests;
