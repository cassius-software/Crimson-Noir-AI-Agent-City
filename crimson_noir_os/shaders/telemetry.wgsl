// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
// Why does this file exist? It is the fog's Process stage of the IIoT telemetry pipeline on the GPU: one invocation
// per frame, the digest of the frame's eight 32-bit words (FNV-1a over their little-endian bytes, finished with the
// lowbias32 mixer the swarm uses), telemetry.rs `frame_digest` and the page's telemetry.ts `frameDigest` word for
// word. Integer arithmetic only, no branch, no float: every GPU, and the CPU, computes the same bits, so the cloud can
// refuse a frame whose fog digest differs from the edge's own. The frame count is a uniform; an invocation past it
// writes nothing (its index is clamped to the last frame and its write masked by rewriting that frame's own digest).
// What breaks if it is removed? The fog has no digest to agree with the edge about.

struct Params {
    frames: u32,
    pad0: u32,
    pad1: u32,
    pad2: u32,
}

const FRAME_WORDS: u32 = 8u;
const FNV_OFFSET: u32 = 0x811c9dc5u;
const FNV_PRIME: u32 = 0x01000193u;

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> words: array<u32>;
@group(0) @binding(2) var<storage, read_write> digests: array<u32>;

fn mix32(x0: u32) -> u32 {
    var x = x0;
    x = x ^ (x >> 16u);
    x = x * 0x7feb352du;
    x = x ^ (x >> 15u);
    x = x * 0x846ca68bu;
    x = x ^ (x >> 16u);
    return x;
}

fn fnv_word(h0: u32, w: u32) -> u32 {
    var h = h0;
    h = (h ^ (w & 0xffu)) * FNV_PRIME;
    h = (h ^ ((w >> 8u) & 0xffu)) * FNV_PRIME;
    h = (h ^ ((w >> 16u) & 0xffu)) * FNV_PRIME;
    h = (h ^ ((w >> 24u) & 0xffu)) * FNV_PRIME;
    return h;
}

@compute @workgroup_size(64)
fn digest(@builtin(global_invocation_id) gid: vec3<u32>) {
    let f = min(gid.x, P.frames - 1u);
    let at = f * FRAME_WORDS;
    var h = FNV_OFFSET;
    h = fnv_word(h, words[at]);
    h = fnv_word(h, words[at + 1u]);
    h = fnv_word(h, words[at + 2u]);
    h = fnv_word(h, words[at + 3u]);
    h = fnv_word(h, words[at + 4u]);
    h = fnv_word(h, words[at + 5u]);
    h = fnv_word(h, words[at + 6u]);
    h = fnv_word(h, words[at + 7u]);
    digests[f] = mix32(h);
}
