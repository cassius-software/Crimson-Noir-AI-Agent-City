// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
// Why does this file exist? It is one Jacobi pass of the routing relaxation on the GPU: kernels.rs `relax_pass`, one
// invocation per (station, cell). Each cell takes the smallest of its own distance and its neighbours' plus one; a
// wall is INF and a station's own cell 0. No branch. Every pass adds the cells it changed to its own counter (a pass
// that changed nothing is convergence), so the host can run many passes in one submission and find where it settled.
// What breaks if it is removed? The routing fields cannot be relaxed on the GPU.

struct Pass {
    width: u32,
    depth: u32,
    cells: u32,
    index: u32,
}

@group(0) @binding(0) var<uniform> R: Pass;
@group(0) @binding(1) var<storage, read> walls: array<u32>;
@group(0) @binding(2) var<storage, read> station: array<u32>;
@group(0) @binding(3) var<storage, read> src: array<u32>;
@group(0) @binding(4) var<storage, read_write> dst: array<u32>;
@group(0) @binding(5) var<storage, read_write> changed: array<atomic<u32>>;

const INF: u32 = 0x3fffffffu;

fn sel(m: u32, a: u32, b: u32) -> u32 {
    return b ^ ((a ^ b) & (0u - m));
}

@compute @workgroup_size(64)
fn relax(@builtin(global_invocation_id) gid: vec3<u32>) {
    let n = gid.x;
    let s = n / R.cells;
    let c = n % R.cells;
    let x = c % R.width;
    let z = c / R.width;
    let base = s * R.cells;
    let e = src[base + z * R.width + min(x + 1u, R.width - 1u)];
    let wv = src[base + z * R.width + (max(x, 1u) - 1u)];
    let nv = src[base + min(z + 1u, R.depth - 1u) * R.width + x];
    let sv = src[base + (max(z, 1u) - 1u) * R.width + x];
    let near = min(min(e, wv), min(nv, sv));
    let own = src[base + c];
    var v = min(own, min(near, INF - 1u) + 1u);
    v = sel(walls[c] & 1u, INF, v);
    v = sel(u32(c == station[s]), 0u, v);
    dst[base + c] = v;
    atomicAdd(&changed[R.index], u32(v != own));
}
