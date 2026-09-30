// Why does this file exist? It is one decode step of attention over the paged KV pool: for every agent (sequence) and
// query head, the new token's query attends to every key the agent's block table maps, and the output is the softmax-
// weighted sum of the values. The pages need not be contiguous, and a page shared by many agents (a cached prefix) is
// read by all of them in place.
// What breaks if it is removed? The native host has a page table (lib.rs) and a pool, but nothing that reads them.
//
// One workgroup per (query head, sequence), 64 invocations. The context is walked in tiles of TILE tokens with an
// online softmax (a running max and sum; the accumulator is rescaled when the max rises), so no score array the length
// of the context is ever kept. Invocation t scores token t of the tile, then owns output dims 2t and 2t+1.
//
// Pool layout, one K and one V buffer per layer: [block][slot][kv_head][HEAD_DIM / 2] words, each word two f16 values
// (low half = the even dim). Grouped-query attention: query head h reads kv head h / (q_heads / kv_heads).

const HEAD_DIM: u32 = 128u;
const WORDS: u32 = 64u;         // HEAD_DIM / 2
const TILE: u32 = 64u;          // tokens per tile = invocations per workgroup
const BLOCK_TOKENS: u32 = 16u;  // must equal lib.rs BLOCK_TOKENS
const NO_BLOCK: u32 = 0xffffffffu;
const NEG: f32 = -1.0e30;       // "no score": finite, so exp(NEG - m) is 0 and never NaN

struct Params {
    num_seqs: u32,
    max_blocks: u32,
    q_heads: u32,
    kv_heads: u32,
    pool_blocks: u32,
    scale: f32,
    _pad0: u32,
    _pad1: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> q: array<f32>;            // [seq][q_head][HEAD_DIM]
@group(0) @binding(2) var<storage, read> k_pool: array<u32>;       // one layer
@group(0) @binding(3) var<storage, read> v_pool: array<u32>;       // one layer
@group(0) @binding(4) var<storage, read> block_table: array<u32>;  // [seq][max_blocks]
@group(0) @binding(5) var<storage, read> seq_lens: array<u32>;     // [seq]
@group(0) @binding(6) var<storage, read_write> out: array<f32>;    // [seq][q_head][HEAD_DIM]

var<workgroup> q_s: array<f32, HEAD_DIM>;
var<workgroup> red: array<f32, TILE>;
var<workgroup> p_s: array<f32, TILE>;
var<workgroup> base_s: array<u32, TILE>;   // word offset of each tile token's head row, or NO_BLOCK
var<workgroup> len_s: u32;

fn reduce_max(t: u32) -> f32 {
    for (var s = TILE / 2u; s > 0u; s = s / 2u) {
        if (t < s) { red[t] = max(red[t], red[t + s]); }
        workgroupBarrier();
    }
    let r = red[0];
    workgroupBarrier();
    return r;
}

fn reduce_sum(t: u32) -> f32 {
    for (var s = TILE / 2u; s > 0u; s = s / 2u) {
        if (t < s) { red[t] = red[t] + red[t + s]; }
        workgroupBarrier();
    }
    let r = red[0];
    workgroupBarrier();
    return r;
}

@compute @workgroup_size(64)
fn decode(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) t: u32) {
    let h = wg.x;
    let seq = wg.y;
    let kvh = h / (params.q_heads / params.kv_heads);

    let q_row = (seq * params.q_heads + h) * HEAD_DIM;
    q_s[2u * t] = q[q_row + 2u * t] * params.scale;
    q_s[2u * t + 1u] = q[q_row + 2u * t + 1u] * params.scale;
    if (t == 0u) { len_s = seq_lens[seq]; }
    let len = workgroupUniformLoad(&len_s);   // also the barrier that publishes q_s

    var m = NEG;
    var l = 0.0;
    var acc = vec2<f32>(0.0, 0.0);

    for (var start = 0u; start < len; start = start + TILE) {
        // Score token t of the tile.
        let pos = start + t;
        var score = NEG;
        var base = NO_BLOCK;
        if (pos < len) {
            let block = block_table[seq * params.max_blocks + pos / BLOCK_TOKENS];
            if (block < params.pool_blocks) {
                base = ((block * BLOCK_TOKENS + pos % BLOCK_TOKENS) * params.kv_heads + kvh) * WORDS;
                var dot = 0.0;
                for (var w = 0u; w < WORDS; w = w + 1u) {
                    let k = unpack2x16float(k_pool[base + w]);
                    dot = dot + q_s[2u * w] * k.x + q_s[2u * w + 1u] * k.y;
                }
                score = dot;
            }
        }
        base_s[t] = base;
        red[t] = score;
        workgroupBarrier();
        let m_new = max(m, reduce_max(t));

        var p = 0.0;
        if (base != NO_BLOCK) { p = exp(score - m_new); }
        p_s[t] = p;
        red[t] = p;
        workgroupBarrier();
        let tile_sum = reduce_sum(t);

        // Rescale what was summed under the old max, then add this tile's values.
        let alpha = exp(m - m_new);
        l = l * alpha + tile_sum;
        acc = acc * alpha;
        for (var j = 0u; j < TILE; j = j + 1u) {
            let b = base_s[j];
            if (b != NO_BLOCK) {
                acc = acc + p_s[j] * unpack2x16float(v_pool[b + t]);
            }
        }
        m = m_new;
        workgroupBarrier();   // base_s / p_s are rewritten by the next tile
    }

    var o = vec2<f32>(0.0, 0.0);
    if (l > 0.0) { o = acc / l; }
    out[q_row + 2u * t] = o.x;
    out[q_row + 2u * t + 1u] = o.y;
}
