// Why does this file exist? It is the swarm's tick on the GPU: crates/noir_core/src/kernels.rs `agent_tick`, the same
// arithmetic line for line, one invocation per agent slot. Like the CPU kernel it has no branch (no if, else, switch,
// while or loop: a test reads this file and refuses one): every decision is a 1/0 mask folded into arithmetic,
// NewState = CurrentState + (UpdateValue x Mask). Each invocation writes only its own row (and its own spare watch
// slot), so the result does not depend on the order invocations run in, and the hosted runtime checks it against the
// CPU kernel bit for bit (the scripted run's fingerprint).
// The Global Matrix is laid out as structure-of-arrays inside a few buffers: positions (px, then pz), the twelve
// per-agent word arrays one after another, the learned weights, the memory blocks, and the world (walls, then every
// station's routing field). The watch buffer records, per tick, the fate and liveness of the scripted run's rogue and
// looper (every other invocation writes its own spare slot instead: no branch, no race).
// What breaks if it is removed? The hosted runtime cannot run the swarm on the GPU.

struct Params {
    t: u32,
    capacity: u32,
    width: u32,
    depth: u32,
    stations: u32,
    block_words: u32,
    loop_limit: u32,
    learn_shift: u32,
    explore: u32,
    step: f32,
    rogue: u32,
    looper: u32,
    watch_spare: u32,
    pad0: u32,
    pad1: u32,
    pad2: u32,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> pos: array<f32>;
@group(0) @binding(2) var<storage, read_write> words: array<u32>;
@group(0) @binding(3) var<storage, read_write> weights: array<i32>;
@group(0) @binding(4) var<storage, read_write> memory: array<u32>;
@group(0) @binding(5) var<storage, read> world: array<u32>;
@group(0) @binding(6) var<storage, read_write> tally: array<atomic<u32>, 4>;
@group(0) @binding(7) var<storage, read_write> watch: array<u32>;

// The word arrays, in the order the host packs them.
const ALIVE: u32 = 0u;
const DOOMED: u32 = 1u;
const CAPS: u32 = 2u;
const REQ: u32 = 3u;
const ROLE: u32 = 4u;
const GOAL: u32 = 5u;
const RUN: u32 = 6u;
const LAST: u32 = 7u;
const TRIPS: u32 = 8u;
const CLOCK: u32 = 9u;
const HEADING: u32 = 10u;
const FATE: u32 = 11u;

const CAP_MOVE: u32 = 1u;
const CAP_ROUTE: u32 = 2u;
const CAP_LEARN: u32 = 4u;
const CAP_MEMORY: u32 = 8u;

// 1 when x is not zero, else 0.
fn nz(x: u32) -> u32 {
    return (x | (0u - x)) >> 31u;
}

// a where the 1/0 mask m is 1, else b.
fn sel(m: u32, a: u32, b: u32) -> u32 {
    return b ^ ((a ^ b) & (0u - m));
}

fn sel_i(m: u32, a: i32, b: i32) -> i32 {
    return bitcast<i32>(sel(m, bitcast<u32>(a), bitcast<u32>(b)));
}

// lowbias32, as hash.rs.
fn mix32(x0: u32) -> u32 {
    var x = x0;
    x = x ^ (x >> 16u);
    x = x * 0x7feb352du;
    x = x ^ (x >> 15u);
    x = x * 0x846ca68bu;
    x = x ^ (x >> 16u);
    return x;
}

fn at(k: u32, i: u32) -> u32 {
    return k * P.capacity + i;
}

@compute @workgroup_size(64)
fn tick(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    let cap = P.capacity;
    let w = P.width;
    let depth = P.depth;
    let stations = P.stations;
    let cells = w * depth;

    // The 1/0 masks are bit 0 of their words, whatever else a word holds.
    let a = words[at(ALIVE, i)] & 1u;
    let caps = words[at(CAPS, i)];
    let reaped = words[at(DOOMED, i)] & 1u;

    // Where the agent stands, and what its station's field says about the four cells around it.
    let cx = min(u32(pos[i]), w - 1u);
    let cz = min(u32(pos[cap + i]), depth - 1u);
    let c = cz * w + cx;
    let g = words[at(GOAL, i)] & (stations - 1u);
    let base = cells + g * cells;
    let here = world[base + c];
    let fe = world[base + cz * w + min(cx + 1u, w - 1u)];
    let fw = world[base + cz * w + (max(cx, 1u) - 1u)];
    let fnorth = world[base + min(cz + 1u, depth - 1u) * w + cx];
    let fsouth = world[base + (max(cz, 1u) - 1u) * w + cx];

    // The closest of the four, ties broken east, west, north, south.
    var best = fe;
    var dx = 1i;
    var dz = 0i;
    var b = u32(fw < best);
    best = sel(b, fw, best);
    dx = sel_i(b, -1i, dx);
    dz = sel_i(b, 0i, dz);
    b = u32(fnorth < best);
    best = sel(b, fnorth, best);
    dx = sel_i(b, 0i, dx);
    dz = sel_i(b, 1i, dz);
    b = u32(fsouth < best);
    best = sel(b, fsouth, best);
    dx = sel_i(b, 0i, dx);
    dz = sel_i(b, -1i, dz);

    // An agent without the route privilege patrols its heading: 0 east, 1 west, 2 north, 3 south.
    let routes = nz(caps & CAP_ROUTE);
    let h = words[at(HEADING, i)] & 3u;
    let hdx = sel_i(u32(h == 0u), 1i, sel_i(u32(h == 1u), -1i, 0i));
    let hdz = sel_i(u32(h == 2u), 1i, sel_i(u32(h == 3u), -1i, 0i));
    let mx = sel_i(routes, dx, hdx);
    let mz = sel_i(routes, dz, hdz);
    let want = a & sel(routes, u32(best < here), 1u);
    let arrived = a & routes & u32(here == 0u);

    // What it asks for this tick, and the dropped-pointer defense.
    let learns = arrived & nz(caps & CAP_LEARN);
    let writes = a & nz(caps & CAP_MEMORY);
    let asked = words[at(REQ, i)] | (CAP_MOVE * want) | (CAP_ROUTE * (routes & a)) | (CAP_LEARN * learns) | (CAP_MEMORY * writes);
    let violated = a & nz(asked & ~caps);
    let ok = a & (violated ^ 1u);

    // One step toward the chosen cell, unless it is a wall.
    let tx = u32(clamp(i32(cx) + mx, 0i, i32(w) - 1i));
    let tz = u32(clamp(i32(cz) + mz, 0i, i32(depth) - 1i));
    let blocked = world[tz * w + tx] & 1u;
    let moves = ok & want & nz(caps & CAP_MOVE);
    let go = moves & (blocked ^ 1u);
    pos[i] = pos[i] + f32(mx) * P.step * f32(go);
    pos[cap + i] = pos[cap + i] + f32(mz) * P.step * f32(go);
    words[at(HEADING, i)] = h ^ (moves & blocked & (routes ^ 1u));

    // The loop breaker.
    let fail = moves & blocked;
    let way = u32(mx + 1i) | (u32(mz + 1i) << 2u);
    let sig = (mix32((c << 4u) | way) | 1u) * fail;
    let same = u32(sig == words[at(LAST, i)]);
    let run = (words[at(RUN, i)] * same + 1u) * fail;
    words[at(RUN, i)] = run;
    words[at(LAST, i)] = sig;
    let flushed = a & u32(run >= P.loop_limit);

    // Docking: learn, then pick the next station by learned weight plus exploration noise.
    let docked = arrived & ok;
    let wi = i * stations + g;
    let reward = i32((1u << 22u) / (min(words[at(CLOCK, i)], 1u << 20u) + 64u));
    let lw = weights[wi];
    let learned = i32(learns & ok);
    weights[wi] = lw + ((reward - lw) >> P.learn_shift) * learned;
    var pick = g;
    var top = i32(0x80000000u);
    for (var s = 0u; s < stations; s = s + 1u) {
        let noise = i32(mix32(i ^ (P.t << 12u) ^ (s << 24u) ^ 0x9e3779b9u) % (P.explore + 1u));
        let weight = weights[i * stations + s] + noise;
        let cand = sel_i(u32(s == g), i32(0x80000000u), weight);
        let better = u32(cand > top);
        top = sel_i(better, cand, top);
        pick = sel(better, s, pick);
    }
    words[at(GOAL, i)] = sel(docked, pick, g);
    words[at(TRIPS, i)] = words[at(TRIPS, i)] + docked;
    words[at(CLOCK, i)] = (words[at(CLOCK, i)] + 1u) * (docked ^ 1u) * a;

    // Memory: the index is masked into the agent's own block.
    let slot = i * P.block_words + (P.t & (P.block_words - 1u));
    memory[slot] = sel(writes & ok, c | (way << 16u) | 0x80000000u, memory[slot]);

    // Requests last one tick; a dropped pointer stops now and is zeroed during the next tick; a flush zeroes at once.
    words[at(REQ, i)] = 0u;
    words[at(ALIVE, i)] = a & (violated ^ 1u);
    words[at(DOOMED, i)] = violated;
    let keep = 0u - ((flushed | reaped) ^ 1u);
    pos[i] = bitcast<f32>(bitcast<u32>(pos[i]) & keep);
    pos[cap + i] = bitcast<f32>(bitcast<u32>(pos[cap + i]) & keep);
    for (var k = 0u; k < FATE; k = k + 1u) {
        words[at(k, i)] = words[at(k, i)] & keep;
    }
    for (var s = 0u; s < stations; s = s + 1u) {
        weights[i * stations + s] = weights[i * stations + s] & bitcast<i32>(keep);
    }
    for (var k = 0u; k < P.block_words; k = k + 1u) {
        memory[i * P.block_words + k] = memory[i * P.block_words + k] & keep;
    }
    let fate = violated | (flushed << 1u) | (reaped << 2u) | (docked << 3u);
    words[at(FATE, i)] = fate;
    atomicAdd(&tally[0], fate & 1u);
    atomicAdd(&tally[1], (fate >> 1u) & 1u);
    atomicAdd(&tally[2], (fate >> 2u) & 1u);
    atomicAdd(&tally[3], (fate >> 3u) & 1u);

    // The watch: the rogue's and the looper's fate and liveness this tick; everyone else writes their own spare slot.
    let spare = P.watch_spare + i;
    let slot4 = P.t * 4u;
    let alive_now = words[at(ALIVE, i)];
    watch[select(spare, slot4, i == P.rogue)] = fate;
    watch[select(spare, slot4 + 1u, i == P.rogue)] = alive_now;
    watch[select(spare, slot4 + 2u, i == P.looper)] = fate;
    watch[select(spare, slot4 + 3u, i == P.looper)] = alive_now;
}
