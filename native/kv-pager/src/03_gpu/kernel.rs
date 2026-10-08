// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Stage 03 (always compiled): the attention kernel's source.
//!
//! Why does this file exist? The kernel (`paged_attention.wgsl`, beside it) is the reader every page-table decision is
//! made for; keeping its text in the crate without the `gpu` feature lets the tests check that its BLOCK_TOKENS and
//! HEAD_DIM are the page table's and the model's.
//! What breaks if it is removed? The GPU pool has no shader to compile, and a page-size change could reach the kernel
//! unnoticed.

/// The attention kernel that reads the tables (one decode step over the paged pool).
pub const PAGED_ATTENTION_WGSL: &str = include_str!("paged_attention.wgsl");
