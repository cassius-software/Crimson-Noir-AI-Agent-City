// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Stage 04: the model's weights, streamed from the disk (feature `weights`, on by default and left out of the
//! WebAssembly page table, which has no files or threads).
//!
//! Why does this file exist? It names the three steps in causal order: `gguf` says where every layer and expert lives
//! in the file, `stream` reads them sector-aligned one unit ahead of the caller, and `swarm` decides what a step of the
//! whole swarm reads. Nothing in the crate runs a model's layers yet: this is the disk side a native runtime streams
//! from, measured on its own by the `stream` run.
//! What breaks if it is removed? Nothing outside the crate; a native host loses its weight streamer.

pub mod gguf;
pub mod stream;
pub mod swarm;

#[cfg(test)]
mod tests;
