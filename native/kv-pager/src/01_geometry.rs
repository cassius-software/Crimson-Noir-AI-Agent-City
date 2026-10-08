// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Stage 01: what a token is and what it costs.
//!
//! Why does this file exist? Every later stage sizes itself from these: a page is BLOCK_TOKENS tokens, a token's keys
//! and values cost `Geometry::bytes_per_token`, and the default model's shape (qwen3-vl:4b) fixes both the pool's
//! bytes and the kernel's HEAD_DIM.
//! What breaks if it is removed? Nothing can size a page, a pool or a dispatch; the page table (02) and the GPU pool
//! (03) do not compile.

/// Tokens per block (page).
pub const BLOCK_TOKENS: usize = 16;
/// An empty entry of a GPU block-table row.
pub const NO_BLOCK: u32 = u32::MAX;

pub type Token = u32;
pub type BlockId = u32;
/// An agent: the pedestrian's number in the crowd.
pub type AgentId = u32;

/// The attention geometry that sizes a token's keys and values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Geometry {
    pub layers: usize,
    /// Query heads; each group of `q_heads / kv_heads` reads one key/value head (grouped-query attention).
    pub q_heads: usize,
    pub kv_heads: usize,
    pub head_dim: usize,
}

/// The default local model's geometry (qwen3-vl:4b, as its server reports it: 36 blocks, 32 query heads, 8 key/value
/// heads of 128).
pub const DEFAULT_MODEL: Geometry = Geometry { layers: 36, q_heads: 32, kv_heads: 8, head_dim: 128 };

impl Geometry {
    /// Bytes of keys and values one token takes across every layer, at `value_bytes` per value (2 for f16).
    pub fn bytes_per_token(&self, value_bytes: usize) -> usize {
        self.layers * self.kv_heads * self.head_dim * 2 * value_bytes
    }
}
