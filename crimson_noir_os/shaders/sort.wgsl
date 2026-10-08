// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
// Why does this file exist? It is one pass of the bitonic sort on the GPU: kernels.rs `bitonic_pass`, one invocation
// per comparator. The comparators of a pass touch disjoint pairs, so they run in parallel; the network is fixed, so
// there is no branch (min and max select the order). The tutorial's eight files use the same network on the CPU.
// What breaks if it is removed? Large arrays cannot be sorted on the GPU.

struct Pass {
    k: u32,
    j: u32,
    pad0: u32,
    pad1: u32,
}

@group(0) @binding(0) var<uniform> S: Pass;
@group(0) @binding(1) var<storage, read_write> keys: array<u32>;

fn sel(m: u32, a: u32, b: u32) -> u32 {
    return b ^ ((a ^ b) & (0u - m));
}

@compute @workgroup_size(64)
fn bitonic(@builtin(global_invocation_id) gid: vec3<u32>) {
    let p = gid.x;
    let i = ((p & ~(S.j - 1u)) << 1u) | (p & (S.j - 1u));
    let l = i | S.j;
    let up = u32((i & S.k) == 0u);
    let a = keys[i];
    let b = keys[l];
    keys[i] = sel(up, min(a, b), max(a, b));
    keys[l] = sel(up, max(a, b), min(a, b));
}
